import SwiftUI
import UIKit

/// Aiden's activity mark. Each shape is a `CAShapeLayer`; motion is a set of
/// `CAKeyframeAnimation`s run by the render server, so there is no per-frame
/// work on the main thread. Inactive, Reduced Motion and Low Power marks freeze
/// on their pose at t = 0 instead.
struct AidenActivityMark: View {
    let mark: AidenActivityMarkKind
    var size: CGFloat = 20
    var active: Bool = true
    var color: Color

    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.aidenReduceMotion) private var appReduceMotion
    @Environment(\.aidenLowPowerMode) private var lowPowerMode

    var body: some View {
        AidenActivityMarkCanvas(
            mark: mark,
            side: size,
            animated: active && !systemReduceMotion && !appReduceMotion && !lowPowerMode,
            ink: UIColor(color)
        )
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct AidenActivityMarkCanvas: UIViewRepresentable {
    let mark: AidenActivityMarkKind
    let side: CGFloat
    let animated: Bool
    let ink: UIColor

    func makeUIView(context: Context) -> AidenActivityMarkUIView {
        AidenActivityMarkUIView()
    }

    func updateUIView(_ view: AidenActivityMarkUIView, context: Context) {
        view.update(mark: mark, side: side, animated: animated, ink: ink)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: AidenActivityMarkUIView, context: Context) -> CGSize? {
        CGSize(width: side, height: side)
    }
}

final class AidenActivityMarkUIView: UIView {
    /// A layer driven by tracks: a group container or a shape.
    private struct Driven {
        let layer: CALayer
        let tracks: [AidenMarkTrack]
    }

    private let markLayer = CALayer()
    /// Each shape layer with its own ink alpha (desktop `fill-opacity`).
    private var shapeLayers: [(layer: CAShapeLayer, fillOpacity: CGFloat)] = []
    private var driven: [Driven] = []
    private var mark: AidenActivityMarkKind?
    private var side: CGFloat = 0
    private var animated = false
    private var isRunning = false
    private var ink: UIColor = .label

    /// Points per view-box unit.
    private var scale: CGFloat { side / 24 }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        layer.addSublayer(markLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("AidenActivityMarkUIView is created in code only")
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: side, height: side)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        reconcilePlayback(force: false)
    }

    func update(mark: AidenActivityMarkKind, side: CGFloat, animated: Bool, ink: UIColor) {
        let rebuild = mark != self.mark || side != self.side
        self.animated = animated
        self.ink = ink
        if rebuild {
            self.mark = mark
            self.side = side
            build(mark)
            invalidateIntrinsicContentSize()
        }
        withoutImplicitAnimations {
            shapeLayers.forEach { $0.layer.fillColor = ink.withAlphaComponent($0.fillOpacity).cgColor }
        }
        reconcilePlayback(force: rebuild)
    }

    // MARK: Building

    private func build(_ mark: AidenActivityMarkKind) {
        withoutImplicitAnimations {
            markLayer.sublayers?.forEach { $0.removeFromSuperlayer() }
            shapeLayers = []
            driven = []

            let spec = AidenActivityMarkSpec.make(mark)
            markLayer.frame = CGRect(x: 0, y: 0, width: side, height: side)
            markLayer.opacity = Float(spec.opacity)

            // Group containers span the whole box, so their centre is (12, 12) in view-box units.
            let groupLayers: [CALayer] = spec.groups.map { group in
                let layer = CALayer()
                layer.frame = markLayer.bounds
                layer.opacity = Float(group.opacity)
                markLayer.addSublayer(layer)
                if !group.tracks.isEmpty {
                    driven.append(Driven(layer: layer, tracks: group.tracks))
                }
                return layer
            }

            for shape in spec.shapes {
                let layer = CAShapeLayer()
                let frame = shape.geometry.frame
                let anchor = shape.pivot.anchor
                layer.bounds = CGRect(x: 0, y: 0, width: frame.width * scale, height: frame.height * scale)
                layer.anchorPoint = anchor
                layer.position = CGPoint(
                    x: (frame.minX + anchor.x * frame.width) * scale,
                    y: (frame.minY + anchor.y * frame.height) * scale
                )
                layer.path = Self.path(for: shape.geometry, scale: scale)
                layer.fillColor = ink.withAlphaComponent(CGFloat(shape.fillOpacity)).cgColor

                let parent = shape.group.map { groupLayers[$0] } ?? markLayer
                parent.addSublayer(layer)
                shapeLayers.append((layer, CGFloat(shape.fillOpacity)))
                if !shape.tracks.isEmpty {
                    driven.append(Driven(layer: layer, tracks: shape.tracks))
                }
            }
        }
    }

    private static func path(for geometry: AidenMarkGeometry, scale: CGFloat) -> CGPath {
        switch geometry {
        case let .circle(_, _, r):
            let diameter = CGFloat(r) * 2 * scale
            return CGPath(ellipseIn: CGRect(x: 0, y: 0, width: diameter, height: diameter), transform: nil)
        case let .roundedRect(_, _, width, height, cornerRadius):
            let radius = CGFloat(cornerRadius) * scale
            return CGPath(
                roundedRect: CGRect(x: 0, y: 0, width: CGFloat(width) * scale, height: CGFloat(height) * scale),
                cornerWidth: radius,
                cornerHeight: radius,
                transform: nil
            )
        }
    }

    // MARK: Playback

    /// Re-applies the pose and animations when the running state changes or the
    /// layers were rebuilt. Re-adding animations on every SwiftUI pass would
    /// restart each cycle, so the call is a no-op otherwise.
    private func reconcilePlayback(force: Bool) {
        let running = animated && window != nil
        guard force || running != isRunning else { return }
        isRunning = running

        withoutImplicitAnimations {
            for entry in driven {
                entry.layer.removeAllAnimations()
                let pose = AidenActivityMarkEvaluator.pose(of: entry.tracks, atTime: 0)
                // Animated layers keep an identity model value; the animations own the pose.
                entry.layer.transform = running ? CATransform3DIdentity : Self.transform(for: pose, scale: scale)
                if entry.tracks.contains(where: { $0.property == .opacity }) {
                    entry.layer.opacity = running ? 1 : Float(pose.opacity)
                }
                if running {
                    addAnimations(to: entry)
                }
            }
        }
    }

    private func addAnimations(to entry: Driven) {
        let markKey = mark?.rawValue ?? ""
        for (index, track) in entry.tracks.enumerated() {
            let animation = CAKeyframeAnimation(keyPath: Self.keyPath(for: track.property))
            animation.keyTimes = track.keyframes.map { NSNumber(value: $0.offset) }
            animation.values = track.keyframes.map {
                NSNumber(value: Self.animatedValue($0.value, for: track.property, scale: scale))
            }
            animation.timingFunctions = track.easings.map {
                CAMediaTimingFunction(controlPoints: Float($0.x1), Float($0.y1), Float($0.x2), Float($0.y2))
            }
            animation.duration = track.duration
            animation.repeatCount = .infinity
            animation.isRemovedOnCompletion = false
            animation.isAdditive = track.isAdditive
            animation.timeOffset = AidenActivityMarkEvaluator.animationTimeOffset(
                delay: track.delay,
                duration: track.duration
            )
            entry.layer.add(animation, forKey: "aiden.activity-mark.\(markKey).\(index)")
        }
    }

    private static func keyPath(for property: AidenMarkProperty) -> String {
        switch property {
        case .translateX: return "transform.translation.x"
        case .translateY: return "transform.translation.y"
        case .rotation: return "transform.rotation.z"
        case .scale: return "transform.scale"
        case .scaleX: return "transform.scale.x"
        case .scaleY: return "transform.scale.y"
        case .opacity: return "opacity"
        }
    }

    /// Translations are stored in view-box units and drawn in points.
    private static func animatedValue(_ value: Double, for property: AidenMarkProperty, scale: CGFloat) -> Double {
        switch property {
        case .translateX, .translateY: value * Double(scale)
        case .rotation, .scale, .scaleX, .scaleY, .opacity: value
        }
    }

    /// Scale about the layer anchor, then rotate, then translate (CSS order).
    private static func transform(for pose: AidenMarkPose, scale: CGFloat) -> CATransform3D {
        let scaled = CATransform3DMakeScale(CGFloat(pose.scaleX), CGFloat(pose.scaleY), 1)
        let rotated = CATransform3DMakeRotation(CGFloat(pose.rotation), 0, 0, 1)
        let translated = CATransform3DMakeTranslation(
            CGFloat(pose.translateX) * scale,
            CGFloat(pose.translateY) * scale,
            0
        )
        return CATransform3DConcat(CATransform3DConcat(scaled, rotated), translated)
    }
}

/// Applies layer changes without Core Animation's implicit transitions.
private func withoutImplicitAnimations(_ changes: () -> Void) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    changes()
    CATransaction.commit()
}
