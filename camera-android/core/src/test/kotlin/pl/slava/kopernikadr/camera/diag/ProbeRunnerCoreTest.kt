package pl.slava.kopernikadr.camera.diag

import java.io.File
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class ProbeRunnerCoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val clock = Clock.fixed(Instant.parse("2026-10-26T15:04:05Z"), ZoneOffset.UTC)
    private val finished = mutableListOf<RunStatus>()

    private fun TestScope.runner(probes: Map<String, (JsonObject) -> Probe>) = ProbeRunnerCore(
        rootDir = tmp.root,
        scope = backgroundScope,
        probes = probes,
        clock = clock,
        environment = buildJsonObject { put("debuggable", false) },
        onFinished = { status, _ -> finished += status },
    )

    private fun probe(body: suspend ProbeContext.() -> Unit) = { _: JsonObject -> Probe { ctx -> ctx.body() } }

    private fun started(r: StartResult): String =
        (r as? StartResult.Started)?.runId ?: throw AssertionError("expected Started, got $r")

    private fun reportOnDisk(runId: String): JsonObject =
        Json.parseToJsonElement(File(tmp.root, "$runId/report.json").readText()).jsonObject

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    @Test
    fun `a run writes report json with status, data, env and files`() = runTest {
        val r = runner(mapOf("caps" to probe {
            step("reading")
            put("answer", JsonPrimitive(42))
            file("extra.txt").writeText("hi")
        }))
        val runId = started(r.start("caps"))
        runCurrent()

        val status = r.status.value!!
        assertEquals(RunStatus(runId, "caps", RunState.DONE, step = "reading"), status)
        val report = reportOnDisk(runId)
        assertEquals(runId, report.str("runId"))
        assertEquals("caps", report.str("name"))
        assertEquals("done", report.str("state"))
        assertEquals(42, report["answer"]!!.jsonPrimitive.int)
        assertEquals(false, report["env"]!!.jsonObject["debuggable"]!!.jsonPrimitive.content.toBoolean())
        assertEquals("2026-10-26T15:04:05Z", report.str("startedAt"))
        assertEquals("2026-10-26T15:04:05Z", report.str("finishedAt"))
        assertNull(report["prompt"])
        assertNull(report["error"])
        val files = report["files"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("extra.txt", "report.json"), files)
        assertEquals(files, r.files(runId))
        assertFalse("no tmp file left", File(tmp.root, runId).list()!!.any { it.endsWith(".tmp") })
        assertEquals(report, r.report(runId))
        assertEquals(report, r.lastReport.value)
        assertEquals(listOf(status), finished)
    }

    @Test
    fun `runId is sortable and safe`() = runTest {
        val r = runner(mapOf("caps" to probe {}))
        val first = started(r.start("caps"))
        runCurrent()
        val second = started(r.start("caps"))
        runCurrent()
        assertEquals("20261026-150405-caps", first)
        assertNotEquals(first, second)
        assertTrue(second > first)
        for (id in listOf(first, second)) assertTrue(id, ProbeRunnerCore.SAFE_NAME.matches(id))
    }

    @Test
    fun `only one probe runs at a time`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val r = runner(mapOf("slow" to probe { gate.await() }, "caps" to probe {}))
        val runId = started(r.start("slow"))
        runCurrent()
        assertEquals(StartResult.Busy(runId), r.start("caps"))
        assertEquals(StartResult.Busy(runId), r.start("slow"))
        gate.complete(Unit)
        runCurrent()
        assertEquals(RunState.DONE, r.status.value!!.state)
        started(r.start("caps"))
    }

    @Test
    fun `unknown probe is rejected`() = runTest {
        val r = runner(mapOf("caps" to probe {}))
        assertEquals(StartResult.UnknownProbe("nope"), r.start("nope"))
        assertNull(r.status.value)
    }

    @Test
    fun `probe args reach the factory`() = runTest {
        var seen: JsonObject? = null
        val r = runner(mapOf("locks" to { args: JsonObject -> seen = args; Probe { } }))
        val args = buildJsonObject { put("manualRestart", true) }
        started(r.start("locks", args))
        runCurrent()
        assertEquals(args, seen)
        assertEquals(args, r.lastReport.value!!["args"])
    }

    @Test
    fun `a failure is captured in the report and frees the runner`() = runTest {
        val r = runner(mapOf("bad" to probe {
            put("partial", JsonPrimitive("kept"))
            error("boom")
        }, "caps" to probe {}))
        val runId = started(r.start("bad"))
        runCurrent()
        val status = r.status.value!!
        assertEquals(RunState.FAILED, status.state)
        assertTrue(status.error!!, "boom" in status.error!!)
        val report = reportOnDisk(runId)
        assertEquals("failed", report.str("state"))
        assertTrue("boom" in report.str("error")!!)
        assertEquals("kept", report.str("partial"))
        assertTrue("stack trace recorded", "IllegalStateException" in report.str("stackTrace")!!)
        assertEquals(listOf(status), finished)
        started(r.start("caps"))
    }

    @Test
    fun `prompt waits for continue with the matching prompt id`() = runTest {
        val r = runner(mapOf("locks" to probe {
            step("S1")
            prompt("card-in", "Put the card into the frame")
            step("S2")
        }))
        val runId = started(r.start("locks"))
        runCurrent()

        val waiting = r.status.value!!
        assertEquals(RunState.WAITING, waiting.state)
        assertEquals(Prompt("card-in", "Put the card into the frame"), waiting.prompt)
        // polled report reflects the prompt
        val polled = reportOnDisk(runId)
        assertEquals("waiting", polled.str("state"))
        assertEquals("card-in", polled["prompt"]!!.jsonObject.str("id"))
        assertEquals(1, r.runs().size)
        assertEquals(waiting, r.runs().single())

        assertFalse(r.continueRun(runId, "other"))
        assertFalse(r.continueRun("20200101-000000-x", "card-in"))
        runCurrent()
        assertEquals(RunState.WAITING, r.status.value!!.state)

        assertTrue(r.continueRun(runId, "card-in"))
        runCurrent()
        assertEquals(RunStatus(runId, "locks", RunState.DONE, step = "S2"), r.status.value)
        assertFalse("prompt is no longer pending", r.continueRun(runId, "card-in"))
    }

    @Test
    fun `awaitCameraBound waits for a bind`() = runTest {
        val r = runner(mapOf("streams" to probe {
            awaitCameraBound()
            step("bound")
        }))
        started(r.start("streams"))
        runCurrent()
        assertEquals(RunState.RUNNING, r.status.value!!.state)
        assertEquals(ProbeRunnerCore.STEP_WAITING_FOR_CAMERA, r.status.value!!.step)
        r.setCameraBound(true)
        runCurrent()
        assertEquals(RunState.DONE, r.status.value!!.state)
        assertEquals("bound", r.status.value!!.step)
    }

    @Test
    fun `awaitCameraBound returns at once when already bound, fresh waits for the next bind`() = runTest {
        val marks = mutableListOf<String>()
        val r = runner(mapOf("locks" to probe {
            awaitCameraBound()
            marks += "bound"
            awaitCameraBound(fresh = true)
            marks += "rebound"
        }))
        r.setCameraBound(true)
        started(r.start("locks"))
        runCurrent()
        assertEquals(listOf("bound"), marks)
        r.setCameraBound(false)
        runCurrent()
        assertEquals(listOf("bound"), marks)
        r.setCameraBound(true)
        runCurrent()
        assertEquals(listOf("bound", "rebound"), marks)
        assertEquals(RunState.DONE, r.status.value!!.state)
    }

    @Test
    fun `runs lists finished runs newest first and marks interrupted ones failed`() = runTest {
        // a report left "running" by a process that died
        val dead = File(tmp.root, "20261025-100000-locks").apply { mkdirs() }
        File(dead, "report.json").writeText("""{"runId":"20261025-100000-locks","name":"locks","state":"running","step":"S2"}""")
        File(tmp.root, "not-a-run").mkdirs() // no report.json: ignored

        val r = runner(mapOf("caps" to probe {}))
        val runId = started(r.start("caps"))
        runCurrent()

        val runs = r.runs()
        assertEquals(listOf(runId, dead.name), runs.map { it.runId })
        assertEquals(RunState.DONE, runs[0].state)
        assertEquals(RunState.FAILED, runs[1].state)
        assertEquals(ProbeRunnerCore.ERROR_INTERRUPTED, runs[1].error)
        assertEquals("failed", r.report(dead.name)!!.str("state"))
    }

    @Test
    fun `report and files reject unsafe run ids and names`() = runTest {
        val r = runner(mapOf("caps" to probe {
            assertThrows(IllegalArgumentException::class.java) { file("../escape.txt") }
            assertThrows(IllegalArgumentException::class.java) { put("state", JsonPrimitive("x")) }
        }))
        val runId = started(r.start("caps"))
        runCurrent()
        assertEquals(RunState.DONE, r.status.value!!.state)
        assertNull(r.report("../etc"))
        assertNull(r.report("19990101-000000-none"))
        assertTrue(r.files("..").isEmpty())
        assertNull(r.file(runId, "../report.json"))
        assertEquals(File(tmp.root, "$runId/report.json"), r.file(runId, "report.json"))
        assertNull(r.file(runId, "missing.png"))
    }
}
