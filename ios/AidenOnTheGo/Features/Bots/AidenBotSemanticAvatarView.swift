import SwiftUI

/// What a Bot's character looks like: a colour and a shape. Every Bot shares
/// one fixed eye mark, so the older eye and detail fields are not drawn.
struct AidenBotAvatarPresentation: Equatable {
    let shape: AidenBotAvatarShape
    let color: AidenBotAvatarColor
}

func aidenBotAvatarPresentation(_ avatar: AidenBotSemanticAvatar) -> AidenBotAvatarPresentation {
    .init(shape: avatar.recipe.shape, color: avatar.recipe.color)
}

/// The eye mark colour, shared with desktop (`BOT_AVATAR_FACE_HEX`).
let aidenBotAvatarFaceRGB: UInt32 = 0x292735

extension Color {
    init(aidenRGB rgb: UInt32) {
        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}

extension AidenBotAvatarColor {
    /// The colour as 0xRRGGBB, exactly desktop's `BOT_AVATAR_COLOR_HEX`.
    var rgb: UInt32 {
        switch self {
        case .lilac: 0xC6A9FF
        case .sky: 0x83D8FF
        case .mint: 0x88E8B1
        case .sun: 0xFFDA7B
        case .periwinkle: 0xB2BCFF
        case .coral: 0xFF9F9B
        case .peach: 0xFFC294
        case .aqua: 0x78E8DF
        case .rose: 0xFFA3C7
        case .lime: 0xC6EC7E
        case .plum: 0xDDA8F2
        case .graphite: 0xC5C5CE
        }
    }

    /// The fill shown for this character colour.
    var swatch: Color { Color(aidenRGB: rgb) }

    var displayName: String {
        switch self {
        case .lilac: "Lilac"
        case .sky: "Sky"
        case .mint: "Mint"
        case .sun: "Sun"
        case .periwinkle: "Periwinkle"
        case .coral: "Coral"
        case .peach: "Peach"
        case .aqua: "Aqua"
        case .rose: "Rose"
        case .lime: "Lime"
        case .plum: "Plum"
        case .graphite: "Graphite"
        }
    }
}

extension AidenBotAvatarShape {
    var displayName: String {
        switch self {
        case .wisp: "Wisp"
        case .orb: "Circle"
        case .drop: "Drop"
        case .hex: "Hexagon"
        case .cloud: "Cloud"
        case .peak: "Triangle"
        case .squircle: "Rounded square"
        case .capsule: "Pill"
        }
    }
}

/// The canonical face's glance while its Bot works: the eyes look left and
/// right and blink, on the shared `glance` keyframes. `dx` is a fraction of the
/// avatar's size; `blink` scales the eyes' height.
struct AidenBotFaceGlancePose: Equatable {
    var dx: Double
    var blink: Double

    static let still = AidenBotFaceGlancePose(dx: 0, blink: 1)
}

private let aidenBotGlanceSpec = AidenActivityMarkSpec.make(.glance)

/// How a working Bot's avatar says so (ruling 8, R19).
struct AidenBotWorkingCue: Equatable {
    /// The canonical face's eyes glance.
    let glances: Bool
    /// A small glance mark sits on the avatar's corner.
    let badge: Bool

    static let none = AidenBotWorkingCue(glances: false, badge: false)
}

/// A canonical face glances while its Bot works. A photo can't, and a face holds
/// still under Reduce Motion or Low Power, so both wear the glance badge (whose
/// mark then holds its still pose): a working Bot always keeps a visible cue.
func aidenBotWorkingCue(working: Bool, hasPhoto: Bool, motionAllowed: Bool) -> AidenBotWorkingCue {
    guard working else { return .none }
    if !hasPhoto, motionAllowed { return AidenBotWorkingCue(glances: true, badge: false) }
    return AidenBotWorkingCue(glances: false, badge: true)
}

func aidenBotFaceGlancePose(at time: TimeInterval) -> AidenBotFaceGlancePose {
    let look = AidenActivityMarkEvaluator.pose(of: aidenBotGlanceSpec.groups[0].tracks, atTime: time)
    let eye = AidenActivityMarkEvaluator.pose(of: aidenBotGlanceSpec.shapes[0].tracks, atTime: time)
    // The mark's view box is 24 wide.
    return AidenBotFaceGlancePose(dx: look.translateX / 24, blink: eye.scaleY)
}

struct AidenBotSemanticAvatarView: View {
    let avatar: AidenBotSemanticAvatar
    let name: String
    let size: CGFloat
    var isDecorative = true
    /// The Bot is in a running turn: its eyes glance (spec §12, ruling 8).
    var working = false

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.aidenReduceMotion) private var appReduceMotion
    @Environment(\.aidenLowPowerMode) private var lowPowerMode

    private var presentation: AidenBotAvatarPresentation {
        aidenBotAvatarPresentation(avatar)
    }

