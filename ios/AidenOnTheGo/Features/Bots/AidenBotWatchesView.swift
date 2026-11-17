import SwiftUI

/// Profile destination. A frozen host/device context prevents responses from
/// another pairing from entering this page; reconnect keeps the editor alive.
struct AidenBotWatchesView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    /// The Bot's own machine; nil follows the selected one.
    let machine: String?
    let botID: String
    @Environment(\.aidenPalette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AidenBotWatchModel?
    @State private var capturedContext: AidenRemoteRequestContext?
    @State private var modelRoutineID: String?

    var body: some View {
        Group {
            if let model, capturedContext.map(coordinator.holds) == true,
               coordinator.botServer(on: machine)?.supportsBotWatches == true {
                AidenBotWatchListView(model: model, onModel: coordinator.botServer(on: machine)?.supportsBotRoutineModels == true ? { modelRoutineID = $0 } : nil)
            } else {
                ContentUnavailableView("Watches unavailable", systemImage: "bell.badge",
                    description: Text("Connect to a paired computer that supports Bot watches."))
            }
        }
        .sheet(isPresented: Binding(get: { modelRoutineID != nil }, set: { if !$0 { modelRoutineID = nil } })) {
            if let modelRoutineID { AidenBotRoutineModelsView(coordinator: coordinator, machine: machine, botID: botID, routineID: modelRoutineID) }
        }
        .navigationTitle("Watches")
        .navigationBarTitleDisplayMode(.inline)
        .background(palette.canvas.ignoresSafeArea())
        .task {
            guard model == nil, coordinator.botServer(on: machine)?.supportsBotWatches == true,
                  let context = try? coordinator.botContext(on: machine),
                  let client = try? coordinator.remoteClient(for: context) else { return }
            capturedContext = context
            model = AidenBotWatchModel(botID: botID, transport: client, isCurrent: {
                coordinator.holds(context) && coordinator.botServer(on: machine)?.supportsBotWatches == true
            }, mayWrite: {
                coordinator.botConnectionState(on: machine) == .connected
                    && coordinator.botInstallation(on: machine)?.canWriteBots == true
            }, draftStore: .shared, draftScope: .init(instanceID: context.instanceId, deviceID: context.deviceId, botID: botID))
            await model?.load()
        }
        .task(id: scenePhase) {
            // Cache reads only. The host owns connector polling, even when this page closes.
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { return }
                await model?.load()
            }
        }
        .onChange(of: coordinator.botConnectionState(on: machine) == .connected) { _, connected in
            if connected { Task { await model?.load() } }
        }
    }
}

struct AidenBotWatchListView: View {
    @Bindable var model: AidenBotWatchModel
    var onModel: ((String) -> Void)?
    @Environment(\.aidenPalette) private var palette
    @State private var showingEditor = false
    @State private var deleting: AidenBotWatch?
    @State private var running: AidenBotWatch?

