import SwiftUI

struct AidenBotOpenWorkView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let botID: String
    @Environment(\.aidenPalette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AidenBotOpenWorkModel?
    @State private var context: AidenRemoteRequestContext?
    var body: some View {
        Group {
            if let model, context.map(coordinator.isCurrent) == true, coordinator.server?.supportsBotOpenWork == true {
                AidenOpenWorkListView(model: model)
            } else {
                ContentUnavailableView("Open work unavailable", systemImage: "checklist",
                    description: Text("Connect to a paired host that supports Open work and grants Bot and chat access."))
            }
        }
        .navigationTitle("Open work")
        .navigationBarTitleDisplayMode(.inline)
        .background(palette.canvas.ignoresSafeArea())
        .task {
            guard model == nil, coordinator.server?.supportsBotOpenWork == true,
                  let current = try? coordinator.requestContext(), let client = try? coordinator.remoteClient(for: current) else { return }
            context = current
            model = AidenBotOpenWorkModel(botID: botID, transport: client, isCurrent: {
                coordinator.isCurrent(current) && coordinator.server?.supportsBotOpenWork == true
            }, mayWrite: {
                coordinator.connectionState == .connected && coordinator.installationStore.activeInstallation?.canWriteBots == true
            }, store: .shared, scope: .init(instanceID: current.instanceId, deviceID: current.deviceId, botID: botID))
            await model?.load()
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await model?.load()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { return }
                await model?.load()
            }
        }
        .onChange(of: coordinator.connectionState == .connected) { _, connected in
            if connected { Task { await model?.load() } }
        }
    }
}

struct AidenOpenWorkListView: View {
    @Bindable var model: AidenBotOpenWorkModel
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @State private var showingEditor = false
    @State private var selectedID: String?
    var body: some View {
        List {
            Section {
                Text("Responsibilities your Bot keeps with you. Adding an item records it; it doesn’t start a run or schedule work.")
                    .font(.subheadline).foregroundStyle(palette.secondary)
                    .listRowBackground(Color.clear)
            }
            if let error = model.loadError {
                Section {
                    Text(error).foregroundStyle(palette.secondary)
                    Button("Refresh") { Task { await model.load() } }
                }
            }
            if model.uncertain { AidenOpenWorkPendingSection(model: model) }
            if let snapshot = model.snapshot {
                if snapshot.items.isEmpty {
                    Section {
                        ContentUnavailableView("No open work yet", systemImage: "checklist",
                            description: Text("Add a responsibility, or ask your Bot to keep track of work you give it."))
                    }
                }
                ForEach(AidenOpenWorkState.allCases) { state in
                    let items = snapshot.items.filter { $0.state == state }
                    if !items.isEmpty {
                        Section(state.title) {
                            ForEach(items) { item in
                                Button { selectedID = item.id } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(item.title).foregroundStyle(palette.foreground)
                                        if let reason = item.waitingReason {
                                            Text(reason).font(.footnote).foregroundStyle(palette.secondary)
                                        } else if !item.note.isEmpty {
                                            Text(item.note).font(.footnote).foregroundStyle(palette.secondary).lineLimit(2)
                                        }
                                        if item.execution.state != .idle {
                                            Text(item.execution.state.rawValue.capitalized).font(.caption).foregroundStyle(palette.secondary)
                                        }
                                    }
                                    .accessibilityElement(children: .combine)
                                    .accessibilityHint("Opens item details and actions")
                                }
                                .buttonStyle(.plain)
                                .listRowBackground(palette.raised)
                            }
                        }
                    }
                }
                Section {
                    Text("\(model.countSummary). Your host keeps up to 64 active items and 128 items in history.")
                        .font(.footnote).foregroundStyle(palette.secondary)
                }
            } else if model.isLoading {
                Section {
                    ForEach(0..<3) { _ in
                        AidenBotSkeletonBlock(width: nil, height: 44, radius: 12, reduceMotion: reduceMotion)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Loading Open work")
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas.ignoresSafeArea())
        .refreshable { await model.load() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(model.draft == nil ? "Add item" : "Continue draft", systemImage: model.draft == nil ? "plus" : "pencil") {
                    if model.draft == nil { model.begin() }
                    showingEditor = true
                }
                .disabled(!model.canMutate)
            }
        }
        .sheet(isPresented: $showingEditor) { AidenOpenWorkEditorView(model: model) }
        .sheet(isPresented: Binding(get: { selectedID != nil }, set: { if !$0 { selectedID = nil } })) {
            if let selectedID { AidenOpenWorkDetailView(model: model, itemID: selectedID) }
        }
        .alert("Open work", isPresented: Binding(get: { model.message != nil && selectedID == nil && !showingEditor }, set: { if !$0 { model.message = nil } })) {
            Button("OK", role: .cancel) { model.message = nil }
        } message: { Text(model.message ?? "") }
    }
}

