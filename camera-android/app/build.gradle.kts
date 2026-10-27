import java.util.Properties

plugins {
    // AGP 9 compiles Kotlin itself (built-in Kotlin); org.jetbrains.kotlin.android is not applied.
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing: ~/.kopernikadr/keystore.properties (outside the repo), or the file named by
// KOPERNIKADR_KEYSTORE_PROPERTIES. Keys: storeFile (absolute, or relative to the properties
// file), storePassword, keyAlias, keyPassword. Without the file the release build stays unsigned
// (scripts/build.sh refuses to build release then). Same loader in remote/android/app/build.gradle.
val releaseKeystoreProps: Properties? = run {
    val override = System.getenv("KOPERNIKADR_KEYSTORE_PROPERTIES")?.takeIf { it.isNotBlank() }
    val propsFile = if (override != null) {
        file(override)
    } else {
        file("${System.getProperty("user.home")}/.kopernikadr/keystore.properties")
    }
    if (!propsFile.isFile) {
        if (override != null) throw GradleException("KOPERNIKADR_KEYSTORE_PROPERTIES=$override: no such file")
        return@run null
    }
    val props = Properties().apply { propsFile.inputStream().use { load(it) } }
    val missing = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
        .filter { props.getProperty(it).isNullOrBlank() }
    if (missing.isNotEmpty()) throw GradleException("$propsFile: missing ${missing.joinToString()}")
    val store = File(props.getProperty("storeFile")).let { if (it.isAbsolute) it else File(propsFile.parentFile, it.path) }
    if (!store.isFile) throw GradleException("$propsFile: storeFile not found: $store")
    props.setProperty("storeFile", store.absolutePath)
    props
}

android {
    namespace = "pl.slava.kopernikadr.camera"
    compileSdk = 36

    defaultConfig {
        applicationId = "pl.slava.kopernikadr.camera"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.1"
    }

    signingConfigs {
        if (releaseKeystoreProps != null) {
            create("release") {
                storeFile = file(releaseKeystoreProps.getProperty("storeFile"))
                storePassword = releaseKeystoreProps.getProperty("storePassword")
                keyAlias = releaseKeystoreProps.getProperty("keyAlias")
                keyPassword = releaseKeystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            buildConfigField("boolean", "CORS_LOCALHOST_ANY_PORT", "true")
        }
        release {
            isMinifyEnabled = false
            // CORS for http://localhost:<any port> (the remote's `next dev` in desktop Chrome):
            // debug and probe only; release allows exactly http://localhost.
            buildConfigField("boolean", "CORS_LOCALHOST_ANY_PORT", "false")
            // Unsigned when there is no keystore.properties (see releaseKeystoreProps above).
            if (releaseKeystoreProps != null) signingConfig = signingConfigs.getByName("release")
        }
        // Release-like (non-debuggable) build for timing probes; carries src/probe diagnostics.
        create("probe") {
            initWith(getByName("release"))
            isDebuggable = false
            applicationIdSuffix = ".probe"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
            buildConfigField("boolean", "CORS_LOCALHOST_ANY_PORT", "true")
        }
    }

    // Debug carries the same diagnostics as probe (src/probe); release has none.
    sourceSets.getByName("debug").kotlin.srcDir("src/probe/kotlin")

    // Kotlin's jvmTarget follows targetCompatibility under built-in Kotlin.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // UI languages: Polish (default resources) and Russian; drops other library translations.
    androidResources {
        localeFilters += listOf("pl", "ru")
    }

    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/INDEX.LIST")
        }
    }
}

dependencies {
    implementation(project(":core"))

    implementation(libs.kotlinx.coroutines.android)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.ktx)
    implementation(libs.lifecycle.runtime.compose)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.camera.core)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.view)

    runtimeOnly(libs.slf4j.nop)

    testImplementation(libs.junit)
}
