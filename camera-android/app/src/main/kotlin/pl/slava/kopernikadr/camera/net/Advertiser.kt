package pl.slava.kopernikadr.camera.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log

/**
 * Advertises the camera over DNS-SD with [NsdManager] (PROTOCOL §3). Needs no runtime permission
 * (INTERNET is enough). Idempotent per [ServiceAdvertiser]; every failure, synchronous or reported
 * by the listener, is logged and never thrown. NSD may rename the instance on a name conflict
 * ("… (2)"); the registered name is logged. Thread-safe: calls come from the server thread,
 * callbacks from NSD's own thread.
 */
class NsdAdvertiser(private val context: Context) : ServiceAdvertiser {
    private val nsd: NsdManager? by lazy { context.getSystemService(NsdManager::class.java) }
    private val lock = Any()

    // Guarded by [lock]: the registration in flight or done; null when none.
    private var current: Registration? = null

    override fun register(ad: Advertisement) {
        synchronized(lock) {
            if (current?.ad == ad) return
            unregisterLocked()
            val manager = nsd ?: run {
                Log.w(TAG, "no NsdManager: not advertising")
                return
            }
            val info = NsdServiceInfo().apply {
                serviceName = ad.instanceName
                serviceType = ad.serviceType
                port = ad.port
                ad.txt.entries.forEach { (k, v) -> setAttribute(k, v) }
            }
            val reg = Registration(ad)
            try {
                manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, reg)
                current = reg
                Log.i(TAG, "registering '${ad.instanceName}' ${ad.serviceType} port ${ad.port} ${ad.txt}")
            } catch (e: RuntimeException) {
                Log.w(TAG, "registerService failed for '${ad.instanceName}'", e)
            }
        }
    }

    override fun unregister() {
        synchronized(lock) { unregisterLocked() }
    }

    private fun unregisterLocked() {
        val reg = current ?: return
        current = null
        try {
            nsd?.unregisterService(reg)
            Log.i(TAG, "unregistering '${reg.registeredName ?: reg.ad.instanceName}'")
        } catch (e: IllegalArgumentException) {
            // The listener is no longer known: its registration failed meanwhile.
            Log.w(TAG, "unregisterService: ${e.message}")
        } catch (e: RuntimeException) {
            Log.w(TAG, "unregisterService failed", e)
        }
    }

    private inner class Registration(val ad: Advertisement) : NsdManager.RegistrationListener {
        @Volatile
        var registeredName: String? = null

        override fun onServiceRegistered(info: NsdServiceInfo) {
            registeredName = info.serviceName
            val renamed = if (info.serviceName != ad.instanceName) " (renamed from '${ad.instanceName}')" else ""
            Log.i(TAG, "registered '${info.serviceName}'$renamed ${ad.serviceType} port ${ad.port}")
        }

        override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
            Log.w(TAG, "registration of '${ad.instanceName}' port ${ad.port} failed: ${errorName(errorCode)}")
            synchronized(lock) { if (current === this) current = null }
        }

        override fun onServiceUnregistered(info: NsdServiceInfo) {
            Log.i(TAG, "unregistered '${info.serviceName}'")
        }

        override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {
            Log.w(TAG, "unregistration of '${info.serviceName}' failed: ${errorName(errorCode)}")
        }
    }

    companion object {
        const val TAG = "KopernikadrNsd"

        private fun errorName(code: Int): String = when (code) {
            NsdManager.FAILURE_INTERNAL_ERROR -> "INTERNAL_ERROR"
            NsdManager.FAILURE_ALREADY_ACTIVE -> "ALREADY_ACTIVE"
            NsdManager.FAILURE_MAX_LIMIT -> "MAX_LIMIT"
            else -> "error $code"
        }
    }
}
