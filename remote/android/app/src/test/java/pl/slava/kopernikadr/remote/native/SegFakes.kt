package pl.slava.kopernikadr.remote.native

import java.io.File

/** Writes a stand-in PNG and reports a fixed size; records what it was asked. */
class FakeLoader(
    private val width: Int = 8,
    private val height: Int = 6,
    private val hasAlpha: Boolean = false,
) : ImageLoader {
    val calls = mutableListOf<Triple<String, String, Int>>()

    override fun load(src: File, dest: File, maxSide: Int): LoadedImage {
        calls += Triple(src.name, dest.name, maxSide)
        dest.writeBytes(byteArrayOf(1, 2, 3))
        return LoadedImage(width, height, hasAlpha)
    }
}

/** A scripted engine: [onSegment] may throw; the default mask is `w*h` bytes of 200. */
class FakeEngine(
    val gpu: Boolean = false,
    private val onSetImage: (FakeEngine) -> Unit = {},
    private val onSegment: (FakeEngine, List<SegStroke>) -> Unit = { _, _ -> },
    private val width: Int = 8,
    private val height: Int = 6,
) : SegEngine {
    var images = 0
    var segments = 0
    var closed = false
    var lastStrokes: List<SegStroke> = emptyList()

    override fun setImage(image: File) {
        images++
        onSetImage(this)
    }

    override fun segment(strokes: List<SegStroke>): SegMask {
        segments++
        lastStrokes = strokes
        onSegment(this, strokes)
        return SegMask(width, height, ByteArray(width * height) { 200.toByte() })
    }

    override fun close() {
        closed = true
    }
}
