import Foundation
import Observation

/// A Bot conversation that matched a search, on the machine that holds it.
struct AidenSearchBotHit: Identifiable, Equatable, Sendable {
    /// The conversation. Host-scoped, because two machines can hold the same id.
    let id: AidenHostObjectID
    /// The Bot it belongs to, on that same machine.
    let botID: AidenHostObjectID
    let machineName: String
    let title: String
    let preview: String?
    let updatedAt: Date

    var route: AidenAppRoute { .bot(botID) }
}

extension AidenUnifiedInboxRow {
    var route: AidenAppRoute { .chat(id) }
}

/// What chat search reads: the same input the Inbox merges. The Inbox store
/// supplies it. Until that store is wired, the shell supplies the selected
/// machine alone (`selectedMachine(of:chats:)`).
struct AidenSearchChatInput {
    var snapshots: [AidenHostInboxSnapshot]
    var hiddenMachines: Set<String> = []
}

/// One paired machine as search sees it. Whether it can be asked, and how, is
/// the machine's own, never the selection's.
struct AidenSearchMachine {
    let instanceId: String
    let deviceId: String
    let name: String
    /// The machine negotiated `bot:read`. Without it there is nothing to find.
    let canReadBots: Bool
    /// Connected now. A machine that isn't is skipped, not connected for the search.
    let isConnected: Bool
    let searchBots: @MainActor @Sendable (_ query: String) async throws -> [AidenBotConversationItem]

    var canBeAsked: Bool { canReadBots && isConnected }
}

@MainActor @Observable
final class AidenSearchModel {
    /// Waits for the last keystroke before a machine is asked.
    static let debounce = Duration.milliseconds(300)
    /// The most a Bot search query carries (`AidenBotConversationQuery`).
    static let maxBotQueryScalars = 200

    var query = ""
    private(set) var bots: [AidenSearchBotHit] = []
    /// Machines that have Bots but couldn't be searched: not connected, or
    /// they didn't answer. In the order the machines are listed.
    private(set) var unsearchedMachines: [String] = []
    private(set) var isSearchingBots = false

    @ObservationIgnored private let chatInput: @MainActor () -> AidenSearchChatInput
    @ObservationIgnored private let machines: @MainActor () -> [AidenSearchMachine]
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let clock: any Clock<Duration>
    /// Each `run()` takes a number. Only the newest one may change what's shown.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var inFlight: Task<Void, Never>?
    @ObservationIgnored private var hitsByMachine: [String: [AidenSearchBotHit]] = [:]
    @ObservationIgnored private var failedMachines: Set<String> = []

    init(
        chatInput: @escaping @MainActor () -> AidenSearchChatInput,
        machines: @escaping @MainActor () -> [AidenSearchMachine],
        now: @escaping () -> Date = Date.init,
        clock: any Clock<Duration> = ContinuousClock()
    ) {
        self.chatInput = chatInput
        self.machines = machines
        self.now = now
        self.clock = clock
    }

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// False for an empty or blank query, which shows nothing and asks nothing.
    var hasQuery: Bool { !trimmedQuery.isEmpty }

    /// Matching loaded chats, as the Inbox places them. Read from the Inbox's
    /// own input on every call, so it follows the query as it's typed and asks
    /// no machine anything.
    var chats: [AidenUnifiedInboxRow] {
        let text = trimmedQuery
        guard !text.isEmpty else { return [] }
        let input = chatInput()
        let inbox = AidenUnifiedInbox.make(
            snapshots: input.snapshots,
            filter: .all,
            hiddenMachines: input.hiddenMachines,
            openChat: nil,
            now: now(),
            searchText: text,
            showAllEarlier: true
        )
        // Running chats are in no list of the Inbox, but a search must find them.
        return inbox.needsYou + inbox.running + inbox.updates + inbox.earlier
    }

    func machineName(for instanceId: String) -> String? {
        machines().first { $0.instanceId == instanceId }?.name
    }

    func workspaceName(for row: AidenUnifiedInboxRow) -> String? {
        guard case .chat(let summary, _) = row.content else { return nil }
        return chatInput().snapshots.first {
            $0.instanceId == row.id.instanceId && $0.deviceId == row.id.deviceId
        }?.workspaceNames[summary.workspaceId]
    }

    /// Searches for the current query. Chats don't need it. This asks each
    /// connected machine that can read Bots, once, after the debounce. A newer
    /// call, or a cancelled caller, stops the older one, and an older query's
    /// reply that arrives anyway is dropped.
    func run() async {
        generation &+= 1
        let mine = generation
        inFlight?.cancel()
        inFlight = nil
        let text = trimmedQuery
        let all = machines()
        hitsByMachine = [:]
        failedMachines = []
        bots = []
        guard !text.isEmpty else {
            unsearchedMachines = []
            isSearchingBots = false
            return
        }
        unsearchedMachines = Self.unsearched(in: all, failed: [])
        isSearchingBots = all.contains(where: \.canBeAsked)
        guard isSearchingBots else { return }

        let work = Task { await self.askMachines(about: text, generation: mine) }
        inFlight = work
        await withTaskCancellationHandler {
            await work.value
        } onCancel: {
            work.cancel()
        }
    }

