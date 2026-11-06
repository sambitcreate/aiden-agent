import SwiftUI

struct AidenOpenWorkEditorView: View {
    @Bindable var model: AidenBotOpenWorkModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var confirmingDiscard = false
    var body: some View {
        NavigationStack {
            Form {
                if !model.canWrite {
                    Section { Text("Connect to your paired host with Bot write access to save. Your draft is kept.") }
                }
                if model.uncertain { AidenOpenWorkPendingSection(model: model) }
                if let conflict = model.conflict {
                    Section("Changed on your host") {
                        Text("Your draft is kept. Review the saved version before using its revision.")
                        Text(conflict.title).font(.headline)
                        if !conflict.note.isEmpty { Text(conflict.note) }
                        LabeledContent("Saved state", value: conflict.state.title)
                        if let reason = conflict.waitingReason { Text(reason) }
                        Button("Keep draft and use latest version") { model.useLatestRevision() }
                            .disabled(!model.canEditDraft)
                    }
                }
                if model.addNeedsReview {
                    Section("Open work changed on your host") {
                        Text("Your new item is kept as a draft. Refresh and review the latest work before adding it.")
                        Text(model.countSummary).foregroundStyle(palette.secondary)
                        Button("Refresh host state") { Task { await model.load() } }
                        Button("Keep draft and use latest list") { model.useLatestRevision() }
                            .disabled(!model.canEditDraft)
                    }
                }
                if model.wasRemoved {
                    Section { Text("This item was removed on your host. Your draft is kept for reference and can’t recreate that item.") }
                }
                if let stop = model.baseline?.lastStop, !stop.state.isTerminal {
                    Section { Text(stop.description) }
                }
                Section {
                    TextField("Title", text: binding(\.title, default: ""), axis: .vertical)
                        .lineLimit(1...4).accessibilityIdentifier("open-work.title")
                }
                .disabled(!model.canEditDraft)
                Section("Notes") {
                    TextField("What should be kept with this item?", text: binding(\.note, default: ""), axis: .vertical)
                        .lineLimit(3...10).accessibilityLabel("Notes").accessibilityIdentifier("open-work.note")
                }
                .disabled(!model.canEditDraft)
                if model.baseline != nil {
                    Section("State") {
                        Picker("State", selection: binding(\.state, default: .open)) {
                            ForEach(AidenOpenWorkState.allCases) { Text($0.title).tag($0) }
                        }
                        if model.draft?.state == .waiting {
                            TextField("What is it waiting for?", text: binding(\.waitingReason, default: ""), axis: .vertical)
                                .lineLimit(1...4).accessibilityLabel("Waiting reason")
                        }
                    }
                    .disabled(!model.canEditDraft)
                } else {
                    Section { Text("Adding creates an Open item. Ask your Bot in chat when you want it to work on the task.").foregroundStyle(palette.secondary) }
                }
                if let validation = validationMessage {
                    Section { Text(validation).font(.footnote).foregroundStyle(palette.secondary) }
                }
                Section {
                    Button("Discard draft", role: .destructive) { confirmingDiscard = true }
                        .disabled(model.isBusy || model.uncertain)
                }
            }
            .scrollContentBackground(.hidden).background(palette.canvas)
            .navigationTitle(model.baseline == nil ? "Add item" : "Edit item").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(model.isBusy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await model.saveDraft() } }
                        .disabled(!model.canSave).accessibilityIdentifier("open-work.save")
                }
            }
            .interactiveDismissDisabled(model.isBusy)
            .onChange(of: model.draft == nil) { _, absent in if absent { dismiss() } }
            .confirmationDialog("Discard this draft?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard draft", role: .destructive) { model.discardDraft(); dismiss() }
            }
            .alert("Open work", isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
                Button("OK", role: .cancel) { model.message = nil }
            } message: { Text(model.message ?? "") }
        }
    }
    private var validationMessage: String? {
        guard let draft = model.draft else { return nil }
        if draft.state == .waiting, draft.waitingReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Add a waiting reason before saving."
        }
        if !draft.title.isEmpty, (try? AidenOpenWorkWire.text(draft.title, scalars: 160, bytes: 640)) == nil {
            return "Shorten the title before saving."
        }
        if (try? AidenOpenWorkWire.text(draft.note, scalars: 1000, bytes: 2048, empty: true)) == nil {
            return "Shorten the note before saving."
        }
        if draft.state == .waiting, (try? AidenOpenWorkWire.text(draft.waitingReason, scalars: 160, bytes: 640)) == nil {
            return "Shorten the waiting reason before saving."
        }
        return nil
    }
    private func binding<T>(_ keyPath: WritableKeyPath<AidenOpenWorkDraft, T>, default fallback: T) -> Binding<T> {
        Binding(get: { model.draft?[keyPath: keyPath] ?? fallback }, set: { model.draft?[keyPath: keyPath] = $0 })
    }
}
