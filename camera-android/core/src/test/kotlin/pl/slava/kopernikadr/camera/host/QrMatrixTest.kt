package pl.slava.kopernikadr.camera.host

import com.google.zxing.BinaryBitmap
import com.google.zxing.LuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class QrMatrixTest {
    @Test
    fun `encodes the remote url and decodes back`() {
        val url = "http://192.168.1.34:8765/"
        val qr = QrMatrix.encode(url)
        assertTrue(qr.size >= 21)
        assertEquals(url, decode(qr))
    }

    @Test
    fun `finder pattern corner is dark`() {
        val qr = QrMatrix.encode("http://10.0.0.2:8765/")
        assertTrue(qr[0, 0])
        assertTrue(qr[qr.size - 1, 0])
        assertTrue(qr[0, qr.size - 1])
    }

    @Test
    fun `rejects empty text`() {
        assertThrows(IllegalArgumentException::class.java) { QrMatrix.encode("") }
    }

    /** Renders with a 4-module quiet zone at 4 px per module and reads it with zxing. */
    private fun decode(qr: QrMatrix): String {
        val scale = 4
        val side = (qr.size + 8) * scale
        val pixels = ByteArray(side * side) { i ->
            val mx = (i % side) / scale - 4
            val my = (i / side) / scale - 4
            val dark = mx in 0 until qr.size && my in 0 until qr.size && qr[mx, my]
            if (dark) 0 else 0xFF.toByte()
        }
        val source = object : LuminanceSource(side, side) {
            override fun getRow(y: Int, row: ByteArray?): ByteArray = pixels.copyOfRange(y * side, (y + 1) * side)
            override fun getMatrix(): ByteArray = pixels
        }
        return QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source))).text
    }
}
