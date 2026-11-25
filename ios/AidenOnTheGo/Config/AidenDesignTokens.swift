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

/// The type steps of grouped pages: Settings, Usage, a Bot's profile. Each
/// step is a Dynamic Type text style at the app's own Text size, so the
/// phone's text size and the in-app multiplier (`uiFontSize`) both grow it.
/// Apply one with `.aidenType(_:)`.
enum AidenTypeScale: CaseIterable, Sendable {
    case pageTitle
    case sectionCaption
    case rowTitle
    case rowValue
    case statHero
    case statCaption
    case footnote

    /// The Dynamic Type style the step scales with.
    var textStyle: Font.TextStyle {
        switch self {
        case .pageTitle: .largeTitle
        case .sectionCaption: .footnote
        case .rowTitle, .rowValue: .body
        case .statHero: .largeTitle
        case .statCaption: .caption
        case .footnote: .footnote
        }
    }

    var weight: Font.Weight {
        switch self {
        case .pageTitle, .statHero: .bold
        case .sectionCaption, .rowTitle: .semibold
        case .rowValue, .statCaption, .footnote: .regular
        }
    }

    /// The step's size at the default Dynamic Type size, for a given in-app
    /// Text size. The app's body text is `uiFontSize`; every other step keeps
    /// its ratio to it, so the scale never inverts.
    func pointSize(uiFontSize: Int = AidenSettingsTokens.defaultUIFontSize) -> CGFloat {
        let ratio: CGFloat = switch self {
        case .pageTitle: 2
        case .statHero: 34.0 / 14
        case .sectionCaption, .statCaption, .footnote: 12.0 / 14
        case .rowTitle, .rowValue: 1
        }
        return (CGFloat(uiFontSize) * ratio).rounded()
    }
}

/// The measurements every grouped page shares, after Android's
/// `AidenSettingsDefaults` and the web's `--settings-*` variables.
enum AidenSettingsTokens {
    /// The in-app Text size a fresh install uses (`AidenAppearanceStore.uiFontSize`).
    static let defaultUIFontSize = 14
    static let rowMinHeight: CGFloat = 52
    static let rowHPadding: CGFloat = AidenSpacing.l
    static let rowVPadding: CGFloat = AidenSpacing.s
    /// The leading icon column: a plain symbol, never on a filled tile.
    static let iconColumnWidth: CGFloat = 28
    /// Where a separator between two rows starts: past the row padding and the
    /// icon column, so it lines up with the titles.
    static let separatorLeadingInset: CGFloat = rowHPadding + iconColumnWidth + AidenSpacing.m
    static let cardRadius: CGFloat = AidenRadius.card
    /// The separator's ink over the card.
    static let separatorOpacity = 0.18

    static func cardFill(_ palette: AidenPalette) -> Color { palette.raised }
    static func pageBackground(_ palette: AidenPalette) -> Color { palette.canvas }
}
