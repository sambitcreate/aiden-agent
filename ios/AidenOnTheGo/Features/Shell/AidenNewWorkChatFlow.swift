import SwiftUI

// MARK: Work on a picked machine

extension AidenRemoteCoordinator {
    /// Makes a chat on the target. The default stays where it is. Nil when the
    /// machine refused, left, or revoked this phone while it was asked, with the
    /// reason in `presentedError`.
    func createChat(
        on target: AidenNewWorkTarget,
        in workspace: AidenWorkspace
    ) async throws -> (chat: AidenChat, id: AidenHostObjectID)? {
        guard let connection = hosts.connection(for: target.instanceId) else {
            presentedError = AidenNewWorkMachine.noLongerPaired
            return nil
        }
        if let refusal = AidenNewWorkKind.chat.refusal(on: connection.installation) {
            presentedError = refusal.message(
                machine: machineName(of: target.instanceId) ?? connection.installation.name,
                canPickAnother: AidenNewWorkPicker(coordinator: self, kind: .chat).canPick(otherThan: target.instanceId)
            )
            return nil
        }
        let owner = try ownerContext(for: target.instanceId)
        let chat: AidenChat
        do {
            chat = try await remoteClient(for: owner)
                .createChat(workspaceId: workspace.id, noWorkspace: workspace.noWorkspace)
        } catch {
            if await handleCredentialRevocation(error, context: owner) { return nil }
            throw error
        }
        guard isLive(owner) else { return nil }
        guard !chat.isBotChat else {
            presentedError = String(localized: "Aiden returned a conversation that is unavailable in Workspaces.")
            return nil
        }
        // A chat without a workspace can land in a fresh hidden workspace the phone hasn't listed yet.
        if chat.workspaceId != workspace.id, !connection.workspaces.contains(where: { $0.id == chat.workspaceId }) {
            await refreshWorkspaces(on: target)
            guard isLive(owner) else { return nil }
            guard connection.workspaces.contains(where: { $0.id == chat.workspaceId }) else {
                presentedError = AidenNoWorkspace.startedButUnlistedMessage
                return nil
            }
        }
        return (chat, AidenHostObjectID(instanceId: owner.instanceId, deviceId: owner.deviceId, objectId: chat.id))
    }

    /// Nil when the machine revoked this phone while it was asked.
    func createWorkspace(_ create: AidenWorkspaceCreate, on target: AidenNewWorkTarget) async throws -> AidenWorkspace? {
        let owner = try ownerContext(for: target.instanceId)
        do {
            let workspace = try await remoteClient(for: owner).createWorkspace(create)
            await refreshWorkspaces(on: target)
            return workspace
        } catch {
            if await handleCredentialRevocation(error, context: owner) { return nil }
            throw error
        }
    }

    /// The workspace back with this phone's default permission, or as it was
    /// when the machine wouldn't take it.
    fileprivate func applyDefaultPermission(
        to workspace: AidenWorkspace,
        on target: AidenNewWorkTarget
    ) async -> AidenWorkspaceDefaultApplication {
        let raw = UserDefaults.standard.string(forKey: AidenWorkspaceDefaultApplication.permissionKey)
        return await .applying(raw.flatMap(AidenWorkspacePermission.init(rawValue:)) ?? .ask, to: workspace) { permission in
            guard let owner = try? ownerContext(for: target.instanceId) else { return nil }
            return try? await remoteClient(for: owner).updateWorkspace(
                id: workspace.id,
                revision: workspace.revision,
                patch: AidenWorkspacePatch(permission: permission)
            )
        }
    }

    /// The chat or workspace already exists, so a failed read here changes nothing
    /// for the caller.
    func refreshWorkspaces(on target: AidenNewWorkTarget) async {
        guard let owner = try? ownerContext(for: target.instanceId),
              let connection = hosts.connection(for: target.instanceId) else { return }
        do {
            let listed = try await remoteClient(for: owner).workspaces()
            guard isLive(owner) else { return }
            connection.applyWorkspaceSnapshot(listed)
        } catch {
            _ = await handleCredentialRevocation(error, context: owner)
        }
    }
}

