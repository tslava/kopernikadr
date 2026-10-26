// Plugins are declared here (not applied) so AGP and KGP share one classloader; this also
// lifts AGP's built-in Kotlin from its default KGP to the version pinned in the catalog.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