    var body: some View {
        List {
            Section {
                Text("Your paired computer checks these sources while Aiden is open and the computer is awake. Checks continue when this phone disconnects.")
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .listRowBackground(Color.clear)
            }
            if let error = model.loadError {
                Section {
                    Text(error).foregroundStyle(palette.secondary)
                    Button("Refresh") { Task { await model.load() } }
                }
            }
            if model.uncertain {
                Section("Waiting for confirmation") {
                    Text("A previous request may have reached your computer. Other changes wait until its outcome is known.")
                    Button("Check computer") { Task { await model.load() } }
                    Button("Retry same request") { Task { await model.retryPending() } }
                        .disabled(!model.canWrite || model.isBusy)
                }
            }
            if let list = model.list {
                if !list.supported {
                    Section { Text(list.unavailableReason ?? "Watches aren’t available on this computer.") }
                }
                if !list.watches.isEmpty {
                    Section {
                        ForEach(list.watches) { watch in
                            Button {
                                model.begin(watch: watch)
                                showingEditor = model.draft != nil
                            } label: {
                                watchRow(watch)
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Group {
                                    Button(watch.enabled ? "Pause" : "Resume", systemImage: watch.enabled ? "pause" : "play") {
                                    Task { await model.setEnabled(watch, !watch.enabled) }
                                }
                                if let onModel { Button("Model", systemImage: "slider.horizontal.3") { onModel(watch.id) } }
                                Button("Test check", systemImage: "checkmark.circle") { Task { await model.testSaved(watch) } }
                                Button("Run now", systemImage: "play.circle") { running = watch }
                                Button("Delete watch", systemImage: "trash", role: .destructive) { deleting = watch }
                                }
                                .disabled(!model.canWrite)
                            }
                            .disabled(model.isBusy || model.uncertain)
                            .listRowBackground(palette.raised)
                            if let onModel {
                                Button("Model for \(watch.name)", systemImage: "slider.horizontal.3") { onModel(watch.id) }
                                    .listRowBackground(palette.raised)
                            }
                        }
                    }
                } else if list.supported {
                    Section {
                        ContentUnavailableView("No watches yet", systemImage: "bell.badge",
                            description: Text("Choose a source and tell your Bot what to do when it changes."))
                    }
                }
                if !list.templates.isEmpty {
                    Section("Available sources") {
                        ForEach(list.templates) { template in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(template.title)
                                Text(template.available ? template.description : template.unavailableReason ?? template.description)
                                    .font(.footnote)
                                    .foregroundStyle(palette.secondary)
                            }
                            .accessibilityElement(children: .combine)
                            .listRowBackground(palette.raised)
                        }
                    }
                }
            } else if model.isLoading {
                Section { ProgressView("Loading watches") }
            }
            if let result = model.testResult, !showingEditor {
                AidenBotWatchTestSection(result: result)
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas.ignoresSafeArea())
        .refreshable { await model.load() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(model.draft == nil ? "Add watch" : "Continue draft", systemImage: model.draft == nil ? "plus" : "pencil") {
                    if model.draft == nil { model.begin() }
                    showingEditor = true
                }
                .disabled(!model.canWrite || model.isBusy || model.uncertain)
            }
        }
        .sheet(isPresented: $showingEditor) { AidenBotWatchEditorView(model: model) }
        .confirmationDialog("Delete this watch?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete watch", role: .destructive) {
                if let deleting { Task { await model.remove(deleting) } }
                deleting = nil
            }
        } message: { Text("This stops future checks. Work already admitted on your computer may still finish.") }
        .confirmationDialog("Run this watch now?", isPresented: Binding(get: { running != nil }, set: { if !$0 { running = nil } }), titleVisibility: .visible) {
            Button("Run now") {
                if let running { Task { await model.run(running) } }
                running = nil
            }
        } message: { Text("This asks your paired computer to run the Bot under its current access and limits.") }
        .alert("Watches", isPresented: Binding(get: { model.message != nil && !showingEditor }, set: { if !$0 { model.message = nil } })) {
            Button("OK", role: .cancel) { model.message = nil }
        } message: { Text(model.message ?? "") }
    }

    private func watchRow(_ watch: AidenBotWatch) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(watch.name).foregroundStyle(palette.foreground)
            Text(watch.source.label).font(.footnote).foregroundStyle(palette.secondary)
            Text("\(watch.state.label) · Every \(watch.everyMinutes) minutes")
                .font(.footnote).foregroundStyle(palette.secondary)
            if let error = watch.lastError { Text(error).font(.footnote).foregroundStyle(palette.secondary) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens watch settings")
    }
}

struct AidenBotWatchTestSection: View {
    let result: AidenBotWatchTestResult
    @Environment(\.aidenPalette) private var palette
    var body: some View {
        Section {
            Text("\(result.itemCount) matching items · \(result.changeCount) changes · \(result.result.rawValue.capitalized)")
            ForEach(Array(result.preview.enumerated()), id: \.offset) { _, label in Text(label).font(.footnote) }
        } header: {
            Text("Test check")
        } footer: {
            Text("Preview only. This doesn’t run the Bot or advance the saved baseline.")
                .foregroundStyle(palette.secondary)
        }
    }
}
