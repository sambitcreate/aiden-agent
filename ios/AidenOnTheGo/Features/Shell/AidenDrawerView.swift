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
/// their own, over a search field that searches every chat and Bot. At
/// compact width it lies under the screen, which slides aside to show it; at
/// regular width it lays over the content (`AidenDrawerOverlay`).
struct AidenDrawerView<Compose: View>: View {
    /// The shell's, so the query and what it found outlive a fold and the
    /// drawer closing.
    let search: AidenSearchModel
    /// Draws a pinned Bot's avatar as the Bots list does, photo included.
    let coordinator: AidenRemoteCoordinator
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

    /// The concept's header: the name alone. The screen pushed aside is the
    /// close target (`AidenDrawerOverlay`), so there's no close button here.
    private var header: some View {
        Text("Aiden")
            .font(.title.bold())
            .accessibilityAddTraits(.isHeader)
            .accessibilityFocused($headingIsFocused)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, AidenSpacing.xl)
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
                            systemImage: "folder",
                            detail: item.isOnline ? nil : String(localized: "offline"),
                            botAvatar: item.botAvatar.map { ($0, item.pin.id.instanceId, item.pin.id.objectId) },
                            needsYou: item.needsYou
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
        /// A pinned Bot's avatar, its machine and its id.
        botAvatar: (avatar: AidenBotAvatarView, machine: String, botID: String)? = nil,
        needsYou: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: AidenSpacing.m) {
                Group {
                    if let botAvatar {
                        AidenBotCanonicalAvatarView(
                            coordinator: coordinator,
                            machine: botAvatar.machine,
                            botID: botAvatar.botID,
                            avatar: botAvatar.avatar,
                            name: title,
                            size: 24
                        )
                    } else {
                        Image(systemName: systemImage)
                            .foregroundStyle(palette.secondary)
                    }
                }
                .frame(width: 24)
                .accessibilityHidden(true)
                Text(title)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if needsYou {
                    Circle()
                        .fill(palette.accent)
                        .frame(width: 8, height: 8)
                        .accessibilityLabel("Needs you")
                }
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
            }
            .buttonStyle(AidenDrawerIconButtonStyle(fill: .raised))
            searchField
            // The style reaches the shell's own button, so its whole 44pt
            // square takes the tap, not only the glyph.
            compose()
                .buttonStyle(AidenDrawerIconButtonStyle(fill: .prominent))
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
                .frame(maxWidth: .infinity, minHeight: 44)
            if search.hasQuery {
                Button {
                    search.query = ""
                } label: {
                    Label("Clear search", systemImage: "xmark.circle.fill")
                        .labelStyle(.iconOnly)
                        .foregroundStyle(palette.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, -AidenSpacing.m)
            }
        }
        .padding(.horizontal, AidenSpacing.m)
        .frame(minHeight: 48)
        .background(palette.raised, in: Capsule())
        // The whole 44pt capsule focuses the field, and it's the frame
        // accessibility reports for it (the field alone is one line tall).
        .contentShape(Capsule())
        .onTapGesture { searchIsFocused = true }
    }
}

/// The drawer bar's round buttons (concept 03): Settings on the raised fill,
/// compose on the foreground colour. The whole circle takes the tap.
private struct AidenDrawerIconButtonStyle: ButtonStyle {
    enum Fill { case raised, prominent }
    let fill: Fill

    func makeBody(configuration: Configuration) -> some View {
        IconLabel(configuration: configuration, fill: fill)
    }

    private struct IconLabel: View {
        let configuration: Configuration
        let fill: Fill
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.aidenPalette) private var palette
        @Environment(\.aidenReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .labelStyle(.iconOnly)
                .font(.title3)
                .foregroundStyle(fill == .prominent ? palette.canvas : palette.foreground)
                .frame(width: 48, height: 48)
                .background(fill == .prominent ? palette.foreground : palette.raised, in: Circle())
                .contentShape(Circle())
                .opacity(isEnabled ? (configuration.isPressed ? 0.6 : 1) : 0.4)
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.94 : 1)
                .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: configuration.isPressed)
        }
    }
}

