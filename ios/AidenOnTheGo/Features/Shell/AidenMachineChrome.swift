import SwiftUI

/// How one machine is named and drawn around its rows.
struct AidenMachineLabel: Equatable {
    let instanceId: String
    /// The person's name for it, else the machine's own, with the last four
    /// characters of `instanceId` when another machine reads the same.
    let name: String
    let symbol: AidenMachineSymbol
    let color: AidenMachineColor

    /// What VoiceOver says for the chip, so colour is never the only signal.
    var accessibilityLabel: String { String(localized: "On \(name)") }

    /// Reads and assigns nothing, so a view can build these from `body`. A machine
    /// nobody has registered yet draws in slate until the Inbox store settles it.
    @MainActor
    static func labels(
        connections: [AidenHostConnection],
        preferences: AidenMachinePreferencesStore
    ) -> [String: Self] {
        let names = connections.map {
            preferences.saved(for: $0.instanceId)?.nameOverride ?? $0.installation.name
        }
        var labels: [String: Self] = [:]
        for (index, connection) in connections.enumerated() {
            let saved = preferences.saved(for: connection.instanceId)
            let isShared = names.enumerated().contains {
                $0.offset != index && $0.element.localizedCaseInsensitiveCompare(names[index]) == .orderedSame
            }
            labels[connection.instanceId] = Self(
                instanceId: connection.instanceId,
                name: isShared ? "\(names[index]) (\(connection.instanceId.suffix(4).lowercased()))" : names[index],
                symbol: saved?.symbol ?? .desktop,
                color: saved?.color ?? .slate
            )
        }
        return labels
    }
}

/// The machines the Inbox draws around its rows, as `AidenUnifiedInboxStore`
/// last read them.
struct AidenMachineRoster: Equatable {
    struct OfflineMachine: Identifiable, Equatable {
        let label: AidenMachineLabel
        let lastSeen: Date?
        let isReconnecting: Bool

        var id: String { label.instanceId }
    }

    /// Every paired machine's label.
    var labels: [String: AidenMachineLabel] = [:]
    /// What the Inbox lists: neither hidden nor blocked, in pairing order.
    var visible: [AidenMachineLabel] = []
    /// Machines known to be offline, in `visible`'s order. A machine still making
    /// its first connection isn't one of these.
    var offline: [OfflineMachine] = []
    var online = 0
    /// Every paired machine, which is what the Machines page lists.
    var total = 0
    /// Paired and not blocked, hidden or not.
    var usable = 0
    /// What the Bots and Workspaces tabs list: paired and not blocked, hidden
    /// from the Inbox or not, in pairing order. Hiding only covers the Inbox.
    var tabMachines: [AidenMachineLabel] = []

    var showsStrip: Bool { AidenMachineStrip.isShown(for: visible) }
    /// The Bots and Workspaces tabs' strip, over `tabMachines`.
    var showsTabStrip: Bool { AidenMachineStrip.isShown(for: tabMachines) }

    /// Nil unless the list holds rows from more than one machine.
    func rowChip(for instanceId: String, filter: AidenMachineFilter) -> AidenMachineLabel? {
        filter == .all ? searchChip(for: instanceId) : nil
    }

    /// Search leaves out what the Inbox hides, whatever the Inbox is filtered to.
    func searchChip(for instanceId: String) -> AidenMachineLabel? {
        visible.count > 1 ? labels[instanceId] : nil
    }

    /// The name Search shows beside a row: the label's, so a rename shows there
    /// too, else the name the row came with.
    func searchMachineName(for instanceId: String, else fallback: String) -> String {
        labels[instanceId]?.name ?? fallback
    }

    /// A chat row may have no machine name of its own.
    func searchMachineName(for instanceId: String, else fallback: String?) -> String? {
        labels[instanceId]?.name ?? fallback
    }

    /// A chat on a hidden machine can still open, from a notification, so this
    /// counts more than `visible`.
    func chatSubtitle(for instanceId: String) -> String? {
        usable > 1 ? labels[instanceId]?.name : nil
    }

    func isOffline(_ instanceId: String) -> Bool {
        offline.contains { $0.id == instanceId }
    }

    func offlineRows(under filter: AidenMachineFilter) -> [OfflineMachine] {
        offline.filter { filter == .all || filter == .machine($0.id) }
    }

    /// What the machine page calls open: everything not marked done.
    static func openChatCount(in chats: [AidenChatSummary]) -> Int {
        chats.filter { $0.inbox.doneAt == nil }.count
    }
}

/// A machine's symbol on its colour, small enough to sit in a row. Its fill and
/// symbol are the same in every theme, so the contrast holds in all of them.
struct AidenMachineChip: View {
    private let label: AidenMachineLabel
    private let namesItselfWithoutColor: Bool

    @ScaledMetric(relativeTo: .caption) private var scaledSize: CGFloat = 18
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @Environment(\.aidenPalette) private var palette
    /// Past this it would outgrow the words beside it for no gain in telling
    /// machines apart.
    private var size: CGFloat { min(scaledSize, 28) }

