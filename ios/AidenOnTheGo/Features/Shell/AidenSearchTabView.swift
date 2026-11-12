import SwiftUI

/// The Search tab: loaded chats, matched on the phone, and Bot conversations,
/// which each connected machine matches itself. Rows are plain list rows.
struct AidenSearchTabView: View {
    let inboxStore: AidenUnifiedInboxStore
    let onOpen: (AidenAppRoute) -> Void

    @State private var model: AidenSearchModel
    @FocusState private var searchIsFocused: Bool
    /// What the last row needs below it so the search field, which grows with the
    /// text size, never sits on it.
    @ScaledMetric(relativeTo: .body) private var fieldClearance: CGFloat = 72
    @Environment(\.aidenPalette) private var palette
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    /// A regular-width toolbar folds the field into a button, even with the tab
    /// picked, so there the field sits under the title, always up.
    private var fieldPlacement: SearchFieldPlacement {
        horizontalSizeClass == .regular ? .navigationBarDrawer(displayMode: .always) : .automatic
    }

    init(
        coordinator: AidenRemoteCoordinator,
        inboxStore: AidenUnifiedInboxStore,
        onOpen: @escaping (AidenAppRoute) -> Void
    ) {
        self.inboxStore = inboxStore
        self.onOpen = onOpen
        _model = State(initialValue: AidenSearchModel(
            chatInput: { AidenSearchChatInput(store: inboxStore) },
            machines: { AidenSearchMachine.machines(in: coordinator) }
        ))
    }

    var body: some View {
        content
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle("Search")
            // Each change of the trimmed query searches again.
            .searchable(text: $model.query, placement: fieldPlacement, prompt: "Chats and Bots")
            // A regular width's active field otherwise hides the bar, and the
            // sidebar button with it, which is the only way back to the other tabs.
            .searchPresentationToolbarBehavior(horizontalSizeClass == .regular ? .avoidHidingContent : .automatic)
            .searchFocused($searchIsFocused)
            .task(id: model.trimmedQuery) { await model.run() }
    }

    @ViewBuilder
    private var content: some View {
        if !model.hasQuery {
            scrolling {
                ContentUnavailableView(
                    "Search",
                    systemImage: "magnifyingglass",
                    description: Text("Find a chat, or a Bot conversation on any of your machines.")
                )
            }
        } else {
            let chats = model.chats
            let bots = model.bots
            let unsearched = unsearchedNote(model.unsearchedMachines)
            if chats.isEmpty && bots.isEmpty {
                emptyResults(note: unsearched)
            } else {
                results(chats: chats, bots: bots, note: unsearched)
            }
        }
    }

    /// A state with no list scrolls like one, so all of it can be read at the
    /// largest text, and it leaves the keyboard the same way.
    private func scrolling<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView {
            content()
                .frame(maxWidth: .infinity)
                .padding(.top, AidenSpacing.xxxl)
        }
        .contentMargins(.bottom, fieldClearance, for: .scrollContent)
        .scrollBounceBehavior(.basedOnSize)
        .putsKeyboardAwayOnDrag(searchIsFocused: $searchIsFocused)
    }

    // MARK: Results

    private func results(chats: [AidenUnifiedInboxRow], bots: [AidenSearchBotHit], note: String?) -> some View {
        let details = model.chatDetails()
        let roster = inboxStore.roster
        return List {
            if !chats.isEmpty {
                Section("Chats") {
                    ForEach(chats) { row in
                        Button { open(row.route) } label: {
                            AidenSearchChatRowView(
                                row: row,
                                machineName: roster.searchMachineName(for: row.id.instanceId, else: details.machineName(for: row)),
                                workspaceName: details.workspaceName(for: row),
                                chip: roster.searchChip(for: row.id.instanceId)
                            )
                        }
                        .listRowBackground(palette.canvas)
                    }
                }
            }
            if !bots.isEmpty {
                Section("Bots") {
                    ForEach(bots) { hit in
                        Button { open(hit.route) } label: {
                            AidenSearchBotRowView(
                                hit: hit,
                                machineName: roster.searchMachineName(for: hit.id.instanceId, else: hit.machineName),
                                chip: roster.searchChip(for: hit.id.instanceId)
                            )
                        }
                            .listRowBackground(palette.canvas)
                    }
                }
            }
            if model.isSearchingBots || note != nil {
                Section {
                    if model.isSearchingBots {
                        HStack(spacing: AidenSpacing.m) {
                            ProgressView()
                            Text("Searching Bots")
                                .foregroundStyle(palette.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    if let note {
                        Text(note)
                            .font(.footnote)
                            .foregroundStyle(palette.secondary)
                    }
                }
                .listRowBackground(palette.canvas)
            }
        }
        .listStyle(.plain)
        .contentMargins(.bottom, fieldClearance, for: .scrollContent)
        .scrollContentBackground(.hidden)
        .putsKeyboardAwayOnDrag(searchIsFocused: $searchIsFocused)
        .foregroundStyle(palette.foreground)
    }

    private func emptyResults(note: String?) -> some View {
        scrolling {
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
                if let note {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, AidenSpacing.xxl)
                }
            }
        }
    }

    /// Says which machines' Bots weren't searched, so a missing result isn't read as "none".
    private func unsearchedNote(_ names: [String]) -> String? {
        guard !names.isEmpty else { return nil }
        let list = names.formatted(.list(type: .and))
        return String(localized: "Couldn’t search Bot conversations on \(list).")
    }

    private func open(_ route: AidenAppRoute) {
        if case .chat(let id) = route {
            inboxStore.homeModel(for: id.instanceId)?.markViewed(chatID: id.objectId)
        }
        onOpen(route)
    }
}

/// A chat found on some machine: its title, then where it lives.
private struct AidenSearchChatRowView: View {
    let row: AidenUnifiedInboxRow
    let machineName: String?
    let workspaceName: String?
    let chip: AidenMachineLabel?

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
                HStack(spacing: AidenSpacing.xs) {
                    if let chip { AidenMachineChip(label: chip) }
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                        .multilineTextAlignment(.leading)
                }
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
    let machineName: String
    let chip: AidenMachineLabel?

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AidenSpacing.m) {
            Image(systemName: AidenChromeSymbols.bots)
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
                HStack(spacing: AidenSpacing.xs) {
                    if let chip { AidenMachineChip(label: chip) }
                    Text("Bot conversation · \(machineName)")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                        .multilineTextAlignment(.leading)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, AidenSpacing.xs)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(String(localized: "\(hit.title), Bot conversation on \(machineName)"))
        .accessibilityValue(hit.preview ?? "")
    }
}

private extension View {
    /// Dragging the results lets go of the search field's focus, which puts the
    /// keyboard away and keeps the query. `scrollDismissesKeyboard` doesn't reach
    /// the field of a search tab, so the field's own focus is let go.
    func putsKeyboardAwayOnDrag(searchIsFocused: FocusState<Bool>.Binding) -> some View {
        onScrollPhaseChange { _, phase in
            if phase == .interacting { searchIsFocused.wrappedValue = false }
        }
    }
}
