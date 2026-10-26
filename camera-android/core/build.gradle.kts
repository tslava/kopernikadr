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
