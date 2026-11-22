import SwiftUI

/// The desktop's Working indicator: an open ring at 60% opacity that turns
/// once every 1.5 seconds. Reduce Motion leaves it still; the row's text
/// still says Working. VoiceOver skips it unless it is given
/// `accessibilityLabel`, for a ring that stands alone.
struct AidenWorkingIndicator: View {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenPalette) private var palette
    var size: CGFloat = 12
    var tint: Color?
    var accessibilityLabel: String?

    var body: some View {
        ring
            .accessibilityElement()
            .accessibilityLabel(accessibilityLabel ?? "")
            .accessibilityHidden(accessibilityLabel == nil)
    }

    static func lineWidth(for size: CGFloat) -> CGFloat { max(1.5, size / 7) }

    /// The ring is pinned square inside the timeline, inset by half its line so
    /// the round caps stay in the frame, and turns about its own centre. The
    /// geometry group resolves its frame with its parent's: in a moving
    /// container, such as the tab bar's accessory as the bar minimizes, the
    /// ring used to animate its position on its own and drift out of its
    /// place while it turned.
    private var ring: some View {
        let lineWidth = Self.lineWidth(for: size)
        return TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            Circle()
                .inset(by: lineWidth / 2)
                .trim(from: 0, to: 0.75)
                .stroke(tint ?? palette.accent, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .frame(width: size, height: size)
                .rotationEffect(.degrees(reduceMotion ? 0 : Self.angle(at: context.date)))
        }
        .frame(width: size, height: size)
        .geometryGroup()
        .opacity(0.6)
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
            // Listed here, not as running, because its machine is offline.
            if row.placement.section == .working {
                return Self(label: "Last seen running", tone: .plain)
            }
            // As the desktop: a Done hold first, then a snooze, else the wait.
            let hold = AidenInbox.triageHold(AidenInbox.Signals(summary: chat, isOpen: false), now: now)
            if hold.done {
                return Self(label: "Done", tone: .plain)
            }
            if hold.snoozed, let until = chat.inbox.snoozedUntil {
                let text = until.formatted(.dateTime.weekday(.abbreviated).hour().minute())
                return Self(label: "Until \(text)", spokenLabel: "Snoozed until \(text)", tone: .plain)
            }
            let since = section == .updates ? chat.inbox.lastAssistantAt ?? chat.updatedAt : chat.updatedAt
            return Self(tone: .plain, wait: AidenInboxDuration.text(since: since, now: now))
        }
    }
}

/// The chip and the workspace under a row's title. Without colour the chip shows
/// the machine's name, so a "·" keeps it from running into the workspace's.
struct AidenInboxRowMachineLine: View {
    let machine: AidenMachineLabel?
    let detail: String?
    var isStacked = false

    @Environment(\.aidenPalette) private var palette
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    var body: some View {
        HStack(spacing: AidenSpacing.xs) {
            if let machine {
                AidenMachineChip(label: machine, namesItselfWithoutColor: true)
                if differentiateWithoutColor, detail != nil {
                    Text(verbatim: "·")
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                        .accessibilityHidden(true)
                }
            }
            if let detail {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(isStacked ? 2 : 1)
            }
        }
    }
}

/// A list row's anatomy, shared by every list in the app: a fixed mark column
/// centred on the title's line, so every title starts on one edge; the title;
/// one quieter summary line; and the trailing marks on the summary's baseline.
/// Whitespace, not hairlines, separates rows. Every measure scales with the text.
/// An avatar takes a wider column and centres on the whole row.
struct AidenListRowLayout<Mark: View, Title: View, Summary: View, Trailing: View>: View {
    enum MarkStyle: Equatable {
        /// A small status mark or symbol, centred on the title's line.
        case glyph
        /// An avatar this wide, centred on the row.
        case avatar(CGFloat)
    }

    let isStacked: Bool
    let hasSummary: Bool
    var markStyle: MarkStyle = .glyph
    @ViewBuilder let mark: () -> Mark
    @ViewBuilder let title: () -> Title
    @ViewBuilder let summary: () -> Summary
    @ViewBuilder let trailing: () -> Trailing

