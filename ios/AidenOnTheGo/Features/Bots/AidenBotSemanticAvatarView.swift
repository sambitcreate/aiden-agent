import SwiftUI

/// What a Bot's character looks like: a colour and a shape. The sprite draws
/// its own eyes from the colour's tones, so the older eye and detail fields
/// are not drawn.
struct AidenBotAvatarPresentation: Equatable {
    let shape: AidenBotAvatarShape
    let color: AidenBotAvatarColor
}

func aidenBotAvatarPresentation(_ avatar: AidenBotSemanticAvatar) -> AidenBotAvatarPresentation {
    .init(shape: avatar.recipe.shape, color: avatar.recipe.color)
}

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

/// A Bot's drawn avatar: its Hi-bit sprite (docs/plans/hibit-sprite-avatars-plan.md).
struct AidenBotSemanticAvatarView: View {
    let avatar: AidenBotSemanticAvatar
    let name: String
    let size: CGFloat
    var isDecorative = true
    /// The live state to play. Nil is the still idle sprite lists and pickers show.
    var state: AidenBotAvatarState?

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.aidenReduceMotion) private var appReduceMotion
    @Environment(\.aidenLowPowerMode) private var lowPowerMode

    private var presentation: AidenBotAvatarPresentation {
        aidenBotAvatarPresentation(avatar)
    }

    var body: some View {
        let presentation = presentation
        Group {
            if let liveState = state, !systemReduceMotion, !appReduceMotion, !lowPowerMode {
                // A new identity per state, so its clock starts on the frame the state does.
                AidenBotAnimatedSprite(shape: presentation.shape, color: presentation.color, size: size, state: liveState)
                    .id(liveState)
            } else {
                // Reduce Motion, Low Power, and every resting avatar: the still pose.
                AidenBotSpriteCanvas(
                    shape: presentation.shape,
                    color: presentation.color,
                    size: size,
                    pose: AidenBotSpritePose(still: state ?? .idle)
                )
            }
        }
        .frame(width: size, height: size)
        .contentShape(Rectangle())
        .accessibilityHidden(isDecorative)
        .accessibilityLabel(isDecorative ? "" : "\(name) Bot avatar")
    }
}

/// A sprite playing one state from the moment it appears, so done and error
/// play once from their start.
private struct AidenBotAnimatedSprite: View {
    let shape: AidenBotAvatarShape
    let color: AidenBotAvatarColor
    let size: CGFloat
    let state: AidenBotAvatarState

    @State private var start = Date()

    var body: some View {
        // Wake only on the pose's step edges: stepped motion needs no frame rate.
        TimelineView(AidenBotSpriteSchedule(start: start, steps: AidenBotSpriteSteps(state))) { timeline in
            AidenBotSpriteCanvas(
                shape: shape,
                color: color,
                size: size,
                pose: AidenBotSpritePose(state: state, elapsed: timeline.date.timeIntervalSince(start))
            )
            .equatable()
        }
    }
}

/// A character's sprite body in a colour, used by the Character card's shape choices.
struct AidenBotShapeSwatch: View {
    let shape: AidenBotAvatarShape
    let color: AidenBotAvatarColor
    let size: CGFloat

    var body: some View {
        AidenBotSpriteCanvas(shape: shape, color: color, size: size, pose: AidenBotSpritePose(still: .idle))
            .accessibilityHidden(true)
    }
}
