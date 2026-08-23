import SwiftUI

enum AidenProductArea: String, Codable, CaseIterable, Identifiable, Sendable {
    case bots
    case workspaces

    var id: String { rawValue }

    var title: String {
        switch self {
        case .bots: "Bots"
        case .workspaces: "Workspaces"
        }
    }

    var detail: String {
        switch self {
        case .bots: "Reusable helpers and their conversations"
        case .workspaces: "Projects, folders, Files, review, and Git"
        }
    }

    var symbol: String {
        switch self {
        case .bots: "person.2.fill"
        case .workspaces: "folder.fill"
        }
    }
}

enum AidenBotsAvailability: Equatable, Sendable {
    case available(canWrite: Bool)
    case unsupported
    case notGranted

    var canOpen: Bool {
        if case .available = self { return true }
        return false
    }

    var canWrite: Bool {
        if case .available(canWrite: true) = self { return true }
        return false
    }

    var unavailableMessage: String? {
        switch self {
        case .available:
            nil
        case .unsupported:
            "Bots need a newer version of Aiden Agent on your Mac."
        case .notGranted:
            "Approve Bot access on your Mac, or pair this phone again."
        }
    }

    static func resolve(_ installation: AidenInstallation?) -> Self {
        guard let installation,
              let supported = installation.serverCapabilities,
              supported.contains(.botRead) else {
            return .unsupported
        }
        guard installation.deviceCapabilities.contains(.botRead) else {
            return .notGranted
        }
        return .available(canWrite: installation.canWriteBots)
    }
}

enum AidenProductRouting {
    static func area(for chat: AidenChat) -> AidenProductArea {
        chat.isBotChat ? .bots : .workspaces
    }
}

func aidenBotChatAllowsMutations(
    canWrite: Bool,
    fullAccessActionsAllowed: Bool,
    botHealth: AidenBotHealth,
    botAccessMode: AidenBotAccessMode,
    chatAccessMode: AidenBotChatAccessMode?
) -> Bool {
    guard canWrite, botHealth != .archived else { return false }
    if fullAccessActionsAllowed { return true }
    return chatAccessMode == .custom || botAccessMode == .custom
}

@Observable
final class AidenProductNavigationStore {
    static let shared = AidenProductNavigationStore()

    private struct Snapshot: Codable {
        var areasByInstance: [String: AidenProductArea] = [:]
        var selectedWorkspaceByInstance: [String: String] = [:]
        var compactWorkspacePathByInstance: [String: [String]] = [:]
        var compactBotPathByInstance: [String: [String]] = [:]
        var selectedBotByScope: [String: String]?
    }