/// How far the drawer is open, shared by the screen it pushes aside and the
/// drawer itself, so the two move as one while a finger drags them.
@MainActor @Observable
final class AidenDrawerReveal {
    /// 0 shut, 1 open.
    var progress: CGFloat = 0
    /// A width and leading safe-area inset to size the column from
    /// (`AidenDrawerGeometry`).
    struct Space: Equatable {
        var width: CGFloat
        var leadingInset: CGFloat
    }
    /// The pushed screen's space, from the shell, used until the drawer is up.
    private(set) var screenSpace = Space(width: 0, leadingInset: 0)
    /// The drawer's own space while it's up. It wins: the closed iPhone Duo
    /// keeps a system rail at the trailing edge that the screen's safe area
    /// doesn't report but the drawer's cover spans, so only this one matches
    /// the column the drawer draws.
    private(set) var drawerSpace: Space?
    /// A finger on the screen's edge is opening it, so the drawer doesn't run
    /// its own slide in when it appears.
    var isTracking = false
    /// Counts each settle, so a close that finishes after the drawer was
    /// reopened doesn't put it away.
    @ObservationIgnored private var settleID = 0

    /// How far the pushed screen moves for the whole drawer, and so how far
    /// a finger drags to open or close it.
    var travel: CGFloat {
        let space = drawerSpace ?? screenSpace
        return AidenDrawerGeometry.travel(in: space.width, leadingInset: space.leadingInset)
    }

    /// Records the pushed screen's space.
    func measure(screen space: Space) {
        keepingTheScreenInPlace { screenSpace = space }
    }

    /// Records the drawer's own space, or forgets it as the drawer goes.
    func measure(drawer space: Space?) {
        keepingTheScreenInPlace { drawerSpace = space }
    }

    /// A new measurement changes `travel`, so a part-open drawer (a finger
    /// dragging, or one that came up mid-swipe) takes the progress that keeps
    /// the screen where it is, rather than jumping. Shut stays shut and open
    /// stays open, at the new width.
    private func keepingTheScreenInPlace(_ change: () -> Void) {
        let before = travel
        change()
        let after = travel
        guard progress > 0, progress < 1, before > 0, after > 0, before != after else { return }
        progress = min(1, progress * before / after)
    }

    static func motion(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : .smooth(duration: 0.32)
    }

    /// Slides it open or shut, then runs `completion`, unless another settle
    /// started in the meantime.
    func settle(open: Bool, reduceMotion: Bool, completion: @escaping () -> Void = {}) {
        settleID += 1
        let id = settleID
        withAnimation(Self.motion(reduceMotion: reduceMotion)) {
            progress = open ? 1 : 0
        } completion: { [weak self] in
            guard let self, self.settleID == id else { return }
            completion()
        }
    }
}

/// Moves the screen aside for the drawer at compact width: it slides toward
/// the trailing edge by the drawer's width, its corners rounded like the
/// concept's card, and the shell records the window's width for both. Off
/// (beside the list, or Reduce Motion) it stays in place.
struct AidenDrawerPush: ViewModifier {
    let reveal: AidenDrawerReveal
    let isEnabled: Bool
    @Environment(\.aidenReduceMotion) private var reduceMotion

    static let cornerRadius: CGFloat = 40

    func body(content: Content) -> some View {
        let progress = isEnabled ? reveal.progress : 0
        let offset = AidenDrawerGeometry.contentOffset(
            progress: progress, travel: reveal.travel, reduceMotion: reduceMotion
        )
        content
            .onGeometryChange(for: AidenDrawerReveal.Space.self) { proxy in
                let insets = proxy.safeAreaInsets
                return .init(width: proxy.size.width + insets.leading + insets.trailing, leadingInset: insets.leading)
            } action: { space in
                reveal.measure(screen: space)
            }
            // Rounded only while it's moved; at rest nothing is clipped, so
            // what draws into the safe area keeps doing so.
            .mask {
                RoundedRectangle(cornerRadius: offset > 0 ? Self.cornerRadius : 0, style: .continuous)
                    .padding(offset > 0 ? 0 : -400)
                    .ignoresSafeArea()
            }
            .offset(x: offset)
    }
}

