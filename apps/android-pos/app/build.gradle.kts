plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.monetiser.pos"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.monetiser.pos"
        // minSdk conservador (Android 5.0): cubre terminales Android antiguos.
        // La versión exacta de Android de los PAX A920Pro y A77 de Marcos no está
        // verificada desde aquí: ver DEV-LOG (sesión 5 nov 2026, F3b).
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        // Servidor por defecto (el de PRUEBAS). Se puede cambiar en la pantalla de login.
        buildConfigField("String", "DEFAULT_SERVER", "\"https://orquestacion-def-test.onrender.com\"")
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        abortOnError = true
        checkReleaseBuilds = false
    }
}

// Sin dependencias externas: solo el framework de Android y la librería
// estándar de Kotlin (menos superficie, compila sin repositorios extra).
dependencies {}
