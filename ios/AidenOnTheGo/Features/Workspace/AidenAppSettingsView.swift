import SwiftUI

struct AidenAppSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AidenHapticCenter.self) private var haptics
    @Bindable var coordinator: AidenRemoteCoordinator
    @Bindable var appearance: AidenAppearanceStore
    let addInstallation: () -> Void

    @State private var isShowingInstallations = false
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
    @AppStorage("aiden.defaults.workspacePermission") private var defaultWorkspacePermissionRaw = AidenWorkspacePermission.ask.rawValue
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

    var body: some View {
        NavigationStack {
            Form {
                Section("Aiden Agent") {
                    LabeledContent(
                        "Connected desktop",
                        value: coordinator.installationStore.activeInstallation?.name ?? "Not connected"
                    )
                    Button {
                        isShowingInstallations = true
                    } label: {
                        Label("Paired Installations", systemImage: "desktopcomputer")
                    }
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
                } header: {
                    Text("Global Defaults")
                } footer: {
                    Text("These are app-wide defaults. Permission, files, Git, and other workspace-specific options remain in each workspace’s ••• menu.")
                }

                Section {
                    NavigationLink { AidenProvidersView(coordinator: coordinator) } label: {
                        Label("Providers", systemImage: "server.rack")
                    }
                } footer: { Text("Manage model connections on your paired Mac.") }

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
                        Text(memoryError).foregroundStyle(.red)
                    }
                } header: {
                    Text("Memory")
                } footer: {
                    Text("This controls memory on your paired Mac. Turning it off stops recall, saving, and indexing without deleting existing approved facts. Workspace overrides are in each workspace’s ••• menu.")
                }

                Section {
                    Text(readAloudStatus?.ready == true ? "Ready on your Mac" : "Set up on your Mac")
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
                    if voiceInputModeRaw == AidenVoiceInputMode.pairedMac.rawValue {
                        NavigationLink {
                            AidenMacTranscriptionSettingsView(coordinator: coordinator)
                        } label: {
                            Label("Desktop speech model", systemImage: "desktopcomputer")
                        }
                    }
                } header: {
                    Text("Voice Input")
                } footer: {
                    Text(
                        voiceInputModeRaw == AidenVoiceInputMode.pairedMac.rawValue
                            ? "Microphone audio is sent over Aiden's encrypted pinned connection, processed on-device by your paired Mac, and not retained. Text appears after you stop recording."
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
                        Label("Privacy Policy", systemImage: "hand.raised")
                    }
                    Link(destination: AppConfig.supportURL) {
                        Label("Support", systemImage: "questionmark.circle")
                    }
                    LabeledContent("License", value: "MIT")
                }
            }
            .navigationTitle("App Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await loadMemorySettings(); await loadReadAloudStatus() }
        .task(id: scenePhase) { if scenePhase == .active { await loadReadAloudStatus() } }
        .task(id: coordinator.server?.instanceId) { readAloudStatus = nil; await loadReadAloudStatus() }
        .sheet(isPresented: $isShowingInstallations) {
            AidenInstallationsView(
                coordinator: coordinator,
                addInstallation: {
                    isShowingInstallations = false
                    addInstallation()
                }
            )
        }
        .sheet(isPresented: $isShowingAppearance) {
            AidenAppearanceSettingsView(appearance: appearance)
        }
    }
}