    @ScaledMetric(relativeTo: .body) private var markColumn: CGFloat = 28
    /// The body style's line height, so the mark centres on the first line.
    @ScaledMetric(relativeTo: .body) private var titleLine: CGFloat = 22
    @ScaledMetric(relativeTo: .body) private var verticalPadding: CGFloat = 15
    @ScaledMetric(relativeTo: .subheadline) private var lineGap: CGFloat = 4

    var body: some View {
        HStack(alignment: markStyle == .glyph ? .top : .center, spacing: 0) {
            switch markStyle {
            case .glyph:
                mark()
                    .frame(width: markColumn, height: titleLine)
            case .avatar(let size):
                mark()
                    .frame(width: size, height: size)
                    .padding(.leading, AidenSpacing.s)
                    .padding(.trailing, AidenSpacing.m)
            }
            VStack(alignment: .leading, spacing: lineGap) {
                if isStacked {
                    // At the largest sizes the marks go under the words, so they
                    // never squeeze the title.
                    title()
                    if hasSummary { summary() }
                    HStack(spacing: AidenSpacing.s) { trailing() }
                } else if hasSummary {
                    title()
                    HStack(alignment: .firstTextBaseline, spacing: AidenSpacing.s) {
                        summary()
                        Spacer(minLength: AidenSpacing.s)
                        trailing()
                    }
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: AidenSpacing.s) {
                        title()
                        Spacer(minLength: AidenSpacing.s)
                        trailing()
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, AidenSpacing.xs)
        .padding(.trailing, AidenSpacing.l)
        .padding(.vertical, verticalPadding)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

/// The mark in a row's leading column: a spinner while it runs, a filled dot
/// when unread, else an open circle. Decoration only: the row's spoken name
/// already says working and unread.
struct AidenListRowMark: View {
    enum Mark: Equatable { case working, unread, idle }
    let mark: Mark
    var isDimmed = false

    @Environment(\.aidenPalette) private var palette
    @ScaledMetric(relativeTo: .body) private var dot: CGFloat = 9
    @ScaledMetric(relativeTo: .body) private var spinner: CGFloat = 13

    var body: some View {
        Group {
            switch mark {
            case .working:
                AidenWorkingIndicator(size: spinner)
            case .unread:
                Circle()
                    .fill(isDimmed ? palette.secondary : palette.accent)
                    .frame(width: dot, height: dot)
            case .idle:
                Circle()
                    .strokeBorder(palette.secondary.opacity(0.55), lineWidth: 1.5)
                    .frame(width: dot, height: dot)
            }
        }
        .accessibilityHidden(true)
    }
}

/// A symbol in a row's mark column, in the quieter ink: what kind of thing
/// the row is, when nothing about its state needs saying.
struct AidenListRowGlyph: View {
    let systemName: String
    var tint: Color? = nil
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        Image(systemName: systemName)
            .font(.subheadline)
            .foregroundStyle(tint ?? palette.secondary)
            .accessibilityHidden(true)
    }
}

/// One Inbox row: title, workspace, status and wait.
struct AidenInboxRowView: View {
    let row: AidenInboxProjection.Row
    let section: AidenInboxSection
    let workspaceName: String?
    let palette: AidenPalette
    var isPinned = false
    /// Says which machine the row is on. Nil when only one is listed.
    var machine: AidenMachineLabel?
    /// The row's machine is offline. The words drop to the palette's secondary
    /// colour rather than fading, so they stay readable, and the chip stays as it
    /// is, because fading it would cost its contrast.
    var isDimmed = false

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// At the largest text sizes the status goes under the words, so it never
    /// squeezes the title.
    private var isStacked: Bool { dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            content(status: AidenInboxRowStatus.make(row, section: section, now: context.date))
        }
    }

    private var unread: Bool { row.summary.unread }
    private var offlineText: String? { isDimmed ? String(localized: "Offline") : nil }

    /// The line under the title. The chip lives here so it can never take width
    /// from the title.
    private var detail: String? {
        let parts = [workspaceName, offlineText].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func content(status: AidenInboxRowStatus) -> some View {
        AidenListRowLayout(isStacked: isStacked, hasSummary: machine != nil || detail != nil) {
            AidenListRowMark(
                mark: status.tone == .working ? .working : unread ? .unread : .idle,
                isDimmed: isDimmed
            )
        } title: {
            title
        } summary: {
            AidenInboxRowMachineLine(machine: machine, detail: detail, isStacked: isStacked)
        } trailing: {
            statusLine(status)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityName(status))
    }

    private var isFork: Bool { row.summary.forkedFrom != nil }

    private var title: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            if isFork {
                Image(systemName: "arrow.triangle.branch")
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
            }
            // Never bold: an unread title only steps up to medium, and the mark
            // beside it carries the rest.
            Text(row.summary.title)
                .font(.body.weight(unread ? .medium : .regular))
                .foregroundStyle(isDimmed ? palette.secondary : palette.foreground)
                .lineLimit(isStacked ? 3 : 1)
        }
    }

    @ViewBuilder
    private func statusLine(_ status: AidenInboxRowStatus) -> some View {
        if isPinned {
            Image(systemName: "pin.fill")
                .font(.caption2)
                .foregroundStyle(palette.secondary)
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

    @ViewBuilder
    private func statusLabel(_ label: String, tone: AidenInboxRowStatus.Tone) -> some View {
        switch tone {
        case .warning, .danger:
            AidenStatusChip(label, kind: tone == .danger ? .danger : .warning, isDimmed: isDimmed)
        case .working, .plain:
            Text(label)
                .font(.caption)
                .foregroundStyle(palette.secondary)
                .lineLimit(1)
                .fixedSize(horizontal: !isStacked, vertical: false)
        }
    }

    /// "Title, workspace, status, wait, Unread", as the desktop names it, with the
    /// machine after the workspace when more than one is listed. A fork says so
    /// first, as its glyph does.
    func accessibilityName(_ status: AidenInboxRowStatus) -> String {
        [
            isFork ? String(localized: "Fork") : nil,
            row.summary.title, workspaceName, machine?.accessibilityLabel, offlineText,
            isPinned ? String(localized: "Pinned") : nil,
            status.spokenLabel ?? status.label, status.wait, unread ? "Unread" : nil,
        ]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }
}

/// A row's status on a tinted capsule: "Needs approval", "Failed". Warning and
/// danger differ by colour, so with Differentiate Without Colour on, a symbol
/// says which one it is. The words use the palette's text-safe tint, which
/// holds 4.5:1 where the fill colour itself would not.
struct AidenStatusChip: View {
    enum Kind { case warning, danger }

    private let text: String
    private let kind: Kind
    private let isDimmed: Bool

    @Environment(\.aidenPalette) private var palette
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    init(_ text: String, kind: Kind, isDimmed: Bool = false) {
        self.text = text
        self.kind = kind
        self.isDimmed = isDimmed
    }

    private var fill: Color {
        isDimmed ? palette.secondary : kind == .danger ? palette.danger : palette.warning
    }

    private var ink: Color {
        isDimmed ? palette.secondary : kind == .danger ? palette.dangerText : palette.warningText
    }

    var body: some View {
        HStack(spacing: AidenSpacing.xs) {
            if differentiateWithoutColor {
                Image(systemName: kind == .danger ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                    .accessibilityHidden(true)
            }
            Text(text)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(ink)
        .lineLimit(1)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(fill.opacity(AidenPalette.statusChipFillOpacity), in: Capsule())
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
        AidenListSectionHeader(title: section.title, count: count) {
            if section == .working {
                AidenWorkingIndicator(size: 10)
            }
        }
    }
}

/// A list section's heading, above its card: small, regular and quiet, with
/// an optional count after it and an optional mark before it. VoiceOver reads
/// the title and count as one heading. The colour holds 4.5:1 on the canvas in
/// every theme (`AidenDesignTokenTests`), at any weight.
struct AidenListSectionHeader<Leading: View>: View {
    let title: String
    var count: Int? = nil
    @ViewBuilder var leading: () -> Leading

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            leading()
            // One run of text, so the title and its count wrap and scale together.
            Group {
                if let count {
                    Text("\(title)  \(Text("\(count)").monospacedDigit())")
                } else {
                    Text(title)
                }
            }
            .font(.footnote)
            .foregroundStyle(palette.secondary)
        }
        .padding(.horizontal, AidenSpacing.xl)
        .padding(.bottom, AidenSpacing.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(count.map { "\(title), \($0)" } ?? title)
        .accessibilityAddTraits(.isHeader)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(palette.canvas)
    }
}

extension AidenListSectionHeader where Leading == EmptyView {
    init(title: String, count: Int? = nil) {
        self.init(title: title, count: count) { EmptyView() }
    }
}

extension View {
    /// Puts a list row in its section's card: inset like the Catch Up card,
    /// no separator, the card's fill (with the selected tint), and a context
    /// menu preview clipped to the card's corners.
    func aidenListCardRow(_ position: AidenListCardPosition?, isSelected: Bool = false) -> some View {
        modifier(AidenListCardRow(position: position, isSelected: isSelected))
    }
}

private struct AidenListCardRow: ViewModifier {
    let position: AidenListCardPosition?
    let isSelected: Bool
    @Environment(\.aidenPalette) private var palette

    func body(content: Content) -> some View {
        content
            .listRowInsets(EdgeInsets(top: 0, leading: AidenListRowBackground.cardInset, bottom: 0, trailing: AidenListRowBackground.cardInset))
            .listRowSeparator(.hidden)
            .listRowBackground(AidenListRowBackground(isSelected: isSelected, palette: palette, card: position))
            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: AidenRadius.control, style: .continuous))
    }
}

/// The swipe actions a row offers. A nil action is not shown, as a swipe
/// or as a VoiceOver action.
struct AidenInboxRowActions {
    var markRead: (() -> Void)?
    var done: (() -> Void)?
    var snooze: (() -> Void)?
    var undone = false
    var wake = false
    var doneLabel: String { undone ? String(localized: "Mark not done") : String(localized: "Done") }
    var snoozeLabel: String { wake ? String(localized: "Unsnooze") : String(localized: "Snooze") }

    init(offer: AidenInboxRowOffer, markRead: @escaping () -> Void,
         triage: @escaping (AidenChatTriageChange) -> Void, snooze: @escaping () -> Void) {
        self.markRead = offer.markRead ? markRead : nil
        self.done = offer.done || offer.undone ? { triage(.done(!offer.undone)) } : nil
        self.snooze = offer.wake ? { triage(.wake) } : offer.snooze ? snooze : nil
        undone = offer.undone
        wake = offer.wake
    }
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
    var isPinned = false
    var machine: AidenMachineLabel?
    var isDimmed = false
    /// The row whose chat the detail beside the list shows.
    var isSelected = false
    /// The row's identity in a list that keeps its place across a fold.
    var scrollRow: AnyHashable? = nil
    /// The row's place in its section's card, or nil for a row on the canvas.
    var card: AidenListCardPosition? = nil
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            AidenInboxRowView(
                row: row,
                section: section,
                workspaceName: workspaceName,
                palette: palette,
                isPinned: isPinned,
                machine: machine,
                isDimmed: isDimmed
            )
            .aidenListScrollRow(scrollRow)
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if let markRead = actions.markRead {
                Button(action: markRead) {
                    Label("Mark read", systemImage: "envelope.open")
                }
                .aidenSolidFillTint()
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if let done = actions.done {
                Button(action: done) {
                    Label(actions.doneLabel, systemImage: "checkmark.circle")
                }
                .tint(palette.success)
            }
            if let snooze = actions.snooze {
                Button(action: snooze) {
                    Label(actions.snoozeLabel, systemImage: "clock")
                }
                .tint(palette.warning)
            }
        }
        .accessibilityActions {
            if let markRead = actions.markRead { Button("Mark read", action: markRead) }
            if let done = actions.done { Button(actions.doneLabel, action: done) }
            if let snooze = actions.snooze { Button(actions.snoozeLabel, action: snooze) }
        }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .aidenListCardRow(card, isSelected: isSelected)
    }
}

/// Where a row sits in its section's card: the card rounds its first row's
/// top corners and its last row's bottom ones. Rows inside are parted by
/// their own padding, not separators.
enum AidenListCardPosition: Equatable, Sendable {
    case only, first, middle, last

