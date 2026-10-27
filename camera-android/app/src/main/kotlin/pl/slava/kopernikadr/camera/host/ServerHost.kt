package pl.slava.kopernikadr.camera.host

import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import pl.slava.kopernikadr.camera.App
import pl.slava.kopernikadr.camera.BuildConfig
import pl.slava.kopernikadr.camera.camera.CharacteristicsReader
import pl.slava.kopernikadr.camera.core.CapabilityMapper
import pl.slava.kopernikadr.camera.image.AndroidImageCodec
import pl.slava.kopernikadr.camera.image.PreviewEncoder
import pl.slava.kopernikadr.camera.image.StillPipeline
import pl.slava.kopernikadr.camera.net.AdvertisedServer
import pl.slava.kopernikadr.camera.net.Advertisement
import pl.slava.kopernikadr.camera.net.NsdAdvertiser
import pl.slava.kopernikadr.camera.net.ServiceAdvertiser
import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.CaptureArgs
import pl.slava.kopernikadr.camera.protocol.FrameInfo
import pl.slava.kopernikadr.camera.protocol.OperationState
import pl.slava.kopernikadr.camera.protocol.Status
import pl.slava.kopernikadr.camera.server.CameraPorts
import pl.slava.kopernikadr.camera.server.CameraServer
import pl.slava.kopernikadr.camera.server.CaptureService
import pl.slava.kopernikadr.camera.server.IdentityPort
import pl.slava.kopernikadr.camera.server.PortResult
import pl.slava.kopernikadr.camera.server.ServerConfig
import pl.slava.kopernikadr.camera.server.SessionManager
import pl.slava.kopernikadr.camera.server.StatusPort
import pl.slava.kopernikadr.camera.spool.DerivedFiles
import pl.slava.kopernikadr.camera.spool.DurableFiles
import pl.slava.kopernikadr.camera.spool.Spool
import pl.slava.kopernikadr.camera.spool.SpoolCaptureService
import pl.slava.kopernikadr.camera.spool.SpoolFrameStore
import pl.slava.kopernikadr.camera.spool.AndroidDirSync

/** What the status screen shows about the server. */
data class ServerState(
    /** Bound port while running, else null. */
    val port: Int? = null,
    /** A tablet holds the control session. */
    val connected: Boolean = false,
    val error: String? = null,
)

/**
 * Hosts the [CameraServer] over the camera, the controls and the spool. Application-scoped;
 * [MainActivity][pl.slava.kopernikadr.camera.MainActivity] calls [start] on ON_START (with CAMERA
 * granted) and [stop] on ON_STOP. Start/stop run in order on one background thread (stop blocks
 * ~1.2 s). The spool and the capture service are built on the first start and kept for the
 * process lifetime (captures outlive a server restart); every start gets a new `bootId`.
 *
 * While bound, the server is advertised over DNS-SD ([AdvertisedServer]: registered after the
 * bind with the bound port, unregistered before the server stops).
 */
