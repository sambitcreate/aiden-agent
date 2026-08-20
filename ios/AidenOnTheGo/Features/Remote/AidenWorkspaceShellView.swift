import SwiftUI

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
        if #available(iOS 26, *), !reduceTransparency {
            content.glassEffect(.regular.tint(tint).interactive(), in: Capsule())
        } else {
            content.background(tint, in: Capsule())
        }
    }
}

private extension View {
    func aidenLiquidGlassCapsule(tint: Color) -> some View {
        modifier(AidenLiquidGlassCapsuleModifier(tint: tint))
    }
}

@MainActor
@Observable
private final class AidenHomeModel {
    var chats: [AidenChat] = []
    var scheduledTasks: [AidenScheduledTask] = []
    var usage: AidenUsageSummary?
    var isLoading = false
    var errorMessage: String?

    func load(coordinator: AidenRemoteCoordinator) async {
        guard coordinator.connectionState == .connected, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let client = try coordinator.remoteClient()
            async let chatsRequest = client.chats()
            async let tasksRequest = client.scheduledTasks()
            let (chats, tasks) = try await (chatsRequest, tasksRequest)
            self.chats = chats.sorted { $0.updatedAt > $1.updatedAt }
            scheduledTasks = tasks.sorted {
                ($0.nextRunAt ?? .distantFuture) < ($1.nextRunAt ?? .distantFuture)
            }
            usage = try? await client.usage()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct AidenNavigationResolutionID: Equatable {
    let request: AidenNavigationRequest?
    let connectionState: AidenRemoteConnectionState
}

enum AidenWorkspaceNavigation {
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
        workspaceIDs: [String]
    ) -> [String] {
        let current = reconciledCompactPath(current: current, workspaceIDs: workspaceIDs)
        if !current.isEmpty { return current }
        guard enteringFromSplit,
              let selectedWorkspaceID,
              workspaceIDs.contains(selectedWorkspaceID) else { return [] }
        return [selectedWorkspaceID]
    }
}

struct AidenWorkspaceShellView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Binding private var navigationRequest: AidenNavigationRequest?
    @Environment(AidenAppearanceStore.self) private var appearance
    @Environment(\.aidenPalette) private var palette
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var selectedWorkspaceId: String?
    @State private var compactWorkspacePath: [String] = []
    @State private var isShowingPairing = false
    @State private var isShowingAppSettings = false
    @State private var isShowingScheduledTasks = false
    @State private var isShowingUsage = false
    @State private var intentChat: AidenChat?
    @State private var intentStartsVoice = false
    @State private var homeModel = AidenHomeModel()
    @State private var searchText = ""
    @State private var isSearching = false
    @State private var isShowingNewAgentChoices = false
    @State private var isShowingExistingWorkspacePicker = false
    @State private var isShowingNewAgentWorkspacePrompt = false
    @State private var newAgentWorkspaceName = ""
    @State private var isCreatingAgent = false
    @State private var agentCreationStatus = ""
    @FocusState private var searchFieldIsFocused: Bool
    @AppStorage("aiden.defaults.workspacePermission") private var defaultWorkspacePermissionRaw = AidenWorkspacePermission.ask.rawValue

    init(
        coordinator: AidenRemoteCoordinator,
        navigationRequest: Binding<AidenNavigationRequest?> = .constant(nil)
    ) {
        self.coordinator = coordinator
        _navigationRequest = navigationRequest
    }

    private var usesSplitNavigation: Bool {
        horizontalSizeClass == .regular
    }

