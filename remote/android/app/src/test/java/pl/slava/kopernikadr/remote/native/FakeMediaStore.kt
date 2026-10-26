package pl.slava.kopernikadr.remote.native

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream

/** An in-memory [MediaStoreGateway] that records every call and can fail at any step. */
class FakeMediaStore : MediaStoreGateway {
    class Row(val values: MutableMap<String, Any>, val content: ByteArrayOutputStream = ByteArrayOutputStream())

    val log = mutableListOf<String>()
    val rows = linkedMapOf<String, Row>()
    var lastQueryArgs: Map<String, Any>? = null
    val inserted = mutableListOf<Map<String, Any>>()

    var insertReturnsNull = false
    var failInsert: RuntimeException? = null
    var outputIsNull = false
    var failWriteAfterBytes: Int? = null
    var failWrite: IOException = IOException("write failed")
    var failClose: IOException? = null
    var failUpdate: RuntimeException? = null
    var updateCount: Int? = null
    var failDelete: RuntimeException? = null

    /** URIs [query] returns; defaults to the pending rows. */
    var queryResult: List<String>? = null

    private var nextId = 1

    override fun insert(values: Map<String, Any>): String? {
        log += "insert"
        inserted += values.toMap()
        failInsert?.let { throw it }
        if (insertReturnsNull) return null
        val uri = "content://media/external_primary/video/media/${nextId++}"
        rows[uri] = Row(values.toMutableMap())
        return uri
    }

    override fun openOutput(uri: String): OutputStream? {
        log += "openOutput"
        if (outputIsNull) return null
        val row = rows.getValue(uri)
        return object : OutputStream() {
            var written = 0

            override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

            override fun write(b: ByteArray, off: Int, len: Int) {
                failWriteAfterBytes?.let { if (written + len > it) throw failWrite }
                row.content.write(b, off, len)
                written += len
            }

            override fun flush() {
                log += "flush"
            }

            override fun close() {
                log += "close"
                failClose?.let { throw it }
            }
        }
    }

    override fun update(uri: String, values: Map<String, Any>): Int {
        log += "update:$values"
        failUpdate?.let { throw it }
        updateCount?.let { return it }
        val row = rows[uri] ?: return 0
        row.values.putAll(values)
        return 1
    }

    override fun delete(uri: String): Int {
        log += "delete"
        failDelete?.let { throw it }
        return if (rows.remove(uri) != null) 1 else 0
    }

    override fun query(queryArgs: Map<String, Any>): List<String> {
        log += "query"
        lastQueryArgs = queryArgs
        return queryResult ?: rows.filterValues { it.values[GalleryPublisher.IS_PENDING] == 1 }.keys.toList()
    }
}