class ServerHost(
    private val app: App,
    private val advertiser: ServiceAdvertiser = NsdAdvertiser(app),
) {
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "kopernikadr-server") }
    private val serial = executor.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _state = MutableStateFlow(ServerState())
    val state: StateFlow<ServerState> = _state.asStateFlow()

    // Confined to [serial].
    private var stack: Stack? = null
    private var server: AdvertisedServer? = null
    private var sessions: SessionManager? = null
    private var poll: Job? = null

    private class Stack(val cameraId: String, val ports: (bootId: String) -> CameraPorts)

    fun start() {
        scope.launch(serial) { startNow() }
    }

    fun stop() {
        scope.launch(serial) { stopNow() }
    }

    private fun startNow() {
        if (server != null) return
        try {
            val s = stack ?: build()?.also { stack = it } ?: return
            val bootId = UUID.randomUUID().toString()
            val sm = SessionManager()
            val config = ServerConfig(sessions = sm, allowLocalhostAnyPort = BuildConfig.CORS_LOCALHOST_ANY_PORT)
            val cs = CameraServer(s.ports(bootId), config)
            val srv = AdvertisedServer(
                bind = cs::start,
                unbind = cs::stop,
                advertiser = advertiser,
                advertisement = { p -> Advertisement.forCamera(s.cameraId, NAME, p) },
                log = { Log.w(TAG, it) },
            )
            val t0 = SystemClock.elapsedRealtime()
            val port = srv.start()
            Log.i(TAG, "server bound on port $port in ${SystemClock.elapsedRealtime() - t0} ms (bootId $bootId, cameraId ${s.cameraId})")
            server = srv
            sessions = sm
            _state.value = ServerState(port = port)
            poll = scope.launch {
                var last = false
                while (isActive) {
                    val connected = sm.current() != null
                    if (connected != last) {
                        Log.i(TAG, if (connected) "tablet connected" else "tablet disconnected")
                        last = connected
                    }
                    _state.update { if (it.port == port) it.copy(connected = connected) else it }
                    delay(POLL_MS)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "server start failed", e)
            _state.value = ServerState(error = e.toString())
        }
    }

    private fun stopNow() {
        val srv = server ?: return
        poll?.cancel()
        poll = null
        server = null
        sessions = null
        val t0 = SystemClock.elapsedRealtime()
        srv.stop()
        Log.i(TAG, "server stopped in ${SystemClock.elapsedRealtime() - t0} ms")
        _state.value = ServerState()
    }

    private fun build(): Stack? {
        val controls = app.ensureControls()
        if (controls == null) {
            Log.e(TAG, "no controls (CAMERA not granted or characteristics unreadable): server not started")
            return null
        }
        val camera = app.camera
        val reader = CharacteristicsReader(app)
        val caps = CapabilityMapper.map(reader.read(reader.backCameraId()))
        val files = DurableFiles(AndroidDirSync())
        val cameraId = IdentityStore(app.filesDir, files, log = { Log.i(TAG, it) }).cameraId()
        val spool = Spool.open(File(app.filesDir, "spool"))
        val codec = AndroidImageCodec()
        val pipeline = StillPipeline(codec)
        val derived = DerivedFiles(spool, pipeline, files, log = { Log.w(CAP_TAG, it) })
        val admission = CaptureAdmission(
            controls = controls.controls,
            currentControls = { controls.controls.value },
            cameraReady = { camera.status.value.ready },
            freeBytes = ::freeBytes,
        )
        val capture = SpoolCaptureService(
            camera = camera,
            pipeline = pipeline,
            spool = spool,
            files = files,
            derived = derived,
            scope = scope,
            admissionCheck = { _, args -> admission.check(args) },
            log = { Log.i(CAP_TAG, it) },
        )
        val guarded = GuardedControls(controls, capture.admission) { capture.isCapturing }
        val frames = SpoolFrameStore(spool, derived)
        val preview = CameraPreviewSource(camera, PreviewEncoder(codec), { controls.controls.value }, log = { Log.w(TAG, it) })
        val status = StatusPort { status(spool) }
        val loggedCapture = LoggingCapture(capture)
        Log.i(TAG, "stack ready: spool ${spool.dir}, ${spool.stats()}")
        return Stack(cameraId) { bootId ->
            val identity = object : IdentityPort {
                override val cameraId: String = cameraId
                override val bootId: String = bootId
                override val name: String = NAME
                override fun capabilities(): Capabilities = caps
            }
            CameraPorts(identity, status, guarded, loggedCapture, frames, preview)
        }
    }

    private fun freeBytes(): Long = StatFs(app.filesDir.path).availableBytes

    private fun status(spool: Spool): Status {
        val battery = app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) level * 100 / scale else 0
        val plugged = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        val stats = spool.stats()
        val thermal = app.getSystemService(PowerManager::class.java)?.currentThermalStatus ?: -1
        return Status(
            batteryPct = pct,
            charging = plugged,
            freeBytes = freeBytes(),
            spoolBytes = stats.fullBytes,
            unackedCount = stats.unackedCount,
            orphanCount = 0,
            integrityErrors = 0,
            thermal = ThermalMapping.fromAndroid(thermal),
        )
    }

    /** Logs every capture request and its outcome under [CAP_TAG]. */
    private class LoggingCapture(private val delegate: CaptureService) : CaptureService {
        override suspend fun capture(clientId: String, reqId: String, args: CaptureArgs): PortResult<FrameInfo> {
            val t0 = SystemClock.elapsedRealtime()
            Log.i(CAP_TAG, "capture req $reqId client $clientId project ${args.projectId} rot ${args.rotation}")
            val r = delegate.capture(clientId, reqId, args)
            val ms = SystemClock.elapsedRealtime() - t0
            when (r) {
                is PortResult.Ok -> Log.i(CAP_TAG, "capture req $reqId -> ${r.value.frameId} seq ${r.value.seq} in $ms ms")
                is PortResult.Err -> Log.w(CAP_TAG, "capture req $reqId -> ${r.error.code} (${r.error.message}) in $ms ms")
            }
            return r
        }

        override fun getOperation(clientId: String, reqId: String): OperationState = delegate.getOperation(clientId, reqId)
    }

    companion object {
        const val TAG = "KopernikadrSrv"
        const val CAP_TAG = "KopernikadrCap"
        const val NAME = "Kopernikadr Kamera"
        private const val POLL_MS = 500L
    }
}
