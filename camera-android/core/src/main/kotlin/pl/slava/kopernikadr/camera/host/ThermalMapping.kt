package pl.slava.kopernikadr.camera.host

import pl.slava.kopernikadr.camera.protocol.Thermal

object ThermalMapping {
    /** `PowerManager.currentThermalStatus` (`THERMAL_STATUS_NONE` = 0 … `SHUTDOWN` = 6) → wire [Thermal]. */
    fun fromAndroid(status: Int): Thermal = when (status) {
        0 -> Thermal.NONE
        1 -> Thermal.LIGHT
        2 -> Thermal.MODERATE
        3 -> Thermal.SEVERE
        4 -> Thermal.CRITICAL
        5 -> Thermal.EMERGENCY
        6 -> Thermal.SHUTDOWN
        else -> Thermal.UNKNOWN
    }
}
