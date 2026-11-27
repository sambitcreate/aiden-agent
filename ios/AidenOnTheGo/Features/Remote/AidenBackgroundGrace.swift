import UIKit

/// The part of `UIApplication` the grace needs, so tests can stand in for it.
@MainActor
protocol AidenBackgroundTaskHost: AnyObject {
    func beginBackgroundTask(expirationHandler: @escaping @MainActor () -> Void) -> UIBackgroundTaskIdentifier
    func endBackgroundTask(_ identifier: UIBackgroundTaskIdentifier)
}

/// Asks iOS for a little more time after the app leaves the screen while a
/// run is still going, so a run that's about to finish still updates its
/// Live Activity and posts its alert. The time ends when the runs do, when
/// the app comes back, or when iOS says it's up, whichever is first.
@MainActor
final class AidenBackgroundGrace {
    private let host: AidenBackgroundTaskHost
    private var task: UIBackgroundTaskIdentifier = .invalid

    init(host: AidenBackgroundTaskHost) {
        self.host = host
    }

    func appDidEnterBackground(hasLiveRuns: Bool) {
        guard hasLiveRuns, task == .invalid else { return }
        task = host.beginBackgroundTask { [weak self] in
            self?.end()
        }
    }

    func liveRunsDidChange(hasLiveRuns: Bool) {
        if !hasLiveRuns { end() }
    }

    func appWillEnterForeground() {
        end()
    }

    private func end() {
        guard task != .invalid else { return }
        let ending = task
        task = .invalid
        host.endBackgroundTask(ending)
    }
}

/// The real host: the running app.
@MainActor
final class AidenApplicationBackgroundTaskHost: AidenBackgroundTaskHost {
    func beginBackgroundTask(expirationHandler: @escaping @MainActor () -> Void) -> UIBackgroundTaskIdentifier {
        UIApplication.shared.beginBackgroundTask(withName: "Aiden run grace") {
            expirationHandler()
        }
    }

    func endBackgroundTask(_ identifier: UIBackgroundTaskIdentifier) {
        UIApplication.shared.endBackgroundTask(identifier)
    }
}
