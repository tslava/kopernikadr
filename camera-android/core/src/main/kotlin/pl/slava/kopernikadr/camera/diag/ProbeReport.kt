package pl.slava.kopernikadr.camera.diag

import java.io.File
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// Run status and report shapes. They match what protocol/tools/probe-client/diag.mjs expects:
//   RunStatus = {runId, name, state: running|waiting|done|failed, step?, prompt?: {id,text}, error?}
//   Report    = RunStatus fields + startedAt/finishedAt + env + args + probe data + files: [names]

@Serializable
enum class RunState {
    @SerialName("running") RUNNING,
    /** Blocked on a user prompt ([RunStatus.prompt] is set). */
    @SerialName("waiting") WAITING,
    @SerialName("done") DONE,
    @SerialName("failed") FAILED,
    ;

    val isTerminal: Boolean get() = this == DONE || this == FAILED
}

@Serializable
data class Prompt(val id: String, val text: String)

@Serializable
data class RunStatus(
    val runId: String,
    val name: String,
    val state: RunState,
    /** Free-form progress text. */
    val step: String? = null,
    /** Set while [state] is [RunState.WAITING]. */
    val prompt: Prompt? = null,
    /** Set when [state] is [RunState.FAILED]. */
    val error: String? = null,
)

/** Result of [ProbeRunnerCore.start]. */
sealed interface StartResult {
    data class Started(val runId: String) : StartResult

    /** Another run is active (`/diag/probe` answers 409). */
    data class Busy(val runId: String) : StartResult

    data class UnknownProbe(val name: String) : StartResult
}

/** One probe. Created per run by the factory registered under its name, with the run's args. */
fun interface Probe {
    suspend fun run(ctx: ProbeContext)
}

/** What a running probe can do. */
interface ProbeContext {
    val runId: String
    val runDir: File
    val args: JsonObject

    /** Sets the progress text and rewrites the report. */
    fun step(text: String)

    /**
     * Adds probe data to the report (top-level key). Reserved keys (the status fields, `files`,
     * `env`, `args`, `startedAt`, `finishedAt`, `stackTrace`) are rejected.
     */
    fun put(key: String, value: JsonElement)

    /** A file in the run dir; [name] must match [ProbeRunnerCore.SAFE_NAME]. */
    fun file(name: String): File

    /** Rewrites `report.json` now (it is also rewritten on every state change). */
    fun writeReport()

    /**
     * Suspends until the camera is bound. With [fresh], waits for a bind that happens after this
     * call even if the camera is bound now (e.g. after a restart step).
     */
    suspend fun awaitCameraBound(fresh: Boolean = false)

    /** Shows a full-screen prompt and suspends until the user (or `/diag/continue`) continues it. */
    suspend fun prompt(id: String, text: String)
}
