import Foundation

// The Hi-bit pixel sprite every Bot without a photo wears
// (docs/plans/hibit-sprite-avatars-plan.md). The bodies and tones are copies of
// `botAvatarSprite` in the shared contract fixture, and tests hold them equal.

/// One cell of the expanded 16×16 sprite grid.
enum AidenBotSpriteCell: Character, Sendable {
    case empty = "."
    case outline = "o"
    case body = "b"
    case highlight = "h"
}

/// A Bot colour's precomputed sprite tones, as 0xRRGGBB.
struct AidenBotSpriteTone: Equatable, Sendable {
    /// The body.
    let tint: UInt32
    /// The outline and the plug arm.
    let shade: UInt32
    /// The eyes and the happy and wince strokes.
    let deep: UInt32
    /// Highlight cells and the eye glint.
    let light: UInt32
    /// The state props in light appearance.
    let markLight: UInt32
    /// The state props in dark appearance.
    let markDark: UInt32
}

enum AidenBotSprite {
    static let gridSize = 16
    static let viewBox: Double = 48
    /// At this drawn size and below the sprite draws its small cut: no
    /// highlight cells, bolder eyes, and a white glint in place of the `light` one.
    static let smallMaxPoints: Double = 24
    /// The small cut's eye glint. Its eyes stay `deep` in every pose.
    static let smallGlintHex = "#FFFFFF"
    static let smallGlintRGB: UInt32 = 0xFFFFFF

    static func isSmallCut(size: Double) -> Bool { size <= smallMaxPoints }

    /// The curated body each shape names: 12 rows of 6 mirrored half-columns.
    /// `1` is body, `2` is outline and `0` is empty.
    static func body(for shape: AidenBotAvatarShape) -> String {
        switch shape {
        case .wisp: "000000/000011/000111/002111/002111/001111/111111/111211/012111/001111/001101/001000"
        case .orb: "000000/000011/000111/001111/001111/011111/121111/012111/002112/001111/000010/001000"
        case .drop: "000010/000111/000111/002111/001111/011111/111111/121111/001111/001111/000111/001100"
        case .hex: "000010/000111/000121/011111/011111/001111/021111/021211/011111/001101/000000/000000"
        case .cloud: "000001/000011/000211/001111/002111/011111/021111/021111/011112/012101/001111/000000"
        case .peak: "000010/000011/000111/001111/001111/001111/011111/111111/002111/011111/001000/001100"
        case .squircle: "000000/000111/000111/001111/012111/011111/021111/011111/012111/012111/001111/001000"
        case .capsule: "000001/000122/001111/011111/011111/001111/011111/011211/012111/001111/001011/001000"
        }
    }

    /// The expanded grid, rows top to bottom.
    static func grid(for shape: AidenBotAvatarShape, small: Bool) -> [[AidenBotSpriteCell]] {
        let grids = small ? smallGrids : fullGrids
        return grids[shape] ?? expand(body: body(for: shape), small: small)
    }

    /// The first row with any body or outline cell.
    static func topRow(of grid: [[AidenBotSpriteCell]]) -> Int {
        grid.firstIndex { row in row.contains { $0 != .empty } } ?? 0
    }

    private static let fullGrids = Dictionary(uniqueKeysWithValues: AidenBotAvatarShape.allCases.map {
        ($0, expand(body: body(for: $0), small: false))
    })
    private static let smallGrids = Dictionary(uniqueKeysWithValues: AidenBotAvatarShape.allCases.map {
        ($0, expand(body: body(for: $0), small: true))
    })

