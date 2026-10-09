import SwiftUI

// Onboarding art in the desktop feature tour's "Snapshot" style: each page shows
// a stylized, cropped slice of the real iOS surface it introduces, tinted with one
// Bot avatar colour mixed into the theme's raised surface. Everything is drawn
// from the active palette, so the art follows light, dark, and every preset, and
// nothing here is a raster image. The vignettes live in AidenOnboardingVignettes.

extension AidenMobileOnboardingPhase {
    /// The Bot avatar colour mixed into this page's art. Each matches the desktop
    /// feature-tour tile the page mirrors (workspace, models, schedules).
    var artTint: AidenBotAvatarColor {
        switch self {
        case .build: .lilac
        case .extend: .periwinkle
        case .control: .mint
        }
    }
}

/// The art's colours: one Bot tint mixed into the palette, as desktop's `--oa-*`
/// variables mix it into the popover surface.
struct AidenOnboardingArtColors: Equatable {
    let isDark: Bool
    let tileHex: String
    let surfaceHex: String
    let fillHex: String
    let inkHex: String
    let tintHex: String

    init(palette: AidenPalette, tint: AidenBotAvatarColor) {
        let tintHex = String(format: "#%06X", tint.rgb)
        let isDark = Self.luminance(palette.canvasHex) < 0.5
        self.isDark = isDark
        self.tintHex = tintHex
        tileHex = Color.mixHex(palette.raisedHex, tintHex, fraction: isDark ? 0.10 : 0.12)
        surfaceHex = Color.mixHex(palette.raisedHex, tintHex, fraction: 0.07)
        fillHex = Color.mixHex(palette.raisedHex, tintHex, fraction: isDark ? 0.20 : 0.28)
        inkHex = Color.mixHex(palette.foregroundHex, tintHex, fraction: isDark ? 0.55 : 0.38)
    }

    /// The page tile behind the vignette.
    var tile: Color { Color(aidenHex: tileHex) }
    /// Cropped app surfaces (screens, lists) sitting on the tile.
    var surface: Color { Color(aidenHex: surfaceHex) }
    /// Bubbles, chips, and tool rows inside a surface.
    var fill: Color { Color(aidenHex: fillHex) }
    /// Skeleton bars that stand in for the title of the thing being shown.
    var ink: Color { Color(aidenHex: inkHex) }
    /// Skeleton bars that stand in for body text.
    var bar: Color { Color(aidenHex: tintHex).opacity(isDark ? 0.50 : 0.58) }
    var softBar: Color { Color(aidenHex: tintHex).opacity(isDark ? 0.28 : 0.34) }
    var surfaceShadow: Color { .black.opacity(isDark ? 0.28 : 0.07) }
    var raisedShadow: Color { .black.opacity(isDark ? 0.40 : 0.12) }

