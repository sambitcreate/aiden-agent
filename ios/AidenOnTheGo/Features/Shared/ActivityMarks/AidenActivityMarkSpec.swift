import CoreGraphics
import Foundation

// Aiden activity marks: pure geometry and timing data.
//
// The tables below mirror docs/activity-marks.md, which is the source of truth
// shared with the desktop SVG mark and the Android port. Nothing in this file
// touches UIKit, so the data can be unit-tested without a view.

enum AidenActivityMarkKind: String, CaseIterable {
    case triStep = "tri-step"
    case quadShuffle = "quad-shuffle"
    case compose
    case scanGrid = "scan-grid"
    case glance
    case bounce
    case helixCalm = "helix-calm"
    case helixTwist = "helix-twist"
    case helixSwell = "helix-swell"
    case helixDuplex = "helix-duplex"
    case helixFlat = "helix-flat"
}

/// CSS-style cubic-bezier control points (x1, y1, x2, y2).
struct AidenMarkEasing: Equatable {
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double

    static let turn = AidenMarkEasing(x1: 0.5, y1: -0.45, x2: 0.25, y2: 1.45)
    static let shuffle = AidenMarkEasing(x1: 0.65, y1: 0, x2: 0.35, y2: 1)
    static let compose = AidenMarkEasing(x1: 0.4, y1: 0, x2: 0.2, y2: 1)
    static let inOut = AidenMarkEasing(x1: 0.42, y1: 0, x2: 0.58, y2: 1)
    static let look = AidenMarkEasing(x1: 0.5, y1: 0, x2: 0.3, y2: 1)
    static let bounce = AidenMarkEasing(x1: 0.45, y1: 0, x2: 0.55, y2: 1)
}

enum AidenMarkProperty: Equatable {
    /// View-box units.
    case translateX
    /// View-box units.
    case translateY
    /// Radians, clockwise positive (matches CSS rotate on a y-down canvas).
    case rotation
    /// Uniform scale about the pivot.
    case scale
    case scaleX
    case scaleY
    case opacity
}

struct AidenMarkKeyframe: Equatable {
    /// Position in one period, in [0, 1].
    let offset: Double
    let value: Double
}

/// One property of one shape or group, animated over a repeating period.
struct AidenMarkTrack: Equatable {
    let property: AidenMarkProperty
    /// Period D, in seconds.
    let duration: Double
    /// Delay d, in seconds. Usually negative. Local time is `t − d`.
    let delay: Double
    /// Keyframes sorted by offset, starting at 0 and ending at 1.
    let keyframes: [AidenMarkKeyframe]
    /// One easing per segment, so `easings.count == keyframes.count - 1`.
    let easings: [AidenMarkEasing]
    /// Additive tracks add to the value produced by the other tracks of the same property.
    let isAdditive: Bool

    init(
        property: AidenMarkProperty,
        duration: Double,
        delay: Double,
        keyframes: [AidenMarkKeyframe],
        easings: [AidenMarkEasing],
        isAdditive: Bool = false
    ) {
        precondition(easings.count == keyframes.count - 1, "One easing per keyframe segment")
        self.property = property
        self.duration = duration
        self.delay = delay
        self.keyframes = keyframes
        self.easings = easings
        self.isAdditive = isAdditive
    }
}

/// Where a shape's own transform is anchored, in its bounding box.
enum AidenMarkPivot: Equatable {
    case center
    /// Left edge, vertically centred. Used by compose lines so they grow from the left.
    case leftCenter

    var anchor: CGPoint {
        switch self {
        case .center: CGPoint(x: 0.5, y: 0.5)
        case .leftCenter: CGPoint(x: 0, y: 0.5)
        }
    }
}

enum AidenMarkGeometry: Equatable {
    case circle(cx: Double, cy: Double, r: Double)
    case roundedRect(x: Double, y: Double, width: Double, height: Double, cornerRadius: Double)

    /// Bounding box in view-box units (24 × 24 box).
    var frame: CGRect {
        switch self {
        case let .circle(cx, cy, r):
            CGRect(x: CGFloat(cx - r), y: CGFloat(cy - r), width: CGFloat(2 * r), height: CGFloat(2 * r))
        case let .roundedRect(x, y, width, height, _):
            CGRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(width), height: CGFloat(height))
        }
    }
}

