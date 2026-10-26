package pl.slava.kopernikadr.camera.core

/** No size in the camera's list fits the rule. */
class NoSuitableSizeException(message: String) : IllegalArgumentException(message)

/**
 * Picks the requested stream sizes from what Camera2 reports (plan "Size selection").
 * Sizes are normalized to landscape first; "4:3" means exactly `w*3 == h*4`.
 */
object SizeSelection {
    val FULL_MAX = Size(3264, 2448)
    val ANALYSIS_PREFERRED = Size(1280, 960)
    val ANALYSIS_FALLBACK = Size(960, 720)

    /**
     * The `full` still size: the largest 4:3 JPEG size ≤ [FULL_MAX] (3264×2448 itself when present).
     * @throws NoSuitableSizeException if there is none.
     */
    fun selectFull(jpegSizes: Collection<Size>): Size =
        largest4by3Within(jpegSizes, FULL_MAX)
            ?: throw NoSuitableSizeException("no 4:3 JPEG size <= $FULL_MAX in ${jpegSizes.toList()}")

    /**
     * The analysis (YUV) size: [ANALYSIS_PREFERRED] if present, else [ANALYSIS_FALLBACK], else the
     * largest 4:3 size ≤ [ANALYSIS_PREFERRED].
     * @throws NoSuitableSizeException if there is none.
     */
    fun selectAnalysis(yuvSizes: Collection<Size>): Size {
        val normalized = yuvSizes.map { it.landscape() }.toSet()
        return when {
            ANALYSIS_PREFERRED in normalized -> ANALYSIS_PREFERRED
            ANALYSIS_FALLBACK in normalized -> ANALYSIS_FALLBACK
            else -> largest4by3Within(normalized, ANALYSIS_PREFERRED)
                ?: throw NoSuitableSizeException("no 4:3 YUV size <= $ANALYSIS_PREFERRED in ${yuvSizes.toList()}")
        }
    }

    private fun largest4by3Within(sizes: Collection<Size>, max: Size): Size? =
        sizes.asSequence()
            .map { it.landscape() }
            .filter { it.isExact4by3 && it.width <= max.width && it.height <= max.height }
            .maxByOrNull { it.area }
}
