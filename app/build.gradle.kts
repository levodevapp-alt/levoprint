plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}
android {
  namespace = "dev.levo.levoprint"
  compileSdk = 34
  defaultConfig {
    applicationId = "dev.levo.levoprint"
    minSdk = 26
    targetSdk = 34
    versionCode = 4
    versionName = "1.2.0"
  }
  // Firma RELEASE de la casa (keystore PKCS12 de LevoDev). En CI llega por
  // secrets (KEYSTORE_B64/KEYSTORE_PASSWORD/KEY_ALIAS/KEY_PASSWORD); sin
  // ellos se firma con la clave debug (instalable, pero NO actualiza sobre
  // un APK firmado con la release).
  val ksPath = System.getenv("KEYSTORE_PATH")
  signingConfigs {
    if (ksPath != null && file(ksPath).exists()) {
      create("release") {
        storeFile = file(ksPath)
        storePassword = System.getenv("KEYSTORE_PASSWORD")
        keyAlias = System.getenv("KEY_ALIAS") ?: "levodev"
        keyPassword = System.getenv("KEY_PASSWORD")
        storeType = "PKCS12"
      }
    }
  }
  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
}
dependencies {
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("com.google.android.material:material:1.12.0")
  // Escaner QR para el emparejamiento (boton "Escanear QR"). Liviano: trae su
  // propia Activity de camara (CameraX/ZXing por dentro), sin Play Services.
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