    /// `namesItselfWithoutColor` is for a chip with no name beside it. Machines
    /// share a symbol until someone picks another, so with Differentiate Without
    /// Colour on, colour can't be what tells them apart: the chip shows the name.
    init(label: AidenMachineLabel, namesItselfWithoutColor: Bool = false) {
        self.label = label
        self.namesItselfWithoutColor = namesItselfWithoutColor
    }

    var showsName: Bool { namesItselfWithoutColor && differentiateWithoutColor }

    var body: some View {
        HStack(spacing: AidenSpacing.xs) {
            AidenMachineChipImage(
                symbol: label.symbol,
                color: label.color,
                size: size,
                symbolScale: 0.66,
                cornerRadius: size * 0.29
            )
            if showsName {
                Text(label.name)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label.accessibilityLabel)
    }
}

/// All, then a chip for each machine. Drawn only when there's a choice to make.
struct AidenMachineStrip: View {
    private let labels: [AidenMachineLabel]
    @Binding private var filter: AidenMachineFilter

    /// Past this a long name truncates, however large the text is.
    @ScaledMetric(relativeTo: .subheadline) private var scaledNameWidth: CGFloat = 160
    private var nameWidth: CGFloat { min(scaledNameWidth, 240) }

    init(labels: [AidenMachineLabel], filter: Binding<AidenMachineFilter>) {
        self.labels = labels
        _filter = filter
    }

    static func isShown(for labels: [AidenMachineLabel]) -> Bool { labels.count >= 2 }