    private static let snapshotKey = "aiden.product-navigation.v1"
    @ObservationIgnored private let defaults: UserDefaults
    private var snapshot: Snapshot

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.snapshotKey),
           data.count <= 1_048_576,
           let decoded = try? JSONDecoder().decode(Snapshot.self, from: data) {
            snapshot = Self.sanitized(decoded)
        } else {
            snapshot = Snapshot()
        }
    }

    func area(for instanceID: String?, botsAvailable: Bool) -> AidenProductArea {
        guard let instanceID = Self.safeID(instanceID) else { return .workspaces }
        let preferred = snapshot.areasByInstance[instanceID] ?? (botsAvailable ? .bots : .workspaces)
        return preferred == .bots && !botsAvailable ? .workspaces : preferred
    }

    func select(_ area: AidenProductArea, for instanceID: String?, botsAvailable: Bool) {
        guard let instanceID = Self.safeID(instanceID),
              area != .bots || botsAvailable else { return }
        guard snapshot.areasByInstance[instanceID] != area else { return }
        snapshot.areasByInstance[instanceID] = area
        persist()
    }

    func selectedWorkspace(for instanceID: String?) -> String? {
        guard let instanceID = Self.safeID(instanceID) else { return nil }
        return snapshot.selectedWorkspaceByInstance[instanceID]
    }

    func setSelectedWorkspace(_ workspaceID: String?, for instanceID: String?) {
        guard let instanceID = Self.safeID(instanceID) else { return }
        if let workspaceID = Self.safeID(workspaceID) {
            snapshot.selectedWorkspaceByInstance[instanceID] = workspaceID
        } else {
            snapshot.selectedWorkspaceByInstance.removeValue(forKey: instanceID)
        }
        persist()
    }

    func compactWorkspacePath(for instanceID: String?) -> [String] {
        guard let instanceID = Self.safeID(instanceID) else { return [] }
        return snapshot.compactWorkspacePathByInstance[instanceID] ?? []
    }

    func setCompactWorkspacePath(_ path: [String], for instanceID: String?) {
        setPath(path, in: \Snapshot.compactWorkspacePathByInstance, for: instanceID)
    }

    func compactBotPath(for instanceID: String?) -> [String] {
        guard let instanceID = Self.safeID(instanceID) else { return [] }
        return snapshot.compactBotPathByInstance[instanceID] ?? []
    }

    func setCompactBotPath(_ path: [String], for instanceID: String?) {
        setPath(path, in: \Snapshot.compactBotPathByInstance, for: instanceID)
    }

    func selectedBot(for instanceID: String?, deviceID: String?) -> String? {
        guard let key = Self.scopeKey(instanceID: instanceID, deviceID: deviceID) else { return nil }
        return snapshot.selectedBotByScope?[key]
    }

    func setSelectedBot(_ botID: String?, for instanceID: String?, deviceID: String?) {
        guard let key = Self.scopeKey(instanceID: instanceID, deviceID: deviceID) else { return }
        var values = snapshot.selectedBotByScope ?? [:]
        if let botID = Self.safeID(botID) {
            values[key] = botID
        } else {
            values.removeValue(forKey: key)
        }
        snapshot.selectedBotByScope = values.isEmpty ? nil : values
        persist()
    }

    func purge(instanceID: String) {
        snapshot.areasByInstance.removeValue(forKey: instanceID)
        snapshot.selectedWorkspaceByInstance.removeValue(forKey: instanceID)
        snapshot.compactWorkspacePathByInstance.removeValue(forKey: instanceID)
        snapshot.compactBotPathByInstance.removeValue(forKey: instanceID)
        let prefix = "\(instanceID.unicodeScalars.count):\(instanceID):"
        snapshot.selectedBotByScope = snapshot.selectedBotByScope?.filter { !$0.key.hasPrefix(prefix) }
        persist()
    }

    private func setPath(
        _ path: [String],
        in keyPath: WritableKeyPath<Snapshot, [String: [String]]>,
        for instanceID: String?
    ) {
        guard let instanceID = Self.safeID(instanceID) else { return }
        let sanitized = Array(path.compactMap(Self.safeID).suffix(16))
        if sanitized.isEmpty {
            snapshot[keyPath: keyPath].removeValue(forKey: instanceID)
        } else {
            snapshot[keyPath: keyPath][instanceID] = sanitized
        }
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(snapshot), data.count <= 1_048_576 else { return }
        defaults.set(data, forKey: Self.snapshotKey)
    }

    private static func sanitized(_ value: Snapshot) -> Snapshot {
        let instanceIDs = Set(
            value.areasByInstance.keys.compactMap(safeID)
                + value.selectedWorkspaceByInstance.keys.compactMap(safeID)
                + value.compactWorkspacePathByInstance.keys.compactMap(safeID)
                + value.compactBotPathByInstance.keys.compactMap(safeID)
        )
        var result = instanceIDs.prefix(64).reduce(into: Snapshot()) { result, instanceID in
            if let area = value.areasByInstance[instanceID] {
                result.areasByInstance[instanceID] = area
            }
            if let workspaceID = safeID(value.selectedWorkspaceByInstance[instanceID]) {
                result.selectedWorkspaceByInstance[instanceID] = workspaceID
            }
            let workspacePath = Array(
                (value.compactWorkspacePathByInstance[instanceID] ?? []).compactMap(safeID).suffix(16)
            )
            if !workspacePath.isEmpty {
                result.compactWorkspacePathByInstance[instanceID] = workspacePath
            }
            let botPath = Array(
                (value.compactBotPathByInstance[instanceID] ?? []).compactMap(safeID).suffix(16)
            )
            if !botPath.isEmpty {
                result.compactBotPathByInstance[instanceID] = botPath
            }
        }
        let selected = (value.selectedBotByScope ?? [:]).reduce(into: [String: String]()) { values, entry in
            guard values.count < 64, safeID(entry.key) != nil, let botID = safeID(entry.value) else { return }
            values[entry.key] = botID
        }
        result.selectedBotByScope = selected.isEmpty ? nil : selected
        return result
    }

    private static func safeID(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.unicodeScalars.count <= 160,
              value.unicodeScalars.allSatisfy({ scalar in
                  CharacterSet.alphanumerics.contains(scalar)
                      || "._:-".unicodeScalars.contains(scalar)
              }) else { return nil }
        return value
    }

    private static func scopeKey(instanceID: String?, deviceID: String?) -> String? {
        guard let instanceID = safeID(instanceID), let deviceID = safeID(deviceID) else { return nil }
        return "\(instanceID.unicodeScalars.count):\(instanceID):\(deviceID)"
    }
}

struct AidenProductSwitcherButton: View {
    @Environment(\.aidenPalette) private var palette

    let area: AidenProductArea
    let botsAvailability: AidenBotsAvailability
    let onSelect: (AidenProductArea) -> Void

