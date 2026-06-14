import SwiftUI

extension Color {
    /// Build a Color from a "#RRGGBB" string (brand palette from the directory).
    init(hex: String) {
        let (r, g, b) = Color.rgbComponents(hex: hex)
        self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }

    /// Parse "#RRGGBB" into 0...1 sRGB components.
    static func rgbComponents(hex: String) -> (Double, Double, Double) {
        let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        var rgb: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&rgb)
        return (
            Double((rgb >> 16) & 0xFF) / 255,
            Double((rgb >> 8) & 0xFF) / 255,
            Double(rgb & 0xFF) / 255
        )
    }

    /// The same brand color scaled toward black (`scale` < 1) for gradient depth.
    static func brand(_ hex: String, scale: Double = 1.0) -> Color {
        let (r, g, b) = rgbComponents(hex: hex)
        return Color(.sRGB, red: r * scale, green: g * scale, blue: b * scale, opacity: 1)
    }
}

/// A top-to-bottom gradient of a brand's signature color, for tile depth.
extension LinearGradient {
    static func brand(_ hex: String) -> LinearGradient {
        LinearGradient(
            colors: [Color(hex: hex), Color.brand(hex, scale: 0.80)],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

/// Gentle scale-down while pressed — makes the big buttons feel tappable.
struct PressableButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.65), value: configuration.isPressed)
    }
}

/// Senior-first design tokens: large type, big tap targets, high contrast.
enum Theme {
    static let minTapTarget: CGFloat = 64       // generous, well above the 44pt HIG min
    static let cornerRadius: CGFloat = 16
    static let tileMinHeight: CGFloat = 104
    static let gridSpacing: CGFloat = 14
    static let screenPadding: CGFloat = 20

    enum Font {
        static let title = SwiftUI.Font.system(size: 34, weight: .heavy, design: .rounded)
        static let brand = SwiftUI.Font.system(size: 24, weight: .bold, design: .rounded)
        static let body = SwiftUI.Font.system(size: 22, weight: .semibold, design: .rounded)
        static let warning = SwiftUI.Font.system(size: 28, weight: .bold, design: .rounded)
        static let search = SwiftUI.Font.system(size: 24, weight: .medium, design: .rounded)
        static let pill = SwiftUI.Font.system(size: 14, weight: .bold, design: .rounded)
    }
}
