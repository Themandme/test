package app.seniordirectory.data

import app.seniordirectory.ActivationPayload
import app.seniordirectory.AppJson
import app.seniordirectory.BrandsResponse
import app.seniordirectory.SigningKeyResponse
import app.seniordirectory.security.SignatureVerifier
import kotlinx.serialization.decodeFromString
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/** User-facing error; [code] is the HTTP status when relevant (-1 otherwise). */
class ApiException(message: String, val code: Int = -1) : Exception(message)

/**
 * Thin network client. Used only at activation time and for occasional refreshes —
 * never on the hot path. The directory and contacts run entirely from the local cache.
 * All calls are blocking; invoke from a background dispatcher.
 */
class ApiClient(private val baseUrl: String) {

    private val client = OkHttpClient.Builder()
        .callTimeout(20, TimeUnit.SECONDS)
        .build()

    fun fetchBrands(): BrandsResponse = get("/v1/brands")

    fun fetchSigningKey(): String = get<SigningKeyResponse>("/v1/signing-key").publicKeyB64

    /** Fetches and cryptographically verifies the activation payload. */
    fun activate(code: String, publicKeyB64: String): ActivationPayload {
        val payload: ActivationPayload = try {
            get("/v1/activate/$code")
        } catch (e: ApiException) {
            if (e.code == 404) {
                throw ApiException("That code didn’t work. Please check it and try again.", 404)
            }
            throw e
        }
        if (!SignatureVerifier.verify(payload, publicKeyB64)) {
            throw ApiException("We couldn’t safely verify your information. Please try again.")
        }
        return payload
    }

    private inline fun <reified T> get(path: String): T {
        val request = Request.Builder().url(baseUrl.trimEnd('/') + path).build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw ApiException("Server error (${response.code}).", response.code)
            return AppJson.decodeFromString(body)
        }
    }
}
