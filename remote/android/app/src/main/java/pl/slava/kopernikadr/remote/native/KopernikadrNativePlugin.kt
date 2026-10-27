package pl.slava.kopernikadr.remote.native

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Environment
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * In-app Capacitor plugin `KopernikadrNative` (TS facade: `remote/lib/native.ts`). Thin: every
 * method runs [NativeApi] on one background thread (so calls are serialized and never block the
 * main thread) and rejects with `code` = a [NativeErrorCode] name.
 */
@CapacitorPlugin(name = "KopernikadrNative")
class KopernikadrNativePlugin : Plugin() {
    private lateinit var api: NativeApi
    private lateinit var executor: ExecutorService
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
            log = log,
        )
        debuggable = (ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
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

    /** Debug builds only: inserts a pending gallery row, for the emulator cleanup check. */
    @PluginMethod
    fun __testInsertPending(call: PluginCall) {
        if (!debuggable) {
            call.reject("__testInsertPending is debug-only", NativeErrorCode.BAD_ARGUMENT.name)
            return
        }
        run(call, api::testInsertPending)
    }

    private fun run(call: PluginCall, op: (BridgeArgs) -> Map<String, Any>) {
        val data = call.data
        val args = BridgeArgs { name -> data.opt(name).takeUnless { it == null || it == JSONObject.NULL } }
        try {
            executor.execute {
                try {
                    val result = op(args)
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
    }
}
