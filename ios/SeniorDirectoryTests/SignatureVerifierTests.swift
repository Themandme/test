import XCTest
import CryptoKit
@testable import SeniorDirectory

/// Pins the Swift canonicalizer to the backend byte-for-byte.
///
/// We assert on the SHA-256 of the canonical contacts JSON rather than on the literal
/// string. That is just as strict — if Swift's output differs from Python's by a single
/// byte (e.g. the em-dash escaping, key order, or separators), the hash won't match —
/// and it avoids embedding ambiguous `\u` escapes in source. The expected values are
/// produced by `backend/app/signing.py` for `data/schema/activation_payload.example.json`
/// (regenerate with the snippet in ios/README.md if the example changes).
final class SignatureVerifierTests: XCTestCase {

    // Input data: the `note` / `name` fields hold a REAL em-dash character (U+2014),
    // which Python emits escaped as a `—` sequence under ensure_ascii.
    private let example = ActivationPayload(
        accountId: "acct_8f3c1a92",
        tier: .free,
        seniorProfile: .init(displayName: "Mom"),
        emergencyContact: EmergencyContact(
            name: "David", phone: "+15125550148", phoneDisplay: "(512) 555-0148",
            relationship: "son", photoUrl: nil
        ),
        customContacts: [
            CustomContact(id: "cc_01", name: "Dr. Patel's Office", phone: "+15125550172",
                          phoneDisplay: "(512) 555-0172", category: "Doctor", photoUrl: nil,
                          note: "Front desk \u{2014} ask for Maria"),
            CustomContact(id: "cc_02", name: "Rite Aid Pharmacy", phone: "+15125550199",
                          phoneDisplay: "(512) 555-0199", category: "Pharmacy", photoUrl: nil,
                          note: "On Lamar Blvd"),
            CustomContact(id: "cc_03", name: "First Bank \u{2014} Oak St Branch", phone: "+15125550133",
                          phoneDisplay: "(512) 555-0133", category: "Bank Branch", photoUrl: nil,
                          note: nil),
        ],
        limits: .init(maxCustomContacts: 3),
        issuedAt: "2026-06-13T21:45:00Z",
        signature: "ed25519:PLACEHOLDER"
    )

    private func sha256Hex(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The contacts JSON must hash identically to Python's compact, sorted-key,
    /// ensure_ascii output.
    func testContactsJSONHashMatchesBackend() {
        XCTAssertEqual(
            sha256Hex(SignatureVerifier.contactsJSON(for: example)),
            "8565cac5b88252c7e6360a6d038c632d5f277da142b36887b9a83f0a59d89081"
        )
    }

    /// The full canonical signing string must match `signing.canonical_string(...)`.
    func testCanonicalStringMatchesBackend() {
        XCTAssertEqual(
            SignatureVerifier.canonicalString(for: example),
            "acct_8f3c1a92|free|2026-06-13T21:45:00Z|8565cac5b88252c7e6360a6d038c632d5f277da142b36887b9a83f0a59d89081"
        )
    }
}
