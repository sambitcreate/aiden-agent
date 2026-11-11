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
    /// Scheduled Tasks and Usage. The page itself says what a machine won't show,
    /// so an offline machine stays pickable for its cached history.
    case reading

    var refusesOffline: Bool {
        switch self {
        case .chat, .bot: true
        case .reading: false
        }
    }

    func refusal(on installation: AidenInstallation) -> AidenNewWorkMachine.Refusal? {
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

        /// `canPickAnother` is false when no other machine could take the work.
        func message(machine name: String, canPickAnother: Bool) -> String {
            switch (self, canPickAnother) {
            case (.offline, true):
                String(localized: "\(name) is offline. Pick another machine, or try again once it’s back.")
            case (.offline, false):
                String(localized: "\(name) is offline. Try again once it’s back.")
            case (.cannotStartChats, true):
                String(localized: "\(name) can’t start chats from this phone. Pick another machine.")
            case (.cannotStartChats, false):
                String(localized: "\(name) can’t start chats from this phone.")
            case (.cannotCreateBots, true):
                String(localized: "\(name) can’t create Bots from this phone. Pick another machine.")
            case (.cannotCreateBots, false):
                String(localized: "\(name) can’t create Bots from this phone.")
            }
        }
    }

    static var noLongerPaired: String {
        String(localized: "This machine is no longer paired. Pair it again to continue.")
    }

    let id: String
    /// Named and drawn as the Inbox draws it, so two machines with one name
    /// read apart here too.
    let label: AidenMachineLabel
    let isDefault: Bool
    let isOffline: Bool
    let refusal: Refusal?

    var name: String { label.name }
    var symbol: AidenMachineSymbol { label.symbol }
    var canBePicked: Bool { refusal == nil }

    /// The second line of the row, when it has anything to say.
    var detail: String? {
        let status = refusal?.title ?? (isOffline ? AidenMachineStatus.offline.title : nil)
        let parts = [isDefault ? String(localized: "Default") : nil, status].compactMap { $0 }
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
    /// Hide is the Inbox's: opened from the Workspaces tab, whose strip lists
    /// hidden machines too, the picker offers them as well.
    private(set) var offersHiddenMachines = false

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
        self.preferences = preferences ?? coordinator.machinePreferences
        self.pinnedMachine = pinnedMachine
        startOver()
    }

    /// Every machine that could take the work, in pairing order, including the
    /// offline ones that can't right now.
    var machines: [AidenNewWorkMachine] {
        machines(includingHidden: offersHiddenMachines)
    }

    /// The machines one entry point offers, whatever the last compose opened
    /// with: the Workspaces tab counts the machines the Inbox hides.
    func machines(includingHidden: Bool) -> [AidenNewWorkMachine] {
        let labels = Self.labels(coordinator: coordinator, preferences: preferences)
        return Self.visibleConnections(
            coordinator: coordinator,
            preferences: preferences,
            keeping: pinnedMachine,
            includingHidden: includingHidden
        ).map { connection in
            Self.machine(connection, label: labels[connection.instanceId], coordinator: coordinator, refusal: refusal(of: connection))
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
        return refusal.message(machine: pickedMachine.name, canPickAnother: canPick(otherThan: pickedMachine.id))
    }

    /// True while a machine besides `instanceId` could take the work.
    func canPick(otherThan instanceId: String) -> Bool {
        machines.contains { $0.id != instanceId && $0.canBePicked }
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
    /// `preferred` is the machine the page it was opened from is showing (the
    /// Workspaces tab filtered to one machine): it starts there instead, and says
    /// so if that machine can't take the work right now, as the default would.
    /// A new Bot never starts on a machine whose pairing can't make Bots while
    /// another's can: the picker offers that one first. `offeringHidden` is for
    /// the Workspaces tab, which lists the machines the Inbox hides.
    func startOver(preferring preferred: String? = nil, offeringHidden: Bool = false) {
        offersHiddenMachines = offeringHidden
        let rows = machines
        var start = preferred.flatMap { id in rows.first { $0.id == id } }
            ?? rows.first(where: \.isDefault) ?? rows.first(where: \.canBePicked) ?? rows.first
        if kind == .bot, start?.refusal == .cannotCreateBots,
           let able = rows.first(where: { $0.refusal != .cannotCreateBots }) {
            start = able
        }
        target = (pinnedMachine ?? start?.id).map(AidenNewWorkTarget.init(instanceId:))
    }

    /// True while some machine in the picker has the grant this work needs,
    /// offline or not. An offline one opens the picker to say why it can't take
    /// the work yet; one whose pairing can never take it doesn't.
    var someMachineAllowsTheWork: Bool {
        Self.visibleConnections(
            coordinator: coordinator,
            preferences: preferences,
            keeping: pinnedMachine,
            includingHidden: offersHiddenMachines
        )
        .contains { kind.refusal(on: $0.installation) == nil }
    }

    /// A pinned machine has no other to send the person to, so what it says when
    /// asked is the answer.
    private func refusal(of connection: AidenHostConnection) -> AidenNewWorkMachine.Refusal? {
        guard pinnedMachine == nil else { return nil }
        return connection.isKnownOffline && kind.refusesOffline ? .offline : kind.refusal(on: connection.installation)
    }

    /// What the Default machine row offers. An offline machine can be the default,
    /// and a hidden default stays so the row can show it.
    static func defaultMachineChoices(
        coordinator: AidenRemoteCoordinator,
        preferences: AidenMachinePreferencesStore? = nil
    ) -> [AidenNewWorkMachine] {
        let preferences = preferences ?? coordinator.machinePreferences
        let labels = Self.labels(coordinator: coordinator, preferences: preferences)
        return visibleConnections(coordinator: coordinator, preferences: preferences, keeping: coordinator.defaultInstanceId).map {
            machine($0, label: labels[$0.instanceId], coordinator: coordinator, refusal: nil)
        }
    }

    /// Paired machines that aren't hidden, or every paired machine with
    /// `includingHidden`. A revoked machine, or one that has to be paired again,
    /// can't take anything.
    private static func visibleConnections(
        coordinator: AidenRemoteCoordinator,
        preferences: AidenMachinePreferencesStore,
        keeping kept: String?,
        includingHidden: Bool = false
    ) -> [AidenHostConnection] {
        coordinator.hosts.ordered.filter { connection in
            !connection.isRevoked && connection.connectionState != .needsPairing
                && (includingHidden
                    || preferences.saved(for: connection.instanceId)?.isHidden != true
                    || connection.instanceId == kept)
        }
    }

    /// Every paired machine's label, as the Inbox makes them, so a shared name gets
    /// the same suffix here as there.
    private static func labels(
        coordinator: AidenRemoteCoordinator,
        preferences: AidenMachinePreferencesStore
    ) -> [String: AidenMachineLabel] {
        AidenMachineLabel.labels(connections: coordinator.hosts.ordered, preferences: preferences)
    }

    private static func machine(
        _ connection: AidenHostConnection,
        label: AidenMachineLabel?,
        coordinator: AidenRemoteCoordinator,
        refusal: AidenNewWorkMachine.Refusal?
    ) -> AidenNewWorkMachine {
        AidenNewWorkMachine(
            id: connection.instanceId,
            label: label ?? AidenMachineLabel(
                instanceId: connection.instanceId,
                name: connection.installation.name,
                symbol: .desktop,
                color: .slate
            ),
            isDefault: connection.instanceId == coordinator.defaultInstanceId,
            isOffline: connection.isKnownOffline,
            refusal: refusal
        )
    }
}

extension AidenRemoteCoordinator {
    /// The name this phone shows for a paired machine.
    func machineName(of instanceId: String) -> String? {
        guard let connection = hosts.connection(for: instanceId) else { return nil }
        return machinePreferences.saved(for: instanceId)?.nameOverride ?? connection.installation.name
    }
}

// MARK: Views

/// Chooses the machine for one piece of work. With one machine to offer there is
/// no choice to show, only the reason it can't take the work.
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
                        // In this order a menu row shows the name, a line under it, and the symbol.
                        Toggle(isOn: isPicked(machine)) {
                            Text(machine.label.name)
                            if let detail = machine.detail {
                                Text(detail)
                            }
                            Image(systemName: machine.label.symbol.systemName)
                        }
                        .disabled(!machine.canBePicked)
                    }
                } label: {
                    HStack(spacing: AidenSpacing.s) {
                        if let picked = picker.pickedMachine {
                            AidenMachineChip(label: picked.label)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(picked.label.name)
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
                refusalLine
            }
        } else {
            refusalLine
        }
    }

    @ViewBuilder
    private var refusalLine: some View {
        if let refusal = picker.refusalMessage {
            Text(refusal)
                .font(.caption)
                .foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
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

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
                    // At the accessibility sizes the symbol would take half the
                    // row and cut the name short, so the name stands alone.
                    if dynamicTypeSize.isAccessibilitySize {
                        Text(machine.label.name).tag(machine.id)
                    } else {
                        Label(machine.label.name, systemImage: machine.label.symbol.systemName).tag(machine.id)
                    }
                }
            }
            .accessibilityHint("New work starts here. You can pick another machine each time.")
        }
    }
}
