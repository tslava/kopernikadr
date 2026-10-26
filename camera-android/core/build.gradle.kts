import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

// No jvmToolchain(): it would try to provision a JDK. Compile on the JBR, target 17 like :app.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

dependencies {
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)
    api(libs.ktor.server.core)
    api(libs.ktor.server.cio)
    api(libs.ktor.server.websockets)
    api(libs.ktor.server.cors)
    api(libs.ktor.server.content.negotiation)
    api(libs.ktor.serialization.kotlinx.json)
    api(libs.androidx.sqlite)
    implementation(libs.zxing.core)
    // Resolves to the JVM variant here and to the Android variant (with .so files) in :app.
    implementation(libs.androidx.sqlite.bundled)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.ktor.server.test.host)
    testImplementation(libs.ktor.client.websockets)
    testImplementation(libs.ktor.client.content.negotiation)
    testRuntimeOnly(libs.slf4j.simple)
}

tasks.test {
    useJUnit()
}

// remote-lite's lib/ = its own src/main/resources/remote-lite/lib/ + packages/remote-core/src/*.js
// (@kopernikadr/remote-core), copied into a dedicated resource root so the classpath and the APK
// merge both. A file name present in both roots fails processResources (duplicate entry).
// (register<…>(…) rather than `by registering`: the delegate syntax is deprecated in Gradle 9.)
val remoteCoreSrc: File = rootDir.resolve("../packages/remote-core/src").normalize()

// A Sync whose source dir is missing skips its actions (empty source), so a doFirst check would
// never run: the check is its own task, which always runs.
val checkRemoteCore = tasks.register("checkRemoteCore") {
    val src = remoteCoreSrc
    doLast { check(src.resolve("protocol.js").isFile) { "remote-core not found at $src" } }
}

val syncRemoteCore = tasks.register<Sync>("syncRemoteCore") {
    dependsOn(checkRemoteCore)
    from(remoteCoreSrc) {
        include("*.js")
        into("remote-lite/lib")
    }
    into(layout.buildDirectory.dir("generated/remote-core-res"))
}

sourceSets.main {
    resources.srcDir(syncRemoteCore)
}
