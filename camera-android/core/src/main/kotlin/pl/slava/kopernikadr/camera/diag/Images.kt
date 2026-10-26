package pl.slava.kopernikadr.camera.diag

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Minimal pure-Kotlin image types for the diagnostics metrics (no android.graphics, no AWT), so
 * the metrics run and are tested on the host JVM. The app converts Bitmap / YUV planes into these.
 */

/** Grayscale image, row-major, values on the 8-bit scale (0..255) as floats. */
class GrayImage(val width: Int, val height: Int, val data: FloatArray = FloatArray(width * height)) {
    init {
        require(width > 0 && height > 0) { "empty image ${width}x$height" }
        require(data.size == width * height) { "data size ${data.size} != ${width}x$height" }
    }

    operator fun get(x: Int, y: Int): Float = data[y * width + x]

    operator fun set(x: Int, y: Int, v: Float) {
        data[y * width + x] = v
    }

    override fun toString() = "GrayImage(${width}x$height)"

    companion object {
        /** From an unsigned 8-bit plane, e.g. the Y plane of YUV_420_888 (`pixelStride` 1). */
        fun fromBytes(width: Int, height: Int, bytes: ByteArray, rowStride: Int = width, offset: Int = 0): GrayImage {
            val img = GrayImage(width, height)
            for (y in 0 until height) {
                val row = offset + y * rowStride
                for (x in 0 until width) img.data[y * width + x] = (bytes[row + x].toInt() and 0xFF).toFloat()
            }
            return img
        }
    }
}

/** Colour image, row-major, packed ARGB like `android.graphics.Bitmap.getPixels` (alpha ignored). */
class RgbImage(val width: Int, val height: Int, val argb: IntArray = IntArray(width * height)) {
    init {
        require(width > 0 && height > 0) { "empty image ${width}x$height" }
        require(argb.size == width * height) { "argb size ${argb.size} != ${width}x$height" }
    }

    override fun toString() = "RgbImage(${width}x$height)"
}

fun argb(r: Int, g: Int, b: Int): Int = (0xFF shl 24) or ((r and 0xFF) shl 16) or ((g and 0xFF) shl 8) or (b and 0xFF)

internal fun red(c: Int) = (c ushr 16) and 0xFF
internal fun green(c: Int) = (c ushr 8) and 0xFF
internal fun blue(c: Int) = c and 0xFF

/**
 * Luma on the gamma-encoded 0..255 values with the **Rec.601** weights (0.299, 0.587, 0.114).
 * Rec.601 rather than Rec.709 because it is what JPEG/JFIF's Y (and the camera's YUV Y plane)
 * uses, so a mean over a decoded still and a mean over a Y plane are directly comparable.
 */
fun luma(r: Int, g: Int, b: Int): Float = 0.299f * r + 0.587f * g + 0.114f * b

fun RgbImage.toGray(): GrayImage {
    val out = GrayImage(width, height)
    for (i in argb.indices) {
        val c = argb[i]
        out.data[i] = luma(red(c), green(c), blue(c))
    }
    return out
}

fun GrayImage.toRgb(): RgbImage = RgbImage(width, height, IntArray(data.size) { i -> clampByte(data[i]).let { argb(it, it, it) } })

fun GrayImage.crop(x0: Int, y0: Int, w: Int, h: Int): GrayImage {
    require(x0 >= 0 && y0 >= 0 && x0 + w <= width && y0 + h <= height) { "crop out of bounds" }
    val out = GrayImage(w, h)
    for (y in 0 until h) System.arraycopy(data, (y0 + y) * width + x0, out.data, y * w, w)
    return out
}

fun RgbImage.crop(x0: Int, y0: Int, w: Int, h: Int): RgbImage {
    require(x0 >= 0 && y0 >= 0 && x0 + w <= width && y0 + h <= height) { "crop out of bounds" }
    val out = RgbImage(w, h)
    for (y in 0 until h) System.arraycopy(argb, (y0 + y) * width + x0, out.argb, y * w, w)
    return out
}