    private func askMachines(about text: String, generation mine: Int) async {
        do {
            try await clock.sleep(for: Self.debounce)
        } catch {
            if mine == generation { isSearchingBots = false }
            return
        }
        guard mine == generation else { return }
        // The machines may have changed while the person typed.
        let all = machines()
        unsearchedMachines = Self.unsearched(in: all, failed: [])
        let askable = all.filter(\.canBeAsked)
        guard !askable.isEmpty else {
            isSearchingBots = false
            return
        }
        let botQuery = String(String.UnicodeScalarView(text.unicodeScalars.prefix(Self.maxBotQueryScalars)))

        typealias Outcome = (machine: AidenSearchMachine, result: Result<[AidenBotConversationItem], Error>)
        await withTaskGroup(of: Outcome.self) { group in
            for machine in askable {
                group.addTask { @MainActor in
                    do {
                        return (machine, .success(try await machine.searchBots(botQuery)))
                    } catch {
                        return (machine, .failure(error))
                    }
                }
            }
            // Each machine's hits show as they arrive, so a slow one holds up no other.
            for await outcome in group {
                guard mine == generation else { continue }
                switch outcome.result {
                case .success(let items):
                    hitsByMachine[outcome.machine.instanceId] = Self.hits(from: items, on: outcome.machine)
                    bots = Self.merged(hitsByMachine, order: all)
                case .failure(let error):
                    // Stopping a search isn't a machine failing.
                    guard !aidenIsCancellation(error) else { continue }
                    failedMachines.insert(outcome.machine.instanceId)
                    unsearchedMachines = Self.unsearched(in: all, failed: failedMachines)
                }
            }
        }
        guard mine == generation else { return }
        isSearchingBots = false
    }

    private static func unsearched(in machines: [AidenSearchMachine], failed: Set<String>) -> [String] {
        machines
            .filter { $0.canReadBots && (!$0.isConnected || failed.contains($0.instanceId)) }
            .map(\.name)
    }

    private static func hits(from items: [AidenBotConversationItem], on machine: AidenSearchMachine) -> [AidenSearchBotHit] {
        // A Bot has one durable chat, so a Bot is one hit.
        aidenCanonicalBotConversations(items).map { item in
            AidenSearchBotHit(
                id: AidenHostObjectID(instanceId: machine.instanceId, deviceId: machine.deviceId, objectId: item.chatId),
                botID: AidenHostObjectID(instanceId: machine.instanceId, deviceId: machine.deviceId, objectId: item.botId),
                machineName: machine.name,
                title: item.title.isEmpty ? String(localized: "Untitled conversation") : item.title,
                preview: item.preview?.isEmpty == false ? item.preview : nil,
                updatedAt: item.updatedAt
            )
        }
    }

    /// Newest first, then the machines' order, so the list never depends on
    /// which machine answered first.
    private static func merged(_ hits: [String: [AidenSearchBotHit]], order: [AidenSearchMachine]) -> [AidenSearchBotHit] {
        let rank = Dictionary(order.enumerated().map { ($1.instanceId, $0) }, uniquingKeysWith: { first, _ in first })
        return hits.values.flatMap { $0 }.sorted { left, right in
            if left.updatedAt != right.updatedAt { return left.updatedAt > right.updatedAt }
            let leftRank = rank[left.id.instanceId] ?? .max
            let rightRank = rank[right.id.instanceId] ?? .max
            if leftRank != rightRank { return leftRank < rightRank }
            return left.id.objectId < right.id.objectId
        }
    }
}

// MARK: - From the coordinator

extension AidenSearchMachine {
    /// Every paired machine, each judged on its own connection. Asking starts
    /// no connection and leaves the selection where it was.
    @MainActor
    static func machines(in coordinator: AidenRemoteCoordinator) -> [AidenSearchMachine] {
        coordinator.hosts.ordered.map { connection in
            let instanceId = connection.instanceId
            let deviceId = connection.installation.deviceId
            return AidenSearchMachine(
                instanceId: instanceId,
                deviceId: deviceId,
                name: connection.installation.name,
                canReadBots: connection.installation.isBotsEligible,
                isConnected: !connection.isRevoked && connection.connectionState == .connected,
                searchBots: { [weak coordinator] query in
                    guard let coordinator else { throw CancellationError() }
                    let context = try coordinator.ownerContext(for: instanceId)
                    guard context.deviceId == deviceId else { throw AidenRemoteClientError.installationChanged }
                    do {
                        let client = try coordinator.remoteClient(for: context)
                        // The text goes as a query item, never in the path.
                        let page = try await client.botConversations(query: AidenBotConversationQuery(query: query))
                        guard coordinator.isLive(context) else { throw AidenRemoteClientError.installationChanged }
                        return page.conversations
                    } catch {
                        _ = await coordinator.handleCredentialRevocation(error, context: context)
                        throw error
                    }
                }
            )
        }
    }
}

extension AidenSearchChatInput {
    /// The selected machine's loaded chats alone, until the Inbox store gives
    /// every machine's.
    @MainActor
    static func selectedMachine(of coordinator: AidenRemoteCoordinator, chats: [AidenChatSummary]) -> Self {
        guard let instanceId = coordinator.activeInstanceId,
              let connection = coordinator.hosts.connection(for: instanceId) else {
            return Self(snapshots: [])
        }
        return Self(snapshots: [AidenHostInboxSnapshot(
            instanceId: instanceId,
            deviceId: connection.installation.deviceId,
            chats: chats,
            workspaceNames: Dictionary(
                connection.workspaces.map { ($0.id, $0.name) },
                uniquingKeysWith: { first, _ in first }
            ),
            isOnline: connection.connectionState == .connected,
            isBlocked: connection.isRevoked,
            fetchedAt: nil
        )])
    }
}
