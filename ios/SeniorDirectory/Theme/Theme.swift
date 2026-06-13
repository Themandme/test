import SwiftUI

extension Color {
    /// Build a Color from a "#RRGGBB" string (brand palette from the directory).
    init(hex: String) {
        let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        var rgb: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&rgb)
        self.init(
            .sRGB,
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// Senior-first design tokens: large type, big tap targets, high contrast.
enum Theme {
    static let minTapTarget: CGFloat = 64       // generous, well above the 44pt HIG min
    static let cornerRadius: CGFloat = 16
    static let gridSpacing: CGFloat = 14
    static let screenPadding: CGFloat = 20

    enum Font {
        static let title = SwiftUI.Font.system(size: 34, weight: .heavy, design: .rounded)
        static let brand = SwiftUI.Font.system(size: 24, weight: .bold, design: .rounded)
        static let body = SwiftUI.Font.system(size: 22, weight: .semibold, design: .rounded)
        static let warning = SwiftUI.Font.system(size: 28, weight: .bold, design: .rounded)
        static let search = SwiftUI.Font.system(size: 24, weight: .medium, design: .rounded)
    }
}
