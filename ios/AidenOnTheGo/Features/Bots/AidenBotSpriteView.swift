import SwiftUI

// Drawing and motion for the Hi-bit sprite. Everything is on the 48-unit view
// box of the plan, then snapped to device pixels: no anti-aliasing, no scale on
// the body, and motion only in whole half-cell steps or opacity.

/// Where every part of the sprite is at one moment of a state. Every animated
/// value is stepped, so two moments between the same step edges make equal
/// poses and the canvas skips the redraw.
struct AidenBotSpritePose: Equatable {
    enum Eyes: Equatable { case open, happy, wince }

    var eyes = Eyes.open
    var lookX = 0.0
    var lookY = 0.0
    /// The open eyes' height, scaled about their centre. The blink's shut
    /// frame is 0.08, and it hides the glint.
    var lid = 1.0
    /// The open eyes' size, scaled about their centre (waiting).
    var eyeScale = 1.0
    var rigX = 0.0
    var rigY = 0.0
    /// The shift of every odd pair of rows (error).
    var glitchX = 0.0
    var dotOpacities: [Double]?
    var plugX: Double?
    var cursorOpacity: Double?
    /// Body and highlight cells' opacity.
    var bodyOpacity = 1.0
    /// Reading's scan: each pair of rows' opacity, outline included.
    var rowOpacities: [Double]?
    /// Writing's typing: each pair of columns' body and highlight opacity. It
    /// replaces `bodyOpacity`; outline cells hold at full.
    var columnOpacities: [Double]?

    /// The still pose: what Reduce Motion shows, and where motion starts and ends.
    init(still state: AidenBotAvatarState) {
        switch state {
        case .idle: break
        case .thinking: (lookX, lookY, dotOpacities) = (1.05, -1.19, [1, 1, 1])
        case .reading: (lookX, lookY, lid) = (-1.12, 0.63, 0.78)
        case .tool: (lookX, plugX) = (1.54, 0)
        case .writing: (lookY, bodyOpacity) = (1.19, 0.92)
        case .editing: (lookX, lookY, lid, cursorOpacity) = (0.84, 0.49, 0.5, 1)
        case .waiting: eyeScale = 1.14
        case .done: eyes = .happy
        case .error: (eyes, rigY, glitchX) = (.wince, 1.5, 1.5)
        }
    }

    /// The pose `elapsed` seconds after `state` began.
    init(state: AidenBotAvatarState, elapsed: TimeInterval) {
        self.init(still: state)
        let t = max(0, elapsed)
        switch state {
        case .idle:
            blink(at: Self.phase(t, 6))
        case .thinking:
            rigY = Self.phase(t, 1.2) < 0.5 ? 0 : -1.5
            dotOpacities = (0..<3).map { Self.phase(t - Double($0) * 0.3, 1.2) < 0.5 ? 0.25 : 1 }
        case .reading:
            // A stepped dip down the rows: each pair sits at .42 for 12–24% of
            // its 1.1 s loop, 0.11 s after the pair above.
            rowOpacities = (0..<8).map { pair in
                let p = Self.phase(t - Double(pair) * 0.11, 1.1)
                return p >= 0.12 && p < 0.24 ? 0.42 : 1
            }
        case .tool:
            let p = Self.phase(t, 1.2)
            plugX = p < 0.25 ? -4.5 : p < 0.5 ? -1.5 : p < 0.92 ? 0 : -3
        case .writing:
            // Typing across the columns: each pair starts 0.15 s after the one
            // to its left, holding .92 until then, then dips to .35 for the
            // first 35% of every 1.2 s loop.
            columnOpacities = (0..<8).map { pair in
                let delay = Double(pair) * 0.15
                guard t >= delay else { return 0.92 }
                return Self.phase(t - delay, 1.2) < 0.35 ? 0.35 : 0.92
            }
        case .editing:
            cursorOpacity = Self.phase(t, 1) < 0.5 ? 0.35 : 1
        case .waiting:
            rigY = Self.phase(t, 1.2) < 0.5 ? 0 : -0.75
            blink(at: Self.phase(t, 2.4))
        case .done:
            let p = t / 0.6
            rigY = p < 0.2 ? 0 : p < 0.45 ? -3 : p < 0.7 ? -4.5 : p < 0.85 ? -1.5 : 0
        case .error:
            // The odd-pair rows glitch while the rig drops; no sideways shake.
            guard t < 0.52 else { break }
            let quarter = Int(t / 0.13)
            glitchX = [-3, 3, -1.5, 1.5][quarter]
            rigY = quarter < 2 ? 0 : 1.5
        }
    }

