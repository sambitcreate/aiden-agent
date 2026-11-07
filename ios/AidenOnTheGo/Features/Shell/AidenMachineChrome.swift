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

    var showsStrip: Bool { AidenMachineStrip.isShown(for: visible) }

    /// Nil unless the list holds rows from more than one machine.
    func rowChip(for instanceId: String, filter: AidenMachineFilter) -> AidenMachineLabel? {
        filter == .all ? searchChip(for: instanceId) : nil
    }

    /// Search leaves out what the Inbox hides, whatever the Inbox is filtered to.
    func searchChip(for instanceId: String) -> AidenMachineLabel? {
        visible.count > 1 ? labels[instanceId] : nil
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

    @ScaledMetric(relativeTo: .caption) private var scaledSize: CGFloat = 18
    /// Past this it would outgrow the words beside it for no gain in telling
    /// machines apart.
    private var size: CGFloat { min(scaledSize, 28) }

    init(label: AidenMachineLabel) {
        self.label = label
    }

    var body: some View {
        AidenMachineChipImage(
            symbol: label.symbol,
            color: label.color,
            size: size,
            symbolScale: 0.66,
            cornerRadius: size * 0.29
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label.accessibilityLabel)
    }
}

/// All, then a chip for each machine. Drawn only when there's a choice to make.
struct AidenMachineStrip: View {
    private let labels: [AidenMachineLabel]
    @Binding private var filter: AidenMachineFilter

    @Environment(\.aidenPalette) private var palette
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
        return Button { filter = choice } label: {
            HStack(spacing: AidenSpacing.s) { content() }
                .font(.subheadline.weight(isSelected ? .semibold : .medium))
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(isSelected ? palette.onFillAccent : palette.foreground)
                .padding(.horizontal, AidenSpacing.m)
                .frame(minHeight: 44)
                .background(isSelected ? palette.fillAccent : palette.raised, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
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
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                }
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
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
        .accessibilityLabel(String(localized: "\(online) of \(total) machines online"))
        .accessibilityHint("Opens Machines")
        .accessibilityIdentifier("aiden.machine-status")
    }
}

extension EnvironmentValues {
    /// The name a conversation's toolbar shows under its title. Nil says nothing.
    @Entry var aidenConversationMachine: String?
}
