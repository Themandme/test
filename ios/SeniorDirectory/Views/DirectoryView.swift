import SwiftUI

/// The main screen: a prominent local search bar, the "Call My Person" panic button,
/// the senior's saved local contacts, and the grid of national brands.
struct DirectoryView: View {
    @EnvironmentObject var state: AppState
    @State private var query = ""
    @State private var safetyTarget: Brand?

    private let columns = [GridItem(.flexible(), spacing: Theme.gridSpacing),
                           GridItem(.flexible(), spacing: Theme.gridSpacing)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header

                SearchBar(text: $query)

                if let person = state.emergencyContact, query.isEmpty {
                    PanicButton(contact: person)
                }

                if !filteredContacts.isEmpty {
                    section("Your Contacts") {
                        ForEach(filteredContacts) { contact in
                            ContactButton(contact: contact)
                        }
                    }
                }

                section(query.isEmpty ? "Companies" : "Results") {
                    LazyVGrid(columns: columns, spacing: Theme.gridSpacing) {
                        ForEach(filteredBrands) { brand in
                            BrandButton(brand: brand) { safetyTarget = brand }
                        }
                    }
                    if filteredBrands.isEmpty && filteredContacts.isEmpty {
                        Text("No matches. Try a shorter word.")
                            .font(Theme.Font.body)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 24)
                    }
                }
            }
            .padding(Theme.screenPadding)
        }
        // Just-In-Time safety prompt: full-screen, enforced delay, then dial.
        .fullScreenCover(item: $safetyTarget) { brand in
            SafetyPromptView(brand: brand) { safetyTarget = nil }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !state.seniorName.isEmpty {
                Text("Hello, \(state.seniorName)").font(Theme.Font.body).foregroundStyle(.secondary)
            }
            Text("Safe Numbers").font(Theme.Font.title)
        }
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.gridSpacing) {
            Text(title).font(Theme.Font.brand).foregroundStyle(.secondary)
            content()
        }
    }

    // MARK: Local-only filtering (no network, ever)
    private var filteredBrands: [Brand] {
        guard !query.isEmpty else { return state.brands }
        let q = query.lowercased()
        return state.brands.filter {
            $0.name.lowercased().contains(q) || $0.category.lowercased().contains(q)
        }
    }

    private var filteredContacts: [CustomContact] {
        guard !query.isEmpty else { return state.customContacts }
        let q = query.lowercased()
        return state.customContacts.filter {
            $0.name.lowercased().contains(q) || $0.category.lowercased().contains(q)
        }
    }
}
