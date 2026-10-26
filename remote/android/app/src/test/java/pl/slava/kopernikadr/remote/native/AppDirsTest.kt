package pl.slava.kopernikadr.remote.native

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AppDirsTest {
    @Test
    fun relativePathsLiveUnderTheRoot() {
        assertEquals(listOf("kopernikadr/tmp", "kopernikadr/exports", "kopernikadr/probe"), AppDirs.ALL.map(AppDirs::relative))
    }

    @Test
    fun unknownDirIsRejected() {
        assertThrows(IllegalArgumentException::class.java) { AppDirs.relative("../etc") }
    }
}