    var body: some View {
        Menu {
            areaButton(.bots)
            areaButton(.workspaces)
        } label: {
            Image("AidenAppIcon")
                .resizable()
                .scaledToFit()
                .contentShape(Circle())
        }
        .menuOrder(.fixed)
        .buttonStyle(.plain)
        .accessibilityLabel("Aiden. Current area: \(area.title)")
        .accessibilityHint(accessibilityHint)
    }

    @ViewBuilder
    private func areaButton(_ candidate: AidenProductArea) -> some View {
        Button {
            onSelect(candidate)
        } label: {
            Label {
                Text(candidate.title)
                if candidate == area {
                    Image(systemName: "checkmark")
                }
            } icon: {
                Image(systemName: candidate.symbol)
            }
        }
        .disabled(candidate == .bots && !botsAvailability.canOpen)
    }

    private var accessibilityHint: String {
        if let unavailable = botsAvailability.unavailableMessage {
            return "Choose Workspaces or Bots. \(unavailable)"
        }
        return "Choose Workspaces or Bots."
    }
}

private struct AidenBotShellView: View {
    private struct PresentationScope: Hashable {
        let instanceID: String
        let deviceID: String
    }

    private struct RestorationID: Equatable {
        let scope: PresentationScope?
        let connectionState: AidenRemoteConnectionState
        let chatID: String?
    }

    private struct ChatPresentation {
        var chat: AidenChat
        let allowsMutations: Bool
    }

    @Bindable var coordinator: AidenRemoteCoordinator
    let area: AidenProductArea
    let botsAvailability: AidenBotsAvailability
    let navigationStore: AidenProductNavigationStore
    let deepLinkedChat: AidenChat?
    let deepLinkedInstanceID: String?
    let deepLinkedDeviceID: String?
    let deepLinkedChatAllowsMutations: Bool
    let fullAccessActionsAllowed: Bool
    let onSelectArea: (AidenProductArea) -> Void
    let onRequestCustomAccess: () -> Void

    @Environment(\.aidenPalette) private var palette
    @State private var chatsByScope: [PresentationScope: [String: ChatPresentation]] = [:]
    @State private var retainedCreateAttempt: AidenBotConversationCreateAttempt?

    private var presentationScope: PresentationScope? {
        guard let installation = coordinator.installationStore.activeInstallation else { return nil }
        return PresentationScope(instanceID: installation.id, deviceID: installation.deviceId)
    }

    private var restorationID: RestorationID {
        RestorationID(
            scope: presentationScope,
            connectionState: coordinator.connectionState,
            chatID: path.last
        )
    }

    private var path: [String] {
        get { navigationStore.compactBotPath(for: coordinator.activeInstanceId) }
        nonmutating set { navigationStore.setCompactBotPath(newValue, for: coordinator.activeInstanceId) }
    }

    private var pathBinding: Binding<[String]> {
        Binding(get: { path }, set: { path = $0 })
    }

    var body: some View {
        NavigationStack(path: pathBinding) {
            AidenBotsHomeView(
                coordinator: coordinator,
                area: area,
                availability: botsAvailability,
                navigationStore: navigationStore,
                onSelectArea: onSelectArea,
                onOpenConversation: openConversation,
                onCreateConversation: createConversation
            )
            .navigationDestination(for: String.self) { chatID in
                if let scope = presentationScope,
                   let presentation = chatsByScope[scope]?[chatID],
                   presentation.chat.isBotChat {
                    AidenChatDetailView(
                        coordinator: coordinator,
                        chat: presentation.chat,
                        allowsMutations: presentation.allowsMutations,
                        onChatUpdated: {
                            chatsByScope[scope, default: [:]][$0.id] = ChatPresentation(
                                chat: $0,
                                allowsMutations: presentation.allowsMutations
                            )
                        }
                    )
                } else {
                    ContentUnavailableView(
                        "Conversation Unavailable",
                        systemImage: "exclamationmark.bubble",
                        description: Text("Return to Bots and try again.")
                    )
                }
            }
        }
        .onChange(of: deepLinkedChat) { _, chat in
            guard let chat, chat.isBotChat,
                  let instanceID = deepLinkedInstanceID,
                  let deviceID = deepLinkedDeviceID,
                  presentationScope == PresentationScope(instanceID: instanceID, deviceID: deviceID) else { return }
            let scope = PresentationScope(instanceID: instanceID, deviceID: deviceID)
            chatsByScope[scope, default: [:]][chat.id] = ChatPresentation(
                chat: chat,
                allowsMutations: botsAvailability.canWrite && deepLinkedChatAllowsMutations
            )
            path = [chat.id]
        }
        .task(id: deepLinkedChat?.revision) {
            guard let chat = deepLinkedChat, chat.isBotChat,
                  let instanceID = deepLinkedInstanceID,
                  let deviceID = deepLinkedDeviceID,
                  presentationScope == PresentationScope(instanceID: instanceID, deviceID: deviceID) else { return }
            let scope = PresentationScope(instanceID: instanceID, deviceID: deviceID)
            chatsByScope[scope, default: [:]][chat.id] = ChatPresentation(
                chat: chat,
                allowsMutations: botsAvailability.canWrite && deepLinkedChatAllowsMutations
            )
            path = [chat.id]
        }
        .onChange(of: deepLinkedChatAllowsMutations) { _, allowed in
            guard let chat = deepLinkedChat,
                  let instanceID = deepLinkedInstanceID,
                  let deviceID = deepLinkedDeviceID,
                  presentationScope == PresentationScope(instanceID: instanceID, deviceID: deviceID) else { return }
            let scope = PresentationScope(instanceID: instanceID, deviceID: deviceID)
            chatsByScope[scope, default: [:]][chat.id] = ChatPresentation(
                chat: chat,
                allowsMutations: botsAvailability.canWrite && allowed
            )
        }
        .task(id: restorationID) {
            await hydrateRestoredPath()
        }
        .onChange(of: presentationScope) { _, _ in
            retainedCreateAttempt = nil
        }
    }