    var body: some View {
        ZStack {
            AidenBotAvatarShapeMask(shape: presentation.shape)
                .fill(presentation.color.swatch)
            AidenBotEyeMark(size: size, glancing: working && !systemReduceMotion && !appReduceMotion && !lowPowerMode)
        }
        .frame(width: size, height: size)
        .contentShape(AidenBotAvatarShapeMask(shape: presentation.shape))
        .accessibilityHidden(isDecorative)
        .accessibilityLabel(isDecorative ? "" : "\(name) Bot avatar")
    }
}

/// A plain character shape, used by the Character card's shape choices.
struct AidenBotShapeSwatch: View {
    let shape: AidenBotAvatarShape
    let color: Color
    let size: CGFloat

    var body: some View {
        AidenBotAvatarShapeMask(shape: shape)
            .fill(color)
            .frame(width: size, height: size)
    }
}

/// The one eye mark every Bot shares: two short, slightly tilted strokes.
/// While its Bot works they glance; otherwise (and under Reduce Motion) they hold still.
private struct AidenBotEyeMark: View {
    let size: CGFloat
    var glancing = false

    var body: some View {
        // 30 frames a second is plenty for a glance and spares the battery.
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !glancing)) { context in
            let pose = glancing ? aidenBotFaceGlancePose(at: context.date.timeIntervalSinceReferenceDate) : .still
            HStack(spacing: size * 0.09) {
                Capsule()
                    .frame(width: size * 0.09, height: size * 0.2)
                    .scaleEffect(x: 1, y: pose.blink)
                Capsule()
                    .frame(width: size * 0.09, height: size * 0.2)
                    .scaleEffect(x: 1, y: pose.blink)
            }
            .foregroundStyle(Color(aidenRGB: aidenBotAvatarFaceRGB))
            .offset(x: pose.dx * size)
            .rotationEffect(.degrees(-12))
            .offset(x: size * 0.08, y: -size * 0.02)
        }
        .accessibilityHidden(true)
    }
}

private struct AidenBotAvatarShapeMask: Shape {
    let shape: AidenBotAvatarShape

    func path(in rect: CGRect) -> Path {
        switch shape {
        case .orb:
            return Circle().path(in: rect)
        case .squircle:
            return RoundedRectangle(cornerRadius: rect.width * 0.3, style: .continuous).path(in: rect)
        case .capsule:
            return Capsule().path(in: rect.insetBy(dx: rect.width * 0.12, dy: 0))
        case .hex:
            return polygon(in: rect, points: 6, rotation: -.pi / 2)
        case .peak:
            return polygon(in: rect.insetBy(dx: rect.width * 0.05, dy: 0), points: 3, rotation: -.pi / 2)
        case .drop:
            var path = Path()
            path.move(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addCurve(
                to: CGPoint(x: rect.midX, y: rect.maxY),
                control1: CGPoint(x: rect.maxX * 1.04, y: rect.height * 0.38),
                control2: CGPoint(x: rect.maxX, y: rect.height * 0.78)
            )
            path.addCurve(
                to: CGPoint(x: rect.midX, y: rect.minY),
                control1: CGPoint(x: rect.minX, y: rect.height * 0.78),
                control2: CGPoint(x: rect.minX - rect.width * 0.04, y: rect.height * 0.38)
            )
            return path
        case .cloud:
            var path = RoundedRectangle(
                cornerRadius: rect.width * 0.28,
                style: .continuous
            ).path(in: rect.insetBy(dx: 0, dy: rect.height * 0.13))
            path.addEllipse(in: CGRect(
                x: rect.width * 0.22,
                y: rect.minY,
                width: rect.width * 0.56,
                height: rect.height * 0.62
            ))
            return path
        case .wisp:
            var path = Path()
            path.move(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addCurve(
                to: CGPoint(x: rect.maxX, y: rect.midY),
                control1: CGPoint(x: rect.width * 0.82, y: rect.minY),
                control2: CGPoint(x: rect.maxX, y: rect.height * 0.18)
            )
            path.addCurve(
                to: CGPoint(x: rect.midX, y: rect.maxY),
                control1: CGPoint(x: rect.maxX, y: rect.height * 0.84),
                control2: CGPoint(x: rect.width * 0.72, y: rect.maxY)
            )
            path.addCurve(
                to: CGPoint(x: rect.minX, y: rect.midY),
                control1: CGPoint(x: rect.width * 0.28, y: rect.maxY),
                control2: CGPoint(x: rect.minX, y: rect.height * 0.82)
            )
            path.addCurve(
                to: CGPoint(x: rect.midX, y: rect.minY),
                control1: CGPoint(x: rect.minX, y: rect.height * 0.2),
                control2: CGPoint(x: rect.width * 0.2, y: rect.height * 0.08)
            )
            return path
        }
    }

    private func polygon(in rect: CGRect, points: Int, rotation: CGFloat) -> Path {
        var path = Path()
        let radius = min(rect.width, rect.height) / 2
        for index in 0..<points {
            let angle = rotation + (CGFloat(index) / CGFloat(points)) * .pi * 2
            let point = CGPoint(
                x: rect.midX + cos(angle) * radius,
                y: rect.midY + sin(angle) * radius
            )
            if index == 0 {
                path.move(to: point)
            } else {
                path.addLine(to: point)
            }
        }
        path.closeSubpath()
        return path
    }
}
