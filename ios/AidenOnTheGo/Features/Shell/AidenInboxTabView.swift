import SwiftUI

/// What a row can be asked to do. Mirrors `AidenInboxRowOffer`, plus Delete,
/// which every row offers.
enum AidenInboxRowAction: Equatable {
    case markRead, done, snooze(AidenSnoozeOption), wake, undone, delete
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
/// aren't listed here, because the accessory owns them, unless they have to make
/// their home here (`AidenRunningHome`). Then they're the first row.
struct AidenInboxTabView: View {
    let inbox: AidenUnifiedInbox
    var state = AidenInboxListState.rows
    var runningHome = AidenRunningHome.accessory
    var refreshFailed = false
    var moreChats = AidenInboxMoreChats.none
    var roster = AidenMachineRoster()
    var filter = Binding.constant(AidenMachineFilter.all)
    /// A chat row opens its chat, a Bot row its Bot.
    let onOpen: (AidenAppRoute) -> Void
    let onAction: (AidenInboxRowAction, AidenHostObjectID) -> Void
    var onRefresh: () async -> Void = {}
    var onRetry: () -> Void = {}
    var onShowAllEarlier: () -> Void = {}
    var onLoadMore: () -> Void = {}
    /// The shell's, so a deleted chat's screen closes. Without one, Delete is a row action.
    var onDelete: ((AidenHostObjectID) -> Void)? = nil
    var onReconnect: (String) -> Void = { _ in }
    var onCatchUp: () -> Void = {}
    var onShowRunning: () -> Void = {}

    @Environment(\.aidenPalette) private var palette
    @State private var snoozeCandidate: AidenHostObjectID?
    @State private var deleteCandidate: AidenHostObjectID?

    private var catchUpCount: Int { AidenCatchUpQueue(rows: inbox.needsYou).count }