struct AidenOpenWorkPendingSection: View {
    @Bindable var model: AidenBotOpenWorkModel
    var body: some View {
        Section(model.isCheckingStop ? "Waiting for Stop acknowledgement" : "Waiting for confirmation") {
            Text(model.isCheckingStop
                 ? "This Stop request hasn’t been confirmed. The item stays unfinished; Stop and dismiss waits for acknowledgement."
                 : "A previous request may have reached your host. Other changes wait until its outcome is known. Your draft is kept.")
            Button("Refresh host state") { Task { await model.load() } }
            Button(model.isCheckingStop ? "Check same Stop request" : "Retry same request") {
                Task { await model.retryPending() }
            }
            .disabled(!model.canWrite || model.isBusy)
        }
    }
}

private struct AidenOpenWorkEvidenceTarget: Identifiable {
    let item: AidenOpenWorkItem
    let kind: AidenOpenWorkEvidenceKind
    var id: String { "\(item.id):\(kind.rawValue)" }
}

struct AidenOpenWorkDetailView: View {
    @Bindable var model: AidenBotOpenWorkModel
    let itemID: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var editor = false
    @State private var evidenceTarget: AidenOpenWorkEvidenceTarget?
    @State private var confirming: AidenOpenWorkMutation.Action?
    private var item: AidenOpenWorkItem? { model.snapshot?.items.first { $0.id == itemID } }
    var body: some View {
        NavigationStack {
            Form {
                if model.uncertain { AidenOpenWorkPendingSection(model: model) }
                if let item {
                    Section {
                        Text(item.title).font(.headline).textSelection(.enabled)
                        if !item.note.isEmpty { Text(item.note).textSelection(.enabled) }
                        LabeledContent("State", value: item.state.title)
                        if let reason = item.waitingReason { LabeledContent("Waiting for", value: reason) }
                        if let completion = item.completion {
                            Text(completion.by == .person ? "Marked done by you." : "Marked done by the Bot.")
                                .font(.footnote).foregroundStyle(palette.secondary)
                        }
                    }
                    Section("Linked work") {
                        LabeledContent("Source", value: item.source.kind == .person ? "Person request" : "Routine")
                        LabeledContent("Execution", value: item.execution.state.rawValue.capitalized)
                        if let explanation = item.execution.explanation { Text(explanation).foregroundStyle(palette.secondary) }
                        if let stop = item.lastStop { Text(stop.description).foregroundStyle(palette.secondary) }
                        if item.hasSource {
                            Button("View source", systemImage: "text.bubble") { evidenceTarget = .init(item: item, kind: .source) }
                        }
                        if item.hasResult {
                            Button("View result", systemImage: "doc.text") { evidenceTarget = .init(item: item, kind: .result) }
                        }
                    }
                    Section {
                        Button("Edit item", systemImage: "pencil") {
                            if model.draft == nil { model.begin(item: item) }
                            if model.baseline?.id == item.id { editor = true }
                            else { model.message = "Continue or discard your saved draft before editing another item." }
                        }
                        if item.state == .done || item.state == .dismissed {
                            Button("Reopen", systemImage: "arrow.uturn.backward") { Task { await model.setState(item, .open) } }
                        } else {
                            Button("Mark done", systemImage: "checkmark.circle") { Task { await model.setState(item, .done) } }
                        }
                        if item.state != .dismissed {
                            Button("Dismiss", systemImage: "archivebox") { confirming = .dismiss }
                        }
                        if item.execution.canStop {
                            Button("Stop linked run", systemImage: "stop.circle") { confirming = .stop }
                            Button("Stop and dismiss", systemImage: "stop.circle.fill") { confirming = .stopAndDismiss }
                        }
                    }
                    .disabled(!model.canMutate || item.hasPendingStop)
                    if let option = model.snapshot?.undo.first(where: { $0.itemId == itemID }) {
                        Section {
                            Button("Undo last change", systemImage: "arrow.uturn.backward") { Task { await model.undo(option) } }
                                .disabled(!model.canMutate || item.hasPendingStop || !option.isAvailable())
                        } footer: {
                            Text("Undo is available for 24 hours unless the item changes. It restores metadata and doesn’t reverse effects already performed.")
                        }
                    }
                } else {
                    ContentUnavailableView("Item unavailable", systemImage: "checklist",
                        description: Text("It may have been removed on your host. Any saved draft is kept."))
                }
            }
            .scrollContentBackground(.hidden).background(palette.canvas)
            .navigationTitle("Open work").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .refreshable { await model.load() }
            .sheet(isPresented: $editor) { AidenOpenWorkEditorView(model: model) }
            .sheet(item: $evidenceTarget, onDismiss: { model.closeEvidence() }) { target in
                AidenOpenWorkEvidenceView(model: model, item: target.item, kind: target.kind)
            }
            .confirmationDialog(confirmationTitle, isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
                Button(confirmationAction, role: confirming == .dismiss ? .destructive : nil) {
                    if let confirming, let item { Task { await model.act(confirming, on: item) } }
                    confirming = nil
                }
            } message: { Text(confirmationMessage) }
            .alert("Open work", isPresented: Binding(get: { model.message != nil && !editor && evidenceTarget == nil }, set: { if !$0 { model.message = nil } })) {
                Button("OK", role: .cancel) { model.message = nil }
            } message: { Text(model.message ?? "") }
        }
    }
    private var confirmationTitle: String {
        switch confirming { case .stop: "Stop the linked run?"; case .stopAndDismiss: "Stop and dismiss this item?"; default: "Dismiss this item?" }
    }
    private var confirmationAction: String {
        switch confirming { case .stop: "Stop linked run"; case .stopAndDismiss: "Stop and dismiss"; default: "Dismiss" }
    }
    private var confirmationMessage: String {
        switch confirming {
        case .stop: "The host stops only the run linked to this item. The item stays unfinished."
        case .stopAndDismiss: "The item is dismissed only after the host confirms the linked run stopped or had already finished."
        default: "Dismiss keeps history and doesn’t stop a run. Undo won’t reverse external effects."
        }
    }
}

struct AidenOpenWorkEvidenceView: View {
    @Bindable var model: AidenBotOpenWorkModel
    let item: AidenOpenWorkItem
    let kind: AidenOpenWorkEvidenceKind
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let evidence = model.evidence {
                        Text(evidence.title).font(.headline)
                        Text(evidence.text).textSelection(.enabled)
                            .accessibilityIdentifier("open-work.evidence-text")
                        if evidence.truncated { Text("This is a truncated excerpt.").font(.footnote).foregroundStyle(palette.secondary) }
                        Text("Supporting transcript material. This excerpt does not by itself verify that the task succeeded.")
                            .font(.footnote).foregroundStyle(palette.secondary)
                    } else if let error = model.evidenceError {
                        ContentUnavailableView(error, systemImage: "doc.text")
                    } else {
                        Text("Loading \(kind.rawValue)…").foregroundStyle(palette.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(20)
            }
            .background(palette.canvas).navigationTitle(kind.title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .task { await model.loadEvidence(item: item, kind: kind) }
        .onDisappear { model.closeEvidence() }
    }
}
