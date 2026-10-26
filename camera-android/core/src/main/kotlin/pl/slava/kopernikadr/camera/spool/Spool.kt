package pl.slava.kopernikadr.camera.spool

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteDriver
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.execSQL
import java.io.Closeable
import java.io.File
import kotlinx.serialization.json.Json
import pl.slava.kopernikadr.camera.core.Ulid
import pl.slava.kopernikadr.camera.core.UlidGenerator
import pl.slava.kopernikadr.camera.image.StillPipeline
import pl.slava.kopernikadr.camera.protocol.DerivedImages
import pl.slava.kopernikadr.camera.protocol.ExposureInfo
import pl.slava.kopernikadr.camera.protocol.FrameInfo
import pl.slava.kopernikadr.camera.protocol.FullImage
import pl.slava.kopernikadr.camera.protocol.OperationError
import pl.slava.kopernikadr.camera.protocol.OperationState
import pl.slava.kopernikadr.camera.server.AckResult
import pl.slava.kopernikadr.camera.server.FramePage
import pl.slava.kopernikadr.camera.server.FrameVariant
import pl.slava.kopernikadr.camera.protocol.Size as WireSize

/** What [Spool.lookup] found for `(clientId, reqId)`. */
sealed interface SpoolLookup {
    data object None : SpoolLookup
    data class Committed(val info: FrameInfo) : SpoolLookup
    data class Pending(val frameId: String) : SpoolLookup
    data class Failed(val code: String, val message: String) : SpoolLookup

    /** Known reqId, different args hash → `REQ_ID_REUSED`. */
    data object Reused : SpoolLookup
}

/** The reserved row of an admitted capture. */
data class PendingFrame(val frameId: String, val seq: Long)

/** [Spool.stats]: committed, not reclaimed frames. */
data class SpoolStats(val unackedCount: Int, val fullBytes: Long)

/** What [Spool.commit] stores about the durable `full` file. */
data class CommitMeta(
    val w: Int,
    val h: Int,
    val bytes: Long,
    val sha256: String,
    /** ISO-8601 UTC with milliseconds. */
    val capturedAt: String,
    val exposure: ExposureInfo? = null,
)

/**
 * The capture spool 0a (ARCHITECTURE §4.5, plan "Spool 0a"): one SQLite table of operations /
 * frames in `dir/spool.db` (WAL, synchronous=FULL) and the JPEGs next to it as
 * `{frameId}.{full|play|thumb}.jpg`. Rows are kept forever. No recovery in 0a: a `pending` row
 * left by a crash stays `pending`.
 *
 * One connection guarded by a lock; every call blocks (call it off the main thread).
 */
