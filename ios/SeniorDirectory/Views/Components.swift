import SwiftUI

/// Prominent, local-only search bar. Filters the cached database instantly; performs
/// NO web requests, so no dangerous search-engine results can ever appear.
struct SearchBar: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass").font(.system(size: 24, weight: .bold))
            TextField("Search", text: $text)
                .font(Theme.Font.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 24))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
        .padding()
        .frame(minHeight: Theme.minTapTarget)
        .background(RoundedRectangle(cornerRadius: Theme.cornerRadius).fill(.quaternary))
    }
}

/// A national-brand button: bold brand-colored text on the brand's signature palette.
/// No logo graphics (trademark-safe). Tapping invokes the safety prompt, never dials
/// directly.
struct BrandButton: View {
    let brand: Brand
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 6) {
                Text(brand.name)
                    .font(Theme.Font.brand)
                    .minimumScaleFactor(0.7)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                if !brand.isDialable {
                    Label("No phone line", systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 14, weight: .bold))
                }
            }
            .foregroundStyle(Color(hex: brand.textColorHex))
            .frame(maxWidth: .infinity, minHeight: 92)
            .padding(8)
            .background(RoundedRectangle(cornerRadius: Theme.cornerRadius).fill(Color(hex: brand.brandColorHex)))
        }
        .accessibilityLabel("\(brand.name)\(brand.isDialable ? "" : ", no phone support")")
    }
}

/// A saved local contact (doctor, pharmacy, bank branch). Dials directly — these are
/// caregiver-entered and trusted, so they skip the brand safety prompt.
struct ContactButton: View {
    let contact: CustomContact

    var body: some View {
        Button { Dialer.call(contact.phone) } label: {
            HStack(spacing: 14) {
                Image(systemName: "phone.fill").font(.system(size: 24))
                VStack(alignment: .leading, spacing: 2) {
                    Text(contact.name).font(Theme.Font.brand)
                    Text(contact.category).font(Theme.Font.body).foregroundStyle(.secondary)
                }
                Spacer()
                Text(contact.phoneDisplay).font(Theme.Font.body).foregroundStyle(.secondary)
            }
            .padding()
            .frame(minHeight: Theme.minTapTarget)
            .background(RoundedRectangle(cornerRadius: Theme.cornerRadius).fill(.quaternary))
        }
        .foregroundStyle(.primary)
    }
}

/// Feature #2 — the always-visible "Call My Person" panic button. Dials the caregiver
/// directly (never 911), giving the senior a daily reason to open the app.
struct PanicButton: View {
    let contact: EmergencyContact

    var body: some View {
        Button { Dialer.call(contact.phone) } label: {
            HStack(spacing: 16) {
                Image(systemName: "phone.fill.arrow.up.right").font(.system(size: 30, weight: .bold))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Call \(contact.name)").font(Theme.Font.brand)
                    Text(contact.relationship.capitalized).font(Theme.Font.body).opacity(0.9)
                }
                Spacer()
            }
            .foregroundStyle(.white)
            .padding()
            .frame(maxWidth: .infinity, minHeight: 80)
            .background(RoundedRectangle(cornerRadius: Theme.cornerRadius).fill(.green))
        }
        .accessibilityLabel("Call \(contact.name), your \(contact.relationship)")
    }
}
