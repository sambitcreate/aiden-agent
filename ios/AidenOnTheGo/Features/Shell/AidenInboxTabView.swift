import SwiftUI

/// What a row can be asked to do. Mirrors `AidenInboxRowOffer`.
enum AidenInboxRowAction: Equatable {
    case markRead, done, snooze(AidenSnoozeOption), wake, undone
}

extension AidenInboxRowActions {
    /// Done and Unsnooze act at once. Snooze goes through `chooseSnooze`, which
    /// asks until when and comes back as `.snooze`.
    init(
        offer: AidenInboxRowOffer,
        perform: @escaping (AidenInboxRowAction) -> Void,
        chooseSnooze: @escaping () -> Void
    ) {
        self.init(offer: offer, markRead: { perform(.markRead) }, triage: { _ in }, snooze: chooseSnooze)
        done = offer.undone ? { perform(.undone) } : offer.done ? { perform(.done) } : nil
        snooze = offer.wake ? { perform(.wake) } : offer.snooze ? chooseSnooze : nil
    }
}

/// Every machine's chats in one list: Needs you, Updates, Earlier. Running chats
/// aren't listed here, because the accessory owns them.
struct AidenInboxTabView: View {
    let inbox: AidenUnifiedInbox
    var state = AidenInboxListState.rows
    var refreshFailed = false
    var moreChats = AidenInboxMoreChats.none
    var roster = AidenMachineRoster()
    var filter = Binding.constant(AidenMachineFilter.all)
    let onOpen: (AidenHostObjectID) -> Void
    let onAction: (AidenInboxRowAction, AidenHostObjectID) -> Void
    var onRefresh: () async -> Void = {}
    var onRetry: () -> Void = {}
    var onShowAllEarlier: () -> Void = {}
    var onLoadMore: () -> Void = {}
    var onReconnect: (String) -> Void = { _ in }

    @Environment(\.aidenPalette) private var palette
    @State private var snoozeCandidate: AidenHostObjectID?