    /// Expands a body string to the 16×16 grid (plan steps 1–5).
    static func expand(body: String, small: Bool) -> [[AidenBotSpriteCell]] {
        let size = gridSize
        var isBody = Array(repeating: Array(repeating: false, count: size), count: size)
        var isOutline = isBody
        // Place the mirrored body rows.
        for (ry, row) in body.split(separator: "/").enumerated() {
            for (h, value) in row.enumerated() {
                let y = ry + 2
                guard y < size else { continue }
                for x in [2 + h, 13 - h] where x >= 0 && x < size {
                    if value == "1" { isBody[y][x] = true }
                    if value == "2" { isOutline[y][x] = true }
                }
            }
        }
        func bodyAt(_ x: Int, _ y: Int) -> Bool {
            x >= 0 && y >= 0 && x < size && y < size && isBody[y][x]
        }
        // Auto outline: every empty cell beside the body.
        for y in 0..<size {
            for x in 0..<size where !isBody[y][x] {
                if bodyAt(x - 1, y) || bodyAt(x + 1, y) || bodyAt(x, y - 1) || bodyAt(x, y + 1) {
                    isOutline[y][x] = true
                }
            }
        }
        // Drop outline cells that touch no body cell, even diagonally.
        for y in 0..<size {
            for x in 0..<size where isOutline[y][x] {
                var touches = false
                for dy in -1...1 {
                    for dx in -1...1 where (dx != 0 || dy != 0) && bodyAt(x + dx, y + dy) { touches = true }
                }
                if !touches { isOutline[y][x] = false }
            }
        }
        return (0..<size).map { y in
            (0..<size).map { x in
                if isBody[y][x] {
                    return !small && y < 9 && !bodyAt(x, y - 1) ? .highlight : .body
                }
                return isOutline[y][x] ? .outline : .empty
            }
        }
    }
}

extension AidenBotAvatarColor {
    var spriteTone: AidenBotSpriteTone {
        switch self {
        case .lilac: .init(tint: 0xC6A9FF, shade: 0xA87EEE, deep: 0x42246C, light: 0xF8F5FE, markLight: 0x8C58D8, markDark: 0xC6A9FF)
        case .sky: .init(tint: 0x83D8FF, shade: 0x2EB7EB, deep: 0x003E54, light: 0xEFF9FD, markLight: 0x0686B0, markDark: 0x83D8FF)
        case .mint: .init(tint: 0x88E8B1, shade: 0x35CB84, deep: 0x004427, light: 0xE8FDF0, markLight: 0x0E915A, markDark: 0x88E8B1)
        case .sun: .init(tint: 0xFFDA7B, shade: 0xE4B416, deep: 0x463502, light: 0xFEF6E2, markLight: 0x96760D, markDark: 0xFFDA7B)
        case .periwinkle: .init(tint: 0xB2BCFF, shade: 0x8C96EE, deep: 0x2C2C74, light: 0xF5F6FC, markLight: 0x676ED0, markDark: 0xB2BCFF)
        case .coral: .init(tint: 0xFF9F9B, shade: 0xEB6F6E, deep: 0x681118, light: 0xFFF4F3, markLight: 0xCE4146, markDark: 0xFF9F9B)
        case .peach: .init(tint: 0xFFC294, shade: 0xE89858, deep: 0x562B01, light: 0xFDF5EF, markLight: 0xB4620A, markDark: 0xFFC294)
        case .aqua: .init(tint: 0x78E8DF, shade: 0x16C8BE, deep: 0x06413E, light: 0xE3FDFA, markLight: 0x008D86, markDark: 0x78E8DF)
        case .rose: .init(tint: 0xFFA3C7, shade: 0xE973A6, deep: 0x63123B, light: 0xFEF4F7, markLight: 0xC64080, markDark: 0xFFA3C7)
        case .lime: .init(tint: 0xC6EC7E, shade: 0x9DCB1D, deep: 0x2E3F01, light: 0xF2FAE6, markLight: 0x678800, markDark: 0xC6EC7E)
        case .plum: .init(tint: 0xDDA8F2, shade: 0xC27CDD, deep: 0x4F1E60, light: 0xFBF4FE, markLight: 0xA251C0, markDark: 0xDDA8F2)
        case .graphite: .init(tint: 0xC5C5CE, shade: 0xA2A1B3, deep: 0x36354B, light: 0xF6F6F9, markLight: 0x797988, markDark: 0xC5C5CE)
        }
    }
}

// MARK: - States

/// What a Bot's sprite shows (the plan's state table).
enum AidenBotAvatarState: String, CaseIterable, Sendable {
    case idle, thinking, reading, tool, writing, editing, waiting, done, error