    private static func luminance(_ hex: String) -> Double {
        let value = Int(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0
        let red = Double((value >> 16) & 0xFF) / 255
        let green = Double((value >> 8) & 0xFF) / 255
        let blue = Double(value & 0xFF) / 255
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
}

/// One frame of the art's looping motion, the native counterpart of desktop's
/// `oa-anim-*` vocabulary. The loop rests on the `still` pose for most of its
/// cycle, and Reduce Motion, Low Power Mode, and off-screen pages draw only that
/// pose, so the composition is complete without any animation.
struct AidenOnboardingArtMotion: Equatable {
    struct Reveal: Equatable {
        /// 0 hidden to 1 fully drawn: the width of a typed bar, the rise of a popped row.
        var amount: Double
        var opacity: Double

        static let shown = Reveal(amount: 1, opacity: 1)
    }

    static let cycle: TimeInterval = 7
    /// Where a page joins the loop: after every staggered row has finished
    /// typing, so a page swipes in complete and only retypes after its hold.
    static let entry: TimeInterval = 2.6
    static let still = AidenOnboardingArtMotion(time: nil)

    /// Seconds into the loop, or nil for the still pose.
    let time: TimeInterval?

    static func pose(
        elapsed: TimeInterval,
        isActive: Bool,
        reduceMotion: Bool,
        lowPowerMode: Bool
    ) -> AidenOnboardingArtMotion {
        guard isActive, !reduceMotion, !lowPowerMode else { return .still }
        return AidenOnboardingArtMotion(time: entry + max(0, elapsed))
    }

    var isAnimated: Bool { time != nil }

    /// A bar typing in or a row popping in `delay` seconds into the loop. It holds
    /// from 12% to 86% of the cycle, then fades so the loop can start again.
    func reveal(delay: TimeInterval = 0) -> Reveal {
        guard let local = loopTime(delay: delay, period: Self.cycle) else {
            return time == nil ? .shown : Reveal(amount: 0, opacity: 1)
        }
        let progress = local / Self.cycle
        switch progress {
        case ..<0.12: return Reveal(amount: Self.easeOut(progress / 0.12), opacity: 1)
        case ..<0.86: return .shown
        case ..<0.96: return Reveal(amount: 1, opacity: 1 - (progress - 0.86) / 0.10)
        default: return Reveal(amount: 1, opacity: 0)
        }
    }

    /// A raised card drifting up to 3 pt and back over ten seconds.
    var float: CGFloat {
        guard let local = loopTime(delay: Self.entry, period: 10) else { return 0 }
        let wave = local < 5 ? local / 5 : (10 - local) / 5
        return -3 * CGFloat(Self.easeInOut(wave))
    }

    /// A button pressed once per loop, `delay` seconds after its row appears.
    func press(delay: TimeInterval = 0) -> CGFloat {
        guard let local = loopTime(delay: delay, period: Self.cycle) else { return 1 }
        let progress = local / Self.cycle
        switch progress {
        case 0.52..<0.56: return 1 - 0.06 * CGFloat((progress - 0.52) / 0.04)
        case 0.56..<0.62: return 0.94 + 0.06 * CGFloat((progress - 0.56) / 0.06)
        default: return 1
        }
    }

    /// A status dot breathing every 2.4 seconds: 1 at rest, 0 at its widest.
    var pulse: Double {
        guard let local = loopTime(delay: Self.entry, period: 2.4) else { return 1 }
        return 1 - Self.easeInOut(local < 1.2 ? local / 1.2 : (2.4 - local) / 1.2)
    }

    private func loopTime(delay: TimeInterval, period: TimeInterval) -> TimeInterval? {
        guard let time, time >= delay else { return nil }
        return (time - delay).truncatingRemainder(dividingBy: period)
    }

    private static func easeOut(_ value: Double) -> Double { 1 - pow(1 - value, 3) }
    private static func easeInOut(_ value: Double) -> Double { value * value * (3 - 2 * value) }
}

/// The onboarding page's art tile. It scales one fixed design canvas to whatever
/// width the page gives it, so every device shows the same crop.
struct AidenOnboardingArtwork: View {
    nonisolated static let canvas = CGSize(width: 300, height: 220)

    let phase: AidenMobileOnboardingPhase
    /// Only the visible page animates; the others hold their still pose.
    var isActive = true

    @Environment(\.aidenPalette) private var palette
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.aidenReduceMotion) private var appReduceMotion
    @Environment(\.aidenLowPowerMode) private var lowPowerMode
    /// When this page last became the visible one; nil while it is not.
    @State private var activatedAt: Date?

    private var animates: Bool {
        isActive && !systemReduceMotion && !appReduceMotion && !lowPowerMode
    }

    var body: some View {
        let colors = AidenOnboardingArtColors(palette: palette, tint: phase.artTint)
        let tileShape = RoundedRectangle(cornerRadius: 28, style: .continuous)
        GeometryReader { proxy in
            TimelineView(.animation(minimumInterval: 1 / 30, paused: !animates)) { context in
                vignette(
                    motion: .pose(
                        elapsed: activatedAt.map { context.date.timeIntervalSince($0) } ?? 0,
                        isActive: isActive && activatedAt != nil,
                        reduceMotion: systemReduceMotion || appReduceMotion,
                        lowPowerMode: lowPowerMode
                    )
                )
                .frame(width: Self.canvas.width, height: Self.canvas.height, alignment: .topLeading)
                .scaleEffect(proxy.size.width / Self.canvas.width, anchor: .topLeading)
            }
        }
        .background(colors.tile)
        .clipShape(tileShape)
        .environment(\.aidenOnboardingArtColors, colors)
        .onChange(of: isActive, initial: true) { _, active in
            activatedAt = active ? Date() : nil
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func vignette(motion: AidenOnboardingArtMotion) -> some View {
        switch phase {
        case .build: AidenOnboardingBuildArt(motion: motion)
        case .extend: AidenOnboardingExtendArt(motion: motion)
        case .control: AidenOnboardingControlArt(motion: motion)
        }
    }
}

// MARK: - Art kit

private struct AidenOnboardingArtColorsKey: EnvironmentKey {
    static let defaultValue = AidenOnboardingArtColors(
        palette: AidenThemeCatalog.palette(preset: .aiden, scheme: .light),
        tint: .lilac
    )
}

extension EnvironmentValues {
    var aidenOnboardingArtColors: AidenOnboardingArtColors {
        get { self[AidenOnboardingArtColorsKey.self] }
        set { self[AidenOnboardingArtColorsKey.self] = newValue }
    }
}

/// A skeleton line of text in one of the art's tint tones.
struct OnboardingArtBar: View {
    enum Tone { case regular, soft, ink }

    @Environment(\.aidenOnboardingArtColors) private var colors
    let width: CGFloat
    var tone: Tone = .regular
    var height: CGFloat = 5
    var reveal: AidenOnboardingArtMotion.Reveal = .shown

    var body: some View {
        Capsule()
            .fill(fill)
            .frame(width: width, height: height)
            .scaleEffect(x: reveal.amount, y: 1, anchor: .leading)
            .opacity(reveal.opacity)
    }

    private var fill: Color {
        switch tone {
        case .regular: colors.bar
        case .soft: colors.softBar
        case .ink: colors.ink
        }
    }
}

/// A cropped app surface: a screen, list, or menu laid on the tile at a fixed
/// canvas position. Raised windows (menus, popovers) use the palette's raised
/// surface and a deeper shadow, as desktop's `ArtWindow raised` does.
struct OnboardingArtWindow<Content: View>: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenOnboardingArtColors) private var colors
    let origin: CGPoint
    let width: CGFloat
    var height: CGFloat?
    var raised = false
    var cornerRadius: CGFloat = 14
    var padding: CGFloat = 4
    @ViewBuilder let content: () -> Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        VStack(alignment: .leading, spacing: 0, content: content)
            .padding(padding)
            .frame(width: width, height: height, alignment: .topLeading)
            .background(raised ? palette.raised : colors.surface, in: shape)
            .clipShape(shape)
            .shadow(
                color: raised ? colors.raisedShadow : colors.surfaceShadow,
                radius: raised ? 10 : 4,
                y: raised ? 4 : 1
            )
            .offset(x: origin.x, y: origin.y)
    }
}