/// Starts a chat from a compose button, on the picked machine: choose where it
/// runs, wait for the machine if it's still connecting, then hand the chat over.
@MainActor
@Observable
final class AidenNewWorkChatFlow {
    private(set) var isCreating = false
    private(set) var status = ""
    var isChoosingWorkspace = false
    var isNamingWorkspace = false
    var workspaceName = ""

    let picker: AidenNewWorkPicker
    let hapticScope = UUID()

    @ObservationIgnored private let coordinator: AidenRemoteCoordinator
    @ObservationIgnored private let readinessWait: Duration
    /// The new chat, its id, and the message it sends as soon as it opens
    /// (Home's Send), if any.
    @ObservationIgnored private let onCreated: @MainActor (AidenChat, AidenHostObjectID, String?) -> Void
    @ObservationIgnored private var latestReceipt: (id: AidenHostObjectID, chat: AidenChat)?
    @ObservationIgnored private let draftStore: AidenChatDraftStore
    /// Home's own machine choice: its chip, apart from the New chat button's,
    /// so opening one never moves the other.
    let homePicker: AidenNewWorkPicker

    init(
        coordinator: AidenRemoteCoordinator,
        preferences: AidenMachinePreferencesStore? = nil,
        readinessWait: Duration = .seconds(30),
        draftStore: AidenChatDraftStore = .shared,
        onCreated: @escaping @MainActor (AidenChat, AidenHostObjectID, String?) -> Void
    ) {
        self.coordinator = coordinator
        self.draftStore = draftStore
        picker = AidenNewWorkPicker(coordinator: coordinator, kind: .chat, preferences: preferences)
        homePicker = AidenNewWorkPicker(coordinator: coordinator, kind: .chat, preferences: preferences)
        self.readinessWait = readinessWait
        self.onCreated = onCreated
    }

    private var connection: AidenHostConnection? {
        picker.target.flatMap { coordinator.hosts.connection(for: $0.instanceId) }
    }

    /// Compose opens with any machine paired, so a machine that can't take the
    /// chat can say why (R15) and an offline default doesn't lock out the others.
    /// Each entry point asks for itself: the Workspaces tab's compose counts the
    /// machines the Inbox hides (`offeringHidden`), the Inbox's doesn't. Neither
    /// depends on which compose was opened last.
    func isUnavailable(offeringHidden: Bool = false) -> Bool {
        isCreating || picker.machines(includingHidden: offeringHidden).isEmpty
    }

    var canStart: Bool { !isCreating && picker.canStart }

    /// What Existing Workspace offers on the picked machine.
    var existingWorkspaces: [AidenWorkspace] {
        AidenNoWorkspace.choices(AidenNoWorkspace.unarchived(
            connection?.workspaces ?? [],
            archivedIDs: coordinator.workspaceArchiveStore.archivedWorkspaceIDs(for: picker.target?.instanceId)
        ))
    }

    var choices: [AidenNewAgentChoice] {
        AidenNewAgentChoice.available(noWorkspace: AidenNoWorkspace.home(in: connection?.workspaces ?? []) != nil)
    }

    /// The chat the flow just made, so its route opens without asking the machine.
    func receipt(for id: AidenHostObjectID) -> AidenChat? {
        latestReceipt?.id == id ? latestReceipt?.chat : nil
    }

    /// The chat's screen closed, so whatever opens it next asks the machine.
    func forgetReceipt(_ id: AidenHostObjectID) {
        if latestReceipt?.id == id { latestReceipt = nil }
    }

