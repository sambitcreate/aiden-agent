import SwiftUI

/// The Bots home as a tab root. Bots stays selectable when a machine can't offer
/// them, and says why.
struct AidenBotsTabView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let navigation: AidenAppNavigation
    let availability: AidenBotsAvailability
    /// A Bot the home already knows, so its chat opens with a title at once.
    let onOpenBot: (AidenHostObjectID, AidenBotSummary) -> Void

    @Environment(\.aidenPalette) private var palette
    @State private var chatStarter = AidenBotChatStarter()

    private func route(botID: String) -> AidenHostObjectID? {
        guard let installation = coordinator.installationStore.activeInstallation else { return nil }
        return AidenHostObjectID(instanceId: installation.id, deviceId: installation.deviceId, objectId: botID)
    }

    var body: some View {
        if let explanation = availability.tabExplanation {
            ContentUnavailableView(
                "Bots unavailable",
                systemImage: "person.2.slash",
                description: Text(explanation)
            )
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle("Bots")
        } else {
            AidenBotsHomeView(
                coordinator: coordinator,
                area: .bots,
                availability: availability,
                navigationStore: .shared,
                isShowingSwitcherCoachmark: .constant(false),
                onSelectArea: { _ in },
                onOpenConversation: { conversation in
                    if let id = route(botID: conversation.botId) { navigation.open(.bot(id)) }
                },
                onCreateConversation: createConversation,
                onOpenBotSession: { bot in
                    guard let id = route(botID: bot.id) else { return }
                    onOpenBot(id, bot)
                    navigation.open(.bot(id))
                },
                isInTabShell: true
            )
            .onChange(of: coordinator.activeInstanceId) { _, _ in
                chatStarter.forgetAttempt()
            }
        }
    }

    @MainActor
    private func createConversation(_ bot: AidenBotSummary) async {
        guard availability.canWrite,
              await chatStarter.start(botID: bot.id, coordinator: coordinator),
              let id = route(botID: bot.id) else { return }
        navigation.open(.bot(id))
    }
}

/// A Bot's first chat, on a machine without durable sessions. A retry after an
/// unclear failure reuses its key, so one tap can't make two chats.
@MainActor
final class AidenBotChatStarter {
    private let cache: AidenChatCache
    private var retainedAttempt: AidenBotConversationCreateAttempt?

    init(cache: AidenChatCache = .shared) {
        self.cache = cache
    }

    /// The selected machine changed, so the next tap is a new chat.
    func forgetAttempt() {
        retainedAttempt = nil
    }

    /// True once the chat is made and saved, ready to open.
    func start(botID: String, coordinator: AidenRemoteCoordinator) async -> Bool {
        var capturedContext: AidenRemoteRequestContext?
        var sentAttempt: AidenBotConversationCreateAttempt?
        do {
            let context = try coordinator.requestContext()
            capturedContext = context
            let client = try coordinator.remoteClient(for: context)
            let request = try AidenBotChatCreateRequest()
            let attempt = aidenBotConversationCreateAttempt(
                retaining: retainedAttempt,
                context: context,
                botID: botID,
                request: request
            )
            retainedAttempt = attempt
            sentAttempt = attempt
            let chat = try await client.createBotChat(
                botId: botID,
                request: request,
                idempotencyKey: attempt.idempotencyKey
            )
            guard coordinator.isCurrent(context), chat.botId == botID,
                  retainedAttempt == attempt else { return false }
            retainedAttempt = nil
            let saved = await aidenPersistBotChatForPresentation(chat, context: context, coordinator: coordinator, cache: cache)
            return saved != nil && coordinator.isCurrent(context)
        } catch is CancellationError {
            return false
        } catch {
            if let context = capturedContext,
               await coordinator.handleCredentialRevocation(error, context: context) {
                if retainedAttempt == sentAttempt { retainedAttempt = nil }
                return false
            }
            guard capturedContext.map({ coordinator.isCurrent($0) }) ?? false else { return false }
            if let sentAttempt, retainedAttempt == sentAttempt,
               !aidenBotConversationCreateFailureIsAmbiguous(error) {
                retainedAttempt = nil
            }
            coordinator.presentedError = error.localizedDescription
            return false
        }
    }
}

