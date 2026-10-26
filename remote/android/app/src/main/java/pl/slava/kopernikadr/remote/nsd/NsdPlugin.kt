package pl.slava.kopernikadr.remote.nsd

import android.content.Context
import android.content.pm.ApplicationInfo
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import androidx.annotation.RequiresApi
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.InetAddress
import java.util.concurrent.Executor

/**
 * DNS-SD browsing over Android `NsdManager` (PROTOCOL §3).
 *
 * JS API: `startDiscovery({type})` resolves once browsing runs, `stopDiscovery()`. Events:
 * - `serviceFound` `{name, type, host, addresses, port, txt}`: a resolved service; `host` is the
 *   preferred address (IPv4 first), `txt` values are UTF-8 text. May repeat for the same name when
 *   the service changes.
 * - `serviceLost` `{name, type}`;
 * - `discoveryError` `{stage: "discovery"|"resolve", code, message, name?}`.
 *
 * Resolving uses `registerServiceInfoCallback` on API 34+ and a serial `resolveService` queue below
 * (concurrent resolves fail there). A Wi-Fi multicast lock is held while browsing. All state lives
 * on one handler thread. Debug builds also get `__testRegister`/`__testUnregister` to advertise a
 * service from this device (emulator self-test).
 */
@CapacitorPlugin(name = "KopernikadrNsd")
class NsdPlugin : Plugin() {
    private lateinit var nsd: NsdManager
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private lateinit var executor: Executor
    private var lock: WifiManager.MulticastLock? = null
    private lateinit var queue: ResolveQueue<NsdServiceInfo, NsdServiceInfo>

    /** The running browse session, if any. */
    private var session: Session? = null

    /** API 34+: one info callback per found instance name. */
    private val infoCallbacks = HashMap<String, NsdManager.ServiceInfoCallback>()

    private var testRegistration: NsdManager.RegistrationListener? = null

    private inner class Session(val type: String, var startCall: PluginCall?) : NsdManager.DiscoveryListener {
        private fun current() = session === this

        override fun onDiscoveryStarted(serviceType: String) = post {
            if (!current()) return@post
            startCall?.resolve()
            startCall = null
        }

        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = post {
            if (!current()) return@post
            session = null
            releaseLock()
            startCall?.reject("NSD discovery of $serviceType failed: error $errorCode", errorCode.toString())
            startCall = null
        }

        override fun onServiceFound(info: NsdServiceInfo) = post {
            if (current()) resolve(info)
        }

        override fun onServiceLost(info: NsdServiceInfo) = post {
            if (!current()) return@post
            val name = info.serviceName
            queue.remove(name)
            unwatch(name)
            notifyListeners("serviceLost", JSObject().put("name", name).put("type", info.serviceType ?: type))
        }

        override fun onDiscoveryStopped(serviceType: String) = Unit

        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = post {
            emitError("discovery", errorCode, "stopping discovery of $serviceType failed", null)
        }
    }

    override fun load() {
        nsd = context.getSystemService(NsdManager::class.java)
        thread = HandlerThread("KopernikadrNsd").apply { start() }
        handler = Handler(thread.looper)
        executor = Executor { handler.post(it) }
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager?
        lock = wifi?.createMulticastLock("kopernikadr-nsd")?.apply { setReferenceCounted(false) }
        queue = ResolveQueue(
            resolver = ::legacyResolve,
            schedule = { delay, action -> handler.postDelayed(action, delay) },
            onResolved = { _, info -> if (session != null) emitFound(info, legacyAddresses(info)) },
            onFailed = { name, code, attempts -> emitError("resolve", code, "resolve failed after $attempts attempt(s)", name) },
            // FAILURE_INTERNAL_ERROR (0) and FAILURE_ALREADY_ACTIVE (3) are transient.
            isRetryable = { it == NsdManager.FAILURE_INTERNAL_ERROR || it == NsdManager.FAILURE_ALREADY_ACTIVE },
        )
    }

