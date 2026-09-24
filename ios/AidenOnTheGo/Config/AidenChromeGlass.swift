import SwiftUI

/// Shared chrome glass for compact controls across remote surfaces. Applies
/// interactive Liquid Glass on iOS 26+, an opaque `palette.raised` fill with a
/// hairline stroke under Reduce Transparency, and an ultra-thin material
/// fallback on earlier releases.
struct AidenChromeGlassModifier<GlassShape: InsettableShape>: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var environmentReduceTransparency
    @Environment(\.aidenPalette) private var palette

    let isInteractive: Bool
    let shape: GlassShape
    /// Deterministic override for tests and hosted previews; nil follows the
    /// system Reduce Transparency setting.
    let reduceTransparency: Bool?

    @ViewBuilder
    func body(content: Content) -> some View {
        let reduceTransparency = reduceTransparency ?? environmentReduceTransparency
        if #available(iOS 26, *), !reduceTransparency {
            if isInteractive {
                content.glassEffect(.regular.interactive(), in: shape)
            } else {
                content.glassEffect(.regular, in: shape)
            }
        } else if reduceTransparency {
            content
                .background(palette.raised, in: shape)
                .overlay(shape.stroke(palette.foreground.opacity(0.14), lineWidth: 0.5))
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .overlay(shape.stroke(palette.foreground.opacity(0.10), lineWidth: 0.5))
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
