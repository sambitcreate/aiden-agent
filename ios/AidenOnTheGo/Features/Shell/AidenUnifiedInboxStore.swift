import Foundation
import Observation

/// Every paired machine's chats in one Inbox (spec, "Feed"). Phones get no
/// list-level live feed, so this polls each machine while the app is in the
/// foreground, and only then. `start()` and `stop()` follow the scene.
///
/// Each machine has one `AidenHomeModel`, which does the reading and holds the
/// optimistic edits. This store decides when each machine is read, and turns the
/// models into `snapshots` and `inbox`. A machine's rows follow its connection:
/// a revoked or forgotten machine's rows go as soon as the connection says so,
/// not at the next poll.
///
/// A machine that isn't connected is never polled. It goes to `connectScheduler`,
/// which holds every connect to its limit, and its first poll follows the moment
/// that connect lands.
@MainActor
@Observable
final class AidenUnifiedInboxStore {
    private(set) var snapshots: [String: AidenHostInboxSnapshot] = [:]
    /// Machines the person hid from the Inbox. Search reads them with `snapshots`.
    private(set) var hiddenMachines: Set<String> = []
    /// Built when its inputs change, so a view can read it freely.
    private(set) var inbox = AidenUnifiedInbox()
    /// The tab's badge. Kept apart from `inbox`, so whoever shows it redraws
    /// when the count changes and not with every row.
    private(set) var needsYouCount = 0
    private(set) var listState = AidenInboxListState.loading
    /// A listed machine answered with a failure, and saved rows are standing in.
    private(set) var refreshFailed = false
    private(set) var moreChats = AidenInboxMoreChats.none
    /// The newest banner. `perform` clears the others, so there's only ever one.
    private(set) var notice: AidenInboxMachineNotice?
    /// A machine that stops being shown puts this back to `.all`.
    var filter: AidenMachineFilter = .all {
        didSet { if filter != oldValue { settle() } }
    }
    /// The chat on screen, which is never news.
    var openChat: AidenHostObjectID? {
        didSet { if openChat != oldValue { settle() } }
    }
    var searchText = "" {
        didSet { if searchText != oldValue { settle() } }
    }
    /// Show N more: Earlier past its cap.
    var showsAllEarlier = false {
        didSet { if showsAllEarlier != oldValue { settle() } }
    }
    /// Set by whoever owns the scheduler. Without it an unreachable machine
    /// stays that way until something else connects it.
    @ObservationIgnored weak var connectScheduler: AidenHostConnectScheduler?

    @ObservationIgnored private let hosts: AidenHostRegistry
    @ObservationIgnored private let preferences: AidenMachinePreferencesStore
    @ObservationIgnored private let cache: AidenChatCache
    @ObservationIgnored private let drafts: AidenChatDraftStore
    @ObservationIgnored private let timing: Timing
    @ObservationIgnored private let drawJitter: @MainActor () -> Double
    @ObservationIgnored private let now: @MainActor () -> Date

    @ObservationIgnored private var machines: [String: Machine] = [:]
    @ObservationIgnored private var pollers: [String: Poller] = [:]
    // Kept apart from `Poller` so `deinit` can reach them.
    @ObservationIgnored private var loops: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var fetches: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var isRunning = false
    @ObservationIgnored private var isInboxVisible = false
    @ObservationIgnored private var focusedMachine: String?
    @ObservationIgnored private var builtFrom: InboxInputs?
    @ObservationIgnored private var clockReadings = 0
    /// Shown and inside the filter.
    @ObservationIgnored private var listedMachines: [String] = []

    init(
        hosts: AidenHostRegistry,
        preferences: AidenMachinePreferencesStore,
        cache: AidenChatCache,
        clock: any Clock<Duration>,
        drafts: AidenChatDraftStore = .shared,
        jitter: @escaping @MainActor () -> Double = { .random(in: AidenInboxPollPolicy.jitterRange) },
        now: @escaping @MainActor () -> Date = { Date() }
    ) {
        self.hosts = hosts
        self.preferences = preferences
        self.cache = cache
        self.drafts = drafts
        timing = Timing(clock)
        drawJitter = jitter
        self.now = now
        watchMachines()
    }

