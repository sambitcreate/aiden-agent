import SwiftUI

/// The Chats tab: every machine's chats, newest first, whatever their Inbox
/// placement. The Inbox triages; this is where any chat can be found again.
/// It reads only what the Inbox store already loaded.
struct AidenChatsTabView: View {
    let store: AidenUnifiedInboxStore
    let hasNoComputers: Bool
    let onAddComputer: () -> Void
    /// The route the detail beside the list shows, so its row reads as chosen.
    /// Nil on a stack.
    var selection: AidenAppRoute? = nil
    /// Home's greeting, Bots and digest, above the rows. Nil off Home.
    var header: AnyView? = nil
    /// Draws the ambient background behind the list; Home's root only.
    var showsAmbientBackground = false
    let onOpen: (AidenAppRoute) -> Void

    @Environment(\.aidenPalette) private var palette

    private var entries: [AidenChatListEntry] {
        AidenChatsList.entries(snapshots: Array(store.snapshots.values), hiddenMachines: store.hiddenMachines)
    }

    var body: some View {
        let entries = entries
        let roster = store.roster
        let positions = AidenListCardPosition.positions(entries.map(\.id))
        List {
            if let header {
                header
                // Under Home's header the empty state is a row, so it never
                // lies over the greeting. Sized to its content: a greedy
                // ContentUnavailableView in a self-sizing row never settles.
                emptyState(isEmpty: entries.isEmpty)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if store.listState == .loading, entries.isEmpty, !hasNoComputers {
                AidenChatListSkeleton(rowCount: 6, accessibilityText: "Loading chats")
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(palette.canvas)
            }
            ForEach(entries) { entry in
                let isSelected = selection?.screen == entry.route
                Button { open(entry) } label: {
                    AidenChatListRowView(
                        title: entry.title,
                        isOnline: entry.isOnline,
                        machineName: roster.searchMachineName(for: entry.id.instanceId, else: nil),
                        workspaceName: entry.workspaceName,
                        chip: roster.searchChip(for: entry.id.instanceId)
                    )
                    .aidenListScrollRow(entry.id)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
                .aidenListCardRow(positions[entry.id], isSelected: isSelected)
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(AidenSpacing.l)
        .aidenKeepsListScroll()
        .scrollContentBackground(.hidden)
        .aidenAmbientAurora(showsAmbientBackground)
        .background(palette.canvas.ignoresSafeArea())
        .overlay { if header == nil { emptyState(isEmpty: entries.isEmpty) } }
        .refreshable { await store.refreshAll() }
        .navigationTitle("Chats")
    }

    @ViewBuilder
    private func emptyState(isEmpty: Bool) -> some View {
        if hasNoComputers {
            AidenNoComputersEmptyView(surface: .chats, onAddComputer: onAddComputer)
        } else if isEmpty, store.listState != .loading {
            ContentUnavailableView(
                "No chats yet",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("Chats from your computers appear here.")
            )
        }
    }

    private func open(_ entry: AidenChatListEntry) {
        store.homeModel(for: entry.id.instanceId)?.markViewed(chatID: entry.id.objectId)
        onOpen(entry.route)
    }
}