/// The drawer, presented by the shell as a clear full-screen cover so it's
/// modal. At compact width (`pushesContent`) the screen under the cover slides
/// aside (`AidenDrawerPush`) and the drawer shows in the space it leaves, as
/// if lying beneath it; the slice of the screen still in view closes it. At
/// regular width it lays over the content with a dimmed scrim. A drag toward
/// the leading edge or Escape closes it, and Reduce Motion fades it in place.
///
/// The cover comes and goes without the system's animation; the drawer runs
/// its own slide in when it appears and the shell slides it out before it
/// takes the cover away (`close`).
struct AidenDrawerOverlay<Drawer: View>: View {
    let reveal: AidenDrawerReveal
    let pushesContent: Bool
    /// Slides it shut, then takes the cover away.
    let close: () -> Void
    @ViewBuilder let drawer: () -> Drawer

    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenPalette) private var palette
    @Environment(\.layoutDirection) private var layoutDirection
    /// A drag's direction, fixed by its first move: only a sideways drag moves the drawer.
    @State private var dragIsSideways: Bool?

    /// Whether the screen slides aside, not only the drawer.
    private var slides: Bool { pushesContent && !reduceMotion }

    var body: some View {
        GeometryReader { proxy in
            let inset = proxy.safeAreaInsets.leading
            let container = proxy.size.width + inset + proxy.safeAreaInsets.trailing
            let width = AidenDrawerGeometry.width(in: container, leadingInset: inset)
            let travel = AidenDrawerGeometry.travel(in: container, leadingInset: inset)
            let progress = reveal.progress
            // The part of the window the drawer shows in, from its leading
            // edge (the masks and the slice ignore the safe area, so they
            // measure from there; the drawer's column starts after the inset).
            let revealed = slides ? travel * progress : travel
            ZStack(alignment: .leading) {
                if !slides {
                    palette.scrim
                        .opacity(progress)
                        .ignoresSafeArea()
                        .accessibilityHidden(true)
                }
                drawer()
                    .frame(width: width)
                    .frame(maxHeight: .infinity)
                    .offset(x: drawerOffset(progress: progress, width: width))
                    .opacity(reduceMotion ? progress : 1)
                    .mask(alignment: .leading) {
                        Rectangle()
                            .frame(width: max(0, revealed))
                            .ignoresSafeArea()
                    }
                if slides {
                    // The pushed screen's shadow across the drawer's edge.
                    LinearGradient(
                        colors: [.clear, .black.opacity(0.10)],
                        startPoint: .leading, endPoint: .trailing
                    )
                    .frame(width: 18)
                    .offset(x: revealed - 18)
                    .opacity(progress)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
                closeTarget
                    .frame(width: max(0, container - revealed))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                    .ignoresSafeArea()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .simultaneousGesture(dragToClose(travel: travel))
        }
        // The screen under the cover moves by the same travel as this column.
        .onGeometryChange(for: AidenDrawerReveal.Space.self) { proxy in
            let insets = proxy.safeAreaInsets
            return .init(width: proxy.size.width + insets.leading + insets.trailing, leadingInset: insets.leading)
        } action: { space in
            reveal.measure(drawer: space)
        }
        .onDisappear { reveal.measure(drawer: nil) }
        .onAppear {
            guard !reveal.isTracking, reveal.progress < 1 else { return }
            reveal.settle(open: true, reduceMotion: reduceMotion)
        }
    }

    /// The pushed screen's slice, or the scrim: a tap puts the drawer away.
    private var closeTarget: some View {
        Button(action: close) {
            Color.clear.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close menu")
        .accessibilityIdentifier("aiden.drawer.close")
        // A hardware keyboard's Escape.
        .keyboardShortcut(.cancelAction)
    }

    private func drawerOffset(progress: CGFloat, width: CGFloat) -> CGFloat {
        if reduceMotion { return 0 }
        if slides { return AidenDrawerGeometry.drawerOffset(progress: progress, width: width, reduceMotion: false) }
        // Over the content it slides in whole from the leading edge.
        return -(1 - progress) * width
    }

    /// The drawer follows a sideways drag and settles by where it's let go
    /// and how fast. Global coordinates, so the drawer moving under the
    /// finger doesn't change the drag's own measure.
    private func dragToClose(travel: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { value in
                if dragIsSideways == nil {
                    dragIsSideways = abs(value.translation.width) > abs(value.translation.height)
                }
                guard dragIsSideways == true else { return }
                reveal.progress = AidenDrawerGeometry.progress(
                    start: 1, translation: value.translation.width, width: travel,
                    rightToLeft: layoutDirection == .rightToLeft
                )
            }
            .onEnded { value in
                defer { dragIsSideways = nil }
                guard dragIsSideways == true else { return }
                if AidenDrawerGeometry.settlesOpen(
                    progress: reveal.progress, velocity: value.velocity.width, width: travel,
                    rightToLeft: layoutDirection == .rightToLeft
                ) {
                    reveal.settle(open: true, reduceMotion: reduceMotion)
                } else {
                    close()
                }
            }
    }
}

/// The system's swipe in from the leading screen edge, which opens the
/// drawer. A screen-edge recogniser, not an invisible strip over the content,
/// so a tap at the edge and a row's leading swipe that starts inside the
/// screen still reach what's under them. Off (`isEnabled`), it never begins,
/// so a pushed screen's own Back swipe keeps the edge. The drawer follows the
/// finger, and where and how fast it's let go decides whether it stays open.
struct AidenDrawerEdgeSwipe: UIGestureRecognizerRepresentable {
    /// A swipe's travel and speed, in points on the screen (not mirrored for
    /// a right-to-left language).
    struct Movement {
        var translation: CGFloat
        var velocity: CGFloat
    }

    let isEnabled: Bool
    /// The leading edge, on the screen.
    let layoutDirection: LayoutDirection
    let onBegan: () -> Void
    let onChanged: (Movement) -> Void
    /// Nil when the system cancelled the swipe.
    let onEnded: (Movement?) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIScreenEdgePanGestureRecognizer {
        let recognizer = UIScreenEdgePanGestureRecognizer()
        recognizer.edges = layoutDirection == .rightToLeft ? .right : .left
        recognizer.delegate = context.coordinator
        context.coordinator.isEnabled = isEnabled
        context.coordinator.isRightToLeft = layoutDirection == .rightToLeft
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        // The layout direction can change while the shell is alive.
        recognizer.edges = layoutDirection == .rightToLeft ? .right : .left
        context.coordinator.isEnabled = isEnabled
        context.coordinator.isRightToLeft = layoutDirection == .rightToLeft
    }

    /// How far in from the leading screen edge a touch may begin and still
    /// open the drawer. A swipe that begins further in belongs to what's under
    /// it, such as a row's leading swipe actions, whatever its speed.
    static let edgeBand: CGFloat = 10

    /// Whether a touch at `x` in a window `width` wide begins in the band.
    static func beginsInEdgeBand(x: CGFloat, width: CGFloat, rightToLeft: Bool) -> Bool {
        let fromEdge = rightToLeft ? width - x : x
        return fromEdge >= 0 && fromEdge <= edgeBand
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        // The window's space: the shell's view slides with the drawer, so its
        // own space would move under the finger.
        let space = recognizer.view?.window
        let movement = Movement(
            translation: recognizer.translation(in: space).x,
            velocity: recognizer.velocity(in: space).x
        )
        switch recognizer.state {
        case .began: onBegan(); onChanged(movement)
        case .changed: onChanged(movement)
        case .ended: onEnded(movement)
        case .cancelled, .failed: onEnded(nil)
        default: break
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var isEnabled = false
        var isRightToLeft = false
        /// Where the touch began, in its window.
        private var start: (x: CGFloat, width: CGFloat)?

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            if let window = touch.window {
                start = (touch.location(in: window).x, window.bounds.width)
            }
            return true
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard isEnabled, let start else { return false }
            return AidenDrawerEdgeSwipe.beginsInEdgeBand(x: start.x, width: start.width, rightToLeft: isRightToLeft)
        }
    }
}