struct AidenMarkShape: Equatable {
    let geometry: AidenMarkGeometry
    /// Index into `AidenActivityMarkSpec.groups`, or nil to draw at the root.
    let group: Int?
    let pivot: AidenMarkPivot
    let tracks: [AidenMarkTrack]
    /// Ink alpha for this shape alone (desktop `fill-opacity`): 0.55 for Helix · Duplex strand b.
    var fillOpacity: Double = 1
}

/// A container layer that shares one transform and opacity across its shapes.
struct AidenMarkGroup: Equatable {
    let opacity: Double
    let tracks: [AidenMarkTrack]
}

struct AidenActivityMarkSpec: Equatable {
    let kind: AidenActivityMarkKind
    /// Opacity of the whole mark.
    let opacity: Double
    /// Containers in draw order. Shapes reference them by index.
    let groups: [AidenMarkGroup]
    /// Shapes in draw order: later shapes paint over earlier ones.
    let shapes: [AidenMarkShape]
}

extension AidenActivityMarkSpec {
    /// The spec for a mark. `waveAmplitude` sizes Helix · Swell's second wave
    /// (3 by default; `1 + 4 × level` for a 0–1 voice level).
    static func make(_ kind: AidenActivityMarkKind, waveAmplitude: Double = 3) -> AidenActivityMarkSpec {
        switch kind {
        case .triStep: triStep()
        case .quadShuffle: quadShuffle()
        case .compose: compose()
        case .scanGrid: scanGrid()
        case .glance: glance()
        case .bounce: bounce()
        case .helixCalm: helix(kind, HelixParams.calm)
        case .helixTwist: helix(kind, HelixParams.twist)
        case .helixSwell: helix(kind, HelixParams.swell, wave: waveAmplitude)
        case .helixDuplex: helix(kind, HelixParams.duplex, strandBFillOpacity: 0.55)
        case .helixFlat: helixFlat()
        }
    }

    // MARK: Helpers

    private static func track(
        _ property: AidenMarkProperty,
        duration: Double,
        delay: Double = 0,
        easing: AidenMarkEasing,
        _ frames: [(Double, Double)],
        additive: Bool = false
    ) -> AidenMarkTrack {
        AidenMarkTrack(
            property: property,
            duration: duration,
            delay: delay,
            keyframes: frames.map { AidenMarkKeyframe(offset: $0.0, value: $0.1) },
            easings: Array(repeating: easing, count: frames.count - 1),
            isAdditive: additive
        )
    }

    private static func degrees(_ value: Double) -> Double {
        value * .pi / 180
    }

    // MARK: Marks

    private static func triStep() -> AidenActivityMarkSpec {
        let turn = AidenMarkGroup(opacity: 1, tracks: [
            track(.rotation, duration: 2.7, easing: .turn, [
                (0, degrees(0)), (0.22, degrees(120)), (0.3333, degrees(120)),
                (0.5533, degrees(240)), (0.6666, degrees(240)),
                (0.8866, degrees(360)), (1, degrees(360)),
            ]),
        ])
        let centres: [(Double, Double)] = [(12, 5.5), (17.63, 15.25), (6.37, 15.25)]
        let shapes = centres.map { cx, cy in
            AidenMarkShape(geometry: .circle(cx: cx, cy: cy, r: 2.6), group: 0, pivot: .center, tracks: [])
        }
        return AidenActivityMarkSpec(kind: .triStep, opacity: 1, groups: [turn], shapes: shapes)
    }

