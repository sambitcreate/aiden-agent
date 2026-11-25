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
    case sectionCaption
    case rowTitle
    case rowValue
    case statHero
    case statCaption
    case chipLabel
    case footnote

    /// The Dynamic Type style the step scales with.
    var textStyle: Font.TextStyle {
        switch self {
        case .sectionCaption: .footnote
        case .rowTitle, .rowValue: .body
        case .statHero: .largeTitle
        case .statCaption, .chipLabel: .caption
        case .footnote: .footnote
        }
    }

    var weight: Font.Weight {
        switch self {
        case .statHero: .bold
        case .sectionCaption, .chipLabel: .semibold
        case .rowTitle, .rowValue, .statCaption, .footnote: .regular
        }
    }

    /// The step's size at the default Dynamic Type size, for a given in-app
    /// Text size. The app's body text is `uiFontSize`; every other step keeps
    /// its ratio to it, so the scale never inverts.
    func pointSize(uiFontSize: Int = AidenSettingsTokens.defaultUIFontSize) -> CGFloat {
        let ratio: CGFloat = switch self {
        case .statHero: 34.0 / 14
        case .sectionCaption, .statCaption, .chipLabel, .footnote: 12.0 / 14
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
    /// The leading icon column at the default text size: a plain symbol, never
    /// on a filled tile. It grows with the symbol (`AidenSettingsRow`).
    static let iconColumnWidth: CGFloat = 28
    /// Where the separator under an icon row starts: past the row padding and
    /// the icon column, so it lines up with the title (Android's 56dp).
    static let separatorLeadingInset: CGFloat = rowHPadding + iconColumnWidth + AidenSpacing.m
    /// Where the separator under a text-only row starts: at its title (16dp).
    static let textRowSeparatorInset: CGFloat = rowHPadding
    static let cardRadius: CGFloat = AidenRadius.card
    /// The widest a grouped page's column grows in a regular-width detail pane.
    static let readableWidth: CGFloat = 680
    /// A tap target's least height (HIG).
    static let minimumHitSize: CGFloat = 44
    /// A status chip's padding around its label.
    static let chipHPadding: CGFloat = 7
    static let chipVPadding: CGFloat = 2
    /// The least luminance contrast between a card and the page under it, so a
    /// card always reads as a surface without an outline (one tonal step, as
    /// Android's `surfaceContainer` on `surfaceContainerLow`).
    static let cardToPageContrast = 1.07

    static func cardFillHex(_ palette: AidenPalette) -> String { palette.raisedHex }

    /// The canvas, unless the card would melt into it (Monochrome and Paper
    /// light have a white canvas under white cards); then the sidebar tone,
    /// one step darker.
    static func pageBackgroundHex(_ palette: AidenPalette) -> String {
        let card = cardFillHex(palette)
        if Color.contrastRatio(card, palette.canvasHex) >= cardToPageContrast { return palette.canvasHex }
        return [palette.sidebarHex, Color.mixHex(palette.canvasHex, palette.foregroundHex, fraction: 0.06)]
            .first { Color.contrastRatio(card, $0) >= cardToPageContrast } ?? palette.sidebarHex
    }

    static func cardFill(_ palette: AidenPalette) -> Color { Color(aidenHex: cardFillHex(palette)) }
    static func pageBackground(_ palette: AidenPalette) -> Color { Color(aidenHex: pageBackgroundHex(palette)) }
    /// The hairline between two rows: the secondary ink, softened over the card.
    static func separator(_ palette: AidenPalette) -> Color {
        Color(aidenHex: Color.mixHex(cardFillHex(palette), palette.secondaryHex, fraction: 0.18))
    }
    /// A row under the finger.
    static func pressedFill(_ palette: AidenPalette) -> Color {
        Color(aidenHex: Color.mixHex(cardFillHex(palette), palette.foregroundHex, fraction: 0.08))
    }
    /// A row's disclosure chevron: the secondary ink itself, which holds 3:1
    /// on the card and follows Increase Contrast.
    static func chevron(_ palette: AidenPalette) -> Color { palette.secondary }
}