    deinit {
        loops.values.forEach { $0.cancel() }
        fetches.values.forEach { $0.cancel() }
    }

    /// Begins polling. A machine's first poll since `start()` is a cold start.
    func start() {
        guard !isRunning else { return }
        isRunning = true
        settle()
    }

    /// Ends every poll, including one still out. Rows stay as they were.
    func stop() {
        guard isRunning else { return }
        isRunning = false
        for instanceId in Array(pollers.keys) { endPolling(instanceId) }
    }

    /// Pull to refresh: every connected machine at once. A machine with a poll
    /// already out joins it.
    func refreshAll() async {
        var running: [Task<Void, Never>] = []
        for (instanceId, poller) in pollers {
            guard let connection = hosts.connection(for: instanceId),
                  connection.connectionState == .connected,
                  let fetch = fetch(poller, instanceId, connection) else { continue }
            running.append(fetch)
        }
        for fetch in running { await fetch.value }
    }

    func setInboxVisible(_ visible: Bool) {
        guard visible != isInboxVisible else { return }
        isInboxVisible = visible
        wakeEveryPoller()
    }

    /// The machine with a chat open, which polls fastest while the Inbox shows.
    func setFocusedMachine(_ instanceId: String?) {
        guard instanceId != focusedMachine else { return }
        focusedMachine = instanceId
        wakeEveryPoller()
    }

    /// The model that reads `instanceId`, for acting on its rows.
    func homeModel(for instanceId: String) -> AidenHomeModel? {
        machines[instanceId]?.model
    }

    // MARK: Acting on rows

    /// One swipe, on the model the row is drawn from, so its optimistic edit is
    /// the one on screen. A row is acted on over its own machine, selected or not.
    func perform(_ action: AidenInboxRowAction, on id: AidenHostObjectID) async {
        guard let (model, connection) = owner(of: id) else { return }
        machines.values.forEach { $0.model.inboxNotice = nil }
        func triage(_ change: AidenChatTriageChange) async {
            await model.setTriage(change, chatID: id.objectId, host: connection, isOpen: id == openChat, now: now())
        }
        switch action {
        case .markRead: await model.markRead(chatID: id.objectId, host: connection)
        case .done: await triage(.done(true))
        case .undone: await triage(.done(false))
        case .snooze(let option): await triage(.snooze(until: option.until))
        case .wake: await triage(.wake)
        case .delete: await delete(id)
        }
    }

    /// Undo is sent against the swipe's own revision, so a notice without one
    /// offers none rather than writing unconditionally.
    func undo(_ notice: AidenInboxMachineNotice) async {
        guard let model = homeModel(for: notice.instanceId),
              let connection = hosts.connection(for: notice.instanceId),
              let undo = notice.notice.undo, let chatID = notice.notice.chatID,
              let revision = notice.notice.revision else { return }
        model.inboxNotice = nil
        await model.setTriage(undo, chatID: chatID, host: connection, now: now(), undoRevision: revision)
    }

    func dismissNotice() {
        guard let notice else { return }
        homeModel(for: notice.instanceId)?.inboxNotice = nil
    }

    /// A row from an older pairing of a machine goes nowhere: `id` was issued to
    /// a device that machine no longer knows, or the store no longer reads.
    private func owner(of id: AidenHostObjectID) -> (AidenHomeModel, AidenHostConnection)? {
        guard let machine = machines[id.instanceId], machine.lease.deviceId == id.deviceId,
              let connection = hosts.connection(for: id.instanceId),
              connection.installation.deviceId == id.deviceId else { return nil }
        return (machine.model, connection)
    }

    // MARK: Reading on demand

    /// Older chats, from every listed machine that has them, each at its own pace.
    func loadMoreChats() async {
        let reads = listedMachines.compactMap { instanceId -> Task<Void, Never>? in
            guard let model = homeModel(for: instanceId), model.nextChatCursor != nil,
                  let connection = hosts.connection(for: instanceId) else { return nil }
            return Task { await model.loadMoreChats(host: connection) }
        }
        for read in reads { await read.value }
    }

