import Foundation
import UserNotifications

/// Turns the `/scheduled-tasks/notifications` feed into local notifications.
/// Polling-only by design — Aiden Remote has no cloud push, so delivery
/// happens while the app is foregrounded (scheduled-list loads/refreshes).
/// The persisted cursor + delivered-id set make duplicate and replayed runs
/// idempotent, and items only post when the owning task opted into `notify`.
final class AidenScheduledRunNotifier {
    static let shared = AidenScheduledRunNotifier()

    private static let maximumDeliveredIds = 500
    private let defaults = UserDefaults.standard

    private func cursorKey(_ instanceId: String) -> String {
        "aiden.scheduledNotifications.cursor.\(instanceId)"
    }
    private func deliveredKey(_ instanceId: String) -> String {
        "aiden.scheduledNotifications.delivered.\(instanceId)"
    }

    /// Feed items that still need a local notification (respects `notify` + dedup).
    static func pending(
        _ items: [AidenScheduledRunNotification],
        deliveredIds: Set<String>
    ) -> [AidenScheduledRunNotification] {
        items.filter { $0.notify && !deliveredIds.contains($0.id) }
    }

    /// The `since` cursor after consuming `items`, in epoch milliseconds.
    static func cursor(after items: [AidenScheduledRunNotification]) -> Double? {
        items.map { $0.finishedAt.timeIntervalSince1970 * 1_000 }.max()
    }

    func deliver(instanceId: String, client: AidenRemoteClient) async {
        let center = UNUserNotificationCenter.current()
        guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return }
        // Baseline the first poll to now so a fresh install never replays
        // historical runs as a notification storm.
        let baseline = Date()
        let cursor = defaults.object(forKey: cursorKey(instanceId)) as? Double
        guard let items = try? await client.scheduledRunNotifications(
            since: cursor.map { Date(timeIntervalSince1970: $0 / 1_000) } ?? baseline
        ) else { return }
        var delivered = Set(defaults.stringArray(forKey: deliveredKey(instanceId)) ?? [])
        for item in Self.pending(items, deliveredIds: delivered) {
            delivered.insert(item.id)
            let content = UNMutableNotificationContent()
            content.title = String(item.taskName.prefix(120))
            if item.status == "failed" {
                content.body = "Scheduled run failed (\(item.errorCode ?? "error"))."
            } else if let summary = item.summary, !summary.isEmpty {
                content.body = String(summary.prefix(200))
            } else {
                content.body = "Scheduled run completed."
            }
            let request = UNNotificationRequest(
                identifier: "aiden.schedule.\(item.id)",
                content: content,
                trigger: nil
            )
            try? await center.add(request)
        }
        defaults.set(
            Self.cursor(after: items) ?? cursor ?? baseline.timeIntervalSince1970 * 1_000,
            forKey: cursorKey(instanceId)
        )
        defaults.set(Array(delivered).suffix(Self.maximumDeliveredIds), forKey: deliveredKey(instanceId))
    }
}
