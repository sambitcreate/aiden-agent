plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
}

// versionName is the single source; CI may pass -PaidenVersionName=1.2.3.
// versionCode is derived as major * 1_000_000 + minor * 1_000 + patch, so the
// same version always produces the same code and newer versions sort higher.
val aidenVersionName = (findProperty("aidenVersionName") as String?) ?: "0.1.0"
val aidenVersionCode = run {
    val parts = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)$").matchEntire(aidenVersionName)?.destructured
        ?: error("aidenVersionName must be MAJOR.MINOR.PATCH, got '$aidenVersionName'")
    val (major, minor, patch) = parts.toList().map { it.toInt() }
    require(minor < 1_000 && patch < 1_000 && major < 2_100) { "aidenVersionName out of range: $aidenVersionName" }
    major * 1_000_000 + minor * 1_000 + patch
}

android {
    namespace = "sbtbiswas.AidenOnTheGo"
    compileSdk = 36
    defaultConfig {
        applicationId = "sbtbiswas.AidenOnTheGo"
        minSdk = 26
        targetSdk = 36
        versionCode = aidenVersionCode
        versionName = aidenVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    buildFeatures {
      compose = true
      aidl = false
      buildConfig = false
      shaders = false
    }

    sourceSets {
      // JVM contract tests read the canonical Aiden Remote fixtures directly.
      getByName("test").resources.directories.add("../../protocol/aiden-remote/v1/fixtures")
    }

    packaging {
      resources {
        excludes += "/META-INF/{AL2.0,LGPL2.1}"
      }
    }

    testOptions {
      unitTests.all {
        // Resolve names from a fixed table so MockWebServer's per-request reverse lookup
        // of the loopback address never waits on the system resolver.
        it.systemProperty("jdk.net.hosts.file", file("src/test/jvm-hosts").absolutePath)
      }
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
  val composeBom = platform(libs.androidx.compose.bom)
  implementation(composeBom)
  androidTestImplementation(composeBom)

  // Core Android dependencies
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.compose)

  // Arch Components
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  // Compose
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  implementation(libs.androidx.compose.material3.adaptive)
  implementation(libs.androidx.compose.material.icons.extended)

  // Security & Crypto
  implementation(libs.androidx.security.crypto)

  // Coroutines & Serialization
  implementation(libs.kotlinx.coroutines.core)
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.kotlinx.serialization.json)

  // Camera & QR Barcode Scanning
  implementation(libs.camera.camera2)
  implementation(libs.camera.lifecycle)
  implementation(libs.camera.view)
  implementation(libs.mlkit.barcode.scanning)

  // OkHttp
  implementation(libs.okhttp)

  // Tooling
  debugImplementation(libs.androidx.compose.ui.tooling)
  debugImplementation(libs.androidx.compose.ui.test.manifest)

  // Local tests
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.okhttp.mockwebserver)

  // Instrumented tests
  androidTestImplementation(libs.androidx.compose.ui.test.junit4)
  androidTestImplementation(libs.androidx.test.core)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.test.espresso.core)
}