    /// Done and error play once, then settle back to idle.
    var isOutcome: Bool { self == .done || self == .error }

    /// A turn is running or waiting on the person.
    var isWorking: Bool { self != .idle && !isOutcome }

    /// What VoiceOver reads for a live avatar; nil when it rests.
    var accessibilityValue: String? {
        switch self {
        case .idle: nil
        case .thinking: String(localized: "Thinking")
        case .reading: String(localized: "Reading")
        case .tool: String(localized: "Using a tool")
        case .writing: String(localized: "Writing")
        case .editing: String(localized: "Editing")
        case .waiting: String(localized: "Waiting for you")
        case .done: String(localized: "Done")
        case .error: String(localized: "Something went wrong")
        }
    }
}

/// The activity a Bot's avatar reads its state from: the same signal that
/// drives the chat's status line and the Bots home "Working" cue.
struct AidenBotAvatarSignal: Equatable, Sendable {
    /// A turn is running.
    var working = false
    /// The person's message is on its way and no turn has started yet.
    var sending = false
    /// The running turn's raw activity phase (`AidenBotActivityPhase`), when known.
    var phase: String?
    /// The answer is streaming in.
    var streamingText = false
    /// An approval, question, hand-off, access request or pending plan is waiting for the person.
    var waitingForPerson = false
    /// The last turn failed.
    var lastTurnFailed = false
    /// The session's state, when known: interrupted and needs-model end a turn
    /// in error, and paused ends it quietly.
    var session: AidenBotSessionStateKind?
    /// The person stopped the turn. The settler latches it until the next turn
    /// starts, so a stop and the turn's end landing together stay quiet.
    var stopped = false
}

extension AidenBotAvatarSignal {
    /// A legacy Bot chat's signal, from its stream and its cards. Through the
    /// settler, a pending approval or question shows waiting, queued, running
    /// and reconciling show thinking, a stream ending in error or interrupted
    /// shows error, one ending done shows done, and a cancelled or stopping
    /// stream, or none, ends quietly.
    init(stream: AidenStreamState?, isStopping: Bool, awaitingPerson: Bool = false) {
        let active = stream.map { !$0.isTerminal } ?? false
        self.init(
            working: active,
            waitingForPerson: awaitingPerson || stream == .waitingForApproval,
            lastTurnFailed: stream == .error || stream == .interrupted,
            // A stream cleared mid-run was abandoned (a failed send or a removed
            // chat), so it ends as quietly as a stop.
            stopped: isStopping || stream == .cancelled || stream == nil
        )
    }
}

private let aidenBotFailedSessions: Set<AidenBotSessionStateKind> = [.interrupted, .needsModel]

/// The state a signal heads to, before the settler. Done is never a target:
/// the settler shows it when a shown working state ends. A failed turn or
/// session targets error.
func aidenBotAvatarState(for signal: AidenBotAvatarSignal) -> AidenBotAvatarState {
    if signal.waitingForPerson { return .waiting }
    guard signal.working else {
        if signal.sending { return .thinking }
        let failed = signal.lastTurnFailed || signal.session.map(aidenBotFailedSessions.contains) == true
        return failed ? .error : .idle
    }
    // Streamed text is the reply when the turn says nothing else, or says it writes.
    if signal.streamingText, signal.phase == nil || signal.phase == "writing" { return .writing }
    switch signal.phase {
    case nil, "thinking", "preparing", "tidying", "resuming", "stopping", "reconnecting": return .thinking
    case "reading", "photo", "searching": return .reading
    case "editing": return .editing
    case "writing": return .writing
    case "waiting": return .waiting
    default: return .tool
    }
}

/// Turns a stream of signals into what the avatar shows, as the desktop's
/// settler does. Working states wait out a short debounce so quick tool bursts
/// don't flicker. When a shown working state ends, done (or error) shows at
/// once and holds for a moment before idle. A turn that ended before any
/// working pose showed, a Stop, or a pause settles quietly to idle. An error
/// that follows no work stays idle; one landing during done replaces it. Time
/// is passed in, so tests drive it without waiting.
struct AidenBotAvatarStateSettler: Equatable, Sendable {
    static let debounce: TimeInterval = 0.25
    static let outcomeHold: TimeInterval = 1.5

