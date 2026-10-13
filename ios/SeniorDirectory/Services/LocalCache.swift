import Foundation
import GRDB

/// Offline SQLite cache (GRDB). After activation, the directory + the senior's contacts
/// live here so the app works with zero connectivity — the senior is never cut off.
///
/// Two stores:
///  - `brands`  : the 50 national brands (refreshed opportunistically when online)
///  - `payload` : the single signed activation payload (one row), kept verbatim so the
///                signature can be re-checked on load.
final class LocalCache {
    private let dbQueue: DatabaseQueue

    init(path: String) throws {
        dbQueue = try DatabaseQueue(path: path)
        try migrator.migrate(dbQueue)
    }

    /// Default location in Application Support.
    static func makeDefault() throws -> LocalCache {
        let dir = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        return try LocalCache(path: dir.appendingPathComponent("senior_directory.sqlite").path)
    }

    private var migrator: DatabaseMigrator {
        var m = DatabaseMigrator()
        m.registerMigration("v1") { db in
            try db.create(table: "brand") { t in
                t.column("id", .text).primaryKey()
                t.column("json", .blob).notNull()       // verbatim Brand JSON
                t.column("sort", .integer).notNull()     // preserve dataset order
            }
            try db.create(table: "kv") { t in
                t.column("key", .text).primaryKey()
                t.column("value", .blob).notNull()
            }
        }
        return m
    }

    // MARK: Brands
    func saveBrands(_ brands: [Brand]) throws {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        try dbQueue.write { db in
            try db.execute(sql: "DELETE FROM brand")
            for (i, brand) in brands.enumerated() {
                let json = try encoder.encode(brand)
                try db.execute(
                    sql: "INSERT INTO brand (id, json, sort) VALUES (?, ?, ?)",
                    arguments: [brand.id, json, i]
                )
            }
        }
    }

    func loadBrands() throws -> [Brand] {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try dbQueue.read { db in
            let rows = try Row.fetchAll(db, sql: "SELECT json FROM brand ORDER BY sort")
            return try rows.map { try decoder.decode(Brand.self, from: $0["json"]) }
        }
    }

    // MARK: Activation payload
    func savePayload(_ payload: ActivationPayload) throws {
        let json = try JSONEncoder.snakeCase.encode(payload)
        try setKV("activation_payload", json)
    }

    func loadPayload() throws -> ActivationPayload? {
        guard let data = try getKV("activation_payload") else { return nil }
        return try JSONDecoder.snakeCase.decode(ActivationPayload.self, from: data)
    }

    func savePublicKey(_ base64: String) throws { try setKV("signing_public_key", Data(base64.utf8)) }
    func loadPublicKey() throws -> String? {
        guard let d = try getKV("signing_public_key") else { return nil }
        return String(data: d, encoding: .utf8)
    }

    func clear() throws {
        try dbQueue.write { db in
            try db.execute(sql: "DELETE FROM brand")
            try db.execute(sql: "DELETE FROM kv")
        }
    }

    // MARK: KV helpers
    private func setKV(_ key: String, _ value: Data) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                arguments: [key, value]
            )
        }
    }

    private func getKV(_ key: String) throws -> Data? {
        try dbQueue.read { db in
            try Row.fetchOne(db, sql: "SELECT value FROM kv WHERE key = ?", arguments: [key])?["value"]
        }
    }
}

private extension JSONEncoder {
    static var snakeCase: JSONEncoder {
        let e = JSONEncoder(); e.keyEncodingStrategy = .convertToSnakeCase; return e
    }
}
private extension JSONDecoder {
    static var snakeCase: JSONDecoder {
        let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase; return d
    }
}
