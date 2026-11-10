import SwiftUI

private let aidenWorkspaceSidebarPreviewLimit = 20

enum AidenRelativeTimestamp {
    static func text(for date: Date, now: Date = Date()) -> String {
        let elapsed = max(0, now.timeIntervalSince(date))
        if elapsed < 60 { return "just now" }

        let minutes = Int(elapsed / 60)
        if minutes < 60 { return minutes == 1 ? "1 min ago" : "\(minutes) mins ago" }

        let hours = Int(elapsed / 3_600)
        if hours < 24 { return hours == 1 ? "1 hr ago" : "\(hours) hrs ago" }

        let days = Int(elapsed / 86_400)
        return days == 1 ? "1 day ago" : "\(days) days ago"
    }
}

struct AidenRelativeTimestampView: View {
    let date: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(AidenRelativeTimestamp.text(for: date, now: context.date))
        }
    }
}

private struct AidenLiquidGlassCapsuleModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let tint: Color

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(tint, in: Capsule())
        } else {
            content.glassEffect(.regular.tint(tint).interactive(), in: Capsule())
        }
    }
}

private struct AidenProminentGlassButtonModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .buttonStyle(.plain)
                .background(palette.raised, in: Capsule())
                .overlay(Capsule().stroke(palette.foreground.opacity(0.16), lineWidth: 0.5))
        } else {
            content.buttonStyle(.glass)
        }
    }
}

extension View {
    func aidenLiquidGlassCapsule(tint: Color) -> some View {
        modifier(AidenLiquidGlassCapsuleModifier(tint: tint))
    }

    func aidenProminentGlassButton() -> some View {
        modifier(AidenProminentGlassButtonModifier())
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

/// A quiet one-line connection status in place of a modal overlay.
struct AidenConnectingHint: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let installationName: String?
    @State private var dimmed = false

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(palette.accent)
                .frame(width: 7, height: 7)
                .opacity(dimmed ? 0.35 : 1)
            Text(installationName.map { "Connecting to \($0)…" } ?? String(localized: "Connecting to Aiden Agent…"))
                .lineLimit(1)
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(palette.secondary)
        .frame(maxWidth: .infinity, minHeight: 28)
        .accessibilityElement(children: .combine)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dimmed = true }
        }
    }
}

private struct AidenNavigationResolutionID: Equatable {
    let request: AidenNavigationRequest?
    let connectionState: AidenRemoteConnectionState
}

private struct AidenHomeLoadID: Equatable {
    let instanceID: String?
    let connectionState: AidenRemoteConnectionState
}

private struct AidenUnlistedChatWorkspacesID: Equatable {
    let instanceID: String?
    let connectionState: AidenRemoteConnectionState
    let workspaceIDs: Set<String>
}

enum AidenWorkspaceNavigation {
    /// Workspaces split view can select. A hidden No workspace record has no page of its own, so
    /// only the Chats group's home is selectable, and only while one of its chats is open.
    static func selectableIDs(_ workspaces: [AidenWorkspace], openChatWorkspaceID: String?) -> [String] {
        let openGroupID = openChatWorkspaceID.map { AidenNoWorkspace.groupID(for: $0, in: workspaces) }
        return workspaces.filter { !$0.noWorkspace || $0.id == openGroupID }.map(\.id)
    }

    static func reconciledSelection(current: String?, workspaceIDs: [String]) -> String? {
        guard !workspaceIDs.isEmpty else { return nil }
        if let current, workspaceIDs.contains(current) { return current }
        return workspaceIDs.first
    }

    static func reconciledCompactPath(current: [String], workspaceIDs: [String]) -> [String] {
        guard let workspaceID = current.last, workspaceIDs.contains(workspaceID) else { return [] }
        return [workspaceID]
    }

    static func compactPath(
        enteringFromSplit: Bool,
        current: [String],
        selectedWorkspaceID: String?,
        workspaceIDs: [String],
        preservingSelectedChat: Bool = false
    ) -> [String] {
        if preservingSelectedChat { return [] }
        let current = reconciledCompactPath(current: current, workspaceIDs: workspaceIDs)
        if !current.isEmpty { return current }
        guard enteringFromSplit,
              let selectedWorkspaceID,
              workspaceIDs.contains(selectedWorkspaceID) else { return [] }
        return [selectedWorkspaceID]
    }
}

enum AidenWorkspaceSidebarOrganization: String, Codable, Equatable {
    case workspace
    case recent
    /// Beta: Needs you, Pinned, Updates and Earlier, with the Working shelf.
    case inbox

    /// The sidebar header's title for this organization.
    var title: String {
        switch self {
        case .workspace: String(localized: "Workspaces")
        case .recent: String(localized: "Recents")
        case .inbox: String(localized: "Inbox")
        }
    }

    /// Whether the header carries the Beta badge.
    var isBeta: Bool { self == .inbox }
}

struct AidenWorkspaceSidebarSection: Identifiable, Equatable {
    let workspace: AidenWorkspace
    let chats: [AidenChatSummary]
    let newestActivityAt: Date

    var id: String { workspace.id }
}

struct AidenWorkspaceSidebarProjection: Equatable {
    let sections: [AidenWorkspaceSidebarSection]
    let recents: [AidenChatSummary]

    static func make(
        workspaces: [AidenWorkspace],
        chats: [AidenChatSummary],
        searchText: String
    ) -> Self {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let workspaceByID = Dictionary(uniqueKeysWithValues: workspaces.map { ($0.id, $0) })
        let regularChats = chats
            .filter { workspaceByID[$0.workspaceId] != nil }
            .sorted { left, right in
                left.updatedAt == right.updatedAt ? left.id < right.id : left.updatedAt > right.updatedAt
            }
        // Workspace and Recent views stay in recency order.
        let chatsByWorkspace = Dictionary(grouping: regularChats) { chat in
            AidenNoWorkspace.groupID(for: chat.workspaceId, in: workspaces)
        }
        let sections = AidenNoWorkspace.grouped(workspaces).compactMap { workspace -> AidenWorkspaceSidebarSection? in
            let allChats = chatsByWorkspace[workspace.id] ?? []
            let workspaceMatches = !query.isEmpty && workspace.name.localizedCaseInsensitiveContains(query)
            let visibleChats = query.isEmpty || workspaceMatches
                ? allChats
                : allChats.filter { $0.title.localizedCaseInsensitiveContains(query) }
            guard query.isEmpty || workspaceMatches || !visibleChats.isEmpty else { return nil }
            return AidenWorkspaceSidebarSection(
                workspace: workspace,
                chats: visibleChats,
                newestActivityAt: max(workspace.updatedAt, allChats.map(\.updatedAt).max() ?? .distantPast)
            )
        }
        .sorted { left, right in
            if left.newestActivityAt != right.newestActivityAt {
                return left.newestActivityAt > right.newestActivityAt
            }
            if left.workspace.name != right.workspace.name {
                return left.workspace.name.localizedStandardCompare(right.workspace.name) == .orderedAscending
            }
            return left.workspace.id < right.workspace.id
        }
        let recents = regularChats.filter { chat in
            guard !query.isEmpty else { return true }
            return chat.title.localizedCaseInsensitiveContains(query)
                || workspaceByID[chat.workspaceId].map { AidenNoWorkspace.label(for: $0) }?
                    .localizedCaseInsensitiveContains(query) == true
        }
        return Self(sections: sections, recents: recents)
    }

    static func make(
        workspaces: [AidenWorkspace],
        chats: [AidenChat],
        searchText: String
    ) -> Self {
        make(
            workspaces: workspaces,
            chats: AidenChat.regularWorkspaceChats(from: chats).map { AidenChatSummary(chat: $0) },
            searchText: searchText
        )
    }
}

/// What restarts the Inbox banner's timer: a new banner, or VoiceOver
/// turning on or off while it shows.
private struct InboxNoticeTiming: Hashable {
    let id: UUID
    let voiceOver: Bool
}

struct AidenWorkspaceDefaultApplication {
    /// Where this phone keeps the permission a new workspace starts with.
    static let permissionKey = "aiden.defaults.workspacePermission"

    let workspace: AidenWorkspace
    let feedback: AidenHapticEvent