    /// Try Again: reads the machines that are connected, and queues the rest.
    func retry() async {
        for instanceId in listedMachines where hosts.connection(for: instanceId)?.connectionState != .connected {
            connectScheduler?.connect(instanceId: instanceId)
        }
        await refreshAll()
    }

    /// Snoozes end and Earlier ages out on this phone's clock, with no change on
    /// any machine to say so.
    func refreshClock() {
        clockReadings += 1
        settle()
    }

    // MARK: Following the machines

    /// Re-reads every machine each time anything read here changes, so a
    /// connection that says it was revoked needs no poll to be believed.
    private func watchMachines() {
        let readings = withObservationTracking {
            readMachines()
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.watchMachines() }
        }
        apply(readings)
    }

    private func settle() {
        apply(readMachines())
    }

    /// Reading a machine's preferences is what assigns its colour, so a machine
    /// has one by the time a view asks.
    private func readMachines() -> [MachineReading] {
        hosts.ordered.map { connection in
            let isBlocked = connection.isBlockedFromInbox
            let isHidden = preferences.preferences(for: connection.instanceId).isHidden
            let machine = isBlocked ? nil : machine(for: connection)
            let workspaces = connection.workspaces
            return MachineReading(
                connection: connection,
                machine: machine,
                chats: machine?.model.chats ?? [],
                workspaceNames: isBlocked ? [:] : workspaces.isEmpty ? machine?.savedWorkspaceNames ?? [:] : Self.names(of: workspaces),
                isConnected: connection.connectionState == .connected,
                isOnline: connection.isKnownOnline,
                isOffline: connection.isKnownOffline,
                isBlocked: isBlocked,
                isHidden: isHidden,
                supportsReadState: connection.server?.supportsChatReadState == true,
                supportsTriage: connection.server?.supportsChatTriage == true
                    && connection.installation.hasNegotiatedAccess(to: .chatWrite),
                loadState: machine?.model.chatListLoadState ?? .unresolved,
                pagination: machine?.model.paginationState ?? .idle,
                hasMoreChats: machine?.model.nextChatCursor != nil,
                notice: machine?.model.inboxNotice
            )
        }
    }

    /// The record for this pairing of the machine. A re-pairing starts again, so
    /// nothing from the old lease can land on the new one.
    private func machine(for connection: AidenHostConnection) -> Machine {
        let lease = Lease(deviceId: connection.installation.deviceId, hostGeneration: connection.hostGeneration)
        let instanceId = connection.instanceId
        if let machine = machines[instanceId], machine.lease == lease { return machine }
        endPolling(instanceId)
        let machine = Machine(lease: lease, model: AidenHomeModel(chatCache: cache))
        machines[instanceId] = machine
        let cache = cache
        machine.savedRows = Task { [weak self] in
            await machine.model.showSavedChats(host: connection)
            machine.savedWorkspaceNames = Self.names(of: await cache.loadWorkspaces(instanceId: instanceId) ?? [])
            self?.settle()
        }
        return machine
    }

    private static func names(of workspaces: [AidenWorkspace]) -> [String: String] {
        Dictionary(workspaces.map { ($0.id, AidenNoWorkspace.label(for: $0)) }, uniquingKeysWith: { first, _ in first })
    }

    private func apply(_ readings: [MachineReading]) {
        let present = Set(readings.map(\.connection.instanceId))
        for instanceId in machines.keys where !present.contains(instanceId) {
            endPolling(instanceId)
            machines[instanceId] = nil
        }
        var latest: [String: AidenHostInboxSnapshot] = [:]
        for reading in readings {
            let connection = reading.connection
            if reading.isBlocked {
                endPolling(connection.instanceId)
                machines[connection.instanceId] = nil
            }
            latest[connection.instanceId] = AidenHostInboxSnapshot(
                instanceId: connection.instanceId,
                deviceId: connection.installation.deviceId,
                chats: reading.chats,
                workspaceNames: reading.workspaceNames,
                isOnline: reading.isOnline,
                isBlocked: reading.isBlocked,
                fetchedAt: reading.machine?.fetchedAt,
                supportsReadState: reading.supportsReadState,
                supportsTriage: reading.supportsTriage
            )
        }
        if latest != snapshots { snapshots = latest }
        if isRunning { followPollers(readings) }

        let shown = readings.filter { !$0.isBlocked && !$0.isHidden }
        if case .machine(let instanceId) = filter, !shown.contains(where: { $0.connection.instanceId == instanceId }) {
            filter = .all
        }
        let hidden = Set(readings.filter(\.isHidden).map(\.connection.instanceId))
        if hidden != hiddenMachines { hiddenMachines = hidden }
        let inputs = InboxInputs(
            snapshots: snapshots,
            filter: filter,
            hiddenMachines: hidden,
            openChat: openChat,
            searchText: searchText,
            showsAllEarlier: showsAllEarlier,
            clockReadings: clockReadings
        )
        if inputs != builtFrom {
            builtFrom = inputs
            let rebuilt = AidenUnifiedInbox.make(
                snapshots: Array(snapshots.values),
                filter: filter,
                hiddenMachines: hidden,
                openChat: openChat,
                now: now(),
                searchText: searchText,
                showAllEarlier: showsAllEarlier
            )
            if rebuilt != inbox { inbox = rebuilt }
            if rebuilt.needsYouCount != needsYouCount { needsYouCount = rebuilt.needsYouCount }
        }
        describeTheList(shown: shown, hasHiddenMachines: !hidden.isEmpty)
    }

    /// Everything the list says besides its rows.
    private func describeTheList(shown: [MachineReading], hasHiddenMachines: Bool) {
        let listed = shown.filter { filter == .all || filter == .machine($0.connection.instanceId) }
        listedMachines = listed.map(\.connection.instanceId)

        let state = AidenInboxListState.make(
            hasRows: !(inbox.needsYou.isEmpty && inbox.updates.isEmpty && inbox.earlier.isEmpty),
            machines: listed.map(\.read),
            hasHiddenMachines: hasHiddenMachines
        )
        if state != listState { listState = state }

        // A list with nothing else to show says this itself.
        var failed = listed.contains { $0.read.failure != nil }
        if case .failed = state { failed = false }
        if failed != refreshFailed { refreshFailed = failed }

        let more = AidenInboxMoreChats.make(listed)
        if more != moreChats { moreChats = more }

        let newest = shown
            .compactMap { reading in
                reading.notice.map { AidenInboxMachineNotice(instanceId: reading.connection.instanceId, notice: $0) }
            }
            .max { $0.notice.postedAt < $1.notice.postedAt }
        if newest != notice { notice = newest }
    }

    // MARK: Polling

    /// Hidden machines aren't read: nothing shows them.
    private func followPollers(_ readings: [MachineReading]) {
        let wanted = readings.filter { !$0.isBlocked && !$0.isHidden }
        let wantedIDs = Set(wanted.map(\.connection.instanceId))
        let countBefore = pollers.count
        for instanceId in pollers.keys where !wantedIDs.contains(instanceId) { endPolling(instanceId) }
        var changed = pollers.count != countBefore
        for reading in wanted {
            let instanceId = reading.connection.instanceId
            guard let poller = pollers[instanceId] else {
                pollers[instanceId] = Poller(isConnected: reading.isConnected)
                loops[instanceId] = pollLoop(instanceId)
                changed = true
                continue
            }
            if reading.isConnected, !poller.isConnected {
                // However it got connected, it can be read now.
                poller.isDue = true
                poller.nap?.cancel()
            }
            poller.isConnected = reading.isConnected
        }
        // One machine more or fewer can change who is the only machine.
        if changed { wakeEveryPoller() }
    }

    private func endPolling(_ instanceId: String) {
        loops.removeValue(forKey: instanceId)?.cancel()
        fetches.removeValue(forKey: instanceId)?.cancel()
        machines[instanceId]?.model.cancelTranscriptPrefetch()
        pollers[instanceId] = nil
    }

    private func wakeEveryPoller() {
        pollers.values.forEach { $0.nap?.cancel() }
    }

    /// Holds no reference to the store while it sleeps, so the store can go.
    private func pollLoop(_ instanceId: String) -> Task<Void, Never> {
        Task { [weak self] in
            while !Task.isCancelled {
                guard let nap = await self?.step(instanceId) else { return }
                await withTaskCancellationHandler {
                    await nap.value
                } onCancel: {
                    nap.cancel()
                }
            }
        }
    }

    /// Polls if the machine is due, and returns the sleep until it next is.
    /// That sleep is cut short by a wake, and the wait is worked out again, so a
    /// role changing moves the next poll without ever putting it off.
    private func step(_ instanceId: String) async -> Task<Void, Never>? {
        guard let poller = pollers[instanceId] else { return nil }
        if wait(for: poller, instanceId) <= .zero { await tick(poller, instanceId) }
        guard pollers[instanceId] === poller else { return nil }
        let wait = wait(for: poller, instanceId)
        let timing = timing
        let nap = Task { _ = try? await timing.sleep(wait) }
        poller.nap = nap
        return nap
    }

    private func wait(for poller: Poller, _ instanceId: String) -> Duration {
        guard !poller.isDue, let sinceLastPoll = poller.sinceLastPoll else { return .zero }
        return AidenInboxPollPolicy.delay(
            role: role(of: instanceId),
            failures: poller.failures,
            jitter: poller.jitter
        ) - sinceLastPoll()
    }

    private func role(of instanceId: String) -> AidenInboxPollRole {
        guard isInboxVisible else { return .inboxHidden }
        return instanceId == focusedMachine || pollers.count == 1 ? .focused : .background
    }

    private func tick(_ poller: Poller, _ instanceId: String) async {
        guard let connection = hosts.connection(for: instanceId) else { return }
        poller.startCycle(timing: timing, jitter: drawJitter())
        if connection.connectionState == .connected {
            await fetch(poller, instanceId, connection)?.value
        } else if !connection.isConnectInFlight {
            if connection.isKnownOffline { poller.failures += 1 }
            connectScheduler?.connect(instanceId: instanceId)
        }
    }

    /// One read of a connected machine, shared with anyone who asks while it's
    /// out. It isn't tied to a caller, so a pull that's cancelled leaves it to
    /// finish as an ordinary poll.
    private func fetch(
        _ poller: Poller,
        _ instanceId: String,
        _ connection: AidenHostConnection
    ) -> Task<Void, Never>? {
        if let running = fetches[instanceId] { return running }
        guard let machine = machines[instanceId] else { return nil }
        poller.startCycle(timing: timing, jitter: poller.jitter)
        let walkingPages = !poller.hasWalked
        let startedAt = now()
        let connectBefore = connection.connectionGeneration
        let task = Task { [weak self] in
            // A poll that fails has only the saved rows to leave on screen.
            await machine.savedRows?.value
            var result = await machine.model.pollChats(host: connection, walkingPages: walkingPages, now: startedAt)
            if case .loaded = result, let self { result = await self.learnWorkspaces(of: machine, over: connection) }
            await self?.finish(
                result,
                walkingPages: walkingPages,
                connectBefore: connectBefore,
                machine: machine,
                poller: poller,
                connection: connection
            )
        }
        fetches[instanceId] = task
        return task
    }

    /// A chat shows only under a workspace its machine has named, and a poll
    /// reads chats alone, so a chat from a workspace made since the last connect
    /// asks for the list once. An id the list doesn't hold isn't asked about again.
    /// A 5xx hasn't answered that, so the next polls ask, up to
    /// `AidenInboxPollPolicy.workspaceReadLimit` reads for each id.
    private func learnWorkspaces(of machine: Machine, over connection: AidenHostConnection) async -> AidenHomePollResult {
        let unknown = Set(machine.model.chats.map(\.workspaceId))
            .subtracting(connection.workspaces.map(\.id))
            .subtracting(machine.workspacesAskedAbout)
        guard !unknown.isEmpty else { return .loaded }
        do {
            try await connection.refreshWorkspacesForPoll()
        } catch let error where aidenIsCancellation(error) {
            return .abandoned
        } catch let error as AidenRemoteClientError where error.isCredentialRevoked {
            return .failed(error)
        } catch AidenRemoteClientError.server(let statusCode, _) where statusCode >= 500 {
            // The machine is there and the rows are read, so this poll did its job.
            for id in unknown {
                machine.workspaceReadsFailed[id, default: 0] += 1
                if machine.workspaceReadsFailed[id, default: 0] >= AidenInboxPollPolicy.workspaceReadLimit {
                    machine.workspacesAskedAbout.insert(id)
                }
            }
            return .loaded
        } catch AidenRemoteClientError.server(_, _) {
            // Refused rather than down: asking again would get the same answer.
        } catch {
            return .failed(error)
        }
        machine.workspacesAskedAbout.formUnion(unknown)
        return .loaded
    }

    private func finish(
        _ result: AidenHomePollResult,
        walkingPages: Bool,
        connectBefore: Int,
        machine: Machine,
        poller: Poller,
        connection: AidenHostConnection
    ) async {
        let instanceId = connection.instanceId
        if pollers[instanceId] === poller { fetches[instanceId] = nil }
        switch result {
        case .loaded:
            poller.failures = 0
            if walkingPages {
                poller.hasWalked = true
                // Saved so a first open works once the machine has gone.
                if pollers[instanceId] === poller { machine.model.prefetchRecentTranscripts(host: connection) }
            }
            machine.fetchedAt = now()
            settle()
        case .abandoned:
            break
        case .failed(let error):
            if await connection.handlePollError(error, sinceConnect: connectBefore) { poller.failures += 1 }
        }
    }
}

