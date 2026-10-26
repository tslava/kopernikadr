package pl.slava.kopernikadr.camera.diag

import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Clock
import java.time.Instant
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject

/**
 * Runs diagnostics probes one at a time (plan "ProbeRunner"). Each run gets `<rootDir>/<runId>/`
 * with a `report.json` that is rewritten (tmp + rename) on every state change, so it can be
 * polled while the run is active. A probe exception ends the run as `failed` with the error in
 * the report. Steps can wait for a camera bind ([setCameraBound]) and for a user "Continue"
 * ([continueRun]).
 *
 * Lives as long as the [scope] it is given (the Application scope on Android), so a run survives
 * activity recreation and screen lock.
 */
class ProbeRunnerCore(
    private val rootDir: File,
    private val scope: CoroutineScope,
    private val probes: Map<String, (args: JsonObject) -> Probe>,
    private val clock: Clock = Clock.systemDefaultZone(),
    /** Written as `env` into every report (build type, debuggable, device, …). */
    private val environment: JsonObject = JsonObject(emptyMap()),
    /** Called once per run after the final report is written. */
    private val onFinished: (RunStatus, JsonObject) -> Unit = { _, _ -> },
) {
    private data class Binding(val bound: Boolean, val generation: Long)

    private val lock = Any()
    private var active: ActiveRun? = null
    private val binding = MutableStateFlow(Binding(bound = false, generation = 0))

    private val _status = MutableStateFlow<RunStatus?>(null)

    /** The active run, or the last one of this process; null before the first run. */
    val status: StateFlow<RunStatus?> = _status.asStateFlow()

    private val _lastReport = MutableStateFlow<JsonObject?>(null)

    /** The report last written by this process. */
    val lastReport: StateFlow<JsonObject?> = _lastReport.asStateFlow()

    val probeNames: List<String> get() = probes.keys.toList()

    fun start(name: String, args: JsonObject = JsonObject(emptyMap())): StartResult {
        val run = synchronized(lock) {
            active?.let { return StartResult.Busy(it.runId) }
            val factory = probes[name] ?: return StartResult.UnknownProbe(name)
            val runId = newRunId(name)
            val dir = File(rootDir, runId)
            check(dir.mkdirs()) { "cannot create run dir $dir" }
            ActiveRun(runId, name, dir, args, factory, clock.instant()).also {
                active = it
                it.publish()
            }
        }
        scope.launch { execute(run) }
        return StartResult.Started(run.runId)
    }

    /** Answers the pending prompt [promptId] of run [runId]; false if it is not pending (409). */
    fun continueRun(runId: String, promptId: String): Boolean = synchronized(lock) {
        val run = active?.takeIf { it.runId == runId } ?: return false
        val pending = run.pendingPrompt?.takeIf { it.first == promptId } ?: return false
        run.pendingPrompt = null
        run.status = run.status.copy(state = RunState.RUNNING, prompt = null)
        run.publish()
        pending.second.complete(Unit)
        true
    }

    /** Reported by the camera controller on every bind / unbind. */
    fun setCameraBound(bound: Boolean) {
        binding.update {
            when {
                bound && !it.bound -> Binding(true, it.generation + 1)
                !bound -> it.copy(bound = false)
                else -> it
            }
        }
    }

    /** All runs in [rootDir], newest first. A non-terminal run that is not active is reported failed. */
    fun runs(): List<RunStatus> {
        val activeStatus = synchronized(lock) { active?.status }
        val dirs = rootDir.listFiles { f -> f.isDirectory && SAFE_NAME.matches(f.name) }.orEmpty()
        return dirs.mapNotNull { dir ->
            if (dir.name == activeStatus?.runId) activeStatus else readReport(dir.name)?.let(::statusOf)
        }.sortedByDescending { it.runId }
    }

    /** The run's report as on disk (interrupted runs patched to `failed`), or null. */
    fun report(runId: String): JsonObject? = readReport(runId)

    /** Names of the files in the run dir. */
    fun files(runId: String): List<String> {
        if (!SAFE_NAME.matches(runId)) return emptyList()
        return listFiles(File(rootDir, runId))
    }

    /** An existing file of a run, or null (also for unsafe names). */
    fun file(runId: String, name: String): File? {
        if (!SAFE_NAME.matches(runId) || !SAFE_NAME.matches(name)) return null
        return File(File(rootDir, runId), name).takeIf { it.isFile }
    }

    private suspend fun execute(run: ActiveRun) {
        try {
            run.factory(run.args).run(run)
            finish(run, RunState.DONE, error = null, stackTrace = null)
        } catch (e: CancellationException) {
            finish(run, RunState.FAILED, "cancelled", stackTrace = null)
            throw e
        } catch (e: Throwable) {
            finish(run, RunState.FAILED, "${e::class.simpleName}: ${e.message}", e.stackTraceToString())
        }
    }

    private fun finish(run: ActiveRun, state: RunState, error: String?, stackTrace: String?) {
        val report = synchronized(lock) {
            try {
                run.pendingPrompt = null
                run.finishedAt = clock.instant()
                run.stackTrace = stackTrace?.take(MAX_STACK_TRACE)
                run.status = run.status.copy(state = state, prompt = null, error = error)
                run.publish()
            } finally {
                if (active === run) active = null
            }
        }
        runCatching { onFinished(run.status, report) }
    }

    private fun newRunId(name: String): String {
        val base = ID_TIME.format(clock.instant().atZone(clock.zone)) + "-" + name
        var id = base
        var n = 2
        while (File(rootDir, id).exists()) id = "$base-${n++}"
        require(SAFE_NAME.matches(id)) { "unsafe probe name '$name'" }
        return id
    }

    private fun readReport(runId: String): JsonObject? {
        if (!SAFE_NAME.matches(runId)) return null
        val file = File(File(rootDir, runId), REPORT)
        val report = runCatching { ReportJson.parseToJsonElement(file.readText()).jsonObject }.getOrNull()
            ?: return null
        val state = runCatching { ReportJson.decodeFromJsonElement(RunStatus.serializer(), report).state }
            .getOrNull() ?: return report
        val isActive = synchronized(lock) { active?.runId == runId }
        if (state.isTerminal || isActive) return report
        return JsonObject(
            report - "prompt" + mapOf("state" to JsonPrimitive("failed"), "error" to JsonPrimitive(ERROR_INTERRUPTED)),
        )
    }

    private fun statusOf(report: JsonObject): RunStatus? =
        runCatching { ReportJson.decodeFromJsonElement(RunStatus.serializer(), report) }.getOrNull()?.let {
            if (it.state.isTerminal || synchronized(lock) { active?.runId == it.runId }) it
            else it.copy(state = RunState.FAILED, prompt = null, error = ERROR_INTERRUPTED)
        }

    private fun listFiles(dir: File): List<String> =
        dir.listFiles { f -> f.isFile && !f.name.endsWith(TMP_SUFFIX) && SAFE_NAME.matches(f.name) }
            .orEmpty().map { it.name }.sorted()

    private inner class ActiveRun(
        override val runId: String,
        val name: String,
        override val runDir: File,
        override val args: JsonObject,
        val factory: (JsonObject) -> Probe,
        val startedAt: Instant,
    ) : ProbeContext {
        // All mutable state is guarded by `lock`.
        var status = RunStatus(runId, name, RunState.RUNNING)
        var finishedAt: Instant? = null
        var stackTrace: String? = null
        var pendingPrompt: Pair<String, CompletableDeferred<Unit>>? = null
        private val data = LinkedHashMap<String, JsonElement>()

        override fun step(text: String) {
            synchronized(lock) {
                status = status.copy(step = text)
                publish()
            }
        }

        override fun put(key: String, value: JsonElement) {
            require(key !in RESERVED) { "reserved report key '$key'" }
            synchronized(lock) { data[key] = value }
        }

        override fun file(name: String): File {
            require(SAFE_NAME.matches(name) && !name.endsWith(TMP_SUFFIX) && name != REPORT) { "bad file name '$name'" }
            return File(runDir, name)
        }

        override fun writeReport() {
            synchronized(lock) { publish() }
        }

        override suspend fun awaitCameraBound(fresh: Boolean) {
            val start = binding.value
            if (!fresh && start.bound) return
            step(STEP_WAITING_FOR_CAMERA)
            binding.first { it.bound && (!fresh || it.generation > start.generation) }
        }

        override suspend fun prompt(id: String, text: String) {
            require(SAFE_NAME.matches(id)) { "bad prompt id '$id'" }
            val answered = CompletableDeferred<Unit>()
            synchronized(lock) {
                pendingPrompt = id to answered
                status = status.copy(state = RunState.WAITING, prompt = Prompt(id, text))
                publish()
            }
            answered.await() // continueRun switches the status back to running
        }

        /** Writes report.json and updates the flows. Call with `lock` held. */
        fun publish(): JsonObject {
            val report = buildReport()
            writeAtomically(File(runDir, REPORT), ReportJson.encodeToString(JsonObject.serializer(), report))
            _status.value = status
            _lastReport.value = report
            return report
        }

        private fun buildReport(): JsonObject = buildJsonObject {
            ReportJson.encodeToJsonElement(RunStatus.serializer(), status).jsonObject.forEach { (k, v) -> put(k, v) }
            put("startedAt", JsonPrimitive(startedAt.toString()))
            finishedAt?.let { put("finishedAt", JsonPrimitive(it.toString())) }
            put("env", environment)
            put("args", args)
            data.forEach { (k, v) -> put(k, v) }
            stackTrace?.let { put("stackTrace", JsonPrimitive(it)) }
            put("files", JsonArray((listFiles(runDir) + REPORT).distinct().sorted().map(::JsonPrimitive)))
        }
    }

    companion object {
        /** Run ids, file names and prompt ids: what `/diag` accepts in a path segment. */
        val SAFE_NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
        const val REPORT = "report.json"
        const val STEP_WAITING_FOR_CAMERA = "waiting for camera"
        const val ERROR_INTERRUPTED = "interrupted: the app process ended during the run"
        private const val TMP_SUFFIX = ".tmp"
        private const val MAX_STACK_TRACE = 8_000
        private val RESERVED = setOf(
            "runId", "name", "state", "step", "prompt", "error",
            "startedAt", "finishedAt", "env", "args", "stackTrace", "files",
        )
        private val ID_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")

        /** Report JSON: pretty, absent optionals omitted, unknown keys ignored on read. */
        val ReportJson: Json = Json {
            prettyPrint = true
            encodeDefaults = true
            explicitNulls = false
            ignoreUnknownKeys = true
        }

        /** tmp + rename, so a reader never sees a half-written file. */
        fun writeAtomically(target: File, text: String) {
            val tmp = File(target.parentFile, target.name + TMP_SUFFIX)
            tmp.writeText(text)
            try {
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        }
    }
}
