import SwiftUI

// MARK: - Environment

private struct AidenAmbientActivityKey: EnvironmentKey { static let defaultValue = AidenAmbientActivity.idle }
private struct AidenAmbientMicLevelKey: EnvironmentKey { static let defaultValue = 0.0 }
private struct AidenAuroraLevelKey: EnvironmentKey { static let defaultValue = AidenAuroraLevel.subtle }
private struct AidenAuroraFollowsActivityKey: EnvironmentKey { static let defaultValue = true }

extension EnvironmentValues {
    /// What the person's work is doing right now, for the ambient background.
    var aidenAmbientActivity: AidenAmbientActivity {
        get { self[AidenAmbientActivityKey.self] }
        set { self[AidenAmbientActivityKey.self] = newValue }
    }

    /// The listening mic's level, 0...1.
    var aidenAmbientMicLevel: Double {
        get { self[AidenAmbientMicLevelKey.self] }
        set { self[AidenAmbientMicLevelKey.self] = newValue }
    }

    /// Settings → Appearance → Ambient background.
    var aidenAuroraLevel: AidenAuroraLevel {
        get { self[AidenAuroraLevelKey.self] }
        set { self[AidenAuroraLevelKey.self] = newValue }
    }

    /// Settings → Appearance → Follow activity. Off keeps the background idle
    /// except while the mic listens.
    var aidenAuroraFollowsActivity: Bool {
        get { self[AidenAuroraFollowsActivityKey.self] }
        set { self[AidenAuroraFollowsActivityKey.self] = newValue }
    }
}

extension View {
    /// Lays an ambient background along the bottom of the view: a band at
    /// most 400 pt tall under the bottom safe area, fading out by 45% of the
    /// view's height, and never in the way of a touch or of VoiceOver.
    func aidenAmbientBackground<Background: View>(
        @ViewBuilder _ background: @escaping () -> Background
    ) -> some View {
        self.background(alignment: .bottom) {
            GeometryReader { proxy in
                let band = AidenAmbientLayout.band(forHeight: proxy.size.height)
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    background()
                        .frame(height: band.height)
                        .mask {
                            LinearGradient(
                                stops: [.init(color: .black, location: 0), .init(color: .clear, location: band.fadeEnd)],
                                startPoint: .bottom,
                                endPoint: .top
                            )
                        }
                }
            }
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    /// Home's ambient background, when `shown`. In Debug builds a forced
    /// phase is also exposed as the `aurora.phase` element, outside the
    /// hidden background so UI tests can read it.
    func aidenAmbientAurora(_ shown: Bool) -> some View {
        aidenAmbientBackground { if shown { AidenAmbientAurora() } }
        #if DEBUG
            .overlay(alignment: .bottomLeading) {
                if shown, AidenAuroraDebug.exposesPhase { AidenAuroraPhaseMarker() }
            }
        #endif
    }
}

enum AidenAmbientLayout {
    static let maximumHeight: CGFloat = 400
    /// The glow is clear from this share of the view's height up.
    static let fadeShare: CGFloat = 0.45

    /// The band's height, and where in it (0 at the bottom, 1 at the top) the
    /// glow has faded out: 45% of the view's height, or the band's top if
    /// that comes first.
    static func band(forHeight viewHeight: CGFloat) -> (height: CGFloat, fadeEnd: CGFloat) {
        let height = min(maximumHeight, max(viewHeight, 0))
        guard height > 0 else { return (0, 1) }
        return (height, min(1, viewHeight * fadeShare / height))
    }
}

// MARK: - Gate

/// How the ambient background may draw right now.
enum AidenAuroraRendering: Equatable, Sendable {
    /// Not drawn at all: switched off, or Low Power Mode.
    case hidden
    /// A dimmed, still gradient: Reduce Motion, Reduce Transparency or
    /// VoiceOver.
    case still
    case animated
}

/// Whether the ambient background draws, holds still, or animates.
struct AidenAmbientGate: Equatable, Sendable {
    var level: AidenAuroraLevel
    var sceneActive: Bool
    var lowPowerMode: Bool
    var visible: Bool
    var reduceMotion: Bool
    var reduceTransparency: Bool
    var voiceOver: Bool

