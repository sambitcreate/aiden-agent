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

private struct AidenChromeGlassModifier<GlassShape: InsettableShape>: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    let isInteractive: Bool
    let shape: GlassShape

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *), !reduceTransparency {
            if isInteractive {
                content.glassEffect(.regular.interactive(), in: shape)
            } else {
                content.glassEffect(.regular, in: shape)
            }
        } else if reduceTransparency {
            content
                .background(palette.raised, in: shape)
                .overlay(shape.stroke(palette.foreground.opacity(0.14), lineWidth: 0.5))
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .overlay(shape.stroke(palette.foreground.opacity(0.10), lineWidth: 0.5))
        }
    }
}

private struct AidenProminentGlassButtonModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *), !reduceTransparency {
            content.buttonStyle(.glass)
        } else if reduceTransparency {
            content
                .buttonStyle(.plain)
                .background(palette.raised, in: Capsule())
                .overlay(Capsule().stroke(palette.foreground.opacity(0.16), lineWidth: 0.5))
        } else {
            content
                .buttonStyle(.plain)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().stroke(palette.foreground.opacity(0.10), lineWidth: 0.5))
        }
    }
}

private extension View {
    func aidenLiquidGlassCapsule(tint: Color) -> some View {
        modifier(AidenLiquidGlassCapsuleModifier(tint: tint))
    }

    func aidenChromeGlass<GlassShape: InsettableShape>(
        isInteractive: Bool = false,
        in shape: GlassShape
    ) -> some View {
        modifier(AidenChromeGlassModifier(isInteractive: isInteractive, shape: shape))
    }

    func aidenProminentGlassButton() -> some View {
        modifier(AidenProminentGlassButtonModifier())
    }
}

enum AidenNewAgentChoice: String, CaseIterable, Identifiable {
    case existingWorkspace
    case newWorkspace
    case scratchWorkspace

    var id: String { rawValue }

    var title: String {
        switch self {
        case .existingWorkspace: "Existing Workspace"
        case .newWorkspace: "New Workspace"
        case .scratchWorkspace: "Managed Scratch Workspace"
        }
    }

    var detail: String {
        switch self {
        case .existingWorkspace: "Start another chat without creating a folder."
        case .newWorkspace: "Create a reusable workspace for ongoing work."
        case .scratchWorkspace: "Use an isolated workspace Aiden can clean up later."
        }
    }

    var symbol: String {
        switch self {
        case .existingWorkspace: "folder"
        case .newWorkspace: "folder.badge.plus"
        case .scratchWorkspace: "hammer.fill"
        }
    }
}

@MainActor
@Observable
private final class AidenHomeModel {
    var chats: [AidenChat] = []
    var scheduledTasks: [AidenScheduledTask] = []
    var usage: AidenUsageSummary?
    var modelCatalog: AidenModelCatalog?
    var isLoading = false
    var errorMessage: String?

    func accept(_ chat: AidenChat) {
        chats.removeAll { $0.id == chat.id }
        chats.append(chat)
        chats.sort { $0.updatedAt > $1.updatedAt }
    }

    func load(coordinator: AidenRemoteCoordinator) async {
        guard coordinator.connectionState == .connected, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let client = try coordinator.remoteClient()
            async let chatsRequest = client.chats()
            async let tasksRequest = client.scheduledTasks()
            async let catalogRequest: AidenModelCatalog? = try? await client.modelCatalog()
            let (chats, tasks, catalog) = try await (chatsRequest, tasksRequest, catalogRequest)
            self.chats = chats.sorted { $0.updatedAt > $1.updatedAt }
            scheduledTasks = tasks.sorted {
                ($0.nextRunAt ?? .distantFuture) < ($1.nextRunAt ?? .distantFuture)
            }
            if let catalog { modelCatalog = catalog }
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

@MainActor
@Observable
final class AidenWorkspaceArchiveStore {
    private struct Snapshot: Codable {
        var workspaceIDsByInstance: [String: [String]]
    }

    private static let snapshotKey = "aiden.deviceArchivedWorkspaces.v1"
    private static let disclosureKey = "aiden.deviceArchivedWorkspaces.disclosureSeen.v1"

    @ObservationIgnored private let defaults: UserDefaults
    private var workspaceIDsByInstance: [String: Set<String>]
    private(set) var hasAcknowledgedDeviceOnlyArchive: Bool

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        hasAcknowledgedDeviceOnlyArchive = defaults.bool(forKey: Self.disclosureKey)

        if let data = defaults.data(forKey: Self.snapshotKey),
           let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) {
            workspaceIDsByInstance = snapshot.workspaceIDsByInstance.reduce(into: [:]) { result, entry in
                result[entry.key] = Set(entry.value.filter { !$0.isEmpty })
            }
        } else {
            workspaceIDsByInstance = [:]
        }
    }

