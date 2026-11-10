import SwiftUI

struct AidenWorkspaceChatsView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Environment(\.aidenPalette) private var palette
    let workspace: AidenWorkspace
    /// The workspace's machine, whose chats these are. Nil is the selected machine.
    let owner: AidenRemoteRequestContext?
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatRemoved: @MainActor (String) -> Void
    let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void
    @State private var model: AidenWorkspaceChatsModel
    @State private var createdChat: AidenChat?
    @State private var renameChat: AidenChat?
    @State private var renameTitle = ""
    @State private var deleteChat: AidenChat?

    init(
        coordinator: AidenRemoteCoordinator,
        workspace: AidenWorkspace,
        owner: AidenRemoteRequestContext?,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatRemoved: @escaping @MainActor (String) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in }
    ) {
        self.coordinator = coordinator
        self.workspace = workspace
        self.owner = owner
        self.onChatUpdated = onChatUpdated
        self.onChatRemoved = onChatRemoved
        self.onChatActivityChanged = onChatActivityChanged
        _model = State(initialValue: AidenWorkspaceChatsModel(
            coordinator: coordinator,
            owner: owner,
            workspaceId: workspace.id,
            onChatUpdated: onChatUpdated,
            onChatRemoved: onChatRemoved
        ))
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(workspace.name).font(.title2.bold())
                    Label(workspace.permission.detail, systemImage: "checkmark.shield")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }

            Section("Chats") {
                if model.chats.isEmpty, !model.isLoading {
                    ContentUnavailableView(
                        "No Chats",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Start a chat in this workspace to control Aiden Agent.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(model.chats) { chat in
                        NavigationLink {
                            AidenForkableChatDetailView(
                                coordinator: coordinator,
                                chat: chat,
                                owner: owner,
                                onChatUpdated: {
                                    model.accept($0)
                                    onChatUpdated($0)
                                },
                                onChatActivityChanged: onChatActivityChanged,
                                onForkOpened: acceptOpenedFork
                            )
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                AidenForkableChatTitle(title: chat.displayTitle, isFork: chat.forkedFrom != nil)
                                AidenRelativeTimestampView(date: chat.updatedAt)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { deleteChat = chat } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button { beginRename(chat) } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            .tint(palette.fillAccent)
                        }
                        .contextMenu {
                            Button { beginRename(chat) } label: { Label("Rename", systemImage: "pencil") }
                            Button(role: .destructive) { deleteChat = chat } label: { Label("Delete", systemImage: "trash") }
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .overlay { if model.isLoading && model.chats.isEmpty { ProgressView() } }
        .refreshable { await model.load() }
        // An owned workspace's chats don't follow the selection.
        .task(id: owner == nil ? coordinator.defaultInstanceId : owner?.instanceId) { await model.load() }
        .navigationDestination(isPresented: Binding(
            get: { createdChat != nil },
            set: { if !$0 { createdChat = nil } }
        )) {
            if let createdChat {
                AidenForkableChatDetailView(
                    coordinator: coordinator,
                    chat: createdChat,
                    owner: owner,
                    onChatUpdated: {
                        model.accept($0)
                        onChatUpdated($0)
                    },
                    onChatActivityChanged: onChatActivityChanged,
                    onForkOpened: acceptOpenedFork
                )
                .id(createdChat.id)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { createdChat = await model.create() }
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .disabled(!model.isConnected || model.isMutating)
                .accessibilityLabel("New chat")
            }
        }
        .alert("Rename Chat", isPresented: Binding(
            get: { renameChat != nil },
            set: { if !$0 { renameChat = nil } }
        )) {
            TextField("Chat title", text: $renameTitle)
            Button("Cancel", role: .cancel) { renameChat = nil }
            Button("Save") {
                guard let chat = renameChat else { return }
                renameChat = nil
                Task { await model.rename(chat, to: renameTitle) }
            }
        }
        .confirmationDialog("Delete this chat?", isPresented: Binding(
            get: { deleteChat != nil },
            set: { if !$0 { deleteChat = nil } }
        ), titleVisibility: .visible) {
            Button("Delete Chat", role: .destructive) {
                guard let chat = deleteChat else { return }
                deleteChat = nil
                Task { await model.remove(chat) }
            }
            Button("Cancel", role: .cancel) { deleteChat = nil }
        } message: {
            Text("This permanently removes the chat from Aiden Agent.")
        }
        .alert("Aiden On The Go", isPresented: Binding(
            get: { model.presentedError != nil },
            set: { if !$0 { model.presentedError = nil } }
        )) {
            Button("OK", role: .cancel) { model.presentedError = nil }
        } message: {
            Text(model.presentedError ?? "The operation could not be completed.")
        }
        .onAppear { model.setHapticsActive(true) }
        .onDisappear { model.setHapticsActive(false) }
    }

    private func beginRename(_ chat: AidenChat) {
        renameTitle = chat.displayTitle
        renameChat = chat
    }

    /// Lists the fork; the detail pushes it over its source.
    private func acceptOpenedFork(_ chat: AidenChat) {
        model.accept(chat)
        onChatUpdated(chat)
    }
}
