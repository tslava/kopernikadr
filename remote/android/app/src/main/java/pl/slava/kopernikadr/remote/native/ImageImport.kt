package pl.slava.kopernikadr.remote.native

import java.io.File
import java.io.InputStream
import java.util.UUID

/**
 * Copies a picked image into `tmp/pick-<uuid>.<ext>` (ARCHITECTURE §5.4), counting bytes against
 * [maxBytes] while copying, and checks that it is a jpeg / png / webp / heic / heif. The mime comes
 * from the content provider; when it is missing or generic the file header decides.
 */
class ImageImport(
    private val guard: PathGuard,
    private val ids: () -> String = { UUID.randomUUID().toString() },
    private val maxBytes: Long = MAX_BYTES,
) {
    class Imported(val path: String, val mime: String)

    /** Stream from a picker (a `content://` uri). Never leaves a partial file behind. */
    fun importStream(declaredMime: String?, input: InputStream): Imported {
        val header = ByteArray(HEADER)
        val n = io("read picked image") { readUpTo(input, header) }
        val mime = resolveMime(declaredMime, header.copyOf(n))
            ?: raise(NativeErrorCode.UNSUPPORTED, "not a jpeg, png, webp or heic image (${declaredMime ?: "no type"})")
        val rel = "${AppDirs.TMP}/pick-${ids()}.${EXT.getValue(mime)}"
        val dest = guard.resolve(rel)
        io("create tmp dir") { dest.parentFile!!.mkdirs() }
        try {
            io("copy picked image") {
                dest.outputStream().use { out ->
                    var total = n.toLong()
                    out.write(header, 0, n)
                    val buf = ByteArray(BUF)
                    while (true) {
                        if (total > maxBytes) raise(NativeErrorCode.TOO_LARGE, "image is larger than $maxBytes bytes")
                        val r = input.read(buf)
                        if (r < 0) break
                        total += r
                        out.write(buf, 0, r)
                    }
                }
            }
        } catch (e: Throwable) {
            dest.delete()
            throw e
        }
        return Imported(rel, mime)
    }

    /** A local file (the debug test hook); the extension is only a hint, the header decides. */
    fun importFile(src: File): Imported {
        if (!src.isFile) raise(NativeErrorCode.NOT_FOUND, "no such file: ${src.name}")
        return io("open image") { src.inputStream() }.use { importStream(null, it) }
    }

    companion object {
        const val MAX_BYTES = 40L * 1024 * 1024
        private const val HEADER = 16
        private const val BUF = 64 * 1024

        private val EXT = mapOf(
            "image/jpeg" to "jpg",
            "image/png" to "png",
            "image/webp" to "webp",
            "image/heic" to "heic",
            "image/heif" to "heif",
        )

        /** The accepted mime, or null if [declared] is a different type or the header is unknown. */
        internal fun resolveMime(declared: String?, header: ByteArray): String? {
            val d = declared?.lowercase()?.substringBefore(';')?.trim()
            return when {
                d == null || d.isEmpty() || d == "application/octet-stream" || d == "image/*" -> sniff(header)
                d == "image/jpg" -> "image/jpeg"
                d in EXT -> d
                else -> null
            }
        }

        internal fun sniff(h: ByteArray): String? {
            fun at(i: Int, vararg b: Int) = h.size >= i + b.size && b.indices.all { h[i + it].toInt() and 0xFF == b[it] }
            fun ascii(i: Int, s: String) = h.size >= i + s.length && s.indices.all { h[i + it].toInt() == s[it].code }
            return when {
                at(0, 0xFF, 0xD8, 0xFF) -> "image/jpeg"
                at(0, 0x89, 0x50, 0x4E, 0x47) -> "image/png"
                ascii(0, "RIFF") && ascii(8, "WEBP") -> "image/webp"
                ascii(4, "ftyp") && h.size >= 12 -> when (String(h, 8, 4, Charsets.US_ASCII)) {
                    "heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs" -> "image/heic"
                    "mif1", "msf1" -> "image/heif"
                    else -> null
                }
                else -> null
            }
        }

        private fun readUpTo(input: InputStream, buf: ByteArray): Int {
            var n = 0
            while (n < buf.size) {
                val r = input.read(buf, n, buf.size - n)
                if (r < 0) break
                n += r
            }
            return n
        }
    }
}
