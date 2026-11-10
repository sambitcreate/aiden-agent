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
    @State private var remoteCoordinator: AidenRemoteCoordinator
    /// Built here because an app's `init` runs once.
    @State private var inboxStore: AidenUnifiedInboxStore
    @State private var appearance = AidenAppearanceStore()

    init() {
        aidenBotImagePlaygroundCleanupAfterProcessLaunch()
        AidenMetricDiagnosticSubscriber.shared.start()
        AidenScheduledRunNotifier.installPresentationDelegate()
        AidenDiagnostics.record(.app, event: .launch, outcome: .started)
        let haptics = AidenHapticCenter()
        _haptics = State(initialValue: haptics)
        let coordinator: AidenRemoteCoordinator
#if DEBUG
        // `-AidenDemoScenario <name>` runs the real shell against fake machines.
        if let scenario = AidenDemoScenario.requested(in: ProcessInfo.processInfo.arguments) {
            coordinator = AidenDemoHosts.coordinator(
                scenario,
                responder: AidenDemoResponder(),
                haptics: haptics
            )
        } else {
            coordinator = AidenRemoteCoordinator(haptics: haptics)
        }
#else
        coordinator = AidenRemoteCoordinator(haptics: haptics)
#endif
        _remoteCoordinator = State(initialValue: coordinator)
        _inboxStore = State(initialValue: AidenUnifiedInboxStore(coordinator: coordinator))
        // A tap can launch the app, so this can't wait for `ContentView`.
        AidenNotificationPresentationDelegate.openTap = { $0.open(coordinator: coordinator) }
        // The unit-test host never touches the device's notifications.
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil {
            Task { await AidenNotificationIdentifierMigration.runOnce() }
        }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                AidenAppearanceRoot(appearance: appearance) {
#if DEBUG
                    if AidenInboxFixtureView.isRequested {
                        AidenInboxFixtureView()
                    } else {
                        ContentView(coordinator: remoteCoordinator, inboxStore: inboxStore)
                    }
#else
                    ContentView(coordinator: remoteCoordinator, inboxStore: inboxStore)
#endif
                }
                .environment(appearance)
            }
            .environment(haptics)
            .aidenHapticHost(haptics)
        }
    }
}
