package app.seniordirectory

import app.seniordirectory.security.SignatureVerifier
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Cross-language conformance: the canonical signing string MUST match the Python backend
 * (and the iOS verifier) byte for byte, or signature verification fails on device.
 *
 * The golden value is produced by backend/app/signing.canonical_string for the same
 * payload — if you change the canonical format, regenerate it on all three platforms.
 */
class SignatureVerifierTest {

    private val payload = ActivationPayload(
        accountId = "acct_test",
        tier = "free",
        seniorProfile = SeniorProfile("Mom"),
        emergencyContact = EmergencyContact(
            name = "David",
            phone = "+15125550148",
            phoneDisplay = "(512) 555-0148",
            relationship = "son",
            photoUrl = null,
        ),
        customContacts = listOf(
            CustomContact(
                id = "cc_1",
                name = "Dr. Patel",
                phone = "+15125550172",
                phoneDisplay = "(512) 555-0172",
                category = "Doctor",
                photoUrl = null,
                note = null,
            ),
        ),
        limits = Limits(maxCustomContacts = 3),
        issuedAt = "2026-06-14T00:00:00+00:00",
        signature = "ed25519:unused",
    )

    @Test
    fun canonicalStringMatchesBackend() {
        val expected =
            "acct_test|free|2026-06-14T00:00:00+00:00|" +
                "daa1bf208a69384dd6e7d25daa0c6faa98d190f64ce6b135f9b5303aec33ffa0"
        assertEquals(expected, SignatureVerifier.canonicalString(payload))
    }

    @Test
    fun contactsJsonHasSortedKeysAndCompactSeparators() {
        val json = SignatureVerifier.contactsJson(payload)
        // top-level order custom,emergency; nested keys alphabetical; no spaces.
        assertEquals(true, json.startsWith("{\"custom\":[{\"category\":"))
        assertEquals(true, json.contains("\"emergency\":{\"name\":\"David\""))
        assertEquals(false, json.contains(", "))
    }
}
