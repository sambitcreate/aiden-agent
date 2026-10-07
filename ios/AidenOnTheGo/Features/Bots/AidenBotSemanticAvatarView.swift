import SwiftUI

/// What a Bot's character looks like: a colour and a shape. Every Bot shares
/// one fixed eye mark, so the older eye and detail fields are not drawn.
struct AidenBotAvatarPresentation: Equatable {
    let shape: AidenBotAvatarShape
    let color: AidenBotAvatarColor
}

func aidenBotAvatarPresentation(_ avatar: AidenBotSemanticAvatar) -> AidenBotAvatarPresentation {
    switch avatar {
    case let .recipe(recipe):
        return .init(shape: recipe.shape, color: recipe.color)
    case let .legacy(legacy):
        // Matches the desktop's legacy table in renderer/shared/bots.ts.
        switch legacy {
        case .spark: return .init(shape: .wisp, color: .lilac)
        case .orbit: return .init(shape: .orb, color: .sky)
        case .leaf: return .init(shape: .drop, color: .mint)
        case .prism: return .init(shape: .hex, color: .sun)
        case .wave: return .init(shape: .cloud, color: .periwinkle)
        case .ember: return .init(shape: .peak, color: .coral)
        }
    }
}

extension AidenBotAvatarColor {
    /// The fill shown for this character colour.
    var swatch: Color {
        switch self {
        case .lilac: .purple
        case .sky: .blue
        case .mint: .mint
        case .sun: .yellow
        case .periwinkle: .indigo
        case .coral: .pink
        case .peach: .orange
        case .aqua: .cyan
        }
    }

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

struct AidenBotSemanticAvatarView: View {
    let avatar: AidenBotSemanticAvatar
    let name: String
    let size: CGFloat
    var isDecorative = true

    private var presentation: AidenBotAvatarPresentation {
        aidenBotAvatarPresentation(avatar)
    }

    var body: some View {
        ZStack {
            AidenBotAvatarShapeMask(shape: presentation.shape)
                .fill(presentation.color.swatch)
            AidenBotEyeMark(size: size)
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
private struct AidenBotEyeMark: View {
    let size: CGFloat

    var body: some View {
        HStack(spacing: size * 0.09) {
            Capsule().frame(width: size * 0.09, height: size * 0.2)
            Capsule().frame(width: size * 0.09, height: size * 0.2)
        }
        .foregroundStyle(.white)
        .rotationEffect(.degrees(-12))
        .offset(x: size * 0.08, y: -size * 0.02)
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