    private static func quadShuffle() -> AidenActivityMarkSpec {
        // Home centre, diagonal offset a, corner offset b.
        let quads: [(home: (Double, Double), a: (Double, Double), b: (Double, Double))] = [
            (home: (7, 7), a: (-2.2, -2.2), b: (10, 0)),
            (home: (17, 7), a: (-7.4, 2.6), b: (0, 10)),
            (home: (7, 17), a: (7.4, -2.6), b: (0, -10)),
            (home: (17, 17), a: (2.2, 2.2), b: (-10, 0)),
        ]
        let shapes = quads.map { quad in
            AidenMarkShape(
                geometry: .circle(cx: quad.home.0, cy: quad.home.1, r: 2.4),
                group: nil,
                pivot: .center,
                tracks: [
                    track(.translateX, duration: 2.6, easing: .shuffle, [
                        (0, 0), (0.18, quad.a.0), (0.36, 0), (0.56, quad.b.0), (0.72, quad.b.0), (0.9, 0), (1, 0),
                    ]),
                    track(.translateY, duration: 2.6, easing: .shuffle, [
                        (0, 0), (0.18, quad.a.1), (0.36, 0), (0.56, quad.b.1), (0.72, quad.b.1), (0.9, 0), (1, 0),
                    ]),
                ]
            )
        }
        return AidenActivityMarkSpec(kind: .quadShuffle, opacity: 1, groups: [], shapes: shapes)
    }

    private static func compose() -> AidenActivityMarkSpec {
        let lines: [(y: Double, width: Double)] = [(5.5, 16), (10.7, 12), (15.9, 14)]
        let shapes = lines.enumerated().map { index, line in
            let delay = Double(index) * 0.16 - 1.1
            return AidenMarkShape(
                geometry: .roundedRect(x: 4, y: line.y, width: line.width, height: 2.6, cornerRadius: 1.3),
                group: nil,
                pivot: .leftCenter,
                tracks: [
                    track(.scaleX, duration: 2.2, delay: delay, easing: .compose, [
                        (0, 0.16), (0.35, 1), (0.7, 1), (1, 0.16),
                    ]),
                    track(.opacity, duration: 2.2, delay: delay, easing: .compose, [
                        (0, 0.35), (0.35, 1), (0.7, 1), (1, 0.35),
                    ]),
                ]
            )
        }
        return AidenActivityMarkSpec(kind: .compose, opacity: 1, groups: [], shapes: shapes)
    }

    private static func scanGrid() -> AidenActivityMarkSpec {
        let positions: [Double] = [6, 12, 18]
        var shapes: [AidenMarkShape] = []
        for cy in positions {
            for (column, cx) in positions.enumerated() {
                // Delay per the spec: d = i × 0.18 s − 0.45 s, so the t = 0 pose lights the first column.
                let delay = Double(column) * 0.18 - 0.45
                shapes.append(AidenMarkShape(
                    geometry: .circle(cx: cx, cy: cy, r: 1.9),
                    group: nil,
                    pivot: .center,
                    tracks: [
                        track(.scale, duration: 1.5, delay: delay, easing: .inOut, [
                            (0, 1), (0.3, 1.18), (0.7, 1), (1, 1),
                        ]),
                        track(.opacity, duration: 1.5, delay: delay, easing: .inOut, [
                            (0, 0.2), (0.3, 1), (0.7, 0.2), (1, 0.2),
                        ]),
                    ]
                ))
            }
        }
        return AidenActivityMarkSpec(kind: .scanGrid, opacity: 1, groups: [], shapes: shapes)
    }

    private static func glance() -> AidenActivityMarkSpec {
        let look = AidenMarkGroup(opacity: 1, tracks: [
            track(.translateX, duration: 4, easing: .look, [
                (0, 0), (0.14, 0), (0.24, -2.6), (0.4, -2.6),
                (0.52, 2.6), (0.68, 2.6), (0.8, 0), (1, 0),
            ]),
        ])
        let blink = track(.scaleY, duration: 4, easing: .inOut, [
            (0, 1), (0.86, 1), (0.9, 0.1), (0.94, 1), (1, 1),
        ])
        let eyes = [7.0, 13.6].map { x in
            AidenMarkShape(
                geometry: .roundedRect(x: x, y: 8.5, width: 3.4, height: 7, cornerRadius: 1.7),
                group: 0,
                pivot: .center,
                tracks: [blink]
            )
        }
        return AidenActivityMarkSpec(kind: .glance, opacity: 1, groups: [look], shapes: eyes)
    }

