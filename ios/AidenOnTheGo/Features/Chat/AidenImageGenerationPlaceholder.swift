import SwiftUI
import UIKit

/// The "Lens" scan placeholder shown while a `generate_image` call runs, and the
/// one-shot arrival reveal over the delivered image. The numbers mirror the
/// desktop spec module `renderer/shared/image-generation/placeholder-spec.ts`;
/// change them there and in Android's `AidenImageGenerationPlaceholder.kt` together.
enum AidenImagePlaceholderSpec {
    static let dotPitch: CGFloat = 12
    static let dimDotRadius: CGFloat = 1
    static let litDotRadius: CGFloat = 1.1
    /// Lens window height as a fraction of the placeholder height.
    static let lensHeightFraction: CGFloat = 0.34
    static let period: TimeInterval = 2.8
    /// After `longRunAfter` seconds the pass slows and the caption says "Still generating".
    static let longPeriod: TimeInterval = 5.2
    static let longRunAfter: TimeInterval = 60
    /// The lens travels during the first 78% of a period, then rests.
    static let travelFraction = 0.78
    static let travelEase = (0.55, 0.06, 0.3, 1.0)
    /// Still pose (Reduce Motion, Low Power Mode): the lens window's top sits at
    /// 80% of its own height, so the lens rests around 40% of the placeholder.
    static let stillLensTopFraction: CGFloat = 0.8
    static let edgeGlowRadius: CGFloat = 10
    static let edgeInsetFraction: CGFloat = 0.06
    static let arrivalDuration: TimeInterval = 0.72
    static let arrivalEase = (0.65, 0.05, 0.25, 1.0)
    static let reducedArrivalDuration: TimeInterval = 0.26
    static let cornerRadius = AidenInlineCardDeckLayout.singleImageCornerRadius

    static func period(elapsed: TimeInterval) -> TimeInterval {
        elapsed >= longRunAfter ? longPeriod : period
    }

    /// "Generating · 12s", then "Still generating · 1m 05s" after a minute.
    static func caption(elapsed: TimeInterval) -> String {
        let seconds = elapsed.isFinite ? max(0, Int(elapsed.rounded(.down))) : 0
        guard seconds >= Int(longRunAfter) else { return "Generating · \(seconds)s" }
        return "Still generating · \(seconds / 60)m \(String(format: "%02d", seconds % 60))s"
    }

    /// Lens travel progress (0 at the top, 1 past the bottom) for a phase in [0, 1).
    static func lensProgress(phase: Double) -> Double {
        let clamped = min(max(phase, 0), 1)
        guard clamped < travelFraction else { return 1 }
        let (x1, y1, x2, y2) = travelEase
        return cubicBezier(clamped / travelFraction, x1, y1, x2, y2)
    }

    /// Top of the lens window in points: just above the placeholder at
    /// progress 0, just below it at progress 1.
    static func lensTop(progress: Double, height: CGFloat) -> CGFloat {
        let lens = height * lensHeightFraction
        return -lens + CGFloat(progress) * (height + lens)
    }

    static func stillLensTop(height: CGFloat) -> CGFloat {
        height * lensHeightFraction * stillLensTopFraction
    }

    /// CSS-style `cubic-bezier(x1, y1, x2, y2)` evaluated at `x`.
    static func cubicBezier(_ x: Double, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> Double {
        if x <= 0 { return 0 }
        if x >= 1 { return 1 }
        func sample(_ t: Double, _ a: Double, _ b: Double) -> Double {
            let u = 1 - t
            return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
        }
        var low = 0.0, high = 1.0, t = x
        for _ in 0..<24 {
            let value = sample(t, x1, x2)
            if abs(value - x) < 1e-6 { break }
            if value < x { low = t } else { high = t }
            t = (low + high) / 2
        }
        return sample(t, y1, y2)
    }
}

/// The shapes `generate_image` accepts (desktop `IMAGE_ASPECT_RATIOS`).
enum AidenImageAspectRatio: String, CaseIterable, Equatable, Sendable {
    case square = "1:1"
    case landscape16x9 = "16:9"
    case portrait9x16 = "9:16"
    case landscape4x3 = "4:3"
    case portrait3x4 = "3:4"
    case landscape3x2 = "3:2"
    case portrait2x3 = "2:3"

