import Foundation
import UserNotifications

/// What this iPhone tells the person about chat runs, and how much of a
/// run's words reach the Lock Screen. Device-local; never sent to a Mac.
struct AidenNotificationPreferences: Codable, Equatable, Sendable {
    /// An approval or question is waiting.
    var needsAnswer = true
    var responseReady = true
    var runFailed = true
    /// A Bot handed the person a step.
    var botNeedsMe = true
    /// Alerts show the approval summary or question instead of fixed copy.
    var showMessageText = true
    /// The Live Activity shows the end of the reply.
    var replyTextOnLockScreen = false
    /// No alert for the chat already on screen behind a system overlay.
    var quietInOpenChat = true

    static let defaultsKey = "aiden.notifications.preferences"

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = AidenNotificationPreferences()
        needsAnswer = try container.decodeIfPresent(Bool.self, forKey: .needsAnswer) ?? defaults.needsAnswer
        responseReady = try container.decodeIfPresent(Bool.self, forKey: .responseReady) ?? defaults.responseReady
        runFailed = try container.decodeIfPresent(Bool.self, forKey: .runFailed) ?? defaults.runFailed
        botNeedsMe = try container.decodeIfPresent(Bool.self, forKey: .botNeedsMe) ?? defaults.botNeedsMe
        showMessageText = try container.decodeIfPresent(Bool.self, forKey: .showMessageText) ?? defaults.showMessageText
        replyTextOnLockScreen = try container.decodeIfPresent(Bool.self, forKey: .replyTextOnLockScreen)
            ?? defaults.replyTextOnLockScreen
        quietInOpenChat = try container.decodeIfPresent(Bool.self, forKey: .quietInOpenChat) ?? defaults.quietInOpenChat
    }

    /// Unreadable data falls back to the defaults.
    static func load(from defaults: UserDefaults) -> AidenNotificationPreferences {
        guard let data = defaults.data(forKey: defaultsKey),
              let decoded = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return decoded
    }

    func save(to defaults: UserDefaults) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }

    func allows(_ kind: AidenRunAlertKind) -> Bool {
        switch kind {
        case .needsApproval, .needsAnswer: needsAnswer
        case .completed: responseReady
        case .failed: runFailed
        }
    }
}

/// The permission row at the top of Settings → Notifications.
enum AidenNotificationPermissionRow: Equatable {
    case on
    /// `canAsk` shows "Turn on"; otherwise iOS won't ask again and the row
    /// offers "Open Settings".
    case off(canAsk: Bool)

    static func state(for status: UNAuthorizationStatus) -> AidenNotificationPermissionRow {
        switch status {
        case .authorized, .provisional, .ephemeral: .on
        case .notDetermined: .off(canAsk: true)
        case .denied: .off(canAsk: false)
        @unknown default: .off(canAsk: false)
        }
    }
}
