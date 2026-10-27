package pl.slava.kopernikadr.camera.spool

import kotlin.random.Random

/**
 * The "are you sure" question before the quarantine is cleared: the product of two random two-digit
 * numbers (12..29), e.g. "23 × 17". Quarantine can hold the only copy of a photo and the screen sits
 * behind a hold gesture a child can find, so the guard is arithmetic a 9-year-old cannot easily do.
 * A new question is made each time the dialog opens.
 */
class ClearQuestion(val a: Int, val b: Int) {
    val answer: Int = a * b

    /** True only for the exact product typed as plain digits. */
    fun accepts(typed: String): Boolean {
        val t = typed.trim()
        return t.isNotEmpty() && t.length <= MAX_DIGITS && t.all { it in '0'..'9' } && t.toInt() == answer
    }

    companion object {
        const val MIN = 12
        const val MAX = 29
        const val MAX_DIGITS = 6

        fun random(rnd: Random = Random.Default) = ClearQuestion(rnd.nextInt(MIN, MAX + 1), rnd.nextInt(MIN, MAX + 1))
    }
}