/// Finds what a `.bot` route opens. The Bot chat is bound to the selected machine,
/// so a route to any other machine stops here without asking it for anything.
@MainActor @Observable
final class AidenBotRouteModel {
    enum State: Equatable {
        case loading
        /// The Bot's one durable chat, which loads itself.
        case session
        /// A machine from before durable sessions: the Bot's newest chat.
        case chat(AidenChat, allowsMutations: Bool)
        case unavailable(String)
    }

    let id: AidenHostObjectID
    private(set) var state = State.loading
    @ObservationIgnored private let chatCache: AidenChatCache
    @ObservationIgnored private let botCache: AidenBotCache

    init(id: AidenHostObjectID, chatCache: AidenChatCache = .shared, botCache: AidenBotCache = .shared) {
        self.id = id
        self.chatCache = chatCache
        self.botCache = botCache
    }

    static func isOnSelectedMachine(_ id: AidenHostObjectID, coordinator: AidenRemoteCoordinator) -> Bool {
        let installation = coordinator.installationStore.activeInstallation
        return installation?.id == id.instanceId && installation?.deviceId == id.deviceId
    }

    /// Why this route can't open here, in the words the screen shows.
    static func elsewhereMessage(_ id: AidenHostObjectID, coordinator: AidenRemoteCoordinator) -> String {
        let installation = coordinator.installationStore.installations.first {
            $0.id == id.instanceId && $0.deviceId == id.deviceId
        }
        return installation.map { String(localized: "This Bot is on \($0.name). Select that machine in Settings to open it.") }
            ?? String(localized: "This machine is no longer paired. Pair it again to open this Bot.")
    }

    func accept(_ chat: AidenChat) {
        guard case .chat(let current, let allowsMutations) = state, current.id == chat.id else { return }
        state = .chat(chat, allowsMutations: allowsMutations)
    }

    func load(coordinator: AidenRemoteCoordinator) async {
        guard Self.isOnSelectedMachine(id, coordinator: coordinator),
              let installation = coordinator.installationStore.activeInstallation else {
            state = .unavailable(Self.elsewhereMessage(id, coordinator: coordinator))
            return
        }
        let availability = AidenBotsAvailability.resolve(installation)
        if let explanation = availability.tabExplanation {
            state = .unavailable(explanation)
            return
        }
        if case .durableSession = AidenBotChatRoute.resolve(botID: id.objectId, hostFeatures: coordinator.knownServerFeatures) {
            state = .session
            return
        }
        await loadChat(canWrite: availability.canWrite, coordinator: coordinator)
    }

    private func savedChat() async -> AidenChat? {
        let snapshot = await botCache.load(instanceId: id.instanceId, deviceId: id.deviceId)
        guard case .openChat(let chatID) = aidenResolvedBotDeepLink(
            botID: id.objectId,
            conversations: snapshot?.conversations?.conversations ?? []
        ) else { return nil }
        return aidenAdmittedCachedBotChat(
            await chatCache.admittedChat(instanceId: id.instanceId, chatId: chatID),
            chatID: chatID,
            botID: id.objectId
        )
    }

