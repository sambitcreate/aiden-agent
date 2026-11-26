import SwiftUI

/// The dock in a screen's bottom bar, and the recents its chosen tab opens.
///
/// A tap on another tab switches to it. A tap on the chosen tab, while its
/// list is showing, opens that tab's recents over the page; while a page is
/// pushed over the list it goes back to the list, as it always has.
///
/// The host reads no store. `recents` is asked only when a list opens, so
/// nothing is built, sorted or observed while the dock just sits there.
struct AidenDockHost: View {
    let selection: AidenAppTab
    let needsYouCount: Int
    /// The chosen tab shows its own list, with nothing pushed over it.
    let isAtRoot: Bool
    /// Switches tab, or returns the chosen one to its list.
    let onSelect: (AidenAppTab) -> Void
    let recents: (AidenAppTab) -> AidenDockRecentsList
    /// A row was chosen in the tab's recents.
    let onOpen: (AidenAppTab, AidenAppRoute) -> Void
    /// Runs once the recents have gone, so what it presents has a clear screen.
    let onFooter: (AidenDockRecentsList.Footer) -> Void

    @State private var open: AidenDockRecentsList?
    @State private var memo = Memo()

    /// What the host remembers without redrawing for it.
    private final class Memo {
        /// The dock's frame in the window, kept for the copy drawn over the scrim.
        var dockFrame = CGRect.zero
        var pendingFooter: AidenDockRecentsList.Footer?
    }

    var body: some View {
        AidenDock(
            selection: selection,
            needsYouCount: needsYouCount,
            chosenTabHint: isAtRoot ? Self.opensHint(for: selection) : nil,
            onSelect: tapped
        )
        .equatable()
        // The copy over the scrim stands in for it while the recents are open.
        .accessibilityHidden(open != nil)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { [memo] in memo.dockFrame = $0 }
        .padding(.bottom, AidenSpacing.xs)
        .fullScreenCover(item: $open, onDismiss: runPendingFooter) { list in
            AidenDockRecentsCover(
                list: list,
                needsYouCount: needsYouCount,
                dockFrame: memo.dockFrame,
                onClose: { open = nil },
                onOpen: { route in
                    open = nil
                    onOpen(list.tab, route)
                },
                onFooter: { footer in
                    memo.pendingFooter = footer
                    open = nil
                },
                onSelect: { tab in
                    open = nil
                    onSelect(tab)
                }
            )
            .presentationBackground(.clear)
        }
        // The popover runs its own entrance; the cover comes and goes
        // without the system's slide.
        .transaction(value: open?.tab) { $0.disablesAnimations = true }
        .onChange(of: selection) { open = nil }
        .onChange(of: isAtRoot) { _, atRoot in
            if !atRoot { open = nil }
        }
    }

    private func tapped(_ tab: AidenAppTab) {
        if tab == selection, isAtRoot {
            open = recents(tab)
        } else {
            onSelect(tab)
        }
    }

    private func runPendingFooter() {
        guard let footer = memo.pendingFooter else { return }
        memo.pendingFooter = nil
        onFooter(footer)
    }

    static func opensHint(for tab: AidenAppTab) -> String {
        switch tab {
        case .chats: String(localized: "Tap again to show recent chats.")
        case .bots: String(localized: "Tap again to show recent Bots.")
        case .workspaces: String(localized: "Tap again to show recent workspaces.")
        case .inbox: String(localized: "Tap again to show the latest in your Inbox.")
        }
    }
}

/// The open recents: the page whitened behind, the list above the dock, and
/// a copy of the dock exactly over the real one, so the chosen tab closes
/// the list and any other tab switches to it. A full-screen cover holds it,
/// so the page and its bars are out of reach, of VoiceOver too, until it goes.
private struct AidenDockRecentsCover: View {
    let list: AidenDockRecentsList
    let needsYouCount: Int
    /// The real dock's frame in the window.
    let dockFrame: CGRect
    let onClose: () -> Void
    let onOpen: (AidenAppRoute) -> Void
    let onFooter: (AidenDockRecentsList.Footer) -> Void
    let onSelect: (AidenAppTab) -> Void

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    @State private var isShown = false

    /// How much of the page shows through the scrim (the concept: 22%).
    private static let scrimOpacity = 0.78
    /// Between the list and the dock's pill.
    private static let gap: CGFloat = AidenSpacing.s