    var body: some View {
        Group {
            if usesSplitNavigation {
                NavigationSplitView {
                    regularWorkspaceSidebar
                        .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 400)
                } detail: {
                    NavigationStack {
                        workspaceDetail(workspaceID: selectedWorkspaceId)
                    }
                }
                .navigationSplitViewStyle(.balanced)
            } else {
                NavigationStack(path: $compactWorkspacePath) {
                    compactWorkspaceSidebar
                        .navigationDestination(for: String.self) { workspaceID in
                            workspaceDetail(workspaceID: workspaceID)
                        }
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if case .offline(let message) = coordinator.connectionState {
                AidenOfflineBanner(message: message) {
                    Task { await coordinator.connectActiveInstallation() }
                }
            }
        }
        .overlay {
            if coordinator.connectionState == .connecting {
                ProgressView("Connecting to Aiden Agent…")
                    .padding()
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            } else if isCreatingAgent {
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
            AidenPairingView(coordinator: coordinator) { isShowingPairing = false }
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
            if let usage = homeModel.usage {
                AidenUsageView(usage: usage)
            }
        }
        .sheet(isPresented: $isShowingExistingWorkspacePicker) {
            NavigationStack {
                List(coordinator.workspaces) { workspace in
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
        .sheet(item: $intentChat) { chat in
            NavigationStack {
                AidenChatDetailView(
                    coordinator: coordinator,
                    chat: chat,
                    autoStartVoice: intentStartsVoice
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { intentChat = nil }
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
        .confirmationDialog(
            "Where should this agent work?",
            isPresented: $isShowingNewAgentChoices,
            titleVisibility: .visible
        ) {
            Button("Existing Workspace") { isShowingExistingWorkspacePicker = true }
                .disabled(coordinator.workspaces.isEmpty)
            Button("New Workspace") { isShowingNewAgentWorkspacePrompt = true }
            Button("Managed Scratch Workspace") {
                Task { await createNewAgentInScratchWorkspace() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Reuse a workspace to avoid creating unnecessary folders, or choose an isolated scratch workspace for temporary work.")
        }
        .onChange(of: coordinator.workspaces.map(\.id)) { _, ids in
            selectedWorkspaceId = AidenWorkspaceNavigation.reconciledSelection(
                current: selectedWorkspaceId,
                workspaceIDs: ids
            )
            compactWorkspacePath = AidenWorkspaceNavigation.reconciledCompactPath(
                current: compactWorkspacePath,
                workspaceIDs: ids
            )
        }
        .onChange(of: compactWorkspacePath) { _, path in
            guard let workspaceID = path.last,
                  coordinator.workspaces.contains(where: { $0.id == workspaceID }) else { return }
            selectedWorkspaceId = workspaceID
        }
        .onChange(of: usesSplitNavigation) { wasSplit, isSplit in
            let workspaceIDs = coordinator.workspaces.map(\.id)
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
                    workspaceIDs: workspaceIDs
                )
            }
        }
        .task {
            let workspaceIDs = coordinator.workspaces.map(\.id)
            selectedWorkspaceId = AidenWorkspaceNavigation.reconciledSelection(
                current: selectedWorkspaceId,
                workspaceIDs: workspaceIDs
            )
            compactWorkspacePath = AidenWorkspaceNavigation.reconciledCompactPath(
                current: compactWorkspacePath,
                workspaceIDs: workspaceIDs
            )
        }
        .task(id: AidenNavigationResolutionID(
            request: navigationRequest,
            connectionState: coordinator.connectionState
        )) {
            await resolveNavigationRequest()
        }
        .task(id: coordinator.connectionState) {
            await homeModel.load(coordinator: coordinator)
        }
    }

    private var regularWorkspaceSidebar: some View {
        ZStack(alignment: .bottomTrailing) {
            homeList { chat in
                Button { intentChat = chat } label: { homeChatRow(chat) }
                    .buttonStyle(.plain)
            }
            newAgentButton.padding(.trailing, 24).padding(.bottom, 22)
        }
    }

    private var compactWorkspaceSidebar: some View {
        ZStack(alignment: .bottomTrailing) {
            homeList { chat in
                NavigationLink {
                    AidenChatDetailView(coordinator: coordinator, chat: chat)
                } label: {
                    homeChatRow(chat)
                }
            }
            newAgentButton.padding(.trailing, 24).padding(.bottom, 22)
        }
    }

    private var filteredChats: [AidenChat] {
        guard !searchText.isEmpty else { return homeModel.chats }
        return homeModel.chats.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }

    private func homeList<ChatRow: View>(
        @ViewBuilder chatRow: @escaping (AidenChat) -> ChatRow
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

            if !isSearching {
                Text("Chats")
                    .font(.title3.bold())
                    .foregroundStyle(palette.foreground)
                    .padding(.horizontal, 24)
                    .padding(.top, 26)
                    .padding(.bottom, 10)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(palette.canvas)
            }

            if filteredChats.isEmpty, !homeModel.isLoading {
                ContentUnavailableView(
                    searchText.isEmpty ? "No Chats Yet" : "No Matching Chats",
                    systemImage: searchText.isEmpty ? "bubble.left" : "magnifyingglass",
                    description: Text(searchText.isEmpty
                        ? "Start a new agent to create your first chat."
                        : "Try a different search term.")
                )
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
                .listRowBackground(palette.canvas)
            } else {
                ForEach(filteredChats) { chat in
                    chatRow(chat)
                        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
                        .listRowSeparator(.hidden)
                        .listRowBackground(palette.canvas)
                }
            }

            Color.clear.frame(height: 90).listRowSeparator(.hidden)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .refreshable {
            await coordinator.refreshWorkspaces()
            await homeModel.load(coordinator: coordinator)
        }
        .overlay { if homeModel.isLoading && homeModel.chats.isEmpty { ProgressView() } }
    }

    private var homeHeader: some View {
        HStack(spacing: isSearching ? 0 : 16) {
            Image("AidenAppIcon")
                .resizable()
                .scaledToFit()
                .frame(width: isSearching ? 0 : 68, height: 68, alignment: .leading)
                .opacity(isSearching ? 0 : 1)
                .clipped()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Aiden")

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
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Profile and app settings")
            }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: isSearching ? .infinity : nil, alignment: .trailing)
        .background(.thinMaterial, in: Capsule())
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
            .disabled(coordinator.connectionState != .connected)

            Button { isShowingUsage = true } label: {
                homeNavigationRow(title: "Usage", systemImage: "chart.bar.xaxis")
            }
            .buttonStyle(.plain)
            .disabled(homeModel.usage == nil)

            NavigationLink {
                AidenWorkspacesDirectoryView(coordinator: coordinator)
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

    private func homeChatRow(_ chat: AidenChat) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(chat.title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(2)

                if let workspace = coordinator.workspaces.first(where: { $0.id == chat.workspaceId }) {
                    Text(workspace.name)
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

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
            Label("New Agent", systemImage: "square.and.pencil")
                .font(.headline.weight(.semibold))
                .padding(.horizontal, 20)
                .frame(height: 56)
                .foregroundStyle(palette.canvas)
                .aidenLiquidGlassCapsule(tint: palette.foreground)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(coordinator.connectionState != .connected || coordinator.isMutating || isCreatingAgent)
    }

    @MainActor
    private func createNewAgent(in workspace: AidenWorkspace) async {
        await createNewAgent(workspace: workspace, status: "Opening agent…")
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

        guard let created = await coordinator.createWorkspace(workspaceCreate) else { return }
        let workspace = await applyGlobalDefaults(to: created)
        await createNewAgent(workspace: workspace, status: "Opening agent…", managesProgress: false)
    }

    @MainActor
    private func createNewAgent(
        workspace: AidenWorkspace,
        status: String,
        managesProgress: Bool = true
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

        do {
            let chat = try await coordinator.remoteClient().createChat(workspaceId: workspace.id)
            await homeModel.load(coordinator: coordinator)
            navigate(to: workspace.id)
            intentChat = chat
        } catch {
            coordinator.presentedError = error.localizedDescription
            await coordinator.refreshWorkspaces()
            await homeModel.load(coordinator: coordinator)
        }
    }

    @MainActor
    private func applyGlobalDefaults(to workspace: AidenWorkspace) async -> AidenWorkspace {
        let permission = AidenWorkspacePermission(rawValue: defaultWorkspacePermissionRaw) ?? .ask
        guard permission != workspace.permission else { return workspace }
        return await coordinator.updateWorkspace(workspace, permission: permission) ?? workspace
    }

    @ViewBuilder
    private func workspaceDetail(workspaceID: String?) -> some View {
        if let workspaceID,
           let workspace = coordinator.workspaces.first(where: { $0.id == workspaceID }) {
            AidenWorkspaceDetailView(
                coordinator: coordinator,
                workspace: workspace,
                onRemoved: { removeWorkspaceFromNavigation(workspaceID) }
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

    private func navigate(to workspaceID: String) {
        guard coordinator.workspaces.contains(where: { $0.id == workspaceID }) else { return }
        selectedWorkspaceId = workspaceID
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

    @MainActor
    private func resolveNavigationRequest() async {
        guard let request = navigationRequest,
              coordinator.connectionState == .connected else { return }
        defer { navigationRequest = nil }
        guard request.instanceId == nil || request.instanceId == coordinator.activeInstanceId else {
            coordinator.presentedError = String(localized: "The requested Aiden installation is not active.")
            return
        }

        do {
            let chat: AidenChat
            switch request.destination {
            case .newChat:
                let workspaceId = request.workspaceId ?? selectedWorkspaceId ?? coordinator.workspaces.first?.id
                guard let workspaceId,
                      coordinator.workspaces.contains(where: { $0.id == workspaceId }) else {
                    coordinator.presentedError = String(localized: "The requested workspace is unavailable. Choose or add a workspace first.")
                    return
                }
                navigate(to: workspaceId)
                chat = try await coordinator.remoteClient().createChat(workspaceId: workspaceId)
            case .chat(let chatId):
                chat = try await coordinator.remoteClient().chat(id: chatId)
                guard coordinator.workspaces.contains(where: { $0.id == chat.workspaceId }) else {
                    coordinator.presentedError = String(localized: "The chat's workspace is no longer available.")
                    return
                }
                navigate(to: chat.workspaceId)
            }
            intentStartsVoice = request.startsVoice
            intentChat = chat
        } catch {
            coordinator.presentedError = error.localizedDescription
        }
    }
}

private struct AidenWorkspacesDirectoryView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @State private var searchText = ""
    @State private var isShowingFolderBrowser = false
    @State private var isShowingNewWorkspace = false
    @State private var isConfirmingScratch = false
    @State private var newWorkspaceName = ""
    @AppStorage("aiden.defaults.workspacePermission") private var defaultWorkspacePermissionRaw = AidenWorkspacePermission.ask.rawValue

    private var filteredWorkspaces: [AidenWorkspace] {
        guard !searchText.isEmpty else { return coordinator.workspaces }
        return coordinator.workspaces.filter { workspace in
            workspace.name.localizedCaseInsensitiveContains(searchText)
                || workspace.repositoryName?.localizedCaseInsensitiveContains(searchText) == true
                || workspace.branchName?.localizedCaseInsensitiveContains(searchText) == true
        }
    }

    var body: some View {
        List {
            if filteredWorkspaces.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No Workspaces" : "No Matching Workspaces",
                    systemImage: searchText.isEmpty ? "folder" : "magnifyingglass",
                    description: Text(searchText.isEmpty
                        ? "Create a workspace or add a Mac folder to get started."
                        : "Try a different search term.")
                )
                .listRowBackground(Color.clear)
            } else {
                ForEach(filteredWorkspaces) { workspace in
                    NavigationLink {
                        AidenDirectoryWorkspaceDetail(
                            coordinator: coordinator,
                            workspace: workspace
                        )
                    } label: {
                        AidenWorkspaceRow(workspace: workspace)
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Workspaces")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Search workspaces")
        .refreshable {
            await coordinator.refreshWorkspaces()
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        newWorkspaceName = ""
                        isShowingNewWorkspace = true
                    } label: {
                        Label("New Workspace", systemImage: "folder.badge.plus")
                    }

                    Button { isConfirmingScratch = true } label: {
                        Label("New Managed Scratch", systemImage: "hammer")
                    }

                    Button { isShowingFolderBrowser = true } label: {
                        Label("Add Mac Folder", systemImage: "folder.badge.plus")
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add workspace")
            }
        }
        .sheet(isPresented: $isShowingFolderBrowser) {
            AidenFolderBrowserView(coordinator: coordinator) { workspace in
                Task {
                    _ = await applyGlobalDefault(to: workspace)
                    isShowingFolderBrowser = false
                }
            }
        }
        .alert("New Workspace", isPresented: $isShowingNewWorkspace) {
            TextField("Workspace name", text: $newWorkspaceName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines)
                Task {
                    if let workspace = await coordinator.createWorkspace(.folderless(name: name)) {
                        _ = await applyGlobalDefault(to: workspace)
                    }
                }
            }
            .disabled(newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("Creates a workspace registry entry without a Mac folder. You can add a folder later from Aiden Agent.")
        }
        .confirmationDialog(
            "Create a managed scratch workspace?",
            isPresented: $isConfirmingScratch,
            titleVisibility: .visible
        ) {
            Button("Create Managed Scratch") {
                Task {
                    if let workspace = await coordinator.createWorkspace(.scratch) {
                        _ = await applyGlobalDefault(to: workspace)
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Aiden Agent will create and manage the worktree on your Mac.")
        }
    }

    @MainActor
    private func applyGlobalDefault(to workspace: AidenWorkspace) async -> AidenWorkspace {
        let permission = AidenWorkspacePermission(rawValue: defaultWorkspacePermissionRaw) ?? .ask
        guard permission != workspace.permission else { return workspace }
        return await coordinator.updateWorkspace(workspace, permission: permission) ?? workspace
    }
}

private struct AidenDirectoryWorkspaceDetail: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace

    var body: some View {
        AidenWorkspaceDetailView(
            coordinator: coordinator,
            workspace: workspace,
            onRemoved: { dismiss() }
        )
        .id(workspace.revision)
    }
}

private struct AidenWorkspaceRow: View {
    let workspace: AidenWorkspace

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: workspace.isManagedWorktree ? "hammer.fill" : workspace.hasFolder ? "folder.fill" : "folder")
                .foregroundStyle(.tint)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 3) {
                Text(workspace.name)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Text(workspace.permission.title)
                    if let branch = workspace.branchName ?? workspace.git?.branch {
                        Text("·")
                        Text(branch)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct AidenWorkspaceDetailView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    let onRemoved: () -> Void

    @State private var isShowingSettings = false

    var body: some View {
        AidenWorkspaceChatsView(coordinator: coordinator, workspace: workspace)
        .navigationTitle(workspace.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        isShowingSettings = true
                    } label: {
                        Label("Workspace Settings", systemImage: "gearshape")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Workspace menu")
            }
        }
        .sheet(isPresented: $isShowingSettings) {
            AidenWorkspaceSettingsView(
                coordinator: coordinator,
                workspace: workspace,
                onRemoved: {
                    isShowingSettings = false
                    onRemoved()
                }
            )
        }
    }
}

private struct AidenWorkspaceSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    let onRemoved: () -> Void

    @State private var name: String
    @State private var permission: AidenWorkspacePermission
    @State private var isConfirmingRemoval = false

    init(
        coordinator: AidenRemoteCoordinator,
        workspace: AidenWorkspace,
        onRemoved: @escaping () -> Void
    ) {
        self.coordinator = coordinator
        self.workspace = workspace
        self.onRemoved = onRemoved
        _name = State(initialValue: workspace.name)
        _permission = State(initialValue: workspace.permission)
    }

    private var hasChanges: Bool {
        name.trimmingCharacters(in: .whitespacesAndNewlines) != workspace.name || permission != workspace.permission
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Workspace") {
                    TextField("Name", text: $name)
                    LabeledContent("Folder", value: workspace.hasFolder ? "Connected" : "None")
                    LabeledContent("Managed worktree", value: workspace.isManagedWorktree ? "Yes" : "No")
                    if let repository = workspace.repositoryName {
                        LabeledContent("Repository", value: repository)
                    }
                }

                Section {
                    Picker("Permission", selection: $permission) {
                        ForEach(AidenWorkspacePermission.allCases, id: \.self) { permission in
                            Text(permission.title).tag(permission)
                        }
                    }
                } header: {
                    Text("Permission")
                } footer: {
                    Text("\(permission.detail) This setting overrides the app default for this workspace.")
                }

                Section("Workspace tools") {
                    NavigationLink {
                        AidenWorkspaceFilesView(coordinator: coordinator, workspace: workspace)
                    } label: {
                        Label("Files", systemImage: "doc.text")
                    }
                    .disabled(!workspace.hasFolder)

                    NavigationLink {
                        AidenWorkspaceGitView(coordinator: coordinator, workspace: workspace)
                    } label: {
                        Label("Git", systemImage: "arrow.triangle.branch")
                    }
                    .disabled(!workspace.hasFolder)
                }

                Section {
                    Button(
                        workspace.isManagedWorktree ? "Delete Managed Worktree" : "Unregister Workspace",
                        role: .destructive
                    ) {
                        isConfirmingRemoval = true
                    }
                } footer: {
                    Text(workspace.isManagedWorktree
                         ? "Deleting an Aiden-managed worktree removes its checkout and may remove its branch when safe."
                         : "Unregistering removes this workspace from Aiden. It does not delete its folder.")
                }
            }
            .navigationTitle("Workspace Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task {
                            if await coordinator.updateWorkspace(
                                workspace,
                                name: trimmedName == workspace.name ? nil : trimmedName,
                                permission: permission == workspace.permission ? nil : permission
                            ) != nil {
                                dismiss()
                            }
                        }
                    }
                    .disabled(!hasChanges || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || coordinator.isMutating)
                }
            }
            .confirmationDialog(
                workspace.isManagedWorktree ? "Delete \(workspace.name)?" : "Unregister \(workspace.name)?",
                isPresented: $isConfirmingRemoval,
                titleVisibility: .visible
            ) {
                Button(workspace.isManagedWorktree ? "Delete Managed Worktree" : "Unregister Workspace", role: .destructive) {
                    Task {
                        let removed = workspace.isManagedWorktree
                            ? await coordinator.removeManagedWorktree(workspace)
                            : await coordinator.removeWorkspace(workspace)
                        if removed {
                            onRemoved()
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(workspace.isManagedWorktree
                     ? "This destructive Git operation is performed by Aiden Agent using its persisted worktree ownership record."
                     : "The folder and its files remain untouched on your Mac.")
            }
        }
    }
}

private struct AidenUsageView: View {
    @Environment(\.dismiss) private var dismiss
    let usage: AidenUsageSummary

    var body: some View {
        NavigationStack {
            List {
                Section("Last 30 days") {
                    LabeledContent("Requests", value: usage.totals.requests.formatted())
                    LabeledContent("Total tokens", value: usage.totals.tokens.total.formatted())
                    LabeledContent("Input", value: usage.totals.tokens.input.formatted())
                    LabeledContent("Output", value: usage.totals.tokens.output.formatted())
                    LabeledContent("Reasoning", value: usage.totals.tokens.reasoning.formatted())
                    LabeledContent("Cache read", value: usage.totals.tokens.cacheRead.formatted())
                }

                Section("Activity") {
                    LabeledContent("Active days", value: usage.totals.activeDays.formatted())
                    LabeledContent("Current streak", value: "\(usage.totals.currentStreak) days")
                    LabeledContent("Local requests", value: usage.totals.localRequests.formatted())
                    LabeledContent(
                        "Hosted cost",
                        value: usage.totals.hostedCostUsd.formatted(.currency(code: "USD"))
                    )
                }

                Section {
                    Text("These are privacy-safe aggregates recorded by Aiden Agent on your Mac. Prompts, responses, chat IDs, workspace IDs, and file paths are not part of usage data.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct AidenAppSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var coordinator: AidenRemoteCoordinator
    @Bindable var appearance: AidenAppearanceStore
    let addInstallation: () -> Void

    @State private var isShowingInstallations = false
    @State private var isShowingAppearance = false
    @AppStorage("aiden.defaults.workspacePermission") private var defaultWorkspacePermissionRaw = AidenWorkspacePermission.ask.rawValue

    var body: some View {
        NavigationStack {
            Form {
                Section("Aiden Agent") {
                    LabeledContent(
                        "Connected Mac",
                        value: coordinator.installationStore.activeInstallation?.name ?? "Not connected"
                    )
                    Button {
                        isShowingInstallations = true
                    } label: {
                        Label("Paired Installations", systemImage: "desktopcomputer")
                    }
                }

                Section {
                    Button {
                        isShowingAppearance = true
                    } label: {
                        Label("Appearance", systemImage: "circle.lefthalf.filled")
                    }
                    Picker("New workspace permission", selection: $defaultWorkspacePermissionRaw) {
                        ForEach(AidenWorkspacePermission.allCases, id: \.self) { permission in
                            Text(permission.title).tag(permission.rawValue)
                        }
                    }
                } header: {
                    Text("Global Defaults")
                } footer: {
                    Text("These are app-wide defaults. Permission, files, Git, and other workspace-specific options remain in each workspace’s ••• menu.")
                }

                Section("About") {
                    Link(destination: AppConfig.privacyPolicyURL) {
                        Label("Privacy Policy", systemImage: "hand.raised")
                    }
                    Link(destination: AppConfig.supportURL) {
                        Label("Support", systemImage: "questionmark.circle")
                    }
                    LabeledContent("License", value: "MIT")
                }
            }
            .navigationTitle("App Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .sheet(isPresented: $isShowingInstallations) {
            AidenInstallationsView(
                coordinator: coordinator,
                addInstallation: {
                    isShowingInstallations = false
                    addInstallation()
                }
            )
        }
        .sheet(isPresented: $isShowingAppearance) {
            AidenAppearanceSettingsView(appearance: appearance)
        }
    }
}

private struct AidenInstallationsView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var coordinator: AidenRemoteCoordinator
    let addInstallation: () -> Void

    @State private var installationToRemove: AidenInstallation?

    var body: some View {
        NavigationStack {
            List {
                Section("Paired installations") {
                    ForEach(coordinator.installationStore.installations) { installation in
                        Button {
                            Task {
                                await coordinator.switchInstallation(to: installation.id)
                                dismiss()
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(installation.name)
                                        .foregroundStyle(.primary)
                                    Text(installation.endpoint.host ?? installation.endpoint.absoluteString)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if coordinator.installationStore.activeInstallationId == installation.id {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                        .swipeActions {
                            Button("Forget", role: .destructive) { installationToRemove = installation }
                        }
                    }
                }

                Section {
                    Button(action: addInstallation) {
                        Label("Pair Another Aiden Agent", systemImage: "plus")
                    }
                }
            }
            .navigationTitle("Aiden Installations")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Forget this Aiden Agent?",
                isPresented: Binding(
                    get: { installationToRemove != nil },
                    set: { if !$0 { installationToRemove = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Forget Installation", role: .destructive) {
                    guard let installationToRemove else { return }
                    Task {
                        await coordinator.removeInstallation(installationToRemove.id)
                        self.installationToRemove = nil
                    }
                }
                Button("Cancel", role: .cancel) { installationToRemove = nil }
            } message: {
                Text("Its credential will be removed from this device. You can pair again from Aiden Agent settings.")
            }
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

private struct AidenFolderLocation: Hashable {
    let label: String
    let location: String
}

private struct AidenFolderBrowserView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var coordinator: AidenRemoteCoordinator
    let onCreated: (AidenWorkspace) -> Void

    @State private var roots: [AidenBrowserRoot] = []
    @State private var path: [AidenFolderLocation] = []
    @State private var errorMessage: String?
    @State private var isLoading = true

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if isLoading {
                    ProgressView("Loading approved folders…")
                } else if roots.isEmpty {
                    ContentUnavailableView(
                        "No Approved Folders",
                        systemImage: "folder.badge.questionmark",
                        description: Text("Add an approved root in Aiden Agent → Settings → Remote Access, then try again.")
                    )
                } else {
                    List(roots) { root in
                        NavigationLink(value: AidenFolderLocation(label: root.label, location: root.location)) {
                            Label(root.label, systemImage: "folder.fill")
                        }
                    }
                }
            }
            .navigationTitle("Add Mac Folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .navigationDestination(for: AidenFolderLocation.self) { location in
                AidenFolderPageView(
                    coordinator: coordinator,
                    location: location,
                    onCreated: onCreated
                )
            }
            .task { await loadRoots() }
            .alert("Couldn’t Browse Folders", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("Retry") { Task { await loadRoots() } }
                Button("Cancel", role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "Try again.")
            }
        }
    }

    private func loadRoots() async {
        isLoading = true
        defer { isLoading = false }
        do {
            roots = try await coordinator.browserRoots()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct AidenFolderPageView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let location: AidenFolderLocation
    let onCreated: (AidenWorkspace) -> Void

    @State private var page: AidenBrowserPage?
    @State private var isLoading = true
    @State private var isLoadingMore = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading folders…")
            } else if let page {
                List {
                    if !page.breadcrumbs.isEmpty {
                        Section {
                            Text(page.breadcrumbs.map(\.label).joined(separator: " › "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Section("Folders") {
                        ForEach(page.entries) { entry in
                            NavigationLink(value: AidenFolderLocation(label: entry.name, location: entry.location)) {
                                Label(entry.name, systemImage: "folder")
                            }
                        }
                        if let nextCursor = page.nextCursor {
                            Button {
                                Task { await loadMore(cursor: nextCursor) }
                            } label: {
                                if isLoadingMore { ProgressView() } else { Text("Load More") }
                            }
                            .disabled(isLoadingMore)
                        }
                    }
                }
            } else {
                ContentUnavailableView("Folder Unavailable", systemImage: "exclamationmark.folder")
            }
        }
        .navigationTitle(location.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Add This Folder") {
                    Task {
                        if let workspace = await coordinator.createSelectedFolderWorkspace(
                            location: location.location,
                            name: nil
                        ) {
                            onCreated(workspace)
                        } else {
                            errorMessage = coordinator.presentedError
                        }
                    }
                }
                .disabled(coordinator.isMutating)
            }
        }
        .task(id: location.location) { await load() }
        .alert("Couldn’t Add Folder", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("Retry") { Task { await load() } }
            Button("Cancel", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "The selection may have expired. Browse the folder again and retry.")
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            page = try await coordinator.browserChildren(location: location.location)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadMore(cursor: String) async {
        guard let page else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let next = try await coordinator.browserChildren(location: location.location, cursor: cursor)
            self.page = AidenBrowserPage(
                rootId: page.rootId,
                label: page.label,
                breadcrumbs: page.breadcrumbs,
                entries: page.entries + next.entries,
                nextCursor: next.nextCursor
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
