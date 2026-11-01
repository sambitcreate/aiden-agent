import SwiftUI

/// The desktop's Working indicator: an open ring at 60% opacity that turns
/// once every 1.5 seconds. Reduce Motion leaves it still; the row's text
/// still says Working.
struct AidenWorkingIndicator: View {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenPalette) private var palette
    var size: CGFloat = 12
    var tint: Color?

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            Circle()
                .trim(from: 0, to: 0.75)
                .stroke(tint ?? palette.accent, style: StrokeStyle(lineWidth: max(1.5, size / 7), lineCap: .round))
                .rotationEffect(.degrees(reduceMotion ? 0 : Self.angle(at: context.date)))
        }
        .frame(width: size, height: size)
        .opacity(0.6)
        .accessibilityHidden(true)
    }

    static func angle(at date: Date) -> Double {
        date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.5) / 1.5 * 360
    }
}

/// The small Beta tag beside the Inbox choice and heading.
struct AidenBetaBadge: View {
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        Text("Beta")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(palette.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(palette.secondary.opacity(0.12), in: Capsule())
            .accessibilityLabel("Beta")
    }
}

/// What a compact Inbox row says on its trailing edge, as the desktop does.
struct AidenInboxRowStatus: Equatable {
    enum Tone: Equatable { case warning, danger, working, plain }

    var label: String?
    var spokenLabel: String?
    var tone: Tone
    var wait: String?

    static func make(_ row: AidenInboxProjection.Row, section: AidenInboxSection, now: Date) -> Self {
        let chat = row.summary
        switch section {
        case .needsYou:
            let since = chat.inbox.attentionSince ?? chat.inbox.lastAssistantAt ?? chat.updatedAt
            let wait = AidenInboxDuration.text(since: since, now: now)
            switch row.placement.tier {
            case AidenInbox.Tier.approval: return Self(label: "Approval", tone: .warning, wait: wait)
            case AidenInbox.Tier.input: return Self(label: "Question", tone: .warning, wait: wait)
            default: return Self(label: "Failed", tone: .danger, wait: wait)
            }
        case .working:
            if let started = chat.inbox.runStartedAt {
                return Self(label: "Working \(AidenInboxDuration.text(since: started, now: now))", tone: .working)
            }
            return Self(label: "Working", tone: .working)
        case .pinned, .updates, .earlier:
            if chat.inbox.doneAt != nil, chat.inbox.snoozedUntil.map({ $0 > now }) != true {
                return Self(label: "Done", tone: .plain)
            }
            if let until = chat.inbox.snoozedUntil, until > now {
                let text = until.formatted(.dateTime.weekday(.abbreviated).hour().minute())
                return Self(label: "Until \(text)", spokenLabel: "Snoozed until \(text)", tone: .plain)
            }
            return Self(tone: .plain, wait: AidenInboxDuration.text(since: row.placement.sortAt, now: now))
        }
    }
}

/// One compact Inbox row: title, workspace, status and wait.
struct AidenInboxRowView: View {
    let row: AidenInboxProjection.Row
    let section: AidenInboxSection
    let workspaceName: String?
    let palette: AidenPalette

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            content(status: AidenInboxRowStatus.make(row, section: section, now: context.date))
        }
    }

    private var unread: Bool { row.summary.unread }

    private func content(status: AidenInboxRowStatus) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Circle()
                .fill(unread ? palette.accent : Color.clear)
                .frame(width: 7, height: 7)

            VStack(alignment: .leading, spacing: 1) {
                Text(row.summary.title)
                    .font(.subheadline.weight(unread ? .semibold : .medium))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                if let workspaceName {
                    Text(workspaceName)
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            if status.tone == .working {
                AidenWorkingIndicator(size: 12)
            }
            if let label = status.label {
                statusLabel(label, tone: status.tone)
            }
            if let wait = status.wait {
                Text(wait)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityName(status))
    }

    @ViewBuilder
    private func statusLabel(_ label: String, tone: AidenInboxRowStatus.Tone) -> some View {
        switch tone {
        case .warning, .danger:
            let tint = tone == .danger ? palette.danger : palette.warning
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tint)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(tint.opacity(0.12), in: Capsule())
        case .working, .plain:
            Text(label)
                .font(.caption)
                .foregroundStyle(palette.secondary)
                .lineLimit(1)
                .fixedSize()
        }
    }

    /// "Title, workspace, status, wait, Unread", as the desktop names it.
    func accessibilityName(_ status: AidenInboxRowStatus) -> String {
        [row.summary.title, workspaceName, status.spokenLabel ?? status.label, status.wait, unread ? "Unread" : nil]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }
}

