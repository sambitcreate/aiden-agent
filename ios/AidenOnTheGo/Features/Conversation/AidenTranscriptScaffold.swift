import SwiftUI

/// The structure both conversations share: a transcript that scrolls under one
/// bottom dock. `safeAreaBar` reaches the transcript as an adjusted content
/// inset, the way `aidenOnComposerInsetChange` reads it, and gives the dock's
/// edge the system's scroll edge effect.
struct AidenTranscriptScaffold<Transcript: View>: View {
    private let dock: AidenChatDock
    private let transcript: Transcript

    init(dock: AidenChatDock, @ViewBuilder transcript: () -> Transcript) {
        self.dock = dock
        self.transcript = transcript()
    }

    var body: some View {
        transcript
            .aidenComposerSoftScrollEdge()
            .safeAreaBar(edge: .bottom, spacing: 0) { dock }
    }
}

enum AidenSessionAction: Hashable, Identifiable {
    case rename, fork, readAloud, profile, files, memory, advanced, delete

    var id: Self { self }

    var systemImage: String {
        switch self {
        case .rename: "pencil"
        case .fork: "arrow.triangle.branch"
        case .readAloud: "speaker.wave.2"
        case .profile: "person.crop.circle"
        case .files: "folder"
        case .memory: AidenBotMemorySymbol.name
        case .advanced: "slider.horizontal.3"
        case .delete: "trash"
        }
    }
}

/// What a conversation offers from its toolbar. There's no Context % until a
/// host supplies one, and no Mute, since no per-chat data exists.
struct AidenSessionSheetConfig: Equatable {
    var sheetTitle: String
    var actions: [AidenSessionAction]
    /// Listed but not available right now.
    var unavailable: Set<AidenSessionAction> = []
    var isReadingAloud = false

    func title(for action: AidenSessionAction) -> String {
        switch action {
        case .rename: String(localized: "Rename")
        case .fork: String(localized: "Fork")
        case .readAloud: isReadingAloud ? String(localized: "Stop reading aloud") : String(localized: "Read response aloud")
        case .profile: String(localized: "Profile")
        case .files: String(localized: "Files")
        case .memory: String(localized: "Memory")
        case .advanced: String(localized: "Advanced")
        case .delete: String(localized: "Delete")
        }
    }

    /// `canRename`, `canFork` and `canReadAloud` say what works right now. The
    /// three stay listed either way, so the sheet doesn't change with each run.
    static func chat(
        title: String,
        canRename: Bool,
        canFork: Bool,
        canReadAloud: Bool,
        isReadingAloud: Bool,
        hasFiles: Bool
    ) -> Self {
        var unavailable = Set<AidenSessionAction>()
        if !canRename { unavailable.insert(.rename) }
        if !canFork { unavailable.insert(.fork) }
        if !canReadAloud, !isReadingAloud { unavailable.insert(.readAloud) }
        return Self(
            sheetTitle: title,
            actions: [.rename, .fork, .readAloud] + (hasFiles ? [.files] : []),
            unavailable: unavailable,
            isReadingAloud: isReadingAloud
        )
    }

    /// A Bot chat opened as a chat: the Bot owns its name and has no forks.
    static func botChat(
        title: String,
        hasFiles: Bool,
        canDelete: Bool,
        canReadAloud: Bool,
        isReadingAloud: Bool
    ) -> Self {
        Self(
            sheetTitle: title,
            actions: [.readAloud, .profile] + (hasFiles ? [.files] : []) + (canDelete ? [.delete] : []),
            unavailable: canReadAloud || isReadingAloud ? [] : [.readAloud],
            isReadingAloud: isReadingAloud
        )
    }

    static func bot(
        title: String,
        hasFiles: Bool,
        hasMemory: Bool,
        canDelete: Bool,
        isDeleting: Bool
    ) -> Self {
        Self(
            sheetTitle: title,
            actions: [.profile] + (hasFiles ? [.files] : []) + (hasMemory ? [.memory] : [])
                + [.advanced] + (canDelete ? [.delete] : []),
            unavailable: isDeleting ? [.delete] : []
        )
    }
}

struct AidenSessionActions {
    let perform: (AidenSessionAction) -> Void

    init(perform: @escaping (AidenSessionAction) -> Void) {
        self.perform = perform
    }
}

/// The conversation's own actions, behind one toolbar button.
struct AidenSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    private let config: AidenSessionSheetConfig
    private let actions: AidenSessionActions

    init(config: AidenSessionSheetConfig, actions: AidenSessionActions) {
        self.config = config
        self.actions = actions
    }

    var body: some View {
        NavigationStack {
            List(config.actions) { action in
                Button(role: action == .delete ? .destructive : nil) {
                    actions.perform(action)
                    dismiss()
                } label: {
                    Label(config.title(for: action), systemImage: action.systemImage)
                }
                .disabled(config.unavailable.contains(action))
                // A disabled row keeps the primary colour, which reads as live text.
                .opacity(config.unavailable.contains(action) ? 0.5 : 1)
            }
            .navigationTitle(config.sheetTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
