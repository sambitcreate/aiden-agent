import SwiftUI

struct AidenProvidersView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @State private var catalog: AidenModelCatalog?
    @State private var errorMessage: String?
    @State private var showingCreation = false

    private var canCreate: Bool {
        coordinator.server?.features.contains("providers-create-v1") == true &&
        coordinator.server?.capabilities.contains(.workspaceManage) == true
    }

    var body: some View {
        List {
            Section {
                ForEach(catalog?.providers ?? []) { provider in
                    HStack(spacing: 12) {
                        AidenProviderIcon(providerID: provider.id, providerLabel: provider.label, artwork: provider.artwork)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(provider.label)
                            Text("\(provider.models.count) models").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if catalog == nil && errorMessage == nil { ProgressView("Loading providers") }
            } header: { Text("Connected to your Mac") } footer: {
                Text("Providers and API keys are stored on your paired Mac. Add a custom connection using the endpoint and exact model IDs your server accepts.")
            }
            Section {
                Button("Add provider", systemImage: "plus") { showingCreation = true }
                    .disabled(!canCreate)
                if !canCreate { Text("Connect to an updated Mac with permission to manage workspaces to add providers.").font(.footnote).foregroundStyle(.secondary) }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
                Button("Refresh providers") { Task { await load() } }
            }
        }
        .navigationTitle("Providers")
        .task(id: coordinator.server?.instanceId) { catalog = nil; await load() }
        .sheet(isPresented: $showingCreation) {
            AidenProviderCreationView(coordinator: coordinator) { await load() }
        }
    }

    private func load() async {
        guard let context = try? coordinator.requestContext() else { errorMessage = "Connect to your paired Mac."; return }
        do {
            let value = try await coordinator.remoteClient(for: context).modelCatalog()
            guard coordinator.isCurrent(context) else { return }
            catalog = value; errorMessage = nil
        } catch {
            guard coordinator.isCurrent(context) else { return }
            errorMessage = "Providers are unavailable. Refresh to try again."
        }
    }
}

private struct AidenProviderCreationView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let onSaved: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var baseURL = ""
    @State private var modelIDs = ""
    @State private var apiKey = ""
    @State private var needsKey = true
    @State private var kind = "openai"
    @State private var deployment = "hosted"
    @State private var vision = false
    @State private var reasoning = false
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var creationKey = UUID()
    @State private var submitted: AidenProviderCreation?
    @State private var ownerContext: AidenRemoteRequestContext?

    private var draft: AidenProviderCreation {
        AidenProviderCreation(label: label.trimmingCharacters(in: .whitespacesAndNewlines), baseUrl: baseURL.trimmingCharacters(in: .whitespacesAndNewlines), kind: kind, deployment: deployment, needsKey: needsKey,
            apiKey: needsKey ? apiKey.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
            models: modelIDs.split(separator: ",", omittingEmptySubsequences: false).map { AidenProviderCreationModel(id: $0.trimmingCharacters(in: .whitespacesAndNewlines), vision: vision, reasoning: reasoning, toolCall: true) })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    TextField("Name", text: $label)
                    TextField("Base URL", text: $baseURL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if needsKey { SecureField("API key", text: $apiKey).textInputAutocapitalization(.never).autocorrectionDisabled() }
                }
                Section {
                    TextField("Model IDs, separated by commas", text: $modelIDs).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("Models") } footer: { Text("Use the exact IDs accepted by your server. The first model is the default. Saving does not contact the provider.") }
                Section {
                    DisclosureGroup("Connection options") {
                        Picker("API format", selection: $kind) { Text("OpenAI-compatible").tag("openai"); Text("Anthropic-compatible").tag("anthropic") }
                        Picker("Deployment", selection: $deployment) { Text("Hosted").tag("hosted"); Text("Local to the Mac").tag("local") }
                        Toggle("Requires API key", isOn: $needsKey)
                    }
                    DisclosureGroup("Model capabilities") {
                        Toggle("Vision", isOn: $vision)
                        Toggle("Reasoning", isOn: $reasoning)
                        Text("Enable only features your server supports. These settings apply to every model entered above.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if [label, baseURL, modelIDs, apiKey].contains(where: { !$0.isEmpty }), let message = draft.validationMessage {
                    Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
                }
                if let errorMessage { Section { Text(errorMessage).foregroundStyle(.red) } }
            }
            .disabled(saving)
            .navigationTitle("Add provider")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { apiKey = ""; dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) { Button(saving ? "Saving…" : "Save") { Task { await save() } }.disabled(saving || !draft.isValid) }
            }
            .interactiveDismissDisabled(saving)
            .task { ownerContext = try? coordinator.requestContext() }
            .onChange(of: coordinator.server?.instanceId) { _, _ in apiKey = ""; submitted = nil; dismiss() }
            .onDisappear { apiKey = ""; submitted = nil }
        }
    }

    private func save() async {
        guard let context = ownerContext, coordinator.isCurrent(context), draft.isValid else { apiKey = ""; submitted = nil; dismiss(); return }
        let request = draft
        if submitted != request { creationKey = UUID(); submitted = request }
        saving = true
        defer { saving = false }
        do {
            _ = try await coordinator.remoteClient(for: context).createProvider(request, idempotencyKey: creationKey)
            guard coordinator.isCurrent(context) else { apiKey = ""; submitted = nil; dismiss(); return }
            apiKey = ""; submitted = nil
            await onSaved(); dismiss()
        } catch {
            guard coordinator.isCurrent(context) else { apiKey = ""; submitted = nil; dismiss(); return }
            errorMessage = "Couldn't save the provider. Check the connection details and try again."
        }
    }
}
