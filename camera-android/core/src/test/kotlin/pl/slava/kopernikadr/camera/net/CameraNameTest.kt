package pl.slava.kopernikadr.camera.net

import org.junit.Assert.assertEquals
import org.junit.Test

class CameraNameTest {
    @Test
    fun `the phone model, trimmed and capped, or the default`() {
        assertEquals("moto g05", cameraName("moto g05"))
        assertEquals("Pixel 8", cameraName("  Pixel   8 "))
        assertEquals(DEFAULT_CAMERA_NAME, cameraName(null))
        assertEquals(DEFAULT_CAMERA_NAME, cameraName("   "))
        assertEquals(MAX_CAMERA_NAME_CHARS, cameraName("x".repeat(100)).length)
    }
}
