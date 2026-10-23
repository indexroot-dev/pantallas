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
        versionCode = 3
        versionName = "1.2"
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