/** Centred crop of at most [w]x[h] (clamped to the image size). */
fun GrayImage.centreCrop(w: Int, h: Int = w): GrayImage {
    val cw = min(w, width)
    val ch = min(h, height)
    return crop((width - cw) / 2, (height - ch) / 2, cw, ch)
}

fun RgbImage.centreCrop(w: Int, h: Int = w): RgbImage {
    val cw = min(w, width)
    val ch = min(h, height)
    return crop((width - cw) / 2, (height - ch) / 2, cw, ch)
}

fun GrayImage.rotate180(): GrayImage = GrayImage(width, height, data.reversedArray())

fun RgbImage.rotate180(): RgbImage = RgbImage(width, height, argb.reversedArray())

/** Area-average (box) resampling: each output pixel is the coverage-weighted mean of the source. */
fun GrayImage.downscale(w: Int, h: Int): GrayImage =
    if (w == width && h == height) GrayImage(w, h, data.copyOf()) else GrayImage(w, h, resampleArea(data, width, height, w, h))

/** Area-average resampling per channel. */
fun RgbImage.downscale(w: Int, h: Int): RgbImage {
    if (w == width && h == height) return RgbImage(w, h, argb.copyOf())
    val r = resampleArea(FloatArray(argb.size) { red(argb[it]).toFloat() }, width, height, w, h)
    val g = resampleArea(FloatArray(argb.size) { green(argb[it]).toFloat() }, width, height, w, h)
    val b = resampleArea(FloatArray(argb.size) { blue(argb[it]).toFloat() }, width, height, w, h)
    return RgbImage(w, h, IntArray(w * h) { argb(clampByte(r[it]), clampByte(g[it]), clampByte(b[it])) })
}

internal fun clampByte(v: Float): Int = v.roundToInt().coerceIn(0, 255)

/** Per output index: source taps [first, first + count) with weights summing to 1. */
private class AreaTaps(srcN: Int, dstN: Int) {
    val first = IntArray(dstN)
    val offset = IntArray(dstN + 1)
    val weight: FloatArray

    init {
        val scale = srcN.toDouble() / dstN
        val ws = ArrayList<Float>(dstN * (ceil(scale).toInt() + 1))
        for (i in 0 until dstN) {
            val lo = i * scale
            val hi = min((i + 1) * scale, srcN.toDouble())
            val j0 = floor(lo).toInt()
            val j1 = min(ceil(hi).toInt(), srcN) // exclusive
            first[i] = j0
            offset[i] = ws.size
            for (j in j0 until j1) ws.add(((min(hi, j + 1.0) - maxOf(lo, j.toDouble())) / scale).toFloat())
        }
        offset[dstN] = ws.size
        weight = ws.toFloatArray()
    }
}

/** Separable area resampling (horizontal pass, then vertical). Also works for upscaling. */
internal fun resampleArea(src: FloatArray, sw: Int, sh: Int, dw: Int, dh: Int): FloatArray {
    require(dw > 0 && dh > 0)
    val tx = AreaTaps(sw, dw)
    val ty = AreaTaps(sh, dh)
    val tmp = FloatArray(dw * sh)
    for (y in 0 until sh) {
        val row = y * sw
        for (x in 0 until dw) {
            var s = 0f
            var j = row + tx.first[x]
            for (k in tx.offset[x] until tx.offset[x + 1]) s += src[j++] * tx.weight[k]
            tmp[y * dw + x] = s
        }
    }
    val out = FloatArray(dw * dh)
    for (y in 0 until dh) {
        val o = y * dw
        var r = ty.first[y]
        for (k in ty.offset[y] until ty.offset[y + 1]) {
            val wk = ty.weight[k]
            val t = r * dw
            for (x in 0 until dw) out[o + x] += tmp[t + x] * wk
            r++
        }
    }
    return out
}