    private static func bounce() -> AidenActivityMarkSpec {
        let centres: [Double] = [5.5, 12, 18.5]
        let shapes = centres.enumerated().map { index, cx in
            AidenMarkShape(
                geometry: .circle(cx: cx, cy: 13, r: 2.4),
                group: nil,
                pivot: .center,
                tracks: [
                    track(.translateY, duration: 1.2, delay: Double(index) * 0.13, easing: .bounce, [
                        (0, 0), (0.27, -5), (0.55, 0), (1, 0),
                    ]),
                ]
            )
        }
        return AidenActivityMarkSpec(kind: .bounce, opacity: 1, groups: [], shapes: shapes)
    }

    private struct HelixParams {
        let amplitude: Double
        let duration: Double
        let step: Double
        let frontScale: Double
        let backScale: Double
        let backOpacity: Double

        static let calm = HelixParams(amplitude: 3.4, duration: 3.6, step: 0.3, frontScale: 1.12, backScale: 0.78, backOpacity: 0.5)
        static let twist = HelixParams(amplitude: 5, duration: 1.5, step: 0.375, frontScale: 1.3, backScale: 0.55, backOpacity: 0.3)
        static let swell = HelixParams(amplitude: 3, duration: 1.6, step: 0.2, frontScale: 1.3, backScale: 0.6, backOpacity: 0.35)
        static let duplex = HelixParams(amplitude: 5, duration: 2, step: 0.2, frontScale: 1.3, backScale: 0.6, backOpacity: 0.35)
    }

    /// Two strands of five circles. Strand b (phase 0.5) is group 0 and is drawn
    /// first; strand a (phase 0) is group 1 and passes over it.
    private static func helix(
        _ kind: AidenActivityMarkKind,
        _ params: HelixParams,
        strandBFillOpacity: Double = 1,
        wave: Double? = nil
    ) -> AidenActivityMarkSpec {
        let columns: [Double] = [4, 8, 12, 16, 20]
        let groups = [
            AidenMarkGroup(opacity: 1, tracks: []),
            AidenMarkGroup(opacity: 1, tracks: []),
        ]
        let depthDelayShift = params.duration / 4
        var shapes: [AidenMarkShape] = []
        for (group, phase) in [(0, 0.5), (1, 0.0)] {
            for (column, cx) in columns.enumerated() {
                let delay = -(Double(column) * params.step) - phase * params.duration
                var tracks: [AidenMarkTrack] = [
                    track(.translateY, duration: params.duration, delay: delay, easing: .inOut, [
                        (0, -params.amplitude), (0.5, params.amplitude), (1, -params.amplitude),
                    ]),
                    track(.scale, duration: params.duration, delay: delay + depthDelayShift, easing: .inOut, [
                        (0, params.frontScale), (0.5, params.backScale), (1, params.frontScale),
                    ]),
                    track(.opacity, duration: params.duration, delay: delay + depthDelayShift, easing: .inOut, [
                        (0, 1), (0.5, params.backOpacity), (1, 1),
                    ]),
                ]
                if let wave {
                    tracks.append(track(.translateY, duration: 2.3, delay: Double(column) * -0.45, easing: .inOut, [
                        (0, -wave), (0.5, wave), (1, -wave),
                    ], additive: true))
                }
                shapes.append(AidenMarkShape(
                    geometry: .circle(cx: cx, cy: 12, r: 1.8),
                    group: group,
                    pivot: .center,
                    tracks: tracks,
                    fillOpacity: group == 0 ? strandBFillOpacity : 1
                ))
            }
        }
        return AidenActivityMarkSpec(kind: kind, opacity: 1, groups: groups, shapes: shapes)
    }

    /// Helix · Flat: the same ten circles at rest, with the whole mark at 45% opacity.
    private static func helixFlat() -> AidenActivityMarkSpec {
        let columns: [Double] = [4, 8, 12, 16, 20]
        let groups = [
            AidenMarkGroup(opacity: 1, tracks: []),
            AidenMarkGroup(opacity: 1, tracks: []),
        ]
        var shapes: [AidenMarkShape] = []
        for group in [0, 1] {
            for cx in columns {
                shapes.append(AidenMarkShape(
                    geometry: .circle(cx: cx, cy: 12, r: 1.8),
                    group: group,
                    pivot: .center,
                    tracks: []
                ))
            }
        }
        return AidenActivityMarkSpec(kind: .helixFlat, opacity: 0.45, groups: groups, shapes: shapes)
    }
}
