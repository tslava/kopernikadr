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
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService

/**
 * In-app Capacitor plugin `KopernikadrNative` (TS facade: `remote/lib/native.ts`). Thin: every
 * method runs [NativeApi] on one background thread (so calls are serialized and never block the
 * main thread) and rejects with `code` = a [NativeErrorCode] name.
 *
 * Image work (copying a picked image, later decoding and segmenting) runs on its own single-thread
 * [segExecutor], so a slow segmenter call never delays frame downloads or project saves queued on
 * the shared executor. It is a scheduled one for the segmenter session's idle timeout.
 */
@CapacitorPlugin(name = "KopernikadrNative")
class KopernikadrNativePlugin : Plugin() {
    private lateinit var api: NativeApi
    private lateinit var executor: ExecutorService
    private lateinit var segExecutor: ScheduledExecutorService
    private var debuggable = false

    override fun load() {
        val ctx = context
        val guard = PathGuard.forFilesDir(ctx.filesDir)
        val dirSync = AndroidDirSync()
        val log: (String) -> Unit = { Log.i(TAG, it) }
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
            testImportRoots = listOfNotNull(
                File(Environment.getExternalStorageDirectory(), Environment.DIRECTORY_DOWNLOADS),
                ctx.getExternalFilesDir(null),
            ),
            log = log,
        )
        debuggable = (ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        // a photo left by a process death while the camera was in front is of no use to anyone
        File(ctx.cacheDir, CAPTURE_DIR).deleteRecursively()
        segExecutor = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "KopernikadrSeg") }
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
        segExecutor.shutdownNow()
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
     * Result of [pickImage]. [call] is null when the process died while the picker was in front;
     * then there is nobody to answer and the app just opens on its default route.
     */
    @ActivityCallback
    private fun pickResult(call: PluginCall?, result: ActivityResult) {
        val uri = result.data?.data ?: result.data?.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri
        val outcome = ActivityResults.outcome(call != null, result.resultCode, uri != null)
        if (call == null) return
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
     * writing to the fixed `cacheDir/capture/photo.jpg`, and resolves with `{path}`: the photo moved
     * to `tmp/photo-<uuid>.jpg`. `CANCELLED` (back out or an empty file), `NO_APP` on failure.
     */
    @PluginMethod
    fun takePhoto(call: PluginCall) {
        closeSegSessions()
        val file = capturePhotoFile()
        val uri = try {
            file.parentFile!!.mkdirs()
            file.delete()
            FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
        } catch (e: Exception) {
            call.reject("cannot prepare the photo file", NativeErrorCode.IO.name)
            return
        }
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, uri)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivityForResult(call, intent, "cameraResult")
        } catch (e: ActivityNotFoundException) {
            call.reject("no camera app", NativeErrorCode.NO_APP.name)
        }
    }

    /** Result of [takePhoto]; [call] is null after a process death (the photo is lost, nobody to answer). */
    @ActivityCallback
    private fun cameraResult(call: PluginCall?, result: ActivityResult) {
        val file = capturePhotoFile()
        val outcome = ActivityResults.cameraOutcome(call != null, result.resultCode, file.length())
        if (call == null) return
        ActivityResults.errorOf(outcome)?.let {
            file.delete()
            call.reject(it.name.lowercase(), it.name)
            return
        }
        runOn(segExecutor, call) { api.importCaptured(file) }
    }

    private fun capturePhotoFile() = File(File(context.cacheDir, CAPTURE_DIR), "photo.jpg")

    /** Frees the segmenter session's memory while another app is in front (the session arrives with the segmenter). */
    private fun closeSegSessions() {}

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
        val args = BridgeArgs { name -> data.opt(name).takeUnless { it == null || it == JSONObject.NULL } }
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
    }
}