    var body: some View {
        List {
            machineRows
            if refreshFailed { refreshErrorRow }
            if runningHome == .inboxRow, !inbox.running.isEmpty { runningRow }
            if catchUpCount > 0 { catchUpRow }
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
        .confirmationDialog(
            "Delete this chat?",
            isPresented: Binding(
                get: { deleteCandidate != nil },
                set: { if !$0 { deleteCandidate = nil } }
            ),
            titleVisibility: .visible,
            presenting: deleteCandidate
        ) { id in
            Button("Delete chat", role: .destructive) {
                if let onDelete { onDelete(id) } else { onAction(.delete, id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("This permanently removes the chat from its machine.")
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
                open: { onOpen(row.route) }
            )
            .contextMenu { contextMenu(for: row, actions: actions) }
            .accessibilityActions {
                if row.isOnline {
                    Button("Delete chat") { deleteCandidate = row.id }
                }
            }
        case .bot(let bot):
            // No Bot triage exists, so a Bot row has no swipes and no menu.
            Button { onOpen(row.route) } label: {
                AidenInboxBotRowView(
                    bot: bot,
                    palette: palette,
                    machine: roster.rowChip(for: row.id.instanceId, filter: filter.wrappedValue),
                    isDimmed: roster.isOffline(row.id.instanceId)
                )
            }
            .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
            .listRowSeparator(.hidden)
            .listRowBackground(palette.canvas)
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
        Button("Delete", systemImage: "trash", role: .destructive) { deleteCandidate = row.id }
            .disabled(!row.isOnline)
    }

    private var runningRow: some View {
        AidenRunningAccessory(rows: inbox.running, onOpen: onOpen, onShowAll: onShowRunning)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: AidenRadius.control))
            .listRowInsets(EdgeInsets(top: AidenSpacing.s, leading: AidenSpacing.m, bottom: AidenSpacing.xs, trailing: AidenSpacing.m))
            .listRowSeparator(.hidden)
            .listRowBackground(palette.canvas)
    }

    private var catchUpRow: some View {
        let count = catchUpCount
        return Button(action: onCatchUp) {
            HStack(spacing: AidenSpacing.m) {
                Image(systemName: "rectangle.stack")
                    .foregroundStyle(palette.accent)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text("Catch Up")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                    Text(count == 1 ? "1 chat needs you" : "\(count) chats need you")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, AidenSpacing.l)
            .padding(.vertical, AidenSpacing.m)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: AidenRadius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("aiden.catch-up")
        .listRowInsets(EdgeInsets(top: AidenSpacing.s, leading: AidenSpacing.m, bottom: AidenSpacing.xs, trailing: AidenSpacing.m))
        .listRowSeparator(.hidden)
        .listRowBackground(palette.canvas)
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
        case .rows where runningHome.leavesListEmpty(inbox):
            ContentUnavailableView(
                "Nothing needs you yet",
                systemImage: "tray",
                description: Text("Running chats are above the tab bar until they finish or need you.")
            )
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
    var runningHome = AidenRunningHome.accessory
    let onOpen: (AidenAppRoute) -> Void
    var onDelete: ((AidenHostObjectID) -> Void)? = nil
    var onOpenMachines: () -> Void = {}
    var onCatchUp: () -> Void = {}
    var onShowRunning: () -> Void = {}

    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    /// The banner VoiceOver last heard, so one shown again isn't announced twice.
    @State private var announcedNoticeID: UUID?

    var body: some View {
        AidenInboxTabView(
            inbox: store.inbox,
            state: store.listState,
            runningHome: runningHome,
            refreshFailed: store.refreshFailed,
            moreChats: store.moreChats,
            roster: store.roster,
            filter: Binding(get: { store.inboxFilter }, set: { store.filter = $0 }),
            onOpen: onOpen,
            onAction: { action, id in
                Task { await store.perform(action, on: id) }
            },
            onRefresh: { await store.refreshAll() },
            onRetry: { Task { await store.retry() } },
            onShowAllEarlier: { store.showsAllEarlier = true },
            onLoadMore: { Task { await store.loadMoreChats() } },
            onDelete: onDelete,
            onReconnect: { store.reconnect($0) },
            onCatchUp: onCatchUp,
            onShowRunning: onShowRunning
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

/// Where a Catch Up run ends, so the last Next lands on an answer and not on a
/// chat or an empty screen.
struct AidenCatchUpFinishedView: View {
    let ending: AidenCatchUpEnding
    let onDone: () -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        ContentUnavailableView {
            Label(ending.title, systemImage: ending.walked ? "checkmark.circle" : "tray")
        } description: {
            Text(ending.message)
        } actions: {
            Button("Back to Inbox", action: onDone)
                .buttonStyle(.borderedProminent)
        }
        .background(palette.canvas.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A Bot that needs the person, or is running: its name and why. Tapping opens
/// the Bot, the one thing a Bot row offers.
struct AidenInboxBotRowView: View {
    let bot: AidenBotSummary
    let palette: AidenPalette
    /// Says which machine the Bot is on. Nil when only one is listed.
    var machine: AidenMachineLabel? = nil
    /// The Bot's machine is offline: the row stays, in secondary colours.
    var isDimmed = false

    private var reason: String? { AidenBotAttention.reason(bot) }

    /// "Bot Scout, On Laptop, Offline, 1 thing needs you", like a chat row.
    var accessibilityName: String {
        [
            String(localized: "Bot \(bot.name)"),
            machine?.accessibilityLabel,
            isDimmed ? String(localized: "Offline") : nil,
            reason,
        ]
            .compactMap { $0 }
            .joined(separator: ", ")
    }

    var body: some View {
        let needsYou = AidenBotAttention.needsYou(bot)
        let tint = isDimmed ? palette.secondary : needsYou ? palette.warning : palette.secondary
        HStack(alignment: .center, spacing: 10) {
            AidenBotAvatarSymbol(name: bot.name, palette: palette)
                .opacity(isDimmed ? 0.6 : 1)
            VStack(alignment: .leading, spacing: 1) {
                Text(bot.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(isDimmed ? palette.secondary : palette.foreground)
                    .lineLimit(1)
                if let machine { AidenMachineChip(label: machine, namesItselfWithoutColor: true) }
            }
            Spacer(minLength: 8)
            if AidenBotAttention.isRunning(bot), !needsYou, !isDimmed {
                AidenWorkingIndicator(size: 12)
            }
            if let reason {
                if needsYou {
                    AidenStatusChip(reason, kind: .warning, isDimmed: isDimmed)
                        .fixedSize()
                } else {
                    // Running: no tint to tell apart, so no symbol either.
                    Text(reason)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(tint)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(tint.opacity(0.12), in: Capsule())
                        .lineLimit(1)
                        .fixedSize()
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityName)
        .accessibilityHint("Opens the Bot")
    }
}

/// The Bot's initial on a tinted circle, so a Bot row reads as a Bot beside chats.
private struct AidenBotAvatarSymbol: View {
    let name: String
    let palette: AidenPalette

    var body: some View {
        Text(name.prefix(1).uppercased())
            .font(.caption.weight(.bold))
            .foregroundStyle(palette.accent)
            .frame(width: 24, height: 24)
            .background(palette.accent.opacity(0.14), in: Circle())
            .accessibilityHidden(true)
    }
}

/// Shaped placeholder rows for a first read of a chat list.
struct AidenChatListSkeleton: View {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let rowCount: Int
    var accessibilityText: LocalizedStringKey = "Loading chats"

    private static let titleWidths: [CGFloat] = [212, 168, 236, 148, 196, 180]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<rowCount, id: \.self) { index in
                HStack(spacing: 12) {
                    AidenBotSkeletonBlock(
                        width: Self.titleWidths[index % Self.titleWidths.count],
                        height: 14,
                        radius: 7,
                        reduceMotion: reduceMotion
                    )
                    Spacer(minLength: 16)
                    AidenBotSkeletonBlock(width: 44, height: 10, radius: 5, reduceMotion: reduceMotion)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 52)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(accessibilityText))
    }
}
