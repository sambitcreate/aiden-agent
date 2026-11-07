import SwiftUI

/// The machine a piece of new work goes to. The default machine is only where a
/// picker starts, so work can go elsewhere without moving it.
struct AidenNewWorkTarget: Hashable, Sendable {
    let instanceId: String
}

/// What a machine is being picked for. Each kind asks the picked machine what it
/// allows, never the default.
enum AidenNewWorkKind {
    case chat
    case bot
    /// Scheduled Tasks and Usage. The page itself says what a machine won't show.
    case reading

    fileprivate func refusal(on installation: AidenInstallation) -> AidenNewWorkMachine.Refusal? {
        switch self {
        case .chat:
            // A pairing that has never heard `/server` has nothing to check yet.
            let unknown = installation.serverCapabilities == nil
            return unknown || installation.hasNegotiatedAccess(to: .chatWrite) ? nil : .cannotStartChats
        case .bot:
            return AidenBotsAvailability.resolve(installation).canWrite && installation.canWriteBots
                ? nil : .cannotCreateBots
        case .reading:
            return nil
        }
    }
}

/// One line of a picker.
struct AidenNewWorkMachine: Identifiable, Equatable {
    enum Refusal: Equatable {
        case offline, cannotStartChats, cannotCreateBots

        var title: String {
            switch self {
            case .offline: AidenMachineStatus.offline.title
            case .cannotStartChats: String(localized: "Can’t start chats")
            case .cannotCreateBots: String(localized: "Can’t create Bots")
            }
        }

        func message(machine name: String) -> String {
            switch self {
            case .offline:
                String(localized: "\(name) is offline. Pick another machine, or try again once it’s back.")
            case .cannotStartChats:
                String(localized: "\(name) can’t start chats from this phone. Pick another machine.")
            case .cannotCreateBots:
                String(localized: "\(name) can’t create Bots from this phone. Pick another machine.")
            }
        }
    }

    let id: String
    let name: String
    let symbol: AidenMachineSymbol
    let isDefault: Bool
    let refusal: Refusal?

    var canBePicked: Bool { refusal == nil }