    /// The position of the row at `index` among `count` rows.
    init(index: Int, count: Int) {
        switch (index == 0, index == count - 1) {
        case (true, true): self = .only
        case (true, false): self = .first
        case (false, true): self = .last
        case (false, false): self = .middle
        }
    }

    var roundsTop: Bool { self == .only || self == .first }
    var roundsBottom: Bool { self == .only || self == .last }

    /// Each id's position in a card that holds `ids` in order.
    static func positions<ID: Hashable>(_ ids: [ID]) -> [ID: AidenListCardPosition] {
        Dictionary(
            ids.enumerated().map { ($1, AidenListCardPosition(index: $0, count: ids.count)) },
            uniquingKeysWith: { first, _ in first }
        )
    }
}

/// An Inbox row's ground: the canvas, with a soft accent tint under the row
/// the detail beside the list is showing, the fill a selected theme card uses.
/// In a section's card, the raised fill inset like the Catch Up card above
/// the list. No border: the fill is the selection.
struct AidenListRowBackground: View {
    let isSelected: Bool
    let palette: AidenPalette
    /// The row's place in its section's card, or nil for a row on the canvas.
    var card: AidenListCardPosition? = nil

    /// The card's inset from the list's edges, the Catch Up card's.
    static let cardInset = AidenSpacing.m

