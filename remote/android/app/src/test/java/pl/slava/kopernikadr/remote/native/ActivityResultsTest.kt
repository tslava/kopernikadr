package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import pl.slava.kopernikadr.remote.native.ActivityResults.Outcome

class ActivityResultsTest {
    private fun outcome(call: Boolean = true, code: Int = ActivityResults.RESULT_OK, payload: Boolean = true) =
        ActivityResults.outcome(call, code, payload)

    @Test
    fun okWithPayloadIsOk() = assertEquals(Outcome.OK, outcome())

    @Test
    fun cancelIsCancelled() {
        assertEquals(Outcome.CANCELLED, outcome(code = ActivityResults.RESULT_CANCELED, payload = false))
        assertEquals(Outcome.CANCELLED, outcome(code = ActivityResults.RESULT_CANCELED))
    }

    @Test
    fun okWithNothingInItIsCancelled() = assertEquals(Outcome.CANCELLED, outcome(payload = false))

    @Test
    fun foreignResultCodeIsCancelled() = assertEquals(Outcome.CANCELLED, outcome(code = 7))

    @Test
    fun nullCallIsIgnoredWhateverTheResult() {
        assertEquals(Outcome.IGNORE, outcome(call = false))
        assertEquals(Outcome.IGNORE, outcome(call = false, code = ActivityResults.RESULT_CANCELED, payload = false))
    }

    @Test
    fun errorsMapToCodes() {
        assertEquals(NativeErrorCode.CANCELLED, ActivityResults.errorOf(Outcome.CANCELLED))
        assertEquals(NativeErrorCode.NO_APP, ActivityResults.errorOf(Outcome.NO_APP))
        assertNull(ActivityResults.errorOf(Outcome.OK))
        assertNull(ActivityResults.errorOf(Outcome.IGNORE))
    }
}