    private func loadChat(canWrite: Bool, coordinator: AidenRemoteCoordinator) async {
        guard let context = try? coordinator.requestContext() else { return }
        var chat: AidenChat?
        if case .chat(let current, _) = state {
            chat = current
        } else if let saved = await savedChat() {
            guard coordinator.isCurrent(context) else { return }
            chat = saved
            // Saved words show at once; only a live check grants sending.
            state = .chat(saved, allowsMutations: false)
        }
        switch coordinator.connectionState {
        case .connected:
            break
        case .connecting:
            return
        case .offline, .needsPairing:
            if chat == nil {
                state = .unavailable(String(localized: "Reconnect to your paired machine to open this Bot chat."))
            }
            return
        }
        do {
            let client = try coordinator.remoteClient(for: context)
            if chat == nil {
                let page = try await client.botConversations(query: AidenBotConversationQuery(botId: id.objectId))
                guard coordinator.isCurrent(context) else { return }
                guard case .openChat(let chatID) = aidenResolvedBotDeepLink(
                    botID: id.objectId,
                    conversations: page.conversations
                ) else {
                    // A link never starts a chat on the person's behalf.
                    let bot = try await client.bot(id: id.objectId)
                    guard coordinator.isCurrent(context) else { return }
                    state = .unavailable(String(localized: "\(bot.name) has no chat yet. Open it from Bots to start one."))
                    return
                }
                let fetched = try await client.chat(id: chatID)
                guard coordinator.isCurrent(context) else { return }
                guard fetched.id == chatID, fetched.botId == id.objectId,
                      let admitted = await aidenPersistBotChatForPresentation(
                        fetched,
                        context: context,
                        coordinator: coordinator,
                        cache: chatCache
                      ) else {
                    state = .unavailable(String(localized: "That Bot chat is no longer available."))
                    return
                }
                chat = admitted
                state = .chat(admitted, allowsMutations: false)
            }
            let bot = try await client.bot(id: id.objectId)
            guard coordinator.isCurrent(context), let chat else { return }
            state = .chat(chat, allowsMutations: aidenBotChatAllowsMutations(canWrite: canWrite, botHealth: bot.health))
        } catch where aidenIsCancellation(error) {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) {
                state = .unavailable(Self.elsewhereMessage(id, coordinator: coordinator))
                return
            }
            guard coordinator.isCurrent(context) else { return }
            if chat != nil {
                coordinator.presentedError = String(localized: "Couldn’t refresh this Bot chat. Showing the saved conversation.")
            } else {
                state = .unavailable(error.localizedDescription)
            }
        }
    }
}

/// A pushed Bot chat.
struct AidenBotRouteView: View {
    private struct LoadID: Equatable {
        let selection: String?
        let connectionState: AidenRemoteConnectionState
        let canWrite: Bool
    }

    let coordinator: AidenRemoteCoordinator
    let initialSummary: AidenBotSummary?

    @Environment(\.aidenPalette) private var palette
    @State private var model: AidenBotRouteModel

    init(coordinator: AidenRemoteCoordinator, id: AidenHostObjectID, initialSummary: AidenBotSummary?) {
        self.coordinator = coordinator
        self.initialSummary = initialSummary
        _model = State(initialValue: AidenBotRouteModel(id: id))
    }

    private var loadID: LoadID {
        LoadID(
            selection: coordinator.activeInstanceId,
            connectionState: coordinator.connectionState,
            canWrite: coordinator.installationStore.activeInstallation?.canWriteBots == true
        )
    }

    var body: some View {
        Group {
            if !AidenBotRouteModel.isOnSelectedMachine(model.id, coordinator: coordinator) {
                unavailable(AidenBotRouteModel.elsewhereMessage(model.id, coordinator: coordinator))
            } else {
                switch model.state {
                case .loading:
                    AidenBotChatSkeletonView()
                case .session:
                    AidenBotSessionChatView(
                        coordinator: coordinator,
                        botID: model.id.objectId,
                        initialSummary: initialSummary
                    )
                    .id("\(model.id.instanceId)-\(model.id.objectId)")
                case .chat(let chat, let allowsMutations):
                    AidenChatDetailView(
                        coordinator: coordinator,
                        chat: chat,
                        allowsMutations: allowsMutations,
                        onChatUpdated: { model.accept($0) }
                    )
                    .id("\(model.id.instanceId)-\(chat.id)")
                case .unavailable(let message):
                    unavailable(message)
                }
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .task(id: loadID) {
            await model.load(coordinator: coordinator)
        }
    }

    private func unavailable(_ message: String) -> some View {
        ContentUnavailableView(
            "Bot unavailable",
            systemImage: "exclamationmark.bubble",
            description: Text(message)
        )
        .background(palette.canvas.ignoresSafeArea())
    }
}
