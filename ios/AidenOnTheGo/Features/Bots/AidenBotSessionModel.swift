import CryptoKit
import Foundation
import Observation

/// Host feature tokens added in contract revision 25.
enum AidenBotHostFeature {
    static let durableSession = "bot-durable-session-v1"
    static let routines = "bot-routines-v1"
    static let connectionRequests = "bot-connection-requests-v1"
    static let presets = "bot-presets-v1"
    /// Contract revision 27: Profile → Memory.
    static let memory = "bot-memory-v1"
    /// Contract revision 27: routine proposal answers, the daily check-in
    /// suggestion and the Bot routine notification feed.
    static let proactive = "bot-proactive-v1"
    /// Contract revision 30: the status line, Steer and Queue, Queued bubbles and Chat activity.
    static let activity = "bot-activity-v1"

    static func isAdvertised(_ token: String, by features: [String]?) -> Bool {
        features?.contains(token) == true
    }

    @MainActor
    static func isAdvertised(_ token: String, coordinator: AidenRemoteCoordinator) -> Bool {
        isAdvertised(token, by: coordinator.server?.features)
    }
}

/// How a Bot chat is opened. A host advertising `bot-durable-session-v1`
/// serves one durable session per Bot; older hosts keep the chatId path,
/// including stream Stop (`POST /streams/{id}/cancel`).
enum AidenBotChatRoute: Equatable {
    case durableSession(botID: String)
    case legacyChat

    static func resolve(botID: String, hostFeatures: [String]?) -> Self {
        AidenBotHostFeature.isAdvertised(AidenBotHostFeature.durableSession, by: hostFeatures)
            ? .durableSession(botID: botID) : .legacyChat
    }

    /// Navigation value for a durable session (restorable across launches).
    static let pathPrefix = "aiden-bot-session:"

    static func pathValue(botID: String) -> String { pathPrefix + botID }

    static func botID(fromPath value: String) -> String? {
        guard value.hasPrefix(pathPrefix) else { return nil }
        let id = String(value.dropFirst(pathPrefix.count))
        return id.isEmpty ? nil : id
    }
}