    var body: some View {
        if Self.isShown(for: labels) {
            ScrollView(.horizontal) {
                HStack(spacing: AidenSpacing.s) {
                    button(for: .all, spokenAs: String(localized: "All machines")) {
                        Text("All")
                    }
                    ForEach(labels, id: \.instanceId) { label in
                        button(for: .machine(label.instanceId), spokenAs: label.name) {
                            AidenMachineChip(label: label)
                                .accessibilityHidden(true)
                            Text(label.name)
                                .frame(maxWidth: nameWidth, alignment: .leading)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                    }
                }
            }
            .contentMargins(.horizontal, AidenSpacing.l, for: .scrollContent)
            .scrollIndicators(.hidden)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Filter by machine")
        }
    }

    private func button(
        for choice: AidenMachineFilter,
        spokenAs name: String,
        @ViewBuilder content: () -> some View
    ) -> some View {
        let isSelected = filter == choice
        let label = content()
        return Button { filter = choice } label: {
            AidenMachineFilterChoiceLabel(isSelected: isSelected) { label }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// One choice in the strip. The fill says which is picked, and with
/// Differentiate Without Colour on, a checkmark says it too.
struct AidenMachineFilterChoiceLabel<Content: View>: View {
    let isSelected: Bool
    @ViewBuilder let content: () -> Content

    @Environment(\.aidenPalette) private var palette
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    var body: some View {
        HStack(spacing: AidenSpacing.s) {
            if isSelected && differentiateWithoutColor {
                Image(systemName: "checkmark")
                    .font(.caption.weight(.bold))
                    .accessibilityHidden(true)
            }
            content()
        }
        .font(.subheadline.weight(isSelected ? .semibold : .medium))
        .lineLimit(1)
        .truncationMode(.tail)
        .foregroundStyle(isSelected ? palette.onFillAccent : palette.foreground)
        .padding(.horizontal, AidenSpacing.m)
        .frame(minHeight: 44)
        .background(isSelected ? palette.fillAccent : palette.raised, in: Capsule())
        .contentShape(Capsule())
    }
}

/// Says a machine is offline, when it last answered, and offers to try it again.
struct AidenMachineOfflineRow: View {
    private let label: AidenMachineLabel
    private let lastSeen: Date?
    private let isReconnecting: Bool
    private let onReconnect: () -> Void

    @Environment(\.aidenPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(label: AidenMachineLabel, lastSeen: Date?, isReconnecting: Bool = false, onReconnect: @escaping () -> Void) {
        self.label = label
        self.lastSeen = lastSeen
        self.isReconnecting = isReconnecting
        self.onReconnect = onReconnect
    }

    private var title: String { String(localized: "\(label.name) is offline") }
    private var detail: String { AidenInstallationPresentation.lastConnection(lastSeen) }

    var body: some View {
        // At the largest text sizes the button goes under the words, so they keep the width.
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: AidenSpacing.xs))
            : AnyLayout(HStackLayout(spacing: AidenSpacing.m))
        layout {
            HStack(alignment: dynamicTypeSize.isAccessibilitySize ? .top : .center, spacing: AidenSpacing.m) {
                AidenMachineChip(label: label)
                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(palette.foreground)
                    // The warning tint behind it takes the quieter colour under 4.5:1.
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(palette.foreground)
                }
                // A long name wraps rather than cutting off what the row says.
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 2)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(title), \(detail)")
            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
            reconnect
        }
        .padding(.leading, AidenSpacing.m)
        .padding(.trailing, AidenSpacing.s)
        .padding(.vertical, AidenSpacing.xs)
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
        .background(palette.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: AidenRadius.control, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private var reconnect: some View {
        Button(action: onReconnect) {
            HStack(spacing: AidenSpacing.xs) {
                if isReconnecting {
                    ProgressView()
                        .controlSize(.small)
                }
                Text("Reconnect")
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(palette.foreground)
            .padding(.horizontal, AidenSpacing.s)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Several rows can be offline at once, so each button says which machine it tries.
        .accessibilityLabel(String(localized: "Reconnect \(label.name)"))
        .disabled(isReconnecting)
    }
}

/// "3 of 4": how many machines are online, in the Inbox's toolbar. It opens Machines.
struct AidenHostStatusItem: View {
    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 17

    private let online: Int
    private let total: Int
    private let onOpen: () -> Void

    init(online: Int, total: Int, onOpen: @escaping () -> Void) {
        self.online = online
        self.total = total
        self.onOpen = onOpen
    }

    static func title(online: Int, total: Int) -> String {
        String(localized: "\(online) of \(total)")
    }

    /// What VoiceOver says for the item.
    static func spokenTitle(online: Int, total: Int) -> String {
        total == 1
            ? String(localized: "\(online) of 1 machine online")
            : String(localized: "\(online) of \(total) machines online")
    }

    var body: some View {
        Button(action: onOpen) {
            // Not a `Label`: a toolbar draws one as its icon alone, and the count is the point.
            HStack(spacing: AidenSpacing.xs) {
                Image(systemName: "desktopcomputer")
                    .accessibilityHidden(true)
                Text(Self.title(online: online, total: total))
                    .monospacedDigit()
            }
            // A bar's height doesn't grow, so past this size the item would spill out of
            // it and push the title aside. A held press shows the large version. The size
            // is set here because a toolbar ignores a `dynamicTypeSize` limit on its items.
            .font(.system(size: min(textSize, 22)))
            .lineLimit(1)
            .fixedSize()
        }
        .accessibilityShowsLargeContentViewer()
        .accessibilityLabel(Self.spokenTitle(online: online, total: total))
        .accessibilityHint("Opens Machines")
        .accessibilityIdentifier("aiden.machine-status")
    }
}

extension EnvironmentValues {
    /// The name a conversation's toolbar shows under its title. Nil says nothing.
    @Entry var aidenConversationMachine: String?
}

/// Tiles in rows: as many columns at least `minimumWidth` wide as fit, sharing the
/// width, as `GridItem(.adaptive(minimum:))` lays them out. It measures every tile
/// up front instead of lazily. On iOS 26.5 an adaptive `LazyVGrid` in a Form row on
/// an iPad sized itself again on each pass when the text size changed, until UIKit
/// stopped the app.
struct AidenTileGrid: Layout {
    var minimumWidth: CGFloat
    var spacing: CGFloat

    /// How many columns fit in `width`.
    static func columnCount(width: CGFloat, minimumWidth: CGFloat, spacing: CGFloat) -> Int {
        guard width.isFinite, width > 0, minimumWidth > 0 else { return 1 }
        return max(1, Int(((width + spacing) / (minimumWidth + spacing)).rounded(.down)))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let grid = columns(in: proposal.width, count: subviews.count)
        let heights = rowHeights(of: subviews, grid: grid)
        let naturalWidth = CGFloat(grid.count) * grid.width + CGFloat(grid.count - 1) * spacing
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? naturalWidth
        return CGSize(width: width, height: heights.reduce(0, +) + CGFloat(max(heights.count - 1, 0)) * spacing)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let grid = columns(in: bounds.width, count: subviews.count)
        var y = bounds.minY
        for (row, height) in rowHeights(of: subviews, grid: grid).enumerated() {
            for column in 0..<grid.count {
                let index = row * grid.count + column
                guard index < subviews.count else { break }
                subviews[index].place(
                    at: CGPoint(x: bounds.minX + CGFloat(column) * (grid.width + spacing), y: y),
                    anchor: .topLeading,
                    proposal: ProposedViewSize(width: grid.width, height: height)
                )
            }
            y += height + spacing
        }
    }

    /// One row of every tile at its smallest when no width is offered.
    private func columns(in width: CGFloat?, count: Int) -> (count: Int, width: CGFloat) {
        guard let width, width.isFinite, width > 0 else { return (max(count, 1), minimumWidth) }
        let columns = Self.columnCount(width: width, minimumWidth: minimumWidth, spacing: spacing)
        return (columns, max((width - CGFloat(columns - 1) * spacing) / CGFloat(columns), 0))
    }

    private func rowHeights(of subviews: Subviews, grid: (count: Int, width: CGFloat)) -> [CGFloat] {
        stride(from: 0, to: subviews.count, by: grid.count).map { start in
            subviews[start..<min(start + grid.count, subviews.count)]
                .map { $0.sizeThatFits(ProposedViewSize(width: grid.width, height: nil)).height }
                .max() ?? 0
        }
    }
}
