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

/// A national-brand button: bold brand-colored text on the brand's signature palette,
/// with a gradient, a brand-tinted shadow, and a clear "Tap to call" affordance.
/// No logo graphics (trademark-safe). Tapping invokes the safety prompt, never dials
/// directly.
struct BrandButton: View {
    let brand: Brand
    let onTap: () -> Void

    private var foreground: Color { Color(hex: brand.textColorHex) }

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 10) {
                Text(brand.name)
                    .font(Theme.Font.brand)
                    .minimumScaleFactor(0.7)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                statusPill
            }
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity, minHeight: Theme.tileMinHeight)
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous)
                    .fill(LinearGradient.brand(brand.brandColorHex))
            )
            .overlay(
                // Subtle top highlight gives the flat fill a bit of dimension.
                RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
            )
            .shadow(color: Color(hex: brand.brandColorHex).opacity(0.35), radius: 7, x: 0, y: 4)
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel("\(brand.name)\(brand.isDialable ? "" : ", no phone support")")
    }

    /// A small chip that signals the action ("Tap to call") or the safety state
    /// ("No phone line") for the online-only brands.
    private var statusPill: some View {
        HStack(spacing: 6) {
            Image(systemName: brand.isDialable ? "phone.fill" : "exclamationmark.triangle.fill")
            Text(brand.isDialable ? "Tap to call" : "No phone line")
        }
        .font(Theme.Font.pill)
        .foregroundStyle(foreground)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(foreground.opacity(0.18)))
    }
}

/// A saved local contact (doctor, pharmacy, bank branch). Dials directly — these are
/// caregiver-entered and trusted, so they skip the brand safety prompt.
struct ContactButton: View {
    let contact: CustomContact

    var body: some View {
        Button { Dialer.call(contact.phone) } label: {
            HStack(spacing: 14) {
                Image(systemName: "phone.fill")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(.green)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(Color.green.opacity(0.15)))
                VStack(alignment: .leading, spacing: 2) {
                    Text(contact.name).font(Theme.Font.brand)
                    Text(contact.category).font(Theme.Font.body).foregroundStyle(.secondary)
                }
                Spacer()
                Text(contact.phoneDisplay).font(Theme.Font.body).foregroundStyle(.secondary)
            }
            .padding()
            .frame(minHeight: Theme.minTapTarget)
            .background(RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous).fill(.quaternary))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.06), lineWidth: 1)
            )
        }
        .buttonStyle(PressableButtonStyle())
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
                Image(systemName: "phone.fill.arrow.up.right")
                    .font(.system(size: 26, weight: .bold))
                    .frame(width: 54, height: 54)
                    .background(Circle().fill(Color.white.opacity(0.22)))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Call \(contact.name)").font(Theme.Font.brand)
                    Text(contact.relationship.capitalized).font(Theme.Font.body).opacity(0.95)
                }
                Spacer()
            }
            .foregroundStyle(.white)
            .padding()
            .frame(maxWidth: .infinity, minHeight: 80)
            .background(
                RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous)
                    .fill(LinearGradient(
                        colors: [Color(red: 0.20, green: 0.78, blue: 0.35),
                                 Color(red: 0.13, green: 0.62, blue: 0.27)],
                        startPoint: .top, endPoint: .bottom))
            )
            .shadow(color: Color.green.opacity(0.40), radius: 8, x: 0, y: 4)
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel("Call \(contact.name), your \(contact.relationship)")
    }
}
