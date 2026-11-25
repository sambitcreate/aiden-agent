import SwiftUI

/// What a search found: loaded chats, matched on the phone, and Bot
/// conversations, which each connected machine matches itself. The drawer
/// shows it in place of its sections while its search field holds a query;
/// the field and the search's `.task` are the drawer's.
struct AidenSearchResultsView: View {
    /// The shell's, so the query and what it found outlive a fold, which
    /// builds this view again.
    let model: AidenSearchModel
    let inboxStore: AidenUnifiedInboxStore
    /// The drawer's search field. Dragging the results lets go of it.
    var searchIsFocused: FocusState<Bool>.Binding
    let onOpen: (AidenAppRoute) -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        let chats = model.chats
        let bots = model.bots
        let unsearched = unsearchedNote(model.unsearchedMachines)
        if chats.isEmpty && bots.isEmpty {
            emptyResults(note: unsearched)
        } else {
            results(chats: chats, bots: bots, note: unsearched)
        }
    }

    /// A state with no list scrolls like one, so all of it can be read at the
    /// largest text, and it leaves the keyboard the same way.
    private func scrolling<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView {
            content()
                .frame(maxWidth: .infinity)
                .padding(.top, AidenSpacing.xl)
        }
        .scrollBounceBehavior(.basedOnSize)
        .putsKeyboardAwayOnDrag(searchIsFocused: searchIsFocused)
    }

    // MARK: Results

    private func results(chats: [AidenUnifiedInboxRow], bots: [AidenSearchBotHit], note: String?) -> some View {
        let details = model.chatDetails()
        let roster = inboxStore.roster
        return List {
            if !chats.isEmpty {
                let positions = AidenListCardPosition.positions(chats.map(\.id))
                Section {
                    ForEach(chats) { row in
                        Button { open(row.route) } label: {
                            AidenChatListRowView(
                                title: row.chatTitle,
                                isOnline: row.isOnline,
                                machineName: roster.searchMachineName(for: row.id.instanceId, else: details.machineName(for: row)),
                                workspaceName: details.workspaceName(for: row),
                                chip: roster.searchChip(for: row.id.instanceId)
                            )
                        }
                        .buttonStyle(.plain)
                        .aidenListCardRow(positions[row.id])
                    }
                } header: {
                    AidenListSectionHeader(title: String(localized: "Chats"))
                }
            }
            if !bots.isEmpty {
                let positions = AidenListCardPosition.positions(bots.map(\.id))
                Section {
                    ForEach(bots) { hit in
                        Button { open(hit.route) } label: {
                            AidenSearchBotRowView(
                                hit: hit,
                                machineName: roster.searchMachineName(for: hit.id.instanceId, else: hit.machineName),
                                chip: roster.searchChip(for: hit.id.instanceId)
                            )
                        }
                        .buttonStyle(.plain)
                        .aidenListCardRow(positions[hit.id])
                    }
                } header: {
                    AidenListSectionHeader(title: String(localized: "Bots"))
                }
            }
            if model.isSearchingBots || note != nil {
                Section {
                    if model.isSearchingBots {
                        AidenChatListSkeleton(rowCount: 2, accessibilityText: "Searching Bots")
                            .listRowInsets(EdgeInsets())
                    }
                    if let note {
                        Text(note)
                            .font(.footnote)
                            .foregroundStyle(palette.secondary)
                    }
                }
                .listRowSeparator(.hidden)
                .listRowBackground(palette.canvas)
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(AidenSpacing.l)
        .scrollContentBackground(.hidden)
        .putsKeyboardAwayOnDrag(searchIsFocused: searchIsFocused)
        .foregroundStyle(palette.foreground)
    }

    private func emptyResults(note: String?) -> some View {
        scrolling {
            VStack(spacing: AidenSpacing.l) {
                if model.isSearchingBots {
                    // Results to come, not a spinner.
                    AidenChatListSkeleton(rowCount: 4, accessibilityText: "Searching Bots")
                        .padding(.horizontal, AidenSpacing.l)
                } else {
                    ContentUnavailableView(
                        "No results",
                        systemImage: "magnifyingglass",
                        description: Text("Search covers the chats Aiden has loaded and Bot conversations on connected computers. A chat that hasn’t loaded yet won’t appear here.")
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

/// A chat on some machine: its title, then where it lives. Search results
/// and the Chats tab list chats with it.
struct AidenChatListRowView: View {
    let title: String
    let isOnline: Bool
    let machineName: String?
    let workspaceName: String?
    let chip: AidenMachineLabel?

    @Environment(\.aidenPalette) private var palette

    private var machine: String { machineName ?? String(localized: "Unknown computer") }

    private var subtitle: String {
        [workspaceName, machine, isOnline ? nil : String(localized: "offline")]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    var body: some View {
        AidenListRowLayout(isStacked: false, hasSummary: true) {
            AidenListRowGlyph(systemName: "bubble.left")
        } title: {
            Text(title)
                .font(.body)
                .foregroundStyle(palette.foreground)
                .multilineTextAlignment(.leading)
        } summary: {
            HStack(spacing: AidenSpacing.xs) {
                if let chip { AidenMachineChip(label: chip) }
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(1)
            }
        } trailing: {
            EmptyView()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(
            isOnline
                ? String(localized: "\(title), chat on \(machine)")
                : String(localized: "\(title), chat on \(machine), offline")
        )
    }
}

private extension AidenUnifiedInboxRow {
    var chatTitle: String {
        guard case .chat(let summary, _) = content else { return "" }
        return summary.title
    }
}

/// A Bot conversation found on some machine.
private struct AidenSearchBotRowView: View {
    let hit: AidenSearchBotHit
    let machineName: String
    let chip: AidenMachineLabel?

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        AidenListRowLayout(isStacked: false, hasSummary: true) {
            AidenListRowGlyph(systemName: AidenChromeSymbols.bots)
        } title: {
            Text(hit.title)
                .font(.body)
                .foregroundStyle(palette.foreground)
                .multilineTextAlignment(.leading)
        } summary: {
            VStack(alignment: .leading, spacing: AidenSpacing.xs) {
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
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                }
            }
        } trailing: {
            EmptyView()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(String(localized: "\(hit.title), Bot conversation on \(machineName)"))
        .accessibilityValue(hit.preview ?? "")
    }
}

private extension View {
    /// Dragging the results lets go of the search field's focus, which puts the
    /// keyboard away and keeps the query.
    func putsKeyboardAwayOnDrag(searchIsFocused: FocusState<Bool>.Binding) -> some View {
        onScrollPhaseChange { _, phase in
            if phase == .interacting { searchIsFocused.wrappedValue = false }
        }
    }
}
