import Foundation

/// Pure timing model for activity marks (docs/activity-marks.md, "Coordinate
/// system and timing model"). The view layer uses it for frozen poses; the
/// CoreAnimation phase mapping is checked against it in tests.
enum AidenActivityMarkEvaluator {
    /// Value of one track at clock time `t` (seconds).
    ///
    /// Local time is `u = ((t − d) mod D) / D`. The keyframe segment containing
    /// `u` is found, its progress is eased by that segment's cubic-bezier, and
    /// the two keyframe values are interpolated linearly.
    static func value(of track: AidenMarkTrack, atTime t: Double) -> Double {
        let keys = track.keyframes
        guard keys.count > 1, track.duration > 0 else { return keys.first?.value ?? 0 }

        let u = positiveRemainder(t - track.delay, track.duration) / track.duration

        var index = 0
        while index < keys.count - 2 && u > keys[index + 1].offset {
            index += 1
        }
        let start = keys[index]
        let end = keys[index + 1]
        let span = end.offset - start.offset
        let progress = span > 0 ? min(max((u - start.offset) / span, 0), 1) : 1
        let eased = easedProgress(track.easings[index], x: progress)
        return start.value + (end.value - start.value) * eased
    }

    /// Combined pose of a set of tracks at time `t`. Non-additive tracks set a
    /// property; additive tracks add to translation and rotation, and multiply
    /// scale and opacity.
    static func pose(of tracks: [AidenMarkTrack], atTime t: Double) -> AidenMarkPose {
        var pose = AidenMarkPose()
        for track in tracks {
            let sample = value(of: track, atTime: t)
            pose.apply(track.property, sample, additive: track.isAdditive)
        }
        return pose
    }

    /// The `timeOffset` that makes a CoreAnimation repeating animation with
    /// `beginTime` at its start match the phase `(t − d) mod D`:
    /// `((−d) mod D + D) mod D`.
    static func animationTimeOffset(delay: Double, duration: Double) -> Double {
        positiveRemainder(-delay, duration)
    }

    // MARK: Private

    private static func positiveRemainder(_ value: Double, _ modulus: Double) -> Double {
        let remainder = value.truncatingRemainder(dividingBy: modulus)
        return remainder < 0 ? remainder + modulus : remainder
    }

    /// Solves x(s) = `x` for the curve parameter s by bisection (x(s) is
    /// monotonic for the control points used here), then returns y(s).
    private static func easedProgress(_ easing: AidenMarkEasing, x: Double) -> Double {
        var low = 0.0
        var high = 1.0
        for _ in 0..<60 {
            let mid = (low + high) / 2
            if bezier(mid, easing.x1, easing.x2) < x {
                low = mid
            } else {
                high = mid
            }
        }
        let s = (low + high) / 2
        return bezier(s, easing.y1, easing.y2)
    }

    private static func bezier(_ s: Double, _ p1: Double, _ p2: Double) -> Double {
        let inverse = 1 - s
        return 3 * inverse * inverse * s * p1 + 3 * inverse * s * s * p2 + s * s * s
    }
}

/// Transform and opacity of one layer at one instant, in view-box units.
struct AidenMarkPose: Equatable {
    var translateX: Double = 0
    var translateY: Double = 0
    /// Radians.
    var rotation: Double = 0
    var scaleX: Double = 1
    var scaleY: Double = 1
    var opacity: Double = 1

    mutating func apply(_ property: AidenMarkProperty, _ sample: Double, additive: Bool) {
        switch property {
        case .translateX:
            translateX = additive ? translateX + sample : sample
        case .translateY:
            translateY = additive ? translateY + sample : sample
        case .rotation:
            rotation = additive ? rotation + sample : sample
        case .scale:
            scaleX = additive ? scaleX * sample : sample
            scaleY = additive ? scaleY * sample : sample
        case .scaleX:
            scaleX = additive ? scaleX * sample : sample
        case .scaleY:
            scaleY = additive ? scaleY * sample : sample
        case .opacity:
            opacity = additive ? opacity * sample : sample
        }
    }
}