/// The network surface the durable Bot chat needs. `AidenRemoteClient`
/// provides it; tests substitute a fake.
protocol AidenBotSessionTransport: Sendable {
    func botSession(botId: String) async throws -> AidenBotSession
    func botSessionEvents(botId: String) -> AsyncThrowingStream<AidenBotSessionEvent, Error>
    func sendBotMessage(
        botId: String,
        request: AidenBotMessageRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotMessageReceipt
    func resumeBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView
    func dismissBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView
    func stopBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView
    func answerBotQuestion(
        botId: String,
        waitId: String,
        request: AidenQuestionRespondRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotQuestionAnswerReceipt
    /// The generic `POST /approvals/{id}/respond`; a Bot approval is answered
    /// by its `waitId` with no scope.
    func respondToApproval(
        id: String,
        decision: AidenApprovalDecision,
        scope: AidenApprovalScope?,
        idempotencyKey: UUID
    ) async throws -> AidenApprovalResponse
    func requestBotConnection(
        botId: String,
        request: AidenBotConnectionRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotConnectionRequestReceipt
    func respondToBotRoutineProposal(
        botId: String,
        proposalId: String,
        request: AidenBotRoutineProposalRespondRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotRoutineProposalRespondResult
}

extension AidenRemoteClient: AidenBotSessionTransport {}

/// The exact copy shared with desktop and Android.
enum AidenBotSessionCopy {
    static let interrupted = "I got interrupted while working on this."
    static let resume = "Resume"
    static let dismiss = "Dismiss"
    static let accessChanged = "This Bot's access changed. Review it in Advanced."
    static let openAdvanced = "Advanced"
    static let pausedSubtitle = "Paused — tap to resume"
    static let needsModel = "Needs an AI model"
    static let needsModelHint = "Set up on your Mac"
    static let setUp = "Set up"
    static let queued = "Queued"

    static func needsModelDetail(botName: String) -> String {
        "Set up an AI model so \(botName) can reply."
    }
    static let sessionReset = "This chat was restarted."
    static let finishOnMac = "Finish on your Mac"
    static let finishOnMacReadOnly = "Finish this on your Mac."
    static let checkYourMac = "Check your Mac to finish."
    static let connected = "Connected ✓"
    static let failedTurn = "I couldn't finish that reply."
    static let retry = "Retry"

    static func connectTitle(_ name: String) -> String { "Connect \(name)" }

    static let memoryUpdated = "Memory updated"
    static let proposalTitle = "Add a routine?"
    static let addRoutine = "Add routine"
    static let notNow = "Not now"
    static let notAdded = "Not added"
    static let proposalFailed = "That didn’t reach your Mac. Please try again."

    static func proposalBody(name: String, label: String) -> String { "\(name) · \(label)" }
    static func proposalAdded(label: String) -> String { "Added ✓ · \(label)" }
}

/// The status line's words and marks (spec §5). Kept in step with
/// `renderer/shared/bot-activity.ts` by the shared fixture's `botActivity.phases`.
enum AidenBotActivityPhase {
    struct Display: Equatable {
        let phase: String
        let word: String
        let mark: AidenActivityMarkKind
    }

    static let table: [String: (word: String, mark: AidenActivityMarkKind)] = [
        "preparing": ("Getting ready", .bounce),
        "thinking": ("Thinking", .triStep),
        "reading": ("Reading", .scanGrid),
        "photo": ("Looking at your photo", .scanGrid),
        "searching": ("Searching the web", .scanGrid),
        "command": ("Running a command", .quadShuffle),
        "editing": ("Editing files", .quadShuffle),
        "app": ("Using an app", .quadShuffle),
        "helper": ("Asking a helper", .quadShuffle),
        "computer": ("Using your Mac", .quadShuffle),
        "remembering": ("Remembering", .compose),
        "routine": ("Setting up a routine", .triStep),
        "working": ("Working", .quadShuffle),
        "writing": ("Writing", .compose),
        "waiting": ("Waiting for you", .glance),
        "tidying": ("Tidying up its notes", .bounce),
        "stopping": ("Stopping", .bounce),
        "resuming": ("Picking up where it left off", .bounce),
        "reconnecting": ("Reconnecting to your Mac", .bounce),
    ]

    /// These change what the person should do, so Always "Thinking" keeps them.
    static let keepsItsWord: Set<String> = ["waiting", "stopping", "reconnecting"]

    /// What the line shows for any phase id: an id this build doesn't know reads as Working.
    static func display(phase: String, wording: AidenBotChatActivityWording, app: String?) -> Display {
        let known = table[phase] == nil ? "working" : phase
        let shown = wording == .thinking && !keepsItsWord.contains(known) ? "thinking" : known
        // `known` and `shown` are both table ids, so the lookup always succeeds.
        let entry = table[shown]!
        if shown == "app", let app, !app.isEmpty {
            return Display(phase: shown, word: "Using \(app)", mark: entry.mark)
        }
        return Display(phase: shown, word: entry.word, mark: entry.mark)
    }
}

/// Elapsed time on the status line (§5.2): from the Mac's `startedAt`, after 20 seconds.
enum AidenBotElapsed {
    static let showAfterMs = 20_000

    /// Nil before 20 seconds, and while this phone's clock reads behind the Mac's.
    static func label(startedAt: Int, nowMs: Int) -> String? {
        let elapsed = nowMs - startedAt
        guard elapsed >= showAfterMs else { return nil }
        return duration(ms: elapsed)
    }

    /// "18s", "1m 12s", "2m", "1h 2m", the Mac's wording.
    static func duration(ms: Int) -> String {
        let seconds = max(1, ms / 1_000)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        let rest = seconds % 60
        if minutes < 60 { return rest > 0 ? "\(minutes)m \(rest)s" : "\(minutes)m" }
        let hours = minutes / 60
        let remainder = minutes % 60
        return remainder > 0 ? "\(hours)h \(remainder)m" : "\(hours)h"
    }
}

/// What the Bot chat's status line shows (spec §12).
struct AidenBotStatusLine: Equatable {
    let display: AidenBotActivityPhase.Display
    /// "1m 12s" after 20 seconds, else nil.
    let elapsed: String?

    var accessibilityLabel: String {
        elapsed.map { "\(display.word), \($0)" } ?? display.word
    }
}

/// Screen readers hear a status change at most once every 2 seconds (§14).
struct AidenBotStatusAnnouncer {
    static let gap: TimeInterval = 2
    private var current: (text: String, at: TimeInterval)?

    /// The text to announce now, or nil. `retryAfter` says when to offer the newest text again.
    mutating func offer(_ text: String, at now: TimeInterval) -> (announce: String?, retryAfter: TimeInterval?) {
        if let current, current.text == text { return (nil, nil) }
        if let current, now - current.at < Self.gap { return (nil, Self.gap - (now - current.at)) }
        current = (text, now)
        return (text, nil)
    }
}

/// Names one Bot chat across model instances and launches: its Mac and its Bot.
struct AidenBotSessionKey: Hashable, Sendable {
    let instanceId: String
    let botID: String
}

/// A message the person sent that the Mac's transcript doesn't show yet (R14).
/// It shows at once and is replaced by the Mac's own entry or Queued bubble.
struct AidenBotOutgoingMessage: Equatable, Identifiable, Sendable {
    enum Status: Equatable, Sendable {
        /// Waiting for a connection, or on its way to the Mac.
        case sending
        /// The Mac took it; its transcript entry or Queued bubble is on the way.
        case sent(submissionId: String)
        /// It didn't reach the Mac: "Couldn't send · Try again".
        case failed
    }

    /// The Idempotency-Key. Every attempt of one message uses it, unless the Mac
    /// definitely refused it; then Try again is a new request with a new key.
    fileprivate(set) var key: UUID
    let text: String
    /// Steer or Queue, when it was sent while the Bot worked on a Mac that offers them.
    let mode: AidenStreamInputMode?
    /// Sent while the Bot worked: it reads as Queued until the turn takes it in.
    let enqueuedWhileRunning: Bool
    /// The failed turn this message sends again (R18), or nil.
    let retryOf: String?
    let createdAt: Date
    fileprivate(set) var status: Status

    var id: String { "outgoing:\(key.uuidString)" }

    /// The request body of the first attempt; later attempts with the same key resend it unchanged.
    fileprivate var request: AidenBotMessageRequest?
    /// Entry ids the transcript held at the first attempt: the Mac's echo is a newer entry.
    fileprivate var baseline: Set<String> = []
    /// The Mac's Queued bubble for it; while that shows, this copy is hidden.
    fileprivate var queuedID: String?
    /// A transcript entry already stands for it while its request is unsettled;
    /// it stays (hidden) until the receipt or failure settles it.
    fileprivate var echoed = false
    /// Waits for the next connection or backoff before trying again.
    fileprivate var deferred = false
    fileprivate var connectionAttempts = 0
    /// The last failure may have reached the Mac, so Try again keeps the key.
    fileprivate var keepsKey = false

    fileprivate var submissionId: String? {
        if case let .sent(id) = status { return id }
        return nil
    }

    /// Whether the Mac may hold it, so its echo can stand in for it.
    fileprivate var mayHaveReachedMac: Bool {
        guard request != nil else { return false }
        if case .failed = status { return keepsKey }
        return true
    }
}

/// How the chat draws an outgoing message (R14).
enum AidenBotOutgoingLook: Equatable {
    /// Faded, "Sending…".
    case sending
    /// The Mac took it; its own entry replaces it shortly.
    case sent
    /// The Bot is working: Queued, as Steer or Queue.
    case queued(AidenStreamInputMode)
    /// "Couldn't send · Try again".
    case failed
}

/// What each Bot chat last showed in this run of the app, so a chat opens on
/// its messages instead of waiting for the Mac, and its unsent messages outlive
/// leaving the chat (R14, R17). Memory only; `AidenBotOutboxStore` keeps the
/// outbox across launches.
@MainActor
final class AidenBotSessionCache {
    static let shared = AidenBotSessionCache()
    static let capacity = 16

    private var transcripts: [AidenBotSessionKey: [AidenBotSessionEntry]] = [:]
    private var order: [AidenBotSessionKey] = []
    private var outboxes: [AidenBotSessionKey: [AidenBotOutgoingMessage]] = [:]
    /// The model that writes each chat's outbox; an older one left open never overwrites it.
    private var owners: [AidenBotSessionKey: ObjectIdentifier] = [:]

    func transcript(for key: AidenBotSessionKey) -> [AidenBotSessionEntry]? { transcripts[key] }

    func store(_ transcript: [AidenBotSessionEntry], for key: AidenBotSessionKey) {
        transcripts[key] = transcript
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > Self.capacity { transcripts[order.removeFirst()] = nil }
    }

    /// The chat's unsent messages, now written by `owner` only.
    func adoptOutbox(for key: AidenBotSessionKey, owner: ObjectIdentifier) -> [AidenBotOutgoingMessage] {
        owners[key] = owner
        return outboxes[key] ?? []
    }

    func storeOutbox(_ outbox: [AidenBotOutgoingMessage], for key: AidenBotSessionKey, owner: ObjectIdentifier) {
        guard owners[key] == nil || owners[key] == owner else { return }
        owners[key] = owner
        outboxes[key] = outbox.isEmpty ? nil : outbox
    }

    /// Access to this chat ended (401/403, accessChanged).
    func purge(_ key: AidenBotSessionKey) {
        transcripts[key] = nil
        outboxes[key] = nil
        order.removeAll { $0 == key }
    }

    /// This Mac was unpaired.
    func purge(instanceId: String) {
        for key in Set(transcripts.keys).union(outboxes.keys) where key.instanceId == instanceId { purge(key) }
        owners = owners.filter { $0.key.instanceId != instanceId }
    }
}

/// The unsent messages of each Bot chat on disk, so they survive a relaunch
/// (R17): protected until first unlock, kept 24 hours, purged with the pairing.
actor AidenBotOutboxStore {
    static let shared = AidenBotOutboxStore()
    static let lifetime: TimeInterval = 24 * 60 * 60
    static let maxMessages = 50
    private static let maxBytes = 4_000_000

    private struct Record: Codable {
        let key: UUID
        let text: String
        let mode: AidenStreamInputMode?
        let enqueuedWhileRunning: Bool
        let retryOf: String?
        let createdAt: Date
        let submissionId: String?
        let failed: Bool
        let request: AidenBotMessageRequest?
        let baseline: [String]
        let connectionAttempts: Int
        let keepsKey: Bool
    }

    private struct Envelope: Codable {
        let version: Int
        let instanceId: String
        let botID: String
        let messages: [Record]
    }

    private let root: URL
    private let fileManager: FileManager
    private let now: @Sendable () -> Date

    init(root: URL? = nil, now: @escaping @Sendable () -> Date = { Date() }, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        self.now = now
        if let root {
            self.root = root
        } else {
            let applicationSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? fileManager.temporaryDirectory
            self.root = applicationSupport
                .appending(path: "AidenOnTheGo", directoryHint: .isDirectory)
                .appending(path: "BotOutbox-v1", directoryHint: .isDirectory)
        }
    }

    /// The chat's unsent messages younger than 24 hours, oldest first.
    func load(_ key: AidenBotSessionKey) -> [AidenBotOutgoingMessage] {
        let url = fileURL(key)
        guard let data = try? Data(contentsOf: url),
              data.count <= Self.maxBytes,
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              envelope.version == 1, envelope.instanceId == key.instanceId, envelope.botID == key.botID else {
            return []
        }
        let cutoff = now().addingTimeInterval(-Self.lifetime)
        let fresh = envelope.messages.filter { $0.createdAt > cutoff && $0.createdAt <= now().addingTimeInterval(60) }
        if fresh.count != envelope.messages.count {
            if fresh.isEmpty { try? fileManager.removeItem(at: url) } else { try? write(fresh, for: key) }
        }
        return fresh.map { record in
            var message = AidenBotOutgoingMessage(
                key: record.key,
                text: record.text,
                mode: record.mode,
                enqueuedWhileRunning: record.enqueuedWhileRunning,
                retryOf: record.retryOf,
                createdAt: record.createdAt,
                status: record.failed ? .failed : record.submissionId.map { .sent(submissionId: $0) } ?? .sending
            )
            message.request = record.request
            message.baseline = Set(record.baseline)
            message.connectionAttempts = record.connectionAttempts
            message.keepsKey = record.keepsKey
            return message
        }
    }

    func save(_ messages: [AidenBotOutgoingMessage], for key: AidenBotSessionKey) {
        let records = messages.suffix(Self.maxMessages).map { message in
            Record(
                key: message.key,
                text: message.text,
                mode: message.mode,
                enqueuedWhileRunning: message.enqueuedWhileRunning,
                retryOf: message.retryOf,
                createdAt: message.createdAt,
                submissionId: message.submissionId,
                failed: message.status == .failed,
                request: message.request,
                baseline: Array(message.baseline),
                connectionAttempts: message.connectionAttempts,
                keepsKey: message.keepsKey
            )
        }
        if records.isEmpty {
            remove(key)
        } else {
            try? write(Array(records), for: key)
        }
    }

    func remove(_ key: AidenBotSessionKey) {
        try? fileManager.removeItem(at: fileURL(key))
    }

    func purge(instanceId: String) {
        try? fileManager.removeItem(at: root.appending(path: digest(instanceId), directoryHint: .isDirectory))
    }

    private func write(_ records: [Record], for key: AidenBotSessionKey) throws {
        let data = try JSONEncoder().encode(Envelope(version: 1, instanceId: key.instanceId, botID: key.botID, messages: records))
        guard data.count <= Self.maxBytes else { return }
        let url = fileURL(key)
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func fileURL(_ key: AidenBotSessionKey) -> URL {
        root.appending(path: digest(key.instanceId), directoryHint: .isDirectory)
            .appending(path: "\(digest(key.botID)).json")
    }

    private func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// One row of the durable Bot transcript. Consecutive `memory_update` entries
/// collapse into one quiet "Memory updated" caption.
enum AidenBotTranscriptRow: Equatable, Identifiable {
    case entry(AidenBotSessionEntry)
    case memoryUpdated(id: String)

    var id: String {
        switch self {
        case let .entry(entry): entry.id
        case let .memoryUpdated(id): id
        }
    }

    static func rows(for entries: [AidenBotSessionEntry]) -> [Self] {
        var rows: [Self] = []
        for entry in entries {
            if case let .memoryUpdate(id, _) = entry {
                if case .memoryUpdated = rows.last { continue }
                rows.append(.memoryUpdated(id: id))
            } else {
                rows.append(.entry(entry))
            }
        }
        return rows
    }
}

/// True when a request failure may have reached the Mac, so a retry of the
/// same logical action must reuse its Idempotency-Key.
func aidenBotSessionFailureIsAmbiguous(_ error: Error) -> Bool {
    aidenBotEditorCreateFailureIsAmbiguous(error)
}

/// One Bot's durable conversation: a snapshot from `GET /session`, kept
/// current by the session event stream and its `(epoch, seq)` rule.
@MainActor
@Observable
final class AidenBotSessionModel {
    enum Action: Hashable, Sendable {
        case send, resume, dismiss, stop, answerQuestion, answerApproval, retry
    }

    let botID: String
    private let transport: any AidenBotSessionTransport

    private(set) var entries: [AidenBotSessionEntry] = []
    private(set) var partial: String?
    private(set) var stateView: AidenBotSessionStateView?
    /// The A–E question the Bot is waiting on, or nil.
    private(set) var question: AidenRemoteBotQuestion?
    /// The tool approval the Bot is waiting on, or nil.
    private(set) var approval: AidenRemoteBotApproval?
    private(set) var epoch: String?
    private(set) var seq = 0
    private(set) var hasLoaded = false
    private(set) var inFlight: Set<Action> = []
    private(set) var sentConnectionRequests: Set<String> = []
    /// Routine proposals with an answer on its way to the Mac, by proposal id.
    private(set) var respondingProposals: Set<String> = []
    /// Revision 30: the Mac announces `bot-activity-v1` and this phone holds `bot:activity`.
    var activitySupported = false
    /// The Bot's Chat activity wording, from its detail.
    var wording: AidenBotChatActivityWording = .follows
    /// What the running turn is doing (revision 30), or nil.
    private(set) var activity: AidenBotSessionActivity?
    /// The person's messages waiting for the running turn (revision 30).
    private(set) var queued: [AidenBotQueuedMessage] = []
    /// The session stream dropped and is reconnecting.
    private(set) var isStreamDown = false
    /// Messages sent from this phone the Mac's transcript doesn't show yet, oldest first.
    private(set) var outbox: [AidenBotOutgoingMessage] = [] {
        didSet { if outbox != oldValue { outboxDidChange() } }
    }
    /// Stop was pressed: the line says "Stopping" until the Mac speaks or the turn ends.
    private var stopIntent: Intent = .none
    /// Resume was pressed: the line says "Picking up where it left off" until the Mac speaks (R18).
    private var resumeIntent: Intent = .none
    var errorMessage: String?

    @ObservationIgnored private var retainedKeys: [Action: UUID] = [:]
    @ObservationIgnored private let cache: AidenBotSessionCache
    @ObservationIgnored private let cacheKey: AidenBotSessionKey?
    @ObservationIgnored private let outboxStore: AidenBotOutboxStore?
    @ObservationIgnored private let retryDelays: [Duration]
    @ObservationIgnored private var retainedQuestion: (waitId: String, request: AidenQuestionRespondRequest, key: UUID)?
    @ObservationIgnored private var retainedApproval: (waitId: String, decision: AidenApprovalDecision, key: UUID)?
    @ObservationIgnored private var connectionKeys: [String: UUID] = [:]
    /// The key of a proposal answer that failed ambiguously, by proposal id.
    @ObservationIgnored private var proposalKeys: [String: (decision: AidenBotRoutineProposalDecision, key: UUID)] = [:]
    /// Transcript entries that already stand for an outgoing message, for the life of an epoch:
    /// each entry settles one message, once.
    @ObservationIgnored private var claimedEntries: Set<String> = []
    @ObservationIgnored private var claimsEpoch: String?
    /// The run a Stop was pressed in, by its `startedAt`.
    @ObservationIgnored private var stopStartedAt: Int?
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private var backoffTask: Task<Void, Never>?
    @ObservationIgnored private var restoreTask: Task<Void, Never>?
    @ObservationIgnored private var persistTask: Task<Void, Never>?
    @ObservationIgnored private var released = false

    private enum Intent { case none, requested, acknowledged }

    /// Tries a message gets on a connection that keeps failing before it says "Couldn't send".
    static let maxConnectionAttempts = 3

    /// `cacheKey` names this chat across model instances and launches (its Mac
    /// and Bot). With one, the chat opens on its last transcript and adopts the
    /// unsent messages a previous visit or launch left (R14, R17).
    /// `retryDelays` space the retries of a message whose request may not have
    /// arrived while the Mac is connected.
    init(
        botID: String,
        transport: any AidenBotSessionTransport,
        cacheKey: AidenBotSessionKey? = nil,
        cache: AidenBotSessionCache = .shared,
        outboxStore: AidenBotOutboxStore? = .shared,
        retryDelays: [Duration] = [.seconds(1), .seconds(4)]
    ) {
        self.botID = botID
        self.transport = transport
        self.cacheKey = cacheKey
        self.cache = cache
        self.outboxStore = cacheKey == nil ? nil : outboxStore
        self.retryDelays = retryDelays
        if let cacheKey {
            entries = cache.transcript(for: cacheKey) ?? []
            outbox = cache.adoptOutbox(for: cacheKey, owner: ObjectIdentifier(self)).map(Self.adopted)
        }
    }

    /// A message another visit left keeps its key and body; what it saw then is stale.
    private static func adopted(_ message: AidenBotOutgoingMessage) -> AidenBotOutgoingMessage {
        var message = message
        message.deferred = false
        message.echoed = false
        message.queuedID = nil
        return message
    }

    /// The chat closed: timers stop, and the unsent messages stay for the next visit.
    func release() {
        released = true
        backoffTask?.cancel()
        flushTask?.cancel()
    }

    var state: AidenBotSessionStateKind? { stateView?.state }
    var needsModel: Bool { state == .needsModel }
    var isRunning: Bool { state == .running }
    var isInterrupted: Bool { stateView?.interrupted == true }
    var isAccessBlocked: Bool { stateView?.blocked == .accessChanged }
    /// The composer takes a message unless the Mac said this Bot can't take one.
    /// Before the first snapshot it waits in the outbox (R14).
    var canSend: Bool { !needsModel && state != .unavailable }

    /// No snapshot yet: the chat draws skeleton bubbles where it has no transcript (R14).
    var showsSkeleton: Bool { !hasLoaded && entries.isEmpty }
    /// Not connected yet, or reconnecting: a quiet "Connecting…" hint, never a blocking screen.
    var isConnecting: Bool { !hasLoaded || isStreamDown }
    /// Connected well enough to send now; otherwise messages wait in the outbox.
    private var isConnected: Bool { hasLoaded && !isStreamDown }

    /// The outgoing messages to draw after the transcript and the Mac's Queued bubbles.
    var outgoing: [AidenBotOutgoingMessage] { outbox.filter { !$0.echoed && !isShownAsQueued($0) } }

    private func isShownAsQueued(_ message: AidenBotOutgoingMessage) -> Bool {
        guard let id = message.queuedID else { return false }
        return queued.contains { $0.submissionId == id }
    }

    /// A message was sent and the turn hasn't started on the Mac yet.
    var isAwaitingTurn: Bool { outbox.contains { $0.status == .sending } }

    /// Stop was pressed and the turn is still running.
    var isStopping: Bool { stopIntent != .none && isRunning }
    /// Resume was pressed and the Mac hasn't said what the resumed run is doing yet.
    var isResuming: Bool { resumeIntent != .none && isRunning }

    func look(of message: AidenBotOutgoingMessage) -> AidenBotOutgoingLook {
        switch message.status {
        case .failed:
            return .failed
        case .sent where message.queuedID != nil:
            // It left the Mac's queue: the turn took it in, and its entry is on the way.
            return .sent
        case _ where activitySupported && isRunning && message.enqueuedWhileRunning:
            return .queued(message.mode ?? .queue)
        case .sending:
            return .sending
        case .sent:
            return .sent
        }
    }

    /// Steer and Queue while the Bot works need the Mac's `bot-activity-v1`.
    var offersBusyModes: Bool { activitySupported && isRunning }

    /// Phases with no tool running: while the reply's words stream in them, the
    /// words are the signal (§5.2), as on the Mac.
    private static let replyPhases: Set<String> = ["writing", "thinking"]

    /// The status line now (spec §12), or nil when it is hidden.
    func statusLine(nowMs: Int) -> AidenBotStatusLine? {
        guard activitySupported, isRunning || isAwaitingTurn else { return nil }
        func line(_ phase: String, elapsed: String? = nil) -> AidenBotStatusLine {
            AidenBotStatusLine(display: AidenBotActivityPhase.display(phase: phase, wording: wording, app: nil), elapsed: elapsed)
        }
        // A message just sent says "Getting ready" at once, before the Mac's state catches up.
        guard isRunning else { return line(isStreamDown ? "reconnecting" : "preparing") }
        let elapsed = activity.flatMap { AidenBotElapsed.label(startedAt: $0.startedAt, nowMs: nowMs) }
        if isStreamDown { return line("reconnecting", elapsed: elapsed) }
        if isStopping { return line("stopping", elapsed: elapsed) }
        if isResuming { return line("resuming", elapsed: elapsed) }
        // The partial text can outlast narration into a tool call, so a running step keeps the line.
        let replyStreaming = !(partial ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if replyStreaming, activity.map({ Self.replyPhases.contains($0.phase) }) ?? true { return nil }
        // Sent, and the first activity frame is on its way.
        guard let activity else { return line("preparing") }
        return AidenBotStatusLine(
            display: AidenBotActivityPhase.display(phase: activity.phase, wording: wording, app: activity.app),
            elapsed: elapsed
        )
    }

    /// Where the transcript stood; a response is applied only if it didn't move meanwhile.
    private var cursor: String { "\(epoch ?? "")\u{1f}\(seq)" }

    // MARK: Loading and the event stream

    /// `GET /session`, after the outbox a previous launch left is restored;
    /// returns once what waits in the outbox has gone out.
    func load() async {
        await restoreOutbox()
        _ = await fetchSnapshot()
        await flushTask?.value
    }

    /// `GET /session`. Returns false when no snapshot was loaded. A snapshot
    /// means the Mac is reachable, so the outbox goes out, without waiting here.
    private func fetchSnapshot() async -> Bool {
        do {
            let session = try await transport.botSession(botId: botID)
            // Cleared first, so what the snapshot itself reports (a purged outbox) stays.
            errorMessage = nil
            apply(snapshot: session)
            return true
        } catch is CancellationError {
            return false
        } catch {
            if Self.isAccessLoss(error) { purgeForAccessLoss() }
            errorMessage = hasLoaded ? "Couldn’t refresh this chat." : error.localizedDescription
            return false
        }
    }

    /// Listens until cancelled, reconnecting after a close or a dropped
    /// connection. Each connection starts with a snapshot. Outbox requests run
    /// beside it and never hold up a frame.
    func listen() async {
        await restoreOutbox()
        var failures = 0
        while !Task.isCancelled {
            do {
                for try await event in transport.botSessionEvents(botId: botID) {
                    failures = 0
                    isStreamDown = false
                    if await apply(event) == .closed { break }
                }
            } catch is CancellationError {
                return
            } catch {
                failures += 1
            }
            guard !Task.isCancelled else { return }
            // A dropped connection says "Reconnecting to your Mac" until the next one's first
            // frame. A clean close reconnects at once, so it doesn't flash the word.
            if failures > 0 { isStreamDown = true }
            let delay = min(30.0, 0.5 * pow(2.0, Double(min(failures, 6))))
            try? await Task.sleep(for: .seconds(failures == 0 ? 0.2 : delay))
        }
    }

    enum EventOutcome: Equatable {
        case applied, ignored, refetched, closed
    }

    /// Applies one frame under the `(epoch, seq)` rule: a snapshot replaces
    /// everything; a frame from another epoch or after a gap refetches the
    /// session; a stale or repeated frame is ignored. `closed` ends this
    /// connection, and so does a refetch that fails, because the next
    /// connection starts with a fresh snapshot anyway.
    @discardableResult
    func apply(_ event: AidenBotSessionEvent) async -> EventOutcome {
        guard event.botId == botID else { return .ignored }
        if case .closed = event.kind { return .closed }
        if case let .snapshot(session) = event.kind {
            // First frame of a connection, or mid-stream after the host
            // rewrote history: either way it replaces everything.
            apply(snapshot: session, authoritative: true)
            return .applied
        }
        guard let epoch, event.epoch == epoch else {
            return await refetch()
        }
        if event.seq <= seq { return .ignored }
        guard event.seq == seq + 1 else {
            return await refetch()
        }
        seq = event.seq
        switch event.kind {
        case .snapshot:
            break
        case let .partial(text):
            partial = text.isEmpty ? nil : text
        case let .entry(entry):
            // Upsert by id: the host re-sends an entry when it changes (an
            // answer marked interrupted, a connect card that got connected).
            if let index = entries.firstIndex(where: { $0.id == entry.id }) {
                entries[index] = entry
            } else {
                entries.append(entry)
                if entries.count > AidenBotSessionWire.maxEntries {
                    entries.removeFirst(entries.count - AidenBotSessionWire.maxEntries)
                }
                // A new assistant answer replaces the streamed partial. Other
                // entries leave it alone; the host clears it with `partial ""`.
                if case let .message(message) = entry, message.role == .assistant { partial = nil }
            }
            if let cacheKey { cache.store(entries, for: cacheKey) }
        case .unknownEntry:
            // A newer Mac's entry type: the sequence advances, nothing renders.
            break
        case let .state(view):
            setStateView(view)
        case let .question(next):
            question = next
        case let .approval(next):
            approval = next
        case let .activity(next):
            activity = next
            // The Mac's own word now stands for a Stop or Resume it has heard,
            // and a new run (another `startedAt`) has nothing to stop.
            if stopIntent == .acknowledged || (next != nil && stopStartedAt != nil && next?.startedAt != stopStartedAt) {
                stopIntent = .none
            }
            if resumeIntent == .acknowledged { resumeIntent = .none }
        case let .queued(next):
            queued = next
        case .closed:
            return .closed
        }
        reconcileOutbox(snapshot: false)
        scheduleFlush()
        return .applied
    }

    /// The visible transcript stays until the new snapshot replaces it, so a
    /// failed refetch never blanks the chat.
    private func refetch() async -> EventOutcome {
        epoch = nil
        seq = 0
        return await fetchSnapshot() ? .refetched : .closed
    }

    /// A stream snapshot is authoritative. A `GET /session` response is not:
    /// one that arrives after newer frames of the same epoch is dropped so it
    /// cannot roll the transcript back.
    private func apply(snapshot session: AidenBotSession, authoritative: Bool = false) {
        guard session.botId == botID else { return }
        if !authoritative, session.epoch == epoch, session.seq < seq { return }
        epoch = session.epoch
        seq = session.seq
        entries = session.entries
        partial = session.partial.flatMap { $0.isEmpty ? nil : $0 }
        setStateView(session.stateView)
        question = session.question
        approval = session.approval
        activity = session.activity
        queued = session.queued
        hasLoaded = true
        if let cacheKey { cache.store(entries, for: cacheKey) }
        reconcileOutbox(snapshot: true)
        // A snapshot is a connection: what waits in the outbox goes out now.
        wakeOutbox()
    }

    /// A turn that is no longer running takes its Stop and Resume with it, so the
    /// next turn never starts at "Stopping". A Bot whose access changed loses
    /// what waited to go to it.
    private func setStateView(_ view: AidenBotSessionStateView?) {
        let wasBlocked = stateView?.blocked == .accessChanged
        stateView = view
        if view?.state != .running {
            stopIntent = .none
            resumeIntent = .none
        }
        if view?.blocked == .accessChanged, !wasBlocked { purgeForAccessLoss() }
    }

    // MARK: Reconciling the outbox

    /// Server truth replaces optimistic messages (R14, R16, R17). A taken message
    /// gives way to the entry with its `submissionId`; text stands in only where
    /// the entry has none (an older Mac), for a request still unsettled, or for a
    /// Queued bubble that beats the receipt. Each entry settles one message for
    /// the life of the epoch. An unsettled message is never removed: it hides
    /// and settles on its receipt. On a Mac that sends its queue, a snapshot also
    /// drops a taken message that is neither queued nor echoed.
    private func reconcileOutbox(snapshot: Bool) {
        if claimsEpoch != epoch {
            claimsEpoch = epoch
            claimedEntries = []
        }
        guard !outbox.isEmpty else { return }
        let owned = Set(outbox.compactMap(\.submissionId))
        let queuedIDs = Set(queued.map(\.submissionId))
        var claimedQueued = owned
        var kept: [AidenBotOutgoingMessage] = []
        for var message in outbox {
            guard message.mayHaveReachedMac else {
                kept.append(message)
                continue
            }
            if !message.echoed, let echo = echoEntry(for: message, owned: owned) {
                claimedEntries.insert(echo)
                guard message.status == .sending else { continue }
                message.echoed = true
            }
            if !message.echoed {
                if let id = message.submissionId {
                    if queuedIDs.contains(id) {
                        message.queuedID = id
                    } else if snapshot, activitySupported {
                        // Taken, not queued and not in the transcript: nothing on the Mac holds it.
                        continue
                    }
                } else if message.queuedID == nil,
                          let match = queued.first(where: { !claimedQueued.contains($0.submissionId) && $0.text == message.text }) {
                    // The Queued frame can beat the receipt.
                    claimedQueued.insert(match.submissionId)
                    message.queuedID = match.submissionId
                }
            }
            kept.append(message)
        }
        if kept != outbox { outbox = kept }
    }

    /// The unclaimed user entry that stands for `message`, if any.
    private func echoEntry(for message: AidenBotOutgoingMessage, owned: Set<String>) -> String? {
        var byText: String?
        for entry in entries {
            guard case let .message(sent) = entry, sent.role == .user, !claimedEntries.contains(sent.id) else { continue }
            if let id = message.submissionId, sent.submissionId == id { return sent.id }
            guard byText == nil, !message.baseline.contains(sent.id),
                  sent.text.trimmingCharacters(in: .whitespacesAndNewlines) == message.text else { continue }
            if let theirs = sent.submissionId {
                // An entry that names its submission belongs to that submission.
                if message.submissionId != nil || owned.contains(theirs) { continue }
            }
            byText = sent.id
        }
        return byText
    }

    // MARK: The outbox

    private func outboxDidChange() {
        guard let cacheKey, !released else { return }
        cache.storeOutbox(outbox, for: cacheKey, owner: ObjectIdentifier(self))
        guard let outboxStore else { return }
        let snapshot = outbox
        let previous = persistTask
        persistTask = Task {
            await previous?.value
            await outboxStore.save(snapshot, for: cacheKey)
        }
    }

    /// Adds what a previous launch left on disk, once, before the first snapshot sends it.
    private func restoreOutbox() async {
        guard let cacheKey, let outboxStore else { return }
        if restoreTask == nil {
            restoreTask = Task { [weak self] in
                let stored = await outboxStore.load(cacheKey)
                guard let self, !stored.isEmpty else { return }
                let known = Set(self.outbox.map(\.key))
                let added = stored.filter { !known.contains($0.key) }.map(Self.adopted)
                if !added.isEmpty {
                    self.outbox = (added + self.outbox).sorted { $0.createdAt < $1.createdAt }
                }
            }
        }
        await restoreTask?.value
    }

    /// The Mac is reachable again: deferred messages get another try.
    private func wakeOutbox() {
        for index in outbox.indices where outbox[index].deferred { outbox[index].deferred = false }
        scheduleFlush()
    }

    private func scheduleFlush() {
        guard !released, flushTask == nil, nextToDeliver() != nil else { return }
        flushTask = Task { [weak self] in await self?.flushOutbox() }
    }

    /// The oldest unsettled message, unless it waits for a retry: nothing
    /// overtakes it, so messages reach the Mac in the order they were sent.
    private func nextToDeliver() -> UUID? {
        guard isConnected, !released, let head = outbox.first(where: { $0.status == .sending }), !head.deferred else {
            return nil
        }
        return head.key
    }

    private func flushOutbox() async {
        while let key = nextToDeliver(), !Task.isCancelled {
            await deliver(key)
        }
        flushTask = nil
    }

    private func deliver(_ key: UUID) async {
        guard let index = outbox.firstIndex(where: { $0.key == key }) else { return }
        if needsModel || state == .unavailable {
            outbox[index].status = .failed
            outbox[index].echoed = false
            return
        }
        let request: AidenBotMessageRequest
        if let frozen = outbox[index].request {
            request = frozen
        } else {
            let whenBusy = offersBusyModes ? outbox[index].mode : nil
            guard let made = try? AidenBotMessageRequest(text: outbox[index].text, whenBusy: whenBusy) else {
                outbox[index].status = .failed
                return
            }
            request = made
            outbox[index].request = made
            outbox[index].baseline = Set(entries.map(\.id))
        }
        let isRetry = outbox[index].retryOf != nil
        let mark = cursor
        inFlight.insert(.send)
        if isRetry { inFlight.insert(.retry) }
        defer {
            inFlight.remove(.send)
            inFlight.remove(.retry)
        }
        do {
            let receipt = try await transport.sendBotMessage(botId: botID, request: request, idempotencyKey: key)
            if cursor == mark { setStateView(receipt.stateView) }
            guard let current = outbox.firstIndex(where: { $0.key == key }) else { return }
            if outbox[current].echoed {
                outbox.remove(at: current)
            } else {
                outbox[current].status = .sent(submissionId: receipt.submissionId)
                outbox[current].deferred = false
                outbox[current].keepsKey = false
            }
            reconcileOutbox(snapshot: false)
        } catch {
            // A closed chat leaves the message as it was for the next visit.
            guard !released, let current = outbox.firstIndex(where: { $0.key == key }) else { return }
            if Self.isAccessLoss(error) {
                purgeForAccessLoss()
                return
            }
            guard aidenBotSessionFailureIsAmbiguous(error) else {
                // Refused outright: it never reached the Mac.
                outbox[current].status = .failed
                outbox[current].keepsKey = false
                outbox[current].echoed = false
                return
            }
            outbox[current].keepsKey = true
            outbox[current].connectionAttempts += 1
            let attempts = outbox[current].connectionAttempts
            if attempts < Self.maxConnectionAttempts {
                // It keeps its place and key: the next connection, or a short wait while
                // connected, tries again. Nothing behind it overtakes it.
                outbox[current].deferred = true
                scheduleBackoff(after: attempts)
            } else if outbox[current].echoed {
                // The Mac's transcript already shows it.
                outbox.remove(at: current)
            } else {
                outbox[current].status = .failed
            }
        }
    }

    private func scheduleBackoff(after attempts: Int) {
        guard isConnected, !retryDelays.isEmpty else { return }
        let delay = retryDelays[min(attempts - 1, retryDelays.count - 1)]
        backoffTask?.cancel()
        backoffTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self, !self.released else { return }
            self.wakeOutbox()
        }
    }

    /// 401 or 403, or a pairing that's gone: this phone no longer reaches this Bot.
    private static func isAccessLoss(_ error: Error) -> Bool {
        guard let error = error as? AidenRemoteClientError else { return false }
        switch error {
        case let .server(status, _), let .unexpectedStatus(status):
            return status == 401 || status == 403
        case .missingCredential, .installationChanged:
            return true
        default:
            return false
        }
    }

    /// Access ended: nothing unsent is kept for this chat, in memory or on disk.
    private func purgeForAccessLoss() {
        let hadUnsent = outbox.contains { $0.submissionId == nil }
        backoffTask?.cancel()
        outbox = []
        if let cacheKey {
            cache.purge(cacheKey)
            if let outboxStore {
                let previous = persistTask
                persistTask = Task {
                    await previous?.value
                    await outboxStore.remove(cacheKey)
                }
            }
        }
        if hadUnsent { errorMessage = "That message wasn’t sent. Please try again." }
    }

    // MARK: Quick-reply questions

    var canAnswerQuestion: Bool {
        hasLoaded && question != nil && !needsModel && !inFlight.contains(.answerQuestion)
    }

    /// Answers the waiting question. The card goes at once and comes back with an
    /// error if the answer didn't reach the Mac (R18). The request UUID is kept
    /// across an ambiguous failure, so retrying the same answer replays the Mac's
    /// receipt instead of answering twice; a different answer is a new request.
    func answerQuestion(_ response: AidenQuestionRespondRequest) async {
        guard canAnswerQuestion, let shown = question else { return }
        let waitId = shown.waitId
        let key: UUID
        if let retainedQuestion, retainedQuestion.waitId == waitId, retainedQuestion.request == response {
            key = retainedQuestion.key
        } else {
            key = UUID()
            retainedQuestion = (waitId, response, key)
        }
        let mark = cursor
        question = nil
        inFlight.insert(.answerQuestion)
        defer { inFlight.remove(.answerQuestion) }
        do {
            _ = try await transport.answerBotQuestion(
                botId: botID,
                waitId: waitId,
                request: response,
                idempotencyKey: key
            )
            retainedQuestion = nil
        } catch {
            if question == nil, cursor == mark { question = shown }
            if error is CancellationError { return }
            if !aidenBotSessionFailureIsAmbiguous(error) { retainedQuestion = nil }
            errorMessage = "That answer wasn’t sent. Please try again."
        }
    }

    // MARK: Tool approvals

    var canAnswerApproval: Bool {
        hasLoaded && approval != nil && !inFlight.contains(.answerApproval)
    }

    /// Allows or denies the waiting tool call, once. The card goes at once and
    /// comes back with an error if the decision didn't reach the Mac (R18).
    /// Allow is refused when the Mac says the phone may only deny it. The
    /// request UUID survives an ambiguous failure so retrying the same decision
    /// replays the Mac's receipt; another decision is a new request. When nothing
    /// is waiting any more (expired or already answered), the card stays gone.
    func answerApproval(_ decision: AidenApprovalDecision) async {
        guard canAnswerApproval, let current = approval else { return }
        if decision == .allow && !current.canAllow { return }
        let waitId = current.waitId
        let key: UUID
        if let retainedApproval, retainedApproval.waitId == waitId, retainedApproval.decision == decision {
            key = retainedApproval.key
        } else {
            key = UUID()
            retainedApproval = (waitId, decision, key)
        }
        let mark = cursor
        approval = nil
        inFlight.insert(.answerApproval)
        defer { inFlight.remove(.answerApproval) }
        do {
            _ = try await transport.respondToApproval(
                id: waitId,
                decision: decision,
                scope: nil,
                idempotencyKey: key
            )
            retainedApproval = nil
        } catch {
            if !aidenBotSessionFailureIsAmbiguous(error) { retainedApproval = nil }
            if case let AidenRemoteClientError.server(_, body) = error,
               ["approval_expired", "approval_already_resolved"].contains(body.code.rawValue) {
                return
            }
            if approval == nil, cursor == mark { approval = current }
            if error is CancellationError { return }
            errorMessage = "That answer wasn’t sent. Please try again."
        }
    }

    // MARK: Turn controls

    /// Sends one message (R14). It shows at once as an outgoing message, and
    /// goes out now when connected, or from the outbox on the next connection,
    /// under one Idempotency-Key. A Bot that needs an AI model takes nothing.
    /// While it works, on a Mac offering `bot-activity-v1`, `whenBusy` says
    /// Steer or Queue; otherwise it is left off, because an older Mac refuses it.
    ///
    /// Returns true when the message was taken (it shows), false when refused.
    @discardableResult
    func send(_ rawText: String, whenBusy mode: AidenStreamInputMode? = nil) async -> Bool {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, (try? AidenBotMessageRequest(text: text)) != nil else { return false }
        enqueue(text, mode: offersBusyModes ? mode ?? .queue : nil, retryOf: nil)
        await flushTask?.value
        return true
    }

    private func enqueue(_ text: String, mode: AidenStreamInputMode?, retryOf: String?) {
        outbox.append(AidenBotOutgoingMessage(
            key: UUID(),
            text: text,
            mode: mode,
            enqueuedWhileRunning: isRunning,
            retryOf: retryOf,
            createdAt: Date(),
            status: .sending
        ))
        scheduleFlush()
    }

    /// Try again on a message that couldn't be sent. A message the Mac may hold
    /// keeps its key, so the Mac replays its receipt instead of taking it twice.
    @discardableResult
    func retrySend(_ id: String) async -> Bool {
        guard let index = outbox.firstIndex(where: { $0.id == id }), outbox[index].status == .failed else { return false }
        if !outbox[index].keepsKey {
            outbox[index].key = UUID()
            outbox[index].request = nil
        }
        outbox[index].status = .sending
        outbox[index].deferred = false
        outbox[index].connectionAttempts = 0
        scheduleFlush()
        await flushTask?.value
        return true
    }

    /// Removes a message that couldn't be sent; nothing else is ever dropped silently.
    func discardSend(_ id: String) {
        outbox.removeAll { $0.id == id && $0.status == .failed }
    }

    /// The newest entry when it is a failed turn that can be sent again, and no
    /// Retry of it is on its way.
    var retryableFailedTurn: AidenBotFailedTurn? {
        guard case let .failedTurn(turn) = entries.last,
              let text = turn.retryText,
              (try? AidenBotMessageRequest(text: text)) != nil,
              !outbox.contains(where: { $0.retryOf == turn.id && $0.status != .failed }) else { return nil }
        return turn
    }

    /// Sends a failed turn's text again through the outbox (R18): it shows at
    /// once and goes out with the other messages. A Retry is its own submission
    /// with its own key, never the original message's; a Retry that couldn't be
    /// sent is tried again under its key when the Mac may hold it.
    @discardableResult
    func retry() async -> Bool {
        guard hasLoaded, canSend, let turn = retryableFailedTurn, let text = turn.retryText else { return false }
        if let earlier = outbox.first(where: { $0.retryOf == turn.id }) {
            return await retrySend(earlier.id)
        }
        enqueue(text, mode: offersBusyModes ? .queue : nil, retryOf: turn.id)
        await flushTask?.value
        return true
    }

    /// Resume shows "Picking up where it left off" at once and goes back if the
    /// Mac didn't take it (R18).
    func resume() async {
        guard isInterrupted, !isAccessBlocked, !inFlight.contains(.resume) else { return }
        resumeIntent = .requested
        let resumed = await perform(.resume, optimistic: try? AidenBotSessionStateView(state: .running)) { [transport, botID] key in
            try await transport.resumeBotSession(botId: botID, idempotencyKey: key)
        }
        if !resumed {
            resumeIntent = .none
        } else if resumeIntent == .requested {
            resumeIntent = .acknowledged
        }
    }

    /// Dismiss clears the paused card at once and brings it back if the Mac didn't take it (R18).
    func dismiss() async {
        guard isInterrupted else { return }
        await perform(.dismiss, optimistic: try? AidenBotSessionStateView(state: .idle)) { [transport, botID] key in
            try await transport.dismissBotSession(botId: botID, idempotencyKey: key)
        }
    }

    /// Stop says "Stopping" at once (R14) and goes back if the Mac didn't take it.
    func stop() async {
        guard isRunning, !inFlight.contains(.stop) else { return }
        stopIntent = .requested
        stopStartedAt = activity?.startedAt
        let stopped = await perform(.stop) { [transport, botID] key in
            try await transport.stopBotSession(botId: botID, idempotencyKey: key)
        }
        if !stopped {
            stopIntent = .none
        } else if stopIntent == .requested {
            stopIntent = .acknowledged
        }
    }

    /// One request per logical action at a time. The key survives an ambiguous
    /// failure so a retry is deduplicated by the Mac. `optimistic` shows at once
    /// and goes back on failure; the Mac's answer is applied only if no frame
    /// moved the session meanwhile.
    @discardableResult
    private func perform(
        _ action: Action,
        optimistic: AidenBotSessionStateView? = nil,
        _ request: @escaping @Sendable (UUID) async throws -> AidenBotSessionStateView
    ) async -> Bool {
        guard !inFlight.contains(action) else { return false }
        let key = retainedKeys[action] ?? UUID()
        retainedKeys[action] = key
        let previous = stateView
        let mark = cursor
        if let optimistic { stateView = optimistic }
        inFlight.insert(action)
        defer { inFlight.remove(action) }
        do {
            let view = try await request(key)
            if cursor == mark { setStateView(view) }
            retainedKeys[action] = nil
            return true
        } catch {
            if optimistic != nil, cursor == mark { stateView = previous }
            if error is CancellationError { return false }
            if !aidenBotSessionFailureIsAmbiguous(error) { retainedKeys[action] = nil }
            errorMessage = "That didn’t work. Please try again."
            return false
        }
    }

    // MARK: Routine proposals

    /// Answers a pending routine proposal. The card settles at once and goes
    /// back to pending with an error if the answer didn't reach the Mac (R18);
    /// the Mac's settled answer replaces it when it arrives (the same answer on
    /// every repeat, from any device). The key survives an ambiguous failure so
    /// tapping again cannot add twice.
    @discardableResult
    func respondToProposal(_ proposalId: String, decision: AidenBotRoutineProposalDecision) async -> Bool {
        guard hasLoaded, !respondingProposals.contains(proposalId),
              let index = proposalIndex(proposalId),
              case let .routineProposal(card) = entries[index],
              card.status == .pending else { return false }
        let key: UUID
        if let retained = proposalKeys[proposalId], retained.decision == decision {
            key = retained.key
        } else {
            key = UUID()
            proposalKeys[proposalId] = (decision, key)
        }
        let optimistic = AidenBotSessionEntry.routineProposal(AidenBotRoutineProposalCard(
            id: card.id,
            proposalId: card.proposalId,
            name: card.name,
            prompt: card.prompt,
            label: card.label,
            status: decision == .accept ? .accepted : .dismissed,
            routineId: nil,
            createdAt: card.createdAt
        ))
        entries[index] = optimistic
        respondingProposals.insert(proposalId)
        defer { respondingProposals.remove(proposalId) }
        do {
            let result = try await transport.respondToBotRoutineProposal(
                botId: botID,
                proposalId: proposalId,
                request: AidenBotRoutineProposalRespondRequest(decision: decision),
                idempotencyKey: key
            )
            proposalKeys[proposalId] = nil
            if let current = proposalIndex(proposalId), case let .routineProposal(latest) = entries[current] {
                entries[current] = .routineProposal(latest.settled(result))
            }
            return true
        } catch {
            if let current = proposalIndex(proposalId), entries[current] == optimistic {
                entries[current] = .routineProposal(card)
            }
            if error is CancellationError { return false }
            if !aidenBotSessionFailureIsAmbiguous(error) { proposalKeys[proposalId] = nil }
            if case AidenRemoteClientError.server(404, _) = error {
                // The proposal is gone on the Mac; show what the Mac has now.
                _ = await fetchSnapshot()
            }
            errorMessage = AidenBotSessionCopy.proposalFailed
            return false
        }
    }

    private func proposalIndex(_ proposalId: String) -> Int? {
        entries.firstIndex { entry in
            if case let .routineProposal(card) = entry { return card.proposalId == proposalId }
            return false
        }
    }

    // MARK: Connect cards

    func requestConnection(pluginId: String) async {
        guard !sentConnectionRequests.contains(pluginId),
              let request = try? AidenBotConnectionRequest(pluginId: pluginId) else { return }
        let key = connectionKeys[pluginId] ?? UUID()
        connectionKeys[pluginId] = key
        sentConnectionRequests.insert(pluginId)
        do {
            _ = try await transport.requestBotConnection(botId: botID, request: request, idempotencyKey: key)
            connectionKeys[pluginId] = nil
        } catch is CancellationError {
            sentConnectionRequests.remove(pluginId)
        } catch {
            sentConnectionRequests.remove(pluginId)
            if !aidenBotSessionFailureIsAmbiguous(error) { connectionKeys[pluginId] = nil }
            if case let AidenRemoteClientError.server(404, body) = error {
                // The Mac can't set up this app; say so instead of "try again".
                errorMessage = body.message
            } else {
                errorMessage = "Your Mac didn’t get that request. Please try again."
            }
        }
    }
}

/// A neutral glyph for a connection's `iconId`.
func aidenBotConnectionSymbol(iconId: String) -> String {
    switch iconId {
    case "gmail", "outlook-email", "outlook", "email": "envelope"
    case "google-calendar", "outlook-calendar", "calendar": "calendar"
    case "notion", "google-docs", "docs": "doc.text"
    case "slack", "discord": "bubble.left.and.bubble.right"
    case "github", "gitlab": "chevron.left.forwardslash.chevron.right"
    case "linear", "jira": "checklist"
    case "google-drive", "dropbox": "folder"
    case "composio": "square.grid.2x2"
    default: "puzzlepiece.extension"
    }
}
