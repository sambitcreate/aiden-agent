import Foundation
import Observation
import UIKit
import UserNotifications

/// Lets Aiden's scheduled-run notifications alert while the app is
/// foregrounded — without a center delegate iOS suppresses foreground
/// presentation entirely, which is exactly when this polling feed delivers.
/// Also hands a tapped notification to `openTap`, which sends it to its machine.
final class AidenNotificationPresentationDelegate: NSObject, UNUserNotificationCenterDelegate {
    /// Set at launch, before a tap can arrive.
    @MainActor static var openTap: (@MainActor (AidenNotificationTap) -> Void)?

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let appState = await MainActor.run { AidenRunAlertNotifier.currentAppState() }
        return Self.presentationOptions(identifier: notification.request.identifier, appState: appState)
    }

    /// Scheduled runs alert in the foreground. A run alert that lands after
    /// the user returned to the active app stays quiet: the app already shows
    /// the prompt or result, whichever side of `add` the transition fell on.
    static func presentationOptions(
        identifier: String,
        appState: AidenRunAlertAppState
    ) -> UNNotificationPresentationOptions {
        if identifier.hasPrefix(AidenScheduledRunNotifier.identifierPrefix)
            || identifier.hasPrefix(AidenBotRoutineNotifier.identifierPrefix) {
            return [.banner, .sound, .list]
        }
        if identifier.hasPrefix(AidenRunAlertNotifier.identifierPrefix), appState == .active {
            return []
        }
        return [.banner, .list]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        let tap = AidenNotificationTap(userInfo: response.notification.request.content.userInfo)
        await MainActor.run { Self.openTap?(tap) }
    }
}

/// What a tapped notification says about where it came from.
struct AidenNotificationTap: Equatable, Sendable {
    let link: URL?
    let instanceID: String?

    init(userInfo: [AnyHashable: Any]) {
        link = AidenRunAlertNotifier.deepLink(from: userInfo)
        instanceID = userInfo[AidenRunAlertNotifier.instanceUserInfoKey] as? String
    }

    /// Queues a route to the notification's own machine. A machine that's gone
    /// takes the tap with it, without a word.
    @MainActor
    func open(coordinator: AidenRemoteCoordinator, intents: AidenForegroundIntentRouter? = nil) {
        guard let route = route(on: coordinator), coordinator.canOpen(route) else { return }
        (intents ?? .shared).submit(route: route)
    }

    /// A scheduled run has no chat to open, so its tap opens the machine's page.
    @MainActor
    private func route(on coordinator: AidenRemoteCoordinator) -> AidenAppRoute? {
        if let request = link.flatMap(AidenDeepLink.request(from:)) {
            return AidenAppRoute(
                request: request,
                installations: coordinator.installationStore.installations,
                defaultInstanceId: coordinator.defaultInstanceId
            )
        }
        return instanceID.map { .machine(instanceId: $0) }
    }
}

/// The notification-center surface the identifier migration needs, so it is
/// testable against a fake.
protocol AidenNotificationInventory: AnyObject {
    func postedRequests() async -> [UNNotificationRequest]
    func removeNotifications(withIdentifiers identifiers: [String])
}

extension UNUserNotificationCenter: AidenNotificationInventory {
    func postedRequests() async -> [UNNotificationRequest] {
        let delivered = await deliveredNotifications().map(\.request)
        return await pendingNotificationRequests() + delivered
    }

    func removeNotifications(withIdentifiers identifiers: [String]) {
        removePendingNotificationRequests(withIdentifiers: identifiers)
        removeDeliveredNotifications(withIdentifiers: identifiers)
    }
}

/// `<prefix><instanceId>.<id>`, for notifications two machines could both post.
/// The instance's `%` and `.` are escaped so the first dot always ends it: otherwise
/// `a.b` + `c` and `a` + `b.c` would be one notification. Real instance IDs hold
/// neither, so they read exactly as written.
enum AidenMachineNotificationIdentifier {
    static func make(prefix: String, instanceId: String, id: String) -> String {
        let instance = instanceId
            .replacingOccurrences(of: "%", with: "%25")
            .replacingOccurrences(of: ".", with: "%2E")
        return "\(prefix)\(instance).\(id)"
    }
}

/// Scheduled-run and Bot routine identifiers used to name only the run, so two
/// machines with one run ID replaced each other's notification. Whatever an older
/// build left behind is cancelled on the first launch of this one. Old and new are
/// told apart by the instance every new notification carries: an identifier alone
/// can't say, because an old run ID may contain a dot.
enum AidenNotificationIdentifierMigration {
    static let completedKey = "aiden.notifications.machine-identifiers.v1"