/// An Inbox banner, and the machine whose model holds it.
struct AidenInboxMachineNotice: Equatable {
    let instanceId: String
    let notice: AidenInboxNotice
}

extension AidenUnifiedInboxStore {
    /// The app's store, on the coordinator's machines and saved chats.
    convenience init(coordinator: AidenRemoteCoordinator) {
        self.init(
            hosts: coordinator.hosts,
            preferences: .shared,
            cache: coordinator.chatCache,
            clock: ContinuousClock()
        )
    }

    /// The row goes at once. If the machine doesn't take the delete it comes back.
    func delete(_ id: AidenHostObjectID) async {
        guard let (model, connection) = owner(of: id), let context = try? connection.homeContext(),
              let index = model.chats.firstIndex(where: { $0.id == id.objectId }) else { return }
        let row = model.chats[index]
        model.removeChat(id: id.objectId)
        do {
            let client = try connection.homeClient(for: context)
            // The machine wants the chat's current revision, and a row can be behind.
            let current = try await client.chat(id: id.objectId)
            guard connection.holdsHomeContext(context) else { return }
            try await client.removeChat(id: id.objectId, revision: current.revision)
            guard connection.holdsHomeContext(context) else { return }
            await cache.removeChat(instanceId: id.instanceId, chatId: id.objectId)
            await drafts.remove(instanceId: id.instanceId, chatId: id.objectId)
            // The machine lets the chat's hidden folder go with it.
            try? await connection.refreshWorkspacesForPoll()
        } catch {
            guard connection.holdsHomeContext(context) else { return }
            if (error as? AidenRemoteClientError)?.isCredentialRevoked == true {
                // Its rows go with it, so there's nothing to bring back.
                _ = await connection.handlePollError(error, sinceConnect: connection.connectionGeneration)
                return
            }
            model.restoreChat(row, at: index)
            guard !aidenIsCancellation(error) else { return }
            model.inboxNotice = AidenInboxNotice(message: String(localized: "Couldn’t delete that chat. It’s back where it was."))
            // The answer may be what was lost, with the chat gone after all.
            _ = await model.pollChats(host: connection, walkingPages: false, now: now())
        }
    }
}

