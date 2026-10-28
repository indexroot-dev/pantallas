plugins {
    id("com.android.application")
}

android {
    namespace = "com.pantallas.avisos"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.pantallas.avisos"
        minSdk = 26
        targetSdk = 37
        versionCode = 8
        versionName = "1.7"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // Cliente Socket.IO (compatible con servidores Socket.IO v3/v4). Android ya trae org.json.
    implementation("io.socket:socket.io-client:2.1.2") {
        exclude(group = "org.json", module = "json")
    }
}

// Copia el APK a apk/avisos.apk en la raíz del proyecto: es el que entrega el servidor,
// va al repositorio y entra en la imagen de Docker (la Raspberry Pi no puede compilar la app).
val publishApk by tasks.registering(Copy::class) {
    from(layout.buildDirectory.file("outputs/apk/debug/app-debug.apk"))
    into(rootProject.file("../apk"))
    rename { "avisos.apk" }
}
tasks.matching { it.name == "assembleDebug" }.configureEach { finalizedBy(publishApk) }
