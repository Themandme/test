# kotlinx.serialization: keep generated serializers.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class app.seniordirectory.** {
    *** Companion;
}
-keepclasseswithmembers class app.seniordirectory.** {
    kotlinx.serialization.KSerializer serializer(...);
}
# BouncyCastle
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**