/// `any Clock<Duration>` can sleep, but can't compare two of its own instants, so
/// this keeps the clock's instant type inside.
private struct Timing {
    let sleep: @Sendable (Duration) async throws -> Void
    /// Starts a stopwatch.
    let mark: @MainActor () -> @MainActor () -> Duration

    init<C: Clock>(_ clock: C) where C.Duration == Duration {
        sleep = { try await clock.sleep(for: $0) }
        mark = {
            let start = clock.now
            return { start.duration(to: clock.now) }
        }
    }
}

private struct Lease: Equatable {
    let deviceId: String
    let hostGeneration: Int
}

/// What the store keeps for one pairing of a machine, polling or not.
@MainActor
private final class Machine {
    let lease: Lease
    let model: AidenHomeModel
    var fetchedAt: Date?
    var savedWorkspaceNames: [String: String] = [:]
    /// Reads back what this phone saved, once, when the machine is first seen.
    var savedRows: Task<Void, Never>?
    var workspacesAskedAbout: Set<String> = []
    var workspaceReadsFailed: [String: Int] = [:]

    init(lease: Lease, model: AidenHomeModel) {
        self.lease = lease
        self.model = model
    }
}

/// One machine's polling since `start()`.
@MainActor
private final class Poller {
    var failures = 0
    var jitter = 0.0
    /// Only a cold start walks pages, and it isn't over until a walk lands.
    var hasWalked = false
    var isConnected: Bool
    var isDue = false
    var nap: Task<Void, Never>?
    /// Nil until the first poll, so that one is due at once.
    var sinceLastPoll: (@MainActor () -> Duration)?