    @MainActor
    private func openConversation(_ item: AidenBotConversationItem) async {
        guard coordinator.connectionState == .connected else {
            coordinator.presentedError = "Reconnect to your Mac to open this Bot chat."
            return
        }
        var capturedContext: AidenRemoteRequestContext?
        do {
            let context = try coordinator.requestContext()
            capturedContext = context
            let client = try coordinator.remoteClient(for: context)
            let chat = try await client.chat(id: item.chatId)
            guard coordinator.isCurrent(context), chat.id == item.chatId,
                  chat.botId == item.botId else { return }
            let allowsMutations = try await allowsMutations(
                for: chat,
                client: client,
                context: context
            )
            guard coordinator.isCurrent(context) else { return }
            let retained = await coordinator.withRetainedInstallationData(for: context) {
                try? await AidenChatCache.shared.saveChat(chat, instanceId: context.instanceId)
            }
            guard retained, coordinator.isCurrent(context) else { return }
            let scope = PresentationScope(instanceID: context.instanceId, deviceID: context.deviceId)
            chatsByScope[scope, default: [:]][chat.id] = ChatPresentation(
                chat: chat,
                allowsMutations: allowsMutations
            )
            path = [chat.id]
        } catch is CancellationError {
            return
        } catch {
            if let context = capturedContext,
               await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard capturedContext.map({ coordinator.isCurrent($0) }) ?? false else { return }
            coordinator.presentedError = error.localizedDescription
        }
    }

    @MainActor
    private func createConversation(_ bot: AidenBotSummary) async {
        var capturedContext: AidenRemoteRequestContext?
        var sentAttempt: AidenBotConversationCreateAttempt?
        do {
            let context = try coordinator.requestContext()
            capturedContext = context
            let client = try coordinator.remoteClient(for: context)
            if !fullAccessActionsAllowed {
                let detail = try await client.bot(id: bot.id)
                guard coordinator.isCurrent(context) else { return }
                if detail.access.accessMode == .full {
                    onRequestCustomAccess()
                    return
                }
            }
            let request = try AidenBotChatCreateRequest()
            let attempt = aidenBotConversationCreateAttempt(
                retaining: retainedCreateAttempt,
                context: context,
                botID: bot.id,
                request: request
            )
            retainedCreateAttempt = attempt
            sentAttempt = attempt
            let chat = try await client.createBotChat(
                botId: bot.id,
                request: request,
                idempotencyKey: attempt.idempotencyKey
            )
            guard coordinator.isCurrent(context), chat.botId == bot.id,
                  retainedCreateAttempt == attempt else { return }
            retainedCreateAttempt = nil
            let retained = await coordinator.withRetainedInstallationData(for: context) {
                try? await AidenChatCache.shared.saveChat(chat, instanceId: context.instanceId)
            }
            guard retained, coordinator.isCurrent(context) else { return }
            let scope = PresentationScope(instanceID: context.instanceId, deviceID: context.deviceId)
            chatsByScope[scope, default: [:]][chat.id] = ChatPresentation(
                chat: chat,
                allowsMutations: botsAvailability.canWrite
            )
            path = [chat.id]
        } catch is CancellationError {
            return
        } catch {
            if let context = capturedContext,
               await coordinator.handleCredentialRevocation(error, context: context) {
                if retainedCreateAttempt == sentAttempt { retainedCreateAttempt = nil }
                return
            }
            guard capturedContext.map({ coordinator.isCurrent($0) }) ?? false else { return }
            if let sentAttempt, retainedCreateAttempt == sentAttempt,
               !aidenBotConversationCreateFailureIsAmbiguous(error) {
                retainedCreateAttempt = nil
            }
            coordinator.presentedError = error.localizedDescription
        }
    }

