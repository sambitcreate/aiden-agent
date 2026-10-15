# Release shrinking rules for Aiden On The Go.
#
# kotlinx.serialization, OkHttp, Okio, coroutines, AndroidX and ML Kit ship
# their own consumer R8 rules; only app-specific needs belong here.

# Keep line numbers so release stack traces in diagnostics stay readable.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Serializable models: keep generated serializers and the companion lookups
# used by serializer<T>() for every @Serializable class in the app.
-keepclassmembers @kotlinx.serialization.Serializable class sbtbiswas.AidenOnTheGo.** {
    *** Companion;
    *** INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class sbtbiswas.AidenOnTheGo.**$$serializer { *; }

# OkHttp optional TLS providers are probed reflectively and absent on Android.
-dontwarn org.bouncycastle.jsse.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