    @PluginMethod
    fun startDiscovery(call: PluginCall) {
        val type = call.getString("type")?.takeIf { it.isNotBlank() } ?: SERVICE_TYPE
        post {
            stopSession()
            val s = Session(type, call)
            session = s
            acquireLock()
            try {
                nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, s)
            } catch (e: RuntimeException) {
                session = null
                releaseLock()
                call.reject("NSD discovery of $type failed: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun stopDiscovery(call: PluginCall) = post {
        stopSession()
        call.resolve()
    }

    @PluginMethod
    fun __testRegister(call: PluginCall) {
        if (!debuggable()) return call.unavailable("debug builds only")
        val name = call.getString("name") ?: return call.reject("name is required")
        val port = call.getInt("port") ?: return call.reject("port is required")
        val info = NsdServiceInfo().apply {
            serviceName = name
            serviceType = call.getString("type") ?: SERVICE_TYPE
            this.port = port
            call.getObject("txt")?.let { txt -> txt.keys().forEach { k -> setAttribute(k, txt.getString(k)) } }
        }
        post {
            testRegistration?.let { runCatching { nsd.unregisterService(it) } }
            val listener = object : NsdManager.RegistrationListener {
                override fun onServiceRegistered(si: NsdServiceInfo) = call.resolve(JSObject().put("name", si.serviceName))
                override fun onRegistrationFailed(si: NsdServiceInfo, errorCode: Int) =
                    call.reject("registration failed: error $errorCode", errorCode.toString())
                override fun onServiceUnregistered(si: NsdServiceInfo) = Unit
                override fun onUnregistrationFailed(si: NsdServiceInfo, errorCode: Int) = Unit
            }
            testRegistration = listener
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
        }
    }

    @PluginMethod
    fun __testUnregister(call: PluginCall) {
        if (!debuggable()) return call.unavailable("debug builds only")
        post {
            testRegistration?.let { runCatching { nsd.unregisterService(it) } }
            testRegistration = null
            call.resolve()
        }
    }

    override fun handleOnDestroy() {
        post {
            stopSession()
            testRegistration?.let { runCatching { nsd.unregisterService(it) } }
            testRegistration = null
            thread.quitSafely()
        }
    }

    private fun post(block: () -> Unit) {
        handler.post(block)
    }

    private fun debuggable() = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    private fun stopSession() {
        val s = session ?: return
        session = null
        try {
            nsd.stopServiceDiscovery(s)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "stopServiceDiscovery: ${e.message}")
        }
        s.startCall?.reject("discovery stopped before it started")
        s.startCall = null
        queue.clear()
        infoCallbacks.keys.toList().forEach(::unwatch)
        releaseLock()
    }

    private fun resolve(info: NsdServiceInfo) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) watch(info) else queue.enqueue(info.serviceName, info)
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun watch(info: NsdServiceInfo) {
        val name = info.serviceName
        if (name in infoCallbacks) return
        val cb = object : NsdManager.ServiceInfoCallback {
            override fun onServiceUpdated(si: NsdServiceInfo) {
                if (infoCallbacks[name] === this && session != null) emitFound(si, si.hostAddresses)
            }
            override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
                if (infoCallbacks[name] === this) infoCallbacks.remove(name)
                emitError("resolve", errorCode, "service info callback registration failed", name)
            }
            override fun onServiceLost() = Unit // the discovery listener reports it
            override fun onServiceInfoCallbackUnregistered() = Unit
        }
        infoCallbacks[name] = cb
        try {
            nsd.registerServiceInfoCallback(info, executor, cb)
        } catch (e: RuntimeException) {
            infoCallbacks.remove(name)
            emitError("resolve", NsdManager.FAILURE_INTERNAL_ERROR, "registerServiceInfoCallback: ${e.message}", name)
        }
    }

    private fun unwatch(name: String) {
        val cb = infoCallbacks.remove(name) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            runCatching { nsd.unregisterServiceInfoCallback(cb) }
        }
    }

    @Suppress("DEPRECATION")
    private fun legacyResolve(info: NsdServiceInfo, done: (ResolveQueue.Outcome<NsdServiceInfo>) -> Unit) {
        try {
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onServiceResolved(si: NsdServiceInfo) = post { done(ResolveQueue.Outcome.Ok(si)) }
                override fun onResolveFailed(si: NsdServiceInfo, errorCode: Int) = post { done(ResolveQueue.Outcome.Failed(errorCode)) }
            })
        } catch (e: RuntimeException) {
            Log.w(TAG, "resolveService: ${e.message}")
            post { done(ResolveQueue.Outcome.Failed(NsdManager.FAILURE_INTERNAL_ERROR)) }
        }
    }

    @Suppress("DEPRECATION")
    private fun legacyAddresses(info: NsdServiceInfo): List<InetAddress> = listOfNotNull(info.host)

    private fun emitFound(info: NsdServiceInfo, addresses: List<InetAddress>) {
        // hostAddress, never hostName: that would be a blocking reverse DNS lookup.
        val ordered = orderAddresses(addresses.mapNotNull { it.hostAddress })
        val txt = JSObject()
        decodeTxt(info.attributes ?: emptyMap()).forEach { (k, v) -> txt.put(k, v) }
        notifyListeners(
            "serviceFound",
            JSObject()
                .put("name", info.serviceName)
                .put("type", info.serviceType ?: session?.type ?: SERVICE_TYPE)
                .put("host", ordered.firstOrNull() ?: "")
                .put("addresses", JSArray(ordered))
                .put("port", info.port)
                .put("txt", txt),
        )
    }

    private fun emitError(stage: String, code: Int, message: String, name: String?) {
        Log.w(TAG, "$stage error $code${name?.let { " ($it)" } ?: ""}: $message")
        val e = JSObject().put("stage", stage).put("code", code.toString()).put("message", message)
        if (name != null) e.put("name", name)
        notifyListeners("discoveryError", e)
    }

    private fun acquireLock() {
        try {
            lock?.acquire()
        } catch (e: SecurityException) {
            Log.w(TAG, "multicast lock: ${e.message}")
        }
    }

    private fun releaseLock() {
        lock?.takeIf { it.isHeld }?.release()
    }

    private companion object {
        const val TAG = "KopernikadrNsd"
    }
}