    /// The host projects only the requested ratio into the step's `detail`;
    /// anything else (or none) falls back to square.
    init(detail: String?) {
        self = detail.flatMap(Self.init(rawValue:)) ?? .square
    }

    /// Width over height.
    var value: CGFloat {
        let parts = rawValue.split(separator: ":").compactMap { Double($0) }
        return CGFloat(parts[0] / parts[1])
    }

    /// Display width cap, matching the desktop slots.
    var maxWidth: CGFloat {
        switch self {
        case .landscape16x9, .landscape3x2: 360
        case .landscape4x3: 340
        case .square: 300
        case .portrait3x4: 240
        case .portrait2x3: 220
        case .portrait9x16: 190
        }
    }
}

enum AidenImagePlaceholderMotion: Equatable {
    case animated
    case still

    static func resolve(reduceMotion: Bool, lowPowerMode: Bool) -> Self {
        reduceMotion || lowPowerMode ? .still : .animated
    }
}

struct AidenImageGenerationPlaceholderItem: Equatable, Identifiable {
    let id: String
    let aspectRatio: AidenImageAspectRatio
    /// Host time of the step's last status change (when it started running).
    let runningSince: Date
}

enum AidenImageGenerationPlaceholderState {
    static let toolName = "generate_image"

    /// One placeholder per `generate_image` call that is running, or that
    /// finished while the turn is still streaming: the image itself reaches the
    /// phone with the settled message, so the placeholder holds until then.
    /// Calls waiting for approval, failed, denied or cancelled show none.
    static func items(_ timeline: AidenGenerationTimeline?) -> [AidenImageGenerationPlaceholderItem] {
        guard let timeline, timeline.status == .running else { return [] }
        return timeline.steps.compactMap { step in
            guard isGenerateImage(step), step.status == .running || step.status == .completed else { return nil }
            return AidenImageGenerationPlaceholderItem(
                id: step.toolCallId ?? step.id,
                aspectRatio: AidenImageAspectRatio(detail: step.detail),
                runningSince: Date(timeIntervalSince1970: step.updatedAt / 1_000)
            )
        }
    }

    /// The generation whose settled image should play the arrival reveal: one
    /// where this phone watched a `generate_image` call run.
    static func arrivalRevealGenerationID(_ timeline: AidenGenerationTimeline?) -> String? {
        guard let timeline else { return nil }
        let watched = timeline.steps.contains { step in
            isGenerateImage(step) && (step.status == .running || step.status == .completed)
        }
        return watched ? timeline.generationId : nil
    }

    private static func isGenerateImage(_ step: AidenAgentStep) -> Bool {
        step.kind == .tool && step.toolName == toolName
    }
}

/// A 12 pt tile with one centred dot, drawn once per radius and tinted with
/// `foregroundStyle`; tiling it is the static dot grid.
private enum AidenDotTile {
    @MainActor private static var cache: [CGFloat: UIImage] = [:]

    @MainActor static func image(radius: CGFloat) -> UIImage {
        if let cached = cache[radius] { return cached }
        let pitch = AidenImagePlaceholderSpec.dotPitch
        let image = UIGraphicsImageRenderer(size: CGSize(width: pitch, height: pitch)).image { context in
            UIColor.black.setFill()
            context.cgContext.fillEllipse(in: CGRect(
                x: pitch / 2 - radius, y: pitch / 2 - radius, width: radius * 2, height: radius * 2
            ))
        }.withRenderingMode(.alwaysTemplate)
        cache[radius] = image
        return image
    }
}

private struct AidenDotGrid: View {
    let radius: CGFloat
    let color: Color