    static func runOnce(
        center: any AidenNotificationInventory = UNUserNotificationCenter.current(),
        defaults: UserDefaults = .standard
    ) async {
        guard !defaults.bool(forKey: completedKey) else { return }
        center.removeNotifications(withIdentifiers: await oldIdentifiers(on: center))
        // A removal reports nothing back, so only a second read says it worked.
        // Anything left waits for the next launch; new notifications are never touched.
        guard await oldIdentifiers(on: center).isEmpty else { return }
        defaults.set(true, forKey: completedKey)
    }

    private static func oldIdentifiers(on center: any AidenNotificationInventory) async -> [String] {
        await center.postedRequests().filter(isFromAnOlderBuild).map(\.identifier)
    }

    private static func isFromAnOlderBuild(_ request: UNNotificationRequest) -> Bool {
        (request.identifier.hasPrefix(AidenScheduledRunNotifier.identifierPrefix)
            || request.identifier.hasPrefix(AidenBotRoutineNotifier.identifierPrefix))
            && request.content.userInfo[AidenRunAlertNotifier.instanceUserInfoKey] == nil
    }
}

/// The feed the scheduled-run notifier polls. `AidenRemoteClient` provides it;
/// tests substitute a fake.
protocol AidenScheduledRunNotificationTransport: Sendable {
    func scheduledRunNotifications(since: Date?) async throws -> AidenScheduledRunNotificationFeed
}

extension AidenRemoteClient: AidenScheduledRunNotificationTransport {}

/// Turns the `/scheduled-tasks/notifications` feed into local notifications.
/// Polling-only by design — Aiden Remote has no cloud push, so delivery
/// happens while the app is foregrounded (scheduled-list loads/refreshes).
/// The persisted cursor + delivered-id set make duplicate and replayed runs
/// idempotent, and items only post when the owning task opted into `notify`.
final class AidenScheduledRunNotifier {
    static let shared = AidenScheduledRunNotifier()
    /// Must stay installed for the app lifetime; assigning the delegate is
    /// enough — UNUserNotificationCenter retains it weakly, hence the static.
    static let presentationDelegate = AidenNotificationPresentationDelegate()

    nonisolated static let identifierPrefix = "aiden.schedule."
    private static let maximumDeliveredIds = 500
    private let defaults: UserDefaults
    private let center: AidenRunAlertCenter

    init(
        defaults: UserDefaults = .standard,
        center: AidenRunAlertCenter = UNUserNotificationCenter.current()
    ) {
        self.defaults = defaults
        self.center = center
    }

    /// Install once at app launch so foregrounded polls still alert.
    static func installPresentationDelegate() {
        UNUserNotificationCenter.current().delegate = presentationDelegate
    }

    private func cursorKey(_ instanceId: String) -> String {
        "aiden.scheduledNotifications.cursor.\(instanceId)"
    }
    private func deliveredKey(_ instanceId: String) -> String {
        "aiden.scheduledNotifications.delivered.\(instanceId)"
    }

    /// Lock-screen display text: bounded and free of control/bidi characters.
    static func displaySafe(_ value: String, limit: Int) -> String {
        String(String(value.prefix(limit)).unicodeScalars.filter {
            !CharacterSet.controlCharacters.contains($0) && !$0.properties.isBidiControl
        })
    }

    func deliver(instanceId: String, client: any AidenScheduledRunNotificationTransport) async {
        guard await center.requestAlertAuthorization() else { return }
        let cursor = defaults.object(forKey: cursorKey(instanceId)) as? Double
        do {
            let feed = try await client.scheduledRunNotifications(
                since: cursor.map { Date(timeIntervalSince1970: $0 / 1_000) }
            )
            // Insertion-ordered so trimming to the cap evicts the OLDEST ids;
            // the Set is only the membership index.
            var deliveredOrder = defaults.stringArray(forKey: deliveredKey(instanceId)) ?? []
            var delivered = Set(deliveredOrder)
            func markDelivered(_ id: String) {
                if delivered.insert(id).inserted { deliveredOrder.append(id) }
            }
            guard let cursor else {
                // First poll: baseline to the SERVER clock so phone-clock skew
                // can neither replay history nor permanently skip runs. All
                // returned ids are marked delivered so nothing storms.
                feed.notifications.sorted(by: { $0.finishedAt < $1.finishedAt }).forEach { markDelivered($0.id) }
                defaults.set(feed.serverNow.timeIntervalSince1970 * 1_000, forKey: cursorKey(instanceId))
                defaults.set(Array(deliveredOrder.suffix(Self.maximumDeliveredIds)), forKey: deliveredKey(instanceId))
                return
            }
            // Cursor advances only past CONTIGUOUSLY handled items (oldest
            // first): a failed post must keep its finishedAt inside the next
            // poll's window or the run is lost even though it was never posted.
            var nextCursor = cursor
            for item in feed.notifications.sorted(by: { $0.finishedAt < $1.finishedAt }) {
                if !item.notify || delivered.contains(item.id) {
                    // History-only or already posted — safe to advance past.
                    nextCursor = item.finishedAt.timeIntervalSince1970 * 1_000
                    continue
                }
                let content = UNMutableNotificationContent()
                content.title = Self.displaySafe(item.taskName, limit: 120)
                if item.status == "failed" {
                    content.body = "Scheduled run failed (\(item.errorCode ?? "error"))."
                } else if let summary = item.summary, !summary.isEmpty {
                    content.body = Self.displaySafe(summary, limit: 200)
                } else {
                    content.body = "Scheduled run completed."
                }
                content.userInfo = [AidenRunAlertNotifier.instanceUserInfoKey: instanceId]
                let request = UNNotificationRequest(
                    identifier: AidenMachineNotificationIdentifier.make(
                        prefix: Self.identifierPrefix, instanceId: instanceId, id: item.id
                    ),
                    content: content,
                    trigger: nil
                )
                do {
                    try await center.add(request)
                    markDelivered(item.id)
                    nextCursor = item.finishedAt.timeIntervalSince1970 * 1_000
                } catch {
                    if error is CancellationError { return }
                    break // retry this item on the next poll
                }
            }
            defaults.set(nextCursor, forKey: cursorKey(instanceId))
            defaults.set(Array(deliveredOrder.suffix(Self.maximumDeliveredIds)), forKey: deliveredKey(instanceId))
        } catch {
            // Fetch/validation failure or cancellation: keep cursor state so a
            // later poll retries instead of silently skipping runs.
            return
        }
    }
}