    /// The workspace back with `permission`, or as it was when `update` returns nil.
    @MainActor
    static func applying(
        _ permission: AidenWorkspacePermission,
        to workspace: AidenWorkspace,
        update: (AidenWorkspacePermission) async -> AidenWorkspace?
    ) async -> AidenWorkspaceDefaultApplication {
        guard permission != workspace.permission else {
            return AidenWorkspaceDefaultApplication(workspace: workspace, feedback: .success)
        }
        guard let updated = await update(permission) else {
            return AidenWorkspaceDefaultApplication(workspace: workspace, feedback: .warning)
        }
        return AidenWorkspaceDefaultApplication(workspace: updated, feedback: .success)
    }
}

struct AidenWorkspaceShellView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Binding private var navigationRequest: AidenNavigationRequest?
    let productArea: AidenProductArea
    let botsAvailability: AidenBotsAvailability
    let navigationStore: AidenProductNavigationStore
    let onSelectProductArea: (AidenProductArea) -> Void
    @Environment(AidenAppearanceStore.self) private var appearance
    @Environment(\.aidenPalette) private var palette
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var isShowingPairing = false
    /// Hidden workspace ids this phone already re-read the workspace list for, per Mac.
    @State private var workspaceReReads: [String: Set<String>] = [:]
    @State private var isShowingAppSettings = false
    @State private var isShowingScheduledTasks = false
    @State private var isShowingUsage = false
    @State private var selectedSidebarChat: AidenChat?
    @State private var selectedSidebarChatStartsVoice = false
    /// A chat under Chats waiting on the Delete confirmation. Those chats have no
    /// workspace page, so their sidebar row carries the Delete action.
    @State private var chatPendingDelete: AidenChatSummary?
    @State private var sidebarChatNavigationTask: Task<Void, Never>?
    @State private var sidebarChatNavigationRequestID: UUID?
    @State private var homeModel = AidenHomeModel()
    @State private var fullyRevealedSidebarWorkspaceIDs: Set<String> = []
    @State private var showsAllInboxEarlier = false
    @State private var inboxClock = Date()
    @State private var snoozeCandidate: AidenChatSummary?
    @State private var searchText = ""
    @State private var isSearching = false
    @State private var isShowingNewAgentChoices = false
    @State private var isShowingExistingWorkspacePicker = false
    @State private var isShowingNewAgentWorkspacePrompt = false
    @State private var newAgentWorkspaceName = ""
    @State private var isCreatingAgent = false
    @State private var agentCreationStatus = ""
    @State private var showsConnectingHint = false
    @State private var hapticScope = UUID()
    @FocusState private var searchFieldIsFocused: Bool
    @Namespace private var newAgentTransition
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @AppStorage(AidenWorkspaceDefaultApplication.permissionKey) private var defaultWorkspacePermissionRaw = AidenWorkspacePermission.ask.rawValue

    init(
        coordinator: AidenRemoteCoordinator,
        navigationRequest: Binding<AidenNavigationRequest?> = .constant(nil),
        productArea: AidenProductArea = .workspaces,
        botsAvailability: AidenBotsAvailability = .unsupported,
        navigationStore: AidenProductNavigationStore = .shared,
        onSelectProductArea: @escaping (AidenProductArea) -> Void = { _ in }
    ) {
        self.coordinator = coordinator
        _navigationRequest = navigationRequest
        self.productArea = productArea
        self.botsAvailability = botsAvailability
        self.navigationStore = navigationStore
        self.onSelectProductArea = onSelectProductArea
    }

    private var selectedWorkspaceId: String? {
        get { navigationStore.selectedWorkspace(for: coordinator.activeInstanceId) }
        nonmutating set {
            navigationStore.setSelectedWorkspace(newValue, for: coordinator.activeInstanceId)
        }
    }

    private var compactWorkspacePath: [String] {
        get { navigationStore.compactWorkspacePath(for: coordinator.activeInstanceId) }
        nonmutating set {
            navigationStore.setCompactWorkspacePath(newValue, for: coordinator.activeInstanceId)
        }
    }

    private var compactWorkspacePathBinding: Binding<[String]> {
        Binding(get: { compactWorkspacePath }, set: { compactWorkspacePath = $0 })
    }

    private var usesSplitNavigation: Bool {
        horizontalSizeClass == .regular
    }

    private var archivedWorkspaceIDs: Set<String> {
        workspaceArchiveStore.archivedWorkspaceIDs(for: coordinator.activeInstanceId)
    }

    private var workspaceArchiveStore: AidenWorkspaceArchiveStore {
        coordinator.workspaceArchiveStore
    }

    private var activeWorkspaces: [AidenWorkspace] {
        AidenNoWorkspace.unarchived(coordinator.workspaces, archivedIDs: archivedWorkspaceIDs)
    }

    private var activeWorkspaceIDs: [String] {
        activeWorkspaces.map(\.id)
    }

    private var sidebarOrganization: AidenWorkspaceSidebarOrganization {
        navigationStore.workspaceSidebarOrganization(for: coordinator.activeInstanceId)
    }

    private var expandedSidebarWorkspaceIDs: Set<String> {
        navigationStore.expandedSidebarWorkspaceIDs(for: coordinator.activeInstanceId)
    }

    private var unlistedChatWorkspacesID: AidenUnlistedChatWorkspacesID {
        let instanceID = coordinator.activeInstanceId
        return AidenUnlistedChatWorkspacesID(
            instanceID: instanceID,
            connectionState: coordinator.connectionState,
            workspaceIDs: AidenNoWorkspace.unlistedWorkspaceIDs(
                chatWorkspaceIDs: homeModel.chats.map(\.workspaceId),
                in: coordinator.workspaces,
                alreadyReRead: instanceID.flatMap { workspaceReReads[$0] } ?? []
            )
        )
    }

    /// A chat another device started without a workspace sits in a hidden record this phone
    /// hasn't listed, so the sidebar would leave it out. Re-read the workspace list once for it.
    private func reReadWorkspacesForUnlistedChats() {
        let id = unlistedChatWorkspacesID
        guard let instanceID = id.instanceID, id.connectionState == .connected, !id.workspaceIDs.isEmpty else { return }
        workspaceReReads[instanceID, default: []].formUnion(id.workspaceIDs)
        // Marking the ids changes this view's task identity, which cancels the `.task(id:)` that
        // called us. The read runs in its own task so that cancellation never drops it.
        Task { await coordinator.refreshWorkspaces() }
    }

    private var sidebarProjection: AidenWorkspaceSidebarProjection {
        AidenWorkspaceSidebarProjection.make(
            workspaces: activeWorkspaces,
            chats: homeModel.chats,
            searchText: searchText
        )
    }

    private var inboxProjection: AidenInboxProjection {
        AidenInboxProjection.make(
            chats: homeModel.chats,
            workspaceNames: Dictionary(activeWorkspaces.map { ($0.id, AidenNoWorkspace.label(for: $0)) }, uniquingKeysWith: { first, _ in first }),
            openChatID: selectedSidebarChat?.id,
            now: inboxClock,
            searchText: searchText,
            showAllEarlier: showsAllInboxEarlier
        )
    }

    private var sidebarOrganizationTitle: String { sidebarOrganization.title }

    /// The row's swipes: Mark read needs `chat-read-state-v1`; Done and
    /// Snooze need `chat-triage-v1`, chat:write and the desktop's offer rules.
    private func inboxOffer(_ chat: AidenChatSummary) -> AidenInboxRowOffer {
        AidenInbox.rowOffer(
            for: chat,
            isOpen: chat.id == selectedSidebarChat?.id,
            now: inboxClock,
            supportsReadState: coordinator.server?.supportsChatReadState == true,
            supportsTriage: coordinator.server?.supportsChatTriage == true
                && coordinator.installationStore.activeInstallation?.hasNegotiatedAccess(to: .chatWrite) == true
        )
    }

    private func snooze(_ chat: AidenChatSummary, until date: Date) {
        let isOpen = chat.id == selectedSidebarChat?.id
        Task { await homeModel.setTriage(.snooze(until: date), chatID: chat.id, coordinator: coordinator, isOpen: isOpen) }
    }

    private func markRead(_ chat: AidenChatSummary) {
        Task { await homeModel.markRead(chatID: chat.id, coordinator: coordinator) }
    }

    private var recentsPresentation: AidenReadPresentation {
        let hasRows = searchText.isEmpty
            ? !sidebarProjection.recents.isEmpty
            : !AidenWorkspaceSidebarProjection.make(
                workspaces: activeWorkspaces,
                chats: homeModel.chats,
                searchText: ""
            ).recents.isEmpty
        return aidenHomeChatListPresentation(
            hasRows: hasRows,
            connectionState: coordinator.connectionState,
            loadState: homeModel.chatListLoadState
        )
    }

    private var workspaceListPresentation: AidenReadPresentation {
        aidenHomeWorkspaceListPresentation(
            hasWorkspaces: !activeWorkspaces.isEmpty,
            connectionState: coordinator.connectionState
        )
    }

    /// A refresh that failed over saved rows: say so above them, keep them.
    private var chatRefreshErrorRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                .foregroundStyle(palette.warning)
            Text("Couldn’t refresh chats.")
                .foregroundStyle(palette.secondary)
            Spacer(minLength: 8)
            Button("Try Again") {
                Task { await homeModel.load(coordinator: coordinator) }
            }
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

    private var unreachableListState: some View {
        ContentUnavailableView {
            Label("Can’t reach your machine", systemImage: "wifi.slash")
        } description: {
            Text("Saved chats appear here after this iPhone has connected once.")
        } actions: {
            Button("Try Again") {
                Task { await coordinator.connectActiveInstallation() }
            }
        }
    }

    private var chatListUnavailable: Bool {
        if case .failed = homeModel.chatListLoadState { return true }
        return false
    }

    private var chatCreationBlocked: Bool {
        homeModel.chatListLoadState != .loaded
    }

    /// New chat stays available while the Mac is connecting: the tap waits
    /// for the connection (see `awaitChatCreationReady`) instead of failing.
    private var newChatUnavailable: Bool {
        if coordinator.isMutating || isCreatingAgent { return true }
        switch coordinator.connectionState {
        case .connecting: return false
        case .connected: return chatListUnavailable
        case .offline, .needsPairing: return true
        }
    }

    /// Holds a New chat tapped before the Mac is ready, then lets it continue.
    /// Returns false when the connection or the chat list fails meanwhile.
    @MainActor
    private func awaitChatCreationReady() async -> Bool {
        if coordinator.connectionState == .connected, !chatCreationBlocked { return true }
        let resumedStatus = agentCreationStatus
        agentCreationStatus = String(localized: "Waiting for your machine…")
        defer { agentCreationStatus = resumedStatus }
        let deadline = ContinuousClock.now + .seconds(30)
        while ContinuousClock.now < deadline, !Task.isCancelled {
            switch coordinator.connectionState {
            case .connected:
                if !chatCreationBlocked { return true }
                if case .failed = homeModel.chatListLoadState { return false }
            case .connecting:
                break
            case .offline, .needsPairing:
                return false
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return false
    }

    @MainActor
    private func reportChatCreationUnavailable() {
        if case .offline = coordinator.connectionState {
            coordinator.presentedError = String(localized: "Your machine isn’t reachable right now. Try again once it’s connected.")
        } else {
            coordinator.presentedError = homeModel.chatLoadErrorMessage
                ?? String(localized: "Chats are unavailable. Try loading them again first.")
        }
        coordinator.haptics.play(.error, scope: hapticScope)
    }

    var body: some View {
        Group {
            if usesSplitNavigation {
                NavigationSplitView {
                    regularWorkspaceSidebar
                        .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 400)
                } detail: {
                    NavigationStack {
                        if let selectedSidebarChat {
                            AidenForkableChatDetailView(
                                coordinator: coordinator,
                                chat: selectedSidebarChat,
                                autoStartVoice: selectedSidebarChatStartsVoice,
                                onChatUpdated: acceptSelectedChatUpdate,
                                onChatActivityChanged: { chatID, activity in
                                    homeModel.setActivity(activity, forChatID: chatID)
                                },
                                onForkOpened: acceptOpenedFork
                            )
                            .id(selectedSidebarChat.id)
                        } else {
                            workspaceDetail(workspaceID: selectedWorkspaceId)
                        }
                    }
                }
                .navigationSplitViewStyle(.balanced)
            } else {
                NavigationStack(path: compactWorkspacePathBinding) {
                    compactWorkspaceSidebar
                        .navigationDestination(for: String.self) { workspaceID in
                            workspaceDetail(workspaceID: workspaceID)
                        }
                        .navigationDestination(
                            isPresented: Binding(
                                get: { selectedSidebarChat != nil },
                                set: { if !$0 { clearSelectedSidebarChat() } }
                            )
                        ) {
                            if let selectedSidebarChat {
                                AidenForkableChatDetailView(
                                    coordinator: coordinator,
                                    chat: selectedSidebarChat,
                                    autoStartVoice: selectedSidebarChatStartsVoice,
                                    onChatUpdated: acceptSelectedChatUpdate,
                                    onChatActivityChanged: { chatID, activity in
                                        homeModel.setActivity(activity, forChatID: chatID)
                                    },
                                    onForkOpened: acceptOpenedFork
                                )
                                .id(selectedSidebarChat.id)
                            }
                        }
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if case .offline(let message) = coordinator.connectionState {
                AidenOfflineBanner(message: message) {
                    Task { await coordinator.connectActiveInstallation() }
                }
            } else if showsConnectingHint {
                AidenConnectingHint(installationName: coordinator.installationStore.activeInstallation?.name)
            }
        }
        .task(id: coordinator.connectionState) {
            // Fast reconnects finish before the hint would only flash.
            showsConnectingHint = false
            guard coordinator.connectionState == .connecting else { return }
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            showsConnectingHint = coordinator.connectionState == .connecting
        }
        .overlay {
            if isCreatingAgent {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text(agentCreationStatus)
                }
                .font(.callout.weight(.medium))
                .padding(.horizontal, 16)
                .frame(height: 48)
                .foregroundStyle(palette.canvas)
                .aidenLiquidGlassCapsule(tint: palette.foreground)
                .accessibilityElement(children: .combine)
            }
        }
        .sheet(isPresented: $isShowingPairing) {
            AidenPairingView(
                coordinator: coordinator,
                onPaired: { isShowingPairing = false }
            )
        }
        .sheet(isPresented: $isShowingAppSettings) {
            AidenAppSettingsView(
                coordinator: coordinator,
                appearance: appearance,
                addInstallation: {
                    isShowingAppSettings = false
                    isShowingPairing = true
                }
            )
        }
        .sheet(isPresented: $isShowingScheduledTasks) {
            AidenScheduledTasksView(coordinator: coordinator)
        }
        .sheet(isPresented: $isShowingUsage) {
            Group {
                if let usage = homeModel.usage {
                    AidenUsageView(usage: usage, providers: homeModel.modelCatalog?.providers ?? [])
                } else {
                    AidenUsagePendingView(
                        isOffline: {
                            if case .offline = coordinator.connectionState { return true }
                            return false
                        }(),
                        failed: homeModel.usageLoadFailed,
                        retry: { Task { await homeModel.load(coordinator: coordinator) } }
                    )
                }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $isShowingExistingWorkspacePicker) {
            NavigationStack {
                List(AidenNoWorkspace.choices(activeWorkspaces)) { workspace in
                    Button {
                        isShowingExistingWorkspacePicker = false
                        Task { await createNewAgent(in: workspace) }
                    } label: {
                        AidenWorkspaceRow(workspace: workspace)
                    }
                    .buttonStyle(.plain)
                }
                .navigationTitle("Choose Workspace")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { isShowingExistingWorkspacePicker = false }
                    }
                }
            }
        }
        .alert(
            "Aiden On The Go",
            isPresented: Binding(
                get: { coordinator.presentedError != nil },
                set: { if !$0 { coordinator.presentedError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { coordinator.presentedError = nil }
        } message: {
            Text(coordinator.presentedError ?? "The operation could not be completed.")
        }
        .alert("New Workspace", isPresented: $isShowingNewAgentWorkspacePrompt) {
            TextField("Workspace name", text: $newAgentWorkspaceName)
            Button("Cancel", role: .cancel) { newAgentWorkspaceName = "" }
            Button("Create") {
                let name = newAgentWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines)
                newAgentWorkspaceName = ""
                Task { await createNewAgent(inNewWorkspaceNamed: name) }
            }
            .disabled(newAgentWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("Aiden will create a reusable workspace, then open a new chat in it.")
        }
        .onChange(of: coordinator.workspaces.map(\.id)) { _, _ in
            syncArchivedWorkspaceProjection()
            reconcileNavigation(workspaceIDs: activeWorkspaceIDs)
        }
        .onChange(of: coordinator.workspaceSnapshotRevision) { _, _ in
            syncArchivedWorkspaceProjection()
            reconcileNavigation(workspaceIDs: activeWorkspaceIDs)
            navigationStore.pruneExpandedSidebarWorkspaces(
                validWorkspaceIDs: Set(activeWorkspaceIDs),
                for: coordinator.activeInstanceId
            )
        }
        .onChange(of: archivedWorkspaceIDs) { _, _ in
            syncArchivedWorkspaceProjection()
            reconcileNavigation(workspaceIDs: activeWorkspaceIDs)
            navigationStore.pruneExpandedSidebarWorkspaces(
                validWorkspaceIDs: Set(activeWorkspaceIDs),
                for: coordinator.activeInstanceId
            )
        }
        .onChange(of: selectedSidebarChat?.workspaceId) { _, workspaceID in
            // The Chats home is selectable only while one of its chats is open, so closing that
            // chat hands the split view back to a workspace that has a page.
            if workspaceID == nil { reconcileNavigation(workspaceIDs: activeWorkspaceIDs) }
        }
        .onChange(of: coordinator.activeInstanceId) { _, _ in
            cancelPendingSidebarChatNavigation()
            isShowingScheduledTasks = false
            clearSelectedSidebarChat()
            fullyRevealedSidebarWorkspaceIDs = []
            syncArchivedWorkspaceProjection()
            if coordinator.connectionState == .connected {
                reconcileNavigation(workspaceIDs: activeWorkspaceIDs)
            }
        }
        .onChange(of: compactWorkspacePath) { _, path in
            guard let workspaceID = path.last,
                  activeWorkspaceIDs.contains(workspaceID) else { return }
            selectedWorkspaceId = workspaceID
        }
        .onChange(of: usesSplitNavigation) { wasSplit, isSplit in
            let workspaceIDs = activeWorkspaceIDs
            if isSplit {
                if let compactWorkspaceID = compactWorkspacePath.last,
                   workspaceIDs.contains(compactWorkspaceID) {
                    selectedWorkspaceId = compactWorkspaceID
                }
            } else {
                compactWorkspacePath = AidenWorkspaceNavigation.compactPath(
                    enteringFromSplit: wasSplit,
                    current: compactWorkspacePath,
                    selectedWorkspaceID: selectedWorkspaceId,
                    workspaceIDs: workspaceIDs,
                    preservingSelectedChat: selectedSidebarChat != nil
                )
            }
        }
        .task {
            syncArchivedWorkspaceProjection()
            reconcileNavigation(workspaceIDs: activeWorkspaceIDs)
            navigationStore.ensureExpandedSidebarWorkspace(
                selectedWorkspaceId,
                for: coordinator.activeInstanceId
            )
            if coordinator.connectionState == .connected {
                navigationStore.pruneExpandedSidebarWorkspaces(
                    validWorkspaceIDs: Set(activeWorkspaceIDs),
                    for: coordinator.activeInstanceId
                )
            }
        }
        .task(id: AidenNavigationResolutionID(
            request: navigationRequest,
            connectionState: coordinator.connectionState
        )) {
            await resolveNavigationRequest()
        }
        .task(id: AidenHomeLoadID(
            instanceID: coordinator.activeInstanceId,
            connectionState: coordinator.connectionState
        )) {
            await homeModel.load(coordinator: coordinator)
        }
        .task(id: unlistedChatWorkspacesID) {
            reReadWorkspacesForUnlistedChats()
        }
        .onAppear { coordinator.haptics.activate(scope: hapticScope) }
        .onDisappear {
            cancelPendingSidebarChatNavigation()
            coordinator.haptics.deactivate(scope: hapticScope)
        }
    }

    private var regularWorkspaceSidebar: some View {
        ZStack(alignment: .bottomTrailing) {
            homeList { workspace in
                Button {
                    navigate(to: workspace.id)
                } label: {
                    Image(systemName: "arrow.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                        .frame(width: 36, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(workspace.name)")
            } chatRow: { chat in
                Button { openChat(chat) } label: {
                    homeChatRow(chat, showsWorkspace: sidebarOrganization == .recent)
                }
                    .buttonStyle(.plain)
            }
            if !isSearching {
                newAgentButton
                    .padding(.trailing, 24)
                    .padding(.bottom, 22)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.smooth(duration: 0.24, extraBounce: 0), value: isSearching)
    }

    private var compactWorkspaceSidebar: some View {
        ZStack(alignment: .bottomTrailing) {
            homeList { workspace in
                NavigationLink(value: workspace.id) {
                    Image(systemName: "arrow.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                        .frame(width: 36, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(workspace.name)")
            } chatRow: { chat in
                Button { openChat(chat) } label: {
                    homeChatRow(
                        chat,
                        showsWorkspace: sidebarOrganization == .recent
                    )
                }
                .buttonStyle(.plain)
            }
            if !isSearching {
                newAgentButton
                    .padding(.trailing, 24)
                    .padding(.bottom, 22)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.smooth(duration: 0.24, extraBounce: 0), value: isSearching)
    }

    private func homeList<WorkspaceDestination: View, ChatRow: View>(
        @ViewBuilder workspaceDestination: @escaping (AidenWorkspace) -> WorkspaceDestination,
        @ViewBuilder chatRow: @escaping (AidenChatSummary) -> ChatRow
    ) -> some View {
        List {
            homeHeader
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 18, trailing: 0))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)

            if !isSearching {
                homeNavigationRows
                    .padding(.top, 10)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(palette.canvas)
            }

            HStack(spacing: 12) {
                Text(sidebarOrganizationTitle)
                    .font(.title3.bold())
                    .foregroundStyle(palette.foreground)
                if sidebarOrganization.isBeta {
                    AidenBetaBadge()
                }

                Spacer(minLength: 8)

                sidebarOrganizationMenu
            }
            .padding(.horizontal, 24)
            .padding(.top, isSearching ? 10 : 26)
            .padding(.bottom, 10)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(palette.canvas)

            if sidebarOrganization == .inbox {
                inboxListContent
            } else if sidebarOrganization == .workspace {
                if chatListUnavailable, workspaceListPresentation == .content {
                    chatRefreshErrorRow
                }
                switch workspaceListPresentation {
                case .content:
                    if sidebarProjection.sections.isEmpty {
                        ContentUnavailableView.search(text: searchText)
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                            .listRowBackground(palette.canvas)
                    } else {
                        ForEach(sidebarProjection.sections) { section in
                            let expanded = !searchText.isEmpty
                                || expandedSidebarWorkspaceIDs.contains(section.workspace.id)
                            let revealsAll = fullyRevealedSidebarWorkspaceIDs.contains(section.workspace.id)
                            let visibleChats = revealsAll
                                ? section.chats
                                : Array(section.chats.prefix(aidenWorkspaceSidebarPreviewLimit))
                            let remainingChatCount = section.chats.count - visibleChats.count
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 8) {
                                    Button {
                                        navigationStore.toggleExpandedSidebarWorkspace(
                                            section.workspace.id,
                                            for: coordinator.activeInstanceId
                                        )
                                    } label: {
                                        HStack(spacing: 10) {
                                            Image(systemName: expanded ? "chevron.down" : "chevron.right")
                                                .font(.caption.weight(.semibold))
                                                .foregroundStyle(palette.secondary)
                                                .frame(width: 12)
                                            Image(systemName: section.workspace.noWorkspace
                                                ? "bubble.left.and.bubble.right"
                                                : section.workspace.hasFolder ? "folder" : "tray")
                                                .font(.body.weight(.medium))
                                                .foregroundStyle(palette.accent)
                                                .frame(width: 22)
                                            Text(section.workspace.name)
                                                .font(.headline.weight(.semibold))
                                                .foregroundStyle(palette.foreground)
                                                .lineLimit(1)
                                        }
                                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(
                                        "\(expanded ? "Collapse" : "Expand") \(section.workspace.name)"
                                    )

                                    if !section.workspace.noWorkspace {
                                        workspaceDestination(section.workspace)
                                    }
                                }

                                if expanded {
                                    ForEach(visibleChats) { chat in
                                        noWorkspaceChatActions(chatRow(chat), chat: chat)
                                            .padding(.leading, 30)
                                    }
                                    if section.chats.isEmpty {
                                        Button {
                                            Task { await createNewAgent(in: section.workspace) }
                                        } label: {
                                            Label("New chat", systemImage: "square.and.pencil")
                                                .font(.subheadline.weight(.medium))
                                                .foregroundStyle(palette.secondary)
                                                .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                                                .padding(.leading, 34)
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(newChatUnavailable)
                                    }
                                    if remainingChatCount > 0 {
                                        Button {
                                            fullyRevealedSidebarWorkspaceIDs.insert(section.workspace.id)
                                        } label: {
                                            Text("Show \(remainingChatCount) more")
                                                .font(.subheadline.weight(.medium))
                                                .foregroundStyle(palette.secondary)
                                                .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                                                .padding(.leading, 34)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                            .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
                            .listRowSeparator(.hidden)
                            .listRowBackground(palette.canvas)
                        }
                    }
                case .skeleton:
                    AidenChatListSkeleton(rowCount: 4, accessibilityText: "Loading workspaces")
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(palette.canvas)
                case .empty:
                    ContentUnavailableView(
                        "No Workspaces Yet",
                        systemImage: "folder",
                        description: Text("Add a workspace to begin.")
                    )
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(palette.canvas)
                case .failed:
                    unreachableListState
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(palette.canvas)
                }
            } else {
                switch recentsPresentation {
                case .content:
                    if chatListUnavailable { chatRefreshErrorRow }
                    if sidebarProjection.recents.isEmpty {
                        ContentUnavailableView.search(text: searchText)
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                            .listRowBackground(palette.canvas)
                    } else {
                        ForEach(sidebarProjection.recents) { chat in
                            noWorkspaceChatActions(chatRow(chat), chat: chat)
                                .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
                                .listRowSeparator(.hidden)
                                .listRowBackground(palette.canvas)
                        }
                    }
                case .skeleton:
                    AidenChatListSkeleton(rowCount: 6)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(palette.canvas)
                case .empty:
                    ContentUnavailableView(
                        "No Chats Yet",
                        systemImage: "bubble.left",
                        description: Text("Start a new Workspace chat to begin.")
                    )
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(palette.canvas)
                case .failed:
                    if case .offline = coordinator.connectionState {
                        unreachableListState
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                            .listRowBackground(palette.canvas)
                    } else {
                        ContentUnavailableView {
                            Label("Chats Couldn’t Load", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                        } description: {
                            Text(homeModel.chatLoadErrorMessage ?? "Reconnect and try again.")
                        } actions: {
                            Button("Try Again") {
                                Task { await homeModel.load(coordinator: coordinator) }
                            }
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(palette.canvas)
                    }
                }
            }

            if nextPageAvailableOrFailed {
                chatPaginationRow
                    .listRowInsets(EdgeInsets(top: 8, leading: 24, bottom: 8, trailing: 24))
                    .listRowSeparator(.hidden)
                    .listRowBackground(palette.canvas)
            }

        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.canvas.ignoresSafeArea())
        .contentMargins(.bottom, 104, for: .scrollContent)
        .refreshable {
            await coordinator.refreshWorkspaces()
            await homeModel.load(coordinator: coordinator)
        }
        .confirmationDialog(
            "Delete this chat?",
            isPresented: Binding(
                get: { chatPendingDelete != nil },
                set: { if !$0 { chatPendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Chat", role: .destructive) {
                guard let chat = chatPendingDelete else { return }
                chatPendingDelete = nil
                Task { await deleteNoWorkspaceChat(chat) }
            }
            Button("Cancel", role: .cancel) { chatPendingDelete = nil }
        } message: {
            Text("This permanently removes the chat from Aiden Agent.")
        }
        .task(id: sidebarOrganization) {
            // Snoozes wake and Earlier ages out on this phone's clock.
            guard sidebarOrganization == .inbox else { return }
            while !Task.isCancelled {
                inboxClock = Date()
                try? await Task.sleep(for: .seconds(30))
            }
        }
        .onChange(of: sidebarOrganization) { _, _ in
            showsAllInboxEarlier = false
            homeModel.inboxNotice = nil
        }
        .confirmationDialog(
            "Snooze until",
            isPresented: Binding(
                get: { snoozeCandidate != nil },
                set: { if !$0 { snoozeCandidate = nil } }
            ),
            titleVisibility: .visible,
            presenting: snoozeCandidate
        ) { chat in
            ForEach(AidenSnoozeOption.options(now: Date())) { option in
                Button(option.label) { snooze(chat, until: option.until) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .overlay(alignment: .top) {
            if sidebarOrganization == .inbox, let notice = homeModel.inboxNotice {
                AidenInboxNoticeBanner(
                    notice: notice,
                    palette: palette,
                    onUndo: { () -> (() -> Void)? in
                        // Undo is sent against the swipe's own revision, so a
                        // notice without one offers none rather than writing
                        // unconditionally.
                        guard let undo = notice.undo, let chatID = notice.chatID,
                              let revision = notice.revision else { return nil }
                        return {
                            homeModel.inboxNotice = nil
                            Task {
                                await homeModel.setTriage(
                                    undo,
                                    chatID: chatID,
                                    coordinator: coordinator,
                                    undoRevision: revision
                                )
                            }
                        }
                    }(),
                    onDismiss: { homeModel.inboxNotice = nil }
                )
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                .task(id: InboxNoticeTiming(id: notice.id, voiceOver: voiceOverEnabled)) {
                    // The banner can't take focus, so VoiceOver hears it here,
                    // once: not again when the overlay is rebuilt. Marked only
                    // while VoiceOver is on, so turning it on mid-banner still
                    // reads the banner out.
                    if voiceOverEnabled, homeModel.announcedInboxNoticeID != notice.id {
                        homeModel.announcedInboxNoticeID = notice.id
                        AccessibilityNotification.Announcement(notice.message).post()
                    }
                    // Only what is left of the window since it was posted.
                    guard let delay = notice.remainingDelay(voiceOverRunning: voiceOverEnabled) else { return }
                    try? await Task.sleep(for: delay)
                    guard !Task.isCancelled else { return }
                    if homeModel.inboxNotice?.id == notice.id { homeModel.inboxNotice = nil }
                }
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.24, extraBounce: 0), value: homeModel.inboxNotice)
    }

    @ViewBuilder
    private var inboxListContent: some View {
        switch recentsPresentation {
        case .content:
            if chatListUnavailable { chatRefreshErrorRow }
            let projection = inboxProjection
            if projection.isEmpty {
                Group {
                    if searchText.isEmpty {
                        ContentUnavailableView(
                            "All Caught Up",
                            systemImage: "tray",
                            description: Text("Chats that need you or have news show up here.")
                        )
                    } else {
                        ContentUnavailableView.search(text: searchText)
                    }
                }
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(palette.canvas)
            } else {
                ForEach(AidenInboxSection.allCases, id: \.self) { section in
                    let rows = projection.rows(in: section)
                    if !rows.isEmpty {
                        inboxSectionHeader(section, count: rows.count)
                        ForEach(rows) { row in
                            inboxRow(row, section: section)
                        }
                        if section == .earlier, projection.earlierOverflow > 0 {
                            Button {
                                showsAllInboxEarlier = true
                            } label: {
                                Text("Show \(projection.earlierOverflow) more")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(palette.secondary)
                                    .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                                    .padding(.leading, 29)
                            }
                            .buttonStyle(.plain)
                            .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
                            .listRowSeparator(.hidden)
                            .listRowBackground(palette.canvas)
                        }
                    }
                }
            }
        case .skeleton:
            AidenChatListSkeleton(rowCount: 6, accessibilityText: "Loading Inbox")
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(palette.canvas)
        case .empty:
            ContentUnavailableView(
                "No Chats Yet",
                systemImage: "tray",
                description: Text("Start a new Workspace chat to begin.")
            )
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(palette.canvas)
        case .failed:
            unreachableListState
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(palette.canvas)
        }
    }

    private func inboxSectionHeader(_ section: AidenInboxSection, count: Int) -> some View {
        AidenInboxSectionHeader(section: section, count: count, palette: palette)
    }

    private func inboxRow(_ row: AidenInboxProjection.Row, section: AidenInboxSection) -> some View {
        let chat = row.summary
        let offer = inboxOffer(chat)
        return AidenInboxListRow(
            row: row,
            section: section,
            workspaceName: activeWorkspaces.first(where: { $0.id == chat.workspaceId }).map { AidenNoWorkspace.label(for: $0) },
            palette: palette,
            actions: AidenInboxRowActions(
                offer: offer,
                markRead: { markRead(chat) },
                triage: { change in Task { await homeModel.setTriage(change, chatID: chat.id, coordinator: coordinator, isOpen: chat.id == selectedSidebarChat?.id) } },
                snooze: { snoozeCandidate = chat }
            ),
            open: { openChat(chat) }
        )
    }

    private var nextPageAvailableOrFailed: Bool {
        homeModel.nextChatCursor != nil || {
            if case .failed = homeModel.paginationState { return true }
            return false
        }()
    }

    @ViewBuilder
    private var chatPaginationRow: some View {
        switch homeModel.paginationState {
        case .loading:
            AidenChatListSkeleton(rowCount: 2, accessibilityText: "Loading more chats")
        case .failed(let message):
            VStack(spacing: 6) {
                Text("More chats couldn’t load")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.foreground)
                Text(message)
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(2)
                Button("Try Again") {
                    Task { await homeModel.loadMoreChats(coordinator: coordinator) }
                }
                .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        case .idle:
            Button("Load more chats") {
                Task { await homeModel.loadMoreChats(coordinator: coordinator) }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity, minHeight: 44)
        }
    }

    private var sidebarOrganizationMenu: some View {
        Menu {
            Picker("Organize sidebar", selection: Binding(
                get: { sidebarOrganization },
                set: {
                    navigationStore.setWorkspaceSidebarOrganization(
                        $0,
                        for: coordinator.activeInstanceId
                    )
                }
            )) {
                Label("By workspace", systemImage: "list.bullet.indent").tag(
                    AidenWorkspaceSidebarOrganization.workspace
                )
                Label("Recent only", systemImage: "clock").tag(
                    AidenWorkspaceSidebarOrganization.recent
                )
                Label("Inbox (Beta)", systemImage: "tray").tag(
                    AidenWorkspaceSidebarOrganization.inbox
                )
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.secondary)
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Organize sidebar")
    }

    private var homeHeader: some View {
        HStack(spacing: isSearching ? 0 : 16) {
            AidenProductSwitcherButton(
                area: productArea,
                botsAvailability: botsAvailability,
                onSelect: onSelectProductArea
            )
                .frame(width: isSearching ? 0 : 68, height: 68, alignment: .leading)
                .opacity(isSearching ? 0 : 1)
                .clipped()

            searchChrome
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, 24)
        .padding(.top, 28)
        .animation(.smooth(duration: 0.24, extraBounce: 0), value: isSearching)
    }

    private var searchChrome: some View {
        HStack(spacing: isSearching ? 8 : 2) {
            Button {
                openSearch()
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(isSearching ? palette.secondary : palette.foreground)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isSearching ? "Focus chat search" : "Search chats")

            if isSearching {
                TextField("Search chats", text: $searchText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($searchFieldIsFocused)
                    .submitLabel(.done)

                Button {
                    closeSearch()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 21, weight: .medium))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close search")
            } else {
                Button { isShowingAppSettings = true } label: {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(palette.accent)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Profile and app settings")
            }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: isSearching ? .infinity : nil, alignment: .trailing)
        .aidenChromeGlass(isInteractive: true, in: Capsule())
        .clipShape(Capsule())
        .contentShape(Capsule())
    }

    private var homeNavigationRows: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { isShowingScheduledTasks = true } label: {
                homeNavigationRow(
                    title: "Scheduled Tasks",
                    systemImage: "calendar.badge.clock"
                )
            }
            .buttonStyle(.plain)

            Button { isShowingUsage = true } label: {
                homeNavigationRow(title: "Usage", systemImage: "chart.bar.xaxis")
            }
            .buttonStyle(.plain)
            .disabled(
                homeModel.usage == nil
                    && !AidenHomeLoadPlan(installation: coordinator.installationStore.activeInstallation).loadsUsage
            )

            NavigationLink {
                AidenWorkspacesDirectoryView(
                    coordinator: coordinator,
                    archiveStore: workspaceArchiveStore
                )
            } label: {
                homeNavigationRow(
                    title: "Workspaces",
                    systemImage: "folder",
                    showsChevron: false
                )
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 24)
    }

    private func homeNavigationRow(
        title: String,
        systemImage: String,
        showsChevron: Bool = true
    ) -> some View {
        HStack(spacing: 18) {
            Image(systemName: systemImage)
                .font(.system(size: 21, weight: .medium))
                .foregroundStyle(palette.accent)
                .frame(width: 28)

            Text(title)
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.foreground)
                .lineLimit(1)

            Spacer(minLength: 8)

            if showsChevron {
                Image(systemName: "chevron.forward")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 24)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func homeChatRow(_ chat: AidenChatSummary, showsWorkspace: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    if chat.forkedFrom != nil {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(palette.secondary)
                            .accessibilityLabel("Fork")
                    }
                    Text(chat.title)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                        .lineLimit(2)
                }

                if showsWorkspace,
                   let workspace = coordinator.workspaces.first(where: { $0.id == chat.workspaceId }) {
                    Text(AidenNoWorkspace.label(for: workspace))
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            AidenChatRowStatusView(
                state: chat.displayRowState,
                unread: chat.unread,
                failed: chat.showsFailed,
                palette: palette
            )

            AidenRelativeTimestampView(date: chat.updatedAt)
                .font(.caption)
                .foregroundStyle(palette.secondary)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }

    private func openSearch() {
        if isSearching {
            searchFieldIsFocused = true
            return
        }

        withAnimation(.smooth(duration: 0.24, extraBounce: 0)) {
            isSearching = true
        }
        Task { @MainActor in
            await Task.yield()
            searchFieldIsFocused = true
        }
    }

    private func closeSearch() {
        searchText = ""
        searchFieldIsFocused = false
        withAnimation(.smooth(duration: 0.24, extraBounce: 0)) {
            isSearching = false
        }
    }

    private var newAgentButton: some View {
        Button { isShowingNewAgentChoices = true } label: {
            Image(systemName: "square.and.pencil")
                .font(.title2.weight(.semibold))
                .foregroundStyle(palette.foreground)
                .frame(width: 42, height: 50)
                .contentShape(Rectangle())
        }
        .aidenProminentGlassButton()
        .disabled(newChatUnavailable)
        .accessibilityLabel("New Workspace Chat")
        .accessibilityHint("Choose the workspace for a new chat.")
        .matchedTransitionSource(id: "AidenNewAgentOptions", in: newAgentTransition)
        .popover(isPresented: $isShowingNewAgentChoices, arrowEdge: .bottom) {
            AidenNewAgentPopover(
                choices: AidenNewAgentChoice.available(
                    noWorkspace: AidenNoWorkspace.home(in: coordinator.workspaces) != nil
                ),
                canUseExistingWorkspace: !AidenNoWorkspace.choices(activeWorkspaces).isEmpty,
                onSelect: presentNewAgentChoice
            )
            .frame(width: 320)
            .presentationCompactAdaptation(.popover)
            .navigationTransition(.zoom(sourceID: "AidenNewAgentOptions", in: newAgentTransition))
        }
    }

    @MainActor
    private func presentNewAgentChoice(_ choice: AidenNewAgentChoice) {
        isShowingNewAgentChoices = false
        Task { @MainActor in
            await Task.yield()
            switch choice {
            case .noWorkspace:
                // The Mac gives the chat a folder of its own if the home already holds one.
                if let home = AidenNoWorkspace.home(in: coordinator.workspaces) {
                    await createNewAgent(in: home)
                }
            case .existingWorkspace:
                isShowingExistingWorkspacePicker = true
            case .newWorkspace:
                newAgentWorkspaceName = ""
                isShowingNewAgentWorkspacePrompt = true
            case .scratchWorkspace:
                await createNewAgentInScratchWorkspace()
            }
        }
    }

    @MainActor
    private func createNewAgent(in workspace: AidenWorkspace) async {
        await createNewAgent(workspace: workspace, status: "Opening chat…")
    }

    @MainActor
    private func createNewAgent(inNewWorkspaceNamed name: String) async {
        guard !name.isEmpty else { return }
        await createNewAgent(
            workspaceCreate: .folderless(name: name),
            status: "Creating workspace…"
        )
    }

    @MainActor
    private func createNewAgentInScratchWorkspace() async {
        await createNewAgent(workspaceCreate: .scratch, status: "Preparing scratch workspace…")
    }

    @MainActor
    private func createNewAgent(workspaceCreate: AidenWorkspaceCreate, status: String) async {
        guard !isCreatingAgent else { return }
        isCreatingAgent = true
        agentCreationStatus = status
        defer {
            isCreatingAgent = false
            agentCreationStatus = ""
        }
        guard await awaitChatCreationReady() else {
            reportChatCreationUnavailable()
            return
        }

        let creationOutcome = await coordinator.createWorkspaceOutcome(workspaceCreate)
        guard case .success(let created) = creationOutcome else {
            if creationOutcome.isDefinitiveFailure {
                coordinator.haptics.play(.error, scope: hapticScope)
            }
            return
        }
        let application = await applyGlobalDefaults(to: created)
        await createNewAgent(
            workspace: application.workspace,
            status: "Opening chat…",
            managesProgress: false,
            completionFeedback: application.feedback
        )
    }

    @MainActor
    private func createNewAgent(
        workspace: AidenWorkspace,
        status: String,
        managesProgress: Bool = true,
        completionFeedback: AidenHapticEvent = .success
    ) async {
        guard !isCreatingAgent || !managesProgress else { return }
        if managesProgress {
            isCreatingAgent = true
            agentCreationStatus = status
        } else {
            agentCreationStatus = status
        }
        defer {
            if managesProgress {
                isCreatingAgent = false
                agentCreationStatus = ""
            }
        }
        guard await awaitChatCreationReady() else {
            reportChatCreationUnavailable()
            return
        }

        let context: AidenRemoteRequestContext
        do {
            context = try coordinator.requestContext()
        } catch {
            coordinator.presentedError = error.localizedDescription
            return
        }

        do {
            let chat = try await coordinator.remoteClient(for: context)
                .createChat(workspaceId: workspace.id, noWorkspace: workspace.noWorkspace)
            guard coordinator.isCurrent(context) else { return }
            guard !chat.isBotChat else {
                coordinator.presentedError = String(localized: "Aiden returned a conversation that is unavailable in Workspaces.")
                return
            }
            // A No workspace chat can land in a fresh hidden workspace the phone hasn't listed yet.
            if !coordinator.workspaces.contains(where: { $0.id == chat.workspaceId }) {
                await coordinator.refreshWorkspaces()
                guard coordinator.isCurrent(context) else { return }
                guard coordinator.workspaces.contains(where: { $0.id == chat.workspaceId }) else {
                    homeModel.accept(chat)
                    coordinator.presentedError = AidenNoWorkspace.startedButUnlistedMessage
                    return
                }
            }
            // The chat opens from the create receipt; Home's full reload
            // (chats, tasks, catalog, usage) runs behind it.
            homeModel.accept(chat)
            openChat(chat)
            coordinator.haptics.play(
                completionFeedback,
                scope: hapticScope,
                dedupeKey: "new-agent:\(workspace.id):\(chat.id):\(chat.revision)"
            )
            let homeModel = homeModel
            let coordinator = coordinator
            Task { @MainActor in
                guard coordinator.isCurrent(context) else { return }
                await homeModel.load(coordinator: coordinator)
            }
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            guard coordinator.isCurrent(context) else { return }
            coordinator.presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            await coordinator.refreshWorkspaces()
            guard coordinator.isCurrent(context) else { return }
            await homeModel.load(coordinator: coordinator)
        }
    }

    @MainActor
    private func applyGlobalDefaults(to workspace: AidenWorkspace) async -> AidenWorkspaceDefaultApplication {
        let permission = AidenWorkspacePermission(rawValue: defaultWorkspacePermissionRaw) ?? .ask
        return await .applying(permission, to: workspace) { await coordinator.updateWorkspace(workspace, permission: $0) }
    }

    @ViewBuilder
    private func workspaceDetail(workspaceID: String?) -> some View {
        // A hidden No workspace record has no page of its own (no chat list, settings or Remove).
        if let workspaceID,
           !archivedWorkspaceIDs.contains(workspaceID),
           let workspace = coordinator.workspaces.first(where: { $0.id == workspaceID }),
           !workspace.noWorkspace {
            AidenWorkspaceDetailView(
                coordinator: coordinator,
                workspace: workspace,
                owner: nil,
                onRemoved: { removeWorkspaceFromNavigation(workspaceID) },
                onChatUpdated: { homeModel.accept($0) },
                onChatRemoved: { homeModel.removeChat(id: $0) },
                onChatActivityChanged: { chatID, activity in
                    homeModel.setActivity(activity, forChatID: chatID)
                }
            )
            .id(workspace.revision)
        } else {
            ContentUnavailableView(
                "Choose a Workspace",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("Select a workspace to see its chats and settings.")
            )
        }
    }

    private func openChat(_ chat: AidenChat, startsVoice: Bool = false) {
        cancelPendingSidebarChatNavigation()
        commitOpenChat(chat, startsVoice: startsVoice)
    }

    /// Lists a fork opened from the selected chat. The detail pushes it over
    /// its source in either layout (the compact stack or the split detail
    /// column), so Back returns to the source and the sidebar keeps the
    /// source selected.
    private func acceptOpenedFork(_ chat: AidenChat) {
        homeModel.accept(chat)
        homeModel.markViewed(chatID: chat.id)
    }

    private func acceptSelectedChatUpdate(_ updated: AidenChat) {
        homeModel.accept(updated)
        guard AidenChatReadAdmission.acceptsSelectedChatUpdate(
            chatID: updated.id,
            selectedChatID: selectedSidebarChat?.id
        ) else { return }
        selectedSidebarChat = updated
    }

    private func commitOpenChat(_ chat: AidenChat, startsVoice: Bool = false) {
        guard activeWorkspaceIDs.contains(chat.workspaceId) else { return }
        // A chat without a workspace is listed under the Chats group, which stands on the home.
        let sectionID = AidenNoWorkspace.groupID(for: chat.workspaceId, in: coordinator.workspaces)
        selectedWorkspaceId = sectionID
        navigationStore.ensureExpandedSidebarWorkspace(
            sectionID,
            for: coordinator.activeInstanceId
        )
        if !usesSplitNavigation { compactWorkspacePath = [] }
        selectedSidebarChatStartsVoice = startsVoice
        selectedSidebarChat = chat
        homeModel.markViewed(chatID: chat.id)
    }

    private func openChat(_ summary: AidenChatSummary, startsVoice: Bool = false) {
        guard activeWorkspaceIDs.contains(summary.workspaceId) else { return }
        cancelPendingSidebarChatNavigation()
        let requestID = UUID()
        sidebarChatNavigationRequestID = requestID
        sidebarChatNavigationTask = Task { @MainActor in
            defer {
                if sidebarChatNavigationRequestID == requestID {
                    sidebarChatNavigationRequestID = nil
                    sidebarChatNavigationTask = nil
                }
            }
            do {
                let context = try coordinator.requestContext()
                // Saved transcript first: the chat opens at once and refreshes
                // itself, instead of waiting here on the network.
                if let cached = await homeModel.cachedWorkspaceChat(
                    id: summary.id,
                    workspaceId: summary.workspaceId,
                    instanceId: context.instanceId
                ) {
                    try Task.checkCancellation()
                    guard sidebarChatNavigationRequestID == requestID,
                          coordinator.isCurrent(context),
                          activeWorkspaceIDs.contains(cached.workspaceId) else { return }
                    commitOpenChat(cached, startsVoice: startsVoice)
                    return
                }
                let chat = try await coordinator.remoteClient(for: context).chat(id: summary.id)
                try Task.checkCancellation()
                guard sidebarChatNavigationRequestID == requestID,
                      coordinator.isCurrent(context),
                      !chat.isBotChat,
                      chat.workspaceId == summary.workspaceId,
                      activeWorkspaceIDs.contains(chat.workspaceId) else { return }
                commitOpenChat(chat, startsVoice: startsVoice)
            } catch let error where aidenIsCancellation(error) {
                return
            } catch {
                coordinator.presentedError = error.localizedDescription
            }
        }
    }

    private func cancelPendingSidebarChatNavigation() {
        sidebarChatNavigationRequestID = nil
        sidebarChatNavigationTask?.cancel()
        sidebarChatNavigationTask = nil
    }

    private func navigate(to workspaceID: String, clearsSelectedChat: Bool = true) {
        guard activeWorkspaceIDs.contains(workspaceID) else { return }
        cancelPendingSidebarChatNavigation()
        if clearsSelectedChat {
            clearSelectedSidebarChat()
        }
        selectedWorkspaceId = workspaceID
        navigationStore.ensureExpandedSidebarWorkspace(
            workspaceID,
            for: coordinator.activeInstanceId
        )
        if !usesSplitNavigation {
            compactWorkspacePath = [workspaceID]
        }
    }

    private func removeWorkspaceFromNavigation(_ workspaceID: String) {
        if selectedWorkspaceId == workspaceID {
            selectedWorkspaceId = nil
        }
        compactWorkspacePath.removeAll { $0 == workspaceID }
    }

    private func reconcileNavigation(workspaceIDs: [String]) {
        if coordinator.connectionState == .connecting, workspaceIDs.isEmpty { return }
        if let selectedSidebarChat, !workspaceIDs.contains(selectedSidebarChat.workspaceId) {
            clearSelectedSidebarChat()
        }
        fullyRevealedSidebarWorkspaceIDs.formIntersection(workspaceIDs)
        selectedWorkspaceId = AidenWorkspaceNavigation.reconciledSelection(
            current: selectedWorkspaceId,
            workspaceIDs: AidenWorkspaceNavigation.selectableIDs(
                activeWorkspaces.filter { workspaceIDs.contains($0.id) },
                openChatWorkspaceID: selectedSidebarChat?.workspaceId
            )
        )
        compactWorkspacePath = AidenWorkspaceNavigation.reconciledCompactPath(
            current: compactWorkspacePath,
            workspaceIDs: workspaceIDs
        )
    }

    /// Chats under Chats have no workspace page (where other chats are deleted),
    /// so their row's menu offers Delete. Other rows are unchanged.
    @ViewBuilder
    private func noWorkspaceChatActions<Row: View>(_ row: Row, chat: AidenChatSummary) -> some View {
        if coordinator.workspaces.first(where: { $0.id == chat.workspaceId })?.noWorkspace == true {
            row
                .contextMenu {
                    Button(role: .destructive) { chatPendingDelete = chat } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .disabled(coordinator.connectionState != .connected)
                }
                .accessibilityAction(named: Text("Delete chat")) {
                    guard coordinator.connectionState == .connected else { return }
                    chatPendingDelete = chat
                }
        } else {
            row
        }
    }

    @MainActor
    private func deleteNoWorkspaceChat(_ summary: AidenChatSummary) async {
        guard let context = try? coordinator.requestContext() else { return }
        if selectedSidebarChat?.id == summary.id { clearSelectedSidebarChat() }
        // The row leaves the sidebar at once; a failed delete reloads the list, which puts it back.
        homeModel.removeChat(id: summary.id)
        do {
            let client = try coordinator.remoteClient(for: context)
            // The row's revision can lag a rename, so delete the chat as the Mac has it now.
            let current = try await client.chat(id: summary.id)
            guard coordinator.isCurrent(context) else { return }
            try await client.removeChat(id: current.id, revision: current.revision)
            guard coordinator.isCurrent(context) else { return }
            await AidenChatCache.shared.removeChat(instanceId: context.instanceId, chatId: summary.id)
            await AidenChatDraftStore.shared.remove(instanceId: context.instanceId, chatId: summary.id)
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-remove:\(summary.id)")
            // The Mac releases the chat's hidden folder with it; drop it from the list too.
            await coordinator.refreshWorkspaces()
        } catch let error where aidenIsCancellation(error) {
            guard coordinator.isCurrent(context) else { return }
            await homeModel.load(coordinator: coordinator)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            coordinator.presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            await homeModel.load(coordinator: coordinator)
        }
    }

    private func clearSelectedSidebarChat() {
        selectedSidebarChat = nil
        selectedSidebarChatStartsVoice = false
    }

    private func syncArchivedWorkspaceProjection() {
        coordinator.setDeviceArchivedWorkspaceIDs(
            archivedWorkspaceIDs,
            for: coordinator.activeInstanceId
        )
    }

    @MainActor
    private func resolveNavigationRequest() async {
        guard let request = navigationRequest,
              coordinator.connectionState == .connected else { return }
        defer { navigationRequest = nil }
        guard request.instanceId == nil || request.instanceId == coordinator.activeInstanceId else {
            coordinator.presentedError = String(localized: "The requested Aiden installation is not active.")
            return
        }

        let context: AidenRemoteRequestContext
        do {
            context = try coordinator.requestContext(for: request.instanceId)
        } catch {
            coordinator.presentedError = error.localizedDescription
            return
        }
        do {
            let chat: AidenChat
            switch request.destination {
            case .newChat:
                let workspaceId = request.workspaceId ?? selectedWorkspaceId ?? activeWorkspaces.first?.id
                guard let workspaceId,
                      activeWorkspaceIDs.contains(workspaceId) else {
                    if let requestedWorkspaceID = request.workspaceId,
                       archivedWorkspaceIDs.contains(requestedWorkspaceID) {
                        coordinator.presentedError = String(localized: "That workspace is archived on this device. Unarchive it from Workspaces to start a chat.")
                        return
                    }
                    coordinator.presentedError = String(localized: "The requested workspace is unavailable. Choose or add a workspace first.")
                    return
                }
                let underChats = coordinator.workspaces.contains { $0.id == workspaceId && $0.noWorkspace }
                chat = try await coordinator.remoteClient(for: context)
                    .createChat(workspaceId: workspaceId, noWorkspace: underChats)
                guard coordinator.isCurrent(context) else { return }
                guard !chat.isBotChat else {
                    coordinator.presentedError = String(localized: "Aiden returned a conversation that is unavailable in Workspaces.")
                    return
                }
                navigate(to: workspaceId)
            case .chat(let chatId):
                chat = try await coordinator.remoteClient(for: context).chat(id: chatId)
                guard coordinator.isCurrent(context) else { return }
                guard !chat.isBotChat else {
                    coordinator.presentedError = String(localized: "This conversation belongs in Bots and cannot be opened from Workspaces yet.")
                    return
                }
                // A chat started without a workspace can sit in a hidden folder made after the
                // phone last read the Mac's workspaces.
                if !coordinator.workspaces.contains(where: { $0.id == chat.workspaceId }) {
                    await coordinator.refreshWorkspaces()
                    guard coordinator.isCurrent(context) else { return }
                }
                guard activeWorkspaceIDs.contains(chat.workspaceId) else {
                    if archivedWorkspaceIDs.contains(chat.workspaceId) {
                        coordinator.presentedError = String(localized: "That chat belongs to a workspace archived on this device. Unarchive it from Workspaces to open the chat.")
                        return
                    }
                    coordinator.presentedError = String(localized: "The chat's workspace is no longer available.")
                    return
                }
                navigate(to: AidenNoWorkspace.groupID(for: chat.workspaceId, in: coordinator.workspaces))
            case .botChat:
                // The product shell resolves Bot links before Workspaces sees
                // them; never reinterpret a Bot ID as a Workspace destination.
                coordinator.presentedError = String(localized: "This conversation belongs in Bots and cannot be opened from Workspaces yet.")
                return
            }
            guard coordinator.isCurrent(context) else { return }
            openChat(chat, startsVoice: request.startsVoice)
        } catch {
            guard coordinator.isCurrent(context) else { return }
            coordinator.presentedError = error.localizedDescription
        }
    }
}

private struct AidenOfflineBanner: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "wifi.slash")
            Text(message)
                .font(.footnote)
                .lineLimit(2)
            Spacer(minLength: 4)
            Button("Retry", action: retry)
                .font(.footnote.bold())
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.regularMaterial)
        .accessibilityElement(children: .combine)
    }
}

extension AidenWorkspacePermission {
    var title: String {
        switch self {
        case .full: "Full Access"
        case .ask: "Ask Before Actions"
        case .none: "No Access"
        }
    }

    var detail: String {
        switch self {
        case .full:
            "Aiden can use this workspace's approved tools without asking for each ordinary action. Consequential Git actions still require confirmation."
        case .ask:
            "Aiden asks before actions that need approval in this workspace."
        case .none:
            "Aiden can show existing chats but cannot use workspace tools."
        }
    }
}
