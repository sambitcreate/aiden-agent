import SwiftUI
import Observation

// MARK: Model

enum AidenMachineStatus: Equatable {
    case online, connecting, offline, needsPairing, revoked

    var title: String {
        switch self {
        case .online: String(localized: "Online")
        case .connecting: String(localized: "Connecting")
        case .offline: String(localized: "Offline")
        case .needsPairing: String(localized: "Needs pairing")
        case .revoked: String(localized: "Access revoked")
        }
    }

    var systemImage: String {
        switch self {
        case .online: "checkmark.circle.fill"
        case .connecting: "arrow.triangle.2.circlepath"
        case .offline: "wifi.slash"
        case .needsPairing, .revoked: "exclamationmark.circle"
        }
    }
}

/// What one line of the Machines page shows. Built by the model, so a view only
/// formats it.
struct AidenMachineRow: Identifiable, Equatable {
    let id: String
    /// The name the machine reports for itself.
    let ownName: String
    /// The name this phone shows: the person's override, else `ownName`.
    let name: String
    /// The last four characters of the instance ID, when another machine reads the same.
    let identitySuffix: String?
    let symbol: AidenMachineSymbol
    let color: AidenMachineColor
    let isHidden: Bool
    let isSelected: Bool
    let status: AidenMachineStatus
    /// A reconnect is running now. Not the same as `.connecting`, which is also where
    /// a machine starts before anything has tried it.
    let isReconnecting: Bool
    let transport: String
    let lastConnectedAt: Date?
    let workspaceCount: Int

    /// A machine that was revoked or lost its pairing can't be reconnected; it has to be paired again.
    var offersReconnect: Bool { status != .revoked && status != .needsPairing }

    var canReconnect: Bool { offersReconnect && !isReconnecting }

    var accessibilityLabel: String {
        if let identitySuffix {
            return String(localized: "\(name), identity \(identitySuffix), \(status.title)")
        }
        return String(localized: "\(name), \(status.title)")
    }

    var accessibilityValue: String {
        var parts: [String] = []
        if isSelected { parts.append(String(localized: "Default machine")) }
        if isHidden { parts.append(String(localized: "Hidden from Inbox, still paired")) }
        parts.append(transport)
        if status != .online { parts.append(AidenInstallationPresentation.lastConnection(lastConnectedAt)) }
        return parts.joined(separator: ", ")
    }
}

/// Reads and edits every paired machine. Machine appearance lives in the
/// preferences store and is never sent to a machine.
///
/// `AidenMachinePreferencesStore.preferences(for:)` assigns a colour the first
/// time it sees a machine. That is a write, and `NavigationLink` builds its
/// destination as soon as the row does, so nothing here writes while a model
/// or a view is being built. `register()` does it, from a page's `.task` once
/// it has loaded. Rows only include machines `register()` has settled.
@MainActor
@Observable
final class AidenMachinesModel {
    /// Longest name kept. Longer text is clipped, so a row never has to wrap
    /// without end.
    static let maxNameLength = 40

    @ObservationIgnored private let coordinator: AidenRemoteCoordinator
    @ObservationIgnored private let preferences: AidenMachinePreferencesStore
    private var registered: Set<String> = []

    init(coordinator: AidenRemoteCoordinator, preferences: AidenMachinePreferencesStore) {
        self.coordinator = coordinator
        self.preferences = preferences
    }

    /// Instance IDs of every paired machine, in pairing order.
    var machineIDs: [String] { coordinator.hosts.ordered.map(\.instanceId) }

    var hasNoMachines: Bool { coordinator.installationStore.installations.isEmpty }

    var isBusy: Bool { coordinator.isMutating }