// MARK: - Bot routine results (`bot-proactive-v1`)

/// The feed the Bot routine notifier polls. `AidenRemoteClient` provides it;
/// tests substitute a fake.
protocol AidenBotRoutineNotificationTransport: Sendable {
    func botRoutineNotifications(since: String?) async throws -> AidenBotRoutineNotificationFeed
}

extension AidenRemoteClient: AidenBotRoutineNotificationTransport {}

/// The recent routine feed per machine, shared by the notifier and Home's
/// "From your Bots" card so a refresh asks each machine once. Recording never
/// touches the notifier's cursor or delivered ids: Home reading a run never
/// stops its banner.
@MainActor
@Observable
final class AidenBotRoutineFeedReader {
    static let shared = AidenBotRoutineFeedReader()

    /// The newest items kept per machine.
    static let windowSize = 20
    /// A window younger than this answers Home without asking the machine.
    static let freshness: Duration = .seconds(60)

    struct Window: Equatable, Sendable {
        var notifications: [AidenBotRoutineNotification]
        var recordedAt: ContinuousClock.Instant
        /// The grants the items were read under. A pairing that later sees
        /// less starts the window over rather than keep what it can't see.
        var grants: Set<AidenRemoteCapability>
        /// The machine's own clock at the reader's last full read, so the next
        /// read asks only for what's newer. Nil until the reader has read the
        /// whole window itself (the notifier's pages start from its own cursor).
        var cursor: String?
    }

    enum Outcome: Equatable, Sendable {
        /// The window answers: read just now, fresh, or read by a fetch
        /// already on its way.
        case read
        /// Not asked: the pairing can't read Bots and chats, or the machine
        /// stopped being current.
        case skipped
        /// The machine didn't answer.
        case failed
    }

    private(set) var windows: [String: Window] = [:]
    @ObservationIgnored private var generations: [String: Int] = [:]
    /// Machines with a feed read on its way, and who waits for it.
    @ObservationIgnored private var inFlight: [String: [UUID: CheckedContinuation<Void, Never>]] = [:]
    @ObservationIgnored private let clock = ContinuousClock()

    init() {}

    /// What the machine's window holds that `grants` still allow, newest first.
    /// Nothing at all once the pairing can't read Bots and chats.
    func notifications(for instanceId: String, grants: Set<AidenRemoteCapability>) -> [AidenBotRoutineNotification] {
        guard Self.readGrants.isSubset(of: grants) else { return [] }
        return notifications(for: instanceId).filter { Self.isVisible($0, grants: grants) }
    }

    func notifications(for instanceId: String) -> [AidenBotRoutineNotification] {
        windows[instanceId]?.notifications ?? []
    }

    /// Merges a fetched page into the machine's window, newest first. `grants`
    /// are the ones the page was read under; `cursor` is set only by a read
    /// that covers the whole window.
    func record(
        _ notifications: [AidenBotRoutineNotification],
        instanceId: String,
        grants: Set<AidenRemoteCapability>,
        cursor: String? = nil
    ) {
        var kept = windows[instanceId]
        if let window = kept, !window.grants.isSubset(of: grants) { kept = nil }
        var byId: [String: AidenBotRoutineNotification] = [:]
        for item in (kept?.notifications ?? []) + notifications { byId[item.id] = item }
        let merged = byId.values.sorted {
            $0.finishedAt.date != $1.finishedAt.date ? $0.finishedAt.date > $1.finishedAt.date : $0.id < $1.id
        }
        windows[instanceId] = Window(
            notifications: Array(merged.prefix(Self.windowSize)),
            recordedAt: clock.now,
            grants: kept.map { $0.grants.intersection(grants) } ?? grants,
            cursor: cursor ?? kept?.cursor
        )
    }

