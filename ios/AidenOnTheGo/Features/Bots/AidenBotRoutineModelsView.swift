import SwiftUI

struct AidenBotRoutineModelsView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    /// The Bot's own machine; nil follows the selected one.
    let machine: String?
    let botID: String; let routineID: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var isVisible = false
    @State private var model: AidenBotRoutineModelsModel?
    @State private var context: AidenRemoteRequestContext?
    var body: some View {
        NavigationStack {
            Group {
                if let model, context.map(coordinator.holds) == true, coordinator.botServer(on: machine)?.supportsBotRoutineModels == true {
                    AidenRoutineModelForm(model: model)
                } else {
                    ContentUnavailableView("Routine models unavailable", systemImage: "slider.horizontal.3",
                        description: Text("Connect to a computer that supports routine models and grants Bot and chat access."))
                }
            }
            .navigationTitle("Routine model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            if let model { await model.load(); return }
            guard coordinator.botServer(on: machine)?.supportsBotRoutineModels == true,
                  let current = try? coordinator.botContext(on: machine), let client = try? coordinator.remoteClient(for: current) else { return }
            context = current
            model = AidenBotRoutineModelsModel(botID: botID, routineID: routineID, transport: client,
                isCurrent: { isVisible && coordinator.holds(current) && coordinator.botServer(on: machine)?.supportsBotRoutineModels == true },
                mayWrite: { UIApplication.shared.applicationState == .active && coordinator.botConnectionState(on: machine) == .connected && coordinator.botInstallation(on: machine)?.canWriteBots == true },
                store: .shared, scope: .init(instanceID: current.instanceId, deviceID: current.deviceId, botID: botID, routineID: routineID))
            await model?.load()
        }
        .onChange(of: coordinator.botConnectionState(on: machine) == .connected) { _, connected in if connected, scenePhase == .active { Task { await model?.load() } } }
    }
}

