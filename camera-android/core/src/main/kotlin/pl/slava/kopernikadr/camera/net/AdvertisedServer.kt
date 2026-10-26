package pl.slava.kopernikadr.camera.net

/**
 * Publishes an [Advertisement] (Android: NSD). Both calls are idempotent: [register] with the
 * current advertisement does nothing, with another one replaces it; [unregister] without a
 * registration does nothing. Implementations may fail asynchronously (they log); a synchronous
 * failure throws.
 */
interface ServiceAdvertiser {
    fun register(ad: Advertisement)
    fun unregister()
}

/**
 * A server that is advertised while it is bound: [start] binds, then registers with the bound
 * port; [stop] unregisters, then unbinds, so remotes never resolve a closed port for longer than
 * the NSD round trip. Advertiser failures are [log]ged and never fail the server. Not
 * thread-safe: call from one thread (ServerHost's serial executor).
 */
class AdvertisedServer(
    private val bind: () -> Int,
    private val unbind: () -> Unit,
    private val advertiser: ServiceAdvertiser,
    private val advertisement: (port: Int) -> Advertisement,
    private val log: (String) -> Unit = {},
) {
    /** The bound port while started, else null. */
    var port: Int? = null
        private set

    /** Binds (a bind failure throws, nothing is advertised) and advertises; returns the port. */
    fun start(): Int {
        port?.let { return it }
        val p = bind()
        port = p
        try {
            advertiser.register(advertisement(p))
        } catch (e: Exception) {
            log("advertising on port $p failed: $e")
        }
        return p
    }

    fun stop() {
        if (port == null) return
        port = null
        try {
            advertiser.unregister()
        } catch (e: Exception) {
            log("unadvertising failed: $e")
        }
        unbind()
    }
}
