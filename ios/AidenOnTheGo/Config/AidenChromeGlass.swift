import SwiftUI

/// Shared chrome glass for compact controls across remote surfaces. Applies
/// interactive Liquid Glass, or an opaque `palette.raised` fill with a hairline
/// stroke under Reduce Transparency.
struct AidenChromeGlassModifier<GlassShape: InsettableShape>: ViewModifier {
    /// What the chrome renders as, decided from Reduce Transparency alone.
    enum Mode: Equatable {
        case glass(interactive: Bool)
        case opaque
    }

    @Environment(\.accessibilityReduceTransparency) private var environmentReduceTransparency
    @Environment(\.aidenPalette) private var palette

    let isInteractive: Bool
    let shape: GlassShape
    /// Deterministic override for tests and hosted previews; nil follows the
    /// system Reduce Transparency setting.
    let reduceTransparency: Bool?

    static func mode(reduceTransparency: Bool, isInteractive: Bool) -> Mode {
        reduceTransparency ? .opaque : .glass(interactive: isInteractive)
    }

    @ViewBuilder
    func body(content: Content) -> some View {
        switch Self.mode(
            reduceTransparency: reduceTransparency ?? environmentReduceTransparency,
            isInteractive: isInteractive
        ) {
        case .glass(interactive: true):
            content.glassEffect(.regular.interactive(), in: shape)
        case .glass(interactive: false):
            content.glassEffect(.regular, in: shape)
        case .opaque:
            content
                .background(palette.raised, in: shape)
                .overlay(shape.stroke(palette.foreground.opacity(0.14), lineWidth: 0.5))
        }
    }
}

extension View {
    func aidenChromeGlass<GlassShape: InsettableShape>(
        isInteractive: Bool = false,
        in shape: GlassShape,
        reduceTransparency: Bool? = nil
    ) -> some View {
        modifier(AidenChromeGlassModifier(
            isInteractive: isInteractive,
            shape: shape,
            reduceTransparency: reduceTransparency
        ))
    }
}
