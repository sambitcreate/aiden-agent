import SwiftUI

struct AidenBotAvatarPresentation: Equatable {
    let shape: AidenBotAvatarShape
    let color: AidenBotAvatarColor
    let eyes: AidenBotAvatarEyes
    let detail: AidenBotAvatarDetail
}

func aidenBotAvatarPresentation(_ avatar: AidenBotSemanticAvatar) -> AidenBotAvatarPresentation {
    switch avatar {
    case let .recipe(recipe):
        return .init(
            shape: recipe.shape,
            color: recipe.color,
            eyes: recipe.eyes,
            detail: recipe.detail
        )
    case let .legacy(legacy):
        switch legacy {
        case .spark: return .init(shape: .wisp, color: .sun, eyes: .happy, detail: .sparkles)
        case .orbit: return .init(shape: .orb, color: .lilac, eyes: .focus, detail: .orbit)
        case .leaf: return .init(shape: .drop, color: .mint, eyes: .sleepy, detail: .none)
        case .prism: return .init(shape: .hex, color: .periwinkle, eyes: .wide, detail: .halo)
        case .wave: return .init(shape: .cloud, color: .aqua, eyes: .wink, detail: .orbit)
        case .ember: return .init(shape: .peak, color: .coral, eyes: .dots, detail: .bolts)
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
                .fill(avatarColor.gradient)
            detailDecoration
            Text(eyeGlyph)
                .font(.system(size: size * 0.29, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.5)
                .shadow(color: .black.opacity(0.16), radius: 1, y: 1)
        }
        .frame(width: size, height: size)
        .overlay {
            AidenBotAvatarShapeMask(shape: presentation.shape)
                .stroke(.white.opacity(0.34), lineWidth: max(0.7, size * 0.012))
        }
        .contentShape(AidenBotAvatarShapeMask(shape: presentation.shape))
        .accessibilityHidden(isDecorative)
        .accessibilityLabel(isDecorative ? "" : "\(name) Bot avatar")
    }

    @ViewBuilder
    private var detailDecoration: some View {
        switch presentation.detail {
        case .none:
            EmptyView()
        case .halo:
            Ellipse()
                .stroke(.white.opacity(0.72), lineWidth: max(1, size * 0.025))
                .frame(width: size * 0.55, height: size * 0.18)
                .offset(y: -size * 0.27)
        case .orbit:
            ZStack(alignment: .trailing) {
                Ellipse()
                    .stroke(.white.opacity(0.62), lineWidth: max(1, size * 0.02))
                Circle()
                    .fill(.white)
                    .frame(width: size * 0.09, height: size * 0.09)
            }
            .frame(width: size * 0.82, height: size * 0.34)
            .rotationEffect(.degrees(-22))
        case .sparkles:
            Image(systemName: "sparkles")
                .font(.system(size: size * 0.24, weight: .semibold))
                .foregroundStyle(.white.opacity(0.72))
                .offset(x: size * 0.24, y: -size * 0.23)
        case .antenna:
            VStack(spacing: 0) {
                Circle().fill(.white).frame(width: size * 0.09, height: size * 0.09)
                Capsule().fill(.white.opacity(0.78)).frame(width: size * 0.035, height: size * 0.16)
            }
            .offset(y: -size * 0.46)
        case .bolts:
            HStack(spacing: size * 0.54) {
                Image(systemName: "bolt.fill")
                Image(systemName: "bolt.fill")
                    .scaleEffect(x: -1)
            }
            .font(.system(size: size * 0.16, weight: .bold))
            .foregroundStyle(.white.opacity(0.76))
        }
    }

    private var eyeGlyph: String {
        switch presentation.eyes {
        case .dots: "•  •"
        case .wide: "●  ●"
        case .happy: "⌣"
        case .sleepy: "–  –"
        case .focus: "⊙  ⊙"
        case .wink: "•  ˘"
        }
    }

    private var avatarColor: Color {
        switch presentation.color {
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
