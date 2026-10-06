import Foundation
import UIKit
import UserNotifications

/// Lets Aiden's scheduled-run notifications alert while the app is
/// foregrounded — without a center delegate iOS suppresses foreground
/// presentation entirely, which is exactly when this polling feed delivers.
/// Also routes a tapped run alert to its chat through the app's deep link.
final class AidenNotificationPresentationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let appState = await MainActor.run { AidenRunAlertNotifier.currentAppState() }
        return Self.presentationOptions(identifier: notification.request.identifier, appState: appState)
    }

    /// Scheduled runs alert in the foreground. A run alert that lands after
    /// the user returned to the active app stays quiet: the app already shows
    /// the prompt or result, whichever side of `add` the transition fell on.
    static func presentationOptions(
        identifier: String,
        appState: AidenRunAlertAppState
    ) -> UNNotificationPresentationOptions {
        if identifier.hasPrefix("aiden.schedule.") {
            return [.banner, .sound, .list]
        }
        if identifier.hasPrefix(AidenRunAlertNotifier.identifierPrefix), appState == .active {
            return []
        }
        return [.banner, .list]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let url = AidenRunAlertNotifier.deepLink(
                from: response.notification.request.content.userInfo
              ) else { return }
        // The app's own scheme routes back through `onOpenURL`, which switches
        // to the link's paired instance before opening the chat.
        await MainActor.run { UIApplication.shared.open(url) }
    }
}

/// Turns the `/scheduled-tasks/notifications` feed into local notifications.
/// Polling-only by design — Aiden Remote has no cloud push, so delivery
/// happens while the app is foregrounded (scheduled-list loads/refreshes).
/// The persisted cursor + delivered-id set make duplicate and replayed runs
/// idempotent, and items only post when the owning task opted into `notify`.
final class AidenScheduledRunNotifier {
    static let shared = AidenScheduledRunNotifier()
    /// Must stay installed for the app lifetime; assigning the delegate is
    /// enough — UNUserNotificationCenter retains it weakly, hence the static.
    static let presentationDelegate = AidenNotificationPresentationDelegate()

    private static let maximumDeliveredIds = 500
    private let defaults = UserDefaults.standard

    /// Install once at app launch so foregrounded polls still alert.
    static func installPresentationDelegate() {
        UNUserNotificationCenter.current().delegate = presentationDelegate
    }

    private func cursorKey(_ instanceId: String) -> String {
        "aiden.scheduledNotifications.cursor.\(instanceId)"
    }
    private func deliveredKey(_ instanceId: String) -> String {
        "aiden.scheduledNotifications.delivered.\(instanceId)"
    }

    /// Lock-screen display text: bounded and free of control/bidi characters.
    static func displaySafe(_ value: String, limit: Int) -> String {
        String(String(value.prefix(limit)).unicodeScalars.filter {
            !CharacterSet.controlCharacters.contains($0) && !$0.properties.isBidiControl
        })
    }

    func deliver(instanceId: String, client: AidenRemoteClient) async {
        let center = UNUserNotificationCenter.current()
        guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return }
        let cursor = defaults.object(forKey: cursorKey(instanceId)) as? Double
        do {
            let feed = try await client.scheduledRunNotifications(
                since: cursor.map { Date(timeIntervalSince1970: $0 / 1_000) }
            )
            // Insertion-ordered so trimming to the cap evicts the OLDEST ids;
            // the Set is only the membership index.
            var deliveredOrder = defaults.stringArray(forKey: deliveredKey(instanceId)) ?? []
            var delivered = Set(deliveredOrder)
            func markDelivered(_ id: String) {
                if delivered.insert(id).inserted { deliveredOrder.append(id) }
            }
            guard let cursor else {
                // First poll: baseline to the SERVER clock so phone-clock skew
                // can neither replay history nor permanently skip runs. All
                // returned ids are marked delivered so nothing storms.
                feed.notifications.sorted(by: { $0.finishedAt < $1.finishedAt }).forEach { markDelivered($0.id) }
                defaults.set(feed.serverNow.timeIntervalSince1970 * 1_000, forKey: cursorKey(instanceId))
                defaults.set(Array(deliveredOrder.suffix(Self.maximumDeliveredIds)), forKey: deliveredKey(instanceId))
                return
            }
            // Cursor advances only past CONTIGUOUSLY handled items (oldest
            // first): a failed post must keep its finishedAt inside the next
            // poll's window or the run is lost even though it was never posted.
            var nextCursor = cursor
            for item in feed.notifications.sorted(by: { $0.finishedAt < $1.finishedAt }) {
                if !item.notify || delivered.contains(item.id) {
                    // History-only or already posted — safe to advance past.
                    nextCursor = item.finishedAt.timeIntervalSince1970 * 1_000
                    continue
                }
                let content = UNMutableNotificationContent()
                content.title = Self.displaySafe(item.taskName, limit: 120)
                if item.status == "failed" {
                    content.body = "Scheduled run failed (\(item.errorCode ?? "error"))."
                } else if let summary = item.summary, !summary.isEmpty {
                    content.body = Self.displaySafe(summary, limit: 200)
                } else {
                    content.body = "Scheduled run completed."
                }
                let request = UNNotificationRequest(
                    identifier: "aiden.schedule.\(item.id)",
                    content: content,
                    trigger: nil
                )
                do {
                    try await center.add(request)
                    markDelivered(item.id)
                    nextCursor = item.finishedAt.timeIntervalSince1970 * 1_000
                } catch {
                    if error is CancellationError { return }
                    break // retry this item on the next poll
                }
            }
            defaults.set(nextCursor, forKey: cursorKey(instanceId))
            defaults.set(Array(deliveredOrder.suffix(Self.maximumDeliveredIds)), forKey: deliveredKey(instanceId))
        } catch {
            // Fetch/validation failure or cancellation: keep cursor state so a
            // later poll retries instead of silently skipping runs.
            return
        }
    }
}

