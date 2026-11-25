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
    /// Chats and Bots still listed and resting normally: an idle chat that
    /// did not fail, an idle Bot with nothing waiting. Only work that stops
    /// into this counts as finishing; a chat archived or deleted, or a Bot
    /// paused or unavailable, is not a finish.
    var quiet: Set<AidenActivityKey> = []
    /// Machines whose lists are live (fetched this session, online, shown).
    /// Work on any other machine never counts as finishing.
    var liveScopes: Set<String> = []
    /// When each live machine's list was last fetched, so a machine that
    /// comes back counts as live only from its first fresh list.
    var fetchedAt: [String: Date] = [:]
    /// The chat that is open beside Home, if any. It finishing is already on
    /// screen, so it does not flash Done.
    var focused: AidenActivityKey?
    var listening = false

    /// Reads the signals from the inbox's snapshots: every online, unblocked,
    /// shown machine, whatever the list's filter or search says.
    static func make(
        snapshots: [AidenHostInboxSnapshot],
        hiddenMachines: Set<String>,
        focusedChat: AidenHostObjectID? = nil,
        listening: Bool = false
    ) -> AidenActivitySignals {
        var signals = AidenActivitySignals(listening: listening)
        for snapshot in snapshots
        where snapshot.isOnline && !snapshot.isBlocked && !hiddenMachines.contains(snapshot.instanceId) {
            let scope = snapshot.instanceId
            if let fetchedAt = snapshot.fetchedAt {
                signals.liveScopes.insert(scope)
                signals.fetchedAt[scope] = fetchedAt
            }
            for chat in snapshot.chats {
                let key = AidenActivityKey(scope: scope, id: "chat:\(chat.id)")
                switch chat.displayRowState {
                case .working: signals.working.insert(key)
                case .needsApproval, .needsInput: signals.needsYou.insert(key)
                case .idle: if !chat.showsFailed { signals.quiet.insert(key) }
                }
                if chat.showsFailed { signals.failed.insert(key) }
            }
            for bot in snapshot.bots {
                let key = AidenActivityKey(scope: scope, id: "bot:\(bot.id)")
                let needsYou = AidenBotAttention.needsYou(bot)
                if AidenBotAttention.isRunning(bot) { signals.working.insert(key) }
                if needsYou { signals.needsYou.insert(key) }
                if bot.sessionState == .idle, !needsYou { signals.quiet.insert(key) }
            }
        }
        if let focusedChat, signals.liveScopes.contains(focusedChat.instanceId) {
            signals.focused = AidenActivityKey(scope: focusedChat.instanceId, id: "chat:\(focusedChat.objectId)")
        }
        return signals
    }
}

/// The ambient state over time. Pure: every change takes the time it happens,
/// in seconds on one steady timeline, so tests drive it with plain numbers.
///
/// - Work that stops is held as Working for `settleInterval` first, so a run
///   that pauses between steps does not flicker.
/// - Done comes only from a run seen working and then seen resting on a live
///   machine. A first load, a reconnect, a machine going offline, an archive
///   or delete, or a Bot pausing never shows it. It lasts `doneInterval`,
///   then the state falls back to whatever is still true (Working if another
///   run continues, otherwise Idle).
struct AidenAuroraState: Equatable, Sendable {
    static let settleInterval: TimeInterval = 0.6
    static let doneInterval: TimeInterval = 2

    private(set) var signals = AidenActivitySignals()
    /// Work seen running on the last read; nil before the first read.
    private var lastWorking: Set<AidenActivityKey>?
    /// Work that stopped and when, while it settles.
    private var stopping: [AidenActivityKey: TimeInterval] = [:]
    private var doneUntil: TimeInterval?
    /// The last fetch of each machine counted live on the last read.
    private var lastFetch: [String: Date] = [:]
    /// Machines that dropped out, with the fetch their rows date from. They
    /// count as live again only once a newer list arrives.
    private var awaitingFresh: [String: Date] = [:]

    init() {}

    /// Takes a new read of the signals.
    mutating func apply(_ incoming: AidenActivitySignals, now: TimeInterval) {
        settle(now: now)
        var next = incoming
        for (scope, fetched) in lastFetch where !incoming.liveScopes.contains(scope) {
            awaitingFresh[scope] = fetched
        }
        for (scope, stale) in awaitingFresh where incoming.liveScopes.contains(scope) {
            if let fetched = incoming.fetchedAt[scope], fetched > stale {
                awaitingFresh[scope] = nil
            } else {
                next.liveScopes.remove(scope)
            }
        }
        lastFetch = incoming.fetchedAt.filter { next.liveScopes.contains($0.key) }

        if let lastWorking {
            for key in lastWorking.subtracting(next.working) where next.liveScopes.contains(key.scope) {
                stopping[key] = now
            }
        }
        for key in Array(stopping.keys) where next.working.contains(key) || !next.liveScopes.contains(key.scope) {
            stopping[key] = nil
        }
        // Only work on a live machine is remembered, so a machine that comes
        // back starts from what its first fresh list says.
        lastWorking = next.working.filter { next.liveScopes.contains($0.scope) }
        signals = next
    }

    /// Lets time pass: settled stops become Done or nothing, and Done expires.
    mutating func settle(now: TimeInterval) {
        // Compared the way `nextChange` adds, so a wake at exactly that time
        // settles (4 + 0.6 is 4.6, while 4.6 - 4 falls just short of 0.6).
        for (key, stoppedAt) in stopping where now >= stoppedAt + Self.settleInterval {
            stopping[key] = nil
            if signals.quiet.contains(key), signals.focused != key {
                // Several runs settling at once: Done lasts from the latest.
                let candidate = stoppedAt + Self.settleInterval + Self.doneInterval
                doneUntil = max(doneUntil ?? candidate, candidate)
            }
        }
        if let doneUntil, now >= doneUntil { self.doneUntil = nil }
    }

