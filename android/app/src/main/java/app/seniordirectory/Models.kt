package app.seniordirectory

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Shared JSON config: tolerant of extra server/asset keys (e.g. _meta, count). */
val AppJson: Json = Json { ignoreUnknownKeys = true }

@Serializable
data class Brand(
    val id: String,
    val name: String,
    val category: String,
    @SerialName("support_type") val supportType: String,
    val phone: String? = null,
    @SerialName("phone_display") val phoneDisplay: String? = null,
    @SerialName("brand_color_hex") val brandColorHex: String,
    @SerialName("text_color_hex") val textColorHex: String,
    @SerialName("safety_warning") val safetyWarning: String,
    @SerialName("official_url") val officialUrl: String = "",
    @SerialName("official_support_url") val officialSupportUrl: String = "",
) {
    val isDialable: Boolean get() = supportType == "phone" && phone != null
}

/** Matches both GET /v1/brands and the bundled assets/brands.json (extra keys ignored). */
@Serializable
data class BrandsResponse(
    val brands: List<Brand>,
    val categories: List<String> = emptyList(),
)

@Serializable
data class SigningKeyResponse(
    val algorithm: String,
    @SerialName("public_key_b64") val publicKeyB64: String,
)

@Serializable
data class SeniorProfile(@SerialName("display_name") val displayName: String)

@Serializable
data class Limits(@SerialName("max_custom_contacts") val maxCustomContacts: Int? = null)

/** Feature #2 — the "Call My Person" panic-button target. */
@Serializable
data class EmergencyContact(
    val name: String,
    val phone: String,
    @SerialName("phone_display") val phoneDisplay: String,
    val relationship: String,
    @SerialName("photo_url") val photoUrl: String? = null,
)

/** Feature #15 — caregiver-managed local contacts, pre-loaded at signup. */
@Serializable
data class CustomContact(
    val id: String,
    val name: String,
    val phone: String,
    @SerialName("phone_display") val phoneDisplay: String,
    val category: String,
    @SerialName("photo_url") val photoUrl: String? = null,
    val note: String? = null,
)

/** Fetched once from GET /v1/activate/{code}, verified, then cached offline. */
@Serializable
data class ActivationPayload(
    @SerialName("account_id") val accountId: String,
    val tier: String,
    @SerialName("senior_profile") val seniorProfile: SeniorProfile,
    @SerialName("emergency_contact") val emergencyContact: EmergencyContact? = null,
    @SerialName("custom_contacts") val customContacts: List<CustomContact> = emptyList(),
    val limits: Limits,
    @SerialName("issued_at") val issuedAt: String,
    val signature: String,
)
