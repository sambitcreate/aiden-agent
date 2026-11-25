import SwiftUI

/// What the ambient background behind Home says about the person's work, in
/// the order one state outranks another: a listening mic first, then anything
/// waiting on the person, an unread failure, a run that just finished, live
/// work, and quiet.
enum AidenAmbientActivity: String, CaseIterable, Sendable {
    case listening
    case needsYou
    case failed
    case done
    case working
    case idle
}

/// One running or waiting thing on one machine: a chat, a Bot, a routine.
/// `scope` is the machine, so a machine dropping offline can forget its work
/// without that looking like the work finishing.
struct AidenActivityKey: Hashable, Sendable {
    let scope: String
    let id: String
}

/// The inputs to the ambient state, read from the latest inbox snapshots and
/// the voice composer. Plain values, so the reducer can be driven by tests.
struct AidenActivitySignals: Equatable, Sendable {
    /// Running chats, Bots and routines.
    var working: Set<AidenActivityKey> = []
    /// Chats and Bots waiting on an approval or an answer.
    var needsYou: Set<AidenActivityKey> = []
    /// Chats whose last run failed and that the person has not read.
    var failed: Set<AidenActivityKey> = []
    /// Machines whose lists are live (fetched this session, online, shown).
    /// Work on any other machine never counts as finishing.
    var liveScopes: Set<String> = []
    /// The chat that is open beside Home, if any. It finishing is already on
    /// screen, so it does not flash Done.
    var focused: AidenActivityKey?
    var listening = false
    /// The mic's level, 0...1, while listening.
    var micLevel: Double = 0

    /// Reads the signals from the inbox's snapshots: every online, unblocked,
    /// shown machine, whatever the list's filter or search says.
    static func make(
        snapshots: [AidenHostInboxSnapshot],
        hiddenMachines: Set<String>,
        focusedChat: AidenHostObjectID? = nil,
        listening: Bool = false,
        micLevel: Double = 0
    ) -> AidenActivitySignals {
        var signals = AidenActivitySignals(listening: listening, micLevel: min(max(micLevel, 0), 1))
        for snapshot in snapshots
        where snapshot.isOnline && !snapshot.isBlocked && !hiddenMachines.contains(snapshot.instanceId) {
            let scope = snapshot.instanceId
            if snapshot.fetchedAt != nil { signals.liveScopes.insert(scope) }
            for chat in snapshot.chats {
                let key = AidenActivityKey(scope: scope, id: "chat:\(chat.id)")
                switch chat.displayRowState {
                case .working: signals.working.insert(key)
                case .needsApproval, .needsInput: signals.needsYou.insert(key)
                case .idle: break
                }
                if chat.showsFailed { signals.failed.insert(key) }
            }
            for bot in snapshot.bots {
                let key = AidenActivityKey(scope: scope, id: "bot:\(bot.id)")
                if AidenBotAttention.isRunning(bot) { signals.working.insert(key) }
                if AidenBotAttention.needsYou(bot) { signals.needsYou.insert(key) }
            }
        }
        if let focusedChat, signals.liveScopes.contains(focusedChat.instanceId) {
            signals.focused = AidenActivityKey(scope: focusedChat.instanceId, id: "chat:\(focusedChat.objectId)")
        }
        return signals
    }
}

/// The ambient state over time. Pure: every change takes the time it happens,
/// so tests drive it with fixed dates.
///
/// - Work that stops is held as Working for `settleInterval` first, so a run
///   that pauses between steps does not flicker.
/// - Done comes only from a run seen working and then seen stopping on a live
///   machine. A first load, a reconnect or a machine going offline never
///   shows it. It lasts `doneInterval`, then the state falls back to whatever
///   is still true (Working if another run continues, otherwise Idle).
struct AidenAuroraState: Equatable, Sendable {
    static let settleInterval: TimeInterval = 0.6
    static let doneInterval: TimeInterval = 2

    private(set) var signals = AidenActivitySignals()
    /// Work seen running on the last read; nil before the first read.
    private var lastWorking: Set<AidenActivityKey>?
    /// Work that stopped and when, while it settles.
    private var stopping: [AidenActivityKey: Date] = [:]
    private var doneUntil: Date?

    init() {}

    /// Takes a new read of the signals.
    mutating func apply(_ next: AidenActivitySignals, now: Date) {
        settle(now: now)
        if let lastWorking {
            for key in lastWorking.subtracting(next.working) where next.liveScopes.contains(key.scope) {
                stopping[key] = now
            }
        }
        for key in Array(stopping.keys) where next.working.contains(key) || !next.liveScopes.contains(key.scope) {
            stopping[key] = nil
        }
        // Only work on a live machine is remembered, so a machine that comes
        // back starts from what it says then.
        lastWorking = next.working.filter { next.liveScopes.contains($0.scope) }
        signals = next
    }

