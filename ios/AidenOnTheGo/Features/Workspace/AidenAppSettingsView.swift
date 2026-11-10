import SwiftUI

struct AidenAppSettingsView: View {
    @Environment(AidenHapticCenter.self) private var haptics
    @Environment(\.aidenPalette) private var palette
    @Bindable var coordinator: AidenRemoteCoordinator
    @Bindable var appearance: AidenAppearanceStore

    @State private var isShowingAppearance = false
    @Environment(\.scenePhase) private var scenePhase
    @State private var readAloudStatus: AidenReadAloudStatus?
    @State private var readAloudError: String?
    // TODO: mobile configuration is deferred; only the desktop may enable TTS.
    private func loadReadAloudStatus() async {
        let context = try? coordinator.requestContext()
        guard let context else { readAloudStatus = nil; return }
        do {
            let value = try await coordinator.remoteClient(for: context).readAloudStatus()
            guard coordinator.isCurrent(context) else { return }
            readAloudStatus = value; readAloudError = nil
        } catch {
            guard coordinator.isCurrent(context) else { return }
            readAloudStatus = nil; readAloudError = "Read Aloud is unavailable. Connect to an updated desktop app."
        }
    }
    @State private var memorySettings: AidenMemorySettings?
    @State private var memoryError: String?
    @State private var isSavingMemory = false
    @AppStorage(AidenWorkspaceDefaultApplication.permissionKey) private var defaultWorkspacePermissionRaw = AidenWorkspacePermission.ask.rawValue
    @AppStorage(AidenVoiceInputMode.defaultsKey) private var voiceInputModeRaw = AidenVoiceInputMode.onDevice.rawValue

    private func loadMemorySettings() async {
        do {
            memorySettings = try await coordinator.remoteClient().memorySettings()
            memoryError = nil
        } catch {
            memoryError = error.localizedDescription
        }
    }

    private func updateMemory(_ enabled: Bool) {
        guard let current = memorySettings, !isSavingMemory else { return }
        isSavingMemory = true
        memorySettings = AidenMemorySettings(enabled: enabled, revision: current.revision)
        Task {
            do {
                memorySettings = try await coordinator.remoteClient().updateMemorySettings(
                    revision: current.revision,
                    enabled: enabled
                )
                memoryError = nil
            } catch {
                memorySettings = current
                memoryError = error.localizedDescription
            }
            isSavingMemory = false
        }
    }

    /// "3 of 4 online", read from the connections, so it never writes anything.
    private var machinesSummary: String {
        let connections = coordinator.hosts.ordered
        let online = connections.filter { !$0.isRevoked && $0.connectionState == .connected }.count
        return String(localized: "\(online) of \(connections.count) online")
    }

