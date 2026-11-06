import SwiftUI

/// The Search tab: loaded chats, matched on the phone, and Bot conversations,
/// which each connected machine matches itself. Rows are plain list rows.
struct AidenSearchTabView: View {
    let coordinator: AidenRemoteCoordinator
    let homeModel: AidenHomeModel
    let onOpen: (AidenAppRoute) -> Void

    @State private var model: AidenSearchModel
    @Environment(\.aidenPalette) private var palette

    init(
        coordinator: AidenRemoteCoordinator,
        homeModel: AidenHomeModel,
        onOpen: @escaping (AidenAppRoute) -> Void
    ) {
        self.coordinator = coordinator
        self.homeModel = homeModel
        self.onOpen = onOpen
        _model = State(initialValue: AidenSearchModel(
            chatInput: { AidenSearchChatInput.selectedMachine(of: coordinator, chats: homeModel.chats) },
            machines: { AidenSearchMachine.machines(in: coordinator) }
        ))
    }

    var body: some View {
        content
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle("Search")
            // The query is the field's text; each change searches again.
            .searchable(text: $model.query, prompt: "Chats and Bots")
            .task(id: model.query) { await model.run() }
    }

    @ViewBuilder
    private var content: some View {
        if !model.hasQuery {
            ContentUnavailableView(
                "Search",
                systemImage: "magnifyingglass",
                description: Text("Find a chat, or a Bot conversation on any of your machines.")
            )
        } else {
            let chats = model.chats
            let bots = model.bots
            if chats.isEmpty && bots.isEmpty {
                emptyResults
            } else {
                results(chats: chats, bots: bots)
            }
        }
    }

    // MARK: Results

    private func results(chats: [AidenUnifiedInboxRow], bots: [AidenSearchBotHit]) -> some View {
        List {
            if !chats.isEmpty {
                Section("Chats") {
                    ForEach(chats) { row in
                        Button { open(row.route) } label: {
                            AidenSearchChatRowView(
                                row: row,
                                machineName: model.machineName(for: row.id.instanceId),
                                workspaceName: model.workspaceName(for: row)
                            )
                        }
                        .listRowBackground(palette.canvas)
                    }
                }
            }
            if !bots.isEmpty {
                Section("Bots") {
                    ForEach(bots) { hit in
                        Button { open(hit.route) } label: { AidenSearchBotRowView(hit: hit) }
                            .listRowBackground(palette.canvas)
                    }
                }
            }
            if model.isSearchingBots || !model.unsearchedMachines.isEmpty {
                Section {
                    if model.isSearchingBots {
                        HStack(spacing: AidenSpacing.m) {
                            ProgressView()
                            Text("Searching Bots")
                                .foregroundStyle(palette.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    if let note = unsearchedNote {
                        Text(note)
                            .font(.footnote)
                            .foregroundStyle(palette.secondary)
                    }
                }
                .listRowBackground(palette.canvas)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        // Reading the results puts the keyboard away.
        .scrollDismissesKeyboard(.immediately)
        .foregroundStyle(palette.foreground)
    }

    private var emptyResults: some View {
        VStack(spacing: AidenSpacing.l) {
            if model.isSearchingBots {
                ProgressView("Searching Bots")
                    .padding(AidenSpacing.xxl)
            } else {
                ContentUnavailableView(
                    "No results",
                    systemImage: "magnifyingglass",
                    description: Text("Search covers the chats Aiden has loaded and Bot conversations on connected machines. A chat that hasn’t loaded yet won’t appear here.")
                )
            }
            if let note = unsearchedNote {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, AidenSpacing.xxl)
            }
        }
    }

    /// Says which machines' Bots weren't searched, so a missing result isn't read as "none".
    private var unsearchedNote: String? {
        let names = model.unsearchedMachines
        guard !names.isEmpty else { return nil }
        let list = names.formatted(.list(type: .and))
        return String(localized: "Couldn’t search Bot conversations on \(list).")
    }

    private func open(_ route: AidenAppRoute) {
        if case .chat(let id) = route, id.instanceId == coordinator.activeInstanceId {
            homeModel.markViewed(chatID: id.objectId)
        }
        onOpen(route)
    }
}

/// A chat found on some machine: its title, then where it lives.
private struct AidenSearchChatRowView: View {
    let row: AidenUnifiedInboxRow
    let machineName: String?
    let workspaceName: String?

    @Environment(\.aidenPalette) private var palette

    private var title: String {
        guard case .chat(let summary, _) = row.content else { return "" }
        return summary.title
    }

    private var machine: String { machineName ?? String(localized: "Unknown machine") }

    private var subtitle: String {
        [workspaceName, machine, row.isOnline ? nil : String(localized: "offline")]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AidenSpacing.m) {
            Image(systemName: "bubble.left")
                .foregroundStyle(palette.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: AidenSpacing.xs) {
                Text(title)
                    .font(.body)
                    .foregroundStyle(palette.foreground)
                    .multilineTextAlignment(.leading)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, AidenSpacing.xs)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(
            row.isOnline
                ? String(localized: "\(title), chat on \(machine)")
                : String(localized: "\(title), chat on \(machine), offline")
        )
    }
}

/// A Bot conversation found on some machine.
private struct AidenSearchBotRowView: View {
    let hit: AidenSearchBotHit

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AidenSpacing.m) {
            Image(systemName: AidenProductArea.bots.symbol)
                .foregroundStyle(palette.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: AidenSpacing.xs) {
                Text(hit.title)
                    .font(.body)
                    .foregroundStyle(palette.foreground)
                    .multilineTextAlignment(.leading)
                if let preview = hit.preview {
                    Text(preview)
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                }
                Text("Bot conversation · \(hit.machineName)")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, AidenSpacing.xs)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(String(localized: "\(hit.title), Bot conversation on \(hit.machineName)"))
        .accessibilityValue(hit.preview ?? "")
    }
}
