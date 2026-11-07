import SwiftUI

/// Starts a chat from a compose button, on the selected machine: choose where it
/// runs, wait for the machine if it's still connecting, then open the chat from
/// the create receipt.
@MainActor @Observable
final class AidenNewChatFlow {
    private(set) var isCreating = false
    private(set) var status = ""
    var isChoosingWorkspace = false
    var isNamingWorkspace = false
    var workspaceName = ""

    let hapticScope = UUID()

    @ObservationIgnored private let coordinator: AidenRemoteCoordinator
    /// The selected machine's model. It's the store's, so it can change or be
    /// missing between taps.
    @ObservationIgnored private let home: @MainActor () -> AidenHomeModel?
    @ObservationIgnored private let reload: @MainActor () async -> Void
    @ObservationIgnored private let readinessWait: Duration
    @ObservationIgnored private let onOpen: @MainActor (AidenHostObjectID) -> Void
    @ObservationIgnored private var latestReceipt: (id: AidenHostObjectID, chat: AidenChat)?

    init(
        coordinator: AidenRemoteCoordinator,
        home: @escaping @MainActor () -> AidenHomeModel?,
        reload: @escaping @MainActor () async -> Void,
        readinessWait: Duration = .seconds(30),
        onOpen: @escaping @MainActor (AidenHostObjectID) -> Void
    ) {
        self.coordinator = coordinator
        self.home = home
        self.reload = reload
        self.readinessWait = readinessWait
        self.onOpen = onOpen
    }

    private var chatListUnavailable: Bool {
        if case .failed = home()?.chatListLoadState { return true }
        return false
    }

    /// Compose stays available while the machine connects: the tap waits for the
    /// connection (`awaitReady`) instead of failing.
    var isUnavailable: Bool {
        if coordinator.isMutating || isCreating { return true }
        switch coordinator.connectionState {
        case .connecting: return false
        case .connected: return chatListUnavailable
        case .offline, .needsPairing: return true
        }
    }

    private var activeWorkspaces: [AidenWorkspace] {
        AidenNoWorkspace.unarchived(
            coordinator.workspaces,
            archivedIDs: coordinator.workspaceArchiveStore.archivedWorkspaceIDs(for: coordinator.activeInstanceId)
        )
    }

    /// What Existing Workspace offers.
    var existingWorkspaces: [AidenWorkspace] {
        AidenNoWorkspace.choices(activeWorkspaces)
    }

    var choices: [AidenNewAgentChoice] {
        AidenNewAgentChoice.available(noWorkspace: AidenNoWorkspace.home(in: coordinator.workspaces) != nil)
    }

    /// The chat the flow just made, so its route opens without asking the machine.
    func receipt(for id: AidenHostObjectID) -> AidenChat? {
        latestReceipt?.id == id ? latestReceipt?.chat : nil
    }

    func select(_ choice: AidenNewAgentChoice) async {
        switch choice {
        case .noWorkspace:
            // The machine gives the chat a folder of its own if the home already holds one.
            if let home = AidenNoWorkspace.home(in: coordinator.workspaces) {
                await create(in: home)
            }
        case .existingWorkspace:
            isChoosingWorkspace = true
        case .newWorkspace:
            workspaceName = ""
            isNamingWorkspace = true
        case .scratchWorkspace:
            await create(workspace: .scratch, status: String(localized: "Preparing scratch workspace…"))
        }
    }

    func create(in workspace: AidenWorkspace) async {
        guard !isCreating else { return }
        isCreating = true
        status = String(localized: "Opening chat…")
        defer { finish() }
        await createChat(in: workspace, feedback: .success)
    }

    func create(inNewWorkspaceNamed name: String) async {
        guard !name.isEmpty else { return }
        await create(workspace: .folderless(name: name), status: String(localized: "Creating workspace…"))
    }

    private func create(workspace create: AidenWorkspaceCreate, status: String) async {
        guard !isCreating else { return }
        isCreating = true
        self.status = status
        defer { finish() }
        guard await awaitReady() else {
            reportUnavailable()
            return
        }
        let outcome = await coordinator.createWorkspaceOutcome(create)
        guard case .success(let created) = outcome else {
            if outcome.isDefinitiveFailure {
                coordinator.haptics.play(.error, scope: hapticScope)
            }
            return
        }
        let application = await applyGlobalDefaults(to: created)
        self.status = String(localized: "Opening chat…")
        await createChat(in: application.workspace, feedback: application.feedback)
    }

    private func finish() {
        isCreating = false
        status = ""
    }

