import Foundation
import CryptoKit

/// Verifies the Ed25519 signature on an `ActivationPayload`.
///
/// The canonical signed string MUST match the backend (`backend/app/signing.py`) byte
/// for byte:
///
///     account_id | tier | issued_at | sha256(contacts_json)
///
/// where `contacts_json` is Python's
/// `json.dumps({"emergency": …, "custom": […]}, sort_keys=True, separators=(",",":"))`.
/// Because that ordering and escaping are fixed, we reproduce it explicitly here rather
/// than relying on Swift's `JSONEncoder` (which does not guarantee key order or Python's
/// escaping). A cross-language conformance test should pin this against the backend.
enum SignatureVerifier {

    static func verify(_ payload: ActivationPayload, publicKeyBase64: String) -> Bool {
        guard payload.signature.hasPrefix("ed25519:"),
              let sigData = Data(base64Encoded: String(payload.signature.dropFirst("ed25519:".count))),
              let pubData = Data(base64Encoded: publicKeyBase64),
              let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: pubData)
        else { return false }

        let message = Data(canonicalString(for: payload).utf8)
        return publicKey.isValidSignature(sigData, for: message)
    }

    static func canonicalString(for p: ActivationPayload) -> String {
        let hash = SHA256.hash(data: Data(contactsJSON(for: p).utf8))
        let hex = hash.map { String(format: "%02x", $0) }.joined()
        return "\(p.accountId)|\(p.tier.rawValue)|\(p.issuedAt)|\(hex)"
    }

    /// Reproduces Python's compact, sorted-key JSON for the contacts block.
    static func contactsJSON(for p: ActivationPayload) -> String {
        let emergency: String
        if let e = p.emergencyContact {
            // keys sorted: name, phone, phone_display, photo_url, relationship
            emergency = "{" + [
                "\"name\":\(jsonString(e.name))",
                "\"phone\":\(jsonString(e.phone))",
                "\"phone_display\":\(jsonString(e.phoneDisplay))",
                "\"photo_url\":\(jsonString(e.photoUrl))",
                "\"relationship\":\(jsonString(e.relationship))",
            ].joined(separator: ",") + "}"
        } else {
            emergency = "null"
        }

        let custom = "[" + p.customContacts.map { c in
            // keys sorted: category, id, name, note, phone, phone_display, photo_url
            "{" + [
                "\"category\":\(jsonString(c.category))",
                "\"id\":\(jsonString(c.id))",
                "\"name\":\(jsonString(c.name))",
                "\"note\":\(jsonString(c.note))",
                "\"phone\":\(jsonString(c.phone))",
                "\"phone_display\":\(jsonString(c.phoneDisplay))",
                "\"photo_url\":\(jsonString(c.photoUrl))",
            ].joined(separator: ",") + "}"
        }.joined(separator: ",") + "]"

        // top-level keys sorted: custom, emergency
        return "{\"custom\":\(custom),\"emergency\":\(emergency)}"
    }

    /// JSON-encodes a value the way Python's `json.dumps(ensure_ascii=True)` does.
    private static func jsonString(_ value: String?) -> String {
        guard let value else { return "null" }
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                // Python ensure_ascii escapes control chars (<0x20) and non-ASCII
                // (>0x7F); 0x7F itself is left as-is. Astral chars (>0xFFFF) would need
                // surrogate-pair encoding — pin with a conformance test if names can
                // contain them.
                if scalar.value < 0x20 || scalar.value > 0x7F {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }
}