    /// Forgets a machine that was unpaired, revoked or switched away from, and
    /// fences any fetch still in flight for it.
    func forget(instanceId: String) {
        windows[instanceId] = nil
        generations[instanceId, default: 0] &+= 1
    }

    /// True once the reader itself has read the machine's whole window. The
    /// notifier's pages start from its own cursor, so they add rows but never
    /// count as Home's read.
    func hasFullRead(_ instanceId: String) -> Bool { windows[instanceId]?.cursor != nil }

    func isFresh(_ instanceId: String) -> Bool {
        guard let window = windows[instanceId], window.cursor != nil else { return false }
        return window.recordedAt.duration(to: clock.now) < Self.freshness
    }

    /// True while a feed read for the machine is on its way.
    func isFetching(_ instanceId: String) -> Bool { inFlight[instanceId] != nil }

    /// Marks a feed read for the machine as on its way, so a second reader
    /// waits for it instead of asking again. False if one already is; the
    /// caller then must not `endFetch`.
    func beginFetch(_ instanceId: String) -> Bool {
        guard inFlight[instanceId] == nil else { return false }
        inFlight[instanceId] = [:]
        return true
    }

    func endFetch(_ instanceId: String) {
        inFlight.removeValue(forKey: instanceId)?.values.forEach { $0.resume() }
    }

    /// Waits for the read on its way, or until the waiting task is cancelled.
    func waitForFetch(_ instanceId: String) async {
        guard inFlight[instanceId] != nil else { return }
        let waiter = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled || inFlight[instanceId] == nil {
                    continuation.resume()
                } else {
                    inFlight[instanceId]?[waiter] = continuation
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.stopWaiting(waiter, for: instanceId) }
        }
    }

    private func stopWaiting(_ waiter: UUID, for instanceId: String) {
        inFlight[instanceId]?.removeValue(forKey: waiter)?.resume()
    }

    /// Reads the machine's recent feed unless a fresh window already holds it,
    /// or waits for a read already on its way (the notifier's, or another
    /// screen's). `force` reads even a fresh window, for pull to refresh.
    /// Items the pairing's grants don't cover are left out, and a pairing that
    /// can no longer read Bots forgets the window. A response that lands after
    /// the machine stopped being current (`isCurrent`), or after `forget`, is
    /// dropped, so a switch mid-fetch never writes the old machine's rows.
    @discardableResult
    func refreshIfStale(
        instanceId: String,
        transport: any AidenBotRoutineNotificationTransport,
        grants: Set<AidenRemoteCapability>,
        force: Bool = false,
        isCurrent: @escaping @MainActor () -> Bool
    ) async -> Outcome {
        guard Self.readGrants.isSubset(of: grants) else {
            if windows[instanceId] != nil { forget(instanceId: instanceId) }
            return .skipped
        }
        if let window = windows[instanceId], !window.grants.isSubset(of: grants) { forget(instanceId: instanceId) }
        // Wait for any read on its way (the notifier's, or another screen's).
        // Only a full read answers; the notifier's page from its own cursor
        // doesn't, so Home then reads the whole window itself.
        var waited = false
        while isFetching(instanceId) {
            await waitForFetch(instanceId)
            guard !Task.isCancelled else { return .skipped }
            waited = true
        }
        if waited, hasFullRead(instanceId) { return .read }
        guard force || !isFresh(instanceId) else { return .read }
        guard isCurrent(), beginFetch(instanceId) else { return .skipped }
        defer { endFetch(instanceId) }
        let generation = generations[instanceId, default: 0]
        let cursor = windows[instanceId]?.cursor
        guard let feed = try? await transport.botRoutineNotifications(since: cursor) else { return .failed }
        guard generations[instanceId, default: 0] == generation, isCurrent() else { return .skipped }
        record(
            feed.notifications.filter { Self.isVisible($0, grants: grants) },
            instanceId: instanceId,
            grants: grants,
            cursor: feed.now.rawValue
        )
        return .read
    }

    static let readGrants: Set<AidenRemoteCapability> = [.botRead, .chatRead]

    static func isVisible(_ item: AidenBotRoutineNotification, grants: Set<AidenRemoteCapability>) -> Bool {
        switch item.kind {
        case .routine: true
        case .peer: grants.contains(.botPeers)
        case .message: grants.contains(.botMessaging)
        case .issue: grants.contains(.botIssues)
        }
    }
}

