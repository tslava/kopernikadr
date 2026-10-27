package pl.slava.kopernikadr.camera.screen

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenPolicyTest {
    private var now = 1_000L
    private val policy = ScreenPolicy({ now })

    private fun advance(ms: Long) {
        now += ms
    }

    @Test
    fun `bright until 2 min idle then dim`() {
        assertFalse(policy.shouldDim())
        advance(ScreenPolicy.DEFAULT_IDLE_MS - 1)
        assertFalse(policy.shouldDim())
        advance(1)
        assertTrue(policy.shouldDim())
    }

    @Test
    fun `activity brightens and restarts the timer`() {
        advance(ScreenPolicy.DEFAULT_IDLE_MS)
        assertTrue(policy.shouldDim())
        policy.onActivity()
        assertFalse(policy.shouldDim())
        advance(ScreenPolicy.DEFAULT_IDLE_MS - 1)
        assertFalse(policy.shouldDim())
        advance(1)
        assertTrue(policy.shouldDim())
    }

    @Test
    fun `activity before the deadline pushes it out`() {
        advance(ScreenPolicy.DEFAULT_IDLE_MS - 10)
        policy.onActivity()
        advance(20)
        assertFalse(policy.shouldDim())
    }

    @Test
    fun `without activity events the preview stream alone does not count`() {
        // the preview stream reports nothing to the policy: the idle time just runs out
        repeat(10) { advance(ScreenPolicy.DEFAULT_IDLE_MS / 10) }
        assertTrue(policy.shouldDim())
    }

    @Test
    fun `pause and resume resets to bright`() {
        advance(ScreenPolicy.DEFAULT_IDLE_MS * 2)
        assertTrue(policy.shouldDim())
        policy.onResume()
        assertFalse(policy.shouldDim())
        advance(ScreenPolicy.DEFAULT_IDLE_MS)
        assertTrue(policy.shouldDim())
    }

    @Test
    fun `no dim while the waiting card is shown`() {
        policy.setQrShown(true)
        advance(ScreenPolicy.DEFAULT_IDLE_MS * 10)
        assertFalse(policy.shouldDim())
    }

    @Test
    fun `idle time starts when the waiting card goes away`() {
        policy.setQrShown(true)
        advance(ScreenPolicy.DEFAULT_IDLE_MS * 10)
        policy.setQrShown(false)
        assertFalse(policy.shouldDim())
        advance(ScreenPolicy.DEFAULT_IDLE_MS)
        assertTrue(policy.shouldDim())
    }

    @Test
    fun `waiting card appearing while dim brightens`() {
        advance(ScreenPolicy.DEFAULT_IDLE_MS)
        assertTrue(policy.shouldDim())
        policy.setQrShown(true)
        assertFalse(policy.shouldDim())
    }

    @Test
    fun `repeating the same card state is not activity`() {
        advance(ScreenPolicy.DEFAULT_IDLE_MS - 1)
        policy.setQrShown(false)
        advance(1)
        assertTrue(policy.shouldDim())
    }

    @Test
    fun `custom idle`() {
        val p = ScreenPolicy({ now }, idleMs = 5_000)
        advance(5_000)
        assertTrue(p.shouldDim())
    }
}