    var body: some View {
        List {
            machineRows
            if refreshFailed { refreshErrorRow }
            if state == .loading {
                AidenChatListSkeleton(rowCount: 6, accessibilityText: "Loading Inbox")
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(palette.canvas)
            }
            section(.needsYou, rows: inbox.needsYou)
            section(.updates, rows: inbox.updates)
            section(.earlier, rows: inbox.earlier) {
                if inbox.earlierOverflow > 0 { showMoreRow }
            }
            if moreChats != .none { moreChatsRow }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(palette.canvas.ignoresSafeArea())
        .overlay { emptyState }
        .refreshable { await onRefresh() }
        .confirmationDialog(
            "Snooze until",
            isPresented: Binding(
                get: { snoozeCandidate != nil },
                set: { if !$0 { snoozeCandidate = nil } }
            ),
            titleVisibility: .visible,
            presenting: snoozeCandidate
        ) { id in
            ForEach(AidenSnoozeOption.options(now: Date())) { option in
                Button(option.label) { onAction(.snooze(option), id) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private func section(
        _ section: AidenInboxSection,
        rows: [AidenUnifiedInboxRow],
        @ViewBuilder footer: () -> some View = { EmptyView() }
    ) -> some View {
        if !rows.isEmpty {
            Section {
                ForEach(rows) { row in
                    listRow(row, in: section)
                }
                footer()
            } header: {
                AidenInboxSectionHeader(section: section, count: rows.count, palette: palette)
                    .textCase(nil)
            }
            .listSectionSeparator(.hidden)
        }
    }

    @ViewBuilder
    private func listRow(_ row: AidenUnifiedInboxRow, in section: AidenInboxSection) -> some View {
        switch row.content {
        case .chat(let summary, let placement):
            let actions = AidenInboxRowActions(
                offer: row.offer,
                perform: { onAction($0, row.id) },
                chooseSnooze: { snoozeCandidate = row.id }
            )
            AidenInboxListRow(
                row: AidenInboxProjection.Row(summary: summary, placement: placement),
                section: row.isPinned ? .pinned : section,
                workspaceName: row.workspaceName,
                palette: palette,
                actions: actions,
                isPinned: row.isPinned,
                machine: roster.rowChip(for: row.id.instanceId, filter: filter.wrappedValue),
                isDimmed: roster.isOffline(row.id.instanceId),
                open: { onOpen(row.id) }
            )
            .contextMenu { contextMenu(for: row, actions: actions) }
        }
    }

    /// The same actions as the swipes, with Snooze's choices one level in.
    @ViewBuilder
    private func contextMenu(for row: AidenUnifiedInboxRow, actions: AidenInboxRowActions) -> some View {
        if let markRead = actions.markRead {
            Button("Mark read", systemImage: "envelope.open", action: markRead)
        }
        if let done = actions.done {
            Button(actions.doneLabel, systemImage: "checkmark.circle", action: done)
        }
        if row.offer.snooze {
            Menu("Snooze", systemImage: "clock") {
                ForEach(AidenSnoozeOption.options(now: Date())) { option in
                    Button(option.label) { onAction(.snooze(option), row.id) }
                }
            }
        } else if let wake = actions.snooze {
            Button(actions.snoozeLabel, systemImage: "clock", action: wake)
        }
    }

    /// The filter strip, then a row for each offline machine the filter shows.
    @ViewBuilder
    private var machineRows: some View {
        if roster.showsStrip {
            AidenMachineStrip(labels: roster.visible, filter: filter)
                .listRowInsets(EdgeInsets(top: AidenSpacing.xs, leading: 0, bottom: AidenSpacing.xs, trailing: 0))
                .listRowSeparator(.hidden)
                .listRowBackground(palette.canvas)
        }
        ForEach(roster.offlineRows(under: filter.wrappedValue)) { machine in
            AidenMachineOfflineRow(
                label: machine.label,
                lastSeen: machine.lastSeen,
                isReconnecting: machine.isReconnecting,
                onReconnect: { onReconnect(machine.id) }
            )
            .listRowInsets(EdgeInsets(top: AidenSpacing.xs, leading: AidenSpacing.l, bottom: AidenSpacing.xs, trailing: AidenSpacing.l))
            .listRowSeparator(.hidden)
            .listRowBackground(palette.canvas)
        }
    }

    private var showMoreRow: some View {
        Button(action: onShowAllEarlier) {
            Text("Show \(inbox.earlierOverflow) more")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(palette.secondary)
                .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                .padding(.leading, AidenSpacing.xxl)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: AidenSpacing.l, bottom: 0, trailing: AidenSpacing.m))
        .listRowSeparator(.hidden)
        .listRowBackground(palette.canvas)
    }

    /// A read that failed over saved rows: say so above them, keep them.
    private var refreshErrorRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                .foregroundStyle(palette.warning)
                .accessibilityHidden(true)
            Text("Couldn’t refresh chats.")
                .foregroundStyle(palette.secondary)
            Spacer(minLength: 8)
            Button("Try again", action: onRetry)
                .font(.subheadline.weight(.semibold))
        }
        .font(.subheadline)
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
        .listRowSeparator(.hidden)
        .listRowBackground(palette.canvas)
    }

    @ViewBuilder
    private var moreChatsRow: some View {
        Group {
            switch moreChats {
            case .none:
                EmptyView()
            case .loading:
                AidenChatListSkeleton(rowCount: 2, accessibilityText: "Loading more chats")
            case .failed(let message):
                VStack(spacing: 8) {
                    Text("More chats couldn’t load")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(2)
                    Button("Try again", action: onLoadMore)
                        .font(.subheadline.weight(.semibold))
                }
                .frame(maxWidth: .infinity, minHeight: 44)
            case .available:
                Button("Load more chats", action: onLoadMore)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
        }
        .listRowInsets(EdgeInsets(top: 8, leading: 24, bottom: 8, trailing: 24))
        .listRowSeparator(.hidden)
        .listRowBackground(palette.canvas)
    }

    /// Over the list, not in it, so it centres and pull to refresh still works.
    @ViewBuilder
    private var emptyState: some View {
        switch state {
        case .rows, .loading:
            EmptyView()
        case .caughtUp:
            ContentUnavailableView(
                "All caught up",
                systemImage: "tray",
                description: Text("Chats that need you or have news show up here.")
            )
        case .noChats:
            ContentUnavailableView(
                "No chats yet",
                systemImage: "tray",
                description: Text("Start a new chat to begin.")
            )
        case .offline(let machines):
            unavailable(
                machines == 1 ? "Can’t reach your machine" : "Can’t reach your machines",
                systemImage: "wifi.slash",
                description: "Saved chats appear here after this phone has connected once."
            )
        case .failed(let message):
            unavailable("Chats unavailable", systemImage: "tray", description: message)
        case .allHidden:
            ContentUnavailableView(
                "Every machine is hidden",
                systemImage: "eye.slash",
                description: Text("Turn off Hide from Inbox on a machine to see its chats here.")
            )
        }
    }

    private func unavailable(_ title: String, systemImage: String, description: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(description)
        } actions: {
            Button("Try again", action: onRetry)
        }
    }
}

/// The Inbox tab's root: the list, fed by the store, and the banner over it.
struct AidenInboxTabRootView: View {
    private struct NoticeTiming: Hashable {
        let id: UUID
        let voiceOver: Bool
    }

    let store: AidenUnifiedInboxStore
    let onOpen: (AidenHostObjectID) -> Void
    var onOpenMachines: () -> Void = {}

    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    /// The banner VoiceOver last heard, so one shown again isn't announced twice.
    @State private var announcedNoticeID: UUID?

    var body: some View {
        AidenInboxTabView(
            inbox: store.inbox,
            state: store.listState,
            refreshFailed: store.refreshFailed,
            moreChats: store.moreChats,
            roster: store.roster,
            filter: Binding(get: { store.filter }, set: { store.filter = $0 }),
            onOpen: onOpen,
            onAction: { action, id in
                Task { await store.perform(action, on: id) }
            },
            onRefresh: { await store.refreshAll() },
            onRetry: { Task { await store.retry() } },
            onShowAllEarlier: { store.showsAllEarlier = true },
            onLoadMore: { Task { await store.loadMoreChats() } },
            onReconnect: { store.reconnect($0) }
        )
        .navigationTitle("Inbox")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                AidenHostStatusItem(online: store.roster.online, total: store.roster.total, onOpen: onOpenMachines)
            }
        }
        .overlay(alignment: .top) { noticeBanner }
        .animation(reduceMotion ? nil : .smooth(duration: 0.24, extraBounce: 0), value: store.notice)
        .task {
            // Snoozes wake and Earlier ages out on this phone's clock.
            while !Task.isCancelled {
                store.refreshClock()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    @ViewBuilder
    private var noticeBanner: some View {
        if let machineNotice = store.notice {
            let notice = machineNotice.notice
            AidenInboxNoticeBanner(
                notice: notice,
                palette: palette,
                onUndo: notice.undo == nil || notice.revision == nil ? nil : {
                    Task { await store.undo(machineNotice) }
                },
                onDismiss: { store.dismissNotice() }
            )
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            .task(id: NoticeTiming(id: notice.id, voiceOver: voiceOverEnabled)) {
                // The banner can't take focus, so VoiceOver hears it here, once.
                // Marked only while VoiceOver is on, so turning it on mid-banner
                // still reads the banner out.
                if voiceOverEnabled, announcedNoticeID != notice.id {
                    announcedNoticeID = notice.id
                    AccessibilityNotification.Announcement(notice.message).post()
                }
                // Only what is left of the window since it was posted.
                guard let delay = notice.remainingDelay(voiceOverRunning: voiceOverEnabled) else { return }
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled else { return }
                if store.notice?.notice.id == notice.id { store.dismissNotice() }
            }
        }
    }
}
