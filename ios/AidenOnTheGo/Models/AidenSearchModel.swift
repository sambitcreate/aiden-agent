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

/// What chat search reads: the same input the Inbox merges, from the Inbox store
/// (`init(store:)`).
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
    /// The Inbox treats it as gone: revoked, waiting to be purged, or needing to
    /// be paired again. Its Bots are neither searched nor shown, and it isn't
    /// named as one that couldn't be searched.
    var isBlocked = false
    let searchBots: @MainActor @Sendable (_ query: String) async throws -> [AidenBotConversationItem]

    var canBeAsked: Bool { canReadBots && isConnected && !isBlocked }
}

@MainActor @Observable
final class AidenSearchModel {
    /// Waits for the last keystroke before a machine is asked.
    static let debounce = Duration.milliseconds(300)
    /// The most a Bot search query carries (`AidenBotConversationQuery`).
    static let maxBotQueryScalars = 200

    var query = ""
    private(set) var isSearchingBots = false
    private var isSearching = false
    private var skippedMachines: Set<String> = []
    private var failedMachines: Set<String> = []
    private var hitsByMachine: [String: [AidenSearchBotHit]] = [:]

    @ObservationIgnored private let chatInput: @MainActor () -> AidenSearchChatInput
    @ObservationIgnored private let machines: @MainActor () -> [AidenSearchMachine]
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let clock: any Clock<Duration>
    /// Each `run()` takes a number. Only the newest one may change what's shown.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var inFlight: Task<Void, Never>?

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

    /// What is searched for. The view runs a search for each change of it.
    var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Bot conversations found so far, newest first. Read against the machines
    /// as they are now, so a machine that was revoked, hidden or forgotten after
    /// its hits landed has none left, without waiting for another keystroke.
    var bots: [AidenSearchBotHit] {
        guard isSearching else { return [] }
        let current = machines()
        let shown = Set(current.filter { !$0.isBlocked }.map { Self.key($0.instanceId, $0.deviceId) })
        return Self.merged(
            hitsByMachine.filter { entry in
                entry.value.first.map { shown.contains(Self.key($0.id.instanceId, $0.id.deviceId)) } ?? false
            },
            order: current
        )
    }

    /// Machines that have Bots but couldn't be searched: not connected, or
    /// they didn't answer. In the order the machines are listed. A machine that
    /// is revoked, hidden or gone isn't one the person is waiting on.
    var unsearchedMachines: [String] {
        guard isSearching else { return [] }
        return machines()
            .filter { $0.canReadBots && !$0.isBlocked && (skippedMachines.contains($0.instanceId) || failedMachines.contains($0.instanceId)) }
            .map(\.name)
    }

    private static func key(_ instanceId: String, _ deviceId: String) -> String {
        "\(instanceId)\u{0}\(deviceId)"
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
        // Bots are found by their own search, not as chats.
        return (inbox.needsYou + inbox.running + inbox.updates + inbox.earlier).filter { !$0.isBot }
    }

    /// What a chat row says about where it lives. Built once for a render, not
    /// once per row.
    func chatDetails() -> AidenSearchChatDetails {
        AidenSearchChatDetails(
            machineNames: Dictionary(machines().map { ($0.instanceId, $0.name) }, uniquingKeysWith: { first, _ in first }),
            snapshots: chatInput().snapshots
        )
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
        skippedMachines = []
        guard !text.isEmpty else {
            isSearching = false
            isSearchingBots = false
            return
        }
        isSearching = true
        skippedMachines = Self.skipped(in: all)
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
        skippedMachines = Self.skipped(in: all)
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
                case .failure(let error):
                    // Stopping a search isn't a machine failing.
                    guard !aidenIsCancellation(error) else { continue }
                    failedMachines.insert(outcome.machine.instanceId)
                }
            }
        }
        guard mine == generation else { return }
        isSearchingBots = false
    }

    /// Machines with Bots that weren't connected when the search began.
    private static func skipped(in machines: [AidenSearchMachine]) -> Set<String> {
        Set(machines.filter { $0.canReadBots && !$0.isConnected }.map(\.instanceId))
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
    ///
    /// A machine the person hid from the Inbox isn't listed: it isn't asked, its
    /// hits aren't shown, and it isn't named.
    @MainActor
    static func machines(
        in coordinator: AidenRemoteCoordinator,
        preferences: AidenMachinePreferencesStore = .shared
    ) -> [AidenSearchMachine] {
        coordinator.hosts.ordered.filter { !preferences.isHidden($0.instanceId) }.map { connection in
            let instanceId = connection.instanceId
            let deviceId = connection.installation.deviceId
            return AidenSearchMachine(
                instanceId: instanceId,
                deviceId: deviceId,
                name: connection.installation.name,
                canReadBots: connection.installation.isBotsEligible,
                isConnected: !connection.isBlockedFromInbox && connection.connectionState == .connected,
                isBlocked: connection.isBlockedFromInbox,
                searchBots: { [weak coordinator] query in
                    guard let coordinator else { throw CancellationError() }
                    let context = try coordinator.ownerContext(for: instanceId)
                    guard context.deviceId == deviceId else { throw AidenRemoteClientError.installationChanged }
                    do {
                        let client = try coordinator.remoteClient(for: context)
                        // The text goes as a query item, never in the path.
                        let page = try await client.botConversations(query: AidenBotConversationQuery(query: query, limit: AidenBotWire.maxConversationPage))
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

/// Where each chat row lives: its machine's name and its workspace's name.
struct AidenSearchChatDetails {
    let machineNames: [String: String]
    let snapshots: [AidenHostInboxSnapshot]

    func machineName(for row: AidenUnifiedInboxRow) -> String? {
        machineNames[row.id.instanceId]
    }

    func workspaceName(for row: AidenUnifiedInboxRow) -> String? {
        guard case .chat(let summary, _) = row.content else { return nil }
        return snapshots.first {
            $0.instanceId == row.id.instanceId && $0.deviceId == row.id.deviceId
        }?.workspaceNames[summary.workspaceId]
    }
}

extension AidenSearchChatInput {
    /// Every machine's loaded chats, as the Inbox holds them, with the machines
    /// the person hid. Read inside a view body, it follows the store.
    @MainActor
    init(store: AidenUnifiedInboxStore) {
        self.init(snapshots: Array(store.snapshots.values), hiddenMachines: store.hiddenMachines)
    }
}
