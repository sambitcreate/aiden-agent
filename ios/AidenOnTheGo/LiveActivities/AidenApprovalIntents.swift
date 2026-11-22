import AppIntents
import Foundation

/// Something the person chose on a Live Activity or a notification without
/// opening the app. Only ids and the reply text; never what is being approved.
enum AidenAlertAction: Equatable, Sendable {
    case approve(instanceID: String, chatID: String, target: AgentRunApprovalTarget)
    case deny(instanceID: String, chatID: String, target: AgentRunApprovalTarget)
    case reply(instanceID: String, chatID: String, promptID: String, runID: String?, text: String)

    var instanceID: String {
        switch self {
        case let .approve(instanceID, _, _), let .deny(instanceID, _, _), let .reply(instanceID, _, _, _, _):
            instanceID
        }
    }

    var chatID: String {
        switch self {
        case let .approve(_, chatID, _), let .deny(_, chatID, _), let .reply(_, chatID, _, _, _):
            chatID
        }
    }
}

enum AidenAlertActionOutcome: Equatable, Sendable {
    /// The Mac took the answer.
    case done
    /// Someone answered first, or the ask expired; nothing is left to do.
    case alreadyResolved
    /// The answer didn't land; open this chat so the person can answer there.
    case openApp(URL?)
    /// The Mac was removed from this phone; the action is ignored.
    case dropped
}

/// Hands background actions to the app's coordinator. The app sets `perform`
/// as it launches, which also happens when the system launches it to run an
/// intent; until then every action asks to open the app.
@MainActor
final class AidenBackgroundActionBroker {
    static let shared = AidenBackgroundActionBroker()

    var perform: (@MainActor (AidenAlertAction) async -> AidenAlertActionOutcome)?

    init() {}

    func run(_ action: AidenAlertAction) async -> AidenAlertActionOutcome {
        guard let perform else { return .openApp(nil) }
        return await perform(action)
    }
}

/// Deny on a waiting Live Activity. It runs in the app's process; the widget
/// only renders the button. Approving always needs the app or a notification
/// that asks for Face ID, so the card never offers it.
struct DenyApprovalIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Deny"
    static let isDiscoverable = false

    @Parameter(title: "Computer")
    var instanceID: String

    @Parameter(title: "Chat")
    var chatID: String

    @Parameter(title: "Approval")
    var approvalID: String

    @Parameter(title: "Run")
    var runID: String?

    init() {}

    init(instanceID: String, chatID: String, target: AgentRunApprovalTarget) {
        self.instanceID = instanceID
        self.chatID = chatID
        self.approvalID = target.approvalID
        self.runID = target.runID
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        // When the answer doesn't land the card keeps Review, which opens the
        // chat; the app's broker updates the card when it does.
        _ = await AidenBackgroundActionBroker.shared.run(
            .deny(
                instanceID: instanceID,
                chatID: chatID,
                target: AgentRunApprovalTarget(approvalID: approvalID, runID: runID)
            )
        )
        return .result()
    }
}
