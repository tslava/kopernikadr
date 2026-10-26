package pl.slava.kopernikadr.camera.host

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/** A QR code as a square grid of modules; `true` = dark. Includes no quiet zone. */
class QrMatrix(val size: Int, private val modules: BooleanArray) {
    operator fun get(x: Int, y: Int): Boolean = modules[y * size + x]

    companion object {
        /** Encodes [text] (the remote's URL) with medium error correction. */
        fun encode(text: String): QrMatrix {
            require(text.isNotEmpty()) { "empty QR text" }
            val hints = mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 0)
            val bits = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints)
            val size = bits.width
            return QrMatrix(size, BooleanArray(size * size) { bits[it % size, it / size] })
        }
    }
}