    /// Whether a finished turn shows done. A phone's Bots list can't tell a
    /// normal end from a Stop or a failure, so its rows settle to idle instead.
    let showsDone: Bool
    private(set) var shown: AidenBotAvatarState
    /// When `shown` took over.
    private(set) var shownAt: TimeInterval
    private(set) var pending: AidenBotAvatarState?
    private var pendingDue: TimeInterval = 0
    /// The newest target.
    private var target: AidenBotAvatarState
    /// A turn ran since the last ending; a send that never started one ends quietly.
    private var turnRan: Bool
    private var wasWorking: Bool
    /// The person stopped this turn; cleared when the next turn starts.
    private var stopLatched: Bool

    /// Starts on the signal's live state at once: a view that appears mid-turn
    /// shows the turn, and one that appears after it shows idle, never a past
    /// done or error.
    init(signal: AidenBotAvatarSignal, at now: TimeInterval, showsDone: Bool = true) {
        let live = aidenBotAvatarState(for: signal)
        self.showsDone = showsDone
        shown = live.isWorking ? live : .idle
        shownAt = now
        target = shown
        turnRan = signal.working
        wasWorking = signal.working
        stopLatched = signal.stopped
    }

    mutating func receive(_ signal: AidenBotAvatarSignal, at now: TimeInterval) {
        advance(to: now)
        if signal.stopped {
            stopLatched = true
        } else if signal.working, !wasWorking {
            stopLatched = false
        }
        if signal.working { turnRan = true }
        wasWorking = signal.working
        let next = aidenBotAvatarState(for: signal)
        // A failure reported just after the end still replaces its done.
        let lateFailure = next == .error && shown == .done
        if !next.isWorking, stopLatched || signal.session == .paused || (!turnRan && !lateFailure) {
            target = next
            turnRan = false
            show(.idle, at: now)
            return
        }
        guard next != target else { return }
        let targetWasWorking = target.isWorking
        target = next
        if next.isWorking {
            if shown == next { pending = nil } else { schedule(next, at: now + Self.debounce) }
            return
        }
        turnRan = false
        if targetWasWorking, shown.isWorking {
            // The shown turn ended: its outcome shows at once.
            if next == .error || showsDone {
                show(next == .error ? .error : .done, at: now)
                schedule(.idle, at: now + Self.outcomeHold)
            } else {
                show(.idle, at: now)
            }
        } else if next == .error, shown == .done {
            // The failure arrived just after the end: it replaces done.
            show(.error, at: now)
            schedule(.idle, at: now + Self.outcomeHold)
        } else if shown.isOutcome {
            // An outcome on screen finishes its moment.
            schedule(.idle, at: shownAt + Self.outcomeHold)
        } else {
            // Work ended before the debounce showed it: settle quietly.
            show(.idle, at: now)
        }
    }

    /// Shows the signal's live state at once, with no outcome: a view coming
    /// back on screen picks up where the Bot is, never replaying a past ending.
    mutating func resync(_ signal: AidenBotAvatarSignal, at now: TimeInterval) {
        self = Self(signal: signal, at: now, showsDone: showsDone)
    }

    /// Applies whatever is due by `now`.
    mutating func advance(to now: TimeInterval) {
        guard let next = pending, now >= pendingDue else { return }
        pending = nil
        shown = next
        shownAt = pendingDue
    }

    /// When `advance` next has something to do, or nil when nothing is due.
    var nextWake: TimeInterval? { pending == nil ? nil : pendingDue }

    private mutating func show(_ state: AidenBotAvatarState, at now: TimeInterval) {
        pending = nil
        guard state != shown else { return }
        shown = state
        shownAt = now
    }

    private mutating func schedule(_ state: AidenBotAvatarState, at due: TimeInterval) {
        pending = state
        pendingDue = due
    }
}
