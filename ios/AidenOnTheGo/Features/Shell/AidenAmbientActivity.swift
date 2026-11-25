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
    /// Lays an ambient background along the bottom of the view: at most
    /// 400 pt tall and never above 45% of the view's height, under the bottom
    /// safe area, and never in the way of a touch or of VoiceOver.
    func aidenAmbientBackground<Background: View>(
        @ViewBuilder _ background: @escaping () -> Background
    ) -> some View {
        self.background(alignment: .bottom) {
            GeometryReader { proxy in
                let height = min(AidenAmbientLayout.maximumHeight, proxy.size.height * AidenAmbientLayout.maximumScreenShare)
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    background()
                        .frame(height: height)
                }
            }
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}

enum AidenAmbientLayout {
    static let maximumHeight: CGFloat = 400
    static let maximumScreenShare: CGFloat = 0.45
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
    static let stillDimming = 0.6
}

// MARK: - Activity model

/// Feeds the ambient reducer from the inbox and the voice composer, and wakes
/// itself when the state changes with time alone (a run settling, Done
/// expiring). Owned by the shell, read through `\.aidenAmbientActivity`.
@MainActor
@Observable
final class AidenAmbientActivityModel {
    private(set) var activity: AidenAmbientActivity = .idle
    private(set) var micLevel: Double = 0

    @ObservationIgnored private var state = AidenAuroraState()
    @ObservationIgnored private var inbox = AidenActivitySignals()
    @ObservationIgnored private var listening = false
    @ObservationIgnored private var wake: Task<Void, Never>?
    @ObservationIgnored private let clock: any Clock<Duration>
    @ObservationIgnored private let now: @MainActor () -> Date

    init(clock: any Clock<Duration> = ContinuousClock(), now: @escaping @MainActor () -> Date = { Date() }) {
        self.clock = clock
        self.now = now
    }

    deinit { wake?.cancel() }

    func update(snapshots: [AidenHostInboxSnapshot], hiddenMachines: Set<String>, focusedChat: AidenHostObjectID?) {
        inbox = AidenActivitySignals.make(snapshots: snapshots, hiddenMachines: hiddenMachines, focusedChat: focusedChat)
        apply()
    }

    func setVoice(listening: Bool, level: Double) {
        let level = listening ? min(max(level, 0), 1) : 0
        guard listening != self.listening || level != micLevel else { return }
        self.listening = listening
        if level != micLevel { micLevel = level }
        apply()
    }

    private func apply() {
        var signals = inbox
        signals.listening = listening
        signals.micLevel = micLevel
        state.apply(signals, now: now())
        publish()
    }

    private func publish() {
        let date = now()
        let next = state.phase(at: date)
        if next != activity { activity = next }
        schedule()
    }

    private func schedule() {
        wake?.cancel()
        wake = nil
        guard let change = state.nextChange else { return }
        let delay = max(0, change.timeIntervalSince(now()))
        let clock = clock
        wake = Task { [weak self] in
            do {
                try await clock.sleep(for: .milliseconds(Int((delay * 1000).rounded(.up))))
            } catch {
                return
            }
            self?.tick()
        }
    }

    private func tick() {
        state.settle(now: now())
        publish()
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
            increasedContrast: colorSchemeContrast == .increased
        )
        ZStack {
            if gate.rendering != .hidden {
                AidenAuroraMesh(
                    tone: AidenAuroraTone.of(activity, micLevel: micLevel),
                    palette: palette,
                    spread: level.spread,
                    animated: gate.rendering == .animated,
                    paused: gate.isPaused
                )
                .opacity(cap * AidenAuroraTone.of(activity).intensity
                    * (gate.rendering == .still ? AidenAmbientGate.stillDimming : 1))
                .id(activity)
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.6), value: activity)
        .mask {
            LinearGradient(colors: [.black, .clear], startPoint: .bottom, endPoint: .top)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        #if DEBUG
        .overlay(alignment: .bottomLeading) {
            if AidenAuroraDebug.exposesPhase {
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityIdentifier("aurora.phase")
                    .accessibilityValue(gate.rendering == .hidden ? "hidden" : activity.rawValue)
            }
        }
        #endif
    }
}

/// The 3×3 mesh. The top row is clear; the middle and bottom rows carry the
/// state's colour, a little lighter and darker toward the edges, and the
/// inner points drift slowly.
private struct AidenAuroraMesh: View {
    let tone: AidenAuroraTone
    let palette: AidenPalette
    let spread: Double
    let animated: Bool
    let paused: Bool

    var body: some View {
        if animated {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: paused)) { context in
                mesh(at: context.date.timeIntervalSinceReferenceDate)
            }
        } else {
            mesh(at: 0)
        }
    }

    private func mesh(at time: TimeInterval) -> some View {
        let base = tone.hex(in: palette)
        let centre = Color(aidenHex: base)
        let lighter = Color(aidenHex: Color.mixHex(base, "#FFFFFF", fraction: 0.16))
        let darker = Color(aidenHex: Color.mixHex(base, "#000000", fraction: 0.16))
        let phase = time * 2 * .pi / 20 * tone.speed
        let drift = Float(0.08 * spread)
        let middleY = Float(0.45) + drift * Float(sin(phase))
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
            colors: [
                .clear, .clear, .clear,
                lighter.opacity(0.7), centre, darker.opacity(0.7),
                darker, centre, lighter,
            ]
        )
        .blur(radius: 24)
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
        if let forced = AidenAuroraDebug.forcedPhase { return forced }
        #endif
        if followsActivity { return activity }
        return activity == .listening ? .listening : .idle
    }
}
