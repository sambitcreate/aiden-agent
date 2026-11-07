import SwiftUI

/// Where running chats show. An accessory on iOS 26.0 can't be turned off, and a
/// sidebar has no bottom accessory, so both of those list them in the Inbox.
enum AidenRunningHome: Equatable {
    case accessory, inboxRow

    static func resolve(accessoryCanTurnOff: Bool, horizontalSizeClass: UserInterfaceSizeClass?) -> Self {
        accessoryCanTurnOff && horizontalSizeClass != .regular ? .accessory : .inboxRow
    }

    static var accessoryCanTurnOff: Bool {
        if #available(iOS 26.1, *) { true } else { false }
    }
}

/// What the running chats add up to. An offline machine's chat may have stopped
/// long ago, so only rows on machines that are online count.
struct AidenRunningSummary: Equatable {
    enum Tap: Equatable {
        case open(AidenHostObjectID)
        case showAll
    }

    /// Oldest run first.
    let rows: [AidenUnifiedInboxRow]

    init(rows: [AidenUnifiedInboxRow]) {
        self.rows = rows.filter(\.isOnline)
    }

    var isEmpty: Bool { rows.isEmpty }

    var title: String? {
        switch rows.first?.content {
        case .chat(let summary, _): summary.title
        case nil: nil
        }
    }

    var othersCount: Int { max(rows.count - 1, 0) }

    /// One chat opens, and more than one is a list to choose from.
    var tap: Tap? {
        rows.count > 1 ? .showAll : rows.first.map { .open($0.id) }
    }
}

/// The oldest running chat, plus `+N` for the others. Above the tab bar it follows
/// `tabViewBottomAccessoryPlacement`, and goes compact beside a minimized bar.
struct AidenRunningAccessory: View {
    private let summary: AidenRunningSummary
    private let onOpen: (AidenHostObjectID) -> Void
    private let onShowAll: () -> Void

    @Environment(\.aidenPalette) private var palette
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    init(
        rows: [AidenUnifiedInboxRow],
        onOpen: @escaping (AidenHostObjectID) -> Void,
        onShowAll: @escaping () -> Void
    ) {
        summary = AidenRunningSummary(rows: rows)
        self.onOpen = onOpen
        self.onShowAll = onShowAll
    }

    private var isCompact: Bool { placement == .inline }

    var body: some View {
        if let title = summary.title {
            Button(action: tap) {
                HStack(spacing: AidenSpacing.s) {
                    AidenWorkingIndicator(size: isCompact ? 12 : 16)
                    Text(title)
                        .font(isCompact ? .footnote.weight(.medium) : .subheadline.weight(.medium))
                        .foregroundStyle(palette.foreground)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if summary.othersCount > 0 {
                        Text("+\(summary.othersCount)")
                            .font(.footnote.weight(.semibold).monospacedDigit())
                            .foregroundStyle(palette.secondary)
                    }
                }
                .padding(.horizontal, isCompact ? AidenSpacing.m : AidenSpacing.l)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
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
        case .open(let id): onOpen(id)
        case .showAll: onShowAll()
        case nil: break
        }
    }
}

/// The accessory on the store's rows. Reading them here keeps a new row from
/// redrawing the whole shell.
struct AidenRunningAccessoryHost: View {
    let store: AidenUnifiedInboxStore
    let onOpen: (AidenHostObjectID) -> Void
    let onShowAll: () -> Void

    var body: some View {
        AidenRunningAccessory(rows: store.inbox.running, onOpen: onOpen, onShowAll: onShowAll)
    }
}

/// Every running chat, for when the accessory has more than one. It keeps up with
/// the store, because a run can end while the sheet is open.
struct AidenRunningChatsSheet: View {
    let store: AidenUnifiedInboxStore
    let onOpen: (AidenHostObjectID) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette

    private var rows: [AidenUnifiedInboxRow] {
        AidenRunningSummary(rows: store.inbox.running).rows
    }

    var body: some View {
        NavigationStack {
            List(rows) { row in
                listRow(row)
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

    @ViewBuilder
    private func listRow(_ row: AidenUnifiedInboxRow) -> some View {
        switch row.content {
        case .chat(let summary, let placement):
            Button {
                onOpen(row.id)
            } label: {
                AidenInboxRowView(
                    row: AidenInboxProjection.Row(summary: summary, placement: placement),
                    section: .working,
                    workspaceName: row.workspaceName,
                    palette: palette
                )
            }
            .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(top: 0, leading: AidenSpacing.m, bottom: 0, trailing: AidenSpacing.m))
            .listRowSeparator(.hidden)
            .listRowBackground(palette.canvas)
        }
    }
}

extension View {
    /// The accessory, where the OS can turn it off. The branch is fixed for a run
    /// of the app, and `isEnabled` does the changing, so the modifier is never
    /// added or removed under a live `TabView`.
    @ViewBuilder
    func aidenRunningAccessory<Content: View>(
        isEnabled: Bool,
        @ViewBuilder content: () -> Content
    ) -> some View {
        if #available(iOS 26.1, *) {
            tabViewBottomAccessory(isEnabled: isEnabled) { content() }
        } else {
            self
        }
    }
}
