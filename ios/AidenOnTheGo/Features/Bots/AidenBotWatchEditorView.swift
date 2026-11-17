import SwiftUI

/// Native form over safe host-produced labels and typed conditions. Closing
/// keeps the draft; only Discard draft or a confirmed save removes it.
struct AidenBotWatchEditorView: View {
    @Bindable var model: AidenBotWatchModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var confirmingDelete = false
    @State private var confirmingRun = false
    @State private var confirmingDiscard = false

    var body: some View {
        NavigationStack {
            Form {
                if !model.canWrite {
                    Section { Text("Connect to your paired computer with Bot write access to make changes. Your draft is kept.") }
                }
                if model.uncertain {
                    Section("Waiting for confirmation") {
                        Text("The computer may have accepted this request. Your draft stays frozen until its outcome is known.")
                        Button("Check computer") { Task { await model.load() } }
                        Button("Retry same request") { Task { await model.retryPending() } }
                            .disabled(!model.canWrite || model.isBusy)
                    }
                }
                if let conflict = model.conflict {
                    Section("Changed on your computer") {
                        Text("Your draft is kept. Review the latest saved version before using its revision.")
                        Text(conflict.name).font(.headline)
                        Text(conflict.prompt)
                        Text(conflict.source.label).font(.footnote).foregroundStyle(palette.secondary)
                        Text("Every \(conflict.everyMinutes) minutes · \(conflict.enabled ? "Enabled" : "Paused")")
                        switch conflict.condition {
                        case let .email(sender, subject, unread):
                            if let sender { Text("Sender contains: \(sender)") }
                            if let subject { Text("Subject contains: \(subject)") }
                            Text(unread ? "Unread messages only" : "Read and unread messages")
                        case let .calendar(minutes, timezone):
                            Text("Next \(minutes) minutes · \(timezone)")
                        }
                        Button("Keep draft and use latest revision") { model.useLatestRevision() }
                            .disabled(!model.canEditDraft)
                    }
                }
                if model.wasRemoved {
                    Section { Text("This watch was removed on your computer. Your draft is kept for reference.") }
                }
                Section {
                    TextField("Name", text: binding(\.name, default: ""))
                        .accessibilityIdentifier("watch.name")
                }
                .disabled(!model.canEditDraft)
                sourceSection
                conditionSection
                Section("How often") {
                    Picker("Check every", selection: binding(\.everyMinutes, default: 30)) {
                        ForEach(model.selectedTemplate?.intervals ?? AidenBotWatchWire.intervals, id: \.self) {
                            Text("\($0) minutes").tag($0)
                        }
                    }
                }
                .disabled(!model.canEditDraft)
                Section("What should the Bot do?") {
                    TextField("For example, tell me when an important message arrives.", text: binding(\.prompt, default: ""), axis: .vertical)
                        .lineLimit(3...10)
                        .accessibilityIdentifier("watch.prompt")
                }
                .disabled(!model.canEditDraft)
                Section {
                    Button("Test check", systemImage: "checkmark.circle") { Task { await model.testDraft() } }
                        .disabled(!model.canTestDraft)
                } footer: {
                    Text("A test reads a bounded preview. It doesn’t run the Bot or change the saved baseline. To test edited conditions, discover and choose a source first.")
                }
                if let result = model.testResult { AidenBotWatchTestSection(result: result) }
                if let watch = model.baseline {
                    savedState(watch)
                }
                Section {
                    Button("Discard draft", role: .destructive) { confirmingDiscard = true }
                        .disabled(model.isBusy || model.uncertain)
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas)
            .navigationTitle(model.baseline == nil ? "New Watch" : "Watch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(model.isBusy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await model.saveDraft() } }
                        .disabled(!model.canSave)
                        .accessibilityIdentifier("watch.save")
                }
            }
            .interactiveDismissDisabled(model.isBusy)
            .onChange(of: model.draft == nil) { _, absent in if absent { dismiss() } }
            .confirmationDialog("Delete this watch?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete watch", role: .destructive) {
                    if let watch = model.baseline { Task { await model.remove(watch) } }
                }
            } message: { Text("Future checks stop. Work already admitted on your computer may still finish.") }
            .confirmationDialog("Run this watch now?", isPresented: $confirmingRun, titleVisibility: .visible) {
                Button("Run now") { if let watch = model.baseline { Task { await model.run(watch) } } }
            } message: { Text("Runs the saved watch under the Bot’s current access and limits. Unsaved draft changes are not used.") }
            .confirmationDialog("Discard this draft?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard draft", role: .destructive) { model.discardDraft(); dismiss() }
            }
            .alert("Watches", isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
                Button("OK", role: .cancel) { model.message = nil }
            } message: { Text(model.message ?? "") }
        }
    }

    private var sourceSection: some View {
        Section("Source") {
            Picker("Watch", selection: Binding(get: { model.draft?.templateID ?? .mailMessages }, set: model.selectTemplate)) {
                ForEach(model.list?.templates ?? []) { template in Text(template.title).tag(template.id) }
            }
            .disabled(!model.canEditDraft)
            if let template = model.selectedTemplate {
                Text(template.available ? template.description : template.unavailableReason ?? template.description)
                    .font(.footnote).foregroundStyle(palette.secondary)
            }
            if let current = model.baseline {
                LabeledContent("Saved source", value: current.source.label)
            }
            Button(model.sources == nil ? "Discover sources" : "Refresh sources", systemImage: "arrow.clockwise") {
                Task { await model.discover() }
            }
            .disabled(!model.canEditDraft || model.selectedTemplate?.available != true)
            if model.sources != nil {
                Picker("Account and resource", selection: binding(\.sourceChoiceID, default: nil)) {
                    Text(model.baseline == nil ? "Choose a source" : "Keep saved source").tag(String?.none)
                    ForEach(model.eligibleSources) { source in
                        Text(source.label).tag(Optional(source.id)).disabled(!source.available)
                    }
                }
                .disabled(!model.canEditDraft || model.selectedTemplate?.available != true)
                ForEach(model.eligibleSources.filter { !$0.available }) { source in
                    Text("\(source.label): \(source.unavailableReason ?? "Unavailable")")
                        .font(.footnote).foregroundStyle(palette.secondary)
                }
                ForEach(Array((model.sources?.unavailableReasons ?? []).enumerated()), id: \.offset) { _, reason in
                    Text(reason).font(.footnote).foregroundStyle(palette.secondary)
                }
                if model.eligibleSources.isEmpty {
                    Text("No sources found. Connect or repair this provider on your paired computer.")
                        .font(.footnote).foregroundStyle(palette.secondary)
                }
            }
        }
    }

    @ViewBuilder private var conditionSection: some View {
        if model.draft?.templateID == .mailMessages {
            Section("Match messages") {
                TextField("Sender contains (optional)", text: binding(\.sender, default: ""))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("Subject contains (optional)", text: binding(\.subject, default: ""))
                Toggle("Unread only", isOn: binding(\.unreadOnly, default: false))
            }
            .disabled(!model.canEditDraft)
        } else {
            Section("Upcoming window") {
                Stepper("Next \(model.draft?.lookAheadMinutes ?? 60) minutes", value: binding(\.lookAheadMinutes, default: 60), in: 15...1440, step: 15)
                Picker("Time zone", selection: binding(\.timezone, default: TimeZone.current.identifier)) {
                    ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0).tag($0) }
                }
            }
            .disabled(!model.canEditDraft || model.selectedTemplate?.available != true)
        }
    }

    private func savedState(_ watch: AidenBotWatch) -> some View {
        Section("Saved watch") {
            LabeledContent("Status", value: watch.state.label)
            if let stamp = watch.lastCheckAt { LabeledContent("Last checked", value: date(stamp)) }
            if let stamp = watch.nextCheckAt { LabeledContent("Next check", value: date(stamp)) }
            if let stamp = watch.lastRunAt { LabeledContent("Last run", value: date(stamp)) }
            if let error = watch.lastError { Text(error).foregroundStyle(palette.secondary) }
            Button(watch.enabled ? "Pause watch" : "Resume watch", systemImage: watch.enabled ? "pause" : "play") {
                Task { await model.setEnabled(watch, !watch.enabled) }
            }
            Button("Run now", systemImage: "play.circle") { confirmingRun = true }
            Button("Delete watch", role: .destructive) { confirmingDelete = true }
        }
        .disabled(!model.canEditDraft || model.conflict != nil || model.wasRemoved)
    }

    private func binding<T>(_ keyPath: WritableKeyPath<AidenBotWatchDraft, T>, default fallback: T) -> Binding<T> {
        Binding(get: { model.draft?[keyPath: keyPath] ?? fallback }, set: { model.draft?[keyPath: keyPath] = $0 })
    }

    private func date(_ milliseconds: Int) -> String {
        Date(timeIntervalSince1970: Double(milliseconds) / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}