    /// The state at `now`. Call `settle(now:)` first for a change in time alone.
    func phase(at now: TimeInterval) -> AidenAmbientActivity {
        if signals.listening { return .listening }
        if !signals.needsYou.isEmpty { return .needsYou }
        if !signals.failed.isEmpty { return .failed }
        if let doneUntil, now < doneUntil { return .done }
        if !signals.working.isEmpty || !stopping.isEmpty { return .working }
        return .idle
    }

    /// The next time the state can change with no new read, if any.
    var nextChange: TimeInterval? {
        let settles = stopping.values.map { $0 + Self.settleInterval }
        return (settles + [doneUntil].compactMap { $0 }).min()
    }
}

/// How the ambient background draws a state: which palette colour, how strong
/// (a share of the level's opacity cap), how fast the mesh drifts, and how
/// far the mic lifts its centre.
struct AidenAuroraTone: Equatable, Sendable {
    enum Hue: Sendable { case secondary, activity, warning, success, danger }

    let hue: Hue
    /// 0...1, the state's lightness over the brightest state's.
    let intensity: Double
    /// Drift speed, as a multiple of a full cycle every 20 s. Zero holds the
    /// mesh still.
    let speed: Double
    /// 0...1, how far the mic lifts the bright centre while listening.
    let lift: Double

    /// The spec's lightness for Listening at full mic level, the brightest
    /// any state gets.
    private static let brightest = 0.95

    static func of(_ activity: AidenAmbientActivity, micLevel: Double = 0) -> AidenAuroraTone {
        func tone(_ hue: Hue, _ lightness: Double, _ speed: Double, lift: Double = 0) -> AidenAuroraTone {
            AidenAuroraTone(hue: hue, intensity: lightness / brightest, speed: speed, lift: lift)
        }
        switch activity {
        case .idle: return tone(.secondary, 0.32, 0.12)
        case .working: return tone(.activity, 0.80, 0.5)
        case .listening:
            // Listening does not drift: the mic's level lifts and brightens
            // the centre instead.
            let level = min(max(micLevel, 0), 1)
            return tone(.activity, 0.85 + 0.1 * level, 0, lift: level)
        case .needsYou: return tone(.warning, 0.75, 0.3)
        case .done: return tone(.success, 0.65, 0.25)
        case .failed: return tone(.danger, 0.42, 0.1)
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

    /// Every colour the mesh draws for this tone: the state's colour, and the
    /// same a little lighter and a little darker toward the edges.
    func drawnHexes(in palette: AidenPalette) -> (centre: String, lighter: String, darker: String) {
        let base = hex(in: palette)
        return (
            base,
            Color.mixHex(base, "#FFFFFF", fraction: Self.shade),
            Color.mixHex(base, "#000000", fraction: Self.shade)
        )
    }

    /// How far the edge colours move toward white or black.
    static let shade = 0.16
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

/// How strong the ambient background may get in a palette.
///
/// Every colour the mesh draws (each state's colour and its lighter and
/// darker edges), laid over the canvas at the opacity, must leave body text
/// at 4.5:1 and secondary text at 3:1, the spec's floors for body text and
/// for icons and large labels. Vivid takes the strongest opacity that passes,
/// up to its nominal 0.6; Subtle keeps the spec's 0.35 : 0.6 share of it, so
/// the two always differ. Increase Contrast and Reduce Transparency cap
/// either level at half of Subtle.
enum AidenAuroraContrast {
    static let minimumForegroundContrast = 4.5
    static let minimumSecondaryContrast = 3.0

    static func maximumOpacity(
        _ level: AidenAuroraLevel,
        palette: AidenPalette,
        increasedContrast: Bool = false,
        reduceTransparency: Bool = false
    ) -> Double {
        let vivid = legibleHundredths(palette: palette)
        let subtleShare = AidenAuroraLevel.subtle.nominalOpacity / AidenAuroraLevel.vivid.nominalOpacity
        let subtle = Int((Double(vivid) * subtleShare).rounded(.down))
        let chosen = switch level {
        case .off: 0
        case .subtle: subtle
        case .vivid: vivid
        }
        let opacity = Double(chosen) / 100
        return increasedContrast || reduceTransparency ? min(opacity, Double(subtle) / 200) : opacity
    }

    /// The strongest opacity, in whole hundredths up to Vivid's nominal, at
    /// which every drawn colour of every state stays legible.
    private static func legibleHundredths(palette: AidenPalette) -> Int {
        let drawn = AidenAmbientActivity.allCases.flatMap { activity -> [String] in
            // Listening at full mic level is its brightest.
            let shades = AidenAuroraTone.of(activity, micLevel: 1).drawnHexes(in: palette)
            return [shades.centre, shades.lighter, shades.darker]
        }
        var hundredths = Int((AidenAuroraLevel.vivid.nominalOpacity * 100).rounded())
        while hundredths > 0, !drawn.allSatisfy({
            isLegible(over: Color.mixHex(palette.canvasHex, $0, fraction: Double(hundredths) / 100), palette: palette)
        }) {
            hundredths -= 1
        }
        return hundredths
    }

    static func isLegible(over groundHex: String, palette: AidenPalette) -> Bool {
        Color.contrastRatio(palette.foregroundHex, groundHex) >= minimumForegroundContrast
            && Color.contrastRatio(palette.secondaryHex, groundHex) >= minimumSecondaryContrast
    }
}
