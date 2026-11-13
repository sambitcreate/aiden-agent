import SwiftUI

/// Contract revision 61 (`approvals:settings`): Settings → Approvals. The
/// mode with its one-line helper, then the rules grouped as on the Mac.
struct AidenApprovalSettingsView: View {
    @State var model: AidenApprovalSettingsModel
    @Environment(\.aidenPalette) private var palette
    @State private var isAddingRule = false

    var body: some View {
        Form {
            modeSection
            if let rules = model.rules {
                if rules.unreadable {
                    Section("Rules") {
                        Text(AidenApprovalSettingsCopy.unreadable)
                            .foregroundStyle(palette.secondary)
                        Button("Try Again") { Task { await model.load() } }
                    }
                } else {
                    ForEach([AidenApprovalRuleGroup.allow, .ask, .block], id: \.self) { group in
                        ruleSection(group)
                    }
                    let macRows = model.rows(in: .mac)
                    if !macRows.isEmpty {
                        Section {
                            ForEach(macRows) { row in ruleRow(row) }
                        } header: {
                            Text(AidenApprovalSettingsCopy.groupTitle(.mac))
                        } footer: {
                            Text("Commands, file changes and Computer Use you allowed for a workspace, a Bot or a chat. Remove one to be asked again.")
                        }
                    }
                }
            } else if model.isLoading {
                Section("Rules") { skeletonRows }
            }
            if let error = model.errorMessage {
                Section {
                    Text(error).foregroundStyle(palette.dangerText)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .navigationTitle("Approvals")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    isAddingRule = true
                } label: {
                    Label("Add Rule", systemImage: "plus")
                }
                .disabled(model.rules == nil || model.rules?.unreadable == true)
            }
        }
        .task { await model.load() }
        .refreshable { await model.load() }
        .sheet(isPresented: $isAddingRule) {
            AidenApprovalRulePickerView(model: model)
        }
    }

    @ViewBuilder
    private var modeSection: some View {
        Section {
            if let mode = model.mode {
                ForEach(AidenApprovalMode.allCases) { option in
                    let disabled = option == .auto && !mode.autoAvailable
                    Button {
                        Task { await model.setMode(option) }
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: mode.mode == option ? "largecircle.fill.circle" : "circle")
                                .foregroundStyle(mode.mode == option ? palette.accent : palette.secondary)
                                .font(.title3)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(AidenApprovalSettingsCopy.title(option))
                                    .foregroundStyle(palette.foreground)
                                Text(disabled ? AidenApprovalSettingsCopy.autoUnavailable : AidenApprovalSettingsCopy.help(option))
                                    .font(.footnote)
                                    .foregroundStyle(palette.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(disabled || model.isSavingMode)
                    .opacity(disabled ? 0.55 : 1)
                    .accessibilityAddTraits(mode.mode == option ? [.isSelected] : [])
                    .accessibilityIdentifier("aiden.approval-mode.\(option.rawValue)")
                }
            } else {
                skeletonRows
            }
        } header: {
            Text("When Aiden asks")
        }
    }

    private var skeletonRows: some View {
        ForEach(0..<3, id: \.self) { _ in
            VStack(alignment: .leading, spacing: 6) {
                AidenBotSkeletonBlock(width: 90, height: 14, radius: 7, reduceMotion: false)
                AidenBotSkeletonBlock(width: 220, height: 12, radius: 6, reduceMotion: false)
            }
            .padding(.vertical, 4)
            .accessibilityHidden(true)
        }
    }

    private func ruleSection(_ group: AidenApprovalRuleGroup) -> some View {
        let rows = model.rows(in: group)
        return Section {
            if rows.isEmpty {
                Text(AidenApprovalSettingsCopy.groupEmpty(group))
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            } else {
                ForEach(rows) { row in ruleRow(row) }
            }
        } header: {
            Text(AidenApprovalSettingsCopy.groupTitle(group))
        }
    }

    private func ruleRow(_ row: AidenApprovalRuleRow) -> some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .foregroundStyle(palette.foreground)
                Text("\(row.kind) · \(AidenApprovalSettingsCopy.scope(row))")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                if row.handOff?.on == true {
                    Text("Hands the step to you")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                }
            }
            Spacer(minLength: 8)
            Menu {
                ForEach(row.decisions, id: \.self) { decision in
                    Button {
                        Task { await model.change(row, to: decision) }
                    } label: {
                        if AidenApprovalSettingsModel.group(for: decision) == row.group {
                            Label(AidenApprovalSettingsCopy.decisionTitle(decision), systemImage: "checkmark")
                        } else {
                            Text(AidenApprovalSettingsCopy.decisionTitle(decision))
                        }
                    }
                }
                if !row.decisions.isEmpty { Divider() }
                Button("Remove", role: .destructive) { Task { await model.remove(row) } }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.title3)
                    .foregroundStyle(palette.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Change \(row.title)")
            .disabled(model.busyRefs.contains(row.ref))
        }
        .swipeActions {
            Button("Remove", role: .destructive) { Task { await model.remove(row) } }
        }
    }
}

/// Add rule: pick a tool or a connected app from the Mac's list, then Allow,
/// Ask or Block.
struct AidenApprovalRulePickerView: View {
    let model: AidenApprovalSettingsModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var query = ""
    @State private var chosen: AidenApprovalRulePickerOption?
    @State private var decision: AidenApprovalRuleDecision = .ask

    private var options: [AidenApprovalRulePickerOption] {
        let all = model.picker?.options ?? []
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return all }
        return all.filter { $0.label.localizedCaseInsensitiveContains(trimmed) }
    }

    private var groups: [String] {
        options.reduce(into: [String]()) { result, option in
            if !result.contains(option.group) { result.append(option.group) }
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if model.picker == nil {
                    Section {
                        ForEach(0..<4, id: \.self) { _ in
                            AidenBotSkeletonBlock(width: 160, height: 14, radius: 7, reduceMotion: false)
                                .accessibilityHidden(true)
                        }
                    }
                }
                ForEach(groups, id: \.self) { group in
                    Section(group) {
                        ForEach(options.filter { $0.group == group }) { option in
                            Button {
                                chosen = option
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(option.label).foregroundStyle(palette.foreground)
                                        if let description = option.description {
                                            Text(description).font(.footnote).foregroundStyle(palette.secondary)
                                        }
                                    }
                                    Spacer()
                                    if chosen == option {
                                        Image(systemName: "checkmark").foregroundStyle(palette.accent)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if chosen != nil {
                    Section("Decision") {
                        Picker("Decision", selection: $decision) {
                            ForEach(AidenApprovalRuleDecision.allCases, id: \.self) { decision in
                                Text(AidenApprovalSettingsCopy.decisionTitle(decision)).tag(decision)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
            }
            .searchable(text: $query, prompt: "Search tools and apps")
            .navigationTitle("Add Rule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        guard let chosen else { return }
                        Task {
                            if await model.add(chosen, decision: decision) { dismiss() }
                        }
                    }
                    .disabled(chosen == nil || model.isAdding)
                }
            }
            .task { if model.picker == nil { await model.loadPicker() } }
        }
    }
}
