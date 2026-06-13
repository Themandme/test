import Foundation
import Combine

/// App-wide state. Owns the local cache and exposes the directory + activation payload
/// to the SwiftUI views. Designed to be fully usable offline once activated.
@MainActor
final class AppState: ObservableObject {
    enum Phase: Equatable {
        case loading
        case needsActivation
        case ready
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var brands: [Brand] = []
    @Published private(set) var payload: ActivationPayload?
    @Published var activationError: String?
    @Published var isActivating = false

    private let cache: LocalCache
    private let api: APIClient

    init(cache: LocalCache, api: APIClient) {
        self.cache = cache
        self.api = api
    }

    var emergencyContact: EmergencyContact? { payload?.emergencyContact }
    var customContacts: [CustomContact] { payload?.customContacts ?? [] }
    var seniorName: String { payload?.seniorProfile.displayName ?? "" }

    /// Called on launch. Loads everything from the local cache first (offline-first),
    /// then tries a best-effort refresh if the network is available.
    func bootstrap() async {
        do {
            brands = try cache.loadBrands()
            payload = try cache.loadPayload()
        } catch {
            // Corrupt cache shouldn't brick the app; fall through to activation/seed.
        }

        // First launch (empty cache): seed the directory from the bundled file so the
        // 50 brands are usable immediately, fully offline.
        if brands.isEmpty {
            brands = SeedData.bundledBrands()
            try? cache.saveBrands(brands)
        }

        phase = payload == nil ? .needsActivation : .ready

        // Opportunistic refresh; failures are non-fatal because we run from cache.
        Task { await refreshBrandsIfPossible() }
    }

    /// Enter the 6-digit code. Fetches + verifies, then caches for offline use.
    func activate(code: String) async {
        isActivating = true
        activationError = nil
        defer { isActivating = false }
        do {
            let publicKey = try await api.fetchSigningKey()
            try cache.savePublicKey(publicKey)

            let payload = try await api.activate(code: code, publicKeyBase64: publicKey)
            try cache.savePayload(payload)

            // Make sure the directory is present even if the first refresh hasn't run.
            if (try? cache.loadBrands())?.isEmpty ?? true {
                let response = try await api.fetchBrands()
                try cache.saveBrands(response.brands)
                brands = response.brands
            }

            self.payload = payload
            phase = .ready
        } catch {
            activationError = (error as? LocalizedError)?.errorDescription ?? "Something went wrong. Please try again."
        }
    }

    private func refreshBrandsIfPossible() async {
        guard let response = try? await api.fetchBrands() else { return }
        try? cache.saveBrands(response.brands)
        brands = response.brands
    }
}