/// The Bot variant of the scheduled-run feed: `GET /bots/routine-notifications`
/// turned into local notifications that open the Bot's chat. Polling-only,
/// like schedules: it runs on app foreground and on Bots home refresh. The
/// cursor (the Mac's own `now`) and the delivered ids are kept per paired Mac,
/// so a replayed run is never posted twice.
@MainActor
final class AidenBotRoutineNotifier {
    /// The unit-test host never asks for notification permission.
    static let shared = AidenBotRoutineNotifier(
        isEnabled: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil
    )

    nonisolated static let identifierPrefix = "aiden.bot-routine."
    private static let maximumDeliveredIds = 500

    private let defaults: UserDefaults
    private let center: AidenRunAlertCenter
    private let isEnabled: Bool
    private let feedReader: AidenBotRoutineFeedReader
    private var polling: Set<String> = []

    init(
        isEnabled: Bool = true,
        defaults: UserDefaults = .standard,
        center: AidenRunAlertCenter = UNUserNotificationCenter.current(),
        feedReader: AidenBotRoutineFeedReader? = nil
    ) {
        self.defaults = defaults
        self.center = center
        self.isEnabled = isEnabled
        self.feedReader = feedReader ?? .shared
    }

    static func cursorKey(_ instanceId: String) -> String {
        "aiden.botRoutineNotifications.cursor.\(instanceId)"
    }

    static func deliveredKey(_ instanceId: String) -> String {
        "aiden.botRoutineNotifications.delivered.\(instanceId)"
    }

    /// Polls every connected machine that serves `bot-proactive-v1`, not just
    /// the default: each notification carries its own machine, so its tap opens
    /// the Bot chat there.
    func deliverIfSupported(coordinator: AidenRemoteCoordinator) async {
        guard isEnabled else { return }
        for connection in coordinator.hosts.ordered
        where !connection.isRevoked && connection.connectionState == .connected {
            let instanceId = connection.instanceId
            guard AidenBotHostFeature.isAdvertised(
                      AidenBotHostFeature.proactive,
                      by: coordinator.knownServerFeatures(of: instanceId)
                  ),
                  let context = try? coordinator.ownerContext(for: instanceId),
                  let client = try? coordinator.remoteClient(for: context) else { continue }
            // Each machine's own grants and /server fence its own feed.
            await deliverFromHost(instanceId: instanceId, transport: client,
                isCurrent: { coordinator.isLive(context) && coordinator.botConnectionState(on: instanceId) == .connected },
                installation: { coordinator.botInstallation(on: instanceId) },
                server: { coordinator.botServer(on: instanceId) })
        }
    }

    func deliverFromHost(instanceId: String, transport: any AidenBotRoutineNotificationTransport,
                         isCurrent: @escaping @MainActor () -> Bool = { true },
                         installation: @escaping @MainActor () -> AidenInstallation?, server: @escaping @MainActor () -> AidenServer?) async {
        await deliver(instanceId: instanceId, transport: transport, isCurrent: isCurrent,
            currentGrants: { Self.audienceGrants(installation: installation(), server: server()) })
    }