    /// The second line of the row, when it has anything to say.
    var detail: String? {
        let parts = [isDefault ? String(localized: "Default") : nil, refusal?.title].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// Which machine one piece of new work goes to. It starts on the default and
/// moves only when the person picks: a machine going offline underneath it says
/// so, and leaves the choice with them.
@MainActor
@Observable
final class AidenNewWorkPicker {
    let kind: AidenNewWorkKind
    private(set) var target: AidenNewWorkTarget?

    @ObservationIgnored private let coordinator: AidenRemoteCoordinator
    @ObservationIgnored private let preferences: AidenMachinePreferencesStore
    @ObservationIgnored private let pinnedMachine: String?

    /// `pinnedTo` holds the picker on one machine and shows no choice, for work
    /// that can only go back where it came from.
    init(
        coordinator: AidenRemoteCoordinator,
        kind: AidenNewWorkKind,
        preferences: AidenMachinePreferencesStore? = nil,
        pinnedTo pinnedMachine: String? = nil
    ) {
        self.coordinator = coordinator
        self.kind = kind
        self.preferences = preferences ?? .shared
        self.pinnedMachine = pinnedMachine
        startOver()
    }

    /// Every machine that could take the work, in pairing order, including the
    /// offline ones that can't right now.
    var machines: [AidenNewWorkMachine] {
        Self.visibleConnections(coordinator: coordinator, preferences: preferences, keeping: pinnedMachine).map { connection in
            Self.machine(connection, coordinator: coordinator, preferences: preferences, refusal: refusal(of: connection))
        }
    }

    var showsPicker: Bool { pinnedMachine == nil && machines.count > 1 }

    /// The machine the picker is on, while it can still take work at all.
    var pickedMachine: AidenNewWorkMachine? {
        machines.first { $0.id == target?.instanceId }
    }

    var canStart: Bool { pickedMachine?.canBePicked == true }

    /// Why the machine the picker is on can't take the work.
    var refusalMessage: String? {
        guard let pickedMachine, let refusal = pickedMachine.refusal else { return nil }
        return refusal.message(machine: pickedMachine.name)
    }

    /// False, leaving the target alone, for a machine that can't take the work.
    @discardableResult
    func pick(_ instanceId: String) -> Bool {
        guard pinnedMachine == nil, machines.contains(where: { $0.id == instanceId && $0.canBePicked }) else { return false }
        target = AidenNewWorkTarget(instanceId: instanceId)
        return true
    }

    /// Back to the default, for the next piece of work. A hidden default isn't in
    /// the picker, so the first machine that can take the work stands in for it.
    func startOver() {
        let rows = machines
        let start = pinnedMachine ?? (rows.first(where: \.isDefault) ?? rows.first(where: \.canBePicked) ?? rows.first)?.id
        target = start.map(AidenNewWorkTarget.init(instanceId:))
    }

    /// A pinned machine has no other to send the person to, so what it says when
    /// asked is the answer.
    private func refusal(of connection: AidenHostConnection) -> AidenNewWorkMachine.Refusal? {
        guard pinnedMachine == nil else { return nil }
        return connection.isKnownOffline ? .offline : kind.refusal(on: connection.installation)
    }

    /// What the Default machine row offers. An offline machine can be the default,
    /// and a hidden default stays so the row can show it.
    static func defaultMachineChoices(
        coordinator: AidenRemoteCoordinator,
        preferences: AidenMachinePreferencesStore? = nil
    ) -> [AidenNewWorkMachine] {
        let preferences = preferences ?? .shared
        return visibleConnections(coordinator: coordinator, preferences: preferences, keeping: coordinator.defaultInstanceId).map {
            machine($0, coordinator: coordinator, preferences: preferences, refusal: nil)
        }
    }

    /// Paired machines that aren't hidden. A revoked machine, or one that has to be
    /// paired again, can't take anything.
    private static func visibleConnections(
        coordinator: AidenRemoteCoordinator,
        preferences: AidenMachinePreferencesStore,
        keeping kept: String?
    ) -> [AidenHostConnection] {
        coordinator.hosts.ordered.filter { connection in
            !connection.isRevoked && connection.connectionState != .needsPairing
                && (preferences.saved(for: connection.instanceId)?.isHidden != true || connection.instanceId == kept)
        }
    }

    private static func machine(
        _ connection: AidenHostConnection,
        coordinator: AidenRemoteCoordinator,
        preferences: AidenMachinePreferencesStore,
        refusal: AidenNewWorkMachine.Refusal?
    ) -> AidenNewWorkMachine {
        let saved = preferences.saved(for: connection.instanceId)
        return AidenNewWorkMachine(
            id: connection.instanceId,
            name: saved?.nameOverride ?? connection.installation.name,
            symbol: saved?.symbol ?? .desktop,
            isDefault: connection.instanceId == coordinator.defaultInstanceId,
            refusal: refusal
        )
    }
}

// MARK: Work on a picked machine

extension AidenRemoteCoordinator {
    /// Makes a chat on the target. The default stays where it is. Nil when the
    /// machine refused, left, or revoked this phone while it was asked.
    func createChat(
        on target: AidenNewWorkTarget,
        in workspace: AidenWorkspace
    ) async throws -> (chat: AidenChat, id: AidenHostObjectID)? {
        guard let connection = hosts.connection(for: target.instanceId),
              AidenNewWorkKind.chat.refusal(on: connection.installation) == nil else { return nil }
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
        let raw = UserDefaults.standard.string(forKey: "aiden.defaults.workspacePermission")
        let permission = raw.flatMap(AidenWorkspacePermission.init(rawValue:)) ?? .ask
        guard permission != workspace.permission else {
            return AidenWorkspaceDefaultApplication(workspace: workspace, feedback: .success)
        }
        do {
            let owner = try ownerContext(for: target.instanceId)
            let updated = try await remoteClient(for: owner).updateWorkspace(
                id: workspace.id,
                revision: workspace.revision,
                patch: AidenWorkspacePatch(permission: permission)
            )
            return AidenWorkspaceDefaultApplication(workspace: updated, feedback: .success)
        } catch {
            return AidenWorkspaceDefaultApplication(workspace: workspace, feedback: .warning)
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

extension AidenBotCreateOperations {
    /// A create on the context's machine. An owner context stays good when the
    /// default moves; a selected one ends with the selection.
    @MainActor
    static func make(coordinator: AidenRemoteCoordinator, context: AidenRemoteRequestContext) -> AidenBotCreateOperations {
        AidenBotCreateOperations(
            instanceId: context.instanceId,
            deviceId: context.deviceId,
            usesDurableSession: AidenBotHostFeature.isAdvertised(
                AidenBotHostFeature.durableSession,
                by: coordinator.knownServerFeatures(of: context.instanceId)
            ),
            waitForConnection: { hold in
                switch context.scope {
                case .selected: await aidenBotWaitForConnection(coordinator, hold: hold)
                case .owner: await aidenBotWaitForConnection(coordinator, on: context.instanceId, hold: hold)
                }
            },
            catalog: { try await coordinator.remoteClient(for: context).botCapabilityCatalog() },
            create: { request, key in try await coordinator.remoteClient(for: context).createBot(request, idempotencyKey: key) },
            createChat: { botID, request, key in
                _ = try await coordinator.remoteClient(for: context).createBotChat(botId: botID, request: request, idempotencyKey: key)
            },
            readBot: { botID in try await coordinator.remoteClient(for: context).bot(id: botID) },
            isCurrent: { coordinator.holds(context) },
            handleRevocation: { error in await coordinator.handleCredentialRevocation(error, context: context) }
        )
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
    @ObservationIgnored private let onCreated: @MainActor (AidenChat, AidenHostObjectID) -> Void

    init(
        coordinator: AidenRemoteCoordinator,
        preferences: AidenMachinePreferencesStore? = nil,
        readinessWait: Duration = .seconds(30),
        onCreated: @escaping @MainActor (AidenChat, AidenHostObjectID) -> Void
    ) {
        self.coordinator = coordinator
        picker = AidenNewWorkPicker(coordinator: coordinator, kind: .chat, preferences: preferences)
        self.readinessWait = readinessWait
        self.onCreated = onCreated
    }

    private var connection: AidenHostConnection? {
        picker.target.flatMap { coordinator.hosts.connection(for: $0.instanceId) }
    }

    /// Compose stays available while any machine can take the chat, so an offline
    /// default doesn't lock the person out of the others.
    var isUnavailable: Bool {
        isCreating || !picker.machines.contains(where: \.canBePicked)
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
    private func awaitReady(_ target: AidenNewWorkTarget) async -> Bool {
        func state() -> AidenRemoteConnectionState? {
            coordinator.hosts.connection(for: target.instanceId)?.connectionState
        }
        if state() == .connected { return true }
        let resumedStatus = status
        status = String(localized: "Waiting for your machine…")
        defer { status = resumedStatus }
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
        let name = picker.machines.first { $0.id == target.instanceId }?.name
        coordinator.presentedError = name.map { String(localized: "\($0) isn’t reachable right now. Try again once it’s connected.") }
            ?? String(localized: "This machine is no longer paired. Pair it again to continue.")
        coordinator.haptics.play(.error, scope: hapticScope)
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
            onCreated(created.chat, created.id)
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
}

// MARK: Views

/// The machine's name and symbol. Task 27's `AidenMachineLabel` replaces this.
private struct AidenNewWorkMachineLabel: View {
    let machine: AidenNewWorkMachine

    /// In this order a menu row shows the name, a line under it, and the symbol.
    var body: some View {
        Text(machine.name)
        if let detail = machine.detail {
            Text(detail)
        }
        Image(systemName: machine.symbol.systemName)
    }
}

/// Chooses the machine for one piece of work. With one machine to offer there is
/// no choice to show.
struct AidenNewWorkMachinePicker: View {
    let picker: AidenNewWorkPicker

    @Environment(\.aidenPalette) private var palette

    /// A menu row can't say why it's disabled unless it's a toggle: a `Picker` row
    /// drops the line under the name.
    private func isPicked(_ machine: AidenNewWorkMachine) -> Binding<Bool> {
        Binding(
            get: { picker.target?.instanceId == machine.id },
            set: { if $0 { picker.pick(machine.id) } }
        )
    }

    var body: some View {
        if picker.showsPicker {
            VStack(alignment: .leading, spacing: AidenSpacing.xs) {
                Menu {
                    ForEach(picker.machines) { machine in
                        Toggle(isOn: isPicked(machine)) {
                            AidenNewWorkMachineLabel(machine: machine)
                        }
                        .disabled(!machine.canBePicked)
                    }
                } label: {
                    HStack(spacing: AidenSpacing.s) {
                        if let picked = picker.pickedMachine {
                            Image(systemName: picked.symbol.systemName)
                                .foregroundStyle(palette.accent)
                                .frame(width: 24)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(picked.name)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(palette.foreground)
                                    .lineLimit(1)
                                if let detail = picked.detail {
                                    Text(detail)
                                        .font(.caption)
                                        .foregroundStyle(palette.secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                        Spacer(minLength: AidenSpacing.s)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.secondary)
                            .accessibilityHidden(true)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .accessibilityLabel("Machine")
                .accessibilityValue(accessibilityValue)
                .accessibilityHint("Chooses which machine this goes to.")
                if let refusal = picker.refusalMessage {
                    Text(refusal)
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var accessibilityValue: String {
        guard let picked = picker.pickedMachine else { return "" }
        return [picked.name, picked.detail].compactMap { $0 }.joined(separator: ", ")
    }
}

/// The Settings row. It moves the default and nothing else, so what's on screen
/// stays as it is.
struct AidenDefaultMachineRow: View {
    let coordinator: AidenRemoteCoordinator

    private var selection: Binding<String> {
        Binding(
            get: { coordinator.defaultInstanceId ?? "" },
            set: { id in
                if case .busy = coordinator.setDefaultMachine(id) {
                    coordinator.presentedError = String(localized: "Another change is still running. Try again in a moment.")
                }
            }
        )
    }

    var body: some View {
        let machines = AidenNewWorkPicker.defaultMachineChoices(coordinator: coordinator)
        if machines.count > 1 {
            Picker("Default machine", selection: selection) {
                ForEach(machines) { machine in
                    Label(machine.name, systemImage: machine.symbol.systemName).tag(machine.id)
                }
            }
            .accessibilityHint("New work starts here. You can pick another machine each time.")
        }
    }
}

/// The compose button. It opens on the default machine each time.
struct AidenNewWorkComposeButton: View {
    let flow: AidenNewWorkChatFlow

    @State private var isShowingChoices = false

    var body: some View {
        Button {
            flow.picker.startOver()
            isShowingChoices = true
        } label: {
            Label("New chat", systemImage: "square.and.pencil")
        }
        .disabled(flow.isUnavailable)
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
