import SwiftUI

/// The spacing scale. Every gap, inset and padding in new UI comes from here.
enum AidenSpacing {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
    static let xxxl: CGFloat = 32
}

/// Corner radii. Sheets use the system radius, so they have no token.
enum AidenRadius {
    static let control: CGFloat = 16
    static let card: CGFloat = 24
    static let composer: CGFloat = 28
    static let code: CGFloat = 12
}

/// Animation curves. Callers still honour Reduce Motion themselves.
enum AidenMotion {
    static let quick: Animation = .easeOut(duration: 0.15)
    static let standard: Animation = .easeInOut(duration: 0.25)
    static let emphasized: Animation = .spring(response: 0.4, dampingFraction: 0.82)
}
