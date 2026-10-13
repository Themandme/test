import SwiftUI

/// Just-In-Time safety prompt. Full-screen, brand-colored, with an enforced 3-second
/// delay before the "Call" button becomes tappable so the warning is actually read.
///
/// For `online_only` brands (no phone support), there is NO call button at all — the
/// screen exists purely to tell the senior that any "support number" is a scam.
struct SafetyPromptView: View {
    let brand: Brand
    let onDismiss: () -> Void

    private let delaySeconds = 3
    @State private var remaining: Int
    @State private var timer: Timer?

    init(brand: Brand, onDismiss: @escaping () -> Void) {
        self.brand = brand
        self.onDismiss = onDismiss
        _remaining = State(initialValue: brand.isDialable ? 3 : 0)
    }

    private var canCall: Bool { brand.isDialable && remaining == 0 }

    var body: some View {
        ZStack {
            Color(hex: brand.brandColorHex).ignoresSafeArea()

            VStack(spacing: 28) {
                Spacer()

                Image(systemName: brand.isDialable ? "exclamationmark.shield.fill" : "hand.raised.fill")
                    .font(.system(size: 64, weight: .bold))

                Text(brand.name).font(Theme.Font.title)

                Text(brand.safetyWarning)
                    .font(Theme.Font.warning)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Theme.screenPadding)

                Spacer()

                if brand.isDialable {
                    Button {
                        onDismiss()
                        Dialer.call(brand.phone ?? "")
                    } label: {
                        Text(canCall ? "Call \(brand.phoneDisplay ?? "")" : "Please read… \(remaining)")
                            .font(Theme.Font.brand)
                            .frame(maxWidth: .infinity, minHeight: Theme.minTapTarget)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.white)
                    .foregroundStyle(Color(hex: brand.brandColorHex))
                    .disabled(!canCall)
                    .padding(.horizontal, Theme.screenPadding)
                } else {
                    Text("This company has no phone support.\nAnyone who gives you a number for them is a scammer.")
                        .font(Theme.Font.body)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, Theme.screenPadding)
                        .opacity(0.95)
                }

                Button("Go Back", action: dismiss)
                    .font(Theme.Font.body)
                    .frame(minHeight: Theme.minTapTarget)

                Spacer().frame(height: 12)
            }
            .foregroundStyle(Color(hex: brand.textColorHex))
        }
        .onAppear(perform: startCountdown)
        .onDisappear { timer?.invalidate() }
    }

    private func startCountdown() {
        guard brand.isDialable else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { t in
            if remaining > 0 { remaining -= 1 } else { t.invalidate() }
        }
    }

    private func dismiss() {
        timer?.invalidate()
        onDismiss()
    }
}