    var body: some View {
        Form {
            Section("Aiden Agent") {
                LabeledContent(
                    "Connected machine",
                    value: coordinator.installationStore.activeInstallation?.name ?? "Not connected"
                )
                NavigationLink(value: AidenAppRoute.machines) {
                    LabeledContent {
                        Text(machinesSummary)
                    } label: {
                        Label("Machines", systemImage: "desktopcomputer")
                    }
                }
                AidenDefaultMachineRow(coordinator: coordinator)
            }

            Section {
                Button {
                    isShowingAppearance = true
                } label: {
                    Label("Appearance", systemImage: "circle.lefthalf.filled")
                }
                Picker("New workspace permission", selection: $defaultWorkspacePermissionRaw) {
                    ForEach(AidenWorkspacePermission.allCases, id: \.self) { permission in
                        Text(permission.title).tag(permission.rawValue)
                    }
                }
                .aidenPickerThatWrapsWhenLarge()
            } header: {
                Text("Global defaults")
            } footer: {
                Text("These are app-wide defaults. Permission, files, Git, and other workspace-specific options remain in each workspace’s ••• menu.")
            }

            Section {
                NavigationLink { AidenProvidersView(coordinator: coordinator) } label: {
                    Label("Providers", systemImage: "server.rack")
                }
            } footer: { Text("Manage model connections on your paired machine.") }

            Section {
                Toggle(
                    "Use memory",
                    isOn: Binding(
                        get: { memorySettings?.enabled ?? true },
                        set: { updateMemory($0) }
                    )
                )
                .disabled(memorySettings == nil || isSavingMemory)
                if let memoryError {
                    Text(memoryError).foregroundStyle(palette.dangerText)
                }
            } header: {
                Text("Memory")
            } footer: {
                Text("This controls memory on your paired machine. Turning it off stops recall, saving, and indexing without deleting existing approved facts. Workspace overrides are in each workspace’s ••• menu.")
            }

            Section {
                Text(readAloudStatus?.ready == true ? "Ready on your machine" : "Set up on your machine")
                if let readAloudError { Text(readAloudError).foregroundStyle(.secondary) }
                Button("Refresh status") { Task { await loadReadAloudStatus() } }
            } header: { Text("Read Aloud") } footer: {
                Text(AidenReadAloudStatus.setupGuidance + " Audio is retained only for this session; replay does not generate it again.")
            }

            Section {
                Picker("Transcription", selection: $voiceInputModeRaw) {
                    ForEach(AidenVoiceInputMode.allCases) { mode in
                        Text(mode.title).tag(mode.rawValue)
                    }
                }
                .aidenPickerThatWrapsWhenLarge()
                if voiceInputModeRaw == AidenVoiceInputMode.pairedMac.rawValue {
                    NavigationLink {
                        AidenMacTranscriptionSettingsView(coordinator: coordinator)
                    } label: {
                        Label("Desktop speech model", systemImage: "desktopcomputer")
                    }
                }
            } header: {
                Text("Voice input")
            } footer: {
                Text(
                    voiceInputModeRaw == AidenVoiceInputMode.pairedMac.rawValue
                        ? "Microphone audio is sent over Aiden's encrypted pinned connection, processed on-device by your paired machine, and not retained. Text appears after you stop recording."
                        : "Uses Apple's on-device Speech framework. Microphone audio stays on this device."
                )
            }

            Section {
                Toggle("Interaction haptics", isOn: Binding(
                    get: { haptics.isEnabled },
                    set: { haptics.isEnabled = $0 }
                ))
                .disabled(!haptics.supportsHaptics)
            } header: {
                Text("Feedback")
            } footer: {
                Text(haptics.supportsHaptics
                    ? "Adds subtle feedback to important actions and confirmed outcomes. Standard controls keep their system feedback."
                    : "Interaction haptics are not available on this device.")
            }

            Section("About") {
                Link(destination: AppConfig.privacyPolicyURL) {
                    Label("Privacy policy", systemImage: "hand.raised")
                }
                Link(destination: AppConfig.supportURL) {
                    Label("Support", systemImage: "questionmark.circle")
                }
                LabeledContent("License", value: "MIT")
            }
        }
        .navigationTitle("App settings")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadMemorySettings(); await loadReadAloudStatus() }
        .task(id: scenePhase) { if scenePhase == .active { await loadReadAloudStatus() } }
        .task(id: coordinator.server?.instanceId) { readAloudStatus = nil; await loadReadAloudStatus() }
        .sheet(isPresented: $isShowingAppearance) {
            AidenAppearanceSettingsView(appearance: appearance)
        }
    }
}

/// A menu picker shows its value on one line, which the system cuts in the
/// middle at the accessibility sizes ("Ask…ctions"). There it becomes a row
/// that pushes the list of choices, and the value wraps like any other text.
private struct AidenPickerThatWrapsWhenLarge: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            content.pickerStyle(.navigationLink)
        } else {
            content.pickerStyle(.menu)
        }
    }
}

extension View {
    func aidenPickerThatWrapsWhenLarge() -> some View {
        modifier(AidenPickerThatWrapsWhenLarge())
    }
}
