import Foundation

/// One national brand in the safe directory. Mirrors `data/schema/brand.schema.json`.
/// Decoded with `.convertFromSnakeCase`, so JSON `brand_color_hex` -> `brandColorHex`.
struct Brand: Codable, Identifiable, Hashable {
    enum SupportType: String, Codable {
        case phone
        case onlineOnly = "online_only"
    }

    let id: String
    let name: String
    let category: String
    let supportType: SupportType
    let phone: String?          // E.164, nil for online_only
    let phoneDisplay: String?
    let brandColorHex: String
    let textColorHex: String
    let safetyWarning: String
    let officialUrl: String
    let officialSupportUrl: String
    let verification: Verification

    struct Verification: Codable, Hashable {
        let status: String      // unverified_seed | verified | flagged_stale
        let source: String?
        let verifiedOn: String?
        let verifiedBy: String?
    }

    /// True when the app should DIAL on tap; false brands show the no-phone warning.
    var isDialable: Bool { supportType == .phone && phone != nil }
}

/// Wraps `GET /v1/brands`.
struct BrandsResponse: Codable {
    let schemaVersion: String
    let count: Int
    let categories: [String]
    let brands: [Brand]
}
