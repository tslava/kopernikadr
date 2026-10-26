package pl.slava.kopernikadr.remote.native

/** App-private storage layout under `filesDir` (ARCHITECTURE §5.4). */
object AppDirs {
    const val ROOT = "kopernikadr"
    const val TMP = "tmp"
    const val EXPORTS = "exports"
    const val PROBE = "probe"

    val ALL: List<String> = listOf(TMP, EXPORTS, PROBE)

    /** `kopernikadr/<sub>` for one of [ALL]. */
    fun relative(sub: String): String {
        require(sub in ALL) { "unknown app dir: $sub" }
        return "$ROOT/$sub"
    }
}
