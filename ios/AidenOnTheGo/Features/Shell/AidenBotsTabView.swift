import SwiftUI

/// What the Bots home lists when more than one machine is shown: every shown
/// machine's Bots, under the Inbox's machine filter.
struct AidenBotsHomeMachines {
    let roster: AidenMachineRoster
    let filter: Binding<AidenMachineFilter>
    let sections: [AidenMachineSection<AidenMachineBotRow>]
    let onOpen: (AidenMachineBotRow) -> Void
}

/// The Bots home as a tab root. Bots stays selectable when a machine can't offer
/// them, and says why. With more than one machine it lists every machine's Bots,
/// by machine under All.
struct AidenBotsTabView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let store: AidenUnifiedInboxStore
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

    private var machines: AidenBotsHomeMachines? {
        guard store.roster.showsStrip else { return nil }
        return AidenBotsHomeMachines(
            roster: store.roster,
            filter: Binding(get: { store.filter }, set: { store.filter = $0 }),
            sections: store.botSections(),
            onOpen: { row in
                onOpenBot(row.id, row.bot)
                navigation.open(.bot(row.id))
            }
        )
    }

    var body: some View {
        let machines = machines
        if machines == nil, let explanation = availability.tabExplanation {
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
                isInTabShell: true,
                machines: machines
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

/// Finds what a `.bot` route opens, on the Bot's own machine whichever machine
/// is selected. Only an older pairing of that machine, or one that's gone, stops
/// it.
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

    /// The Bot's machine, as long as it's still the pairing the route was made on.
    static func connection(for id: AidenHostObjectID, coordinator: AidenRemoteCoordinator) -> AidenHostConnection? {
        guard let connection = coordinator.hosts.connection(for: id.instanceId),
              connection.installation.deviceId == id.deviceId else { return nil }
        return connection
    }

    static let machineGoneMessage = String(localized: "This machine is no longer paired. Pair it again to open this Bot.")

    func accept(_ chat: AidenChat) {
        guard case .chat(let current, let allowsMutations) = state, current.id == chat.id else { return }
        state = .chat(chat, allowsMutations: allowsMutations)
    }

    func load(coordinator: AidenRemoteCoordinator) async {
        guard let connection = Self.connection(for: id, coordinator: coordinator) else {
            state = .unavailable(Self.machineGoneMessage)
            return
        }
        let availability = AidenBotsAvailability.resolve(connection.installation)
        if let explanation = availability.tabExplanation {
            state = .unavailable(explanation)
            return
        }
        if case .durableSession = AidenBotChatRoute.resolve(
            botID: id.objectId,
            hostFeatures: coordinator.knownServerFeatures(of: id.instanceId)
        ) {
            state = .session
            return
        }
        await loadChat(canWrite: availability.canWrite, over: connection, coordinator: coordinator)
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

    private func loadChat(
        canWrite: Bool,
        over connection: AidenHostConnection,
        coordinator: AidenRemoteCoordinator
    ) async {
        guard let context = try? coordinator.ownerContext(for: id.instanceId) else { return }
        var chat: AidenChat?
        if case .chat(let current, _) = state {
            chat = current
        } else if let saved = await savedChat() {
            guard coordinator.holds(context) else { return }
            chat = saved
            // Saved words show at once; only a live check grants sending.
            state = .chat(saved, allowsMutations: false)
        }
        switch connection.connectionState {
        case .connected:
            break
        case .connecting:
            return
        case .offline, .needsPairing:
            if chat == nil {
                state = .unavailable(String(localized: "Reconnect to \(connection.installation.name) to open this Bot chat."))
            }
            return
        }
        do {
            let client = try coordinator.remoteClient(for: context)
            if chat == nil {
                let page = try await client.botConversations(query: AidenBotConversationQuery(botId: id.objectId))
                guard coordinator.holds(context) else { return }
                guard case .openChat(let chatID) = aidenResolvedBotDeepLink(
                    botID: id.objectId,
                    conversations: page.conversations
                ) else {
                    // A link never starts a chat on the person's behalf.
                    let bot = try await client.bot(id: id.objectId)
                    guard coordinator.holds(context) else { return }
                    state = .unavailable(String(localized: "\(bot.name) has no chat yet. Open it from Bots to start one."))
                    return
                }
                let fetched = try await client.chat(id: chatID)
                guard coordinator.holds(context) else { return }
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
            guard coordinator.holds(context), let chat else { return }
            state = .chat(chat, allowsMutations: aidenBotChatAllowsMutations(canWrite: canWrite, botHealth: bot.health))
        } catch where aidenIsCancellation(error) {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) {
                state = .unavailable(Self.machineGoneMessage)
                return
            }
            guard coordinator.holds(context) else { return }
            if chat != nil {
                coordinator.presentedError = String(localized: "Couldn’t refresh this Bot chat. Showing the saved conversation.")
            } else {
                state = .unavailable(error.localizedDescription)
            }
        }
    }
}

/// A pushed Bot chat, on the Bot's own machine.
struct AidenBotRouteView: View {
    private struct LoadID: Equatable {
        let pairing: String?
        let connectionState: AidenRemoteConnectionState?
        let canWrite: Bool
    }

    let coordinator: AidenRemoteCoordinator
    let initialSummary: AidenBotSummary?
    /// Set only while this Bot is a Catch Up run's, as on a chat route.
    let onNext: (() -> Void)?

    @Environment(\.aidenPalette) private var palette
    @State private var model: AidenBotRouteModel
    @State private var holdsAttachments = false
    @State private var isConfirmingNext = false

    init(
        coordinator: AidenRemoteCoordinator,
        id: AidenHostObjectID,
        initialSummary: AidenBotSummary?,
        onNext: (() -> Void)? = nil
    ) {
        self.coordinator = coordinator
        self.initialSummary = initialSummary
        self.onNext = onNext
        _model = State(initialValue: AidenBotRouteModel(id: id))
    }

    private var connection: AidenHostConnection? {
        AidenBotRouteModel.connection(for: model.id, coordinator: coordinator)
    }

    private var loadID: LoadID {
        LoadID(
            pairing: connection?.installation.deviceId,
            connectionState: connection?.connectionState,
            canWrite: connection?.installation.canWriteBots == true
        )
    }

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                AidenBotChatSkeletonView()
            case .session:
                AidenBotSessionChatView(
                    coordinator: coordinator,
                    botID: model.id.objectId,
                    initialSummary: initialSummary,
                    machine: model.id.instanceId,
                    staysOnItsMachine: true
                )
                .id("\(model.id.instanceId)-\(model.id.objectId)")
            case .chat(let chat, let allowsMutations):
                AidenChatDetailView(
                    coordinator: coordinator,
                    chat: chat,
                    owner: try? connection?.requestContext(scope: .owner),
                    allowsMutations: allowsMutations,
                    onChatUpdated: { model.accept($0) }
                )
                .id("\(model.id.instanceId)-\(chat.id)")
            case .unavailable(let message):
                ContentUnavailableView(
                    "Bot unavailable",
                    systemImage: "exclamationmark.bubble",
                    description: Text(message)
                )
                .background(palette.canvas.ignoresSafeArea())
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            if let onNext {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Next") {
                        if holdsAttachments { isConfirmingNext = true } else { onNext() }
                    }
                    .accessibilityHint("Opens the next chat that needs you")
                    .confirmationDialog(
                        "Discard attachments?",
                        isPresented: $isConfirmingNext,
                        titleVisibility: .visible
                    ) {
                        Button("Discard attachments", role: .destructive, action: onNext)
                        Button("Stay", role: .cancel) {}
                    } message: {
                        Text("They aren’t kept when you move to the next chat. Your message text is saved.")
                    }
                }
            }
        }
        .onPreferenceChange(AidenChatHoldsAttachmentsKey.self) { holds in
            holdsAttachments = holds
        }
        .task(id: loadID) {
            await model.load(coordinator: coordinator)
        }
    }
}