    var rows: [AidenMachineRow] {
        let connections = coordinator.hosts.ordered.filter { registered.contains($0.instanceId) }
        let names = connections.map { preferences.preferences(for: $0.instanceId).nameOverride ?? $0.installation.name }
        return connections.enumerated().map { index, connection in
            let appearance = preferences.preferences(for: connection.instanceId)
            let name = names[index]
            let isShared = names.enumerated().contains {
                $0.offset != index && $0.element.localizedCaseInsensitiveCompare(name) == .orderedSame
            }
            return AidenMachineRow(
                id: connection.instanceId,
                ownName: connection.installation.name,
                name: name,
                identitySuffix: isShared ? String(connection.instanceId.suffix(4)).lowercased() : nil,
                symbol: appearance.symbol,
                color: appearance.color,
                isHidden: appearance.isHidden,
                isSelected: coordinator.activeInstanceId == connection.instanceId,
                status: Self.status(of: connection),
                isReconnecting: connection.isConnectInFlight,
                transport: AidenInstallationPresentation.endpointType(connection.installation.endpoint),
                lastConnectedAt: connection.installation.lastConnectedAt,
                workspaceCount: connection.workspaces.count
            )
        }
    }

    func row(_ instanceId: String) -> AidenMachineRow? {
        rows.first { $0.id == instanceId }
    }

    /// Gives every paired machine its saved appearance, assigning a colour to one
    /// seen for the first time. Call from model code or `.task`.
    func register() {
        let ids = coordinator.hosts.ordered.map(\.instanceId)
        for id in ids {
            _ = preferences.preferences(for: id)
        }
        registered = Set(ids)
    }

    // MARK: Editing

    func setHidden(_ instanceId: String, _ hidden: Bool) {
        edit(instanceId) { $0.isHidden = hidden }
    }

    func setSymbol(_ instanceId: String, _ symbol: AidenMachineSymbol) {
        edit(instanceId) { $0.symbol = symbol }
    }

    func setColor(_ instanceId: String, _ color: AidenMachineColor) {
        edit(instanceId) { $0.color = color }
    }

    /// Saves the name this phone shows. Blank text goes back to the machine's own name.
    func setName(_ instanceId: String, _ text: String?) {
        let name = Self.normalizedName(text)
        edit(instanceId) { $0.nameOverride = name }
    }

    /// Trims, joins lines, clips to `maxNameLength`, and returns nil for nothing left.
    static func normalizedName(_ text: String?) -> String? {
        guard let text else { return nil }
        let oneLine = text.components(separatedBy: .newlines).joined(separator: " ")
        let trimmed = oneLine.trimmingCharacters(in: .whitespacesAndNewlines)
        // Clipping can leave a space at the end, so trim once more.
        let clipped = String(trimmed.prefix(maxNameLength)).trimmingCharacters(in: .whitespacesAndNewlines)
        return clipped.isEmpty ? nil : clipped
    }

    /// A machine that is no longer paired is never written, so a page that is
    /// closing after a forget cannot bring its preferences back.
    private func edit(_ instanceId: String, _ change: (inout AidenMachinePreferences) -> Void) {
        guard coordinator.installationStore.installations.contains(where: { $0.id == instanceId }) else { return }
        preferences.update(instanceId, change)
        registered.insert(instanceId)
    }

    // MARK: Connection

    /// Long enough for a slow network, short enough that the spinner always ends.
    private static let reconnectTimeout: TimeInterval = 30

    /// Retries one machine. Nothing else connects and the default machine stays.
    func reconnect(_ instanceId: String) async {
        guard let connection = coordinator.hosts.connection(for: instanceId),
              !connection.isConnectInFlight else { return }
        await connection.connect(timeout: Self.reconnectTimeout)
    }

    /// Makes it the default, then gives a machine that's down one try to answer.
    /// Nothing on the other machines changes.
    func select(_ instanceId: String) async -> AidenRemoteMutationOutcome<Void> {
        let outcome = coordinator.setDefaultMachine(instanceId)
        guard case .success = outcome, let connection = coordinator.hosts.connection(for: instanceId),
              connection.connectionState != .connected, !connection.isConnectInFlight else { return outcome }
        await connection.connect(timeout: Self.reconnectTimeout)
        return connection.connectionState == .connected ? .success(()) : .failure
    }

    /// Removes the pairing, its drafts and Bot outbox, and (inside the
    /// coordinator) its phone-local appearance. A forget that fails leaves all
    /// of it in place.
    func forget(_ instanceId: String) async -> AidenRemoteMutationOutcome<Void> {
        let outcome = await coordinator.removeInstallationOutcome(instanceId)
        if !coordinator.installationStore.installations.contains(where: { $0.id == instanceId }) {
            registered.remove(instanceId)
        }
        return outcome
    }