    var rendering: AidenAuroraRendering {
        if level == .off || lowPowerMode { return .hidden }
        if reduceMotion || reduceTransparency || voiceOver { return .still }
        return .animated
    }

    /// The animation clock runs only while it draws, the app is in front and
    /// the view is on screen.
    var isPaused: Bool { rendering != .animated || !sceneActive || !visible }

    /// A still gradient is dimmed so it reads as a tint rather than a light.
    /// Reduce Transparency already caps the opacity, so it is not dimmed again.
    var stillScale: Double { rendering == .still && !reduceTransparency ? Self.stillDimming : 1 }

    static let stillDimming = 0.6
}

// MARK: - Activity model

/// Feeds the ambient reducer from the inbox and the voice composer, and wakes
/// itself when the state changes with time alone (a run settling, Done
/// expiring). Owned by the shell, read through `\.aidenAmbientActivity`.
///
/// One clock drives both the reducer's timeline and the wake: deadlines are
/// the clock's own instants, so a test clock moves everything at once.
@MainActor
@Observable
final class AidenAmbientActivityModel {
    private(set) var activity: AidenAmbientActivity = .idle
    private(set) var micLevel: Double = 0

    @ObservationIgnored private var state = AidenAuroraState()
    @ObservationIgnored private var inbox = AidenActivitySignals()
    @ObservationIgnored private var listening = false
    @ObservationIgnored private var wake: Task<Void, Never>?
    /// Seconds since the model started, on the clock.
    @ObservationIgnored private let elapsed: @MainActor () -> TimeInterval
    /// Sleeps until that many seconds since the model started.
    @ObservationIgnored private let sleepUntil: @Sendable (TimeInterval) async throws -> Void

    convenience init() {
        self.init(clock: ContinuousClock())
    }

    init<C: Clock>(clock: C) where C.Duration == Duration {
        let origin = clock.now
        elapsed = {
            let components = origin.duration(to: clock.now).components
            return TimeInterval(components.seconds) + TimeInterval(components.attoseconds) / 1e18
        }
        sleepUntil = { seconds in
            try await clock.sleep(until: origin.advanced(by: .milliseconds(Int64((seconds * 1000).rounded(.up)))), tolerance: nil)
        }
    }

    deinit { wake?.cancel() }

    func update(snapshots: [AidenHostInboxSnapshot], hiddenMachines: Set<String>, focusedChat: AidenHostObjectID?) {
        inbox = AidenActivitySignals.make(snapshots: snapshots, hiddenMachines: hiddenMachines, focusedChat: focusedChat)
        apply()
    }

    /// The voice composer's state. A level change alone only moves the level:
    /// it neither re-runs the reducer nor restarts the wake.
    func setVoice(listening: Bool, level: Double) {
        let level = listening ? min(max(level, 0), 1) : 0
        if level != micLevel { micLevel = level }
        guard listening != self.listening else { return }
        self.listening = listening
        apply()
    }

    private func apply() {
        var signals = inbox
        signals.listening = listening
        state.apply(signals, now: elapsed())
        publish()
    }

    private func publish() {
        let next = state.phase(at: elapsed())
        if next != activity { activity = next }
        schedule()
    }

