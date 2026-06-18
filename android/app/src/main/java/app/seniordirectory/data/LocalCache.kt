package app.seniordirectory.data

import android.content.Context
import app.seniordirectory.ActivationPayload
import app.seniordirectory.AppJson
import app.seniordirectory.Brand
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

/**
 * Offline cache (SharedPreferences, the UserDefaults-equivalent). After activation the
 * directory + the senior's contacts live here so the app works with no connectivity.
 * Backup is disabled at the app level so this PII is not copied off-device.
 */
class LocalCache(context: Context) {

    private val prefs = context.getSharedPreferences("senior_directory_cache", Context.MODE_PRIVATE)

    fun saveBrands(brands: List<Brand>) =
        prefs.edit().putString(KEY_BRANDS, AppJson.encodeToString(brands)).apply()

    fun loadBrands(): List<Brand> =
        prefs.getString(KEY_BRANDS, null)
            ?.let { runCatching { AppJson.decodeFromString<List<Brand>>(it) }.getOrNull() }
            ?: emptyList()

    fun savePayload(payload: ActivationPayload) =
        prefs.edit().putString(KEY_PAYLOAD, AppJson.encodeToString(payload)).apply()

    fun loadPayload(): ActivationPayload? =
        prefs.getString(KEY_PAYLOAD, null)
            ?.let { runCatching { AppJson.decodeFromString<ActivationPayload>(it) }.getOrNull() }

    fun savePublicKey(key: String) = prefs.edit().putString(KEY_PUBKEY, key).apply()

    fun loadPublicKey(): String? = prefs.getString(KEY_PUBKEY, null)

    private companion object {
        const val KEY_BRANDS = "brands"
        const val KEY_PAYLOAD = "payload"
        const val KEY_PUBKEY = "public_key"
    }
}
