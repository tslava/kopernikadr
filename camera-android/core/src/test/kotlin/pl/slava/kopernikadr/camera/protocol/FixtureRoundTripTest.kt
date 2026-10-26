package pl.slava.kopernikadr.camera.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Contract test: every fixture in `protocol/fixtures` parses into its model and re-encodes to
 * equal JSON (PROTOCOL.md: fixtures are normative).
 */
class FixtureRoundTripTest {

    /** Fixture name → check. Each check decodes, asserts a few typed values and re-encodes. */
    private val checks: Map<String, (String) -> Unit> = mapOf(
        "info.json" to { name ->
            val info = body(name, Info.serializer())
            assertEquals(VersionRange(1, 1), info.protocolVersions)
        },
        "hello.req.json" to { name ->
            val args = request<HelloArgs>(name, Ops.HELLO)
            assertEquals("c4e7a1d9-2f6b-4a83-b5e0-9d1c7f3a6b25", args.clientId)
            assertNull(args.token)
        },
        "hello.res.json" to { name ->
            val hello = okData(name, HelloData.serializer())
            val caps = hello.capabilities
            assertEquals(Size(3264, 2448), caps.sizes.full)
            assertEquals(Size(1440, 1080), caps.sizes.play)
            assertEquals(Size(256, 192), caps.sizes.thumb)
            assertEquals(listOf(0, 180), caps.rotations)
            assertEquals(ExposureLockMethod.FREEZE, caps.exposure.method)
            assertEquals(Rational(1, 2), caps.exposure.compensation.stepEv)
            assertEquals(WhiteBalanceLockMethod.FREEZE, caps.whiteBalance.method)
            assertEquals(FocusLockMethod.FREEZE, caps.focusLock.method)
            assertEquals(listOf(FocusMode.AUTO, FocusMode.LOCKED), caps.focus.modes)
            assertEquals(PreviewQuality.entries, caps.previewQualities)
            assertEquals(ControlMode.AUTO, hello.controls.exposure.mode)
            assertEquals(Thermal.NONE, hello.status.thermal)
            assertEquals(10_000L, hello.sessionTtlMs)
        },
        "hello.busy.json" to { name ->
            val e = error(name, ErrorCodes.BUSY)
            assertTrue(e.retryable)
            assertEquals(7350L, e.retryAfterMs)
        },
        "hello.unsupported.json" to { name ->
            val e = error(name, ErrorCodes.UNSUPPORTED_VERSION)
            assertFalse(e.retryable)
            assertTrue(e.data!!.containsKey("protocolVersions"))
        },
        "ping.req.json" to { name -> request<PingArgs>(name, Ops.PING) },
        "ping.res.json" to { name ->
            assertEquals(1793027045123L, okData(name, PingData.serializer()).serverTimeMs)
        },
        "capture.req.json" to { name ->
            val args = request<CaptureArgs>(name, Ops.CAPTURE)
            assertEquals(0, args.rotation)
        },
        "capture.res.json" to { name ->
            val f = okData(name, FrameInfo.serializer())
            assertEquals(42L, f.seq)
            assertEquals(2345678L, f.full.bytes)
            assertEquals(ExposureInfo(200, 16666666L), f.exposure)
        },
        "capture.err.json" to { name -> error(name, ErrorCodes.GEOMETRY_MISMATCH) },
        "getOperation.req.json" to { name ->
            val args = request<GetOperationArgs>(name, Ops.GET_OPERATION)
            assertEquals("9b3e7f1a-5d2c-4a86-8e0b-6f4c2a9d1e57", args.reqId)
        },
        "getOperation.res.done.json" to { name ->
            val s = okData(name, OperationState.serializer()) as OperationState.Done
            assertEquals(42L, s.result.seq)
            assertNull(s.result.exposure)
        },
        "getOperation.res.pending.json" to { name ->
            assertEquals(OperationState.Pending, okData(name, OperationState.serializer()))
        },
        "getOperation.res.failed.json" to { name ->
            val s = okData(name, OperationState.serializer()) as OperationState.Failed
            assertEquals(ErrorCodes.INTERRUPTED, s.error.code)
        },
        "getOperation.res.unknown.json" to { name ->
            assertEquals(OperationState.Unknown, okData(name, OperationState.serializer()))
        },
        "status.evt.json" to { name ->
            assertEquals(Thermal.LIGHT, event(name, Events.STATUS, Status.serializer()).thermal)
        },
        "controls.evt.json" to { name ->
            val c = event(name, Events.CONTROLS, Controls.serializer())
            assertEquals(ControlMode.LOCKED, c.whiteBalance.mode)
            assertEquals(180, c.rotation)
        },
        "preview.header.json" to { name ->
            val h = body(name, PreviewHeader.serializer())
            assertEquals(1793027045480L, h.ts)
            assertEquals(PreviewLocks(ControlMode.LOCKED, ControlMode.LOCKED, FocusMode.LOCKED), h.locks)
        },
        "preview.next.json" to { name -> body(name, PreviewNext.serializer()) },
    )

