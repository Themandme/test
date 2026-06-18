package app.seniordirectory.security

import android.util.Base64
import app.seniordirectory.ActivationPayload
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.MessageDigest

/**
 * Verifies the Ed25519 signature on an ActivationPayload.
 *
 * The canonical signed string MUST match the backend (backend/app/signing.py) and the
 * iOS verifier byte for byte:
 *
 *     account_id | tier | issued_at | sha256(contacts_json)
 *
 * where contacts_json is Python's
 *   json.dumps({"emergency": …, "custom": […]}, sort_keys=True, separators=(",",":"))
 * with ensure_ascii=True. We reproduce that ordering/escaping explicitly rather than
 * relying on a JSON encoder (which doesn't guarantee key order or Python's escaping).
 */
object SignatureVerifier {

    fun verify(payload: ActivationPayload, publicKeyB64: String): Boolean {
        if (!payload.signature.startsWith("ed25519:")) return false
        return try {
            val sig = Base64.decode(payload.signature.removePrefix("ed25519:"), Base64.DEFAULT)
            val pub = Base64.decode(publicKeyB64, Base64.DEFAULT)
            val signer = Ed25519Signer().apply { init(false, Ed25519PublicKeyParameters(pub, 0)) }
            val msg = canonicalString(payload).toByteArray(Charsets.UTF_8)
            signer.update(msg, 0, msg.size)
            signer.verifySignature(sig)
        } catch (e: Exception) {
            false
        }
    }

    fun canonicalString(p: ActivationPayload): String {
        val hash = sha256Hex(contactsJson(p))
        return "${p.accountId}|${p.tier}|${p.issuedAt}|$hash"
    }

    /** Reproduces Python's compact, sorted-key JSON for the contacts block. */
    fun contactsJson(p: ActivationPayload): String {
        val emergency = p.emergencyContact?.let { e ->
            // keys sorted: name, phone, phone_display, photo_url, relationship
            "{" + listOf(
                "\"name\":${jsonString(e.name)}",
                "\"phone\":${jsonString(e.phone)}",
                "\"phone_display\":${jsonString(e.phoneDisplay)}",
                "\"photo_url\":${jsonString(e.photoUrl)}",
                "\"relationship\":${jsonString(e.relationship)}",
            ).joinToString(",") + "}"
        } ?: "null"

        val custom = "[" + p.customContacts.joinToString(",") { c ->
            // keys sorted: category, id, name, note, phone, phone_display, photo_url
            "{" + listOf(
                "\"category\":${jsonString(c.category)}",
                "\"id\":${jsonString(c.id)}",
                "\"name\":${jsonString(c.name)}",
                "\"note\":${jsonString(c.note)}",
                "\"phone\":${jsonString(c.phone)}",
                "\"phone_display\":${jsonString(c.phoneDisplay)}",
                "\"photo_url\":${jsonString(c.photoUrl)}",
            ).joinToString(",") + "}"
        } + "]"

        // top-level keys sorted: custom, emergency
        return "{\"custom\":$custom,\"emergency\":$emergency}"
    }

    /** JSON-encodes a value the way Python's json.dumps(ensure_ascii=True) does. */
    private fun jsonString(value: String?): String {
        if (value == null) return "null"
        val sb = StringBuilder("\"")
        for (ch in value) {
            when (ch.code) {
                0x22 -> sb.append("\\\"")   // "
                0x5C -> sb.append("\\\\")   // backslash
                0x08 -> sb.append("\\b")
                0x09 -> sb.append("\\t")
                0x0A -> sb.append("\\n")
                0x0C -> sb.append("\\f")
                0x0D -> sb.append("\\r")
                else ->
                    // ensure_ascii escapes control chars (<0x20) and non-ASCII (>0x7F).
                    // Iterating UTF-16 chars reproduces Python's surrogate-pair escaping.
                    if (ch.code < 0x20 || ch.code > 0x7F) {
                        sb.append("\\u").append(ch.code.toString(16).padStart(4, '0'))
                    } else {
                        sb.append(ch)
                    }
            }
        }
        return sb.append("\"").toString()
    }

    private fun sha256Hex(s: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }
}