    /// Holds a compose tapped before the machine is ready, then lets it continue.
    /// False when the connection or the chat list fails, or the wait runs out.
    func awaitReady() async -> Bool {
        if coordinator.connectionState == .connected, home()?.chatListLoadState == .loaded { return true }
        let resumedStatus = status
        status = String(localized: "Waiting for your machine…")
        defer { status = resumedStatus }
        let deadline = ContinuousClock.now + readinessWait
        while ContinuousClock.now < deadline, !Task.isCancelled {
            switch coordinator.connectionState {
            case .connected:
                if home()?.chatListLoadState == .loaded { return true }
                if chatListUnavailable { return false }
            case .connecting:
                break
            case .offline, .needsPairing:
                return false
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return false
    }

    private func reportUnavailable() {
        if case .offline = coordinator.connectionState {
            coordinator.presentedError = String(localized: "Your machine isn’t reachable right now. Try again once it’s connected.")
        } else {
            coordinator.presentedError = home()?.chatLoadErrorMessage
                ?? String(localized: "Chats are unavailable. Try loading them again first.")
        }
        coordinator.haptics.play(.error, scope: hapticScope)
    }

    private func createChat(in workspace: AidenWorkspace, feedback: AidenHapticEvent) async {
        guard await awaitReady() else {
            reportUnavailable()
            return
        }
        let context: AidenRemoteRequestContext
        do {
            context = try coordinator.requestContext()
        } catch {
            coordinator.presentedError = error.localizedDescription
            return
        }
        do {
            let chat = try await coordinator.remoteClient(for: context)
                .createChat(workspaceId: workspace.id, noWorkspace: workspace.noWorkspace)
            guard coordinator.isCurrent(context) else { return }
            guard !chat.isBotChat else {
                coordinator.presentedError = String(localized: "Aiden returned a conversation that is unavailable in Workspaces.")
                return
            }
            // A chat without a workspace can land in a fresh hidden workspace the phone hasn't listed yet.
            if !coordinator.workspaces.contains(where: { $0.id == chat.workspaceId }) {
                await coordinator.refreshWorkspaces()
                guard coordinator.isCurrent(context) else { return }
                guard coordinator.workspaces.contains(where: { $0.id == chat.workspaceId }) else {
                    home()?.accept(chat)
                    coordinator.presentedError = AidenNoWorkspace.startedButUnlistedMessage
                    return
                }
            }
            // The chat opens from the create receipt; the full reload runs behind it.
            home()?.accept(chat)
            home()?.markViewed(chatID: chat.id)
            let id = AidenHostObjectID(instanceId: context.instanceId, deviceId: context.deviceId, objectId: chat.id)
            latestReceipt = (id, chat)
            onOpen(id)
            coordinator.haptics.play(
                feedback,
                scope: hapticScope,
                dedupeKey: "new-agent:\(workspace.id):\(chat.id):\(chat.revision)"
            )
            Task { [reload, coordinator] in
                guard coordinator.isCurrent(context) else { return }
                await reload()
            }
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            guard coordinator.isCurrent(context) else { return }
            coordinator.presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            await coordinator.refreshWorkspaces()
            guard coordinator.isCurrent(context) else { return }
            await reload()
        }
    }

    private func applyGlobalDefaults(to workspace: AidenWorkspace) async -> AidenWorkspaceDefaultApplication {
        let raw = UserDefaults.standard.string(forKey: "aiden.defaults.workspacePermission")
        let permission = raw.flatMap(AidenWorkspacePermission.init(rawValue:)) ?? .ask
        guard permission != workspace.permission else {
            return AidenWorkspaceDefaultApplication(workspace: workspace, feedback: .success)
        }
        guard let updated = await coordinator.updateWorkspace(workspace, permission: permission) else {
            return AidenWorkspaceDefaultApplication(workspace: workspace, feedback: .warning)
        }
        return AidenWorkspaceDefaultApplication(workspace: updated, feedback: .success)
    }
}

/// The compose button. Each toolbar has its own, so only the tapped one opens.
struct AidenNewChatButton: View {
    let flow: AidenNewChatFlow

    @State private var isShowingChoices = false

    var body: some View {
        Button { isShowingChoices = true } label: {
            Label("New chat", systemImage: "square.and.pencil")
        }
        .disabled(flow.isUnavailable)
        .accessibilityHint("Choose where the new chat runs.")
        .popover(isPresented: $isShowingChoices, arrowEdge: .top) {
            AidenNewAgentPopover(
                choices: flow.choices,
                canUseExistingWorkspace: !flow.existingWorkspaces.isEmpty,
                onSelect: { choice in
                    isShowingChoices = false
                    Task { @MainActor in
                        await Task.yield()
                        await flow.select(choice)
                    }
                }
            )
            .frame(width: 320)
            .presentationCompactAdaptation(.popover)
        }
    }
}

private struct AidenNewChatPresentation: ViewModifier {
    @Bindable var flow: AidenNewChatFlow

    @Environment(\.aidenPalette) private var palette

    func body(content: Content) -> some View {
        content
            .overlay {
                if flow.isCreating {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(flow.status)
                    }
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, 16)
                    .frame(height: 48)
                    .foregroundStyle(palette.canvas)
                    .aidenLiquidGlassCapsule(tint: palette.foreground)
                    .accessibilityElement(children: .combine)
                }
            }
            .sheet(isPresented: $flow.isChoosingWorkspace) {
                NavigationStack {
                    List(flow.existingWorkspaces) { workspace in
                        Button {
                            flow.isChoosingWorkspace = false
                            Task { await flow.create(in: workspace) }
                        } label: {
                            AidenWorkspaceRow(workspace: workspace)
                        }
                        .buttonStyle(.plain)
                    }
                    .navigationTitle("Choose workspace")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { flow.isChoosingWorkspace = false }
                        }
                    }
                }
            }
            .alert("New workspace", isPresented: $flow.isNamingWorkspace) {
                TextField("Workspace name", text: $flow.workspaceName)
                Button("Cancel", role: .cancel) { flow.workspaceName = "" }
                Button("Create") {
                    let name = flow.workspaceName.trimmingCharacters(in: .whitespacesAndNewlines)
                    flow.workspaceName = ""
                    Task { await flow.create(inNewWorkspaceNamed: name) }
                }
                .disabled(flow.workspaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } message: {
                Text("Aiden will create a reusable workspace, then open a new chat in it.")
            }
    }
}

extension View {
    /// What a compose button opens, wherever in the shell it was tapped.
    func aidenNewChatPresentation(_ flow: AidenNewChatFlow) -> some View {
        modifier(AidenNewChatPresentation(flow: flow))
    }
}
