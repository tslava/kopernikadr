package pl.slava.kopernikadr.camera.core

import pl.slava.kopernikadr.camera.protocol.Capabilities
import pl.slava.kopernikadr.camera.protocol.CompensationCapability
import pl.slava.kopernikadr.camera.protocol.ExposureCapability
import pl.slava.kopernikadr.camera.protocol.ExposureLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusCapability
import pl.slava.kopernikadr.camera.protocol.FocusLockCapability
import pl.slava.kopernikadr.camera.protocol.FocusLockMethod
import pl.slava.kopernikadr.camera.protocol.FocusMode
import pl.slava.kopernikadr.camera.protocol.PreviewQuality
import pl.slava.kopernikadr.camera.protocol.Rational
import pl.slava.kopernikadr.camera.protocol.Sizes
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceCapability
import pl.slava.kopernikadr.camera.protocol.WhiteBalanceLockMethod
import pl.slava.kopernikadr.camera.protocol.Size as WireSize

/**
 * [CharacteristicsSnapshot] → PROTOCOL `Capabilities` (ARCHITECTURE §4.4: "lock" = freeze of the
 * metered values where the manual capabilities allow it, else the Camera2 lock, else none).
 */
object CapabilityMapper {
    val PLAY = Size(1440, 1080)
    val THUMB = Size(256, 192)
    const val ASPECT = "4:3"
    val ROTATIONS = listOf(0, 180)

    /** @throws NoSuitableSizeException if the JPEG list has no 4:3 size for `full`. */
    fun map(s: CharacteristicsSnapshot): Capabilities {
        val exposureMethod = when {
            s.hasManualSensor -> ExposureLockMethod.FREEZE
            s.aeLockAvailable == true -> ExposureLockMethod.AE_LOCK
            else -> null
        }
        val wbMethod = when {
            s.hasManualPostProcessing -> WhiteBalanceLockMethod.FREEZE
            s.awbLockAvailable == true -> WhiteBalanceLockMethod.AWB_LOCK
            else -> null
        }
        val minFocus = s.minFocusDistanceDiopters
        // min focus 0 = fixed lens. It is null when read without the CAMERA permission: then the AF
        // modes decide, and without the distance range only the AF lock is offered.
        val focusable = if (minFocus != null) minFocus > 0f else s.hasAutoFocus
        val focusMethod = when {
            focusable && minFocus != null && s.hasManualSensor -> FocusLockMethod.FREEZE
            focusable -> FocusLockMethod.AF_LOCK
            else -> null
        }
        return Capabilities(
            aspect = ASPECT,
            sizes = Sizes(
                full = SizeSelection.selectFull(s.jpegSizes).toWire(),
                play = PLAY.toWire(),
                thumb = THUMB.toWire(),
            ),
            rotations = ROTATIONS,
            exposure = ExposureCapability(
                lock = exposureMethod != null,
                method = exposureMethod,
                compensation = compensation(s.aeCompensationRange, s.aeCompensationStep),
            ),
            whiteBalance = WhiteBalanceCapability(lock = wbMethod != null, method = wbMethod),
            focusLock = FocusLockCapability(method = focusMethod),
            focus = FocusCapability(
                modes = if (focusable) listOf(FocusMode.AUTO, FocusMode.LOCKED) else listOf(FocusMode.FIXED),
                // Float → its decimal text → Double, so 8.333333f stays 8.333333 on the wire.
                minFocusDistanceDiopters = minFocus?.toString()?.toDouble(),
            ),
            previewQualities = PreviewQuality.entries,
        )
    }

    /** Supported iff the range is not [0,0]; an unsupported one is `{false, 0, 0, step or 0/1}`. */
    private fun compensation(range: IntSpan?, step: Ratio?): CompensationCapability {
        val stepEv = step?.let { Rational(it.num, it.den) } ?: Rational(0, 1)
        val supported = range != null && step != null && step.num != 0 && (range.lower != 0 || range.upper != 0)
        return if (supported) {
            CompensationCapability(true, range!!.lower, range.upper, stepEv)
        } else {
            CompensationCapability(false, 0, 0, stepEv)
        }
    }

    private fun Size.toWire() = WireSize(width, height)
}
