package pl.slava.kopernikadr.camera.host

import java.io.File
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import pl.slava.kopernikadr.camera.spool.DurableFiles

/**
 * The persistent `cameraId` (PROTOCOL §3 `/info`): a UUID kept in `<dir>/identity.json`, written
 * durably on first use. An unreadable file is replaced by a new id ([log]ged).
 */
class IdentityStore(
    private val dir: File,
    private val files: DurableFiles,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val log: (String) -> Unit = {},
) {
    @Serializable
    private data class Stored(val cameraId: String)

    @Synchronized
    fun cameraId(): String {
        val file = File(dir, FILE_NAME)
        if (file.isFile) {
            val stored = runCatching { JSON.decodeFromString(Stored.serializer(), file.readText()).cameraId }
                .getOrNull()
                ?.takeIf { runCatching { UUID.fromString(it) }.isSuccess }
            if (stored != null) return stored
            log("identity: $file is unreadable, creating a new cameraId")
        }
        val id = newId()
        check(dir.isDirectory || dir.mkdirs()) { "cannot create $dir" }
        files.writeAtomic(dir, FILE_NAME, JSON.encodeToString(Stored.serializer(), Stored(id)).toByteArray())
        log("identity: new cameraId $id")
        return id
    }

    companion object {
        const val FILE_NAME = "identity.json"
        private val JSON = Json { ignoreUnknownKeys = true }
    }
}
