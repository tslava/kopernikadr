package pl.slava.kopernikadr.remote.native

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import androidx.activity.result.ActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import android.net.Uri
import android.provider.MediaStore
import androidx.core.content.FileProvider
import android.os.Environment
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * In-app Capacitor plugin `KopernikadrNative` (TS facade: `remote/lib/native.ts`). Thin: every
 * method runs [NativeApi] on one background thread (so calls are serialized and never block the
 * main thread) and rejects with `code` = a [NativeErrorCode] name.
 *
 * Image work (copying a picked image, decoding and segmenting: `segOpen` / `segRun` / `segClose`)
 * runs on its own single-thread [segExecutor], so a slow segmenter call never delays frame downloads
 * or project saves queued on the shared executor. It is a scheduled one for the segmenter session's
 * idle timeout, and the only thread that touches [seg].
 */
@CapacitorPlugin(name = "KopernikadrNative")
class KopernikadrNativePlugin : Plugin() {
    private lateinit var api: NativeApi
    private lateinit var seg: SegSession
    private lateinit var captures: CaptureFiles
    private lateinit var executor: ExecutorService
    private lateinit var segExecutor: ScheduledExecutorService
    private var debuggable = false

    override fun load() {
        val ctx = context
        val guard = PathGuard.forFilesDir(ctx.filesDir)
        val dirSync = AndroidDirSync()
        val log: (String) -> Unit = { Log.i(TAG, it) }
        seg = SegSession(
            guard = guard,
            loader = AndroidImageLoader(),
            engines = MediaPipeEngineFactory(ctx),
            stateDir = ctx.noBackupFilesDir,
            log = log,
        )
        api = NativeApi(
            files = AtomicFiles(guard, dirSync, StatFsDiskSpace),
            writer = VideoWriter(guard, dirSync, disk = StatFsDiskSpace, reserveBytes = GalleryPublisher.RESERVE_BYTES),
            gallery = GalleryPublisher(
                gateway = AndroidMediaStoreGateway(ctx.contentResolver),
                packageName = ctx.packageName,
                volumeDir = Environment.getExternalStorageDirectory(),
                disk = StatFsDiskSpace,
            ),
            images = ImageImport(guard),
            seg = seg,
            testImportRoots = listOfNotNull(
                File(Environment.getExternalStorageDirectory(), Environment.DIRECTORY_DOWNLOADS),
                ctx.getExternalFilesDir(null),
            ),
            log = log,
        )
        debuggable = (ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        // a photo left by a process death while the camera was in front is of no use to anyone
        File(ctx.cacheDir, CAPTURE_DIR).deleteRecursively()
        captures = CaptureFiles(File(ctx.cacheDir, CAPTURE_DIR))
        segExecutor = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "KopernikadrSeg") }
        segExecutor.scheduleWithFixedDelay(
            {
                try {
                    val n = seg.closeIdle()
                    if (n > 0) log("closed $n idle segmenter session(s)")
                } catch (e: Throwable) {
                    Log.w(TAG, "idle segmenter close failed", e)
                }
            },
            IDLE_CHECK_SECONDS, IDLE_CHECK_SECONDS, TimeUnit.SECONDS,
        )
        executor = Executors.newSingleThreadExecutor { r -> Thread(r, "KopernikadrNative") }
        // Startup sweep (§5.7): an export killed mid-encode or mid-publish leaves an exports/ file
        // and maybe a pending gallery row. Queued first on the serial executor, so it finishes
        // before any call from the page; this fresh `api` has no live handles yet.
        executor.execute {
            try {
                val r = api.videoCleanupAbandoned(BridgeArgs { null })
                log("startup sweep: $r")
            } catch (e: Exception) {
                Log.w(TAG, "startup sweep failed", e)
            }
        }
    }

    override fun handleOnDestroy() {
        executor.shutdown()
        // queued work (and a run in progress) finishes, the sessions are closed last, then the thread ends
        closeSegSessions()
        segExecutor.shutdown()
    }

    @PluginMethod
    fun writeTextAtomic(call: PluginCall) = run(call, api::writeTextAtomic)

    @PluginMethod
    fun installFile(call: PluginCall) = run(call, api::installFile)

    @PluginMethod
    fun freeBytes(call: PluginCall) = run(call, api::freeBytes)

    @PluginMethod
    fun videoOpen(call: PluginCall) = run(call, api::videoOpen)

    @PluginMethod
    fun videoWriteAt(call: PluginCall) = run(call, api::videoWriteAt)

    @PluginMethod
    fun videoClose(call: PluginCall) = run(call, api::videoClose)

    @PluginMethod
    fun videoPublish(call: PluginCall) = run(call, api::videoPublish)

    @PluginMethod
    fun videoAbort(call: PluginCall) = run(call, api::videoAbort)

    @PluginMethod
    fun videoCleanupAbandoned(call: PluginCall) = run(call, api::videoCleanupAbandoned)

    /** Opens a published gallery video (`content://` uri from `videoPublish`) in the system player. */
    @PluginMethod
    fun videoView(call: PluginCall) {
        val uri = call.getString("uri")
        if (uri.isNullOrBlank() || !uri.startsWith("content://")) {
            call.reject("uri must be a content:// uri", NativeErrorCode.BAD_ARGUMENT.name)
            return
        }
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(Uri.parse(uri), "video/mp4")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            call.resolve()
        } catch (e: ActivityNotFoundException) {
            call.reject("no video player", NativeErrorCode.NOT_FOUND.name)
        }
    }

    /**
     * Opens the system image picker (the platform photo picker, its Play-services backport or
     * `ACTION_OPEN_DOCUMENT`, whichever `PickVisualMedia` chooses) and resolves with the copy in
     * `tmp/`: `{path, mime}`. `CANCELLED`, `NO_APP`, `TOO_LARGE`, `UNSUPPORTED` on failure.
     */
    @PluginMethod
    fun pickImage(call: PluginCall) {
        closeSegSessions()
        val intent = ActivityResultContracts.PickVisualMedia().createIntent(
            context,
            PickVisualMediaRequest.Builder().setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly).build(),
        )
        try {
            startActivityForResult(call, intent, "pickResult")
        } catch (e: ActivityNotFoundException) {
            call.reject("no image picker", NativeErrorCode.NO_APP.name)
        }
    }

    /**
     * Result of [pickImage]. [call] is null (or a dangling call, Capacitor 8) when the process died while the picker was in front;
     * then there is nobody to answer and the app just opens on its default route.
     */
    @ActivityCallback
    private fun pickResult(call: PluginCall?, result: ActivityResult) {
        val uri = result.data?.data ?: result.data?.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri
        val outcome = ActivityResults.outcome(
            ActivityResults.callLive(call != null, call?.callbackId), result.resultCode, uri != null,
        )
        if (call == null || outcome == ActivityResults.Outcome.IGNORE) return
        ActivityResults.errorOf(outcome)?.let {
            call.reject(it.name.lowercase(), it.name)
            return
        }
        val resolver = context.contentResolver
        runOn(segExecutor, call) {
            val input = resolver.openInputStream(uri!!) ?: raise(NativeErrorCode.NOT_FOUND, "picker returned an unreadable uri")
            input.use { api.importPicked(resolver.getType(uri), it) }
        }
    }

    /**
     * Opens the system camera app (`ACTION_IMAGE_CAPTURE`, so the app needs no CAMERA permission)
     * writing to a per-request `cacheDir/capture/photo-<uuid>.jpg` ([CaptureFiles]), and resolves with `{path}`: the photo moved
     * to `tmp/photo-<uuid>.jpg`. `CANCELLED` (back out or an empty file), `NO_APP` on failure.
     */
    @PluginMethod
    fun takePhoto(call: PluginCall) {
        closeSegSessions()
        val file = captures.newFor(call.callbackId)
        val uri = try {
            FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
        } catch (e: Exception) {
            captures.discard(call.callbackId)
            call.reject("cannot prepare the photo file", NativeErrorCode.IO.name)
            return
        }
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, uri)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivityForResult(call, intent, "cameraResult")
        } catch (e: ActivityNotFoundException) {
            captures.discard(call.callbackId)
            call.reject("no camera app", NativeErrorCode.NO_APP.name)
        }
    }

    /** Result of [takePhoto]; [call] is null after a process death (the photo is lost, nobody to answer). */
    @ActivityCallback
    private fun cameraResult(call: PluginCall?, result: ActivityResult) {
        // exactly this request's file (none after a process death: the startup sweep removed the photo)
        val file = captures.take(call?.callbackId)
        val outcome = ActivityResults.cameraOutcome(
            ActivityResults.callLive(call != null, call?.callbackId), result.resultCode, file?.length() ?: 0L,
        )
        if (call == null || file == null || outcome == ActivityResults.Outcome.IGNORE) {
            file?.delete() // nobody to import it for: do not keep the photo
            return
        }
        ActivityResults.errorOf(outcome)?.let {
            file.delete()
            call.reject(it.name.lowercase(), it.name)
            return
        }
        runOn(segExecutor, call) { api.importCaptured(file) }
    }

    /** Frees the segmenter's memory while another app is in front (or on destroy); runs on the segmenter executor. */
    private fun closeSegSessions() {
        try {
            segExecutor.execute {
                try {
                    seg.closeAll()
                } catch (e: Throwable) {
                    Log.w(TAG, "closing the segmenter sessions failed", e)
                }
            }
        } catch (e: RejectedExecutionException) {
            // already shut down: nothing is left to close
        }
    }

    @PluginMethod
    fun segOpen(call: PluginCall) = run(call, api::segOpen, segExecutor)

    @PluginMethod
    fun segRun(call: PluginCall) = run(call, api::segRun, segExecutor)

    @PluginMethod
    fun segClose(call: PluginCall) = run(call, api::segClose, segExecutor)

    /** Debug builds only: imports a file from `/sdcard/Download/` like a pick would (scripted tablet runs). */
    @PluginMethod
    fun __testImportImage(call: PluginCall) {
        if (!debuggable) {
            call.reject("__testImportImage is debug-only", NativeErrorCode.BAD_ARGUMENT.name)
            return
        }
        run(call, api::testImportImage, segExecutor)
    }

    /** Debug builds only: inserts a pending gallery row, for the emulator cleanup check. */
    @PluginMethod
    fun __testInsertPending(call: PluginCall) {
        if (!debuggable) {
            call.reject("__testInsertPending is debug-only", NativeErrorCode.BAD_ARGUMENT.name)
            return
        }
        run(call, api::testInsertPending)
    }

    private fun run(call: PluginCall, op: (BridgeArgs) -> Map<String, Any>, on: ExecutorService = executor) {
        val data = call.data
        val args = BridgeArgs { name -> plain(data.opt(name)) }
        runOn(on, call) { op(args) }
    }

    private fun runOn(on: ExecutorService, call: PluginCall, op: () -> Map<String, Any>) {
        try {
            on.execute {
                try {
                    val result = op()
                    if (result.isEmpty()) call.resolve() else call.resolve(result.toJSObject())
                } catch (e: NativeException) {
                    call.reject(e.message, e.code.name)
                } catch (e: Throwable) {
                    Log.e(TAG, "${call.methodName} failed", e)
                    call.reject(e.message ?: e.javaClass.simpleName, NativeErrorCode.IO.name, e as? Exception)
                }
            }
        } catch (e: java.util.concurrent.RejectedExecutionException) {
            call.reject("KopernikadrNative is shut down", NativeErrorCode.IO.name)
        }
    }

    /** JSON arrays and objects as plain lists and maps (so [BridgeArgs] and the validators stay JVM-testable); JSON null as null. */
    private fun plain(v: Any?): Any? = when (v) {
        null, JSONObject.NULL -> null
        is JSONArray -> List(v.length()) { plain(v.opt(it)) }
        is JSONObject -> v.keys().asSequence().associateWith { plain(v.opt(it)) }
        else -> v
    }

    private fun Map<String, Any>.toJSObject() = JSObject().also { o ->
        for ((k, v) in this) {
            when (v) {
                is String -> o.put(k, v)
                is Int -> o.put(k, v)
                is Long -> o.put(k, v)
                is Boolean -> o.put(k, v)
                else -> o.put(k, v.toString())
            }
        }
    }

    private companion object {
        const val TAG = "KopernikadrNative"
        private const val CAPTURE_DIR = "capture"
        private const val IDLE_CHECK_SECONDS = 30L
    }
}