    func deliver(instanceId: String, transport: any AidenBotRoutineNotificationTransport, isCurrent: @escaping @MainActor () -> Bool = { true }, currentGrants: @escaping @MainActor () -> Set<AidenRemoteCapability> = { [.botRead, .chatRead] }) async {
        guard !polling.contains(instanceId) else { return }
        polling.insert(instanceId)
        defer { polling.remove(instanceId) }
        // Permission is asked for only once there is a run to show, never
        // just because the Bots list refreshed.
        let status = await center.currentAuthorizationStatus()
        guard status == .notDetermined || AidenRunAlertPolicy.isAuthorized(status) else { return }
        let cursor = defaults.string(forKey: Self.cursorKey(instanceId))
        // Keep the original projection authority: an issue row intentionally
        // does not reveal whether it required access-request visibility.
        let fetchedGrants = currentGrants()
        guard isCurrent(), Set([AidenRemoteCapability.botRead, .chatRead]).isSubset(of: fetchedGrants) else { return }
        // Home waits for this read rather than ask the same machine again.
        var claimed = feedReader.beginFetch(instanceId)
        func finishFetch() {
            if claimed { claimed = false; feedReader.endFetch(instanceId) }
        }
        defer { finishFetch() }
        let feed: AidenBotRoutineNotificationFeed
        do {
            feed = try await transport.botRoutineNotifications(since: cursor)
        } catch {
            // Keep the cursor so the next poll asks again.
            return
        }
        func scopeAllowsProgress() -> Bool {
            isCurrent() && fetchedGrants.isSubset(of: currentGrants()) && feed.notifications.allSatisfy { item in
                switch item.kind {
                case .routine: return true
                case .peer: return fetchedGrants.contains(.botPeers)
                case .message: return fetchedGrants.contains(.botMessaging)
                case .issue: return fetchedGrants.contains(.botIssues)
                }
            }
        }
        guard scopeAllowsProgress() else { return }
        feedReader.record(feed.notifications, instanceId: instanceId, grants: fetchedGrants)
        finishFetch()
        var deliveredOrder = defaults.stringArray(forKey: Self.deliveredKey(instanceId)) ?? []
        var delivered = Set(deliveredOrder)
        func markDelivered(_ id: String) {
            if delivered.insert(id).inserted { deliveredOrder.append(id) }
        }
        func persist(cursor: String) {
            guard scopeAllowsProgress() else { return }
            defaults.set(cursor, forKey: Self.cursorKey(instanceId))
            defaults.set(Array(deliveredOrder.suffix(Self.maximumDeliveredIds)), forKey: Self.deliveredKey(instanceId))
        }
        let oldestFirst = feed.notifications.sorted { $0.finishedAt.date < $1.finishedAt.date }
        guard let cursor else {
            // First poll on this Mac: start from its clock without posting
            // history, so pairing never floods the lock screen.
            oldestFirst.forEach { markDelivered($0.id) }
            persist(cursor: feed.now.rawValue)
            return
        }
        // The cursor only moves past runs that were handled in order, so a
        // run whose post failed is asked for again next time.
        if status == .notDetermined,
           oldestFirst.contains(where: { !delivered.contains($0.id) }),
           !(await center.requestAlertAuthorization()) {
            return
        }
        var nextCursor = cursor
        var handledAll = true
        for item in oldestFirst {
            guard scopeAllowsProgress() else { return }
            if delivered.contains(item.id) {
                nextCursor = item.finishedAt.rawValue
                continue
            }
            do {
                try await center.add(Self.request(for: item, instanceId: instanceId))
                // The system may already have accepted the banner. Its completion
                // cannot consume or recreate progress for revoked access or pairing.
                guard scopeAllowsProgress() else { return }
                markDelivered(item.id)
                nextCursor = item.finishedAt.rawValue
            } catch {
                handledAll = false
                break
            }
        }
        persist(cursor: handledAll ? feed.now.rawValue : nextCursor)
    }

    /// Both the pairing's accepted grants and the current host projection
    /// must agree. A host merely offering a capability grants no visibility.
    static func audienceGrants(installation: AidenInstallation?, server: AidenServer?) -> Set<AidenRemoteCapability> {
        Set([AidenRemoteCapability.botRead, .chatRead, .botPeers, .botMessaging, .botIssues, .botAccessRequests].filter {
            guard let installation, let server, installation.deviceCapabilities.contains($0), server.capabilities.contains($0) else { return false }
            if $0 == .botRead || $0 == .chatRead {
                return (installation.serverCapabilities ?? installation.deviceCapabilities).contains($0)
                    && (server.serverCapabilities ?? server.capabilities).contains($0)
            }
            return installation.hasNegotiatedAccess(to: $0) && server.serverCapabilities?.contains($0) == true
        })
    }

    /// Title: the Bot's name. Body: the routine name and the preview. Opens
    /// the Bot's chat on the Mac it came from.
    nonisolated static func request(
        for item: AidenBotRoutineNotification,
        instanceId: String
    ) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = AidenScheduledRunNotifier.displaySafe(item.botName, limit: 120)
        let routineName = AidenScheduledRunNotifier.displaySafe(item.routineName, limit: 120)
        let preview = AidenScheduledRunNotifier.displaySafe(item.preview, limit: 200)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        content.body = preview.isEmpty ? routineName : "\(routineName): \(preview)"
        content.threadIdentifier = item.kind == .peer
            ? "aiden.bot-peer.\(instanceId).\(item.botId)"
            : item.kind == .issue
            ? "aiden.bot-issue.\(instanceId).\(item.botId)"
            : "aiden.bot-routine.\(instanceId).\(item.botId)"
        content.sound = .default
        content.userInfo[AidenRunAlertNotifier.instanceUserInfoKey] = instanceId
        if let url = AidenDeepLink.botChatURL(instanceId: instanceId, botId: item.botId) {
            content.userInfo[AidenRunAlertNotifier.deepLinkUserInfoKey] = url.absoluteString
        }
        return UNNotificationRequest(
            identifier: AidenMachineNotificationIdentifier.make(
                prefix: identifierPrefix, instanceId: instanceId, id: item.id
            ),
            content: content,
            trigger: nil
        )
    }
}

// MARK: - Run alerts

/// What a chat run needs the user to know while they are away from it.
enum AidenRunAlertKind: String, Equatable, Sendable {
    case needsApproval
    case needsAnswer
    case completed
    case failed

    var isBlocking: Bool { self == .needsApproval || self == .needsAnswer }

