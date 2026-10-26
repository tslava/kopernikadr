package pl.slava.kopernikadr.camera.protocol

import java.nio.ByteBuffer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EncodeTest {

    @Test
    fun `busy error matches the fixture`() {
        val fixture = Fixtures.json("hello.busy.json")
        val reqId = "e1b5c9a3-7f2d-4e68-9a01-3c5d7b9f2e46"
        assertJsonEquals(fixture, Json.parseToJsonElement(encodeError(reqId, ProtocolError.busy(7350))))
    }

    @Test
    fun `absent optional error fields are omitted, not null`() {
        val obj = Json.parseToJsonElement(encodeError("r", ProtocolError.invalidArgs("bad"))).jsonObject
        val error = obj.getValue("error").jsonObject
        assertEquals(setOf("code", "message", "retryable"), error.keys)
        assertFalse(obj.containsKey("data"))
    }

    @Test
    fun `retryable defaults follow the error table`() {
        val retryable = listOf(
            ErrorCodes.BUSY, ErrorCodes.CAMERA_NOT_READY, ErrorCodes.CAPTURE_IN_PROGRESS, ErrorCodes.INTERNAL,
        )
        val notRetryable = listOf(
            ErrorCodes.LEASE_LOST, ErrorCodes.UNSUPPORTED_VERSION, ErrorCodes.UNKNOWN_OP, ErrorCodes.INVALID_ARGS,
            ErrorCodes.CAPTURE_FAILED, ErrorCodes.INTERRUPTED, ErrorCodes.GEOMETRY_MISMATCH,
            ErrorCodes.STORAGE_LOW, ErrorCodes.REQ_ID_REUSED, ErrorCodes.UNSUPPORTED_CONTROL,
            ErrorCodes.INVALID_VALUE,
        )
        retryable.forEach { assertTrue(it, ProtocolError(it, "m").retryable) }
        notRetryable.forEach { assertFalse(it, ProtocolError(it, "m").retryable) }
    }

    @Test
    fun `error helpers`() {
        assertEquals(ErrorCodes.UNKNOWN_OP, ProtocolError.unknownOp("x").code)
        assertEquals(ErrorCodes.LEASE_LOST, ProtocolError.leaseLost().code)
        val u = ProtocolError.unsupportedVersion(camera = VersionRange(1, 1), client = VersionRange(2, 3))
        assertEquals(ErrorCodes.UNSUPPORTED_VERSION, u.code)
        assertNull(u.retryAfterMs)
        assertTrue(u.data!!.containsKey("protocolVersions"))
    }

    @Test
    fun `operation state keeps its discriminator when encoded through the sealed type`() {
        val text = encodeOk("r", OperationState.serializer(), OperationState.Pending)
        val data = Json.parseToJsonElement(text).jsonObject.getValue("data").jsonObject
        assertEquals("pending", data.getValue("state").toString().trim('"'))
        val inline = encodeOk<OperationState>("r", OperationState.Unknown)
        assertTrue(inline, inline.contains("\"state\":\"unknown\""))
    }

    @Test
    fun `event envelope`() {
        val status = Status(50, false, 1, 2, 0, 0, 0, Thermal.MODERATE)
        val obj = Json.parseToJsonElement(encodeEvent(Events.STATUS, status)).jsonObject
        assertEquals(setOf("v", "t", "name", "data"), obj.keys)
        assertTrue(obj.toString().contains("\"thermal\":\"moderate\""))
    }

    @Test
    fun `close codes`() {
        assertEquals(listOf<Short>(4000, 4001, 4002, 4003), CloseCode.entries.map { it.code })
        assertEquals("busy", CloseCode.BUSY.reason)
        assertEquals("replaced", CloseCode.REPLACED.reason)
        assertEquals("lease lost", CloseCode.LEASE_LOST.reason)
        assertEquals("protocol error", CloseCode.PROTOCOL_ERROR.reason)
    }

    @Test
    fun `version negotiation picks the highest common version`() {
        assertEquals(1, VersionRange(1, 1).highestCommon(VersionRange(1, 3)))
        assertEquals(3, VersionRange(1, 4).highestCommon(VersionRange(2, 3)))
        assertNull(VersionRange(1, 1).highestCommon(VersionRange(2, 3)))
        assertEquals(VersionRange(1, 1), SUPPORTED_VERSIONS)
    }

    @Test
    fun `preview frame binary layout`() {
        val header = ProtocolJson.decodeFromString(PreviewHeader.serializer(), Fixtures.text("preview.header.json"))
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 0xFF.toByte(), 0xD9.toByte())
        val frame = encodePreviewFrame(header, jpeg)
        val len = ByteBuffer.wrap(frame, 0, 4).int // big-endian by default
        val headerJson = String(frame, 4, len, Charsets.UTF_8)
        assertEquals(header, ProtocolJson.decodeFromString(PreviewHeader.serializer(), headerJson))
        assertArrayEquals(jpeg, frame.copyOfRange(4 + len, frame.size))
        assertEquals(4 + len + jpeg.size, frame.size)
    }
}