    /// A body cell's opacity at grid column `x`, row `y`.
    func opacity(of cell: AidenBotSpriteCell, x: Int, y: Int) -> Double {
        let row = rowOpacities?[y >> 1] ?? 1
        if cell == .outline { return row }
        if let columnOpacities { return columnOpacities[x >> 1] * row }
        return bodyOpacity * row
    }

    /// The open eyes are shut (the blink's closed frame): no glint shows.
    var eyesShut: Bool { lid < 0.2 }

    /// Where `t` falls in a loop of `period` seconds, from 0 up to 1.
    static func phase(_ t: TimeInterval, _ period: TimeInterval) -> Double {
        let r = t.truncatingRemainder(dividingBy: period)
        return (r < 0 ? r + period : r) / period
    }

    /// A stepped blink over the last 3% of each loop, as on the desktop: the
    /// eyes snap shut to 0.08 and snap open again, with no frames between.
    private mutating func blink(at p: Double) {
        guard p >= 0.97 else { return }
        lid = 0.08
    }
}

/// When a state's pose can change: every step edge of its motion, measured
/// from the state's start. Loops repeat `edges` every `period`; done and error
/// play their edges once and then hold.
struct AidenBotSpriteSteps: Equatable {
    /// Seconds into the loop (or the one play) where a step lands, ascending.
    let edges: [TimeInterval]
    /// The loop's length; nil for a one-shot.
    let period: TimeInterval?

    init(_ state: AidenBotAvatarState) {
        switch state {
        case .idle: (edges, period) = ([0, 6 * 0.97], 6)
        case .thinking: (edges, period) = ([0, 0.3, 0.6, 0.9], 1.2)
        case .reading:
            var marks: [TimeInterval] = []
            for pair in 0..<8 {
                let delay = Double(pair) * 0.11
                marks.append((delay + 0.12 * 1.1).truncatingRemainder(dividingBy: 1.1))
                marks.append((delay + 0.24 * 1.1).truncatingRemainder(dividingBy: 1.1))
            }
            (edges, period) = (Self.sorted(marks), 1.1)
        case .tool: (edges, period) = ([0, 0.3, 0.6, 0.92 * 1.2], 1.2)
        case .writing:
            var marks: [TimeInterval] = []
            for pair in 0..<8 {
                let delay = Double(pair) * 0.15
                marks.append(delay)
                marks.append((delay + 0.35 * 1.2).truncatingRemainder(dividingBy: 1.2))
            }
            (edges, period) = (Self.sorted(marks), 1.2)
        case .editing: (edges, period) = ([0, 0.5], 1)
        case .waiting: (edges, period) = ([0, 0.6, 1.2, 1.8, 0.97 * 2.4], 2.4)
        case .done: (edges, period) = ([0, 0.2, 0.45, 0.7, 0.85].map { $0 * 0.6 }, nil)
        case .error: (edges, period) = ([0, 0.13, 0.26, 0.39, 0.52], nil)
        }
    }

    private static func sorted(_ marks: [TimeInterval]) -> [TimeInterval] {
        Array(Set(marks.map { ($0 * 1000).rounded() / 1000 })).sorted()
    }

    /// The step edges from `from` on, as seconds since the state began.
    func times(from: TimeInterval) -> AnyIterator<TimeInterval> {
        guard let period else {
            var rest = edges.filter { $0 >= from }[...]
            return AnyIterator { rest.popFirst() }
        }
        var loop = max(0, (from / period).rounded(.down))
        var index = edges.firstIndex { loop * period + $0 >= from } ?? edges.count
        return AnyIterator {
            if index == edges.count { loop += 1; index = 0 }
            defer { index += 1 }
            return loop * period + edges[index]
        }
    }
}

/// Wakes a sprite's timeline only on its pose's step edges, rather than at a
/// fixed frame rate: a held pose costs nothing between them.
struct AidenBotSpriteSchedule: TimelineSchedule {
    let start: Date
    let steps: AidenBotSpriteSteps

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> AnyIterator<Date> {
        // A millisecond past each edge, so the pose read at that date is the new step's.
        let times = steps.times(from: startDate.timeIntervalSince(start))
        var first: Date? = startDate
        return AnyIterator {
            if let date = first { first = nil; return date }
            return times.next().map { start.addingTimeInterval($0 + 0.001) }
        }
    }
}

/// The sprite itself, drawn into a `Canvas`.
struct AidenBotSpriteCanvas: View, Equatable {
    let shape: AidenBotAvatarShape
    let color: AidenBotAvatarColor
    let size: CGFloat
    let pose: AidenBotSpritePose

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale

    /// Equal poses skip the redraw (the environment still redraws on change).
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.shape == rhs.shape && lhs.color == rhs.color && lhs.size == rhs.size && lhs.pose == rhs.pose
    }

    var body: some View {
        Canvas { context, _ in
            AidenBotSpritePainter(
                shape: shape,
                tone: color.spriteTone,
                size: Double(size),
                scale: Double(max(displayScale, 1)),
                dark: colorScheme == .dark,
                pose: pose
            ).paint(into: &context)
        }
        .frame(width: size, height: size)
    }
}

private struct AidenBotSpritePainter {
    let shape: AidenBotAvatarShape
    let tone: AidenBotSpriteTone
    let size: Double
    let scale: Double
    let dark: Bool
    let pose: AidenBotSpritePose

    private var unit: Double { size / AidenBotSprite.viewBox }
    private var small: Bool { AidenBotSprite.isSmallCut(size: size) }
    private static let crisp = FillStyle(antialiased: false)

    private func snap(_ value: Double) -> CGFloat { CGFloat((value * unit * scale).rounded() / scale) }

    /// A view-box rect, moved with the rig and snapped to whole device pixels.
    private func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect {
        let left = snap(x + pose.rigX), top = snap(y + pose.rigY)
        return CGRect(x: left, y: top, width: snap(x + w + pose.rigX) - left, height: snap(y + h + pose.rigY) - top)
    }

    private func fill(_ path: Path, _ rgb: UInt32, opacity: Double = 1, in context: inout GraphicsContext) {
        context.fill(path, with: .color(Color(aidenRGB: rgb).opacity(opacity)), style: Self.crisp)
    }

    func paint(into context: inout GraphicsContext) {
        let grid = AidenBotSprite.grid(for: shape, small: small)
        paintBody(grid, into: &context)
        paintEyes(into: &context)
        paintProps(top: AidenBotSprite.topRow(of: grid), into: &context)
    }

    private struct LayerKey: Hashable {
        let rgb: UInt32
        /// Opacity in hundredths.
        let opacity: Int
    }

    private func paintBody(_ grid: [[AidenBotSpriteCell]], into context: inout GraphicsContext) {
        // One path per colour and opacity, so a scan still draws in a handful of fills.
        var layers: [LayerKey: Path] = [:]
        for (y, row) in grid.enumerated() {
            let shift = (y >> 1) % 2 == 1 ? pose.glitchX : 0
            for (x, cell) in row.enumerated() where cell != .empty {
                let rgb = cell == .outline ? tone.shade : cell == .highlight ? tone.light : tone.tint
                let key = LayerKey(rgb: rgb, opacity: Int((pose.opacity(of: cell, x: x, y: y) * 100).rounded()))
                layers[key, default: Path()].addRect(rect(Double(x) * 3 + shift, Double(y) * 3, 3, 3))
            }
        }
        for (key, path) in layers { fill(path, key.rgb, opacity: Double(key.opacity) / 100, in: &context) }
    }

    /// The two eye boxes before any state moves them.
    private var eyeBoxes: [(x: Double, y: Double, w: Double, h: Double)] {
        [15.0, 27.0].map { small ? ($0, 18, 6, 6) : ($0 + 0.5, 18, 5, 6) }
    }

    private func paintEyes(into context: inout GraphicsContext) {
        switch pose.eyes {
        case .open: paintOpenEyes(into: &context)
        case .happy, .wince: paintStrokeEyes(into: &context)
        }
    }

    private func paintOpenEyes(into context: inout GraphicsContext) {
        let boxes = eyeBoxes
        let centreX = (boxes[0].x + boxes[1].x + boxes[1].w) / 2
        let centreY = boxes[0].y + boxes[0].h / 2
        var eyes = Path(), glints = Path()
        for box in boxes {
            // Scale the pair about its centre, close the lid about it, then look.
            let s = pose.eyeScale
            let x = centreX + (box.x - centreX) * s + pose.lookX
            let w = box.w * s
            let h = box.h * s * pose.lid
            let y = centreY - h / 2 + pose.lookY
            eyes.addRect(rect(x, y, w, h))
            // A glint square at the eye's top-left, hidden while the blink is shut.
            if !pose.eyesShut {
                let glint = 0.42 * min(box.w, box.h) * s
                glints.addRect(rect(x, y, glint, glint * pose.lid))
            }
        }
        // The eyes are `deep` at every size; the small cut's glint is white so it
        // still reads at list sizes, where the full cut's `light` would blur away.
        fill(eyes, tone.deep, in: &context)
        fill(glints, small ? AidenBotSprite.smallGlintRGB : tone.light, in: &context)
    }