    private func allowsMutations(
        for chat: AidenChat,
        client: AidenRemoteClient,
        context: AidenRemoteRequestContext
    ) async throws -> Bool {
        guard botsAvailability.canWrite else { return false }
        guard let botID = chat.botId else { return false }
        let bot = try await client.bot(id: botID)
        guard coordinator.isCurrent(context) else { return false }
        if fullAccessActionsAllowed {
            return aidenBotChatAllowsMutations(
                canWrite: true,
                fullAccessActionsAllowed: true,
                botHealth: bot.health,
                botAccessMode: bot.access.accessMode,
                chatAccessMode: nil
            )
        }
        let chatAccess = try await client.botChatAccess(chatId: chat.id)
        guard coordinator.isCurrent(context) else { return false }
        return aidenBotChatAllowsMutations(
            canWrite: true,
            fullAccessActionsAllowed: false,
            botHealth: bot.health,
            botAccessMode: bot.access.accessMode,
            chatAccessMode: chatAccess.mode
        )
    }

    @MainActor
    private func hydrateRestoredPath() async {
        guard coordinator.connectionState == .connected,
              let chatID = path.last,
              let scope = presentationScope,
              chatsByScope[scope]?[chatID] == nil else { return }
        var capturedContext: AidenRemoteRequestContext?
        do {
            let context = try coordinator.requestContext()
            capturedContext = context
            guard context.instanceId == scope.instanceID, context.deviceId == scope.deviceID else { return }
            let client = try coordinator.remoteClient(for: context)
            let chat = try await client.chat(id: chatID)
            guard coordinator.isCurrent(context), chat.isBotChat else {
                path = []
                return
            }
            let allowed = try await allowsMutations(for: chat, client: client, context: context)
            guard coordinator.isCurrent(context), presentationScope == scope else { return }
            chatsByScope[scope, default: [:]][chat.id] = ChatPresentation(
                chat: chat,
                allowsMutations: allowed
            )
        } catch is CancellationError {
            return
        } catch {
            if let context = capturedContext,
               await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard presentationScope == scope,
                  capturedContext.map({ coordinator.isCurrent($0) }) ?? false else { return }
            path = []
            coordinator.presentedError = "The saved Bot chat is no longer available."
        }
    }
}

private struct AidenFullAccessNoticeView: View {
    let includesMigrationCopy: Bool
    let isSaving: Bool
    let onContinue: () -> Void
    let onCustomize: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Image(systemName: "macbook.and.iphone")
                        .font(.system(size: 46, weight: .medium))
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)

                    Text("Bots can use your Mac")
                        .font(.largeTitle.bold())

                    Text("By default, bots can work with files, run commands, and use connections, skills, and AI configured on the paired Mac. Capabilities you enable later in Aiden are also available to Full Access bots. You can choose Custom Access now or reduce access in Bot Settings anytime.")
                        .font(.body)

                    if includesMigrationCopy {
                        Text("Your existing bots will keep the capabilities they already use. You can review or reduce each Bot’s access later.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 12) {
                        Button(action: onContinue) {
                            Text("Continue with Full Access")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)

                        Button(action: onCustomize) {
                            Text("Customize first")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    }
                    .disabled(isSaving)

                    if isSaving {
                        ProgressView("Saving on your Mac…")
                            .frame(maxWidth: .infinity)
                    }
                }
                .padding(24)
            }
            .navigationTitle("Bot Access")
            .navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled()
    }
}

private enum AidenBotNoticeGate: Equatable {
    case inactive
    case checking
    case required(AidenBotNoticeStatus)
    case accepted
    case customOnly
    case readOnly
    case offline(String)
    case customizing
    case failed(String)

    var blocksBotActions: Bool {
        switch self {
        case .accepted, .customOnly, .readOnly, .offline: false
        default: true
        }
    }
}

private struct AidenBotNoticeResolutionID: Equatable {
    let instanceID: String?
    let deviceID: String?
    let connectionState: AidenRemoteConnectionState
    let availability: AidenBotsAvailability
    let deepLinkedChatID: String?
    let deepLinkedChatRevision: String?
}

struct AidenBotConversationCreateAttempt: Equatable {
    let context: AidenRemoteRequestContext
    let botID: String
    let request: AidenBotChatCreateRequest
    let idempotencyKey: UUID
}