    private func schedule() {
        wake?.cancel()
        wake = nil
        guard let change = state.nextChange else { return }
        let sleepUntil = sleepUntil
        wake = Task { [weak self] in
            do {
                try await sleepUntil(change)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            self?.tick(reached: change)
        }
    }

    /// The wake for `change`. The clock has reached it, so a reading a hair
    /// short of it (a rounding in the clock's units) still settles it, rather
    /// than scheduling the same wake again.
    private func tick(reached change: TimeInterval) {
        let now = max(elapsed(), change)
        state.settle(now: now)
        let next = state.phase(at: now)
        if next != activity { activity = next }
        schedule()
    }
}

// MARK: - View

/// The ambient background: a slow mesh of light along the bottom of Home that
/// takes the colour of what the person's work is doing. Decorative only, so
/// it is hidden from VoiceOver and never takes a touch.
struct AidenAuroraView: View {
    let activity: AidenAmbientActivity
    var micLevel: Double = 0

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenAuroraLevel) private var level
    @Environment(\.aidenLowPowerMode) private var lowPowerMode
    @Environment(\.aidenReduceMotion) private var aidenReduceMotion
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.scenePhase) private var scenePhase
    @State private var isVisible = false

    var body: some View {
        let gate = AidenAmbientGate(
            level: level,
            sceneActive: scenePhase == .active,
            lowPowerMode: lowPowerMode,
            visible: isVisible,
            reduceMotion: aidenReduceMotion || systemReduceMotion,
            reduceTransparency: reduceTransparency,
            voiceOver: voiceOver
        )
        let cap = AidenAuroraContrast.maximumOpacity(
            level,
            palette: palette,
            increasedContrast: colorSchemeContrast == .increased,
            reduceTransparency: reduceTransparency
        )
        let tone = AidenAuroraTone.of(activity, micLevel: micLevel)
        ZStack {
            if gate.rendering != .hidden {
                AidenAuroraMesh(
                    tone: tone,
                    palette: palette,
                    spread: level.spread,
                    animated: gate.rendering == .animated,
                    paused: gate.isPaused
                )
                .opacity(cap * tone.intensity * gate.stillScale)
                .id(activity)
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.6), value: activity)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
    }
}

/// The mesh's drift, advanced frame by frame: a change of speed carries on
/// from where the mesh is rather than jumping, and a frame after a pause
/// moves at most `maximumStep`.
struct AidenAuroraDrift: Equatable, Sendable {
    static let maximumStep: TimeInterval = 0.1
    /// A whole number of every point's cycle, so wrapping never moves a point.
    private static let wrap = 200 * Double.pi

    private(set) var phase: Double = 0
    private var last: TimeInterval?

    /// Moves to `time` at `speed` (cycles per 20 s) and returns the phase.
    mutating func advance(to time: TimeInterval, speed: Double) -> Double {
        if let last {
            let step = min(max(time - last, 0), Self.maximumStep)
            phase = (phase + step * speed * 2 * .pi / 20).truncatingRemainder(dividingBy: Self.wrap)
        }
        last = time
        return phase
    }
}

/// Holds one mesh's drift across frames without invalidating the view.
@MainActor
private final class AidenAuroraDriftHolder {
    var drift = AidenAuroraDrift()
}

/// The 3×3 mesh. The top row is clear; the middle and bottom rows carry the
/// state's colour, a little lighter and darker toward the edges, and the
/// inner points drift slowly. No blur: the mesh is smooth on its own, and the
/// band's mask softens the top.
private struct AidenAuroraMesh: View {
    let tone: AidenAuroraTone
    let spread: Double
    let animated: Bool
    let paused: Bool
    /// Built once per tone, not per frame.
    private let colors: [Color]

    @State private var holder = AidenAuroraDriftHolder()

    init(tone: AidenAuroraTone, palette: AidenPalette, spread: Double, animated: Bool, paused: Bool) {
        self.tone = tone
        self.spread = spread
        self.animated = animated
        self.paused = paused
        let shades = tone.drawnHexes(in: palette)
        let centre = Color(aidenHex: shades.centre)
        let lighter = Color(aidenHex: shades.lighter)
        let darker = Color(aidenHex: shades.darker)
        colors = [
            .clear, .clear, .clear,
            lighter.opacity(0.7), centre, darker.opacity(0.7),
            darker, centre, lighter,
        ]
    }

