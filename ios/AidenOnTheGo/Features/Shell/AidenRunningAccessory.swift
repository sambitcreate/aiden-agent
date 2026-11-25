import SwiftUI

/// Where running chats show: above the compact dock, or, beside a sidebar,
/// which has no dock, as the Inbox's first row. iOS 26.0 lists them in the
/// Inbox too, as it did when the system tab bar carried the accessory.
enum AidenRunningHome: Equatable {
    case accessory, inboxRow

    static func resolve(accessoryCanTurnOff: Bool, horizontalSizeClass: UserInterfaceSizeClass?) -> Self {
        accessoryCanTurnOff && horizontalSizeClass != .regular ? .accessory : .inboxRow
    }

    static var accessoryCanTurnOff: Bool {
        if #available(iOS 26.1, *) { true } else { false }
    }

    /// True when running chats are all the Inbox has and they sit above the
    /// dock, so the list is empty without being caught up.
    func leavesListEmpty(_ inbox: AidenUnifiedInbox) -> Bool {
        self == .accessory && !inbox.running.isEmpty
            && inbox.needsYou.isEmpty && inbox.updates.isEmpty && inbox.earlier.isEmpty
    }
}

/// What the running chats add up to.
struct AidenRunningSummary: Equatable {
    enum Tap: Equatable {
        case open(AidenHostObjectID)
        /// A running Bot opens as the Bot.
        case openBot(AidenHostObjectID)
        case showAll
    }

    /// Oldest run first.
    let rows: [AidenUnifiedInboxRow]

    var title: String? {
        switch rows.first?.content {
        case .chat(let summary, _): summary.title
        case .bot(let bot): bot.name
        case nil: nil
        }
    }

    var othersCount: Int { max(rows.count - 1, 0) }

    /// One chat opens, and more than one is a list to choose from.
    var tap: Tap? {
        rows.count > 1 ? .showAll : rows.first.map { $0.isBot ? .openBot($0.id) : .open($0.id) }
    }
}

/// The oldest running chat, plus `+N` for the others: above the compact dock,
/// or as the Inbox's first row where there is no dock. It still follows
/// `tabViewBottomAccessoryPlacement` should a system tab bar ever carry it.
struct AidenRunningAccessory: View {
    private let summary: AidenRunningSummary
    private let onOpen: (AidenAppRoute) -> Void
    private let onShowAll: () -> Void
    /// Above Aiden's own dock, which keeps its height as a system bar does.
    private let isInBar: Bool

    @Environment(\.aidenPalette) private var palette
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        rows: [AidenUnifiedInboxRow],
        isInBar: Bool = false,
        onOpen: @escaping (AidenAppRoute) -> Void,
        onShowAll: @escaping () -> Void
    ) {
        summary = AidenRunningSummary(rows: rows)
        self.isInBar = isInBar
        self.onOpen = onOpen
        self.onShowAll = onShowAll
    }

    private var isCompact: Bool { placement == .inline }

    /// A bar keeps its height, so there the title stays on one line and a held
    /// press shows it large. As the Inbox's first row (a sidebar, or iOS 26.0)
    /// it grows with the text as the rows below it do.
    private var titleLineLimit: Int {
        placement == nil && !isInBar && dynamicTypeSize.isAccessibilitySize ? 3 : 1
    }

    var body: some View {
        if let title = summary.title {
            Button(action: tap) {
                HStack(spacing: AidenSpacing.s) {
                    // A ring per placement: the bar swaps the accessory between
                    // its inline and expanded places in an animation, and one
                    // ring carried across slid from the old place to the new
                    // while it turned, so it wandered. A new ring fades in
                    // where it belongs, as the title does.
                    AidenWorkingIndicator(size: isCompact ? 12 : 16)
                        .id(isCompact)
                    Text(title)
                        .font(isCompact ? .footnote.weight(.medium) : .subheadline.weight(.medium))
                        .foregroundStyle(palette.foreground)
                        .lineLimit(titleLineLimit)
                    Spacer(minLength: 0)
                    if summary.othersCount > 0 {
                        // On glass the quieter colour falls under 4.5:1 over light content.
                        Text("+\(summary.othersCount)")
                            .font(.footnote.weight(.semibold).monospacedDigit())
                            .foregroundStyle(palette.foreground)
                    }
                }
                .padding(.horizontal, isCompact ? AidenSpacing.m : AidenSpacing.l)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // A bar's height doesn't grow with the text, so a held press shows it large.
            .accessibilityShowsLargeContentViewer()
            .accessibilityLabel(accessibilityLabel(title: title))
            .accessibilityHint(summary.tap == .showAll ? "Shows all running chats" : "Opens the chat")
            .accessibilityIdentifier("aiden.running-accessory")
        }
    }

    private func accessibilityLabel(title: String) -> String {
        summary.othersCount > 0
            ? String(localized: "Running: \(title), and \(summary.othersCount) more")
            : String(localized: "Running: \(title)")
    }

    private func tap() {
        switch summary.tap {
        case .open(let id): onOpen(.chat(id))
        case .openBot(let id): onOpen(.bot(id))
        case .showAll: onShowAll()
        case nil: break
        }
    }
}

/// The accessory above the compact dock, on the store's rows and on the same
/// glass as the rest of the chrome. Reading the rows here keeps a new row
/// from redrawing the whole shell.
struct AidenRunningAccessoryHost: View {
    let store: AidenUnifiedInboxStore
    let onOpen: (AidenAppRoute) -> Void
    let onShowAll: () -> Void

    var body: some View {
        if store.hasRunningChats {
            AidenRunningAccessory(rows: store.inbox.running, isInBar: true, onOpen: onOpen, onShowAll: onShowAll)
                .aidenChromeGlass(isInteractive: true, in: Capsule())
                .padding(.horizontal, AidenSpacing.m)
        }
    }
}

/// Every running chat, for when the accessory has more than one. It keeps up with
/// the store, because a run can end while the sheet is open.
struct AidenRunningChatsSheet: View {
    let store: AidenUnifiedInboxStore
    let onOpen: (AidenAppRoute) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette

    private var rows: [AidenUnifiedInboxRow] {
        store.inbox.running
    }

    var body: some View {
        NavigationStack {
            let positions = AidenListCardPosition.positions(rows.map(\.id))
            List(rows) { row in
                listRow(row, card: positions[row.id] ?? .middle)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(palette.canvas.ignoresSafeArea())
            .overlay {
                if rows.isEmpty {
                    ContentUnavailableView("Nothing’s running", systemImage: "checkmark.circle")
                }
            }
            .navigationTitle("Running chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func listRow(_ row: AidenUnifiedInboxRow, card: AidenListCardPosition) -> some View {
        Button {
            onOpen(row.route)
        } label: {
            switch row.content {
            case .chat(let summary, let placement):
                AidenInboxRowView(
                    row: AidenInboxProjection.Row(summary: summary, placement: placement),
                    section: .working,
                    workspaceName: row.workspaceName,
                    palette: palette,
                    machine: store.roster.rowChip(for: row.id.instanceId, filter: .all),
                    isDimmed: store.roster.isOffline(row.id.instanceId)
                )
            case .bot(let bot):
                AidenInboxBotRowView(
                    bot: bot,
                    palette: palette,
                    machine: store.roster.rowChip(for: row.id.instanceId, filter: .all),
                    isDimmed: store.roster.isOffline(row.id.instanceId)
                )
            }
        }
        .buttonStyle(.plain)
        .aidenListCardRow(card)
    }
}