    func select(_ choice: AidenNewAgentChoice) async {
        switch choice {
        case .noWorkspace:
            // The machine gives the chat a folder of its own if the home already holds one.
            if let home = AidenNoWorkspace.home(in: connection?.workspaces ?? []) {
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
        guard !isCreating, let target = picker.target else { return }
        isCreating = true
        status = String(localized: "Opening chat…")
        defer { finish() }
        await createChat(in: workspace, on: target, feedback: .success)
    }

    func create(inNewWorkspaceNamed name: String) async {
        guard !name.isEmpty else { return }
        await create(workspace: .folderless(name: name), status: String(localized: "Creating workspace…"))
    }

    private func create(workspace create: AidenWorkspaceCreate, status: String) async {
        guard !isCreating, let target = picker.target else { return }
        isCreating = true
        self.status = status
        defer { finish() }
        guard await awaitReady(target) else {
            reportUnavailable(target)
            return
        }
        do {
            guard let created = try await coordinator.createWorkspace(create, on: target) else { return }
            let application = await coordinator.applyDefaultPermission(to: created, on: target)
            self.status = String(localized: "Opening chat…")
            await createChat(in: application.workspace, on: target, feedback: application.feedback)
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            report(error)
        }
    }

    private func finish() {
        isCreating = false
        status = ""
    }

    /// Holds a compose tapped before the machine is ready, then lets it continue.
    /// False when the machine goes offline, or the wait runs out.
    /// `showsStatus` is false for Home's Send, which says where it is itself
    /// and must not touch the New chat button's status.
    private func awaitReady(_ target: AidenNewWorkTarget, showsStatus: Bool = true) async -> Bool {
        func state() -> AidenRemoteConnectionState? {
            coordinator.hosts.connection(for: target.instanceId)?.connectionState
        }
        if state() == .connected { return true }
        let resumedStatus = status
        if showsStatus { status = String(localized: "Waiting for your computer…") }
        defer { if showsStatus { status = resumedStatus } }
        let deadline = ContinuousClock.now + readinessWait
        while ContinuousClock.now < deadline, !Task.isCancelled {
            switch state() {
            case .connected: return true
            case .connecting: break
            case .offline, .needsPairing, nil: return false
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return false
    }

    private func reportUnavailable(_ target: AidenNewWorkTarget) {
        coordinator.presentedError = unavailableMessage(target)
        coordinator.haptics.play(.error, scope: hapticScope)
    }

    private func unavailableMessage(_ target: AidenNewWorkTarget) -> String {
        let name = picker.machines.first { $0.id == target.instanceId }?.name
        return name.map { String(localized: "\($0) isn’t reachable right now. Try again once it’s connected.") }
            ?? AidenNewWorkMachine.noLongerPaired
    }

    private func report(_ error: Error) {
        coordinator.presentedError = error.localizedDescription
        coordinator.haptics.play(.error, scope: hapticScope)
    }

    private func createChat(in workspace: AidenWorkspace, on target: AidenNewWorkTarget, feedback: AidenHapticEvent) async {
        guard await awaitReady(target) else {
            reportUnavailable(target)
            return
        }
        do {
            guard let created = try await coordinator.createChat(on: target, in: workspace) else { return }
            latestReceipt = (created.id, created.chat)
            onCreated(created.chat, created.id, nil)
            coordinator.haptics.play(
                feedback,
                scope: hapticScope,
                dedupeKey: "new-agent:\(workspace.id):\(created.chat.id):\(created.chat.revision)"
            )
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            // A mutation is never retried after an uncertain result.
            report(error)
            await coordinator.refreshWorkspaces(on: target)
        }
    }

    /// Home's Send: a Just chat on `target` that sends `prompt` as soon as it
    /// opens. Each call carries its own prompt to its own chat, so a second
    /// Send while the first is still on its way never reaches the first's
    /// chat, and nothing here gates the New chat button (`isCreating`).
    func startChat(sending prompt: String, on target: AidenNewWorkTarget) async -> AidenHomeSendOutcome {
        guard await awaitReady(target, showsStatus: false) else {
            return .failed(unavailableMessage(target))
        }
        // Unpairing mid-send must not open a chat on a machine that's gone.
        guard let owner = try? coordinator.ownerContext(for: target.instanceId) else {
            return .failed(AidenNewWorkMachine.noLongerPaired)
        }
        func home() -> AidenWorkspace? {
            AidenNoWorkspace.home(in: coordinator.hosts.connection(for: target.instanceId)?.workspaces ?? [])
        }
        if home() == nil { await coordinator.refreshWorkspaces(on: target) }
        // A host without the Chats home can't take a Just chat (spec A5).
        guard let workspace = home() else { return .needsChoice }
        do {
            guard let created = try await coordinator.createChat(on: target, in: workspace) else {
                // The coordinator has already said why.
                return .failed(nil)
            }
            latestReceipt = (created.id, created.chat)
            // Also the chat's draft, so a launch that ends before it sends
            // leaves the words in the chat rather than nowhere.
            _ = await seedComposer(prompt, for: created.id)
            guard coordinator.isLive(owner) else { return .failed(AidenNewWorkMachine.noLongerPaired) }
            onCreated(created.chat, created.id, prompt)
            coordinator.haptics.play(
                .success,
                scope: hapticScope,
                dedupeKey: "new-agent:\(workspace.id):\(created.chat.id):\(created.chat.revision)"
            )
            return .started(created.id)
        } catch let error where aidenIsCancellation(error) {
            return .failed(nil)
        } catch {
            // A mutation is never retried after an uncertain result.
            await coordinator.refreshWorkspaces(on: target)
            return .failed(error.localizedDescription)
        }
    }

    /// Saves the prompt as the new chat's draft, which its composer loads when
    /// it opens. Unpairing purges the store and bumps every session, so a save
    /// racing it is rejected; checked before and after.
    private func seedComposer(_ text: String, for id: AidenHostObjectID) async -> Bool {
        guard let context = try? coordinator.ownerContext(for: id.instanceId) else { return false }
        let session = await draftStore.beginSession(instanceId: id.instanceId, chatId: id.objectId)
        guard coordinator.isLive(context) else { return false }
        let saved = (try? await draftStore.save(text, session: session)) ?? false
        guard coordinator.isLive(context) else {
            await draftStore.remove(instanceId: id.instanceId, chatId: id.objectId)
            return false
        }
        return saved
    }
}

/// The compose button, in the Inbox and on the Workspaces tab. It opens on the
/// default machine each time, or on `preferredMachine` when the page it's on is
/// showing just that one. `offersHiddenMachines` is the Workspaces tab's: Hide is
/// the Inbox's, so there the picker offers hidden machines too.
struct AidenNewWorkComposeButton: View {
    let flow: AidenNewWorkChatFlow
    var preferredMachine: String? = nil
    var offersHiddenMachines = false

    @State private var isShowingChoices = false

    var body: some View {
        Button {
            flow.picker.startOver(preferring: preferredMachine, offeringHidden: offersHiddenMachines)
            isShowingChoices = true
        } label: {
            Label("New chat", systemImage: "square.and.pencil")
        }
        .disabled(flow.isUnavailable(offeringHidden: offersHiddenMachines))
        .accessibilityHint("Choose where the new chat runs.")
        .popover(isPresented: $isShowingChoices, arrowEdge: .top) {
            AidenNewAgentPopover(
                choices: flow.choices,
                canUseExistingWorkspace: !flow.existingWorkspaces.isEmpty,
                machinePicker: AidenNewWorkMachinePicker(picker: flow.picker),
                canStart: flow.canStart,
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

private struct AidenNewWorkPresentation: ViewModifier {
    @Bindable var flow: AidenNewWorkChatFlow
    let coordinator: AidenRemoteCoordinator

    @Environment(\.aidenPalette) private var palette

    func body(content: Content) -> some View {
        content
            .overlay {
                if flow.isCreating {
                    HStack(spacing: AidenSpacing.s) {
                        ProgressView().controlSize(.small)
                        Text(flow.status)
                    }
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, AidenSpacing.l)
                    .frame(height: 48)
                    .foregroundStyle(palette.foreground)
                    .glassEffect(.regular, in: .capsule)
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
            .onAppear { coordinator.haptics.activate(scope: flow.hapticScope) }
            .onDisappear { coordinator.haptics.deactivate(scope: flow.hapticScope) }
    }
}

extension View {
    /// What a compose button opens, wherever in the shell it was tapped.
    func aidenNewWorkPresentation(_ flow: AidenNewWorkChatFlow, coordinator: AidenRemoteCoordinator) -> some View {
        modifier(AidenNewWorkPresentation(flow: flow, coordinator: coordinator))
    }
}

/// What Home's Send became.
enum AidenHomeSendOutcome: Equatable {
    case started(AidenHostObjectID)
    /// The machine has no Chats home, so the person chooses where it runs.
    case needsChoice
    /// Nothing was made. The message says why, unless the app already did.
    case failed(String?)
}