    static func selectedFill(_ palette: AidenPalette) -> Color {
        palette.accent.opacity(0.12)
    }

    var body: some View {
        palette.canvas.overlay {
            if let card {
                let shape = UnevenRoundedRectangle(
                    topLeadingRadius: card.roundsTop ? AidenRadius.control : 0,
                    bottomLeadingRadius: card.roundsBottom ? AidenRadius.control : 0,
                    bottomTrailingRadius: card.roundsBottom ? AidenRadius.control : 0,
                    topTrailingRadius: card.roundsTop ? AidenRadius.control : 0,
                    style: .continuous
                )
                shape
                    .fill(isSelected ? AnyShapeStyle(Self.selectedFill(palette)) : AnyShapeStyle(Color.clear))
                    .background(palette.raised, in: shape)
                    .padding(.horizontal, Self.cardInset)
            } else if isSelected {
                RoundedRectangle(cornerRadius: AidenRadius.control, style: .continuous)
                    .fill(Self.selectedFill(palette))
                    .padding(.horizontal, AidenSpacing.m)
            }
        }
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
        let offer = AidenInbox.rowOffer(for: chat, isOpen: false, now: now, supportsReadState: true, supportsTriage: true)
        return AidenInboxRowActions(
            offer: offer,
            markRead: { update(chat.id) { $0.unread = false } },
            triage: { apply($0, to: chat, alsoMarkRead: offer.alsoMarkRead) },
            snooze: { apply(.snooze(until: now.addingTimeInterval(3600)), to: chat, alsoMarkRead: offer.alsoMarkRead) }
        )
    }

    private func apply(_ change: AidenChatTriageChange, to chat: AidenChatSummary, alsoMarkRead: Bool) {
        update(chat.id) { $0 = AidenInbox.applyingOptimisticTriage(change, to: $0, now: now, alsoMarkRead: alsoMarkRead) }
        notice = AidenInboxNotice(
            message: change.confirmation,
            undo: AidenInbox.undo(of: change, before: chat, now: now),
            chatID: chat.id
        )
    }

    private func update(_ id: String, _ body: (inout AidenChatSummary) -> Void) {
        guard let index = chats.firstIndex(where: { $0.id == id }) else { return }
        body(&chats[index])
    }
}
#endif