struct AidenRoutineModelForm: View {
    @Bindable var model: AidenBotRoutineModelsModel
    @Environment(\.aidenPalette) private var palette
    var body: some View {
        Form {
            Section {
                Text("Choose models for future runs of this routine. Saving authorizes only these routine choices under the Bot’s rules and spending limits. Its default model stays the same.")
                    .font(.subheadline).foregroundStyle(palette.secondary)
            }
            if model.loading { Section { ProgressView("Loading routine models") } }
            if let message = model.message { Section { Text(message).foregroundStyle(palette.secondary) } }
            if model.pending != nil {
                Section("Waiting for confirmation") {
                    Text("The computer may have saved this selection. Other changes wait until its outcome is known.")
                    Button("Refresh saved selection") { Task { await model.load() } }
                    Button("Retry same request") { Task { await model.retry() } }.disabled(!model.canWrite || model.busy)
                }
            }
            if model.needsReview {
                Section("Changed on your computer") {
                    Text("Review the current selection before saving your retained draft.")
                    if let saved = model.settings { selectionSummary(saved.selection) }
                    Button("Keep draft and use current revision") { model.keepDraft() }.disabled(!model.canEdit)
                    Button("Use saved selection") { model.useSaved() }.disabled(!model.canEdit)
                }
            }
            if let selection = model.draft {
                Section("Model") {
                    Button { model.inherit() } label: {
                        HStack { Text("Inherit Bot model"); Spacer(); if selection == .inherit { Image(systemName: "checkmark").accessibilityLabel("Selected") } }
                    }.disabled(!model.canEdit)
                    if let primary = selection.primary {
                        choiceRow("Primary", choice: primary, fallback: false)
                        if let fallback = selection.fallback {
                            choiceRow("Fallback", choice: fallback, fallback: true)
                            Button("Remove fallback") { model.clearFallback() }.disabled(!model.canEdit)
                        } else { pickerLink("Add explicit fallback", fallback: true) }
                    } else { pickerLink("Choose a model for this routine", fallback: false) }
                    if selection.primary != nil { pickerLink("Change primary model", fallback: false) }
                }
                if selection.primary != nil {
                    Section { Text("An unavailable explicit model stops with Needs you. Another model runs only when you configure a fallback here; access and spending limits still apply.").font(.footnote).foregroundStyle(palette.secondary) }
                }
                Section {
                    Button("Save routine model") { Task { await model.save() } }
                        .disabled(!model.canSave).accessibilityIdentifier("routine-model.save")
                }
            }
            if !model.runs.isEmpty {
                Section("Recent runs") {
                    ForEach(model.runs) { run in NavigationLink { AidenRoutineModelRunView(run: run) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(run.model.providerLabel) · \(run.model.modelLabel)")
                            Text("\(run.triggerKind.rawValue.replacingOccurrences(of: "_", with: " ").capitalized) · \(date(run.admittedAt))")
                                .font(.footnote).foregroundStyle(palette.secondary)
                            if run.model.fallbackReason != nil { Text("Configured fallback used").font(.footnote).foregroundStyle(palette.secondary) }
                        }
                    } }
                }
            }
            Section { Button("Refresh") { Task { await model.load() } }.disabled(model.loading || model.busy) }
        }
        .scrollContentBackground(.hidden).background(palette.canvas)
    }
    @ViewBuilder private func choiceRow(_ title: String, choice: AidenRoutineModelChoice, fallback: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline)
            Text(model.catalog?.label(choice) ?? "Saved model").foregroundStyle(palette.secondary)
            Text("Thinking: \(choice.thinkingLevel.title)").font(.footnote).foregroundStyle(palette.secondary)
            if model.catalog?.admits(choice) != true { Text("Unavailable — this choice is retained. Choose an available model and thinking level to change it.").font(.footnote).foregroundStyle(palette.secondary) }
        }.accessibilityElement(children: .combine)
        pickerLink("Change \(title.lowercased()) thinking or model", fallback: fallback)
    }
    private func pickerLink(_ title: String, fallback: Bool) -> some View {
        NavigationLink(title) { AidenRoutineModelPicker(model: model, fallback: fallback) }
            .disabled(!model.canEdit || model.catalog == nil)
    }
    @ViewBuilder private func selectionSummary(_ selection: AidenRoutineModelSelection) -> some View {
        if let primary = selection.primary {
            Text("Primary: \(model.catalog?.label(primary) ?? "Saved model") · \(primary.thinkingLevel.title)")
            if let fallback = selection.fallback { Text("Fallback: \(model.catalog?.label(fallback) ?? "Saved model") · \(fallback.thinkingLevel.title)") }
        } else { Text("Inherit Bot model") }
    }
}