// MARK: - Run alerts

/// What a chat run needs the user to know while they are away from it.
enum AidenRunAlertKind: String, Equatable, Sendable {
    case needsApproval
    case needsAnswer
    case completed
    case failed

    var isBlocking: Bool { self == .needsApproval || self == .needsAnswer }

    /// Lock-screen body. Fixed copy only: prompt text, tool arguments, and
    /// replies never leave the app through a notification.
    var body: String {
        switch self {
        case .needsApproval: String(localized: "Needs your approval")
        case .needsAnswer: String(localized: "Needs your answer")
        case .completed: String(localized: "Response complete")
        case .failed: String(localized: "Response failed")
        }
    }
}

/// The app's run state as the alert policy sees it. `.inactive` covers the
/// transient overlays (Notification Center, Control Center, app switcher).
enum AidenRunAlertAppState: Equatable, Sendable {
    case active
    case inactive
    case background
}

enum AidenRunAlertPolicy {
    /// One alert per prompt (blocking) or per stream (completion), only while
    /// the user is away. An active app already shows the prompt or result in
    /// app. Quiet Open Chat: a transient overlay over the chat that is on
    /// screen returns straight to that chat, so it stays silent too.
    static func shouldPost(
        appState: AidenRunAlertAppState,
        isChatOnScreen: Bool,
        alreadyAlerted: Bool,
        isAuthorized: Bool
    ) -> Bool {
        guard isAuthorized, !alreadyAlerted else { return false }
        switch appState {
        case .active:
            return false
        case .inactive:
            return !isChatOnScreen
        case .background:
            return true
        }
    }

    /// Ask for permission once, after the first completed run, while the user
    /// is in the app to see the system prompt: never at launch, and never for
    /// a blocking prompt or a failure.
    static func shouldRequestAuthorization(
        kind: AidenRunAlertKind,
        appState: AidenRunAlertAppState,
        hasRequestedBefore: Bool,
        authorizationStatus: UNAuthorizationStatus
    ) -> Bool {
        kind == .completed
            && appState == .active
            && !hasRequestedBefore
            && authorizationStatus == .notDetermined
    }

    static func isAuthorized(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral: true
        case .denied, .notDetermined: false
        @unknown default: false
        }
    }

    /// Prompt ids identify a prompt; stream ids identify a run. Keys are
    /// instance-scoped so two paired Macs never suppress each other.
    static func dedupeKey(kind: AidenRunAlertKind, instanceID: String, id: String) -> String {
        "\(instanceID)|\(kind.isBlocking ? "prompt" : "run")|\(id)"
    }
}

/// The notification-center surface the run notifier needs, so delivery is
/// testable without system permission prompts.
protocol AidenRunAlertCenter: AnyObject {
    func currentAuthorizationStatus() async -> UNAuthorizationStatus
    func requestAlertAuthorization() async -> Bool
    func add(_ request: UNNotificationRequest) async throws
}

extension UNUserNotificationCenter: AidenRunAlertCenter {
    func currentAuthorizationStatus() async -> UNAuthorizationStatus {
        await notificationSettings().authorizationStatus
    }

