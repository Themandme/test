import Foundation

/// Response of `GET /v1/signing-key`. Field name must survive `.convertFromSnakeCase`:
/// the JSON key `public_key_b64` decodes to `publicKeyB64` (the "b64" is one token).
struct SigningKeyResponse: Codable, Equatable {
    let algorithm: String
    let publicKeyB64: String
}

/// Thin network client. Used only at activation time and for occasional refreshes —
/// never on the hot path. The directory and contacts run entirely from the local cache.
struct APIClient {
    enum APIError: Error, LocalizedError {
        case badStatus(Int)
        case invalidCode
        case signatureInvalid

        var errorDescription: String? {
            switch self {
            case .badStatus(let code): return "Server error (\(code)). Please try again."
            case .invalidCode: return "That code didn’t work. Please check it and try again."
            case .signatureInvalid: return "We couldn’t safely verify your information. Please try again."
            }
        }
    }

    var baseURL: URL
    var session: URLSession = .shared

    private var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    func fetchBrands() async throws -> BrandsResponse {
        try await get("/v1/brands")
    }

    func fetchSigningKey() async throws -> String {
        let key: SigningKeyResponse = try await get("/v1/signing-key")
        return key.publicKeyB64
    }

    /// Fetches and cryptographically verifies the activation payload.
    func activate(code: String, publicKeyBase64: String) async throws -> ActivationPayload {
        guard code.count == 6, code.allSatisfy(\.isNumber) else { throw APIError.invalidCode }
        let payload: ActivationPayload
        do {
            payload = try await get("/v1/activate/\(code)")
        } catch APIError.badStatus(404) {
            throw APIError.invalidCode
        }
        guard SignatureVerifier.verify(payload, publicKeyBase64: publicKeyBase64) else {
            throw APIError.signatureInvalid
        }
        return payload
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, response) = try await session.data(from: baseURL.appendingPathComponent(path))
        guard let http = response as? HTTPURLResponse else { throw APIError.badStatus(-1) }
        guard (200..<300).contains(http.statusCode) else { throw APIError.badStatus(http.statusCode) }
        return try decoder.decode(T.self, from: data)
    }
}
