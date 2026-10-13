import SwiftUI

/// App entry point. Wires the local cache + API client into `AppState` and routes
/// between activation and the directory.
@main
struct SeniorDirectoryApp: App {
    @StateObject private var state: AppState

    init() {
        // In production, baseURL comes from the build configuration.
        let api = APIClient(baseURL: AppConfig.apiBaseURL)
        let cache = (try? LocalCache.makeDefault()) ?? LocalCache.inMemoryFallback()
        _state = StateObject(wrappedValue: AppState(cache: cache, api: api))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .task { await state.bootstrap() }
        }
    }
}

enum AppConfig {
    /// Override per-scheme with an xcconfig / Info.plist value in a real project.
    static var apiBaseURL: URL {
        URL(string: Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String
            ?? "https://api.senior-directory.app")!
    }
}

private extension LocalCache {
    /// Last-resort in-memory cache so a filesystem failure never bricks the app.
    static func inMemoryFallback() -> LocalCache {
        // GRDB supports ":memory:"; activation just won't persist across launches.
        (try? LocalCache(path: ":memory:"))!
    }
}

struct RootView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        switch state.phase {
        case .loading:
            ProgressView().scaleEffect(1.6)
        case .needsActivation:
            ActivationView()
        case .ready:
            DirectoryView()
        }
    }
}