    func archivedWorkspaceIDs(for instanceID: String?) -> Set<String> {
        guard let instanceID, !instanceID.isEmpty else { return [] }
        return workspaceIDsByInstance[instanceID] ?? []
    }

    func isArchived(workspaceID: String, instanceID: String?) -> Bool {
        archivedWorkspaceIDs(for: instanceID).contains(workspaceID)
    }

    func acknowledgeDeviceOnlyArchive() {
        guard !hasAcknowledgedDeviceOnlyArchive else { return }
        hasAcknowledgedDeviceOnlyArchive = true
        defaults.set(true, forKey: Self.disclosureKey)
    }

    func archive(workspaceID: String, instanceID: String?) {
        guard let instanceID, !instanceID.isEmpty, !workspaceID.isEmpty else { return }
        var workspaceIDs = workspaceIDsByInstance[instanceID] ?? []
        guard workspaceIDs.insert(workspaceID).inserted else { return }
        workspaceIDsByInstance[instanceID] = workspaceIDs
        persist()
    }

    func unarchive(workspaceID: String, instanceID: String?) {
        guard let instanceID, !instanceID.isEmpty,
              var workspaceIDs = workspaceIDsByInstance[instanceID],
              workspaceIDs.remove(workspaceID) != nil else { return }
        if workspaceIDs.isEmpty {
            workspaceIDsByInstance.removeValue(forKey: instanceID)
        } else {
            workspaceIDsByInstance[instanceID] = workspaceIDs
        }
        persist()
    }

    func forget(workspaceID: String, instanceID: String?) {
        unarchive(workspaceID: workspaceID, instanceID: instanceID)
    }

    func prune(instanceID: String?, validWorkspaceIDs: Set<String>) {
        guard let instanceID, !instanceID.isEmpty,
              let current = workspaceIDsByInstance[instanceID] else { return }
        let pruned = current.intersection(validWorkspaceIDs)
        guard pruned != current else { return }
        if pruned.isEmpty {
            workspaceIDsByInstance.removeValue(forKey: instanceID)
        } else {
            workspaceIDsByInstance[instanceID] = pruned
        }
        persist()
    }