    var body: some View {
        GeometryReader { proxy in
            let window = proxy.frame(in: .global)
            let dock = dockFrame(in: window, safeBottom: proxy.safeAreaInsets.bottom)
            ZStack {
                palette.canvas
                    .opacity(isShown ? Self.scrimOpacity : 0)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: close)
                    .accessibilityElement()
                    .accessibilityLabel(Text("Close recents"))
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("aiden.dockRecents.dismiss")
                    .accessibilitySortPriority(0)

                AidenDockRecentsPopover(list: list, onOpen: onOpen, onFooter: onFooter)
                    .scaleEffect(isShown || reduceMotion ? 1 : 0.92, anchor: scaleAnchor)
                    .opacity(isShown ? 1 : 0)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
                    .padding(.horizontal, AidenSpacing.l)
                    .padding(.top, proxy.safeAreaInsets.top + AidenSpacing.s)
                    .padding(.bottom, window.maxY - dock.minY + Self.gap)
                    .accessibilitySortPriority(2)

                AidenDock(
                    selection: list.tab,
                    needsYouCount: needsYouCount,
                    chosenTabHint: String(localized: "Tap again to close recents."),
                    onSelect: { tab in
                        if tab == list.tab { close() } else { onSelect(tab) }
                    }
                )
                .frame(width: dock.width, height: dock.height)
                .position(x: dock.midX - window.minX, y: dock.midY - window.minY)
                .accessibilitySortPriority(1)
            }
        }
        .ignoresSafeArea()
        .accessibilityAction(.escape, close)
        .onAppear {
            withAnimation(reduceMotion ? nil : .spring(response: 0.26, dampingFraction: 0.84)) { isShown = true }
        }
    }

    /// The real dock's frame, or where a dock sits when none was measured.
    private func dockFrame(in window: CGRect, safeBottom: CGFloat) -> CGRect {
        guard dockFrame.height > 0 else {
            let height = AidenSettingsTokens.minimumHitSize + 2 * AidenSpacing.xs
            return CGRect(
                x: window.minX,
                y: window.maxY - safeBottom - AidenSpacing.xs - height,
                width: window.width,
                height: height
            )
        }
        return dockFrame
    }

    /// The list sits over its own tab's half of the dock.
    private var opensFromLeadingEdge: Bool {
        list.tab == .chats || list.tab == .bots
    }

    private var alignment: Alignment {
        opensFromLeadingEdge ? .bottomLeading : .bottomTrailing
    }

    private var scaleAnchor: UnitPoint {
        let fromLeft = opensFromLeadingEdge == (layoutDirection == .leftToRight)
        return fromLeft ? .bottomLeading : .bottomTrailing
    }

    private func close() {
        guard isShown, !reduceMotion else { return onClose() }
        withAnimation(.easeOut(duration: 0.14)) {
            isShown = false
        } completion: {
            onClose()
        }
    }
}

/// The recents card (concept 02): up to a handful of rows, each an icon,
/// a title and a line under it, with a spinner on work in progress, and the
/// tab's own "new" action under a hairline.
struct AidenDockRecentsPopover: View {
    let list: AidenDockRecentsList
    let onOpen: (AidenAppRoute) -> Void
    let onFooter: (AidenDockRecentsList.Footer) -> Void

    @Environment(\.aidenPalette) private var palette
    @ScaledMetric(relativeTo: .subheadline) private var width: CGFloat = 290

    var body: some View {
        // At the largest text sizes the rows can outgrow the screen; then they scroll.
        ViewThatFits(in: .vertical) {
            content
            ScrollView { content }
                .scrollBounceBehavior(.basedOnSize)
        }
        .frame(maxWidth: width)
        .background(palette.raised, in: shape)
        .clipShape(shape)
        .shadow(color: .black.opacity(0.14), radius: 20, y: 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(list.title))
        .accessibilityIdentifier("aiden.dockRecents")
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: AidenRadius.card, style: .continuous)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            if list.rows.isEmpty {
                Text(list.emptyText)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, AidenSpacing.l)
                    .padding(.vertical, AidenSpacing.m)
                    .accessibilityIdentifier("aiden.dockRecents.empty")
            }
            ForEach(Array(list.rows.enumerated()), id: \.element.id) { index, row in
                Button {
                    onOpen(row.route)
                } label: {
                    AidenDockRecentRow(row: row)
                }
                .buttonStyle(AidenDockRecentButtonStyle())
                .accessibilityIdentifier("aiden.dockRecents.row.\(index)")
            }
            if let footer = list.footer {
                Rectangle()
                    .fill(AidenSettingsTokens.separator(palette))
                    .frame(height: 0.5)
                    .padding(.horizontal, AidenSpacing.l)
                    .accessibilityHidden(true)
                Button {
                    onFooter(footer)
                } label: {
                    HStack(spacing: AidenSpacing.m) {
                        Image(systemName: "plus")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(palette.raised)
                            .frame(width: 22, height: 22)
                            .background(palette.foreground, in: Circle())
                            .frame(width: AidenDockRecentRow.iconColumn)
                        Text(footer.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(palette.foreground)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, AidenSpacing.l)
                    .padding(.vertical, AidenSpacing.m)
                    .frame(minHeight: AidenSettingsTokens.minimumHitSize)
                    .contentShape(Rectangle())
                }
                .buttonStyle(AidenDockRecentButtonStyle())
                .accessibilityIdentifier("aiden.dockRecents.footer")
            }
        }
        .padding(.vertical, AidenSpacing.s)
    }
}