    /// Lock-screen body. Fixed copy only: prompt text, tool arguments, and
    /// replies never leave the app through a notification.
    var body: String {
        switch self {
        case .needsApproval: String(localized: "Needs your approval")
        case .needsAnswer: String(localized: "Needs your answer")
        case .completed: String(localized: "Response complete")
        case .failed: String(localized: "Response failed")
        }
    }
}

/// The app's run state as the alert policy sees it. `.inactive` covers the
/// transient overlays (Notification Center, Control Center, app switcher).
enum AidenRunAlertAppState: Equatable, Sendable {
    case active
    case inactive
    case background
}

enum AidenRunAlertPolicy {
    /// One alert per prompt (blocking) or per stream (completion), only while
    /// the user is away. An active app already shows the prompt or result in
    /// app. Quiet Open Chat: a transient overlay over the chat that is on
    /// screen returns straight to that chat, so it stays silent too.
    static func shouldPost(
        appState: AidenRunAlertAppState,
        isChatOnScreen: Bool,
        alreadyAlerted: Bool,
        isAuthorized: Bool
    ) -> Bool {
        guard isAuthorized, !alreadyAlerted else { return false }
        switch appState {
        case .active:
            return false
        case .inactive:
            return !isChatOnScreen
        case .background:
            return true
        }
    }

    /// Ask for permission once, after the first completed run, while the user
    /// is in the app to see the system prompt: never at launch, and never for
    /// a blocking prompt or a failure.
    static func shouldRequestAuthorization(
        kind: AidenRunAlertKind,
        appState: AidenRunAlertAppState,
        hasRequestedBefore: Bool,
        authorizationStatus: UNAuthorizationStatus
    ) -> Bool {
        kind == .completed
            && appState == .active
            && !hasRequestedBefore
            && authorizationStatus == .notDetermined
    }

    static func isAuthorized(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral: true
        case .denied, .notDetermined: false
        @unknown default: false
        }
    }

    /// Prompt ids identify a prompt; stream ids identify a run. Keys are
    /// instance-scoped so two paired Macs never suppress each other.
    static func dedupeKey(kind: AidenRunAlertKind, instanceID: String, id: String) -> String {
        "\(instanceID)|\(kind.isBlocking ? "prompt" : "run")|\(id)"
    }
}

/// The notification-center surface the run notifier needs, so delivery is
/// testable without system permission prompts.
protocol AidenRunAlertCenter: AnyObject {
    func currentAuthorizationStatus() async -> UNAuthorizationStatus
    func requestAlertAuthorization() async -> Bool
    func add(_ request: UNNotificationRequest) async throws
}

extension UNUserNotificationCenter: AidenRunAlertCenter {
    func currentAuthorizationStatus() async -> UNAuthorizationStatus {
        await notificationSettings().authorizationStatus
    }

    func requestAlertAuthorization() async -> Bool {
        (try? await requestAuthorization(options: [.alert, .sound])) == true
    }
}

/// Local alerts for chat runs: one Time Sensitive alert when a run first
/// blocks on an approval or a question, and one alert when it completes or
/// fails. Each deep-links to the instance-scoped chat. Local-only: Aiden
/// Remote has no cloud push, so these fire while the app still holds the
/// stream (for example shortly after backgrounding).
@MainActor
final class AidenRunAlertNotifier {
    /// The unit-test host never asks for notification permission: chat model
    /// tests complete runs while the host app is active.
    static let shared = AidenRunAlertNotifier(
        isEnabled: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil
    )

    nonisolated static let identifierPrefix = "aiden.run."
    nonisolated static let deepLinkUserInfoKey = "aidenURL"
    /// On every scheduled-run and Bot routine notification. See
    /// `AidenNotificationIdentifierMigration`.
    nonisolated static let instanceUserInfoKey = "aidenInstance"
    static let permissionRequestedKey = "aiden.runAlerts.permissionRequested"
    static let alertedKeysKey = "aiden.runAlerts.alerted"
    private static let maximumAlertedKeys = 500

    private let defaults: UserDefaults
    private let center: AidenRunAlertCenter
    private let appState: @MainActor () -> AidenRunAlertAppState
    private let isEnabled: Bool

    init(
        isEnabled: Bool = true,
        defaults: UserDefaults = .standard,
        center: AidenRunAlertCenter = UNUserNotificationCenter.current(),
        appState: @escaping @MainActor () -> AidenRunAlertAppState = { AidenRunAlertNotifier.currentAppState() }
    ) {
        self.defaults = defaults
        self.center = center
        self.appState = appState
        self.isEnabled = isEnabled
    }

    static func currentAppState() -> AidenRunAlertAppState {
        switch UIApplication.shared.applicationState {
        case .active: .active
        case .inactive: .inactive
        case .background: .background
        @unknown default: .background
        }
    }