struct AidenRoutineModelPicker: View {
    @Bindable var model: AidenBotRoutineModelsModel
    let fallback: Bool
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            ForEach(model.catalog?.providers ?? []) { provider in
                Section(provider.label) {
                    ForEach(provider.models) { option in
                        DisclosureGroup {
                            ForEach(option.thinkingLevels) { thinking in
                                Button(thinking.title) {
                                    model.select(.init(providerId: provider.id, modelId: option.id, thinkingLevel: thinking), fallback: fallback)
                                    dismiss()
                                }.disabled(!model.canEdit || !provider.available || !option.available)
                            }
                        } label: {
                            VStack(alignment: .leading) {
                                Text(option.label)
                                if !provider.available || !option.available { Text("Unavailable").font(.footnote) }
                                else { Text(option.supportsImages ? "Supports images" : "Text only").font(.footnote) }
                                if option.thinkingLevels.isEmpty { Text("No supported thinking level").font(.footnote) }
                            }
                        }
                    }
                }
            }
        }.navigationTitle(fallback ? "Fallback model" : "Primary model")
    }
}
struct AidenRoutineModelRunView: View {
    let run: AidenRoutineModelRun
    var body: some View {
        Form {
            Section("Chosen") {
                LabeledContent("Provider", value: run.model.chosenProviderLabel)
                LabeledContent("Model", value: run.model.chosenModelLabel)
                LabeledContent("Thinking", value: run.model.chosen.thinkingLevel.title)
            }
            Section("Actual") {
                LabeledContent("Provider", value: run.model.providerLabel)
                LabeledContent("Model", value: run.model.modelLabel)
                LabeledContent("Thinking", value: run.model.actual.thinkingLevel.title)
                if let reason = run.model.fallbackReason {
                    Text(reason == .modelUnavailable ? "Configured fallback used because the chosen model was unavailable." : "Configured fallback used because the chosen provider credentials were unavailable.")
                }
            }
            Section("Timing") {
                LabeledContent("Trigger", value: run.triggerKind.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                LabeledContent("Admitted", value: date(run.admittedAt))
                if let started = run.startedAt { LabeledContent("Started", value: date(started)) }
                else { Text("Not started yet") }
                if let scheduled = run.scheduledFor {
                    LabeledContent("Scheduled for", value: date(scheduled, timezone: run.timezone))
                    if let timezone = run.timezone { LabeledContent("Time zone", value: timezone) }
                    if let started = run.startedAt, started > scheduled {
                        LabeledContent("Started late", value: Duration.seconds(Double(started - scheduled) / 1000).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .wide)))
                    }
                }
            }
        }.navigationTitle("Run model")
    }
}
private func date(_ ms: Int, timezone: String? = nil) -> String {
    let formatter = DateFormatter(); formatter.dateStyle = .medium; formatter.timeStyle = .medium
    if let timezone { formatter.timeZone = TimeZone(identifier: timezone) }
    return formatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
}

/// A name-only host directory also reaches existing URL/script event routines.
struct AidenBotRoutineModelDirectoryView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    /// The Bot's own machine; nil follows the selected one.
    let machine: String?
    let botID: String
    @State private var routines: [AidenRoutineModelDirectory.Routine] = []
    @State private var selected: AidenRoutineModelDirectory.Routine?
    @State private var loading = true
    @State private var error: String?
    @State private var context: AidenRemoteRequestContext?
    var body: some View {
        List {
            if let context, coordinator.holds(context), coordinator.botServer(on: machine)?.supportsBotRoutineModels == true {
                if routines.isEmpty, !loading, error == nil {
                    ContentUnavailableView("No routines yet", systemImage: "calendar.badge.clock", description: Text("Create a routine or watch first. New routines inherit the Bot model."))
                }
                ForEach(routines) { routine in
                    Button { selected = routine } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(routine.name)
                            Text(routine.kind.rawValue.capitalized).font(.footnote).foregroundStyle(.secondary)
                        }
                    }.accessibilityHint("Opens model choices and recent run facts")
                }
            }
            if loading { ProgressView("Loading routines") }
            if let error { Text(error); Button("Try again") { Task { await load() } } }
        }
        .navigationTitle("Routine models")
        .sheet(item: $selected) { routine in AidenBotRoutineModelsView(coordinator: coordinator, machine: machine, botID: botID, routineID: routine.id) }
        .task { await load() }
        .refreshable { await load() }
    }
    @MainActor private func load() async {
        guard coordinator.botServer(on: machine)?.supportsBotRoutineModels == true,
              let current = try? coordinator.botContext(on: machine), let client = try? coordinator.remoteClient(for: current) else {
            routines = []; loading = false; error = "Connect to a computer that supports routine model choices."; return
        }
        context = current; loading = true; defer { loading = false }
        do {
            let directory = try await client.routineModelDirectory(botId: botID)
            guard coordinator.holds(current) else { return }
            routines = directory.routines; error = nil
        } catch { if coordinator.holds(current) { self.error = "Routines couldn’t be loaded." } }
    }
}
