import SwiftUI

/// Minimalist activation screen. The ONLY job of this screen is to accept the 6-digit
/// code created on the web. No pricing, no plans, no "subscribe" — App Store 3.1.3.
struct ActivationView: View {
    @EnvironmentObject var state: AppState
    @State private var code = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 28) {
            Spacer()

            Image(systemName: "lock.shield.fill")
                .font(.system(size: 72))
                .foregroundStyle(.tint)

            Text("Welcome")
                .font(Theme.Font.title)

            Text("Enter the 6-digit code from your family member.")
                .font(Theme.Font.body)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal, Theme.screenPadding)

            TextField("000000", text: $code)
                .font(.system(size: 44, weight: .heavy, design: .monospaced))
                .multilineTextAlignment(.center)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .focused($focused)
                .onChange(of: code) { _, new in
                    code = String(new.filter(\.isNumber).prefix(6))
                }
                .padding()
                .background(RoundedRectangle(cornerRadius: Theme.cornerRadius).fill(.quaternary))
                .padding(.horizontal, Theme.screenPadding)

            if let error = state.activationError {
                Text(error)
                    .font(Theme.Font.body)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Theme.screenPadding)
            }

            Button {
                Task { await state.activate(code: code) }
            } label: {
                Group {
                    if state.isActivating { ProgressView().tint(.white) }
                    else { Text("Continue") }
                }
                .font(Theme.Font.brand)
                .frame(maxWidth: .infinity, minHeight: Theme.minTapTarget)
            }
            .buttonStyle(.borderedProminent)
            .disabled(code.count != 6 || state.isActivating)
            .padding(.horizontal, Theme.screenPadding)

            Spacer()
        }
        .onAppear { focused = true }
    }
}