    /// What the forget confirmation says will happen.
    func forgetMessage(for instanceId: String) -> String {
        var message = String(localized: "This removes its pairing from this phone, along with its name, symbol and colour here, drafts, queued Bot messages and chats saved on this phone. Nothing is deleted on the machine, and you can pair it again later.")
        if coordinator.installationStore.installations.count == 1 {
            message += " " + String(localized: "It is your only machine, so you will be asked to pair again.")
        } else if coordinator.activeInstanceId == instanceId {
            message += " " + String(localized: "Another machine will become the default.")
        }
        return message
    }

    /// What to tell the person when something failed, or nil when nothing needs
    /// saying here. The coordinator puts its own reason in `presentedError`, and
    /// the shell shows that, so a second alert would repeat it.
    func failureMessage<Value>(for outcome: AidenRemoteMutationOutcome<Value>, fallback: String) -> String? {
        switch outcome {
        case .failure, .busy:
            guard coordinator.presentedError == nil else { return nil }
            if case .busy = outcome { return String(localized: "Another change is still running. Try again in a moment.") }
            return fallback
        case .success, .cancelled, .stale:
            return nil
        }
    }

    func playHaptic(_ event: AidenHapticEvent, scope: UUID, key: String) {
        coordinator.haptics.play(event, scope: scope, dedupeKey: key)
    }

    func activateHaptics(scope: UUID) { coordinator.haptics.activate(scope: scope) }
    func deactivateHaptics(scope: UUID) { coordinator.haptics.deactivate(scope: scope) }

    private static func status(of connection: AidenHostConnection) -> AidenMachineStatus {
        if connection.isRevoked { return .revoked }
        return switch connection.connectionState {
        case .connected: .online
        case .connecting: .connecting
        case .offline: .offline
        case .needsPairing: .needsPairing
        }
    }
}

// MARK: Machines page

/// Every paired machine, with its state. A row opens the editor for that machine.
struct AidenMachinesView: View {
    let coordinator: AidenRemoteCoordinator
    let preferences: AidenMachinePreferencesStore
    /// Starts pairing another machine.
    let addMachine: () -> Void

    @State private var model: AidenMachinesModel
    @State private var machineToForget: String?
    @State private var forgetFailure: String?
    @State private var hapticScope = UUID()

    init(
        coordinator: AidenRemoteCoordinator,
        preferences: AidenMachinePreferencesStore,
        addMachine: @escaping () -> Void
    ) {
        self.coordinator = coordinator
        self.preferences = preferences
        self.addMachine = addMachine
        _model = State(initialValue: AidenMachinesModel(coordinator: coordinator, preferences: preferences))
    }

