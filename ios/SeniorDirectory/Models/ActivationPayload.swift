import Foundation

/// The per-senior config fetched once from `GET /v1/activate/{code}` and cached
/// offline. Mirrors `data/schema/activation_payload.schema.json`.
struct ActivationPayload: Codable, Equatable {
    let accountId: String
    let tier: Tier
    let seniorProfile: SeniorProfile
    let emergencyContact: EmergencyContact?
    let customContacts: [CustomContact]
    let limits: Limits
    let issuedAt: String        // exact ISO string that was signed
    let signature: String

    enum Tier: String, Codable { case free, premium }

    struct SeniorProfile: Codable, Equatable {
        let displayName: String
    }

    struct Limits: Codable, Equatable {
        let maxCustomContacts: Int?   // nil = unlimited (premium)
    }
}

/// Feature #2 — the "Call My Person" panic-button target.
struct EmergencyContact: Codable, Equatable, Hashable {
    let name: String
    let phone: String           // E.164
    let phoneDisplay: String
    let relationship: String
    let photoUrl: String?
}

/// Feature #15 — caregiver-managed local contacts, pre-loaded at signup.
struct CustomContact: Codable, Equatable, Hashable, Identifiable {
    let id: String
    let name: String
    let phone: String           // E.164
    let phoneDisplay: String
    let category: String
    let photoUrl: String?
    let note: String?
}
