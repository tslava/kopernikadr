package pl.slava.kopernikadr.camera.server

import io.ktor.client.request.get
import io.ktor.client.request.head
import io.ktor.server.testing.testApplication
import io.ktor.client.statement.bodyAsBytes
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import pl.slava.kopernikadr.camera.protocol.ProtocolJson

class HttpRoutesTest {

    @Test
    fun `HEAD on frames and info answers without a body`() {
        val cam = FakeCamera()
        val f = cam.frames.add("client", "project", 0, fakeJpeg(1000))
        cameraTest(cam) {
            val r = client.head("/frames/${f.frameId}/full.jpg")
            assertEquals(HttpStatusCode.OK, r.status)
            assertEquals("1000", r.headers[HttpHeaders.ContentLength])
            assertEquals(ContentType.Image.JPEG, r.contentType())
            assertEquals(0, r.bodyAsBytes().size)
            assertEquals(HttpStatusCode.OK, client.head("/info").status)
            assertEquals(HttpStatusCode.NotFound, client.head("/frames/${f.frameId}/huge.jpg").status)
        }
    }

    @Test
    fun `a display cache that cannot be generated is 503 with Retry-After`() {
        val cam = FakeCamera()
        val failing = object : FrameStore by cam.frames {
            override fun open(frameId: String, variant: FrameVariant): FrameFile? = throw FrameUnavailableException("injected")
        }
        val ports = CameraPorts(cam.identity, cam.status, cam.controls, cam.capture, failing, cam.preview)
        testApplication {
            application { cameraModule(ports, ServerConfig(staticRoot = TEST_STATIC_ROOT)) }
            val r = client.get("/frames/01K8GZ4V7Q3M9X2B5N6R8T1WCD/play.jpg")
            assertEquals(HttpStatusCode.ServiceUnavailable, r.status)
            assertEquals("1", r.headers[HttpHeaders.RetryAfter])
        }
    }

    @Test
    fun `info returns identity and versions`() {
        val cam = FakeCamera()
        cameraTest(cam) {
            val r = client.get("/info")
            assertEquals(HttpStatusCode.OK, r.status)
            assertTrue(r.contentType()!!.match(ContentType.Application.Json))
            val body = ProtocolJson.parseToJsonElement(r.bodyAsText())
            assertEquals(cam.identity.cameraId, body.str("cameraId"))
            assertEquals(cam.identity.bootId, body.str("bootId"))
            assertEquals(cam.identity.name, body.str("name"))
            assertEquals(1L, body.obj.getValue("protocolVersions").long("min"))
            assertEquals(1L, body.obj.getValue("protocolVersions").long("max"))
        }
    }

    @Test
    fun `root serves remote-lite index html`() = cameraTest {
        val r = client.get("/")
        assertEquals(HttpStatusCode.OK, r.status)
        assertTrue(r.contentType()!!.match(ContentType.Text.Html))
        assertTrue(r.bodyAsText().contains("REMOTE_LITE_TEST"))
    }

    @Test
    fun `static assets get content types and unknown paths 404`() = cameraTest {
        val js = client.get("/js/app.js")
        assertEquals(HttpStatusCode.OK, js.status)
        assertEquals("text/javascript", js.contentType()!!.withoutParameters().toString())
        assertEquals("text/css", client.get("/style.css").contentType()!!.withoutParameters().toString())
        assertEquals(HttpStatusCode.OK, client.get("/index.html").status)
        assertEquals(HttpStatusCode.NotFound, client.get("/nope.js").status)
        assertEquals(HttpStatusCode.NotFound, client.get("/js/../../remote-lite-test/index.html").status)
        assertEquals(HttpStatusCode.NotFound, client.get("/%2e%2e/remote-lite-test/index.html").status)
        assertEquals(HttpStatusCode.NotFound, client.get("/js").status) // a directory
    }

    @Test
    fun `frames serve variants with content length and 404 rules`() {
        val cam = FakeCamera()
        val f = cam.frames.add("client", "project", 0, fakeJpeg(1000))
        cameraTest(cam) {
            val full = client.get("/frames/${f.frameId}/full.jpg")
            assertEquals(HttpStatusCode.OK, full.status)
            assertEquals(ContentType.Image.JPEG, full.contentType())
            assertEquals("1000", full.headers[HttpHeaders.ContentLength])
            assertArrayEquals(fakeJpeg(1000), full.bodyAsBytes())

            val thumb = client.get("/frames/${f.frameId}/thumb.jpg")
            assertEquals(HttpStatusCode.OK, thumb.status)
            assertEquals("250", thumb.headers[HttpHeaders.ContentLength])
            assertEquals(HttpStatusCode.OK, client.get("/frames/${f.frameId}/play.jpg").status)

            assertEquals(HttpStatusCode.NotFound, client.get("/frames/${f.frameId}/huge.jpg").status)
            assertEquals(HttpStatusCode.NotFound, client.get("/frames/${f.frameId}/full.png").status)
            assertEquals(HttpStatusCode.NotFound, client.get("/frames/01K8GZ4V7Q3M9X2B5N6R8T1WCD/full.jpg").status)

            cam.frames.reclaim(f.frameId)
            assertEquals(HttpStatusCode.NotFound, client.get("/frames/${f.frameId}/full.jpg").status)
            assertEquals(HttpStatusCode.NotFound, client.get("/frames/${f.frameId}/play.jpg").status)
        }
    }
}
