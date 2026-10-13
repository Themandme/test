import Foundation

/// Loads the directory bundled with the app (`Resources/brands.json`) so the 50 brands
/// are available on the very first launch, before any network call — the directory is
/// "hardcoded" per the product spec. The server copy is identical and refreshes this
/// opportunistically when online.
///
/// The bundled file is the raw dataset shape `{ "_meta", "categories", "brands" }`,
/// which differs from the API's `BrandsResponse`, so we decode it with its own type.
enum SeedData {
    private struct BundledFile: Decodable {
        let categories: [String]
        let brands: [Brand]
    }

    static func bundledBrands() -> [Brand] {
        guard let url = Bundle.main.url(forResource: "brands", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let file = try? decoder.decode(BundledFile.self, from: data)
        // Never surface a stale-flagged number.
        return (file?.brands ?? []).filter { $0.verification.status != "flagged_stale" }
    }
}