class Spool private constructor(
    val dir: File,
    private val conn: SQLiteConnection,
    private val clock: () -> Long,
    private val ids: UlidGenerator,
) : Closeable {
    private val lock = Any()

    fun file(frameId: String, variant: FrameVariant): File {
        require(Ulid.isValid(frameId)) { "not a frameId: '$frameId'" }
        return File(dir, "$frameId.${variant.wire}.jpg")
    }

    fun lookup(clientId: String, reqId: String, argsHash: String): SpoolLookup = synchronized(lock) {
        conn.prepare("SELECT $COLS FROM frames WHERE clientId = ? AND reqId = ?").use { st ->
            st.bindText(1, clientId)
            st.bindText(2, reqId)
            if (!st.step()) return SpoolLookup.None
            val row = Row.read(st)
            when {
                row.argsHash != argsHash -> SpoolLookup.Reused
                row.state == STATE_COMMITTED -> SpoolLookup.Committed(row.toFrameInfo())
                row.state == STATE_PENDING -> SpoolLookup.Pending(row.frameId)
                else -> SpoolLookup.Failed(row.failCode ?: "INTERNAL", row.errorMessage ?: row.state)
            }
        }
    }

    /**
     * Reserves a frameId (ULID) and the next `seq` (max + 1, so strictly increasing across
     * reopen) for an admitted capture. @throws androidx.sqlite.SQLiteException on a duplicate
     * `(clientId, reqId)`.
     */
    fun insertPending(clientId: String, reqId: String, argsHash: String, projectId: String, rotation: Int): PendingFrame =
        synchronized(lock) {
            val frameId = ids.next()
            conn.prepare(
                "INSERT INTO frames (frameId, seq, clientId, reqId, argsHash, projectId, rotation, state, createdAt) " +
                    "VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM frames), ?, ?, ?, ?, ?, '$STATE_PENDING', ?)",
            ).use { st ->
                st.bindText(1, frameId)
                st.bindText(2, clientId)
                st.bindText(3, reqId)
                st.bindText(4, argsHash)
                st.bindText(5, projectId)
                st.bindLong(6, rotation.toLong())
                st.bindLong(7, clock())
                st.step()
            }
            val seq = conn.prepare("SELECT seq FROM frames WHERE frameId = ?").use { st ->
                st.bindText(1, frameId)
                check(st.step())
                st.getLong(0)
            }
            PendingFrame(frameId, seq)
        }

    /** `pending` → `committed`; returns the stored [FrameInfo]. */
    fun commit(frameId: String, meta: CommitMeta): FrameInfo = synchronized(lock) {
        conn.prepare(
            "UPDATE frames SET state = '$STATE_COMMITTED', committedAt = ?, capturedAt = ?, w = ?, h = ?, bytes = ?, " +
                "sha256 = ?, exposureJson = ? WHERE frameId = ? AND state = '$STATE_PENDING'",
        ).use { st ->
            st.bindLong(1, clock())
            st.bindText(2, meta.capturedAt)
            st.bindLong(3, meta.w.toLong())
            st.bindLong(4, meta.h.toLong())
            st.bindLong(5, meta.bytes)
            st.bindText(6, meta.sha256)
            val exp = meta.exposure
            if (exp == null) st.bindNull(7) else st.bindText(7, JSON.encodeToString(ExposureInfo.serializer(), exp))
            st.bindText(8, frameId)
            st.step()
        }
        check(changes() == 1L) { "frame $frameId is not pending" }
        requireNotNull(row(frameId)).toFrameInfo()
    }

    /** `pending` → `failed(code)`; no-op for a row in another state. */
    fun fail(frameId: String, code: String, message: String): Unit = synchronized(lock) {
        conn.prepare(
            "UPDATE frames SET state = '$STATE_FAILED', failCode = ?, errorMessage = ? WHERE frameId = ? AND state = '$STATE_PENDING'",
        ).use { st ->
            st.bindText(1, code)
            st.bindText(2, message)
            st.bindText(3, frameId)
            st.step()
        }
    }

    fun getOperation(clientId: String, reqId: String): OperationState = synchronized(lock) {
        conn.prepare("SELECT $COLS FROM frames WHERE clientId = ? AND reqId = ?").use { st ->
            st.bindText(1, clientId)
            st.bindText(2, reqId)
            if (!st.step()) return OperationState.Unknown
            val row = Row.read(st)
            when (row.state) {
                STATE_COMMITTED -> OperationState.Done(row.toFrameInfo())
                STATE_PENDING -> OperationState.Pending
                else -> OperationState.Failed(OperationError(row.failCode ?: "INTERNAL", row.errorMessage ?: row.state))
            }
        }
    }

    /** The committed frame [frameId] (any client), or null. */
    fun frame(frameId: String): FrameInfo? = synchronized(lock) {
        row(frameId)?.takeIf { it.state == STATE_COMMITTED }?.toFrameInfo()
    }

    fun listUnacked(clientId: String, afterSeq: Long?, limit: Int): FramePage = synchronized(lock) {
        val n = limit.coerceAtLeast(1)
        conn.prepare(
            "SELECT $COLS FROM frames WHERE clientId = ? AND state = '$STATE_COMMITTED' AND ackedAt IS NULL " +
                "AND reclaimedAt IS NULL AND seq > ? ORDER BY seq LIMIT ?",
        ).use { st ->
            st.bindText(1, clientId)
            st.bindLong(2, afterSeq ?: Long.MIN_VALUE)
            st.bindLong(3, n + 1L)
            val rows = ArrayList<FrameInfo>()
            while (st.step()) rows += Row.read(st).toFrameInfo()
            FramePage(rows.take(n), rows.size > n)
        }
    }

    /** Idempotent: an already acked frame counts as acked. Other clients' or non-committed ids → unknown. */
    fun ack(clientId: String, frameIds: List<String>): AckResult = synchronized(lock) {
        var acked = 0
        val unknown = ArrayList<String>()
        val now = clock()
        for (id in frameIds.distinct()) {
            conn.prepare(
                "UPDATE frames SET ackedAt = COALESCE(ackedAt, ?) WHERE frameId = ? AND clientId = ? AND state = '$STATE_COMMITTED'",
            ).use { st ->
                st.bindLong(1, now)
                st.bindText(2, id)
                st.bindText(3, clientId)
                st.step()
            }
            if (changes() == 1L) acked++ else unknown += id
        }
        AckResult(acked, unknown)
    }

    /** Committed, not reclaimed frames of every client: unacked count and the bytes of their `full` files. */
    fun stats(): SpoolStats = synchronized(lock) {
        conn.prepare(
            "SELECT COALESCE(SUM(CASE WHEN ackedAt IS NULL THEN 1 ELSE 0 END), 0), COALESCE(SUM(bytes), 0) " +
                "FROM frames WHERE state = '$STATE_COMMITTED' AND reclaimedAt IS NULL",
        ).use { st ->
            st.step()
            SpoolStats(unackedCount = st.getLong(0).toInt(), fullBytes = st.getLong(1))
        }
    }

    override fun close() = synchronized(lock) { conn.close() }

    private fun row(frameId: String): Row? =
        conn.prepare("SELECT $COLS FROM frames WHERE frameId = ?").use { st ->
            st.bindText(1, frameId)
            if (st.step()) Row.read(st) else null
        }

    private fun changes(): Long = conn.prepare("SELECT changes()").use { it.step(); it.getLong(0) }

    private class Row(
        val frameId: String,
        val seq: Long,
        val clientId: String,
        val argsHash: String,
        val projectId: String,
        val rotation: Int,
        val state: String,
        val failCode: String?,
        val errorMessage: String?,
        val capturedAt: String?,
        val w: Long?,
        val h: Long?,
        val bytes: Long?,
        val sha256: String?,
        val exposureJson: String?,
    ) {
        fun toFrameInfo() = FrameInfo(
            frameId = frameId,
            seq = seq,
            projectId = projectId,
            clientId = clientId,
            rotation = rotation,
            capturedAt = capturedAt ?: "",
            full = FullImage(w?.toInt() ?: 0, h?.toInt() ?: 0, bytes ?: 0, sha256 ?: ""),
            derived = DERIVED,
            exposure = exposureJson?.let { JSON.decodeFromString(ExposureInfo.serializer(), it) },
        )

        companion object {
            fun read(st: SQLiteStatement) = Row(
                frameId = st.getText(0),
                seq = st.getLong(1),
                clientId = st.getText(2),
                argsHash = st.getText(3),
                projectId = st.getText(4),
                rotation = st.getLong(5).toInt(),
                state = st.getText(6),
                failCode = st.textOrNull(7),
                errorMessage = st.textOrNull(8),
                capturedAt = st.textOrNull(9),
                w = st.longOrNull(10),
                h = st.longOrNull(11),
                bytes = st.longOrNull(12),
                sha256 = st.textOrNull(13),
                exposureJson = st.textOrNull(14),
            )

            private fun SQLiteStatement.textOrNull(i: Int) = if (isNull(i)) null else getText(i)
            private fun SQLiteStatement.longOrNull(i: Int) = if (isNull(i)) null else getLong(i)
        }
    }

    companion object {
        const val DB_NAME = "spool.db"
        const val STATE_PENDING = "pending"
        const val STATE_COMMITTED = "committed"
        const val STATE_FAILED = "failed"
        const val STATE_LOST = "lost"

        private const val COLS =
            "frameId, seq, clientId, argsHash, projectId, rotation, state, failCode, errorMessage, capturedAt, " +
                "w, h, bytes, sha256, exposureJson"

        private val JSON = Json { ignoreUnknownKeys = true }

        val DERIVED = DerivedImages(
            WireSize(StillPipeline.PLAY.width, StillPipeline.PLAY.height),
            WireSize(StillPipeline.THUMB.width, StillPipeline.THUMB.height),
        )

        /** Opens (creating if needed) the spool in [dir]. */
        fun open(
            dir: File,
            driver: SQLiteDriver = BundledSQLiteDriver(),
            clock: () -> Long = System::currentTimeMillis,
            ids: UlidGenerator = UlidGenerator(),
        ): Spool {
            check(dir.isDirectory || dir.mkdirs()) { "cannot create spool dir $dir" }
            val conn = driver.open(File(dir, DB_NAME).absolutePath)
            try {
                conn.prepare("PRAGMA journal_mode=WAL").use { it.step() }
                conn.execSQL("PRAGMA synchronous=FULL")
                conn.execSQL(SCHEMA)
                conn.execSQL("CREATE INDEX IF NOT EXISTS frames_unacked ON frames (clientId, state, ackedAt, seq)")
            } catch (e: Throwable) {
                conn.close()
                throw e
            }
            return Spool(dir, conn, clock, ids)
        }

        private const val SCHEMA = """
            CREATE TABLE IF NOT EXISTS frames (
                frameId TEXT PRIMARY KEY NOT NULL,
                seq INTEGER NOT NULL UNIQUE,
                clientId TEXT NOT NULL,
                reqId TEXT NOT NULL,
                argsHash TEXT NOT NULL,
                projectId TEXT NOT NULL,
                rotation INTEGER NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'failed', 'lost')),
                failCode TEXT,
                errorMessage TEXT,
                createdAt INTEGER NOT NULL,
                committedAt INTEGER,
                capturedAt TEXT,
                w INTEGER,
                h INTEGER,
                bytes INTEGER,
                sha256 TEXT,
                exposureJson TEXT,
                ackedAt INTEGER,
                reclaimedAt INTEGER,
                UNIQUE (clientId, reqId)
            )"""
    }
}
