import AppIntents
import Foundation

/// Actions reachable from the Home Screen widget and Home Screen Quick Actions.
/// Compiled into both the app and the WidgetKit extension; carries only an
/// opaque action case — never endpoints, credentials, prompts, or paths.
enum AidenHomeAction: String, AppEnum, CaseIterable, Equatable, Sendable {
    case newChat
    case newChatCamera
    case newChatVoice
    case workspaces
    case bots

    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Aiden Action" }

    static var caseDisplayRepresentations: [AidenHomeAction: DisplayRepresentation] {
        [
            .newChat: DisplayRepresentation(
                title: "New Chat",
                image: .init(systemName: "square.and.pencil")
            ),
            .newChatCamera: DisplayRepresentation(
                title: "New Chat with Camera",
                image: .init(systemName: "camera")
            ),
            .newChatVoice: DisplayRepresentation(
                title: "Start Voice",
                image: .init(systemName: "waveform")
            ),
            .workspaces: DisplayRepresentation(
                title: "Workspaces",
                image: .init(systemName: "folder")
            ),
            .bots: DisplayRepresentation(
                title: "Bots",
                image: .init(systemName: "person.2")
            ),
        ]
    }

    /// Ordered closest-to-icon first, matching `Info.plist`'s `UIApplicationShortcutItems`.
    static let quickActions: [AidenHomeAction] = [.newChat, .newChatVoice, .workspaces, .bots]

    var shortcutItemType: String? {
        switch self {
        case .newChat: "aiden.quickAction.newChat"
        case .newChatVoice: "aiden.quickAction.startVoice"
        case .workspaces: "aiden.quickAction.workspaces"
        case .bots: "aiden.quickAction.bots"
        case .newChatCamera: nil
        }
    }

    /// Only the static Quick Actions are recognized; anything else fails closed.
    init?(shortcutItemType: String) {
        guard let action = Self.quickActions.first(where: { $0.shortcutItemType == shortcutItemType }) else {
            return nil
        }
        self = action
    }
}

/// In-process bridge between OS-authenticated Home Screen entry points (widget
/// foreground App Intents and Home Screen Quick Actions) and the app's
/// foreground router. Buffers early cold-launch deliveries until the app installs
/// its handler.
@MainActor
enum AidenHomeActionDispatch {
    private static let maximumQueuedActions = 8
    private static var pending: [AidenHomeAction] = []
    private static var handler: (@MainActor (AidenHomeAction) -> Void)?

    static func install(_ handler: @escaping @MainActor (AidenHomeAction) -> Void) {
        self.handler = handler
        guard !pending.isEmpty else { return }
        let queued = pending
        pending = []
        for action in queued {
            handler(action)
        }
    }

    static func dispatch(_ action: AidenHomeAction) {
        if let handler {
            handler(action)
            return
        }
        if pending.count >= maximumQueuedActions {
            pending.removeFirst(pending.count - maximumQueuedActions + 1)
        }
        pending.append(action)
    }

#if DEBUG
    static func resetForTesting() {
        pending = []
        handler = nil
    }
#endif
}

/// Foreground App Intent used by the Home Screen widget's buttons.
/// Because `supportedModes` is `.foreground`, iOS brings the main app to the
/// foreground and executes `perform()` in the main app process rather than the
/// widget extension, preserving OS-authenticated provenance without public URLs.
struct AidenHomeActionIntent: AppIntent {
    static var title: LocalizedStringResource { "Open Aiden Action" }
    static let description = IntentDescription(
        "Opens Aiden On The Go directly to a new chat, camera, voice, Workspaces, or Bots."
    )
    static var isDiscoverable: Bool { false }
    static var supportedModes: IntentModes { .foreground }

    @Parameter(title: "Action")
    var action: AidenHomeAction

    init() {
        self.action = .newChat
    }

    init(_ action: AidenHomeAction) {
        self.action = action
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        AidenHomeActionDispatch.dispatch(action)
        return .result()
    }
}