func aidenBotConversationCreateAttempt(
    retaining existing: AidenBotConversationCreateAttempt?,
    context: AidenRemoteRequestContext,
    botID: String,
    request: AidenBotChatCreateRequest,
    makeKey: () -> UUID = UUID.init
) -> AidenBotConversationCreateAttempt {
    if let existing,
       existing.context == context,
       existing.botID == botID,
       existing.request == request {
        return existing
    }
    return .init(
        context: context,
        botID: botID,
        request: request,
        idempotencyKey: makeKey()
    )
}

func aidenBotConversationCreateFailureIsAmbiguous(_ error: Error) -> Bool {
    if error is CancellationError || error is URLError { return true }
    guard let remoteError = error as? AidenRemoteClientError else { return true }
    switch remoteError {
    case .invalidResponse:
        return true
    case let .server(statusCode, _), let .unexpectedStatus(statusCode):
        return (200..<300).contains(statusCode)
            || statusCode == 408
            || statusCode == 429
            || statusCode >= 500
    case .invalidEndpoint, .missingCredential,
         .missingTrustConfiguration, .installationChanged:
        return false
    }
}

private struct AidenProductNavigationResolutionID: Equatable {
    let request: AidenNavigationRequest?
    let connectionState: AidenRemoteConnectionState
    let instanceID: String?
    let deviceID: String?
}