private struct AidenDockRecentRow: View {
    let row: AidenDockRecent

    static let iconColumn: CGFloat = 24

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(spacing: AidenSpacing.m) {
            icon
                .frame(width: Self.iconColumn)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                if let subtitle = row.subtitle {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: AidenSpacing.s)
            status
        }
        .padding(.horizontal, AidenSpacing.l)
        .padding(.vertical, 10)
        .frame(minHeight: AidenSettingsTokens.minimumHitSize)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var icon: some View {
        switch row.icon {
        case .symbol(let name):
            Image(systemName: name)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(palette.foreground)
        case .bot(let avatar):
            AidenBotSemanticAvatarView(avatar: avatar, name: row.title, size: Self.iconColumn)
        }
    }

    @ViewBuilder
    private var status: some View {
        switch row.status {
        case .none:
            EmptyView()
        case .running:
            AidenWorkingIndicator(size: 18, tint: palette.foreground, accessibilityLabel: String(localized: "Working"))
        case .needsYou:
            Circle()
                .fill(palette.danger)
                .frame(width: 8, height: 8)
                .accessibilityElement()
                .accessibilityLabel(Text("Needs you"))
        }
    }
}

/// A row's press: the neutral selection fill behind it, nothing else moves.
private struct AidenDockRecentButtonStyle: ButtonStyle {
    @Environment(\.aidenPalette) private var palette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? AidenListRowBackground.selectedFill(palette) : .clear)
    }
}

// MARK: The shell's side

extension AidenDockRecents {
    /// One tab's recents from the stores the tab's own list reads. The dock
    /// calls it when a list opens, never while it draws.
    @MainActor
    static func list(
        for tab: AidenAppTab,
        store: AidenUnifiedInboxStore,
        isArchived: (_ instanceId: String, _ workspaceId: String) -> Bool,
        canStart: Bool
    ) -> AidenDockRecentsList {
        let inbox = store.inbox
        switch tab {
        case .chats:
            return chats(
                snapshots: Array(store.snapshots.values),
                hiddenMachines: store.hiddenMachines,
                running: Set(inbox.running.map(\.id)),
                needsYou: Set(inbox.needsYou.map(\.id)),
                canStart: canStart
            )
        case .bots:
            return bots(store.botSections().flatMap(\.rows))
        case .workspaces:
            return workspaces(
                store.workspaceSections(isArchived: isArchived).flatMap(\.rows),
                snapshots: Array(store.snapshots.values),
                running: Set(inbox.running.map(\.id)),
                canStart: canStart
            )
        case .inbox:
            return self.inbox(inbox)
        }
    }

    /// The list's own "new" action, on the compose flow the shell presents.
    /// A workspace chat goes to the workspace choice, or to naming one with
    /// none to choose; a plain chat starts in the machine's Chats home when
    /// it has one.
    @MainActor
    static func start(_ footer: AidenDockRecentsList.Footer, with flow: AidenNewWorkChatFlow) {
        flow.picker.startOver(preferring: nil, offeringHidden: footer == .newWorkspaceChat)
        let inWorkspace: AidenNewAgentChoice = flow.existingWorkspaces.isEmpty ? .newWorkspace : .existingWorkspace
        let choice = footer == .newChat && flow.choices.contains(.noWorkspace) ? .noWorkspace : inWorkspace
        Task { @MainActor in
            await flow.select(choice)
        }
    }
}