    var body: some View {
        List {
            if model.hasNoMachines {
                Section {
                    ContentUnavailableView(
                        "No machines paired",
                        systemImage: "desktopcomputer",
                        description: Text("Pair a machine to see its chats here.")
                    )
                    .listRowBackground(Color.clear)
                }
            } else {
                Section {
                    ForEach(model.rows) { row in
                        NavigationLink(value: AidenMachineLink(instanceId: row.id)) {
                            AidenMachineRowView(row: row)
                        }
                        // Label and value only: hiding the children from a link drops its activation.
                        .accessibilityLabel(row.accessibilityLabel)
                        .accessibilityValue(row.accessibilityValue)
                        .swipeActions(edge: .trailing) {
                            Button("Forget", role: .destructive) { machineToForget = row.id }
                                .disabled(model.isBusy)
                        }
                        .swipeActions(edge: .leading) {
                            if row.offersReconnect, row.status != .online {
                                Button("Reconnect") { Task { await model.reconnect(row.id) } }
                                    .disabled(!row.canReconnect)
                                    .tint(.accentColor)
                            }
                        }
                    }
                } footer: {
                    Text("Hiding a machine keeps it paired. It only leaves the Inbox, and you can still open it here.")
                }
            }

            Section {
                Button(action: addMachine) {
                    Label("Pair a machine", systemImage: "plus")
                }
            }
        }
        .navigationTitle("Machines")
        .navigationBarTitleDisplayMode(.inline)
        // Built when a row is opened, not when the list is.
        .navigationDestination(for: AidenMachineLink.self) { link in
            AidenMachineDetailView(instanceId: link.instanceId, coordinator: coordinator, preferences: preferences)
        }
        .task(id: model.machineIDs) { model.register() }
        .onAppear { model.activateHaptics(scope: hapticScope) }
        .onDisappear { model.deactivateHaptics(scope: hapticScope) }
        .confirmationDialog(
            forgetTitle,
            isPresented: Binding(
                get: { machineToForget != nil },
                set: { if !$0 { machineToForget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Forget machine", role: .destructive) {
                guard let id = machineToForget else { return }
                machineToForget = nil
                Task {
                    let outcome = await model.forget(id)
                    handle(outcome)
                }
            }
            Button("Cancel", role: .cancel) { machineToForget = nil }
        } message: {
            if let id = machineToForget { Text(model.forgetMessage(for: id)) }
        }
        .alert(
            "Could not forget this machine",
            isPresented: Binding(get: { forgetFailure != nil }, set: { if !$0 { forgetFailure = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(forgetFailure ?? "")
        }
    }

    private var forgetTitle: String {
        guard let id = machineToForget, let row = model.row(id) else { return String(localized: "Forget this machine?") }
        return String(localized: "Forget \(row.name)?")
    }

    private func handle(_ outcome: AidenRemoteMutationOutcome<Void>) {
        let key = "machine-forget:\(UUID().uuidString)"
        switch outcome {
        case .success:
            model.playHaptic(.success, scope: hapticScope, key: key)
        case .failure:
            model.playHaptic(.error, scope: hapticScope, key: key)
        case .busy, .cancelled, .stale:
            break
        }
        forgetFailure = model.failureMessage(for: outcome, fallback: String(localized: "It is still paired. Try again in a moment."))
    }
}

/// What a row pushes. The page for it is built only when it is opened.
private struct AidenMachineLink: Hashable {
    let instanceId: String
}

/// The Machines page as a route of the tab shell, which has no sheet for pairing of its own.
struct AidenMachinesRouteView: View {
    let coordinator: AidenRemoteCoordinator
    @State private var showsPairing = false

    var body: some View {
        AidenMachinesView(coordinator: coordinator, preferences: .shared, addMachine: { showsPairing = true })
            .sheet(isPresented: $showsPairing) {
                AidenPairingView(coordinator: coordinator, onPaired: { showsPairing = false })
            }
    }
}

/// One machine on the page: symbol, name, state, and what hiding it means.
private struct AidenMachineRowView: View {
    let row: AidenMachineRow
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var scaledChipSize: CGFloat = 40
    private var chipSize: CGFloat { min(scaledChipSize, 56) }

    var body: some View {
        // At the largest text sizes the symbol sits above the words, so they keep the full width.
        let stacked = dynamicTypeSize.isAccessibilitySize
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: AidenSpacing.s))
            : AnyLayout(HStackLayout(alignment: .center, spacing: AidenSpacing.m))
        layout {
            AidenMachineChipImage(symbol: row.symbol, color: row.color, size: chipSize)
            VStack(alignment: .leading, spacing: AidenSpacing.xs) {
                Text(row.name)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(stacked ? 4 : 2)
                    .truncationMode(.tail)
                HStack(alignment: .firstTextBaseline, spacing: AidenSpacing.xs) {
                    Image(systemName: row.status.systemImage)
                        .imageScale(.small)
                        .accessibilityHidden(true)
                    Text("\(row.status.title) · \(row.transport)")
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                if row.status != .online {
                    Text(AidenInstallationPresentation.lastConnection(row.lastConnectedAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if row.isHidden {
                    Text("Hidden from Inbox · still paired")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let suffix = row.identitySuffix {
                    Text("Identity \(suffix)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                if stacked, row.isSelected {
                    Text("Default machine")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if !stacked {
                Spacer(minLength: 0)
                if row.isSelected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
            }
        }
        .frame(minHeight: 44)
        .padding(.vertical, AidenSpacing.xs)
    }
}