    private func persist() {
        let snapshot = Snapshot(
            workspaceIDsByInstance: workspaceIDsByInstance.mapValues { $0.sorted() }
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: Self.snapshotKey)
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
    @Namespace private var newAgentTransition
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

    private var archivedWorkspaceIDs: Set<String> {
        workspaceArchiveStore.archivedWorkspaceIDs(for: coordinator.activeInstanceId)
    }

    private var workspaceArchiveStore: AidenWorkspaceArchiveStore {
        coordinator.workspaceArchiveStore
    }

    private var activeWorkspaces: [AidenWorkspace] {
        coordinator.workspaces.filter { !archivedWorkspaceIDs.contains($0.id) }
    }

    private var activeWorkspaceIDs: [String] {
        activeWorkspaces.map(\.id)
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
                AidenUsageView(usage: usage, providers: homeModel.modelCatalog?.providers ?? [])
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
        }
        .sheet(isPresented: $isShowingExistingWorkspacePicker) {
            NavigationStack {
                List(activeWorkspaces) { workspace in
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
                    autoStartVoice: intentStartsVoice,
                    onChatUpdated: { homeModel.accept($0) }
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
        .onChange(of: coordinator.workspaces.map(\.id)) { _, _ in
            syncArchivedWorkspaceProjection()
            reconcileNavigation(workspaceIDs: activeWorkspaceIDs)
        }
        .onChange(of: coordinator.workspaceSnapshotRevision) { _, _ in
            syncArchivedWorkspaceProjection()
            reconcileNavigation(workspaceIDs: activeWorkspaceIDs)
        }
        .onChange(of: archivedWorkspaceIDs) { _, _ in
            syncArchivedWorkspaceProjection()
            reconcileNavigation(workspaceIDs: activeWorkspaceIDs)
        }
        .onChange(of: coordinator.activeInstanceId) { _, _ in
            syncArchivedWorkspaceProjection()
            reconcileNavigation(workspaceIDs: activeWorkspaceIDs)
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
                    workspaceIDs: workspaceIDs
                )
            }
        }
        .task {
            syncArchivedWorkspaceProjection()
            reconcileNavigation(workspaceIDs: activeWorkspaceIDs)
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
            homeList { chat in
                NavigationLink {
                    AidenChatDetailView(
                        coordinator: coordinator,
                        chat: chat,
                        onChatUpdated: { homeModel.accept($0) }
                    )
                } label: {
                    homeChatRow(chat)
                }
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

    private var filteredChats: [AidenChat] {
        let activeWorkspaceIDSet = Set(activeWorkspaceIDs)
        let visibleChats = homeModel.chats.filter { activeWorkspaceIDSet.contains($0.workspaceId) }
        guard !searchText.isEmpty else { return visibleChats }
        return visibleChats.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
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
            .disabled(coordinator.connectionState != .connected)

            Button { isShowingUsage = true } label: {
                homeNavigationRow(title: "Usage", systemImage: "chart.bar.xaxis")
            }
            .buttonStyle(.plain)
            .disabled(homeModel.usage == nil)

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
            Image(systemName: "square.and.pencil")
                .font(.title2.weight(.semibold))
                .foregroundStyle(palette.foreground)
                .frame(width: 42, height: 50)
                .contentShape(Rectangle())
        }
        .aidenProminentGlassButton()
        .disabled(coordinator.connectionState != .connected || coordinator.isMutating || isCreatingAgent)
        .accessibilityLabel("New Agent")
        .accessibilityHint("Choose where the new agent should work.")
        .matchedTransitionSource(id: "AidenNewAgentOptions", in: newAgentTransition)
        .popover(isPresented: $isShowingNewAgentChoices, arrowEdge: .bottom) {
            AidenNewAgentPopover(
                canUseExistingWorkspace: !activeWorkspaces.isEmpty,
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
           !archivedWorkspaceIDs.contains(workspaceID),
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
        guard activeWorkspaceIDs.contains(workspaceID) else { return }
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

    private func reconcileNavigation(workspaceIDs: [String]) {
        selectedWorkspaceId = AidenWorkspaceNavigation.reconciledSelection(
            current: selectedWorkspaceId,
            workspaceIDs: workspaceIDs
        )
        compactWorkspacePath = AidenWorkspaceNavigation.reconciledCompactPath(
            current: compactWorkspacePath,
            workspaceIDs: workspaceIDs
        )
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
                navigate(to: workspaceId)
                chat = try await coordinator.remoteClient().createChat(workspaceId: workspaceId)
            case .chat(let chatId):
                chat = try await coordinator.remoteClient().chat(id: chatId)
                guard activeWorkspaceIDs.contains(chat.workspaceId) else {
                    if archivedWorkspaceIDs.contains(chat.workspaceId) {
                        coordinator.presentedError = String(localized: "That chat belongs to a workspace archived on this device. Unarchive it from Workspaces to open the chat.")
                        return
                    }
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

private struct AidenNewAgentPopover: View {
    @Environment(\.aidenPalette) private var palette

    let canUseExistingWorkspace: Bool
    let onSelect: (AidenNewAgentChoice) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 5) {
                Text("New Agent")
                    .font(.title3.bold())
                    .foregroundStyle(palette.foreground)

                Text("Choose where Aiden should work.")
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
            }
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 10)

            ForEach(Array(AidenNewAgentChoice.allCases.enumerated()), id: \.element.id) { index, choice in
                Button {
                    onSelect(choice)
                } label: {
                    HStack(alignment: .center, spacing: 13) {
                        Image(systemName: choice.symbol)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(palette.accent)
                            .frame(width: 38, height: 38)
                            .background(palette.accent.opacity(0.12), in: Circle())

                        VStack(alignment: .leading, spacing: 3) {
                            Text(choice.title)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(palette.foreground)
                                .lineLimit(1)

                            Text(detail(for: choice))
                                .font(.caption)
                                .foregroundStyle(palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        Spacer(minLength: 6)

                        Image(systemName: "chevron.forward")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.secondary)
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(choice == .existingWorkspace && !canUseExistingWorkspace)
                .opacity(choice == .existingWorkspace && !canUseExistingWorkspace ? 0.45 : 1)
                .accessibilityHint(detail(for: choice))

                if index < AidenNewAgentChoice.allCases.count - 1 {
                    Divider()
                        .overlay(palette.secondary.opacity(0.18))
                        .padding(.leading, 69)
                }
            }
        }
        .padding(.bottom, 8)
        .background(palette.canvas.opacity(0.001))
        .accessibilityElement(children: .contain)
    }

    private func detail(for choice: AidenNewAgentChoice) -> String {
        if choice == .existingWorkspace, !canUseExistingWorkspace {
            return String(localized: "Add a workspace before using this option.")
        }
        return choice.detail
    }
}

private struct AidenWorkspacesDirectoryView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Bindable var archiveStore: AidenWorkspaceArchiveStore
    @State private var searchText = ""
    @State private var isShowingFolderBrowser = false
    @State private var isShowingNewWorkspace = false
    @State private var isConfirmingScratch = false
    @State private var newWorkspaceName = ""
    @State private var workspacePendingRename: AidenWorkspace?
    @State private var workspacePendingFirstArchive: AidenWorkspace?
    @State private var workspacePendingRemoval: AidenWorkspace?
    @State private var renameText = ""
    @State private var retainedRenameDraftWorkspaceID: String?
    @AppStorage("aiden.defaults.workspacePermission") private var defaultWorkspacePermissionRaw = AidenWorkspacePermission.ask.rawValue

    private var archivedWorkspaceIDs: Set<String> {
        archiveStore.archivedWorkspaceIDs(for: coordinator.activeInstanceId)
    }

    private var activeWorkspaces: [AidenWorkspace] {
        coordinator.workspaces.filter { !archivedWorkspaceIDs.contains($0.id) }
    }

    private var archivedWorkspaces: [AidenWorkspace] {
        coordinator.workspaces.filter { archivedWorkspaceIDs.contains($0.id) }
    }

    private var filteredWorkspaces: [AidenWorkspace] {
        guard !searchText.isEmpty else { return activeWorkspaces }
        return activeWorkspaces.filter { workspace in
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
                    interactiveRow(workspace, isArchived: false)
                }
            }

            if searchText.isEmpty {
                Section {
                    NavigationLink {
                        AidenArchivedWorkspacesView(
                            coordinator: coordinator,
                            workspaces: archivedWorkspaces,
                            row: interactiveRow
                        )
                    } label: {
                        Label("Archived Workspaces", systemImage: "archivebox")
                    }
                } footer: {
                    Text("Archived workspaces and their chats are hidden only on this device.")
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
        .alert(
            "Rename Workspace",
            isPresented: Binding(
                get: { workspacePendingRename != nil },
                set: { if !$0 { workspacePendingRename = nil } }
            )
        ) {
            TextField("Workspace name", text: $renameText)
            Button("Cancel", role: .cancel) {
                retainedRenameDraftWorkspaceID = nil
                workspacePendingRename = nil
            }
            Button("Rename") {
                guard let workspace = workspacePendingRename else { return }
                let trimmedName = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                Task {
                    if await coordinator.updateWorkspace(workspace, name: trimmedName) != nil {
                        retainedRenameDraftWorkspaceID = nil
                    }
                    workspacePendingRename = nil
                }
            }
            .disabled(
                renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || renameText.trimmingCharacters(in: .whitespacesAndNewlines) == workspacePendingRename?.name
                    || coordinator.connectionState != .connected
                    || coordinator.isMutating
            )
        } message: {
            Text("This updates the workspace name in Aiden Agent on your Mac and paired clients. It does not rename the folder on disk.")
        }
        .alert(
            "Archive on This Device?",
            isPresented: Binding(
                get: { workspacePendingFirstArchive != nil },
                set: { if !$0 { workspacePendingFirstArchive = nil } }
            )
        ) {
            Button("Cancel", role: .cancel) { workspacePendingFirstArchive = nil }
            Button("Archive on This Device") {
                guard let workspace = workspacePendingFirstArchive else { return }
                archiveStore.acknowledgeDeviceOnlyArchive()
                archiveStore.archive(
                    workspaceID: workspace.id,
                    instanceID: coordinator.activeInstanceId
                )
                workspacePendingFirstArchive = nil
            }
        } message: {
            Text("This hides the workspace and its chats only on this iPhone or iPad. It stays available in Aiden Agent on your Mac and on other devices.")
        }
        .alert(
            "Remove from Aiden Agent?",
            isPresented: Binding(
                get: { workspacePendingRemoval != nil },
                set: { if !$0 { workspacePendingRemoval = nil } }
            )
        ) {
            Button("Cancel", role: .cancel) { workspacePendingRemoval = nil }
            Button("Remove from Aiden Agent", role: .destructive) {
                guard let workspace = workspacePendingRemoval else { return }
                workspacePendingRemoval = nil
                Task {
                    if await coordinator.removeWorkspace(workspace) {
                        archiveStore.forget(
                            workspaceID: workspace.id,
                            instanceID: coordinator.activeInstanceId
                        )
                    }
                }
            }
            .disabled(coordinator.connectionState != .connected || coordinator.isMutating)
        } message: {
            Text("This unregisters the workspace from Aiden Agent and paired clients. Its folder, files, and chats stay on your Mac, but its chats will no longer be listed. Delete the folder separately in Finder if you no longer need it.")
        }
    }

    private func interactiveRow(_ workspace: AidenWorkspace, isArchived: Bool) -> some View {
        AidenWorkspaceInteractiveRow(
            coordinator: coordinator,
            workspace: workspace,
            isArchived: isArchived,
            onRename: { requestRename(workspace) },
            onToggleArchive: { toggleArchive(workspace, isArchived: isArchived) },
            onRemove: workspace.isManagedWorktree || coordinator.workspaces.count <= 1
                ? nil
                : { workspacePendingRemoval = workspace }
        )
    }

    private func requestRename(_ workspace: AidenWorkspace) {
        if retainedRenameDraftWorkspaceID != workspace.id {
            renameText = workspace.name
        }
        retainedRenameDraftWorkspaceID = workspace.id
        workspacePendingRename = workspace
    }

    private func toggleArchive(_ workspace: AidenWorkspace, isArchived: Bool) {
        if isArchived {
            archiveStore.unarchive(
                workspaceID: workspace.id,
                instanceID: coordinator.activeInstanceId
            )
        } else if archiveStore.hasAcknowledgedDeviceOnlyArchive {
            archiveStore.archive(
                workspaceID: workspace.id,
                instanceID: coordinator.activeInstanceId
            )
        } else {
            workspacePendingFirstArchive = workspace
        }
    }

    @MainActor
    private func applyGlobalDefault(to workspace: AidenWorkspace) async -> AidenWorkspace {
        let permission = AidenWorkspacePermission(rawValue: defaultWorkspacePermissionRaw) ?? .ask
        guard permission != workspace.permission else { return workspace }
        return await coordinator.updateWorkspace(workspace, permission: permission) ?? workspace
    }
}

private struct AidenArchivedWorkspacesView<Row: View>: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspaces: [AidenWorkspace]
    @ViewBuilder let row: (AidenWorkspace, Bool) -> Row
    @State private var searchText = ""

    private var filteredWorkspaces: [AidenWorkspace] {
        guard !searchText.isEmpty else { return workspaces }
        return workspaces.filter { workspace in
            workspace.name.localizedCaseInsensitiveContains(searchText)
                || workspace.repositoryName?.localizedCaseInsensitiveContains(searchText) == true
                || workspace.branchName?.localizedCaseInsensitiveContains(searchText) == true
        }
    }

    var body: some View {
        List {
            if filteredWorkspaces.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No Archived Workspaces" : "No Matching Workspaces",
                    systemImage: searchText.isEmpty ? "archivebox" : "magnifyingglass",
                    description: Text(searchText.isEmpty
                        ? "Workspaces archived on this device appear here."
                        : "Try a different search term.")
                )
                .listRowBackground(Color.clear)
            } else {
                ForEach(filteredWorkspaces) { workspace in
                    row(workspace, true)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Archived Workspaces")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Search archived workspaces")
        .refreshable { await coordinator.refreshWorkspaces() }
    }
}

private struct AidenWorkspaceInteractiveRow: View {
    @Environment(\.aidenPalette) private var palette
    @Bindable var coordinator: AidenRemoteCoordinator
    let workspace: AidenWorkspace
    let isArchived: Bool
    let onRename: () -> Void
    let onToggleArchive: () -> Void
    let onRemove: (() -> Void)?

    private var serverMutationDisabled: Bool {
        coordinator.connectionState != .connected || coordinator.isMutating
    }

    var body: some View {
        Group {
            if isArchived {
                Button(action: onToggleArchive) {
                    AidenWorkspaceRow(workspace: workspace)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Unarchives this workspace on this device.")
            } else {
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
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button(action: onRename) {
                Label("Rename", systemImage: "pencil")
            }
            .disabled(serverMutationDisabled)
            .tint(palette.accent)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if let onRemove {
                Button(role: .destructive, action: onRemove) {
                    Label("Remove from Agent", systemImage: "minus.circle")
                }
                .disabled(serverMutationDisabled)
                .tint(palette.danger)
            }

            Button(action: onToggleArchive) {
                Label(
                    isArchived ? "Unarchive" : "Archive",
                    systemImage: isArchived ? "tray.and.arrow.up" : "archivebox"
                )
            }
            .tint(palette.warning)
        }
        .contextMenu {
            Button(action: onRename) {
                Label("Rename", systemImage: "pencil")
            }
            .disabled(serverMutationDisabled)

            Button(action: onToggleArchive) {
                Label(
                    isArchived ? "Unarchive on This Device" : "Archive on This Device",
                    systemImage: isArchived ? "tray.and.arrow.up" : "archivebox"
                )
            }

            if let onRemove {
                Divider()
                Button(role: .destructive, action: onRemove) {
                    Label("Remove from Aiden Agent", systemImage: "minus.circle")
                }
                .disabled(serverMutationDisabled)
            }
        }
        .accessibilityAction(named: Text("Rename workspace"), onRename)
        .accessibilityAction(
            named: Text(isArchived ? "Unarchive on this device" : "Archive on this device"),
            onToggleArchive
        )
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
                Section {
                    TextField("Name", text: $name)
                    LabeledContent("Folder", value: workspace.hasFolder ? "Connected" : "None")
                    LabeledContent("Managed worktree", value: workspace.isManagedWorktree ? "Yes" : "No")
                    if let repository = workspace.repositoryName {
                        LabeledContent("Repository", value: repository)
                    }
                } header: {
                    Text("Workspace")
                } footer: {
                    Text("Renaming updates Aiden Agent and paired clients. It does not rename the folder on disk.")
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

                if workspace.isManagedWorktree || coordinator.workspaces.count > 1 {
                    Section {
                        Button(
                            workspace.isManagedWorktree ? "Delete Managed Worktree" : "Remove from Aiden Agent",
                            role: .destructive
                        ) {
                            isConfirmingRemoval = true
                        }
                    } footer: {
                        Text(workspace.isManagedWorktree
                             ? "Deleting an Aiden-managed worktree removes its checkout and may remove its branch when safe."
                             : "Removing unregisters this workspace from Aiden Agent and paired clients. Its folder, files, and chats stay on your Mac, but its chats will no longer be listed.")
                    }
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
                workspace.isManagedWorktree ? "Delete \(workspace.name)?" : "Remove \(workspace.name) from Aiden Agent?",
                isPresented: $isConfirmingRemoval,
                titleVisibility: .visible
            ) {
                Button(workspace.isManagedWorktree ? "Delete Managed Worktree" : "Remove from Aiden Agent", role: .destructive) {
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
                     : "The folder, its files, and chats remain on your Mac, but the chats will no longer be listed. Delete the folder separately in Finder if you no longer need it.")
            }
        }
    }
}

private struct AidenUsageView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    let usage: AidenUsageSummary
    let providers: [AidenProvider]

    private var heatmapDays: [AidenUsageHeatmapDay] {
        AidenUsagePresentation.heatmapDays(for: usage)
    }

    private var maximumDailyTokens: Int {
        max(heatmapDays.map(\.tokens).max() ?? 0, 1)
    }

    private var completionRate: Double {
        AidenUsagePresentation.ratio(
            usage.totals.completedRequests,
            of: usage.totals.requests
        )
    }

    private var localRequestShare: Double {
        AidenUsagePresentation.ratio(
            usage.totals.localRequests,
            of: usage.totals.requests
        )
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                    usageHero
                    overviewGrid
                    tokenActivitySection
                    activityInsightsSection
                    modelSection
                    privacyNote
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 36)
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle("Usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var usageHero: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Your Activity")
                .font(.title2.weight(.bold))
                .foregroundStyle(palette.foreground)

            Text(AidenUsagePresentation.dateRangeText(for: usage))
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var overviewGrid: some View {
        VStack(spacing: 12) {
            LazyVGrid(
                columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                spacing: 12
            ) {
                metricCard(
                    value: usage.totals.requests.formatted(),
                    label: "Requests",
                    symbol: "bolt.fill"
                )
                metricCard(
                    value: usage.totals.activeDays.formatted(),
                    label: "Active days",
                    symbol: "calendar"
                )
                metricCard(
                    value: AidenUsagePresentation.dayCount(usage.totals.currentStreak),
                    label: "Current streak",
                    symbol: "flame"
                )
                metricCard(
                    value: AidenUsagePresentation.dayCount(usage.totals.longestStreak),
                    label: "Longest streak",
                    symbol: "trophy"
                )
            }

            HStack(alignment: .center, spacing: 14) {
                Image(systemName: "circle.hexagongrid.fill")
                    .font(.title2)
                    .foregroundStyle(palette.accent)
                    .frame(width: 34, height: 34)

                VStack(alignment: .leading, spacing: 3) {
                    Text(AidenUsagePresentation.tokenCount(usage.totals.tokens.total))
                        .font(.title2.weight(.bold).monospacedDigit())
                        .foregroundStyle(palette.foreground)
                        .contentTransition(.numericText())
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                        .allowsTightening(true)
                        .layoutPriority(1)
                    Text("Total tokens")
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(18)
            .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
            .aidenUsageCard(palette: palette)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(usage.totals.tokens.total.formatted()) total tokens")
        }
    }

    private func metricCard(value: String, label: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.accent)
                .frame(width: 30, height: 30)
                .background(palette.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                Text(value)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(palette.foreground)
                    .contentTransition(.numericText())
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 118, alignment: .leading)
        .aidenUsageCard(palette: palette)
        .accessibilityElement(children: .combine)
    }

    private var tokenActivitySection: some View {
        usageSection(title: "Token activity") {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Daily totals")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                    Spacer()
                    Text("Last 30 days")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(palette.secondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(palette.sidebar, in: Capsule())
                }

                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 10),
                    spacing: 6
                ) {
                    ForEach(heatmapDays) { day in
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(activityColor(tokens: day.tokens))
                            .aspectRatio(1, contentMode: .fit)
                            .accessibilityElement()
                            .accessibilityLabel("\(day.date), \(day.tokens.formatted()) tokens")
                    }
                }

                HStack(spacing: 6) {
                    Text("Less")
                    ForEach(0..<5, id: \.self) { level in
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(activityColor(level: level))
                            .frame(width: 14, height: 14)
                    }
                    Text("More")
                }
                .font(.caption2)
                .foregroundStyle(palette.secondary)

                Divider().overlay(palette.secondary.opacity(0.18))

                tokenBreakdown
            }
            .padding(18)
            .aidenUsageCard(palette: palette)
        }
    }

    private var tokenBreakdown: some View {
        VStack(spacing: 14) {
            usageValueRow("Input", value: usage.totals.tokens.input.formatted(), color: palette.accent)
            usageValueRow("Output", value: usage.totals.tokens.output.formatted(), color: palette.success)
            usageValueRow("Reasoning", value: usage.totals.tokens.reasoning.formatted(), color: palette.warning)
            usageValueRow("Cache read", value: usage.totals.tokens.cacheRead.formatted(), color: palette.secondary)
        }
    }

    private var activityInsightsSection: some View {
        usageSection(title: "Activity insights") {
            VStack(spacing: 0) {
                insightRow("Completed requests", value: completionRate.formatted(.percent.precision(.fractionLength(0))))
                insightDivider
                insightRow("Local model share", value: localRequestShare.formatted(.percent.precision(.fractionLength(0))))
                insightDivider
                insightRow("Failed requests", value: usage.totals.failedRequests.formatted())
                insightDivider
                insightRow(
                    "Hosted cost",
                    value: usage.totals.hostedCostUsd.formatted(.currency(code: "USD"))
                )
            }
            .padding(.horizontal, 18)
            .aidenUsageCard(palette: palette)
        }
    }

    @ViewBuilder
    private var modelSection: some View {
        if !usage.models.isEmpty {
            usageSection(title: "Most used models") {
                VStack(spacing: 0) {
                    ForEach(Array(usage.models.prefix(5).enumerated()), id: \.element.id) { index, model in
                        HStack(spacing: 12) {
                            AidenProviderIcon(
                                providerID: model.providerId,
                                providerLabel: model.providerLabel,
                                modelID: model.modelId,
                                artwork: providers.first { $0.id == model.providerId }?.artwork,
                                size: 20,
                                color: palette.accent
                            )
                                .frame(width: 34, height: 34)
                                .background(palette.sidebar, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.modelLabel)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(palette.foreground)
                                    .lineLimit(1)
                                Text(model.local ? "\(model.providerLabel) · Local" : model.providerLabel)
                                    .font(.caption)
                                    .foregroundStyle(palette.secondary)
                                    .lineLimit(1)
                            }

                            Spacer(minLength: 8)

                            Text("\(model.requests.formatted()) runs")
                                .font(.subheadline)
                                .foregroundStyle(palette.secondary)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                        .padding(.vertical, 14)

                        if index < min(usage.models.count, 5) - 1 {
                            insightDivider
                        }
                    }
                }
                .padding(.horizontal, 18)
                .aidenUsageCard(palette: palette)
            }
        }
    }

    private var privacyNote: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "lock.shield")
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.accent)
                .frame(width: 28)

            Text("Privacy-safe aggregates are recorded by Aiden Agent on your Mac. Prompts, responses, chat IDs, workspace IDs, and file paths are not included.")
                .font(.footnote)
                .foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func usageSection<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(palette.secondary)
                .padding(.leading, 4)
            content()
        }
    }

    private func usageValueRow(_ label: String, value: String, color: Color) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .foregroundStyle(palette.foreground)
            Spacer()
            Text(value)
                .foregroundStyle(palette.secondary)
                .monospacedDigit()
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }

    private func insightRow(_ label: String, value: String) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .foregroundStyle(palette.foreground)
            Spacer(minLength: 12)
            Text(value)
                .foregroundStyle(palette.secondary)
                .monospacedDigit()
        }
        .font(.body)
        .padding(.vertical, 16)
        .accessibilityElement(children: .combine)
    }

    private var insightDivider: some View {
        Divider().overlay(palette.secondary.opacity(0.18))
    }

    private func activityColor(tokens: Int) -> Color {
        guard tokens > 0 else { return palette.sidebar }
        let normalized = min(Double(tokens) / Double(maximumDailyTokens), 1)
        return palette.accent.opacity(0.22 + (0.78 * normalized.squareRoot()))
    }

    private func activityColor(level: Int) -> Color {
        guard level > 0 else { return palette.sidebar }
        return palette.accent.opacity(0.18 + (Double(level) * 0.205))
    }
}

