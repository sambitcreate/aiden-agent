import Foundation
import UserNotifications

/// Lets Aiden's scheduled-run notifications alert while the app is
/// foregrounded — without a center delegate iOS suppresses foreground
/// presentation entirely, which is exactly when this polling feed delivers.
final class AidenNotificationPresentationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        if notification.request.identifier.hasPrefix("aiden.schedule.") {
            return [.banner, .sound, .list]
        }
        return [.banner, .list]
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
            var delivered = Set(defaults.stringArray(forKey: deliveredKey(instanceId)) ?? [])
            guard let cursor else {
                // First poll: baseline to the SERVER clock so phone-clock skew
                // can neither replay history nor permanently skip runs. All
                // returned ids are marked delivered so nothing storms.
                feed.notifications.forEach { delivered.insert($0.id) }
                defaults.set(feed.serverNow.timeIntervalSince1970 * 1_000, forKey: cursorKey(instanceId))
                defaults.set(Array(delivered).suffix(Self.maximumDeliveredIds), forKey: deliveredKey(instanceId))
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
                    delivered.insert(item.id)
                    nextCursor = item.finishedAt.timeIntervalSince1970 * 1_000
                } catch {
                    if error is CancellationError { return }
                    break // retry this item on the next poll
                }
            }
            defaults.set(nextCursor, forKey: cursorKey(instanceId))
            defaults.set(Array(delivered).suffix(Self.maximumDeliveredIds), forKey: deliveredKey(instanceId))
        } catch {
            // Fetch/validation failure or cancellation: keep cursor state so a
            // later poll retries instead of silently skipping runs.
            return
        }
    }
}
