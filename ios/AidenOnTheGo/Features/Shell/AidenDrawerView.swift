import SwiftUI

/// Pins a Bot or workspace to the drawer, or unpins it. For a row's context menu.
struct AidenDrawerPinButton: View {
    let pin: AidenDrawerPin
    var store: AidenDrawerPinsStore = .shared

    var body: some View {
        if store.isPinned(pin) {
            Button("Unpin", systemImage: "pin.slash") { store.toggle(pin) }
        } else {
            Button("Pin", systemImage: "pin") { store.toggle(pin) }
                .accessibilityHint("Shows it at the top of the menu.")
        }
    }
}

/// The drawer: the person's pins, recent chats and the pages with no tab of
/// their own, over a search field that searches every chat and Bot. It lays
/// over the content from the leading edge at every width (`AidenDrawerOverlay`).
struct AidenDrawerView<Compose: View>: View {
    /// The shell's, so the query and what it found outlive a fold and the
    /// drawer closing.
    let search: AidenSearchModel
    let inboxStore: AidenUnifiedInboxStore
    let pins: AidenDrawerPinsStore
    let usageUnavailable: Bool
    /// Opens a route and closes the drawer.
    let onOpen: (AidenAppRoute) -> Void
    let onShowAllChats: () -> Void
    let onClose: () -> Void
    /// New chat, or Add Computer with none paired.
    @ViewBuilder let compose: () -> Compose

    static var recentsLimit: Int { 12 }