    func requestAlertAuthorization() async -> Bool {
        (try? await requestAuthorization(options: [.alert, .sound])) == true
    }
}

/// Local alerts for chat runs: one Time Sensitive alert when a run first
/// blocks on an approval or a question, and one alert when it completes or
/// fails. Each deep-links to the instance-scoped chat. Local-only: Aiden
/// Remote has no cloud push, so these fire while the app still holds the
/// stream (for example shortly after backgrounding).
@MainActor
final class AidenRunAlertNotifier {
    /// The unit-test host never asks for notification permission: chat model
    /// tests complete runs while the host app is active.
    static let shared = AidenRunAlertNotifier(
        isEnabled: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil
    )

    nonisolated static let identifierPrefix = "aiden.run."
    nonisolated static let deepLinkUserInfoKey = "aidenURL"
    static let permissionRequestedKey = "aiden.runAlerts.permissionRequested"
    static let alertedKeysKey = "aiden.runAlerts.alerted"
    private static let maximumAlertedKeys = 500

    private let defaults: UserDefaults
    private let center: AidenRunAlertCenter
    private let appState: @MainActor () -> AidenRunAlertAppState
    private let isEnabled: Bool

    init(
        isEnabled: Bool = true,
        defaults: UserDefaults = .standard,
        center: AidenRunAlertCenter = UNUserNotificationCenter.current(),
        appState: @escaping @MainActor () -> AidenRunAlertAppState = { AidenRunAlertNotifier.currentAppState() }
    ) {
        self.defaults = defaults
        self.center = center
        self.appState = appState
        self.isEnabled = isEnabled
    }

    static func currentAppState() -> AidenRunAlertAppState {
        switch UIApplication.shared.applicationState {
        case .active: .active
        case .inactive: .inactive
        case .background: .background
        @unknown default: .background
        }
    }

    /// `id` is the prompt id for blocking kinds and the stream id otherwise.
    func notify(
        _ kind: AidenRunAlertKind,
        id: String,
        instanceID: String,
        chatID: String,
        chatTitle: String,
        isChatOnScreen: Bool
    ) async {
        guard isEnabled else { return }
        var status = await center.currentAuthorizationStatus()
        // App state is sampled after each notification-center await: the user
        // may have left or returned to the app while the lookup was suspended.
        if AidenRunAlertPolicy.shouldRequestAuthorization(
            kind: kind,
            appState: appState(),
            hasRequestedBefore: defaults.bool(forKey: Self.permissionRequestedKey),
            authorizationStatus: status
        ) {
            defaults.set(true, forKey: Self.permissionRequestedKey)
            status = await center.requestAlertAuthorization() ? .authorized : .denied
        }
        let key = AidenRunAlertPolicy.dedupeKey(kind: kind, instanceID: instanceID, id: id)
        var alerted = defaults.stringArray(forKey: Self.alertedKeysKey) ?? []
        guard AidenRunAlertPolicy.shouldPost(
            appState: appState(),
            isChatOnScreen: isChatOnScreen,
            alreadyAlerted: alerted.contains(key),
            isAuthorized: AidenRunAlertPolicy.isAuthorized(status)
        ), let url = AidenDeepLink.chatURL(instanceId: instanceID, chatId: chatID) else { return }

        let content = UNMutableNotificationContent()
        content.title = AidenScheduledRunNotifier.displaySafe(
            AgentRunActivitySanitizer.sessionTitle(chatTitle),
            limit: 120
        )
        content.body = kind.body
        content.threadIdentifier = "aiden.run.\(instanceID).\(chatID)"
        content.userInfo = [Self.deepLinkUserInfoKey: url.absoluteString]
        content.interruptionLevel = kind.isBlocking ? .timeSensitive : .active
        if kind.isBlocking { content.sound = .default }
        let request = UNNotificationRequest(
            identifier: "\(Self.identifierPrefix)\(kind.rawValue).\(instanceID).\(id)",
            content: content,
            trigger: nil
        )
        // Recorded before posting: a dropped alert beats a repeated one.
        alerted.append(key)
        defaults.set(Array(alerted.suffix(Self.maximumAlertedKeys)), forKey: Self.alertedKeysKey)
        try? await center.add(request)
    }

    /// The chat link carried by a tapped run alert, if it is a valid Aiden link.
    nonisolated static func deepLink(from userInfo: [AnyHashable: Any]) -> URL? {
        guard let value = userInfo[deepLinkUserInfoKey] as? String,
              let url = URL(string: value),
              AidenDeepLink.request(from: url) != nil else { return nil }
        return url
    }
}