    var body: some View {
        Image(uiImage: AidenDotTile.image(radius: radius))
            .resizable(resizingMode: .tile)
            .foregroundStyle(color)
    }
}

/// Theme-derived colours, following the desktop light/dark tokens.
private struct AidenScanColors {
    let fill: Color
    let dot: Color
    let litDot: Color
    let beam: Color
    let vignette: Color
    let edge: Color

    init(palette: AidenPalette, scheme: ColorScheme) {
        let dark = scheme == .dark
        fill = palette.foreground.opacity(dark ? 0.06 : 0.07)
        dot = palette.foreground.opacity(dark ? 0.10 : 0.16)
        litDot = palette.foreground.opacity(dark ? 0.62 : 0.55)
        beam = dark ? palette.foreground.opacity(0.075) : Color.white.opacity(0.55)
        vignette = dark ? Color.black.opacity(0.18) : palette.foreground.opacity(0.05)
        edge = palette.accent
    }
}

/// The static layers: canvas-backed fill, dim dot grid and vignette.
private struct AidenScanBase: View {
    @Environment(\.aidenPalette) private var palette
    let colors: AidenScanColors

    var body: some View {
        ZStack {
            palette.canvas
            colors.fill
            AidenDotGrid(radius: AidenImagePlaceholderSpec.dimDotRadius, color: colors.dot)
            EllipticalGradient(
                stops: [.init(color: .clear, location: 0.55), .init(color: colors.vignette, location: 1)],
                center: UnitPoint(x: 0.5, y: 0.4),
                startRadiusFraction: 0,
                endRadiusFraction: 0.85
            )
        }
    }
}

private struct AidenScanEdge: View {
    let color: Color