    init(isConnected: Bool) {
        self.isConnected = isConnected
    }

    func startCycle(timing: Timing, jitter: Double) {
        sinceLastPoll = timing.mark()
        self.jitter = jitter
        isDue = false
    }
}

private struct MachineReading {
    let connection: AidenHostConnection
    let machine: Machine?
    let chats: [AidenChatSummary]
    let workspaceNames: [String: String]
    let isConnected: Bool
    let isOnline: Bool
    let isOffline: Bool
    let isBlocked: Bool
    let isHidden: Bool
    let supportsReadState: Bool
    let supportsTriage: Bool
    let loadState: AidenHomeModel.ChatListLoadState
    let pagination: AidenHomeModel.PaginationState
    let hasMoreChats: Bool
    let notice: AidenInboxNotice?

    /// A failure from a machine that's gone says nothing `isOffline` doesn't.
    var read: AidenInboxMachineRead {
        var failure: String?
        if case .failed(let message) = loadState, !isOffline { failure = message }
        return AidenInboxMachineRead(
            presentation: .of(
                hasContent: !chats.isEmpty,
                hasSettled: loadState == .loaded,
                failed: isOffline || failure != nil
            ),
            failure: failure
        )
    }
}

private extension AidenInboxMoreChats {
    /// A machine that isn't connected can't be read, so it has no page to offer.
    static func make(_ machines: [MachineReading]) -> Self {
        let reachable = machines.filter(\.isConnected)
        if reachable.contains(where: { $0.pagination == .loading }) { return .loading }
        for machine in reachable {
            if case .failed(let message) = machine.pagination { return .failed(message) }
        }
        return reachable.contains { $0.hasMoreChats && $0.loadState == .loaded } ? .available : .none
    }
}

private struct InboxInputs: Equatable {
    let snapshots: [String: AidenHostInboxSnapshot]
    let filter: AidenMachineFilter
    let hiddenMachines: Set<String>
    let openChat: AidenHostObjectID?
    let searchText: String
    let showsAllEarlier: Bool
    let clockReadings: Int
}

extension AidenHostConnection {
    /// A machine the Inbox shows nothing of: revoked, waiting to be purged, or
    /// needing to be paired again (a missing credential ends there too). Search
    /// reads the same, so what leaves the Inbox leaves Search.
    var isBlockedFromInbox: Bool {
        isRevoked || isPurgePending || connectionState == .needsPairing
    }
}