    @Test
    fun `every fixture has a check and every check has a fixture`() {
        assertEquals(checks.keys.sorted(), Fixtures.names())
    }

    @Test
    fun `every fixture round-trips through the models`() {
        val failures = mutableListOf<String>()
        for ((name, check) in checks) {
            try {
                check(name)
            } catch (e: Throwable) {
                failures += "$name: ${e.message ?: e}"
            }
        }
        if (failures.isNotEmpty()) fail(failures.joinToString("\n"))
    }

    @Test
    fun `fixtures still parse when unknown fields are added everywhere`() {
        for (name in checks.keys) {
            val noisy = addUnknownFields(Fixtures.json(name))
            // Envelopes and bodies alike: decode with the shared Json must ignore the extras.
            val text = noisy.toString()
            when {
                name.endsWith(".req.json") -> {
                    val req = (decodeRequest(text) as ProtocolResult.Ok).value
                    assertTrue(name, req.decodeArgs() is ProtocolResult.Ok)
                }
                name == "info.json" -> ProtocolJson.decodeFromString(Info.serializer(), text)
                name == "preview.header.json" -> ProtocolJson.decodeFromString(PreviewHeader.serializer(), text)
                name == "preview.next.json" -> ProtocolJson.decodeFromString(PreviewNext.serializer(), text)
                name.endsWith(".evt.json") -> ProtocolJson.decodeFromString(Event.serializer(), text)
                else -> {
                    val res = ProtocolJson.decodeFromString(Response.serializer(), text)
                    val data = res.data ?: continue
                    val ser: KSerializer<*> = when {
                        name.startsWith("hello") -> HelloData.serializer()
                        name.startsWith("ping") -> PingData.serializer()
                        name.startsWith("capture") -> FrameInfo.serializer()
                        else -> OperationState.serializer()
                    }
                    ProtocolJson.decodeFromJsonElement(ser, data)
                }
            }
        }
    }

    // --- helpers ---

    private fun <T> body(name: String, ser: KSerializer<T>): T {
        val expected = Fixtures.json(name)
        val value = ProtocolJson.decodeFromString(ser, Fixtures.text(name))
        assertJsonEquals(expected, ProtocolJson.encodeToJsonElement(ser, value))
        return value
    }

    private inline fun <reified A : RequestArgs> request(name: String, op: String): A {
        val req = when (val r = decodeRequest(Fixtures.text(name))) {
            is ProtocolResult.Ok -> r.value
            is ProtocolResult.Err -> throw AssertionError("decodeRequest: ${r.error}")
        }
        assertEquals(op, req.op)
        val args = when (val r = req.decodeArgs()) {
            is ProtocolResult.Ok -> r.value
            is ProtocolResult.Err -> throw AssertionError("decodeArgs: ${r.error}")
        }
        assertTrue("expected ${A::class.simpleName}, got $args", args is A)
        assertJsonEquals(Fixtures.json(name), parse(encodeRequest(req.reqId, args)))
        return args as A
    }

    private fun response(name: String): Response {
        val res = ProtocolJson.decodeFromString(Response.serializer(), Fixtures.text(name))
        assertEquals("res", res.t)
        assertEquals(PROTOCOL_VERSION, res.v)
        return res
    }

    private fun <T> okData(name: String, ser: KSerializer<T>): T {
        val res = response(name)
        assertTrue(res.ok)
        val value = ProtocolJson.decodeFromJsonElement(ser, res.data!!)
        assertJsonEquals(Fixtures.json(name), parse(encodeOk(res.reqId, ser, value)))
        return value
    }

    private fun error(name: String, code: String): ProtocolError {
        val res = response(name)
        assertFalse(res.ok)
        val e = res.error!!
        assertEquals(code, e.code)
        assertJsonEquals(Fixtures.json(name), parse(encodeError(res.reqId, e)))
        return e
    }

    private fun <T> event(name: String, evtName: String, ser: KSerializer<T>): T {
        val evt = ProtocolJson.decodeFromString(Event.serializer(), Fixtures.text(name))
        assertEquals(evtName, evt.name)
        val value = ProtocolJson.decodeFromJsonElement(ser, evt.data)
        assertJsonEquals(Fixtures.json(name), parse(encodeEvent(evtName, ser, value)))
        return value
    }

    private fun parse(text: String): JsonElement = Json.parseToJsonElement(text)
}

private fun addUnknownFields(e: JsonElement): JsonElement = when (e) {
    is kotlinx.serialization.json.JsonObject -> kotlinx.serialization.json.JsonObject(
        e.mapValues { addUnknownFields(it.value) } +
            ("zzUnknown" to kotlinx.serialization.json.JsonPrimitive("ignored")),
    )
    is kotlinx.serialization.json.JsonArray -> kotlinx.serialization.json.JsonArray(e.map(::addUnknownFields))
    else -> e
}
