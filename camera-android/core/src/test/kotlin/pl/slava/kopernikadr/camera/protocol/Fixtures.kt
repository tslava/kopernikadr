package pl.slava.kopernikadr.camera.protocol

import java.io.File
import java.math.BigDecimal
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.fail

/**
 * Reads `protocol/fixtures` from the repository. Gradle runs `:core` tests with the module dir
 * (`camera-android/core`) as the working dir; IDE runs may use another dir, so walk up.
 */
object Fixtures {
    val dir: File by lazy {
        var d: File? = File(System.getProperty("user.dir")).absoluteFile
        while (d != null) {
            val candidate = d.resolve("protocol/fixtures")
            if (candidate.isDirectory) return@lazy candidate
            d = d.parentFile
        }
        error("protocol/fixtures not found above ${System.getProperty("user.dir")}")
    }

    fun names(): List<String> = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }!!
        .map { it.name }.sorted()

    fun text(name: String): String = dir.resolve(name).readText()

    fun json(name: String): JsonElement = Json.parseToJsonElement(text(name))
}

/**
 * JSON equality where numbers compare by value (`10` == `10.0`), so fixtures written by other
 * implementations do not fail on number formatting. Object key order is irrelevant.
 */
fun assertJsonEquals(expected: JsonElement, actual: JsonElement, path: String = "$") {
    when (expected) {
        is JsonObject -> {
            if (actual !is JsonObject) fail("$path: expected object, got $actual")
            actual as JsonObject
            if (expected.keys != actual.keys) {
                fail("$path: keys differ: expected ${expected.keys.sorted()}, got ${actual.keys.sorted()}")
            }
            for (k in expected.keys) assertJsonEquals(expected.getValue(k), actual.getValue(k), "$path.$k")
        }
        is JsonArray -> {
            if (actual !is JsonArray) fail("$path: expected array, got $actual")
            actual as JsonArray
            if (expected.size != actual.size) fail("$path: expected ${expected.size} items, got ${actual.size}")
            expected.indices.forEach { assertJsonEquals(expected[it], actual[it], "$path[$it]") }
        }
        JsonNull -> if (actual != JsonNull) fail("$path: expected null, got $actual")
        is JsonPrimitive -> {
            if (actual !is JsonPrimitive || actual is JsonNull) fail("$path: expected $expected, got $actual")
            actual as JsonPrimitive
            val same = when {
                expected.isString || actual.isString -> expected.isString == actual.isString && expected.content == actual.content
                isNumber(expected) && isNumber(actual) ->
                    BigDecimal(expected.content).compareTo(BigDecimal(actual.content)) == 0
                else -> expected.content == actual.content
            }
            if (!same) fail("$path: expected $expected, got $actual")
        }
    }
}

private fun isNumber(p: JsonPrimitive) = p.content.toBigDecimalOrNull() != null