/// The Inbox banner after a swipe: what happened, and Undo when it can be
/// put back. It sits above the list and leaves on its own.
struct AidenInboxNoticeBanner: View {
    let notice: AidenInboxNotice
    let palette: AidenPalette
    let onUndo: (() -> Void)?
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(notice.message)
                .font(.subheadline)
                .foregroundStyle(palette.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let onUndo {
                Button("Undo", action: onUndo)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.accent)
            }
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        .accessibilityElement(children: .contain)
    }
}

/// An Inbox section heading: Working shows its indicator; the count follows
/// the title, and VoiceOver reads both as one heading.
struct AidenInboxSectionHeader: View {
    let section: AidenInboxSection
    let count: Int
    let palette: AidenPalette

    var body: some View {
        HStack(spacing: 6) {
            if section == .working {
                AidenWorkingIndicator(size: 10)
            }
            Text(section.title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(palette.secondary)
            Text("\(count)")
                .font(.footnote.monospacedDigit())
                .foregroundStyle(palette.secondary.opacity(0.8))
        }
        .padding(.horizontal, 24)
        .padding(.top, 14)
        .padding(.bottom, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(section.title), \(count)")
        .accessibilityAddTraits(.isHeader)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(palette.canvas)
    }
}

/// The swipe actions a row offers. A nil action is not shown, as a swipe
/// or as a VoiceOver action.
struct AidenInboxRowActions {
    var markRead: (() -> Void)?
    var done: (() -> Void)?
    var snooze: (() -> Void)?
}

/// One Inbox list row: tap opens the chat, a leading swipe marks it read,
/// and a trailing swipe offers Done and Snooze. The same actions are
/// VoiceOver actions.
struct AidenInboxListRow: View {
    let row: AidenInboxProjection.Row
    let section: AidenInboxSection
    let workspaceName: String?
    let palette: AidenPalette
    let actions: AidenInboxRowActions
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            AidenInboxRowView(row: row, section: section, workspaceName: workspaceName, palette: palette)
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if let markRead = actions.markRead {
                Button(action: markRead) {
                    Label("Mark read", systemImage: "envelope.open")
                }
                .tint(palette.accent)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if let done = actions.done {
                Button(action: done) {
                    Label("Done", systemImage: "checkmark.circle")
                }
                .tint(palette.success)
            }
            if let snooze = actions.snooze {
                Button(action: snooze) {
                    Label("Snooze", systemImage: "clock")
                }
                .tint(palette.warning)
            }
        }
        .accessibilityActions {
            if let markRead = actions.markRead { Button("Mark read", action: markRead) }
            if let done = actions.done { Button("Done", action: done) }
            if let snooze = actions.snooze { Button("Snooze", action: snooze) }
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
        .listRowSeparator(.hidden)
        .listRowBackground(palette.canvas)
    }
}

#if DEBUG
/// A paired-host-free Inbox for simulator screenshots, built from the same
/// rows, headings and swipe actions as the sidebar. Launch the Debug build
/// with `-AidenInboxFixture`.
struct AidenInboxFixtureView: View {
    @Environment(\.aidenPalette) private var palette
    @State private var chats: [AidenChatSummary]
    @State private var notice: AidenInboxNotice?
    private let now = Date()

    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains("-AidenInboxFixture")
    }

    init() {
        let now = Date()
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        func chat(
            _ id: String, _ title: String, workspace: String, minutesAgo: Double,
            activity: AidenChatSummaryActivity = .idle, rowState: AidenChatRowState? = nil,
            unread: Bool = false, failed: Bool = false, inbox: AidenChatInboxSignals = AidenChatInboxSignals()
        ) -> AidenChatSummary {
            AidenChatSummary(
                id: id, workspaceId: workspace, title: title, titlePending: false,
                createdAt: ago(minutesAgo + 30), updatedAt: ago(minutesAgo), revision: "r-\(id)",
                activity: activity, rowState: rowState, unread: unread, lastRunFailed: failed, inbox: inbox
            )
        }
        _chats = State(initialValue: [
            chat("a", "Deploy the pricing page", workspace: "web", minutesAgo: 4, activity: .active,
                 rowState: .needsApproval, inbox: AidenChatInboxSignals(attentionSince: ago(4))),
            chat("b", "Which region for the bucket?", workspace: "infra", minutesAgo: 12, activity: .active,
                 rowState: .needsInput, unread: true, inbox: AidenChatInboxSignals(attentionSince: ago(12))),
            chat("c", "Nightly import", workspace: "data", minutesAgo: 40, unread: true, failed: true,
                 inbox: AidenChatInboxSignals(lastAssistantAt: ago(40))),
            chat("d", "Refactor the settings store", workspace: "web", minutesAgo: 1, activity: .active,
                 inbox: AidenChatInboxSignals(runStartedAt: ago(6))),
            chat("e", "Release checklist", workspace: "web", minutesAgo: 300,
                 inbox: AidenChatInboxSignals(pinnedAt: ago(2000))),
            chat("f", "Summarize the support queue", workspace: "data", minutesAgo: 22, unread: true,
                 inbox: AidenChatInboxSignals(lastAssistantAt: ago(22))),
            chat("g", "Draft the launch email", workspace: "web", minutesAgo: 95, unread: true,
                 inbox: AidenChatInboxSignals(lastAssistantAt: ago(95))),
            chat("h", "Rotate staging keys", workspace: "infra", minutesAgo: 1500,
                 inbox: AidenChatInboxSignals(doneAt: ago(1400))),
            chat("i", "Benchmark the parser", workspace: "data", minutesAgo: 2900),
        ])
    }

    private let workspaces = ["web": "Website", "infra": "Infrastructure", "data": "Data"]

    var body: some View {
        let projection = AidenInboxProjection.make(chats: chats, workspaceNames: workspaces, openChatID: nil, now: now)
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("Inbox")
                    .font(.title3.bold())
                    .foregroundStyle(palette.foreground)
                AidenBetaBadge()
                Spacer()
            }
            .padding(.horizontal, 24)
            .padding(.top, 26)
            .padding(.bottom, 4)

            List {
                ForEach(AidenInboxSection.allCases, id: \.self) { section in
                    let rows = projection.rows(in: section)
                    if !rows.isEmpty {
                        AidenInboxSectionHeader(section: section, count: rows.count, palette: palette)
                        ForEach(rows) { row in
                            AidenInboxListRow(
                                row: row,
                                section: section,
                                workspaceName: workspaces[row.summary.workspaceId],
                                palette: palette,
                                actions: actions(for: row.summary),
                                open: {}
                            )
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
        .background(palette.canvas)
        .overlay(alignment: .top) {
            if let notice {
                AidenInboxNoticeBanner(notice: notice, palette: palette, onUndo: {}, onDismiss: { self.notice = nil })
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
            }
        }
    }

    private func actions(for chat: AidenChatSummary) -> AidenInboxRowActions {
        let triage = AidenInbox.offersDoneAndSnooze(chat)
        return AidenInboxRowActions(
            markRead: chat.unread ? { update(chat.id) { $0.unread = false } } : nil,
            done: triage && chat.inbox.doneAt == nil ? { apply(.done(true), to: chat.id) } : nil,
            snooze: triage ? { apply(.snooze(until: now.addingTimeInterval(3600)), to: chat.id) } : nil
        )
    }

    private func apply(_ change: AidenChatTriageChange, to id: String) {
        update(id) { $0 = AidenInbox.applyingOptimisticTriage(change, to: $0, now: now) }
        notice = AidenInboxNotice(message: change.confirmation, undo: change.undo, chatID: id)
    }

    private func update(_ id: String, _ body: (inout AidenChatSummary) -> Void) {
        guard let index = chats.firstIndex(where: { $0.id == id }) else { return }
        body(&chats[index])
    }
}
#endif