    private func paintStrokeEyes(into context: inout GraphicsContext) {
        let sw = small ? 2.4 : 1.6
        var strokes = Path()
        for (index, box) in eyeBoxes.enumerated() {
            let points: [(Double, Double)]
            if pose.eyes == .happy {
                points = [
                    (box.x + sw / 2, box.y + 0.78 * box.h),
                    (box.x + box.w / 2, box.y + 0.2 * box.h),
                    (box.x + box.w - sw / 2, box.y + 0.78 * box.h),
                ]
            } else {
                // `>` on the left, `<` on the right.
                let near = box.x + sw / 2, far = box.x + box.w - sw / 2
                let (x0, x1) = index == 0 ? (near, far) : (far, near)
                points = [(x0, box.y + sw / 2), (x1, box.y + box.h / 2), (x0, box.y + box.h - sw / 2)]
            }
            strokes.addLines(points.map {
                CGPoint(x: ($0.0 + pose.rigX) * unit, y: ($0.1 + pose.rigY) * unit)
            })
        }
        let outline = strokes.strokedPath(StrokeStyle(lineWidth: sw * unit, lineCap: .square, lineJoin: .miter))
        fill(outline, tone.deep, in: &context)
    }

    private func paintProps(top: Int, into context: inout GraphicsContext) {
        let mark = dark ? tone.markDark : tone.markLight
        if let dots = pose.dotOpacities {
            let y = max(0.5, Double(top) * 3 - 4)
            for (index, opacity) in dots.enumerated() {
                fill(Path(rect(36 + Double(index) * 3.9, y, 2.6, 2.6)), mark, opacity: opacity, in: &context)
            }
        }
        if let plugX = pose.plugX {
            fill(Path(rect(42 + plugX, 27, 4.5, 3)), tone.shade, in: &context)
            fill(Path(rect(42 + 4.5 - 0.6 + plugX, 27 - 1.05, 3.3, 5.1)), mark, in: &context)
        }
        if let cursor = pose.cursorOpacity {
            fill(Path(rect(45, 16.5, 2, 8)), mark, opacity: cursor, in: &context)
        }
    }
}

// MARK: - Live state

extension AidenBotAvatarSignal {
    /// A Bot chat's signal: the running turn, its activity, and its cards.
    @MainActor
    init(model: AidenBotSessionModel) {
        let waiting = model.approval != nil || model.question != nil
            || model.handoff != nil || model.accessRequest != nil
            || (model.plansSupported && model.plan?.status == .pending)
        let failed: Bool = if case .failedTurn = model.entries.last { true } else { false }
        self.init(
            working: model.isRunning,
            sending: model.isAwaitingTurn,
            phase: model.activity?.phase,
            streamingText: !(model.partial ?? "").isEmpty,
            waitingForPerson: waiting,
            lastTurnFailed: failed,
            session: model.state,
            stopped: model.stopRequestedThisTurn || model.activity?.phase == "stopping",
            runId: model.activity?.startedAt
        )
    }
}

/// Feeds a signal through the settler and hands its shown state to `content`.
struct AidenBotSettledAvatarState<Content: View>: View {
    let signal: AidenBotAvatarSignal
    /// Whether a finished turn shows done; the Bots list's rows don't.
    var showsDone = true
    /// Told each state the avatar shows, so a label elsewhere can speak it.
    var onShownChange: ((AidenBotAvatarState) -> Void)? = nil
    @ViewBuilder let content: (AidenBotAvatarState) -> Content

    @State private var settler: AidenBotAvatarStateSettler

    init(
        signal: AidenBotAvatarSignal,
        showsDone: Bool = true,
        onShownChange: ((AidenBotAvatarState) -> Void)? = nil,
        @ViewBuilder content: @escaping (AidenBotAvatarState) -> Content
    ) {
        self.signal = signal
        self.showsDone = showsDone
        self.onShownChange = onShownChange
        self.content = content
        _settler = State(initialValue: AidenBotAvatarStateSettler(signal: signal, at: Self.now, showsDone: showsDone))
    }

    private static var now: TimeInterval { Date().timeIntervalSinceReferenceDate }

    var body: some View {
        content(settler.shown)
            // A view coming back on screen picks up where the Bot is now,
            // never replaying an ending it already showed.
            .onAppear { settler.resync(signal, at: Self.now) }
            .onChange(of: signal) { _, next in settler.receive(next, at: Self.now) }
            .onChange(of: settler.shown, initial: true) { _, shown in onShownChange?(shown) }
            .task(id: settler) {
                guard let wake = settler.nextWake else { return }
                let delay = max(0, wake - Self.now)
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000) + 1_000_000)
                guard !Task.isCancelled else { return }
                settler.advance(to: Self.now)
            }
    }
}
