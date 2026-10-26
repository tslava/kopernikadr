package pl.slava.kopernikadr.camera.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DecodeRequestTest {

    private val reqId = "9b3e7f1a-5d2c-4a86-8e0b-6f4c2a9d1e57"

    private fun req(op: String, args: String?): String =
        """{"v":1,"t":"req","reqId":"$reqId","op":"$op"${if (args != null) ""","args":$args""" else ""}}"""

    private fun ok(text: String): Request = when (val r = decodeRequest(text)) {
        is ProtocolResult.Ok -> r.value
        is ProtocolResult.Err -> throw AssertionError("expected Ok, got ${r.error}")
    }

    private fun envelopeError(text: String): ProtocolResult.Err = when (val r = decodeRequest(text)) {
        is ProtocolResult.Ok -> throw AssertionError("expected Err, got ${r.value}")
        is ProtocolResult.Err -> r
    }

    private fun argsError(text: String): ProtocolResult.Err = when (val r = ok(text).decodeArgs()) {
        is ProtocolResult.Ok -> throw AssertionError("expected Err, got ${r.value}")
        is ProtocolResult.Err -> r
    }

    private fun args(text: String): RequestArgs = when (val r = ok(text).decodeArgs()) {
        is ProtocolResult.Ok -> r.value
        is ProtocolResult.Err -> throw AssertionError("expected Ok, got ${r.error}")
    }

    @Test
    fun `decodeRequest exposes op and reqId before args are parsed`() {
        val r = ok(req("capture", """{"projectId":"p","rotation":0}"""))
        assertEquals("capture", r.op)
        assertEquals(reqId, r.reqId)
        assertEquals(1, r.v)
        // The server checks the first message against Ops.HELLO itself.
        assertFalse(r.op == Ops.HELLO)
    }

    @Test
    fun `unknown op is UNKNOWN_OP, with the reqId kept`() {
        val r = ok(req("teleport", """{"x":1}"""))
        assertEquals("teleport", r.op)
        val err = argsError(req("teleport", """{"x":1}"""))
        assertEquals(ErrorCodes.UNKNOWN_OP, err.error.code)
        assertFalse(err.error.retryable)
        assertEquals(reqId, err.reqId)
    }

    @Test
    fun `unknown fields in envelope and args are ignored`() {
        val text = """{"v":1,"t":"req","reqId":"$reqId","op":"capture","extra":{"a":1},
            |"args":{"projectId":"p","rotation":180,"future":true}}""".trimMargin()
        assertEquals(CaptureArgs("p", 180), args(text))
    }

    @Test
    fun `ping accepts empty, missing or extended args`() {
        assertEquals(PingArgs, args(req("ping", "{}")))
        assertEquals(PingArgs, args(req("ping", null)))
        assertEquals(PingArgs, args(req("ping", """{"whatever":1}""")))
    }

    @Test
    fun `hello token is optional and accepted`() {
        val a = args(req("hello", """{"clientId":"c","protocolVersions":{"min":1,"max":2},
            |"appVersion":"1","platform":"node","token":"t"}""".trimMargin())) as HelloArgs
        assertEquals("t", a.token)
        assertEquals(VersionRange(1, 2), a.protocolVersions)
    }

    @Test
    fun `malformed args are INVALID_ARGS`() {
        val bad = listOf(
            "capture" to """{"projectId":"p","rotation":"0"}""", // wrong type
            "capture" to """{"projectId":"p","rotation":0.5}""", // not an int
            "capture" to """{"rotation":0}""", // missing field
            "capture" to """{"projectId":null,"rotation":0}""", // null for required
            "capture" to """{"projectId":"","rotation":0}""", // blank id
            "capture" to """[1,2]""", // not an object
            "capture" to "null",
            "capture" to null, // args missing
            "hello" to """{"protocolVersions":{"min":1,"max":1},"appVersion":"1","platform":"x"}""",
            "hello" to """{"clientId":"c","protocolVersions":{"min":2,"max":1},"appVersion":"1","platform":"x"}""",
            "hello" to """{"clientId":"c","protocolVersions":"1-1","appVersion":"1","platform":"x"}""",
            "getOperation" to """{}""",
            "getOperation" to """{"reqId":5}""",
            "ping" to """[]""",
        )
        for ((op, a) in bad) {
            val err = argsError(req(op, a))
            assertEquals("$op $a", ErrorCodes.INVALID_ARGS, err.error.code)
            assertEquals(reqId, err.reqId)
        }
    }

    @Test
    fun `unparseable text is INVALID_ARGS without reqId`() {
        val err = envelopeError("{not json")
        assertEquals(ErrorCodes.INVALID_ARGS, err.error.code)
        assertNull(err.reqId)
        assertEquals(ErrorCodes.INVALID_ARGS, envelopeError("[1]").error.code)
        assertEquals(ErrorCodes.INVALID_ARGS, envelopeError("\"hello\"").error.code)
    }

    @Test
    fun `broken envelope is INVALID_ARGS and keeps reqId when it is readable`() {
        val missingOp = envelopeError("""{"v":1,"t":"req","reqId":"$reqId"}""")
        assertEquals(ErrorCodes.INVALID_ARGS, missingOp.error.code)
        assertEquals(reqId, missingOp.reqId)

        val notReq = envelopeError("""{"v":1,"t":"res","reqId":"$reqId","op":"ping","args":{}}""")
        assertEquals(ErrorCodes.INVALID_ARGS, notReq.error.code)
        assertEquals(reqId, notReq.reqId)

        val noReqId = envelopeError("""{"v":1,"t":"req","op":"ping","args":{}}""")
        assertNull(noReqId.reqId)

        val blankReqId = envelopeError("""{"v":1,"t":"req","reqId":"","op":"ping","args":{}}""")
        assertEquals(ErrorCodes.INVALID_ARGS, blankReqId.error.code)

        val noV = envelopeError("""{"t":"req","reqId":"$reqId","op":"ping","args":{}}""")
        assertEquals(ErrorCodes.INVALID_ARGS, noV.error.code)
    }

    @Test
    fun `envelope fields are type-checked strictly`() {
        val quotedV = envelopeError("""{"v":"1","t":"req","reqId":"$reqId","op":"ping","args":{}}""")
        assertEquals(ErrorCodes.INVALID_ARGS, quotedV.error.code)
        assertEquals(reqId, quotedV.reqId)
        assertEquals(ErrorCodes.INVALID_ARGS, envelopeError("""{"v":1,"t":"req","reqId":7,"op":"ping"}""").error.code)
        assertEquals(ErrorCodes.INVALID_ARGS, envelopeError("""{"v":1,"t":"req","reqId":"$reqId","op":true}""").error.code)
    }

    @Test
    fun `hello expected error and protocol-error close code`() {
        val e = ProtocolError.helloExpected()
        assertEquals(ErrorCodes.INVALID_ARGS, e.code)
        assertEquals("hello expected", e.message)
        assertFalse(e.retryable)
        assertEquals(4000.toShort(), CloseCode.PROTOCOL_ERROR.code)
    }

    @Test
    fun `typed args encode back with their op`() {
        val text = encodeRequest(reqId, CaptureArgs("p", 180))
        val r = ok(text)
        assertEquals(Ops.CAPTURE, r.op)
        assertEquals(CaptureArgs("p", 180), args(text))
        assertTrue(text.contains("\"t\":\"req\""))
    }
}
