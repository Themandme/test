import XCTest
@testable import SeniorDirectory

/// Regression tests for JSON decoding of server responses. The app uses
/// `.convertFromSnakeCase`, which has non-obvious behavior around tokens like "b64";
/// these pin the field names against the real server payloads.
final class APIDecodingTests: XCTestCase {

    private func snakeCaseDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    func testSigningKeyDecodesPublicKeyField() throws {
        // Exactly what GET /v1/signing-key returns.
        let json = #"{"algorithm":"ed25519","public_key_b64":"AAAA"}"#.data(using: .utf8)!
        let key = try snakeCaseDecoder().decode(SigningKeyResponse.self, from: json)
        XCTAssertEqual(key.algorithm, "ed25519")
        XCTAssertEqual(key.publicKeyB64, "AAAA")   // was silently failing as publicKeyBase64
    }

    func testActivationPayloadDecodesSnakeCaseFields() throws {
        let json = #"""
        {
          "account_id": "acct_1",
          "tier": "free",
          "senior_profile": {"display_name": "Mom"},
          "emergency_contact": {
            "name": "David", "phone": "+15125550148",
            "phone_display": "(512) 555-0148", "relationship": "son", "photo_url": null
          },
          "custom_contacts": [
            {"id":"cc_1","name":"Dr. Patel","phone":"+15125550172",
             "phone_display":"(512) 555-0172","category":"Doctor","photo_url":null,"note":null}
          ],
          "limits": {"max_custom_contacts": 3},
          "issued_at": "2026-06-13T21:45:00+00:00",
          "signature": "ed25519:AAAA"
        }
        """#.data(using: .utf8)!
        let payload = try snakeCaseDecoder().decode(ActivationPayload.self, from: json)
        XCTAssertEqual(payload.accountId, "acct_1")
        XCTAssertEqual(payload.seniorProfile.displayName, "Mom")
        XCTAssertEqual(payload.emergencyContact?.phoneDisplay, "(512) 555-0148")
        XCTAssertEqual(payload.customContacts.first?.id, "cc_1")
        XCTAssertEqual(payload.limits.maxCustomContacts, 3)
    }
}
