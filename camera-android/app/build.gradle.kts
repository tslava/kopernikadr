plugins {
    // AGP 9 compiles Kotlin itself (built-in Kotlin); org.jetbrains.kotlin.android is not applied.
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
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

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = false
            // Unsigned for now; release signing comes with plan 0b.
        }
        // Release-like (non-debuggable) build for timing probes; carries src/probe diagnostics.
        create("probe") {
            initWith(getByName("release"))
            isDebuggable = false
            applicationIdSuffix = ".probe"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
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
