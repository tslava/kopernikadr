package pl.slava.kopernikadr.camera.core

/**
 * Maps a camera buffer to the project's upright 4:3 landscape output (ARCHITECTURE §4.3).
 *
 * Every use case is bound with target rotation ROTATION_90, so a 4:3 ViewPort equals the
 * sensor-native landscape and a buffer's `rotationDegrees` is 0 or 180. The total rotation is
 * `(rotationDegrees + projectRotation) mod 360` ∈ {0, 180}; a 90° turn is never produced.
 *
 * [matrix] maps continuous buffer coordinates to output coordinates: the corner
 * `(cropRect.left, cropRect.top)` goes to `(0, 0)` at total rotation 0 and to
 * `(outputSize.width, outputSize.height)` at 180. It is the matrix for
 * `Bitmap.createBitmap(src, 0, 0, w, h, matrix, true)` / `Canvas.drawBitmap` into an
 * [outputSize] bitmap.
 */
data class FrameTransform(
    /** The exact 4:3 region of the buffer that is used (see [centerCrop4by3]). */
    val cropRect: IntRect,
    /** Total rotation, 0 or 180. */
    val rotationDegrees: Int,
    val outputSize: Size,
    val matrix: Affine,
) {
    companion object {
        private val ALLOWED_ROTATIONS = setOf(0, 180)

        /**
         * @param bufferSize size of the image buffer.
         * @param cropRect the buffer's crop rect (CameraX `ImageProxy.cropRect`); must lie inside
         *   the buffer and be landscape. If it is not exactly 4:3 it is reduced with [centerCrop4by3].
         * @param rotationDegrees the buffer's `rotationDegrees`; 0 or 180.
         * @param projectRotation the project rotation; 0 or 180.
         * @param target output size for scaling (exact 4:3 landscape, e.g. from [size4by3ForWidth]);
         *   null keeps the crop's pixel size.
         * @throws IllegalArgumentException on 90/270 (or any other) rotations, a crop outside the
         *   buffer, a portrait/square crop, a crop smaller than 4×3, or a non-4:3 target.
         */
        fun compute(
            bufferSize: Size,
            cropRect: IntRect,
            rotationDegrees: Int,
            projectRotation: Int,
            target: Size? = null,
        ): FrameTransform {
            require(rotationDegrees in ALLOWED_ROTATIONS) {
                "buffer rotationDegrees must be 0 or 180, got $rotationDegrees (use cases must use ROTATION_90)"
            }
            require(projectRotation in ALLOWED_ROTATIONS) { "project rotation must be 0 or 180, got $projectRotation" }
            require(IntRect.of(bufferSize).contains(cropRect)) { "cropRect $cropRect outside buffer $bufferSize" }
            require(cropRect.width > cropRect.height) { "cropRect $cropRect is not landscape" }
            if (target != null) {
                require(target.isExact4by3) { "target $target is not an exact 4:3 landscape size" }
            }

            val crop = centerCrop4by3(cropRect)
            val total = (rotationDegrees + projectRotation) % 360
            val w = crop.width.toDouble()
            val h = crop.height.toDouble()
            val out = target ?: crop.size

            var m = Affine.translate(-crop.left.toDouble(), -crop.top.toDouble())
            if (total == 180) m = m.then(Affine.rotate(180)).then(Affine.translate(w, h))
            if (out != crop.size) m = m.then(Affine.scale(out.width / w, out.height / h))
            return FrameTransform(crop, total, out, m)
        }

        /**
         * The largest exact 4:3 landscape rect inside [rect], centred: with `k = min(w / 4, h / 3)`
         * (integer division) the result is `4k × 3k`, offset by `floor((w - 4k) / 2)` from the left
         * and `floor((h - 3k) / 2)` from the top. An odd leftover pixel is dropped on the
         * right/bottom.
         * @throws IllegalArgumentException if [rect] is smaller than 4×3.
         */
        fun centerCrop4by3(rect: IntRect): IntRect {
            val k = minOf(rect.width / 4, rect.height / 3)
            require(k >= 1) { "rect $rect is too small for 4:3" }
            val w = 4 * k
            val h = 3 * k
            val left = rect.left + (rect.width - w) / 2
            val top = rect.top + (rect.height - h) / 2
            return IntRect(left, top, left + w, top + h)
        }

        /**
         * The 4:3 landscape size with the given [width] (e.g. 640 → 640×480, 1440 → 1440×1080,
         * 256 → 256×192). @throws IllegalArgumentException unless width > 0 and divisible by 4.
         */
        fun size4by3ForWidth(width: Int): Size {
            require(width > 0 && width % 4 == 0) { "4:3 width must be a positive multiple of 4, got $width" }
            return Size(width, width / 4 * 3)
        }
    }
}
