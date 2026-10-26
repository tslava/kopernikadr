package pl.slava.kopernikadr.camera.protocol

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** `setControl` / `getControls` args (PROTOCOL.md §6 Controls), one control per call. */
class SetControlArgsTest {

    private val reqId = "0c7d2e4a-9b1f-4e53-a8d6-2f5b7c9e1a30"

    private fun decode(op: String, args: String): ProtocolResult<RequestArgs> {
        val req = (decodeRequest("""{"v":1,"t":"req","reqId":"$reqId","op":"$op","args":$args}""") as ProtocolResult.Ok).value
        return req.decodeArgs()
    }

    private fun ok(op: String, args: String): RequestArgs =
        (decode(op, args) as? ProtocolResult.Ok)?.value ?: throw AssertionError("expected Ok: ${decode(op, args)}")

    @Test
    fun `every setControl shape of section 6 decodes`() {
        assertEquals(SetControlArgs("exposure", mode = "locked"), ok(Ops.SET_CONTROL, """{"control":"exposure","mode":"locked"}"""))
        assertEquals(SetControlArgs("exposureCompensation", steps = -6), ok(Ops.SET_CONTROL, """{"control":"exposureCompensation","steps":-6}"""))
        assertEquals(SetControlArgs("whiteBalance", mode = "auto"), ok(Ops.SET_CONTROL, """{"control":"whiteBalance","mode":"auto"}"""))
        assertEquals(SetControlArgs("focus", mode = "locked"), ok(Ops.SET_CONTROL, """{"control":"focus","mode":"locked"}"""))
        assertEquals(SetControlArgs("rotation", degrees = 180), ok(Ops.SET_CONTROL, """{"control":"rotation","degrees":180}"""))
        assertEquals(SetControlArgs("previewQuality", value = "high"), ok(Ops.SET_CONTROL, """{"control":"previewQuality","value":"high"}"""))
    }

    @Test
    fun `unknown control names still decode, so validation can answer UNSUPPORTED_CONTROL`() {
        assertEquals(SetControlArgs("zoom", mode = "auto"), ok(Ops.SET_CONTROL, """{"control":"zoom","mode":"auto"}"""))
    }

    @Test
    fun `wrong wire types and a missing control are INVALID_ARGS`() {
        for (args in listOf("""{"control":"rotation","degrees":"180"}""", """{"mode":"auto"}""", """{"control":""}""")) {
            val r = decode(Ops.SET_CONTROL, args)
            assertTrue(args, r is ProtocolResult.Err && r.error.code == ErrorCodes.INVALID_ARGS)
        }
    }

    @Test
    fun `getControls takes empty args`() {
        assertEquals(GetControlsArgs, ok(Ops.GET_CONTROLS, "{}"))
    }

    @Test
    fun `encoding omits the absent fields`() {
        val json = SetControlArgs("rotation", degrees = 0).toJsonElement()
        assertJsonEquals(Json.parseToJsonElement("""{"control":"rotation","degrees":0}"""), json)
        val req = encodeRequest(reqId, SetControlArgs("exposure", mode = "auto"))
        assertEquals(SetControlArgs("exposure", mode = "auto"), (decodeRequest(req) as ProtocolResult.Ok).value.let {
            (it.decodeArgs() as ProtocolResult.Ok).value
        })
    }
}