struct AidenProductShellView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Binding private var navigationRequest: AidenNavigationRequest?
    @State private var workspaceNavigationRequest: AidenNavigationRequest?
    @State private var deepLinkedBotChat: AidenChat?
    @State private var deepLinkedBotInstanceID: String?
    @State private var deepLinkedBotDeviceID: String?
    @State private var deepLinkedBotAllowsMutations = false
    @State private var noticeGate: AidenBotNoticeGate = .inactive
    @State private var isSavingNotice = false
    @State private var noticeIncludesMigrationCopy = false
    @State private var isShowingCustomizePlaceholder = false
    @State private var navigationStore: AidenProductNavigationStore

    init(
        coordinator: AidenRemoteCoordinator,
        navigationRequest: Binding<AidenNavigationRequest?> = .constant(nil),
        navigationStore: AidenProductNavigationStore = .shared
    ) {
        self.coordinator = coordinator
        _navigationRequest = navigationRequest
        _navigationStore = State(initialValue: navigationStore)
    }

    private var botsAvailability: AidenBotsAvailability {
        AidenBotsAvailability.resolve(coordinator.installationStore.activeInstallation)
    }

    private var area: AidenProductArea {
        get {
            navigationStore.area(
                for: coordinator.activeInstanceId,
                botsAvailable: botsAvailability.canOpen
            )
        }
        nonmutating set {
            navigationStore.select(
                newValue,
                for: coordinator.activeInstanceId,
                botsAvailable: botsAvailability.canOpen
            )
        }
    }

    private var noticeResolutionID: AidenBotNoticeResolutionID {
        AidenBotNoticeResolutionID(
            instanceID: coordinator.activeInstanceId,
            deviceID: coordinator.installationStore.activeInstallation?.deviceId,
            connectionState: coordinator.connectionState,
            availability: botsAvailability,
            deepLinkedChatID: deepLinkedBotChat?.id,
            deepLinkedChatRevision: deepLinkedBotChat?.revision
        )
    }

    private var navigationResolutionID: AidenProductNavigationResolutionID {
        AidenProductNavigationResolutionID(
            request: navigationRequest,
            connectionState: coordinator.connectionState,
            instanceID: coordinator.activeInstanceId,
            deviceID: coordinator.installationStore.activeInstallation?.deviceId
        )
    }

    var body: some View {
        ZStack {
            AidenWorkspaceShellView(
                coordinator: coordinator,
                navigationRequest: $workspaceNavigationRequest,
                productArea: area,
                botsAvailability: botsAvailability,
                navigationStore: navigationStore,
                onSelectProductArea: selectArea
            )
            .opacity(area == .workspaces ? 1 : 0)
            .allowsHitTesting(area == .workspaces)
            .accessibilityHidden(area != .workspaces)

            AidenBotShellView(
                coordinator: coordinator,
                area: area,
                botsAvailability: botsAvailability,
                navigationStore: navigationStore,
                deepLinkedChat: deepLinkedBotChat,
                deepLinkedInstanceID: deepLinkedBotInstanceID,
                deepLinkedDeviceID: deepLinkedBotDeviceID,
                deepLinkedChatAllowsMutations: deepLinkedBotAllowsMutations,
                fullAccessActionsAllowed: noticeGate == .accepted,
                onSelectArea: selectArea,
                onRequestCustomAccess: {
                    isShowingCustomizePlaceholder = true
                }
            )
            .opacity(area == .bots ? 1 : 0)
            .allowsHitTesting(area == .bots && !noticeGate.blocksBotActions)
            .accessibilityHidden(area != .bots)
        }
        .overlay {
            if area == .bots {
                botGateOverlay
            }
        }
        .sheet(isPresented: Binding(
            get: {
                if case .required = noticeGate { return true }
                return false
            },
            set: { _ in }
        )) {
            if case .required = noticeGate {
                AidenFullAccessNoticeView(
                    includesMigrationCopy: noticeIncludesMigrationCopy,
                    isSaving: isSavingNotice,
                    onContinue: { acknowledgeNotice(.continueFull) },
                    onCustomize: { acknowledgeNotice(.customizeFirst) }
                )
            }
        }
        .sheet(isPresented: $isShowingCustomizePlaceholder, onDismiss: {
            Task { await prepareBotAccess() }
        }) {
            AidenBotCustomAccessFlowView(coordinator: coordinator)
        }
        .task(id: noticeResolutionID) {
            noticeGate = .inactive
            noticeIncludesMigrationCopy = false
            if deepLinkedBotInstanceID != coordinator.activeInstanceId
                || deepLinkedBotDeviceID != coordinator.installationStore.activeInstallation?.deviceId {
                deepLinkedBotChat = nil
                deepLinkedBotInstanceID = nil
                deepLinkedBotDeviceID = nil
                deepLinkedBotAllowsMutations = false
            }
            if area == .bots {
                await prepareBotAccess()
            }
        }
        .task(id: navigationResolutionID) {
            await resolveNavigationRequest()
        }
    }

    @ViewBuilder
    private var botGateOverlay: some View {
        switch noticeGate {
        case .checking:
            ProgressView("Checking Bot access on your Mac…")
                .padding()
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        case .failed(let message):
            ContentUnavailableView {
                Label("Bot Access Unavailable", systemImage: "exclamationmark.shield")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await prepareBotAccess() } }
                Button("Workspaces") { area = .workspaces }
            }
            .background(.regularMaterial)
        case .customizing:
            Color.clear
        case .offline(let message):
            VStack {
                Label(message, systemImage: "wifi.slash")
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.top, 8)
                Spacer()
            }
        case .inactive where !botsAvailability.canOpen:
            ContentUnavailableView(
                "Bots Unavailable",
                systemImage: "person.2.slash",
                description: Text(botsAvailability.unavailableMessage ?? "Bot access is unavailable.")
            )
            .background(.regularMaterial)
        default:
            EmptyView()
        }
    }

    private func selectArea(_ selected: AidenProductArea) {
        guard selected != area else { return }
        if selected == .bots, !botsAvailability.canOpen {
            coordinator.presentedError = botsAvailability.unavailableMessage
            return
        }
        area = selected
        if selected == .bots {
            noticeGate = .checking
            Task { await prepareBotAccess() }
        }
    }

    @MainActor
    private func prepareBotAccess() async {
        let expectedResolution = noticeResolutionID
        guard botsAvailability.canOpen else {
            noticeGate = .inactive
            return
        }
        if case .available(canWrite: false) = botsAvailability {
            noticeGate = .readOnly
            deepLinkedBotAllowsMutations = false
            return
        }
        guard coordinator.connectionState == .connected else {
            noticeGate = .offline("Offline — showing saved Bots")
            return
        }
        noticeGate = .checking
        var capturedContext: AidenRemoteRequestContext?
        do {
            let context = try coordinator.requestContext()
            capturedContext = context
            let client = try coordinator.remoteClient(for: context)
            let status = try await client.botAccessNotice()
            guard coordinator.isCurrent(context),
                  expectedResolution == noticeResolutionID,
                  area == .bots else { return }
            if status.requiresAcknowledgement {
                let list: AidenBotList?
                do {
                    list = try await client.bots()
                } catch {
                    if await coordinator.handleCredentialRevocation(error, context: context) { return }
                    list = nil
                }
                guard coordinator.isCurrent(context),
                      expectedResolution == noticeResolutionID,
                      area == .bots else { return }
                noticeIncludesMigrationCopy = !(list?.bots.isEmpty ?? true)
                noticeGate = .required(status)
                deepLinkedBotAllowsMutations = false
                return
            }
            guard status.acceptedDecision == .customizeFirst else {
                noticeGate = .accepted
                if let chat = deepLinkedBotChat,
                   deepLinkedBotInstanceID == context.instanceId,
                   deepLinkedBotDeviceID == context.deviceId,
                   let botID = chat.botId {
                    let bot = try await client.bot(id: botID)
                    guard coordinator.isCurrent(context),
                          expectedResolution == noticeResolutionID,
                          area == .bots else { return }
                    deepLinkedBotAllowsMutations = aidenBotChatAllowsMutations(
                        canWrite: botsAvailability.canWrite,
                        fullAccessActionsAllowed: true,
                        botHealth: bot.health,
                        botAccessMode: bot.access.accessMode,
                        chatAccessMode: nil
                    )
                } else {
                    deepLinkedBotAllowsMutations = true
                }
                return
            }
            if let chat = deepLinkedBotChat,
               let botID = chat.botId,
               deepLinkedBotInstanceID == context.instanceId,
               deepLinkedBotDeviceID == context.deviceId {
                let bot = try await client.bot(id: botID)
                let chatAccess = try await client.botChatAccess(chatId: chat.id)
                let usesCustomAccess = chatAccess.mode == .custom
                    || bot.access.accessMode == .custom
                guard coordinator.isCurrent(context),
                      expectedResolution == noticeResolutionID,
                      area == .bots else { return }
                if usesCustomAccess {
                    noticeGate = .customOnly
                    deepLinkedBotAllowsMutations = aidenBotChatAllowsMutations(
                        canWrite: botsAvailability.canWrite,
                        fullAccessActionsAllowed: false,
                        botHealth: bot.health,
                        botAccessMode: bot.access.accessMode,
                        chatAccessMode: chatAccess.mode
                    )
                    return
                }
                noticeGate = .customizing
                deepLinkedBotAllowsMutations = false
                isShowingCustomizePlaceholder = true
                return
            }
            noticeGate = .customOnly
            deepLinkedBotAllowsMutations = false
        } catch is CancellationError {
            return
        } catch {
            if let context = capturedContext,
               await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard expectedResolution == noticeResolutionID, area == .bots else { return }
            noticeGate = .failed(error.localizedDescription)
        }
    }

    private func acknowledgeNotice(_ decision: AidenBotNoticeDecision) {
        guard case .required(let status) = noticeGate, !isSavingNotice else { return }
        isSavingNotice = true
        Task { @MainActor in
            defer { isSavingNotice = false }
            let expectedResolution = noticeResolutionID
            var requestContext: AidenRemoteRequestContext?
            do {
                let context = try coordinator.requestContext()
                requestContext = context
                let acknowledgement = try AidenBotNoticeAcknowledgement(
                    version: status.version,
                    decision: decision
                )
                let accepted = try await coordinator.remoteClient(for: context)
                    .acknowledgeBotAccessNotice(acknowledgement)
                guard coordinator.isCurrent(context),
                      expectedResolution == noticeResolutionID,
                      !accepted.requiresAcknowledgement else { return }
                if decision == .customizeFirst {
                    noticeGate = .customOnly
                    deepLinkedBotAllowsMutations = false
                    isShowingCustomizePlaceholder = true
                } else {
                    noticeGate = .accepted
                    deepLinkedBotAllowsMutations = true
                }
            } catch {
                if let context = requestContext,
                   await coordinator.handleCredentialRevocation(error, context: context) { return }
                guard expectedResolution == noticeResolutionID,
                      requestContext.map({ coordinator.isCurrent($0) }) ?? true,
                      area == .bots else { return }
                coordinator.presentedError = error.localizedDescription
            }
        }
    }

    @MainActor
    private func resolveNavigationRequest() async {
        guard let request = navigationRequest,
              coordinator.connectionState == .connected else { return }
        switch request.destination {
        case .newChat:
            area = .workspaces
            workspaceNavigationRequest = request
            navigationRequest = nil
        case .chat(let chatID):
            var capturedContext: AidenRemoteRequestContext?
            do {
                let context = try coordinator.requestContext(for: request.instanceId)
                capturedContext = context
                let chat = try await coordinator.remoteClient(for: context).chat(id: chatID)
                guard coordinator.isCurrent(context), navigationRequest == request else { return }
                navigationRequest = nil
                if AidenProductRouting.area(for: chat) == .bots {
                    guard botsAvailability.canOpen else {
                        coordinator.presentedError = botsAvailability.unavailableMessage
                        return
                    }
                    area = .bots
                    deepLinkedBotChat = chat
                    deepLinkedBotInstanceID = context.instanceId
                    deepLinkedBotDeviceID = context.deviceId
                    deepLinkedBotAllowsMutations = false
                    await prepareBotAccess()
                } else {
                    area = .workspaces
                    workspaceNavigationRequest = request
                }
            } catch is CancellationError {
                return
            } catch {
                if let context = capturedContext,
                   await coordinator.handleCredentialRevocation(error, context: context) { return }
                guard navigationRequest == request,
                      capturedContext.map({ coordinator.isCurrent($0) }) ?? false else { return }
                navigationRequest = nil
                coordinator.presentedError = error.localizedDescription
            }
        }
    }
}