    var body: some View {
        if animated, tone.speed > 0 {
            // Slow states need fewer frames.
            TimelineView(.animation(minimumInterval: tone.speed < 0.2 ? 1.0 / 15.0 : 1.0 / 30.0, paused: paused)) { context in
                mesh(phase: holder.drift.advance(to: context.date.timeIntervalSinceReferenceDate, speed: tone.speed))
            }
        } else {
            mesh(phase: holder.drift.phase)
        }
    }

    private func mesh(phase: Double) -> some View {
        let drift = Float(0.08 * spread)
        let middleY = Float(0.45) + drift * Float(sin(phase)) - Float(0.1 * tone.lift)
        let centreX = Float(0.5) + drift * Float(cos(phase * 0.8))
        let bottomX = Float(0.5) + drift * Float(sin(phase * 0.6 + 1))
        let edgeShare = Float(1 - spread) * 0.25
        return MeshGradient(
            width: 3,
            height: 3,
            points: [
                [0, 0], [0.5, 0], [1, 0],
                [0, middleY + edgeShare], [centreX, middleY], [1, middleY - edgeShare],
                [0, 1], [bottomX, 1], [1, 1],
            ],
            colors: colors
        )
    }
}

#if DEBUG
/// Debug-only hooks: `-AidenAuroraForcePhase <phase>` pins the state for
/// screenshots and UI tests, and exposes it as the `aurora.phase` element.
enum AidenAuroraDebug {
    static let forcePhaseArgument = "AidenAuroraForcePhase"

    static var forcedPhase: AidenAmbientActivity? {
        UserDefaults.standard.string(forKey: forcePhaseArgument).flatMap(AidenAmbientActivity.init(rawValue:))
    }

    static var exposesPhase: Bool { forcedPhase != nil }
}

/// The `aurora.phase` element: the state the background shows, or "hidden".
/// Lives beside the background, not in it, since the background is hidden
/// from accessibility.
private struct AidenAuroraPhaseMarker: View {
    @Environment(\.aidenAmbientActivity) private var activity
    @Environment(\.aidenAuroraFollowsActivity) private var followsActivity
    @Environment(\.aidenAuroraLevel) private var level
    @Environment(\.aidenLowPowerMode) private var lowPowerMode

    var body: some View {
        let shown = AidenAmbientAurora.shown(activity, followsActivity: followsActivity, forced: AidenAuroraDebug.forcedPhase)
        Color.clear
            .frame(width: 1, height: 1)
            .accessibilityElement()
            .accessibilityLabel("Ambient background")
            .accessibilityIdentifier("aurora.phase")
            .accessibilityValue(level == .off || lowPowerMode ? "hidden" : shown.rawValue)
            .allowsHitTesting(false)
    }
}
#endif

/// The ambient background for a root screen: reads the shell's activity and
/// the person's settings, and draws the aurora.
struct AidenAmbientAurora: View {
    @Environment(\.aidenAmbientActivity) private var activity
    @Environment(\.aidenAmbientMicLevel) private var micLevel
    @Environment(\.aidenAuroraFollowsActivity) private var followsActivity

    var body: some View {
        AidenAuroraView(activity: shown, micLevel: micLevel)
    }

    private var shown: AidenAmbientActivity {
        #if DEBUG
        Self.shown(activity, followsActivity: followsActivity, forced: AidenAuroraDebug.forcedPhase)
        #else
        Self.shown(activity, followsActivity: followsActivity)
        #endif
    }

    /// What the background shows: a forced phase first, then the activity, or
    /// with Follow activity off only Listening and otherwise Idle.
    static func shown(
        _ activity: AidenAmbientActivity,
        followsActivity: Bool,
        forced: AidenAmbientActivity? = nil
    ) -> AidenAmbientActivity {
        if let forced { return forced }
        if followsActivity { return activity }
        return activity == .listening ? .listening : .idle
    }
}