    var body: some View {
        LinearGradient(
            stops: [
                .init(color: .clear, location: 0),
                .init(color: color, location: 0.22),
                .init(color: color, location: 0.78),
                .init(color: .clear, location: 1),
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
        .frame(height: 1)
        .opacity(0.85)
        .shadow(color: color.opacity(0.45), radius: AidenImagePlaceholderSpec.edgeGlowRadius / 2)
    }
}

/// The moving lens over a placeholder of `size`, with its window top at `top`.
private struct AidenScanLens: View {
    let size: CGSize
    let top: CGFloat
    let colors: AidenScanColors

    var body: some View {
        let lensHeight = size.height * AidenImagePlaceholderSpec.lensHeightFraction
        ZStack(alignment: .top) {
            ZStack(alignment: .top) {
                LinearGradient(colors: [.clear, colors.beam], startPoint: .top, endPoint: .bottom)
                // Counter-translated so the bright dots stay put and light up under the lens.
                AidenDotGrid(radius: AidenImagePlaceholderSpec.litDotRadius, color: colors.litDot)
                    .frame(width: size.width, height: size.height)
                    .offset(y: -top)
            }
            .frame(width: size.width, height: lensHeight, alignment: .top)
            .clipped()
            .mask {
                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .black, location: 0.7),
                        .init(color: .black, location: 0.96),
                        .init(color: .clear, location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            AidenScanEdge(color: colors.edge)
                .padding(.horizontal, size.width * AidenImagePlaceholderSpec.edgeInsetFraction)
                .offset(y: lensHeight - 1)
        }
        .frame(width: size.width, height: lensHeight, alignment: .top)
        .offset(y: top)
        .frame(width: size.width, height: size.height, alignment: .top)
    }
}

/// Live placeholder for one running `generate_image` call.
struct AidenImageGenerationPlaceholderView: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenLowPowerMode) private var lowPowerMode
    @Environment(\.scenePhase) private var scenePhase
    let item: AidenImageGenerationPlaceholderItem
    /// The first observed start; a later status change must not restart the clock.
    @State private var since: Date?
    @State private var livePulse = false

    var body: some View {
        let motion = AidenImagePlaceholderMotion.resolve(reduceMotion: reduceMotion, lowPowerMode: lowPowerMode)
        let start = since ?? item.runningSince
        let colors = AidenScanColors(palette: palette, scheme: colorScheme)
        VStack(alignment: .leading, spacing: 7) {
            GeometryReader { proxy in
                ZStack(alignment: .topTrailing) {
                    AidenScanBase(colors: colors)
                    if motion == .still {
                        AidenScanLens(
                            size: proxy.size,
                            top: AidenImagePlaceholderSpec.stillLensTop(height: proxy.size.height),
                            colors: colors
                        )
                    } else {
                        TimelineView(.animation(minimumInterval: 1 / 60, paused: scenePhase != .active)) { context in
                            let elapsed = context.date.timeIntervalSince(start)
                            let period = AidenImagePlaceholderSpec.period(elapsed: elapsed)
                            let phase = context.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: period) / period
                            AidenScanLens(
                                size: proxy.size,
                                top: AidenImagePlaceholderSpec.lensTop(
                                    progress: AidenImagePlaceholderSpec.lensProgress(phase: phase),
                                    height: proxy.size.height
                                ),
                                colors: colors
                            )
                        }
                    }
                    Text(item.aspectRatio.rawValue)
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(palette.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(palette.canvas.opacity(0.7), in: Capsule())
                        .padding(10)
                }
            }
            .aspectRatio(item.aspectRatio.value, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: AidenImagePlaceholderSpec.cornerRadius, style: .continuous))

            HStack(spacing: 6) {
                Circle()
                    .fill(palette.accent)
                    .frame(width: 6, height: 6)
                    .opacity(livePulse ? 0.25 : 0.9)
                TimelineView(.periodic(from: start, by: 1)) { context in
                    Text(AidenImagePlaceholderSpec.caption(elapsed: context.date.timeIntervalSince(start)))
                        .monospacedDigit()
                }
            }
            .font(.caption)
            .foregroundStyle(palette.secondary)
        }
        .frame(maxWidth: item.aspectRatio.maxWidth, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Generating image, \(item.aspectRatio.rawValue)")
        .accessibilityIdentifier("aiden.imageGeneration.placeholder")
        .onAppear {
            if since == nil { since = item.runningSince }
            if motion == .animated {
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { livePulse = true }
            }
        }
        .onChange(of: motion) { _, newValue in
            if newValue == .still { withAnimation(nil) { livePulse = false } }
        }
    }
}

/// One-shot reveal over a freshly delivered generated image: the scan cover
/// slides down beneath an accent edge, or the image fades in under Reduce Motion.
struct AidenImageArrivalReveal: ViewModifier {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let active: Bool
    let onFinished: () -> Void
    @State private var progress: CGFloat = 0
    @State private var imageOpacity: Double = 1
    @State private var played = false

    func body(content: Content) -> some View {
        content
            .opacity(imageOpacity)
            .overlay {
                if active && !played && !reduceMotion {
                    GeometryReader { proxy in
                        ZStack(alignment: .top) {
                            AidenScanBase(colors: AidenScanColors(palette: palette, scheme: colorScheme))
                            AidenScanEdge(color: palette.accent)
                                .opacity(progress > 0 ? 0.9 : 0)
                                .offset(y: -1)
                        }
                        .offset(y: proxy.size.height * progress)
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
            }
            .clipped()
            .onAppear(perform: play)
    }

    private func play() {
        guard active, !played else { return }
        if reduceMotion {
            imageOpacity = 0
            withAnimation(.easeOut(duration: AidenImagePlaceholderSpec.reducedArrivalDuration)) {
                imageOpacity = 1
            } completion: {
                played = true
                onFinished()
            }
            return
        }
        let (x1, y1, x2, y2) = AidenImagePlaceholderSpec.arrivalEase
        withAnimation(.timingCurve(x1, y1, x2, y2, duration: AidenImagePlaceholderSpec.arrivalDuration)) {
            progress = 1
        } completion: {
            played = true
            onFinished()
        }
    }
}

extension View {
    func aidenImageArrivalReveal(_ active: Bool, onFinished: @escaping () -> Void) -> some View {
        modifier(AidenImageArrivalReveal(active: active, onFinished: onFinished))
    }
}
