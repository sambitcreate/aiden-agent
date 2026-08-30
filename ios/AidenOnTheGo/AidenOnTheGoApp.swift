import SwiftUI
import MetricKit
import OSLog

enum AidenDiagnosticArea: String, CaseIterable {
    case connection, authentication, contract, cache, stream, speech
    case notification, liveActivity, priorTermination, app
}

enum AidenDiagnosticEvent: String, CaseIterable {
    case launch, requestFailed, contractRejected, cacheFailed, streamInterrupted
    case speechFailed, notificationFailed, liveActivityFailed, priorTerminationObserved
    case priorCrashObserved, priorHangObserved
}

enum AidenDiagnosticOutcome: String, CaseIterable {
    case started, completed, degraded, failed, cancelled
}

enum AidenDiagnosticCode: String, CaseIterable {
    case network, unauthorized, invalidResponse, corruptData, unavailable
    case microphonePermission, speechAuthorization, audioStartup, metricDiagnostic, unknown
}

enum AidenDiagnostics {
    nonisolated(unsafe) static var testSink: ((AidenDiagnosticArea, AidenDiagnosticEvent, AidenDiagnosticOutcome, AidenDiagnosticCode) -> Void)?

    static func record(
        _ area: AidenDiagnosticArea,
        event: AidenDiagnosticEvent,
        outcome: AidenDiagnosticOutcome,
        code: AidenDiagnosticCode = .unknown
    ) {
        testSink?(area, event, outcome, code)
        let logger = Logger(
            subsystem: Bundle.main.bundleIdentifier ?? "sbtbiswas.AidenOnTheGo",
            category: area.rawValue
        )
        switch outcome {
        case .failed:
            logger.error("event=\(event.rawValue, privacy: .public) outcome=\(outcome.rawValue, privacy: .public) code=\(code.rawValue, privacy: .public)")
        case .degraded:
            logger.warning("event=\(event.rawValue, privacy: .public) outcome=\(outcome.rawValue, privacy: .public) code=\(code.rawValue, privacy: .public)")
        case .started, .completed, .cancelled:
            logger.info("event=\(event.rawValue, privacy: .public) outcome=\(outcome.rawValue, privacy: .public) code=\(code.rawValue, privacy: .public)")
        }
    }
}

final class AidenMetricDiagnosticSubscriber: NSObject, MXMetricManagerSubscriber {
    static let shared = AidenMetricDiagnosticSubscriber()

    func start() {
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        guard !payloads.isEmpty else { return }
        if payloads.contains(where: { !($0.crashDiagnostics?.isEmpty ?? true) }) {
            AidenDiagnostics.record(
                .priorTermination,
                event: .priorCrashObserved,
                outcome: .degraded,
                code: .metricDiagnostic
            )
        }
        if payloads.contains(where: { !($0.hangDiagnostics?.isEmpty ?? true) }) {
            AidenDiagnostics.record(
                .priorTermination,
                event: .priorHangObserved,
                outcome: .degraded,
                code: .metricDiagnostic
            )
        }
    }
}

@main
struct AidenOnTheGoApp: App {
    @State private var haptics: AidenHapticCenter
#if DEBUG
    @State private var remoteCoordinator: AidenRemoteCoordinator?
    @State private var appearance: AidenAppearanceStore?
    private let prototypeConfiguration: AidenBotFirstPrototypeConfiguration?
#else
    @State private var remoteCoordinator = AidenRemoteCoordinator()
    @State private var appearance = AidenAppearanceStore()
#endif

#if DEBUG
    init() {
        aidenBotImagePlaygroundCleanupAfterProcessLaunch()
        AidenMetricDiagnosticSubscriber.shared.start()
        AidenDiagnostics.record(.app, event: .launch, outcome: .started)
        let haptics = AidenHapticCenter()
        let configuration = AidenBotFirstPrototypeConfiguration.current
        prototypeConfiguration = configuration
        _haptics = State(initialValue: haptics)
        _remoteCoordinator = State(
            initialValue: configuration == nil ? AidenRemoteCoordinator(haptics: haptics) : nil
        )
        _appearance = State(
            initialValue: configuration == nil ? AidenAppearanceStore() : nil
        )
    }
#else
    init() {
        aidenBotImagePlaygroundCleanupAfterProcessLaunch()
        AidenMetricDiagnosticSubscriber.shared.start()
        AidenDiagnostics.record(.app, event: .launch, outcome: .started)
        let haptics = AidenHapticCenter()
        _haptics = State(initialValue: haptics)
        _remoteCoordinator = State(initialValue: AidenRemoteCoordinator(haptics: haptics))
    }
#endif

    var body: some Scene {
        WindowGroup {
            Group {
#if DEBUG
                if let prototypeConfiguration {
                    AidenBotFirstPrototypeLaunchView(configuration: prototypeConfiguration)
                } else if let remoteCoordinator, let appearance {
                    AidenAppearanceRoot(appearance: appearance) {
                        ContentView(coordinator: remoteCoordinator)
                    }
                    .environment(appearance)
                }
#else
                AidenAppearanceRoot(appearance: appearance) {
                    ContentView(coordinator: remoteCoordinator)
                }
                .environment(appearance)
#endif
            }
            .environment(haptics)
            .aidenHapticHost(haptics)
        }
    }
}
