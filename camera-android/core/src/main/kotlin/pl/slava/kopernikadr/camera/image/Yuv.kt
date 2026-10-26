package pl.slava.kopernikadr.camera.image

import pl.slava.kopernikadr.camera.camera.AnalysisFormat
import pl.slava.kopernikadr.camera.camera.AnalysisFrame

/** Pure YUV_420_888 → ARGB conversion shared by the Android codec and the JVM test codec. */
object Yuv {
    /**
     * Converts the whole [frame] (`size.width × size.height`) to opaque ARGB ints, row-major.
     * Full-range BT.601 (JFIF, what Camera2 delivers), honouring each plane's row and pixel
     * stride (pixelStride 1 = planar, 2 = interleaved NV12/NV21).
     */
    fun toArgb(frame: AnalysisFrame, out: IntArray? = null): IntArray {
        require(frame.format == AnalysisFormat.YUV_420_888) { "not a YUV frame: ${frame.format}" }
        require(frame.planes.size == 3) { "YUV_420_888 needs 3 planes, got ${frame.planes.size}" }
        val w = frame.size.width
        val h = frame.size.height
        val dst = out?.also { require(it.size >= w * h) { "out too small" } } ?: IntArray(w * h)
        val (yp, up, vp) = frame.planes
        val yb = yp.buffer
        val ub = up.buffer
        val vb = vp.buffer
        val yRs = yp.rowStride
        val yPs = yp.pixelStride
        val uRs = up.rowStride
        val uPs = up.pixelStride
        val vRs = vp.rowStride
        val vPs = vp.pixelStride
        var i = 0
        for (y in 0 until h) {
            val yRow = y * yRs
            val uRow = (y shr 1) * uRs
            val vRow = (y shr 1) * vRs
            for (x in 0 until w) {
                val yy = yb.get(yRow + x * yPs).toInt() and 0xFF
                val cx = x shr 1
                val u = (ub.get(uRow + cx * uPs).toInt() and 0xFF) - 128
                val v = (vb.get(vRow + cx * vPs).toInt() and 0xFF) - 128
                // 16.16 fixed point: 1.402, 0.344136, 0.714136, 1.772
                val r = yy + ((91_881 * v) shr 16)
                val g = yy - ((22_554 * u + 46_802 * v) shr 16)
                val b = yy + ((116_130 * u) shr 16)
                dst[i++] = (0xFF shl 24) or (clamp(r) shl 16) or (clamp(g) shl 8) or clamp(b)
            }
        }
        return dst
    }

    private fun clamp(c: Int): Int = if (c < 0) 0 else if (c > 255) 255 else c
}
