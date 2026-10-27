package pl.slava.kopernikadr.camera.net

/**
 * The camera's display name (`/info`, `hello`, NSD `name`): the phone model, so a tablet that sees two
 * phones can tell them apart ("Kamera moto g05" vs "Kamera Pixel 8"). Blank → [DEFAULT_CAMERA_NAME].
 */
fun cameraName(model: String?): String {
    val m = model?.trim()?.replace(Regex("\\s+"), " ").orEmpty()
    return if (m.isEmpty()) DEFAULT_CAMERA_NAME else m.take(MAX_CAMERA_NAME_CHARS)
}

const val DEFAULT_CAMERA_NAME = "Kopernikadr Kamera"
const val MAX_CAMERA_NAME_CHARS = 40
