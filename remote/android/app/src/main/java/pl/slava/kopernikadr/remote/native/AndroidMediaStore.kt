package pl.slava.kopernikadr.remote.native

import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.net.Uri
import android.os.Bundle
import android.os.StatFs
import android.provider.MediaStore
import java.io.File
import java.io.IOException
import java.io.OutputStream

/**
 * [MediaStoreGateway] over `ContentResolver` on
 * `MediaStore.Video.Media.getContentUri(VOLUME_EXTERNAL_PRIMARY)`. API 31+ needs no storage
 * permission for our own rows. Not unit-tested (needs the Android runtime); checked on the emulator.
 */
class AndroidMediaStoreGateway(private val resolver: ContentResolver) : MediaStoreGateway {
    private val collection: Uri = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

    override fun insert(values: Map<String, Any>): String? = resolver.insert(collection, values.toContentValues())?.toString()

    override fun openOutput(uri: String): OutputStream? = resolver.openOutputStream(Uri.parse(uri), "w")

    override fun update(uri: String, values: Map<String, Any>): Int =
        resolver.update(Uri.parse(uri), values.toContentValues(), null)

    override fun delete(uri: String): Int = resolver.delete(Uri.parse(uri), null)

    override fun query(queryArgs: Map<String, Any>): List<String> {
        val args = Bundle()
        for ((k, v) in queryArgs) {
            when (v) {
                is String -> args.putString(k, v)
                is Int -> args.putInt(k, v)
                is Array<*> -> args.putStringArray(k, v.map { it as String }.toTypedArray())
                else -> throw IllegalArgumentException("unsupported query arg $k: ${v.javaClass}")
            }
        }
        val projection = arrayOf(MediaStore.MediaColumns._ID)
        val cursor = resolver.query(collection, projection, args, null) ?: return emptyList()
        return cursor.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            buildList { while (c.moveToNext()) add(ContentUris.withAppendedId(collection, c.getLong(idCol)).toString()) }
        }
    }

    private fun Map<String, Any>.toContentValues() = ContentValues().also { cv ->
        for ((k, v) in this) {
            when (v) {
                is String -> cv.put(k, v)
                is Int -> cv.put(k, v)
                is Long -> cv.put(k, v)
                else -> throw IllegalArgumentException("unsupported value $k: ${v.javaClass}")
            }
        }
    }
}

/** [DiskSpace] via `StatFs.availableBytes` (blocks available to apps). */
object StatFsDiskSpace : DiskSpace {
    override fun freeBytes(existingDir: File): Long =
        try {
            StatFs(existingDir.path).availableBytes
        } catch (e: IllegalArgumentException) {
            // StatFs reports statvfs(2) failures as IllegalArgumentException.
            throw IOException("statfs ${existingDir.path}: ${e.message}", e)
        }
}
