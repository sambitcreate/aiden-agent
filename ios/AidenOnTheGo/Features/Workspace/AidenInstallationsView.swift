import SwiftUI

enum AidenInstallationPresentation {
    static func endpointType(_ endpoint: URL) -> String {
        guard let host = endpoint.host?.lowercased() else { return String(localized: "Remote") }
        return host.hasSuffix(".ts.net")
            ? String(localized: "Tailscale")
            : String(localized: "Local Network")
    }

    static func reachability(
        installationID: String,
        activeInstallationID: String?,
        connectionState: AidenRemoteConnectionState
    ) -> String {
        guard installationID == activeInstallationID else {
            return String(localized: "Not checked")
        }
        switch connectionState {
        case .connected: return String(localized: "Connected")
        case .connecting: return String(localized: "Connecting")
        case .offline: return String(localized: "Offline")
        case .needsPairing: return String(localized: "Needs pairing")
        }
    }

    static func lastConnection(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return String(localized: "Never connected") }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return String(localized: "Last connected \(formatter.localizedString(for: date, relativeTo: now))")
    }

    static func identitySuffix(_ instanceID: String) -> String {
        String(instanceID.suffix(6)).lowercased()
    }

    static func accessibilityValue(
        installationID: String,
        activeInstallationID: String?,
        connectionState: AidenRemoteConnectionState,
        endpoint: URL,
        lastConnectedAt: Date?
    ) -> String {
        let selected = installationID == activeInstallationID
            ? String(localized: "Selected")
            : String(localized: "Not selected")
        return [
            selected,
            reachability(
                installationID: installationID,
                activeInstallationID: activeInstallationID,
                connectionState: connectionState
            ),
            endpointType(endpoint),
            lastConnection(lastConnectedAt),
        ].joined(separator: ", ")
    }
}

struct AidenInstallationsView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var coordinator: AidenRemoteCoordinator
    let addInstallation: () -> Void

    @State private var installationToRemove: AidenInstallation?
    @State private var hapticScope = UUID()

    var body: some View {
        NavigationStack {
            List {
                Section("Paired installations") {
                    ForEach(coordinator.installationStore.installations) { installation in
                        let duplicateName = coordinator.installationStore.installations.filter {
                            $0.name.localizedCaseInsensitiveCompare(installation.name) == .orderedSame
                        }.count > 1
                        Button {
                            Task {
                                guard coordinator.activeInstanceId != installation.id else {
                                    dismiss()
                                    return
                                }
                                let operationID = UUID()
                                let outcome = await coordinator.switchInstallationOutcome(to: installation.id)
                                switch outcome {
                                case .success:
                                    coordinator.haptics.play(
                                        .success,
                                        scope: hapticScope,
                                        dedupeKey: "installation-switch:\(operationID.uuidString)"
                                    )
                                    dismiss()
                                case .failure:
                                    coordinator.haptics.play(
                                        .error,
                                        scope: hapticScope,
                                        dedupeKey: "installation-switch:\(operationID.uuidString)"
                                    )
                                case .cancelled, .stale, .busy:
                                    break
                                }
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(installation.name)
                                        .foregroundStyle(.primary)
                                    Text("\(AidenInstallationPresentation.reachability(installationID: installation.id, activeInstallationID: coordinator.activeInstanceId, connectionState: coordinator.connectionState)) · \(AidenInstallationPresentation.endpointType(installation.endpoint))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Text(AidenInstallationPresentation.lastConnection(installation.lastConnectedAt))
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                    if duplicateName {
                                        Text("Identity \(AidenInstallationPresentation.identitySuffix(installation.instanceId))")
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                                Spacer()
                                if coordinator.installationStore.activeInstallationId == installation.id {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                        .accessibilityLabel(duplicateName
                            ? "\(installation.name), identity \(AidenInstallationPresentation.identitySuffix(installation.instanceId))"
                            : installation.name)
                        .accessibilityValue(AidenInstallationPresentation.accessibilityValue(
                            installationID: installation.id,
                            activeInstallationID: coordinator.activeInstanceId,
                            connectionState: coordinator.connectionState,
                            endpoint: installation.endpoint,
                            lastConnectedAt: installation.lastConnectedAt
                        ))
                        .disabled(coordinator.isMutating || coordinator.connectionState == .connecting)
                        .swipeActions {
                            Button("Forget", role: .destructive) { installationToRemove = installation }
                                .disabled(coordinator.isMutating)
                        }
                    }
                }

                Section {
                    Button(action: addInstallation) {
                        Label("Pair Another Aiden Agent", systemImage: "plus")
                    }
                }
            }
            .navigationTitle("Aiden Installations")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Forget this Aiden Agent?",
                isPresented: Binding(
                    get: { installationToRemove != nil },
                    set: { if !$0 { installationToRemove = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Forget Installation", role: .destructive) {
                    guard let installationToRemove else { return }
                    Task {
                        let operationID = UUID()
                        let outcome = await coordinator.removeInstallationOutcome(installationToRemove.id)
                        // The phone-local name, symbol and colour go with the pairing.
                        if !coordinator.installationStore.installations.contains(where: { $0.id == installationToRemove.id }) {
                            AidenMachinePreferencesStore.shared.remove(installationToRemove.id)
                        }
                        switch outcome {
                        case .success:
                            coordinator.haptics.play(
                                .success,
                                scope: hapticScope,
                                dedupeKey: "installation-forget:\(operationID.uuidString)"
                            )
                        case .failure:
                            coordinator.haptics.play(
                                .error,
                                scope: hapticScope,
                                dedupeKey: "installation-forget:\(operationID.uuidString)"
                            )
                        case .cancelled, .stale, .busy:
                            break
                        }
                        self.installationToRemove = nil
                    }
                }
                Button("Cancel", role: .cancel) { installationToRemove = nil }
            } message: {
                Text("Its credential will be removed from this device. You can pair again from Aiden Agent settings.")
            }
        }
        .onAppear { coordinator.haptics.activate(scope: hapticScope) }
        .onDisappear { coordinator.haptics.deactivate(scope: hapticScope) }
    }
}