struct AidenUsageHeatmapDay: Identifiable, Equatable {
    let date: String
    let tokens: Int

    var id: String { date }
}

enum AidenUsagePresentation {
    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let displayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = .current
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return formatter
    }()

    static func ratio(_ value: Int, of total: Int) -> Double {
        guard total > 0 else { return 0 }
        return min(max(Double(value) / Double(total), 0), 1)
    }

    static func dayCount(_ value: Int) -> String {
        value == 1 ? "1 day" : "\(value) days"
    }

    static func tokenCount(_ value: Int, locale: Locale = .current) -> String {
        value.formatted(.number.locale(locale).grouping(.automatic))
    }

    static func dateRangeText(for usage: AidenUsageSummary) -> String {
        guard let start = dateFormatter.date(from: usage.startDate),
              let end = dateFormatter.date(from: usage.endDate) else {
            return String(localized: "Last 30 days")
        }
        return "\(displayFormatter.string(from: start))–\(displayFormatter.string(from: end))"
    }

    static func heatmapDays(for usage: AidenUsageSummary) -> [AidenUsageHeatmapDay] {
        let totalsByDate = Dictionary(uniqueKeysWithValues: usage.days.map { ($0.date, $0.tokens.total) })
        guard let start = dateFormatter.date(from: usage.startDate),
              let end = dateFormatter.date(from: usage.endDate),
              start <= end else {
            return usage.days.map { AidenUsageHeatmapDay(date: $0.date, tokens: $0.tokens.total) }
        }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var date = start
        var result: [AidenUsageHeatmapDay] = []
        while date <= end, result.count < 366 {
            let key = dateFormatter.string(from: date)
            result.append(AidenUsageHeatmapDay(date: key, tokens: totalsByDate[key] ?? 0))
            guard let next = calendar.date(byAdding: .day, value: 1, to: date) else { break }
            date = next
        }
        return result
    }
}

private extension View {
    func aidenUsageCard(palette: AidenPalette) -> some View {
        background(
            palette.raised,
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(palette.foreground.opacity(0.06), lineWidth: 0.5)
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
                        .disabled(coordinator.isMutating || coordinator.connectionState == .connecting)
                        .swipeActions {
                            Button("Forget", role: .destructive) { installationToRemove = installation }
                                .disabled(coordinator.isMutating)
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