    @Environment(\.aidenPalette) private var palette
    @FocusState private var searchIsFocused: Bool
    /// VoiceOver lands on the heading when the drawer opens.
    @AccessibilityFocusState private var headingIsFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Group {
                if search.hasQuery {
                    AidenSearchResultsView(
                        model: search,
                        inboxStore: inboxStore,
                        searchIsFocused: $searchIsFocused,
                        onOpen: onOpen
                    )
                } else {
                    sections
                }
            }
            .frame(maxHeight: .infinity)
            bottomBar
        }
        .background(palette.sidebar.ignoresSafeArea())
        .foregroundStyle(palette.foreground)
        .task(id: search.trimmedQuery) { await search.run() }
        .task {
            // After the first frame, so VoiceOver has the heading to move to.
            await Task.yield()
            headingIsFocused = true
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, onClose)
    }

    // MARK: Header

    private var header: some View {
        HStack {
            Text("Aiden")
                .font(.title2.bold())
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($headingIsFocused)
            Spacer()
            Button(action: onClose) {
                Label("Close menu", systemImage: "xmark")
                    .labelStyle(.iconOnly)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(palette.secondary)
            // A hardware keyboard's Escape.
            .keyboardShortcut(.cancelAction)
        }
        .padding(.leading, AidenSpacing.xl)
        .padding(.trailing, AidenSpacing.s)
        .padding(.top, AidenSpacing.s)
    }

    // MARK: Sections

    private var sections: some View {
        let snapshots = Array(inboxStore.snapshots.values)
        let pinned = AidenDrawerPinned.items(
            pins: pins.pins,
            snapshots: snapshots,
            hiddenMachines: inboxStore.hiddenMachines
        )
        let recents = AidenChatsList.entries(
            snapshots: snapshots,
            hiddenMachines: inboxStore.hiddenMachines,
            limit: Self.recentsLimit
        )
        return List {
            if !pinned.isEmpty {
                Section {
                    ForEach(pinned) { item in
                        row(
                            item.name,
                            systemImage: item.pin.kind == .bot ? AidenChromeSymbols.bots : "folder",
                            detail: item.isOnline ? nil : String(localized: "offline")
                        ) { onOpen(item.pin.route) }
                        .contextMenu { AidenDrawerPinButton(pin: item.pin, store: pins) }
                    }
                } header: {
                    sectionHeader("Pinned")
                }
            }
            Section {
                if recents.isEmpty, inboxStore.listState == .loading {
                    // The first load: rows to come, not an empty flash.
                    AidenChatListSkeleton(rowCount: 4, accessibilityText: "Loading chats")
                        .listRowInsets(EdgeInsets(top: 0, leading: AidenSpacing.s, bottom: 0, trailing: AidenSpacing.s))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                } else if recents.isEmpty {
                    Text("No chats yet")
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                } else {
                    ForEach(recents) { entry in
                        row(
                            entry.title,
                            systemImage: "bubble.left",
                            detail: entry.isOnline ? nil : String(localized: "offline")
                        ) { openChat(entry) }
                    }
                    row(String(localized: "Show all chats"), systemImage: "bubble.left.and.bubble.right", action: onShowAllChats)
                        .foregroundStyle(palette.accent)
                }
            } header: {
                sectionHeader("Recents")
            }
            Section {
                row(String(localized: "Scheduled tasks"), systemImage: "calendar.badge.clock") { onOpen(.scheduled) }
                row(String(localized: "Usage"), systemImage: "chart.bar.xaxis") { onOpen(.usage) }
                    .disabled(usageUnavailable)
                row(String(localized: "Computers"), systemImage: "desktopcomputer") { onOpen(.machines) }
            } header: {
                sectionHeader("More")
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 44)
    }

    private func sectionHeader(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(palette.secondary)
            .accessibilityAddTraits(.isHeader)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, AidenSpacing.xl)
            .padding(.vertical, AidenSpacing.xs)
            .background(palette.sidebar)
            .listRowInsets(EdgeInsets())
    }

    private func row(
        _ title: String,
        systemImage: String,
        detail: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: AidenSpacing.m) {
                Image(systemName: systemImage)
                    .foregroundStyle(palette.secondary)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                Text(title)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 0, leading: AidenSpacing.xl, bottom: 0, trailing: AidenSpacing.l))
    }

    private func openChat(_ entry: AidenChatListEntry) {
        inboxStore.homeModel(for: entry.id.instanceId)?.markViewed(chatID: entry.id.objectId)
        onOpen(entry.route)
    }

    // MARK: Bottom bar

    private var bottomBar: some View {
        HStack(spacing: AidenSpacing.s) {
            Button { onOpen(.settings) } label: {
                Label("Settings", systemImage: "gearshape")
                    .labelStyle(.iconOnly)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            searchField
            // The style reaches the shell's own button, so its whole 44pt
            // square takes the tap, not only the glyph.
            compose()
                .buttonStyle(AidenDrawerIconButtonStyle())
        }
        .padding(.horizontal, AidenSpacing.m)
        .padding(.vertical, AidenSpacing.s)
    }

    /// A filled field. Focus shows in its caret, not a ring.
    private var searchField: some View {
        @Bindable var search = search
        return HStack(spacing: AidenSpacing.s) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(palette.secondary)
                .accessibilityHidden(true)
            TextField("Search chats and Bots", text: $search.query)
                .textFieldStyle(.plain)
                .focused($searchIsFocused)
                .submitLabel(.search)
                .autocorrectionDisabled()
            if search.hasQuery {
                Button {
                    search.query = ""
                } label: {
                    Label("Clear search", systemImage: "xmark.circle.fill")
                        .labelStyle(.iconOnly)
                        .foregroundStyle(palette.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, AidenSpacing.m)
        .frame(minHeight: 40)
        .background(palette.raised, in: Capsule())
    }
}

/// An icon-only button whose 44pt square, not only its glyph, takes the tap.
private struct AidenDrawerIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        IconLabel(configuration: configuration)
    }

    private struct IconLabel: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.aidenPalette) private var palette

        var body: some View {
            configuration.label
                .labelStyle(.iconOnly)
                .font(.title3)
                .foregroundStyle(isEnabled ? palette.accent : palette.secondary)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .opacity(configuration.isPressed ? 0.5 : 1)
        }
    }
}

/// Lays the drawer over the content from the leading edge, with a dimmed
/// scrim behind it, at every width. The scrim, a swipe toward the edge, or
/// Escape closes it. Reduce Motion fades it in place of the slide.
struct AidenDrawerOverlay<Drawer: View>: View {
    let isOpen: Bool
    let onClose: () -> Void
    @ViewBuilder let drawer: () -> Drawer

    @Environment(\.aidenReduceMotion) private var reduceMotion

    static func width(in container: CGFloat) -> CGFloat {
        min(360, (container * 0.85).rounded(.down))
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                if isOpen {
                    Color.black.opacity(0.32)
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture(perform: onClose)
                        .accessibilityHidden(true)
                        .transition(.opacity)
                    drawer()
                        .frame(width: Self.width(in: proxy.size.width + proxy.safeAreaInsets.leading))
                        .frame(maxHeight: .infinity)
                        .simultaneousGesture(
                            DragGesture(minimumDistance: 20).onEnded { value in
                                let dx = value.translation.width
                                if dx < -60, abs(dx) > abs(value.translation.height) { onClose() }
                            }
                        )
                        .transition(reduceMotion ? .opacity : .move(edge: .leading))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
        .allowsHitTesting(isOpen)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth(duration: 0.3), value: isOpen)
    }
}