    /// `id` is the prompt id for blocking kinds and the stream id otherwise.
    func notify(
        _ kind: AidenRunAlertKind,
        id: String,
        instanceID: String,
        chatID: String,
        chatTitle: String,
        isChatOnScreen: Bool
    ) async {
        guard isEnabled else { return }
        var status = await center.currentAuthorizationStatus()
        // App state is sampled after each notification-center await: the user
        // may have left or returned to the app while the lookup was suspended.
        if AidenRunAlertPolicy.shouldRequestAuthorization(
            kind: kind,
            appState: appState(),
            hasRequestedBefore: defaults.bool(forKey: Self.permissionRequestedKey),
            authorizationStatus: status
        ) {
            defaults.set(true, forKey: Self.permissionRequestedKey)
            status = await center.requestAlertAuthorization() ? .authorized : .denied
        }
        let key = AidenRunAlertPolicy.dedupeKey(kind: kind, instanceID: instanceID, id: id)
        var alerted = defaults.stringArray(forKey: Self.alertedKeysKey) ?? []
        guard AidenRunAlertPolicy.shouldPost(
            appState: appState(),
            isChatOnScreen: isChatOnScreen,
            alreadyAlerted: alerted.contains(key),
            isAuthorized: AidenRunAlertPolicy.isAuthorized(status)
        ), let url = AidenDeepLink.chatURL(instanceId: instanceID, chatId: chatID) else { return }

        let content = UNMutableNotificationContent()
        content.title = AidenScheduledRunNotifier.displaySafe(
            AgentRunActivitySanitizer.sessionTitle(chatTitle),
            limit: 120
        )
        content.body = kind.body
        content.threadIdentifier = "aiden.run.\(instanceID).\(chatID)"
        content.userInfo = [Self.deepLinkUserInfoKey: url.absoluteString]
        content.interruptionLevel = kind.isBlocking ? .timeSensitive : .active
        if kind.isBlocking { content.sound = .default }
        let request = UNNotificationRequest(
            identifier: "\(Self.identifierPrefix)\(kind.rawValue).\(instanceID).\(id)",
            content: content,
            trigger: nil
        )
        // Recorded before posting: a dropped alert beats a repeated one.
        alerted.append(key)
        defaults.set(Array(alerted.suffix(Self.maximumAlertedKeys)), forKey: Self.alertedKeysKey)
        try? await center.add(request)
    }

    /// Contract revision 37 (`bot:handoffs`, G24): one Time Sensitive alert
    /// when a Bot hands the person a step while they are away from its chat.
    /// Fixed copy, like the other run alerts: the step's own words stay in
    /// the app. It opens the Bot's chat on the Mac it came from. Local-only,
    /// so it fires only while the app still holds the Bot's session stream.
    func notifyBotHandoff(
        waitID: String,
        kind: AidenBotHandoffKind,
        instanceID: String,
        botID: String,
        botName: String,
        isChatOnScreen: Bool
    ) async {
        guard isEnabled else { return }
        let status = await center.currentAuthorizationStatus()
        let key = "\(instanceID)|handoff|\(botID)|\(waitID)"
        var alerted = defaults.stringArray(forKey: Self.alertedKeysKey) ?? []
        guard AidenRunAlertPolicy.shouldPost(
            appState: appState(),
            isChatOnScreen: isChatOnScreen,
            alreadyAlerted: alerted.contains(key),
            isAuthorized: AidenRunAlertPolicy.isAuthorized(status)
        ), let url = AidenDeepLink.botChatURL(instanceId: instanceID, botId: botID) else { return }

        let content = UNMutableNotificationContent()
        content.title = AidenScheduledRunNotifier.displaySafe(botName, limit: 120)
        content.body = kind == .signIn
            ? String(localized: "Needs you to sign in")
            : String(localized: "Handed you a step")
        content.threadIdentifier = "aiden.run.bot.\(instanceID).\(botID)"
        content.userInfo = [Self.deepLinkUserInfoKey: url.absoluteString]
        content.interruptionLevel = .timeSensitive
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: "\(Self.identifierPrefix)handoff.\(instanceID).\(botID).\(waitID)",
            content: content,
            trigger: nil
        )
        // Recorded before posting: a dropped alert beats a repeated one.
        alerted.append(key)
        defaults.set(Array(alerted.suffix(Self.maximumAlertedKeys)), forKey: Self.alertedKeysKey)
        try? await center.add(request)
    }

    /// The chat link carried by a tapped run alert, if it is a valid Aiden link.
    nonisolated static func deepLink(from userInfo: [AnyHashable: Any]) -> URL? {
        guard let value = userInfo[deepLinkUserInfoKey] as? String,
              let url = URL(string: value),
              AidenDeepLink.request(from: url) != nil else { return nil }
        return url
    }
}