/// An SF Symbol at art scale.
struct OnboardingArtSymbol: View {
    let name: String
    var size: CGFloat = 8
    var weight: Font.Weight = .semibold
    var color: Color?

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        Image(systemName: name)
            .font(.system(size: size, weight: weight))
            .foregroundStyle(color ?? palette.secondary)
            .frame(width: size + 3, height: size + 3)
    }
}

/// Text at art scale. Only the few labels that carry meaning are real words;
/// everything else is drawn as `OnboardingArtBar` skeletons.
struct OnboardingArtText: View {
    enum Style { case primary, secondary, tertiary, accent, custom(Color) }

    @Environment(\.aidenPalette) private var palette
    private let text: Text
    private let size: CGFloat
    private let weight: Font.Weight
    private let style: Style
    private let monospaced: Bool

    init(
        _ key: LocalizedStringKey,
        size: CGFloat = 8,
        weight: Font.Weight = .medium,
        style: Style = .secondary,
        monospaced: Bool = false
    ) {
        self.init(text: Text(key), size: size, weight: weight, style: style, monospaced: monospaced)
    }

    init(
        verbatim: String,
        size: CGFloat = 8,
        weight: Font.Weight = .medium,
        style: Style = .secondary,
        monospaced: Bool = false
    ) {
        self.init(text: Text(verbatim: verbatim), size: size, weight: weight, style: style, monospaced: monospaced)
    }

    private init(text: Text, size: CGFloat, weight: Font.Weight, style: Style, monospaced: Bool) {
        self.text = text
        self.size = size
        self.weight = weight
        self.style = style
        self.monospaced = monospaced
    }

    var body: some View {
        text
            .font(.system(size: size, weight: weight, design: monospaced ? .monospaced : .default))
            .foregroundStyle(color)
            .lineLimit(1)
            .fixedSize()
    }

    private var color: Color {
        switch style {
        case .primary: palette.foreground
        case .secondary: palette.secondary
        case .tertiary: palette.secondary.opacity(0.7)
        case .accent: palette.accent
        case .custom(let color): color
        }
    }
}

/// The circular send button of the iOS composer.
struct OnboardingArtSendButton: View {
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        Image(systemName: "arrow.up")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(palette.onAccent)
            .frame(width: 18, height: 18)
            .background(palette.accent, in: Circle())
    }
}

/// A thin separator inset from the leading edge, as iOS lists and menus draw it.
struct OnboardingArtSeparator: View {
    @Environment(\.aidenPalette) private var palette
    var leadingInset: CGFloat = 10

    var body: some View {
        Rectangle()
            .fill(palette.secondary.opacity(0.16))
            .frame(height: 0.5)
            .padding(.leading, leadingInset)
    }
}
