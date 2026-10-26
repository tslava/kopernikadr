package pl.slava.kopernikadr.camera.spool

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.execSQL
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Proves the bundled SQLite driver loads on the host JVM and honours the Spool pragmas. */
class SqliteSpikeTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun `bundled driver opens a file db with WAL and synchronous FULL`() {
        val file = tmp.newFile("spike.db").apply { delete() }
        BundledSQLiteDriver().open(file.absolutePath).use { conn ->
            assertEquals("wal", conn.queryText("PRAGMA journal_mode=WAL"))
            conn.execSQL("PRAGMA synchronous=FULL")
            assertEquals("wal", conn.queryText("PRAGMA journal_mode"))
            assertEquals(2L, conn.queryLong("PRAGMA synchronous")) // 2 == FULL

            conn.execSQL("CREATE TABLE frames (id TEXT PRIMARY KEY, seq INTEGER NOT NULL)")
            conn.prepare("INSERT INTO frames (id, seq) VALUES (?, ?)").use {
                it.bindText(1, "01JAAAAAAAAAAAAAAAAAAAAAAA")
                it.bindLong(2, 42)
                it.step()
            }
            conn.prepare("SELECT id, seq FROM frames").use {
                check(it.step())
                assertEquals("01JAAAAAAAAAAAAAAAAAAAAAAA", it.getText(0))
                assertEquals(42L, it.getLong(1))
            }
        }
        BundledSQLiteDriver().open(file.absolutePath).use { conn ->
            assertEquals(1L, conn.queryLong("SELECT count(*) FROM frames"))
        }
    }

    private fun SQLiteConnection.queryText(sql: String): String =
        prepare(sql).use { check(it.step()); it.getText(0) }

    private fun SQLiteConnection.queryLong(sql: String): Long =
        prepare(sql).use { check(it.step()); it.getLong(0) }
}
