import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Hands an E.164 number to the native iOS dialer. The app never places calls itself;
/// it only opens `tel:` so the system Phone app takes over.
enum Dialer {
    static func call(_ e164: String) {
        #if canImport(UIKit)
        guard let url = URL(string: "tel://\(sanitize(e164))"),
              UIApplication.shared.canOpenURL(url) else { return }
        UIApplication.shared.open(url)
        #endif
    }

    /// Keep digits and a single leading '+'. Defensive against stray formatting.
    static func sanitize(_ number: String) -> String {
        let hasPlus = number.hasPrefix("+")
        let digits = number.filter(\.isNumber)
        return hasPlus ? "+" + digits : digits
    }
}