    /// Lets time pass: settled stops become Done or nothing, and Done expires.
    mutating func settle(now: Date) {
        for (key, stoppedAt) in stopping where now.timeIntervalSince(stoppedAt) >= Self.settleInterval {
            stopping[key] = nil
            let finished = !signals.needsYou.contains(key)
                && !signals.failed.contains(key)
                && signals.focused != key
            if finished {
                doneUntil = stoppedAt.addingTimeInterval(Self.settleInterval + Self.doneInterval)
            }
        }
        if let doneUntil, now >= doneUntil { self.doneUntil = nil }
    }

    /// The state at `now`. Call `settle(now:)` first for a change in time alone.
    func phase(at now: Date) -> AidenAmbientActivity {
        if signals.listening { return .listening }
        if !signals.needsYou.isEmpty { return .needsYou }
        if !signals.failed.isEmpty { return .failed }
        if let doneUntil, now < doneUntil { return .done }
        if !signals.working.isEmpty || !stopping.isEmpty { return .working }
        return .idle
    }

    /// The next time the state can change with no new read, if any.
    var nextChange: Date? {
        let settles = stopping.values.map { $0.addingTimeInterval(Self.settleInterval) }
        return (settles + [doneUntil].compactMap { $0 }).min()
    }
}

/// How the ambient background draws a state: which palette colour, how strong
/// (a share of the level's opacity cap), and how fast the mesh drifts.
struct AidenAuroraTone: Equatable, Sendable {
    enum Hue: Sendable { case secondary, activity, warning, success, danger }

    let hue: Hue
    /// 0...1, the state's lightness over the brightest state's.
    let intensity: Double
    /// Drift speed, as a multiple of a full cycle every 20 s.
    let speed: Double

    static func of(_ activity: AidenAmbientActivity, micLevel: Double = 0) -> AidenAuroraTone {
        switch activity {
        case .idle: AidenAuroraTone(hue: .secondary, intensity: 0.32 / 0.85, speed: 0.12)
        case .working: AidenAuroraTone(hue: .activity, intensity: 0.80 / 0.85, speed: 0.5)
        case .listening:
            AidenAuroraTone(hue: .activity, intensity: 1, speed: 0.3 + 0.9 * min(max(micLevel, 0), 1))
        case .needsYou: AidenAuroraTone(hue: .warning, intensity: 0.75 / 0.85, speed: 0.3)
        case .done: AidenAuroraTone(hue: .success, intensity: 0.65 / 0.85, speed: 0.25)
        case .failed: AidenAuroraTone(hue: .danger, intensity: 0.42 / 0.85, speed: 0.1)
        }
    }

    func hex(in palette: AidenPalette) -> String {
        switch hue {
        case .secondary: palette.secondaryHex
        case .activity: palette.activityHex
        case .warning: palette.warningHex
        case .success: palette.successHex
        case .danger: palette.dangerHex
        }
    }
}

/// The person's choice for the ambient background.
enum AidenAuroraLevel: String, CaseIterable, Identifiable, Sendable {
    case off, subtle, vivid

    var id: String { rawValue }

    var title: String {
        switch self {
        case .off: "Off"
        case .subtle: "Subtle"
        case .vivid: "Vivid"
        }
    }

    /// The opacity the brightest state aims for before the contrast cap.
    var nominalOpacity: Double {
        switch self {
        case .off: 0
        case .subtle: 0.35
        case .vivid: 0.6
        }
    }

    /// How far the bright centre of the mesh spreads toward its edges.
    var spread: Double {
        switch self {
        case .off: 0
        case .subtle: 0.7
        case .vivid: 1
        }
    }
}

enum AidenAuroraContrast {
    /// Body text over the brightest point of the background.
    static let minimumForegroundContrast = 4.5
    /// Secondary text (captions, timestamps) over the brightest point.
    static let minimumSecondaryContrast = 3.0

    /// The strongest opacity for `level` at which every state's colour, at
    /// full strength over the canvas, still leaves the palette's text legible.
    /// Halved again under Increase Contrast.
    static func maximumOpacity(
        _ level: AidenAuroraLevel,
        palette: AidenPalette,
        increasedContrast: Bool = false
    ) -> Double {
        let hues = AidenAmbientActivity.allCases.map { AidenAuroraTone.of($0).hex(in: palette) }
        // Whole hundredths, so two levels that both stop at the same step
        // come out exactly equal.
        var hundredths = Int((level.nominalOpacity * 100).rounded())
        func legible(_ opacity: Double) -> Bool {
            hues.allSatisfy { isLegible(over: composite($0, opacity: opacity, palette: palette), palette: palette) }
        }
        while hundredths > 0, !legible(Double(hundredths) / 100) {
            hundredths -= 1
        }
        let opacity = Double(hundredths) / 100
        return increasedContrast ? opacity / 2 : opacity
    }

    /// `hex` laid at `opacity` over the canvas.
    static func composite(_ hex: String, opacity: Double, palette: AidenPalette) -> String {
        Color.mixHex(palette.canvasHex, hex, fraction: opacity)
    }

    static func isLegible(over groundHex: String, palette: AidenPalette) -> Bool {
        Color.contrastRatio(palette.foregroundHex, groundHex) >= minimumForegroundContrast
            && Color.contrastRatio(palette.secondaryHex, groundHex) >= minimumSecondaryContrast
    }
}
