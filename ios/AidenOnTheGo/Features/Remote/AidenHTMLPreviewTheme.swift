import SwiftUI

/// The style sheet an HTML preview starts from, so an unstyled page looks
/// like Aiden. Every rule sits under `:where()`, which has zero specificity:
/// any rule of the page's own, even a bare `body{…}`, wins. The variable names
/// match the desktop's `GENERATIVE_UI_THEME_VARIABLES`, so one instruction to
/// an agent styles a page on both.
///
/// A theme change reloads the preview: callers key the view on this string.
enum AidenHTMLPreviewTheme {
    /// Callers pass `AidenMarkdownMetrics.bodySize(for: dynamicTypeSize)` as `bodySize`.
    static func css(
        palette: AidenPalette,
        colorScheme: ColorScheme,
        uiFont: AidenUIFontID,
        codeFont: AidenCodeFontID,
        bodySize: CGFloat
    ) -> String {
        let fill = palette.accentSolidFill
        let size = "\(bodySize)px"
        let variables = [
            ("--surface-background", palette.canvasHex),
            ("--surface-popover", palette.raisedHex),
            ("--text-primary", palette.foregroundHex),
            ("--text-secondary", palette.secondaryHex),
            ("--border-separator", rgb(palette.foregroundHex, alpha: "0.087")),
            ("--accent", palette.accentHex),
            ("--fill-accent", fill.fillHex),
            ("--fill-accent-foreground", fill.contentHex),
            ("--font-ui-family", family(uiFont)),
            ("--font-code-family", family(codeFont)),
            ("--ui-font-size", size),
        ].map { "\($0.0):\($0.1)" }.joined(separator: ";")
        let scheme = colorScheme == .dark ? "dark" : "light"
        return ":where(:root){\(variables);color-scheme:\(scheme);background:var(--surface-background);"
            + "color:var(--text-primary);font-family:var(--font-ui-family);font-size:\(size);"
            + "-webkit-text-size-adjust:100%}"
            + ":where(body){margin:0;padding:16px}"
            + ":where(a){color:var(--accent)}"
            + ":where(code,kbd,pre,samp){font-family:var(--font-code-family)}"
    }

    private static func family(_ font: AidenUIFontID) -> String {
        switch font {
        case .system: "-apple-system,system-ui,sans-serif"
        case .rounded: "ui-rounded,-apple-system,system-ui,sans-serif"
        case .humanist: "\"Avenir Next\",-apple-system,sans-serif"
        }
    }

    private static func family(_ font: AidenCodeFontID) -> String {
        switch font {
        case .sfMono: "ui-monospace,\"SF Mono\",Menlo,monospace"
        case .menlo: "Menlo,ui-monospace,monospace"
        case .monaco: "Monaco,ui-monospace,monospace"
        }
    }

    /// `#RRGGBB` as CSS `rgb(r g b / alpha)`.
    private static func rgb(_ hex: String, alpha: String) -> String {
        let value = Int(hex.hasPrefix("#") ? String(hex.dropFirst()) : hex, radix: 16) ?? 0
        return "rgb(\((value >> 16) & 0xFF) \((value >> 8) & 0xFF) \(value & 0xFF) / \(alpha))"
    }
}
