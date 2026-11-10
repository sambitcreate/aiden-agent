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
        guard store.roster.showsTabStrip else { return nil }
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
                availability: availability,
                onOpenConversation: { conversation in
                    if let id = route(botID: conversation.botId) { navigation.open(.bot(id)) }
                },
                onCreateConversation: createConversation,
                onOpenBotSession: { bot in
                    guard let id = route(botID: bot.id) else { return }
                    onOpenBot(id, bot)
                    navigation.open(.bot(id))
                },
                machines: machines
            )
            .onChange(of: coordinator.defaultInstanceId) { _, _ in
                chatStarter.forgetAttempt()
            }
            .task(id: machines?.roster.tabMachines.map(\.instanceId)) {
                guard machines != nil else { return }
                await store.readHiddenMachinesBots()
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

    /// True once the chat is made and saved, ready to open. Nil `context` makes
    /// it on the selected machine; an owner context, on that machine.
    func start(
        botID: String,
        coordinator: AidenRemoteCoordinator,
        context ownerContext: AidenRemoteRequestContext? = nil
    ) async -> Bool {
        var capturedContext: AidenRemoteRequestContext?
        var sentAttempt: AidenBotConversationCreateAttempt?
        do {
            let context = try ownerContext ?? coordinator.requestContext()
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
            guard coordinator.holds(context), chat.botId == botID,
                  retainedAttempt == attempt else { return false }
            retainedAttempt = nil
            let saved = await aidenPersistBotChatForPresentation(chat, context: context, coordinator: coordinator, cache: cache)
            return saved != nil && coordinator.holds(context)
        } catch is CancellationError {
            return false
        } catch {
            if let context = capturedContext,
               await coordinator.handleCredentialRevocation(error, context: context) {
                if retainedAttempt == sentAttempt { retainedAttempt = nil }
                return false
            }
            guard capturedContext.map({ coordinator.holds($0) }) ?? false else { return false }
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
        /// A machine from before durable sessions, and the Bot has no chat yet.
        /// `canStart` says whether its machine can make one now.
        case noChat(name: String, canStart: Bool)
        case unavailable(String)
    }

    let id: AidenHostObjectID
    private(set) var state = State.loading
    private(set) var isStarting = false
    @ObservationIgnored private let chatCache: AidenChatCache
    @ObservationIgnored private let botCache: AidenBotCache
    @ObservationIgnored private let starter: AidenBotChatStarter

    init(id: AidenHostObjectID, chatCache: AidenChatCache = .shared, botCache: AidenBotCache = .shared) {
        self.id = id
        self.chatCache = chatCache
        self.botCache = botCache
        starter = AidenBotChatStarter(cache: chatCache)
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

    /// Makes the Bot's first chat on its own machine, then opens it. A link
    /// never does this on the person's behalf; only the button on `.noChat` does.
    func startChat(coordinator: AidenRemoteCoordinator) async {
        guard case .noChat(_, true) = state, !isStarting,
              let context = try? coordinator.ownerContext(for: id.instanceId) else { return }
        isStarting = true
        defer { isStarting = false }
        guard await starter.start(botID: id.objectId, coordinator: coordinator, context: context) else { return }
        state = .loading
        await load(coordinator: coordinator)
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
                    // A link never starts a chat on the person's behalf: the
                    // route offers to, on the Bot's own machine.
                    let bot = try await client.bot(id: id.objectId)
                    guard coordinator.holds(context) else { return }
                    state = .noChat(
                        name: bot.name,
                        canStart: canWrite && bot.health == .ready && connection.installation.canWriteBots
                    )
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
                    machine: model.id.instanceId
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
            case .noChat(let name, let canStart):
                ContentUnavailableView {
                    Label("No chat yet", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text(canStart
                        ? String(localized: "Start a chat with \(name).")
                        : String(localized: "\(name) has no chat yet, and its machine can’t start one right now."))
                } actions: {
                    if canStart {
                        Button("Start chat") {
                            Task { await model.startChat(coordinator: coordinator) }
                        }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .disabled(model.isStarting)
                    }
                }
                .background(palette.canvas.ignoresSafeArea())
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

/// One machine's "Bots can message each other", read and written on that
/// machine whichever is selected.
@MainActor
struct AidenMachineBotMessaging {
    let coordinator: AidenRemoteCoordinator
    let instanceId: String

    private var connection: AidenHostConnection? {
        coordinator.hosts.connection(for: instanceId)
    }

    var context: AidenRemoteRequestContext? {
        try? connection?.requestContext(scope: .owner)
    }

    /// The machine lets this phone see and change the setting.
    var isOffered: Bool {
        connection?.installation.hasNegotiatedAccess(to: .botMessaging) == true
    }

    var value: AidenBotMessagingSettings? {
        coordinator.botMessaging.value(for: context)
    }

    var error: String? {
        coordinator.botMessaging.error(for: context)
    }

    var canChange: Bool {
        guard let context, let connection, value != nil else { return false }
        return !coordinator.botMessaging.isSaving(for: context)
            && connection.connectionState == .connected
            && connection.installation.canWriteBots
    }

    /// Reads the setting from the machine's Bot list.
    func load() async {
        guard isOffered, let context, let client = try? coordinator.remoteClient(for: context) else { return }
        let generation = coordinator.botMessaging.generation(for: context)
        guard let list = try? await client.bots(), coordinator.holds(context) else { return }
        coordinator.botMessaging.adopt(list.messaging, context: context, generation: generation)
    }

    func set(enabled: Bool) async {
        guard canChange, let context, let client = try? coordinator.remoteClient(for: context) else { return }
        await coordinator.botMessaging.save(
            enabled: enabled,
            context: context,
            send: { try await client.setBotMessaging(enabled: enabled) },
            read: { try await client.bots().messaging },
            isCurrent: { coordinator.holds(context) }
        )
    }
}

/// The switch at the foot of a machine's Bots, when that machine offers it.
struct AidenMachineBotMessagingRow: View {
    let messaging: AidenMachineBotMessaging

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        Group {
            if messaging.isOffered, let value = messaging.value {
                VStack(alignment: .leading, spacing: 8) {
                    Toggle("Bots can message each other", isOn: Binding(
                        get: { value.enabled },
                        set: { enabled in Task { await messaging.set(enabled: enabled) } }
                    ))
                    .disabled(!messaging.canChange)
                    if let error = messaging.error {
                        Text(error).font(.footnote).foregroundStyle(palette.secondary)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            } else {
                Color.clear.frame(height: 0)
            }
        }
        .task(id: messaging.context) {
            if messaging.value == nil { await messaging.load() }
        }
    }
}

/// A machine's line under its name in the Bots and Workspaces tabs: what its
/// connection says, when it isn't simply connected.
struct AidenMachineSectionStatus: View {
    let coordinator: AidenRemoteCoordinator
    let instanceId: String
    /// "Bots" or "workspaces", as the saved list is named.
    let savedListName: String

    @Environment(\.aidenPalette) private var palette

    private var text: String? {
        switch coordinator.hosts.connection(for: instanceId)?.connectionState {
        case .offline?:
            String(localized: "Offline — showing saved \(savedListName)")
        case .needsPairing?:
            String(localized: "Pair this machine again to see its \(savedListName).")
        case .connecting?:
            String(localized: "Connecting…")
        case .connected?, nil:
            nil
        }
    }

    var body: some View {
        if let text {
            Text(text)
                .font(.footnote)
                .foregroundStyle(palette.secondary)
        }
    }
}

/// A rejected response may have lost to a newer snapshot or deletion. Use the
/// currently cached chat for navigation, and never republish the rejected one.
@MainActor
func aidenPersistBotChatForPresentation(
    _ chat: AidenChat,
    context: AidenRemoteRequestContext,
    coordinator: AidenRemoteCoordinator,
    cache: AidenChatCache = .shared,
    writeToken: UInt64? = nil
) async -> AidenChat? {
    let writeToken = writeToken ?? cache.reserveChatWrite()
    var candidate: AidenChat?
    let retained = await coordinator.withRetainedInstallationData(for: context) {
        _ = try? await cache.saveChat(chat, instanceId: context.instanceId, writeToken: writeToken)
        candidate = await cache.admittedChat(instanceId: context.instanceId, chatId: chat.id)
    }
    guard retained, coordinator.holds(context),
          let candidate, candidate.id == chat.id, candidate.botId == chat.botId else { return nil }
    return candidate
}

/// A Bot chat accepts messages from this phone only when the phone may write
/// Bots and the Bot still exists. What the Bot may use is decided on the Mac.
func aidenBotChatAllowsMutations(canWrite: Bool, botHealth: AidenBotHealth) -> Bool {
    _ = botHealth
    return canWrite
}

/// Only an exact, Mac-authored Bot chat may cross the fast local-cache path.
/// The optional Bot identity is supplied by inbox navigation; restored paths
/// still require the cached chat to carry an authoritative Bot identity.
func aidenAdmittedCachedBotChat(
    _ chat: AidenChat?,
    chatID: String,
    botID: String? = nil
) -> AidenChat? {
    guard let chat,
          chat.id == chatID,
          chat.isBotChat,
          botID == nil || chat.botId == botID else { return nil }
    return chat
}

/// Matches the stable Bot chat chrome closely enough that a cache miss does
/// not cause a blank screen or layout jump while the Mac returns the chat.
struct AidenBotChatSkeletonView: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 14) {
                VStack(spacing: 5) {
                    AidenBotSkeletonBlock(
                        width: 60,
                        height: 60,
                        radius: 30,
                        reduceMotion: reduceMotion
                    )
                    AidenBotSkeletonBlock(
                        width: 118,
                        height: 30,
                        radius: 15,
                        reduceMotion: reduceMotion
                    )
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, 16)

                AidenBotSkeletonBlock(
                    width: 206,
                    height: 48,
                    radius: 20,
                    reduceMotion: reduceMotion
                )
                AidenBotSkeletonBlock(
                    width: 252,
                    height: 70,
                    radius: 20,
                    reduceMotion: reduceMotion
                )
                HStack {
                    Spacer(minLength: 72)
                    AidenBotSkeletonBlock(
                        width: 164,
                        height: 48,
                        radius: 20,
                        reduceMotion: reduceMotion
                    )
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 104)

            HStack(spacing: 10) {
                AidenBotSkeletonBlock(
                    width: 46,
                    height: 46,
                    radius: 23,
                    reduceMotion: reduceMotion
                )
                AidenBotSkeletonBlock(
                    width: nil,
                    height: 64,
                    radius: 24,
                    reduceMotion: reduceMotion
                )
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 10)
        }
        .background(palette.canvas.ignoresSafeArea())
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Image(systemName: AidenChromeSymbols.overflowMenu)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading Bot conversation")
    }
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
