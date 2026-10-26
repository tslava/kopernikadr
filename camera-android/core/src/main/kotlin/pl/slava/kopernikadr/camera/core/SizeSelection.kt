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

    /** The on-phone viewfinder: the screen is 720 px high, so 960×720 shows every pixel it can. */
    val PREVIEW_PREFERRED = Size(960, 720)

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

    /**
     * The Preview (PRIVATE) size: [PREVIEW_PREFERRED] if present, else the largest 4:3 size ≤
     * [ANALYSIS_PREFERRED].
     * @throws NoSuitableSizeException if there is none.
     */
    fun selectPreview(privateSizes: Collection<Size>): Size {
        val normalized = privateSizes.map { it.landscape() }.toSet()
        return if (PREVIEW_PREFERRED in normalized) {
            PREVIEW_PREFERRED
        } else {
            largest4by3Within(normalized, ANALYSIS_PREFERRED)
                ?: throw NoSuitableSizeException("no 4:3 PRIVATE size <= $ANALYSIS_PREFERRED in ${privateSizes.toList()}")
        }
    }

    /**
     * Fallback order for a stream: the [preferred] sizes that are [supported] (in the order of
     * [preferred]), then the remaining supported sizes in their original order. Sizes compare
     * after [Size.landscape]; the returned elements are the [supported] instances. Used as the
     * CameraX `ResolutionFilter` so analysis falls back from 1280×960 to 960×720 first.
     */
    fun prioritize(supported: List<Size>, preferred: List<Size>): List<Size> {
        val wanted = preferred.map { it.landscape() }
        val first = wanted.mapNotNull { w -> supported.firstOrNull { it.landscape() == w } }.distinct()
        return first + supported.filter { it !in first }
    }

    private fun largest4by3Within(sizes: Collection<Size>, max: Size): Size? =
        sizes.asSequence()
            .map { it.landscape() }
            .filter { it.isExact4by3 && it.width <= max.width && it.height <= max.height }
            .maxByOrNull { it.area }
}
