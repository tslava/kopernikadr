package pl.slava.kopernikadr.remote.nsd

/** DNS-SD service type of the camera (PROTOCOL §3). */
const val SERVICE_TYPE = "_kopernikadr._tcp"

/** TXT attributes (`NsdServiceInfo.getAttributes`) as text: UTF-8 values, a key without one → "". */
fun decodeTxt(attributes: Map<String, ByteArray?>): Map<String, String> =
    attributes.entries.associate { (k, v) -> k to (v?.toString(Charsets.UTF_8) ?: "") }

private fun isIpv4(a: String) = ':' !in a && a.isNotEmpty() && a.all { it.isDigit() || it == '.' }

/** Address strings with IPv4 first (stable otherwise), blanks and duplicates removed. */
fun orderAddresses(addresses: List<String>): List<String> {
    val distinct = addresses.filter { it.isNotBlank() }.distinct()
    return distinct.filter(::isIpv4) + distinct.filterNot(::isIpv4)
}
