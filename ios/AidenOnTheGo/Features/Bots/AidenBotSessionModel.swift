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
    /// Contract revision 33: photos and text files on a Bot message (the composer's +).
    static let attachments = "bot-attachments-v1"

    static func isAdvertised(_ token: String, by features: [String]?) -> Bool {
        features?.contains(token) == true
    }

    /// Reads the connection's `/server` answer, or the pairing's saved one
    /// while connecting, so a cold open resolves Bot routes the way the last
    /// connected open did.
    @MainActor
    static func isAdvertised(_ token: String, coordinator: AidenRemoteCoordinator) -> Bool {
        isAdvertised(token, by: coordinator.knownServerFeatures)
    }
}

/// Whether the Bot activity features show (revision 30): the Mac announces
/// `bot-activity-v1` and this phone holds `bot:activity`. Until `/server`
/// answers (a cold or offline open), the pairing's last-known feature and
/// grant stand in, so the status line, Steer/Queue and the Chat activity row
/// keep working (R21). Once `/server` answers, it decides.
func aidenBotActivitySupported(server: AidenServer?, installation: AidenInstallation?) -> Bool {
    if let server { return server.supportsBotActivity }
    return installation?.cachedBotActivity == true
}

@MainActor
func aidenBotActivitySupported(coordinator: AidenRemoteCoordinator) -> Bool {
    aidenBotActivitySupported(server: coordinator.server, installation: coordinator.installationStore.activeInstallation)
}

/// Which of `bot:cards`, `bot:activity`, `bot:handoffs`, `bot:handoff-notes`,
/// `bot:handoff-on-mac` and `bot:images` the pairing holds.
/// The Mac shapes a Bot session feed by these (its cards, Chat activity,
/// hand-offs and the paused state) when the feed opens, and keeps that shape
/// for the feed's life. A Bot chat can open from the pairing's saved features
/// while the phone connects, before this connection has negotiated a grant, so
/// the chat reopens a feed that opened without one
/// (`AidenBotSessionModel.reopenFeed()`; Android parity).
func aidenBotSessionFeedGrants(_ installation: AidenInstallation?) -> Set<AidenRemoteCapability> {
    Set([AidenRemoteCapability.botCards, .botActivity, .botHandoffs, .botHandoffNotes, .botHandoffOnMac, .botImages].filter { installation?.hasNegotiatedAccess(to: $0) == true })
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
    /// Revision 33 (`bot-attachments-v1`): stage one upload for the next message.
    func uploadBotAttachment(botId: String, upload: AidenAttachmentUpload) async throws -> AidenAttachmentReference
    func removeBotAttachment(botId: String, attachmentId: String) async throws
    /// Revision 37 (`bot:handoffs`): Done or Skip for the waiting hand-off.
    func answerBotHandoff(
        botId: String,
        waitId: String,
        request: AidenBotHandoffAnswerRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotHandoffAnswerReceipt
    /// Revision 37: bring a hand-off (a sign-in) forward on the Mac.
    func openBotHandoffOnMac(botId: String, waitId: String, idempotencyKey: UUID) async throws -> AidenBotHandoffOpenOnMacReceipt
    /// Revision 37: `POST /bots/{botId}/pause`.
    func pauseBot(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView
    /// Revision 37: `DELETE /bots/{botId}/pause`.
    func unpauseBot(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView
    /// Revision 45 (`bot:images`): the bytes of an image the Bot shared.
    func botSessionImage(botId: String, entryId: String) async throws -> Data
    /// Revision 42 (`bot:issues`): carry out one action a card offers.
    func actOnBotIssue(
        botId: String,
        issueId: String,
        request: AidenBotIssueActRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotIssueActReceipt
}

extension AidenBotSessionTransport {
    /// A transport without Bot uploads refuses them, as a Mac without the feature does.
    func uploadBotAttachment(botId: String, upload: AidenAttachmentUpload) async throws -> AidenAttachmentReference {
        throw AidenRemoteClientError.invalidResponse
    }

    func removeBotAttachment(botId: String, attachmentId: String) async throws {}

    /// A transport without hand-offs refuses them, as a Mac without `bot:handoffs` does.
    func answerBotHandoff(
        botId: String,
        waitId: String,
        request: AidenBotHandoffAnswerRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotHandoffAnswerReceipt {
        throw AidenRemoteClientError.invalidResponse
    }

    func openBotHandoffOnMac(botId: String, waitId: String, idempotencyKey: UUID) async throws -> AidenBotHandoffOpenOnMacReceipt {
        throw AidenRemoteClientError.invalidResponse
    }

    func pauseBot(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        throw AidenRemoteClientError.invalidResponse
    }

    func unpauseBot(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        throw AidenRemoteClientError.invalidResponse
    }

    /// A transport without shared images has none to read, as a Mac without `bot:images`.
    func botSessionImage(botId: String, entryId: String) async throws -> Data {
        throw AidenRemoteClientError.invalidResponse
    }

    /// A transport without issues refuses them, as a Mac without `bot:issues` does.
    func actOnBotIssue(
        botId: String,
        issueId: String,
        request: AidenBotIssueActRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotIssueActReceipt {
        throw AidenRemoteClientError.invalidResponse
    }
}

extension AidenRemoteClient: AidenBotSessionTransport {}

/// What the Mac said after Finish on your Mac (revision 37).
struct AidenBotHandoffMacPrompt: Equatable, Sendable {
    let waitId: String
    /// The Mac brought the hand-off forward; otherwise no Aiden window could show it.
    let opened: Bool
    /// A sign-in, or (revision 43) a step on the Bot's own screen.
    var signIn: Bool = true

    var text: String {
        if signIn { return opened ? AidenBotSessionCopy.finishSigningInOnMac : AidenBotSessionCopy.openAidenOnMac }
        return opened ? AidenBotSessionCopy.finishStepOnMac : AidenBotSessionCopy.openAidenOnMacForStep
    }
}

/// The exact copy shared with desktop and Android.
enum AidenBotSessionCopy {
    static let attachmentsExpired = "Attachments expired"
    static let attachAgain = "Attach again"
    static let interrupted = "I got interrupted while working on this."
    static let resume = "Resume"
    static let dismiss = "Dismiss"
    static let accessChanged = "This Bot's access changed. Review it in Advanced."
    static let openAdvanced = "Advanced"
    /// A reply that stopped before it finished (a quit, a crash, or a lifted pause).
    static let interruptedSubtitle = "Interrupted — tap to resume"
    /// Revision 37: the person paused the Bot.
    static let pausedSubtitle = "Paused"
    static let needsModel = "Needs an AI model"
    static let needsModelHint = "Set up on your Mac"
    static let setUp = "Set up"
    static let queued = "Queued"
    /// The outbox file a previous launch left couldn't be read; it was set aside, not deleted.
    static let outboxUnrestorable = "Some unsent messages couldn’t be restored."

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

    // Revision 37 (`bot:handoffs`), shared with desktop and Android.
    static func handoffTitle(_ action: String) -> String { "Your turn: \(action)" }
    static let handoffDone = "Done"
    static let handoffSkip = "Skip"
    static let handoffOpen = "Open"
    static let handoffNotePlaceholder = "Add a note and send to mark it done"
    static let signInPlaceholder = "Finish signing in on your Mac, or skip it."
    /// Revision 40: a password-or-code card takes no note, so the composer waits.
    static let handoffNoNotePlaceholder = "Enter it yourself, then tap Done."
    static let handoffExpired = "That card was already answered or closed."
    static let handoffNotSent = "That answer wasn’t sent. Please try again."
    static let handoffNoteTooLong = "Keep the note under 4,000 characters."
    static let handoffPhotosWait = "Send photos after you answer the card."
    static let handoffFilesWait = "Send files after you answer the card."
    static let finishSigningInOnMac = "Finish signing in on your Mac."
    static let openAidenOnMac = "Open Aiden on your Mac to finish signing in."
    /// Revision 43: a step on the Bot's own browser or computer.
    static let finishStepOnMac = "Finish this step on your Mac."
    static let openAidenOnMacForStep = "Open Aiden on your Mac to finish this step."
    static let handoffOnMacDetail = "This step is on the Bot’s own screen on your Mac."
    static let pauseBot = "Pause Bot"
    static let resumeBot = "Resume Bot"
    static func pausedTitle(_ name: String) -> String { "\(name) is paused." }
    static func pausedDetail(_ name: String) -> String { "\(name) won’t reply or run routines until you resume it." }
    static func pausedPlaceholder(_ name: String) -> String { "\(name) is paused" }

    // Revision 42 (`bot:issues`), shared with desktop and Android.
    static let issueNeedsYou = "Needs you"
    /// A card whose only action opens the Mac's own settings.
    static let issueOpenOnMac = "Open on your Mac"
    static let issueOpenChat = "Open chat"
    static let issueResumeRoutine = "Resume routine"
    static let issueStop = "Stop"
    static let issueKeepWaiting = "Keep waiting"
    static let issueStale = "This card changed. Pull to refresh and try again."
    static let issueNotSent = "That didn’t reach your Mac. Please try again."

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

    /// The line hid: whatever it says next is announced at once.
    mutating func reset() { current = nil }

    /// The text to announce now, or nil. `retryAfter` says when to offer the newest text again.
    mutating func offer(_ text: String, at now: TimeInterval) -> (announce: String?, retryAfter: TimeInterval?) {
        if let current, current.text == text { return (nil, nil) }
        if let current, now - current.at < Self.gap { return (nil, Self.gap - (now - current.at)) }
        current = (text, now)
        return (text, nil)
    }
}

/// Names one Bot chat across model instances and launches: its Mac and its Bot.
/// The pairing's `deviceId` is part of it, so a re-paired phone never sees the
/// old pairing's messages.
struct AidenBotSessionKey: Hashable, Sendable {
    let instanceId: String
    let deviceId: String
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
        /// It didn't reach the Mac: "Couldn’t send · Try again".
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
    /// Revision 33: the photos and files it carries, staged on the Mac before it was sent.
    fileprivate(set) var attachments: [AidenAttachmentReference] = []

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
    fileprivate var echoEntryID: String?
    /// The submission that entry names, if any: only a receipt with that id settles it.
    fileprivate var echoSubmissionID: String?
    /// Submissions known not to be this message: entries naming them never settle it.
    fileprivate var foreignSubmissionIDs: Set<String> = []
    /// Waits for the next connection or backoff before trying again.
    fileprivate var deferred = false
    fileprivate var connectionAttempts = 0
    /// The last failure may have reached the Mac, so Try again keeps the key.
    fileprivate var keepsKey = false
    /// The Mac no longer holds its staged uploads (they expire after ten minutes).
    fileprivate var attachmentsGone = false
    /// When a snapshot first showed nothing on the Mac holding it (FR-m5). The
    /// queued list caps at 20 and the Mac leaves out inputs it can't classify,
    /// so one snapshot is not proof: it goes only after a grace period.
    fileprivate var unheldSince: Date?

    fileprivate var submissionId: String? {
        if case let .sent(id) = status { return id }
        return nil
    }

    /// Too old to send: "Couldn’t send · Try again", keeping the key if the Mac may hold it.
    fileprivate mutating func expire() {
        status = .failed
        keepsKey = request != nil
        deferred = false
        dropEcho()
    }

    /// Forgets the entry it waited on; one that names another submission stays foreign.
    fileprivate mutating func dropEcho() {
        if let theirs = echoSubmissionID { foreignSubmissionIDs.insert(theirs) }
        echoed = false
        echoEntryID = nil
        echoSubmissionID = nil
    }

    /// A message on its way looks sent at once; "Sending…" shows only once it
    /// has waited this long for the Mac (offline, or a slow Mac).
    static let sendingCaptionDelay: TimeInterval = 2

    static func showsSendingCaption(sentAt: Date, now: Date) -> Bool {
        now.timeIntervalSince(sentAt) >= sendingCaptionDelay
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
    /// On its way: drawn as sent, with "Sending…" once it has waited a moment.
    case sending
    /// The Mac took it; its own entry replaces it shortly.
    case sent
    /// The Bot is working: Queued, as Steer or Queue.
    case queued(AidenStreamInputMode)
    /// "Couldn’t send · Try again".
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

    /// Stores the outbox when `owner` writes this chat; false when another model does.
    @discardableResult
    func storeOutbox(_ outbox: [AidenBotOutgoingMessage], for key: AidenBotSessionKey, owner: ObjectIdentifier) -> Bool {
        guard owners[key] == nil || owners[key] == owner else { return false }
        owners[key] = owner
        outboxes[key] = outbox.isEmpty ? nil : outbox
        return true
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
/// (R17): protected until first unlock, excluded from backup, keyed by the
/// pairing, and purged with it. A message still unsent after 24 hours comes
/// back as "Couldn’t send · Try again", never silently gone.
actor AidenBotOutboxStore {
    static let shared = AidenBotOutboxStore()
    static let lifetime: TimeInterval = 24 * 60 * 60
    /// The most messages one chat may hold waiting; another is refused, visibly.
    static let maxMessages = 20
    /// One chat's file. 20 of the largest messages fit: 32,000 code points each,
    /// stored twice (text and request), at up to 6 JSON bytes per code point.
    static let maxBytes = 10_000_000

    /// A write handed to the store: the newest one per chat replaces one not yet made.
    enum Write: Sendable {
        case save([AidenBotOutgoingMessage])
        case remove
    }

    /// Writes waiting per chat, filled from any thread.
    private final class Pending: @unchecked Sendable {
        private let lock = NSLock()
        private var writes: [AidenBotSessionKey: Write] = [:]
        /// Every pairing a write was handed in for, per Mac, made or not.
        private var pairings: [String: Set<String>] = [:]

        func put(_ write: Write, for key: AidenBotSessionKey) {
            lock.withLock {
                writes[key] = write
                pairings[key.instanceId, default: []].insert(key.deviceId)
            }
        }

        /// The waiting write, if any. A pairing with nothing left waiting is forgotten
        /// here; the store's own record of what it wrote covers it from now on.
        func take(_ key: AidenBotSessionKey) -> Write? {
            lock.withLock {
                let write = writes.removeValue(forKey: key)
                if !writes.keys.contains(where: { $0.instanceId == key.instanceId && $0.deviceId == key.deviceId }) {
                    pairings[key.instanceId]?.remove(key.deviceId)
                    if pairings[key.instanceId]?.isEmpty == true { pairings[key.instanceId] = nil }
                }
                return write
            }
        }

        /// Drops this Mac's waiting writes; returns the pairings they were handed in for.
        func drop(instanceId: String) -> Set<String> {
            lock.withLock {
                writes = writes.filter { $0.key.instanceId != instanceId }
                return pairings.removeValue(forKey: instanceId) ?? []
            }
        }
    }

    private let pending = Pending()
    /// Pairings seen per Mac, and those an unpair purged: a late write never recreates their files.
    private var knownDevices: [String: Set<String>] = [:]
    private var revokedDevices: Set<String> = []
    /// Chats whose unreadable file couldn't be moved aside: it is never written over.
    private var stuckFiles: Set<AidenBotSessionKey> = []

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
        /// Absent in records written before fix round 4.
        let foreignSubmissionIDs: [String]?
        /// Revision 33; absent in records written before attachments.
        let attachments: [AidenAttachmentReference]?
    }

    /// One record decoded on its own, so a bad one costs only itself.
    private struct Lossy: Decodable {
        let record: Record?
        init(from decoder: Decoder) throws { record = try? Record(from: decoder) }
    }

    private struct Envelope: Encodable {
        let version: Int
        let instanceId: String
        let deviceId: String
        let botID: String
        let messages: [Record]
    }

    private struct ReadEnvelope: Decodable {
        let version: Int
        let instanceId: String
        let deviceId: String
        let botID: String
        let messages: [Lossy]
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

    /// The chat's messages, oldest first, and whether some couldn't be read back.
    /// One still unsent after 24 hours comes back as not sent; a taken one that
    /// old is the Mac's now. A file this build can't read (too large, damaged,
    /// or a newer version) is set aside beside it, never deleted, and the chat
    /// starts a new one.
    func restore(_ key: AidenBotSessionKey) async -> (messages: [AidenBotOutgoingMessage], unreadable: Bool) {
        let restored = readFile(key)
        await afterRead?()
        return restored
    }

    /// Tests only: awaited by `restore` once it has read the file, before it hands the messages back.
    private var afterRead: (@Sendable () async -> Void)?

    func setAfterRead(_ hook: (@Sendable () async -> Void)?) { afterRead = hook }

    private func readFile(_ key: AidenBotSessionKey) -> (messages: [AidenBotOutgoingMessage], unreadable: Bool) {
        knownDevices[key.instanceId, default: []].insert(key.deviceId)
        let url = fileURL(key)
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch CocoaError.fileReadNoSuchFile {
            return ([], false)
        } catch {
            // There, but it can't be opened: it is set aside unread, never written over.
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .degraded, code: .corruptData)
            setAside(url, for: key, keepingOriginal: false)
            return ([], true)
        }
        guard data.count <= 2 * Self.maxBytes else {
            // Never written this large.
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .degraded, code: .corruptData)
            setAside(url, for: key, keepingOriginal: false)
            return ([], true)
        }
        guard let envelope = try? JSONDecoder().decode(ReadEnvelope.self, from: data),
              envelope.version == 1, envelope.instanceId == key.instanceId,
              envelope.deviceId == key.deviceId, envelope.botID == key.botID else {
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .degraded, code: .corruptData)
            setAside(url, for: key, keepingOriginal: false)
            return ([], true)
        }
        let readable = envelope.messages.compactMap(\.record)
        let lostSome = readable.count != envelope.messages.count
        if lostSome {
            // The readable ones are written back; the file as it was is kept beside them.
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .degraded, code: .corruptData)
            setAside(url, for: key, keepingOriginal: true)
        }
        let cutoff = now().addingTimeInterval(-Self.lifetime)
        var changed = readable.count != envelope.messages.count
        var messages: [AidenBotOutgoingMessage] = []
        for record in readable {
            let expired = record.createdAt <= cutoff
            if expired, record.submissionId != nil {
                changed = true
                continue
            }
            var message = AidenBotOutgoingMessage(
                key: record.key,
                text: record.text,
                mode: record.mode,
                enqueuedWhileRunning: record.enqueuedWhileRunning,
                retryOf: record.retryOf,
                createdAt: record.createdAt,
                status: record.failed ? .failed : record.submissionId.map { .sent(submissionId: $0) } ?? .sending,
                attachments: record.attachments ?? []
            )
            message.request = record.request
            message.baseline = Set(record.baseline)
            message.connectionAttempts = record.connectionAttempts
            message.keepsKey = record.keepsKey
            message.foreignSubmissionIDs = Set(record.foreignSubmissionIDs ?? [])
            if expired, message.status == .sending {
                message.expire()
                changed = true
            }
            messages.append(message)
        }
        if changed { save(messages, for: key) }
        return (messages, lostSome)
    }

    /// Moves (or copies) a file this build can't fully read out of the chat's way.
    /// If it can't be moved, the chat never writes over it.
    private func setAside(_ url: URL, for key: AidenBotSessionKey, keepingOriginal: Bool) {
        let aside = url.deletingPathExtension().appendingPathExtension("\(UUID().uuidString).unreadable")
        do {
            if keepingOriginal {
                try fileManager.copyItem(at: url, to: aside)
            } else {
                try fileManager.moveItem(at: url, to: aside)
            }
        } catch {
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .failed, code: .unknown)
            if !keepingOriginal { stuckFiles.insert(key) }
        }
    }

    /// Hands a write to the store's own writer, which makes it in order with
    /// the other writes for this chat and with an unpair's purge. The store
    /// holds it until it is made, whatever happens to the model that sent it.
    nonisolated func submit(_ write: Write, for key: AidenBotSessionKey) {
        pending.put(write, for: key)
        Task { await self.drain(key) }
    }

    private func drain(_ key: AidenBotSessionKey) {
        guard let write = pending.take(key) else { return }
        knownDevices[key.instanceId, default: []].insert(key.deviceId)
        switch write {
        case .remove:
            remove(key)
        case let .save(messages):
            guard !revokedDevices.contains(Self.pairing(key)) else { return }
            save(messages, for: key)
        }
    }

    private static func pairing(_ key: AidenBotSessionKey) -> String { "\(key.instanceId)\u{1f}\(key.deviceId)" }

    private func save(_ messages: [AidenBotOutgoingMessage], for key: AidenBotSessionKey) {
        knownDevices[key.instanceId, default: []].insert(key.deviceId)
        let records = messages.map { message in
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
                keepsKey: message.keepsKey,
                // The entry it waited on goes with it too, as adopting it in memory does.
                foreignSubmissionIDs: message.foreignSubmissionIDs.union(message.echoSubmissionID.map { [$0] } ?? []).sorted(),
                attachments: message.attachments.isEmpty ? nil : message.attachments
            )
        }
        guard !stuckFiles.contains(key) else {
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .failed, code: .unknown)
            return
        }
        if records.isEmpty {
            remove(key)
            return
        }
        do {
            try write(records, for: key)
        } catch {
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .failed, code: .unknown)
        }
    }

    private func remove(_ key: AidenBotSessionKey) {
        try? fileManager.removeItem(at: fileURL(key))
    }

    /// This Mac was unpaired: its files go, writes still waiting are dropped,
    /// and its pairings are never written again.
    func purge(instanceId: String) {
        // Pairings with a write still waiting count too, though nothing of theirs is on disk yet.
        let waiting = pending.drop(instanceId: instanceId)
        for device in (knownDevices[instanceId] ?? []).union(waiting) {
            revokedDevices.insert(Self.pairing(AidenBotSessionKey(instanceId: instanceId, deviceId: device, botID: "")))
        }
        stuckFiles = stuckFiles.filter { $0.instanceId != instanceId }
        try? fileManager.removeItem(at: root.appending(path: digest(instanceId), directoryHint: .isDirectory))
    }

    private func write(_ records: [Record], for key: AidenBotSessionKey) throws {
        let data = try JSONEncoder().encode(Envelope(
            version: 1, instanceId: key.instanceId, deviceId: key.deviceId, botID: key.botID, messages: records
        ))
        guard data.count <= Self.maxBytes else {
            // The chat refuses messages past this budget, so this keeps the last good file.
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .failed, code: .unknown)
            return
        }
        try writeProtected(data, to: fileURL(key))
    }

    /// Protected until first unlock, and never in a backup: what waits to reach the Mac stays on this device.
    private func writeProtected(_ data: Data, to url: URL) throws {
        let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true, attributes: protection)
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        var backupRoot = root
        try? backupRoot.setResourceValues(excluded)
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: protection)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func fileURL(_ key: AidenBotSessionKey) -> URL {
        pairingDirectory(instanceId: key.instanceId, deviceId: key.deviceId)
            .appending(path: "\(digest(key.botID)).json")
    }

    private func pairingDirectory(instanceId: String, deviceId: String) -> URL {
        root.appending(path: digest(instanceId), directoryHint: .isDirectory)
            .appending(path: digest(deviceId), directoryHint: .isDirectory)
    }

    // MARK: A New Bot on its way (R15)

    /// The pairing's one New Bot on its way, beside its chats' outboxes, so it has their
    /// protection and goes with an unpair's purge. A chat file is named by a 64-character digest,
    /// so this name never meets one.
    private func pendingCreateURL(instanceId: String, deviceId: String) -> URL {
        pairingDirectory(instanceId: instanceId, deviceId: deviceId).appending(path: "create.json")
    }

    private struct CreateEnvelope: Codable {
        let version: Int
        let instanceId: String
        let deviceId: String
        let create: AidenBotPendingCreate
    }

    /// The New Bot an earlier launch left on its way for this pairing, if any. Past
    /// `AidenBotPendingCreate.replayWindow` its keys are no longer safe to send: one whose Bot the
    /// Mac made is the Mac's and is dropped; one that may have reached the Mac comes back (and stays
    /// on disk) with its answers and what it sent, but without its keys; one never sent stays as it
    /// is. Its answers are never silently gone. A file this build can't read is set aside.
    func pendingCreate(instanceId: String, deviceId: String) -> AidenBotPendingCreate? {
        knownDevices[instanceId, default: []].insert(deviceId)
        let url = pendingCreateURL(instanceId: instanceId, deviceId: deviceId)
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            return nil
        }
        // The Bot cache's date rules, so a made Bot reads back as the Mac sent it.
        guard let envelope = try? JSONDecoder.aidenRemote().decode(CreateEnvelope.self, from: data), envelope.version == 1,
              envelope.instanceId == instanceId, envelope.deviceId == deviceId else {
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .degraded, code: .corruptData)
            let aside = url.deletingPathExtension().appendingPathExtension("\(UUID().uuidString).unreadable")
            if (try? fileManager.moveItem(at: url, to: aside)) == nil {
                AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .failed, code: .unknown)
            }
            return nil
        }
        let create = envelope.create
        guard let frozen = create.frozen, !AidenBotPendingCreate.canReplay(sentAt: create.createdAt, now: now()) else {
            return create
        }
        guard frozen.created == nil else {
            try? fileManager.removeItem(at: url)
            return nil
        }
        let lapsed = AidenBotPendingCreate(input: create.input, frozen: nil, createdAt: create.createdAt, lapsed: frozen.request)
        savePendingCreate(lapsed, instanceId: instanceId, deviceId: deviceId)
        return lapsed
    }

    /// Keeps the pairing's New Bot on its way; never for a pairing an unpair purged. Returns
    /// whether it is on disk: a create that isn't must not go out.
    @discardableResult
    func savePendingCreate(_ create: AidenBotPendingCreate, instanceId: String, deviceId: String) -> Bool {
        knownDevices[instanceId, default: []].insert(deviceId)
        guard !revokedDevices.contains(Self.pairing(AidenBotSessionKey(instanceId: instanceId, deviceId: deviceId, botID: ""))) else {
            return false
        }
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(CreateEnvelope(version: 1, instanceId: instanceId, deviceId: deviceId, create: create))
            try writeProtected(data, to: pendingCreateURL(instanceId: instanceId, deviceId: deviceId))
            return true
        } catch {
            AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .failed, code: .unknown)
            return false
        }
    }

    func removePendingCreate(instanceId: String, deviceId: String) {
        try? fileManager.removeItem(at: pendingCreateURL(instanceId: instanceId, deviceId: deviceId))
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
/// A Bot request that didn't answer in time: it may still have reached the Mac,
/// so it is ambiguous and keeps its Idempotency-Key.
struct AidenBotRequestTimedOut: LocalizedError {
    var errorDescription: String? { "Your Mac didn’t answer in time." }
}

/// Runs `operation`, giving up after `limit`. The phone's URLSession waits for
/// connectivity for minutes; a chat action must not. The caller goes on time
/// even if the request ignores cancellation, and cancelling the caller
/// cancels the request.
func aidenBotWithin<T: Sendable>(
    _ limit: Duration,
    _ operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    let race = AidenBotRequestRace<T>()
    return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
            race.start(continuation, limit: limit, operation: operation)
        }
    } onCancel: {
        race.cancel()
    }
}

/// The first of the request, its time limit and the caller's cancellation wins.
private final class AidenBotRequestRace<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    private var work: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var cancelled = false

    /// The request and its timer are made in the same step as the cancelled
    /// check, so a cancel either comes first (nothing starts) or finds them.
    func start(_ continuation: CheckedContinuation<T, Error>, limit: Duration, operation: @escaping @Sendable () async throws -> T) {
        let alreadyCancelled = lock.withLock { () -> Bool in
            if cancelled { return true }
            self.continuation = continuation
            let work = Task { [weak self] in
                // Cancelled before it began: the request never goes out.
                guard !Task.isCancelled else { return }
                do {
                    let value = try await operation()
                    self?.finish(.success(value))
                } catch {
                    self?.finish(.failure(error))
                }
            }
            self.work = work
            self.timer = Task { [weak self] in
                try? await Task.sleep(for: limit)
                guard !Task.isCancelled else { return }
                // Publish the timeout before cancellation can make the work
                // throw CancellationError and discard a later queued choice.
                self?.finish(.failure(AidenBotRequestTimedOut()))
                work.cancel()
            }
            return false
        }
        if alreadyCancelled { continuation.resume(throwing: CancellationError()) }
    }

    func cancel() {
        let tasks = lock.withLock { () -> (Task<Void, Never>?, Task<Void, Never>?) in
            cancelled = true
            return (work, timer)
        }
        tasks.0?.cancel()
        tasks.1?.cancel()
        finish(.failure(CancellationError()))
    }

    private func finish(_ result: Result<T, Error>) {
        let (waiting, timer) = lock.withLock { () -> (CheckedContinuation<T, Error>?, Task<Void, Never>?) in
            defer { continuation = nil }
            return (continuation, self.timer)
        }
        guard let waiting else { return }
        timer?.cancel()
        waiting.resume(with: result)
    }
}

/// Revision 45 (`bot:images`): the bytes of images a Bot shared, kept while
/// its chat is open within a byte budget. The least recently drawn image goes
/// first; one that is dropped is read from the Mac again the next time it is
/// drawn. An image larger than the whole budget is never kept.
struct AidenSharedImageBytes {
    /// About four of the largest images the Mac sends (8 MiB each).
    static let defaultMaxBytes = 32 * 1024 * 1024

    let maxBytes: Int
    private var images: [String: Data] = [:]
    /// Least recently drawn first.
    private var order: [String] = []
    private(set) var byteCount = 0

    init(maxBytes: Int = Self.defaultMaxBytes) { self.maxBytes = maxBytes }

    mutating func data(for id: String) -> Data? {
        guard let data = images[id] else { return nil }
        order.removeAll { $0 == id }
        order.append(id)
        return data
    }

    mutating func insert(_ data: Data, for id: String) {
        remove(id)
        guard data.count <= maxBytes else { return }
        images[id] = data
        order.append(id)
        byteCount += data.count
        while byteCount > maxBytes, let oldest = order.first, oldest != id { remove(oldest) }
    }

    /// Drops every image the transcript no longer shows.
    mutating func retainOnly(_ ids: Set<String>) {
        for id in order where !ids.contains(id) { remove(id) }
    }

    mutating func removeAll() {
        images = [:]
        order = []
        byteCount = 0
    }

    private mutating func remove(_ id: String) {
        guard let data = images.removeValue(forKey: id) else { return }
        order.removeAll { $0 == id }
        byteCount -= data.count
    }
}

@MainActor
@Observable
final class AidenBotSessionModel {
    enum Action: Hashable, Sendable {
        case send, resume, dismiss, stop, answerQuestion, answerApproval, retry
        /// Revision 37 (`bot:handoffs`). Pausing is the Bot profile's own
        /// call, made without showing a pause the Mac hasn't confirmed.
        case answerHandoff, openHandoffOnMac, unpause
        /// Revision 42 (`bot:issues`): one action a "Needs you" card offers.
        case actIssue
    }

    let botID: String
    private let transport: any AidenBotSessionTransport

    private(set) var entries: [AidenBotSessionEntry] = []
    /// The streamed answer so far, as the Mac last sent it.
    private(set) var partial: String? {
        didSet { if partial != oldValue { pacePartialReveal() } }
    }
    /// What the chat draws of `partial`. It trails `partial` through
    /// `AidenStreamingRevealGate`, so a burst of text drains in smoothly
    /// instead of landing all at once. A snapshot, a rewrite or the end of
    /// the partial applies at once.
    private(set) var revealedPartial: String?
    @ObservationIgnored private var partialRevealTask: Task<Void, Never>?
    @ObservationIgnored private var partialHeldLastTick = false
    /// Off under Reduce Motion: each tick shows every whole word received.
    @ObservationIgnored var pacesPartialReveal = true
    private(set) var stateView: AidenBotSessionStateView?
    /// The A–E question the Bot is waiting on, or nil.
    private(set) var question: AidenRemoteBotQuestion?
    /// The tool approval the Bot is waiting on, or nil.
    private(set) var approval: AidenRemoteBotApproval?
    /// Revision 37 (`bot:handoffs`): the hand-off the Bot is waiting on, or nil.
    private(set) var handoff: AidenRemoteBotHandoff?
    /// Revision 42 (`bot:issues`): the Bot's "Needs you" cards, oldest first.
    private(set) var issues: [AidenRemoteBotIssue] = []
    /// The card an action is on its way for, so its buttons wait.
    private(set) var actingIssue: AidenRemoteBotIssue?
    /// What the Mac said after Finish on your Mac, for the hand-off it names.
    private(set) var handoffMacPrompt: AidenBotHandoffMacPrompt?
    private(set) var epoch: String?
    private(set) var seq = 0
    private(set) var hasLoaded = false
    private(set) var inFlight: Set<Action> = []
    private(set) var sentConnectionRequests: Set<String> = []
    /// Routine proposals with an answer on its way to the Mac, by proposal id.
    private(set) var respondingProposals: Set<String> = []
    /// Revision 30: the Mac announces `bot-activity-v1` and this phone holds `bot:activity`.
    var activitySupported = false
    /// Revision 33: the Mac announces `bot-attachments-v1`, so the composer offers its +.
    var attachmentsSupported = false
    /// Photos and files staged on the Mac for the next message, in the order they were added.
    private(set) var pendingAttachments: [AidenAttachmentReference] = []
    /// Attachments are being prepared or uploaded; the + and Send wait for them.
    private(set) var isAttaching = false
    /// The bytes of each staged photo, for its thumbnail; never written to disk.
    @ObservationIgnored private var attachmentImages: [String: Data] = [:]
    /// Revision 45: images the Bot shared, kept in memory within a budget while this chat is open; never written to disk.
    @ObservationIgnored private var sharedImages: AidenSharedImageBytes
    /// The Bot's Chat activity wording, from its detail.
    var wording: AidenBotChatActivityWording = .follows
    /// What the running turn is doing (revision 30), or nil.
    private(set) var activity: AidenBotSessionActivity?
    /// The person's messages waiting for the running turn (revision 30).
    private(set) var queued: [AidenBotQueuedMessage] = []
    /// The session stream dropped and is reconnecting.
    private(set) var isStreamDown = false
    /// Ends the feed connection `listen()` follows now; nil between connections.
    private var endFeedConnection: (() -> Void)?
    /// `reopenFeed()` ended the connection, so the next one opens at once.
    private var feedReopenRequested = false
    /// Messages sent from this phone the Mac's transcript doesn't show yet, oldest first.
    private(set) var outbox: [AidenBotOutgoingMessage] = [] {
        didSet { if outbox != oldValue { outboxDidChange() } }
    }
    /// Stop was pressed: the line says "Stopping" until the Mac speaks or the turn ends.
    private var stopIntent: Intent = .none
    /// Resume was pressed: the line says "Picking up where it left off" until the Mac speaks (R18).
    private var resumeIntent: Intent = .none
    var errorMessage: String?
    /// Unsent messages a previous launch left couldn't be read back. Shown until dismissed.
    var restoreNotice: String?

    @ObservationIgnored private var retainedKeys: [Action: UUID] = [:]
    @ObservationIgnored private let cache: AidenBotSessionCache
    @ObservationIgnored private let cacheKey: AidenBotSessionKey?
    @ObservationIgnored private let outboxStore: AidenBotOutboxStore?
    @ObservationIgnored private let retryDelays: [Duration]
    @ObservationIgnored private var retainedQuestion: (waitId: String, request: AidenQuestionRespondRequest, key: UUID)?
    @ObservationIgnored private var retainedApproval: (waitId: String, decision: AidenApprovalDecision, key: UUID)?
    @ObservationIgnored private var retainedHandoff: (waitId: String, request: AidenBotHandoffAnswerRequest, key: UUID)?
    @ObservationIgnored private var retainedHandoffOpen: (waitId: String, key: UUID)?
    /// Revision 42: the request UUID of a card action, kept per card and action
    /// so a retried tap replays the Mac's receipt instead of running twice.
    @ObservationIgnored private var retainedIssueActions: [String: (request: AidenBotIssueActRequest, key: UUID)] = [:]
    /// Called when a hand-off frame (never a snapshot) names a new wait, so
    /// the chat can alert a person who has left it (G24).
    @ObservationIgnored var onHandoffArrived: ((AidenRemoteBotHandoff) -> Void)?
    @ObservationIgnored private var connectionKeys: [String: UUID] = [:]
    /// The key of a proposal answer that failed ambiguously, by proposal id.
    @ObservationIgnored private var proposalKeys: [String: (decision: AidenBotRoutineProposalDecision, key: UUID)] = [:]
    /// Transcript entries that already stand for an outgoing message, for the life of an epoch:
    /// each entry settles one message, once.
    @ObservationIgnored private var claimedEntries: Set<String> = []
    @ObservationIgnored private var claimsEpoch: String?
    /// The run a Stop was pressed in, by its `startedAt`.
    @ObservationIgnored private var stopStartedAt: Int?
    /// The one task that sends the outbox; `release()` cancels it.
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private var backoffTask: Task<Void, Never>?
    @ObservationIgnored private var restoreTask: Task<Void, Never>?
    /// The previous launch's file has been read and merged; disk writes wait for it.
    @ObservationIgnored private var outboxRestored = false
    /// Bumped by each access-loss purge: a restore that started before one drops what it read.
    @ObservationIgnored private var purgeGeneration = 0
    @ObservationIgnored private var released = false
    @ObservationIgnored private let requestLimit: Duration
    @ObservationIgnored private let now: () -> Date
    /// How many times the Mac has written each field, so a failed action rolls
    /// back only what nothing newer replaced (R18).
    @ObservationIgnored private var stateWrites = 0
    @ObservationIgnored private var questionWrites = 0
    @ObservationIgnored private var approvalWrites = 0
    @ObservationIgnored private var handoffWrites = 0
    @ObservationIgnored private var issueWrites = 0

    private enum Intent { case none, requested, acknowledged }

    /// Tries a message gets on a connection that keeps failing before it says "Couldn’t send".
    static let maxConnectionAttempts = 3
    /// How long a taken message a snapshot didn't show stays before it goes (FR-m5).
    static let unheldGrace: TimeInterval = 10

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
        retryDelays: [Duration] = [.seconds(1), .seconds(4)],
        requestLimit: Duration = .seconds(12),
        sharedImageBudget: Int = AidenSharedImageBytes.defaultMaxBytes,
        now: @escaping () -> Date = { Date() }
    ) {
        self.botID = botID
        self.sharedImages = AidenSharedImageBytes(maxBytes: sharedImageBudget)
        self.transport = transport
        self.cacheKey = cacheKey
        self.cache = cache
        self.outboxStore = cacheKey == nil ? nil : outboxStore
        self.retryDelays = retryDelays
        self.requestLimit = requestLimit
        self.now = now
        if let cacheKey {
            entries = cache.transcript(for: cacheKey) ?? []
            let now = now()
            outbox = cache.adoptOutbox(for: cacheKey, owner: ObjectIdentifier(self)).map { Self.adopted($0, now: now) }
        }
    }

    /// A message another visit left keeps its key and body; what it saw then is
    /// stale, and one still unsent after 24 hours says it couldn't be sent.
    private static func adopted(_ message: AidenBotOutgoingMessage, now: Date) -> AidenBotOutgoingMessage {
        var message = message
        message.deferred = false
        message.dropEcho()
        message.queuedID = nil
        message.unheldSince = nil
        if message.status == .sending, isExpired(message, now: now) { message.expire() }
        return message
    }

    private static func isExpired(_ message: AidenBotOutgoingMessage, now: Date) -> Bool {
        now.timeIntervalSince(message.createdAt) >= AidenBotOutboxStore.lifetime
    }

    /// The chat closed: sending and retry timers stop at once, nothing more is
    /// written, and the unsent messages stay for the next visit. The store's own
    /// writer finishes a write already handed to it, so the next launch sees
    /// the latest outbox.
    func release() {
        released = true
        backoffTask?.cancel()
        flushTask?.cancel()
        sharedImages.removeAll()
    }

    var state: AidenBotSessionStateKind? { stateView?.state }
    var needsModel: Bool { state == .needsModel }
    var isRunning: Bool { state == .running }
    var isInterrupted: Bool { stateView?.interrupted == true }
    var isAccessBlocked: Bool { stateView?.blocked == .accessChanged }
    /// Revision 37: the person paused this Bot; nothing runs until it is resumed.
    var isPaused: Bool { state == .paused }
    /// The composer takes a message unless the Mac said this Bot can't take one
    /// (it needs a model, is unavailable or is paused). Before the first
    /// snapshot it waits in the outbox (R14).
    var canSend: Bool { !needsModel && state != .unavailable && state != .paused }

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

    /// The line can show, so its clock ticks (FR-m1): an idle chat runs no timer.
    var statusLineTicks: Bool { activitySupported && (isRunning || isAwaitingTurn) }

    /// The status line now (spec §12), or nil when it is hidden.
    func statusLine(nowMs: Int) -> AidenBotStatusLine? {
        guard statusLineTicks else { return nil }
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

    // MARK: Loading and the event stream

    /// `GET /session`, after the outbox a previous launch left is restored;
    /// returns once what waits in the outbox has gone out.
    func load() async {
        await restoreOutbox()
        _ = await fetchSnapshot()
        await runFlush()
    }

    /// `GET /session`. Returns false when no snapshot was loaded. A snapshot
    /// means the Mac is reachable, so the outbox goes out, without waiting here.
    private func fetchSnapshot() async -> Bool {
        do {
            let session = try await aidenBotWithin(requestLimit) { [transport, botID] in
                try await transport.botSession(botId: botID)
            }
            // Cleared first, so what the snapshot itself reports (a purged outbox) stays.
            errorMessage = nil
            apply(snapshot: session)
            return true
        } catch is CancellationError {
            return false
        } catch {
            // Losing access says so once ("That message wasn't sent"); nothing overwrites it.
            if Self.isAccessLoss(error) {
                purgeForAccessLoss()
                if errorMessage != nil { return false }
            }
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
                for try await event in openFeedConnection() {
                    failures = 0
                    isStreamDown = false
                    if await apply(event) == .closed { break }
                }
            } catch is CancellationError {
                endFeedConnection = nil
                return
            } catch {
                failures += 1
                if Self.isAccessLoss(error) { purgeForAccessLoss() }
            }
            endFeedConnection = nil
            guard !Task.isCancelled else { return }
            if feedReopenRequested {
                // Opened again for new grants: the next connection starts now, with its own snapshot.
                feedReopenRequested = false
                continue
            }
            // A dropped connection says "Reconnecting to your Mac" until the next one's first
            // frame. A clean close reconnects at once, so it doesn't flash the word.
            if failures > 0 { isStreamDown = true }
            let delay = min(30.0, 0.5 * pow(2.0, Double(min(failures, 6))))
            try? await Task.sleep(for: .seconds(failures == 0 ? 0.2 : delay))
        }
    }

    /// Opens the feed again: the Mac shapes a feed by this phone's grants when
    /// it opens (`aidenBotSessionFeedGrants`), so a grant negotiated after this
    /// chat's feed opened reaches it only on a new one, whose first frame is a
    /// snapshot. Unsent messages, their keys and any answer on its way are left
    /// as they are. Between connections it does nothing: the next one opens
    /// with the grants held then.
    func reopenFeed() {
        guard let end = endFeedConnection else { return }
        feedReopenRequested = true
        end()
    }

    /// One connection of the feed, which `reopenFeed()` can end.
    private func openFeedConnection() -> AsyncThrowingStream<AidenBotSessionEvent, Error> {
        let feed = transport.botSessionEvents(botId: botID)
        return AsyncThrowingStream { continuation in
            let forwarding = Task {
                do {
                    for try await event in feed { continuation.yield(event) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            // Ending this stream, or its listener's cancellation, closes the connection.
            continuation.onTermination = { _ in forwarding.cancel() }
            endFeedConnection = { continuation.finish() }
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
            questionWrites += 1
        case let .approval(next):
            approval = next
            approvalWrites += 1
        case let .activity(next):
            activity = next
            // The Mac's own word now stands for a Stop or Resume it has heard,
            // and a new run (another `startedAt`, or a first activity after a Stop
            // pressed before any) has nothing to stop.
            if stopIntent == .acknowledged || (next != nil && (stopStartedAt == nil || next?.startedAt != stopStartedAt)) {
                stopIntent = .none
            }
            // Any frame after the tap is the Mac's word on the resumed run.
            if next != nil { resumeIntent = .none }
        case let .queued(next):
            queued = next
        case let .handoff(next):
            let previous = handoff?.waitId
            handoff = next
            handoffWrites += 1
            if next?.waitId != handoffMacPrompt?.waitId { handoffMacPrompt = nil }
            if let next, next.waitId != previous { onHandoffArrived?(next) }
        case let .issues(next):
            issues = next
            issueWrites += 1
        case .closed:
            return .closed
        }
        reconcileOutbox(snapshot: false)
        scheduleFlush()
        return .applied
    }

    /// Follows a change to `partial`: growth is revealed tick by tick, and
    /// anything else (cleared, rewritten) is shown at once.
    private func pacePartialReveal() {
        guard let partial, let revealed = revealedPartial, partial.hasPrefix(revealed) else {
            if partial != nil, revealedPartial == nil {
                revealedPartial = ""
                schedulePartialRevealTick()
                return
            }
            revealPartialNow()
            return
        }
        if partial.count > revealed.count { schedulePartialRevealTick() }
    }

    private func revealPartialNow() {
        partialRevealTask?.cancel()
        partialRevealTask = nil
        partialHeldLastTick = false
        revealedPartial = partial
    }

    private func schedulePartialRevealTick() {
        guard partialRevealTask == nil else { return }
        partialRevealTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: AidenStreamingRevealGate.tick)
            guard let self, !Task.isCancelled else { return }
            self.partialRevealTask = nil
            self.revealPartialTick()
        }
    }

    private func revealPartialTick() {
        guard let partial, let revealed = revealedPartial, partial.hasPrefix(revealed) else {
            revealPartialNow()
            return
        }
        let pending = String(partial.dropFirst(revealed.count))
        let (shown, held) = AidenStreamingRevealGate.cut(
            pending,
            heldPreviousTick: partialHeldLastTick,
            paced: pacesPartialReveal
        )
        partialHeldLastTick = !held.isEmpty
        if !shown.isEmpty { revealedPartial = revealed + shown }
        if !held.isEmpty { schedulePartialRevealTick() }
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
        // A snapshot is the state to show now, not new text to reveal.
        revealPartialNow()
        setStateView(session.stateView)
        question = session.question
        approval = session.approval
        handoff = session.handoff
        issues = session.issues
        questionWrites += 1
        approvalWrites += 1
        handoffWrites += 1
        issueWrites += 1
        if session.handoff?.waitId != handoffMacPrompt?.waitId { handoffMacPrompt = nil }
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
        stateWrites += 1
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
    /// and settles on its receipt. On a Mac that sends its queue, a taken message
    /// that a snapshot shows neither queued nor echoed is marked unheld, and goes
    /// once `unheldGrace` has passed with nothing holding it (FR-m5): the queued
    /// list caps at 20 and the Mac leaves out what it can't classify, so one
    /// snapshot alone never drops it. Seen again, it is held again.
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
                claimedEntries.insert(echo.id)
                guard message.status == .sending else { continue }
                message.echoed = true
                message.echoEntryID = echo.id
                message.echoSubmissionID = echo.submissionId
            }
            if !message.echoed {
                if let id = message.submissionId {
                    if queuedIDs.contains(id) {
                        message.queuedID = id
                        message.unheldSince = nil
                    } else if activitySupported {
                        // Taken, not queued and not in the transcript: nothing on the Mac shows it.
                        if let since = message.unheldSince {
                            if now().timeIntervalSince(since) >= Self.unheldGrace { continue }
                        } else if snapshot {
                            message.unheldSince = now()
                        }
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
    private func echoEntry(for message: AidenBotOutgoingMessage, owned: Set<String>) -> AidenBotSessionMessage? {
        var byText: AidenBotSessionMessage?
        for entry in entries {
            guard case let .message(sent) = entry, sent.role == .user, !claimedEntries.contains(sent.id) else { continue }
            if let id = message.submissionId, sent.submissionId == id { return sent }
            guard byText == nil, !message.baseline.contains(sent.id),
                  sent.text.trimmingCharacters(in: .whitespacesAndNewlines) == message.text else { continue }
            if let theirs = sent.submissionId {
                // An entry that names its submission belongs to that submission. Only a request
                // still unsettled may wait on one (its receipt says whose it is); a failed one
                // never takes it.
                if message.submissionId != nil || message.status == .failed || owned.contains(theirs)
                    || message.foreignSubmissionIDs.contains(theirs) {
                    continue
                }
            }
            byText = sent
        }
        return byText
    }

    // MARK: The outbox

    /// Writes the outbox to the cache and disk while this model owns the chat;
    /// an older model left open never overwrites a newer one's messages. The
    /// store keeps one ordered writer per chat.
    private func outboxDidChange() {
        guard let cacheKey, !released,
              cache.storeOutbox(outbox, for: cacheKey, owner: ObjectIdentifier(self)) else { return }
        // A write before the restore would replace the previous launch's file. The first change starts the
        // restore, which writes the merged outbox once.
        guard outboxRestored else { startRestore(); return }
        outboxStore?.submit(.save(outbox), for: cacheKey)
    }

    /// The one write the restore owes: the merged outbox, even if the chat closed while the file was read,
    /// since messages sent before the restore exist nowhere else.
    private func writeRestoredOutbox(_ cacheKey: AidenBotSessionKey) {
        guard let outboxStore, !outbox.isEmpty,
              cache.storeOutbox(outbox, for: cacheKey, owner: ObjectIdentifier(self)) else { return }
        outboxStore.submit(.save(outbox), for: cacheKey)
    }

    /// Adds what a previous launch left on disk, once, before the first snapshot sends it.
    func restoreOutbox() async {
        guard outboxStore != nil else { return }
        startRestore()
        await restoreTask?.value
    }

    /// Starts the one restore of this chat's file, unless it has started. Until it has merged the file,
    /// nothing is written to disk.
    private func startRestore() {
        guard restoreTask == nil, !outboxRestored, let cacheKey, let outboxStore else { return }
        let generation = purgeGeneration
        restoreTask = Task { [weak self] in
            let (stored, unreadable) = await outboxStore.restore(cacheKey)
            // Access was lost while the file was read: what it held stays purged, in memory and on disk.
            guard let self, !Task.isCancelled, generation == self.purgeGeneration else { return }
            if unreadable { self.restoreNotice = AidenBotSessionCopy.outboxUnrestorable }
            let known = Set(self.outbox.map(\.key))
            let now = self.now()
            let added = stored.filter { !known.contains($0.key) }.map { Self.adopted($0, now: now) }
            if !added.isEmpty {
                // Silent until the restore is marked done below, so this merge is written once.
                self.outbox = (added + self.outbox).sorted { $0.createdAt < $1.createdAt }
            }
            self.outboxRestored = true
            self.writeRestoredOutbox(cacheKey)
        }
    }

    /// The Mac is reachable again: deferred messages get another try.
    private func wakeOutbox() {
        for index in outbox.indices where outbox[index].deferred { outbox[index].deferred = false }
        scheduleFlush()
    }

    /// Starts the one task that sends the outbox, unless it already runs.
    private func scheduleFlush() {
        guard !released, flushTask == nil, nextToDeliver() != nil else { return }
        flushTask = Task { [weak self] in await self?.flushOutbox() }
    }

    /// Sends the outbox and waits for it; cancelling the caller cancels the sending.
    private func runFlush() async {
        scheduleFlush()
        guard let task = flushTask else { return }
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }

    /// The oldest unsettled message, unless it waits for a retry: nothing
    /// overtakes it, so messages reach the Mac in the order they were sent.
    private func nextToDeliver() -> UUID? {
        guard isConnected, !released, let head = outbox.first(where: { $0.status == .sending }), !head.deferred else {
            return nil
        }
        return head.key
    }

    /// The sending loop of `flushTask`. It clears its handle in the same step as
    /// its last check, so a message added later starts a new one.
    private func flushOutbox() async {
        while let key = nextToDeliver(), !Task.isCancelled {
            await deliver(key)
        }
        flushTask = nil
    }

    private func deliver(_ key: UUID) async {
        guard let index = outbox.firstIndex(where: { $0.key == key }) else { return }
        // A paused Bot (revision 37) takes nothing either, as on Android: the
        // message waits as "Couldn't send · Try again".
        if !canSend {
            // A frozen request may have reached the Mac: Try again replays its key.
            outbox[index].status = .failed
            outbox[index].keepsKey = outbox[index].request != nil
            releaseEcho(at: index)
            return
        }
        if Self.isExpired(outbox[index], now: now()) {
            // Unsent for a day: it says so instead of going out late.
            releaseEcho(at: index)
            outbox[index].expire()
            return
        }
        if outbox[index].request == nil,
           outbox[index].attachments.contains(where: { $0.expiresAt <= now() }) {
            // Never sent, and its uploads are gone from the Mac: sending would only be
            // refused, so it asks for them again instead.
            releaseEcho(at: index)
            outbox[index].status = .failed
            outbox[index].keepsKey = false
            outbox[index].attachmentsGone = true
            return
        }
        let request: AidenBotMessageRequest
        if let frozen = outbox[index].request {
            request = frozen
        } else {
            let whenBusy = offersBusyModes ? outbox[index].mode : nil
            guard let made = try? AidenBotMessageRequest(
                text: outbox[index].text,
                whenBusy: whenBusy,
                attachmentIds: outbox[index].attachments.map(\.id)
            ) else {
                outbox[index].status = .failed
                return
            }
            request = made
            outbox[index].request = made
            outbox[index].baseline = Set(entries.map(\.id))
        }
        let isRetry = outbox[index].retryOf != nil
        let writes = stateWrites
        inFlight.insert(.send)
        if isRetry { inFlight.insert(.retry) }
        defer {
            inFlight.remove(.send)
            inFlight.remove(.retry)
        }
        do {
            let receipt = try await aidenBotWithin(requestLimit) { [transport, botID] in
                try await transport.sendBotMessage(botId: botID, request: request, idempotencyKey: key)
            }
            if stateWrites == writes { setStateView(receipt.stateView) }
            guard let current = outbox.firstIndex(where: { $0.key == key }) else { return }
            if outbox[current].echoed, let echoID = outbox[current].echoSubmissionID, echoID != receipt.submissionId {
                // The entry it waited on was another submission's: give it back.
                releaseEcho(at: current)
            }
            if outbox[current].echoed {
                outbox.remove(at: current)
            } else {
                outbox[current].status = .sent(submissionId: receipt.submissionId)
                outbox[current].deferred = false
                outbox[current].keepsKey = false
            }
            reconcileOutbox(snapshot: false)
        } catch {
            // A closed chat, or a cancelled send (leaving the chat), leaves the message
            // as it was, with no try spent, for the next visit or connection. The
            // cancelled request may still have arrived.
            guard !released, !(error is CancellationError), !Task.isCancelled,
                  let current = outbox.firstIndex(where: { $0.key == key }) else { return }
            if Self.isAccessLoss(error) {
                purgeForAccessLoss()
                return
            }
            guard Self.messageFailureIsAmbiguous(error) else {
                // Refused outright (R22): the Mac answered this key without running it,
                // and replays that answer for as long as it keeps the key, so Try again
                // is a new request with a new key, as on Android.
                outbox[current].status = .failed
                outbox[current].keepsKey = false
                if !outbox[current].attachments.isEmpty, Self.isLostAttachment(error) {
                    outbox[current].attachmentsGone = true
                }
                releaseEcho(at: current)
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
            } else if outbox[current].echoed, outbox[current].echoSubmissionID == nil {
                // The Mac's transcript already shows it.
                outbox.remove(at: current)
            } else {
                // Out of tries. An entry naming another submission isn't this one:
                // it says "Couldn’t send", and Try again keeps the key.
                releaseEcho(at: current)
                outbox[current].status = .failed
            }
        }
    }

    /// Gives the entry a message waited on back to the other messages.
    private func releaseEcho(at index: Int) {
        if let entry = outbox[index].echoEntryID { claimedEntries.remove(entry) }
        outbox[index].dropEcho()
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

    /// The Mac refused the message because a staged upload expired or was already used.
    private static func isLostAttachment(_ error: Error) -> Bool {
        guard case let AidenRemoteClientError.server(_, body) = error else { return false }
        return ["handle_expired", "handle_invalid"].contains(body.code.rawValue)
    }

    /// Whether a message request may have reached the Mac. A request the Mac is
    /// still working on (`409 idempotency_in_flight`) keeps its key too.
    private static func messageFailureIsAmbiguous(_ error: Error) -> Bool {
        if case let AidenRemoteClientError.server(409, body) = error, body.code.rawValue == "idempotency_in_flight" {
            return true
        }
        return aidenBotSessionFailureIsAmbiguous(error)
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
        purgeGeneration += 1
        restoreTask?.cancel()
        outbox = []
        if let cacheKey {
            cache.purge(cacheKey)
            outboxStore?.submit(.remove, for: cacheKey)
        }
        // Nothing is left on disk to wait for: later messages are written as usual.
        outboxRestored = true
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
        let mark = questionWrites
        question = nil
        inFlight.insert(.answerQuestion)
        defer { inFlight.remove(.answerQuestion) }
        do {
            _ = try await aidenBotWithin(requestLimit) { [transport, botID] in
                try await transport.answerBotQuestion(botId: botID, waitId: waitId, request: response, idempotencyKey: key)
            }
            retainedQuestion = nil
        } catch {
            if questionWrites == mark { question = shown }
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
        let mark = approvalWrites
        approval = nil
        inFlight.insert(.answerApproval)
        defer { inFlight.remove(.answerApproval) }
        do {
            _ = try await aidenBotWithin(requestLimit) { [transport] in
                try await transport.respondToApproval(id: waitId, decision: decision, scope: nil, idempotencyKey: key)
            }
            retainedApproval = nil
        } catch {
            if !aidenBotSessionFailureIsAmbiguous(error) { retainedApproval = nil }
            if case let AidenRemoteClientError.server(_, body) = error,
               ["approval_expired", "approval_already_resolved"].contains(body.code.rawValue) {
                return
            }
            if approvalWrites == mark { approval = current }
            if error is CancellationError { return }
            errorMessage = "That answer wasn’t sent. Please try again."
        }
    }

    // MARK: Bot issues (revision 42, `bot:issues`)

    /// The cards the chat shows: the host's open issues. A settled card is
    /// kept out of the transcript, as the Mac shows it as a quiet line.
    var openIssues: [AidenRemoteBotIssue] { issues.filter { !$0.resolved } }

    var canActOnIssue: Bool {
        hasLoaded && !inFlight.contains(.actIssue)
    }

    /// The button label for one action a card offers.
    static func issueActionTitle(_ action: AidenBotIssueAction) -> String {
        switch action.kind {
        case .openChat: AidenBotSessionCopy.issueOpenChat
        case .resumeRoutine: AidenBotSessionCopy.issueResumeRoutine
        case .stopRun: AidenBotSessionCopy.issueStop
        case .keepWaiting: AidenBotSessionCopy.issueKeepWaiting
        }
    }

    /// Carries out one action a card offers (revision 42). The Mac settles the
    /// card and sends the new list; a settling action drops the card here at
    /// once and puts it back if the request didn't reach the Mac (R18). The
    /// request UUID survives an ambiguous failure, so retrying the same tap
    /// replays the Mac's receipt; another action is a new request.
    /// `open_chat` opens nothing new on a phone (it is already the Bot's
    /// chat): the Mac is told so its own view agrees, and the card stays.
    /// Returns false when the action was refused or not sent.
    @discardableResult
    func actOnIssue(_ issue: AidenRemoteBotIssue, action: AidenBotIssueAction) async -> Bool {
        guard canActOnIssue, !issue.resolved,
              issues.contains(where: { $0.id == issue.id && !$0.resolved }),
              issue.actions.contains(where: { $0 == action }),
              let request = try? AidenBotIssueActRequest(action: action) else { return false }
        let settles = action.kind != .openChat
        let actionKey = "\(issue.id):\(action.kind.rawValue):\(action.routineId ?? "")"
        let key: UUID
        if let retained = retainedIssueActions[actionKey], retained.request == request {
            key = retained.key
        } else {
            key = UUID()
            retainedIssueActions[actionKey] = (request, key)
        }
        let mark = issueWrites
        let index = issues.firstIndex { $0.id == issue.id }
        actingIssue = issue
        inFlight.insert(.actIssue)
        defer {
            inFlight.remove(.actIssue)
            if actingIssue?.id == issue.id { actingIssue = nil }
        }
        if settles { issues.removeAll { $0.id == issue.id } }
        /// Put the card back where it was when the action did not reach the Mac.
        func restore() {
            guard settles, issueWrites == mark, !issues.contains(where: { $0.id == issue.id }) else { return }
            if let index, index <= issues.count {
                issues.insert(issue, at: index)
            } else {
                issues.append(issue)
            }
        }
        do {
            let receipt = try await aidenBotWithin(requestLimit) { [transport, botID] in
                try await transport.actOnBotIssue(
                    botId: botID,
                    issueId: issue.id,
                    request: request,
                    idempotencyKey: key
                )
            }
            retainedIssueActions[actionKey] = nil
            // `not_open` means nothing waits any more: the card stays gone.
            if receipt.result == .notOpen, settles { issueWrites += 1 }
            return true
        } catch {
            if !aidenBotSessionFailureIsAmbiguous(error) { retainedIssueActions[actionKey] = nil }
            if case let AidenRemoteClientError.server(_, body) = error,
               ["operation_stale", "invalid_request"].contains(body.code.rawValue) {
                restore()
                errorMessage = AidenBotSessionCopy.issueStale
                return false
            }
            restore()
            if error is CancellationError { return false }
            errorMessage = AidenBotSessionCopy.issueNotSent
            return false
        }
    }

    // MARK: Hand-offs (revision 37, `bot:handoffs`)

    var canAnswerHandoff: Bool {
        hasLoaded && handoff != nil && !inFlight.contains(.answerHandoff)
    }

    /// While a step (not a sign-in) waits, the composer's text is its note:
    /// Send marks the step done (desktop parity). A card that takes no note
    /// (revision 40) holds the composer instead (`composerHeldForNoNote`).
    var composerAnswersHandoff: Bool { handoff?.kind == .action && handoff?.takesNote != false }

    /// Revision 40: a password-or-code card waits. A code typed in the
    /// composer would reach the Bot, so the composer waits for Done or Skip.
    var composerHeldForNoNote: Bool { handoff?.kind == .action && handoff?.takesNote == false }

    /// Answers the waiting hand-off: Done or Skip, with an optional note. A
    /// sign-in is finished on the Mac, so a phone can only skip it. The card
    /// goes at once and comes back with an error if the answer didn't reach
    /// the Mac (R18). The request UUID survives an ambiguous failure, so
    /// retrying the same answer replays the Mac's receipt; another answer is a
    /// new request. When nothing waits any more (`handoff_expired`), the card
    /// stays gone. Returns false when the answer was refused or not sent.
    @discardableResult
    func answerHandoff(_ outcome: AidenBotHandoffOutcome, note rawNote: String? = nil) async -> Bool {
        guard canAnswerHandoff, let shown = handoff else { return false }
        if outcome == .done, shown.kind == .signIn { return false }
        let trimmed = rawNote?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // A card that takes no note is answered bare: a code typed as a note never leaves the phone.
        if !trimmed.isEmpty, !shown.takesNote { return false }
        guard trimmed.unicodeScalars.count <= AidenBotHandoffWire.maxNoteLength,
              let request = try? AidenBotHandoffAnswerRequest(outcome: outcome, note: trimmed.isEmpty ? nil : trimmed) else {
            errorMessage = AidenBotSessionCopy.handoffNoteTooLong
            return false
        }
        let waitId = shown.waitId
        let key: UUID
        if let retainedHandoff, retainedHandoff.waitId == waitId, retainedHandoff.request == request {
            key = retainedHandoff.key
        } else {
            key = UUID()
            retainedHandoff = (waitId, request, key)
        }
        let mark = handoffWrites
        handoff = nil
        inFlight.insert(.answerHandoff)
        defer { inFlight.remove(.answerHandoff) }
        do {
            _ = try await aidenBotWithin(requestLimit) { [transport, botID] in
                try await transport.answerBotHandoff(botId: botID, waitId: waitId, request: request, idempotencyKey: key)
            }
            retainedHandoff = nil
            return true
        } catch {
            if !aidenBotSessionFailureIsAmbiguous(error) { retainedHandoff = nil }
            if case let AidenRemoteClientError.server(_, body) = error, body.code.rawValue == "handoff_expired" {
                // Answered elsewhere or withdrawn: the card stays gone.
                errorMessage = AidenBotSessionCopy.handoffExpired
                return false
            }
            if handoffWrites == mark { handoff = shown }
            if error is CancellationError { return false }
            errorMessage = AidenBotSessionCopy.handoffNotSent
            return false
        }
    }

    /// Send while a step waits: the composer's text is the step's note, and
    /// Send marks the step done (desktop parity). Photos and files staged
    /// before the card came can't go with a note, so Send says so and leaves
    /// them staged for the next message. Like the card's own Done and Skip, it
    /// needs the Mac connected. Returns false when nothing was answered.
    @discardableResult
    func answerHandoffFromComposer(_ text: String, connected: Bool) async -> Bool {
        guard composerAnswersHandoff, connected, canAnswerHandoff else { return false }
        if !pendingAttachments.isEmpty {
            errorMessage = pendingAttachments.contains { $0.kind == .image }
                ? AidenBotSessionCopy.handoffPhotosWait
                : AidenBotSessionCopy.handoffFilesWait
            return false
        }
        guard !AidenBotHandoffWire.isBlank(text) else { return false }
        return await answerHandoff(.done, note: text)
    }

    /// Finish on your Mac: asks the Mac to bring the hand-off forward. The
    /// card stays; it says whether the Mac showed it.
    func finishHandoffOnMac() async {
        guard hasLoaded, let shown = handoff, !inFlight.contains(.openHandoffOnMac) else { return }
        let waitId = shown.waitId
        let key: UUID
        if let retained = retainedHandoffOpen, retained.waitId == waitId {
            key = retained.key
        } else {
            key = UUID()
            retainedHandoffOpen = (waitId, key)
        }
        inFlight.insert(.openHandoffOnMac)
        defer { inFlight.remove(.openHandoffOnMac) }
        do {
            let receipt = try await aidenBotWithin(requestLimit) { [transport, botID] in
                try await transport.openBotHandoffOnMac(botId: botID, waitId: waitId, idempotencyKey: key)
            }
            retainedHandoffOpen = nil
            if handoff?.waitId == waitId {
                handoffMacPrompt = AidenBotHandoffMacPrompt(waitId: waitId, opened: receipt.opened, signIn: shown.kind == .signIn)
            }
        } catch {
            if !aidenBotSessionFailureIsAmbiguous(error) { retainedHandoffOpen = nil }
            if error is CancellationError { return }
            if case let AidenRemoteClientError.server(_, body) = error, body.code.rawValue == "handoff_expired" {
                if handoff?.waitId == waitId { handoff = nil }
                errorMessage = AidenBotSessionCopy.handoffExpired
                return
            }
            errorMessage = "That didn’t work. Please try again."
        }
    }

    /// Resume on a paused Bot. The Mac's answer stands: a reply the pause cut
    /// short comes back interrupted, with its own Resume and Dismiss.
    func unpause() async {
        guard isPaused, !inFlight.contains(.unpause) else { return }
        await perform(.unpause) { [transport, botID] key in
            try await transport.unpauseBot(botId: botID, idempotencyKey: key)
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
        // The staged photos and files go with it, and only with it.
        let attachments = pendingAttachments
        guard canSend, !isAttaching,
              (try? AidenBotMessageRequest(text: text, attachmentIds: attachments.map(\.id))) != nil,
              enqueue(text, mode: offersBusyModes ? mode ?? .queue : nil, retryOf: nil, attachments: attachments) else { return false }
        pendingAttachments = []
        for attachment in attachments { attachmentImages[attachment.id] = nil }
        await runFlush()
        return true
    }

    // MARK: Attachments (revision 33)

    /// Room for more photos and files on the next message.
    var attachmentCapacity: Int {
        AidenAttachmentPickerPolicy.availableCapacity(pendingCount: pendingAttachments.count)
    }

    /// Whether the + can open now: the Mac takes attachments and nothing is uploading.
    var canAttach: Bool { attachmentsSupported && canSend && handoff == nil && !isAttaching && attachmentCapacity > 0 }

    /// Prepares each picked item and stages it on the Mac, in order, up to the
    /// room left. Returns how many couldn't be added; the rest stay ready to send.
    @discardableResult
    func attach(_ items: [@MainActor () async throws -> AidenAttachmentUpload]) async -> Int {
        guard canAttach, !items.isEmpty else { return items.count }
        isAttaching = true
        defer { isAttaching = false }
        var failures = max(0, items.count - attachmentCapacity)
        for prepare in items.prefix(attachmentCapacity) {
            if Task.isCancelled || released { return items.count }
            do {
                let upload = try await prepare()
                // A photo can take longer than a message on a slow connection.
                let reference = try await aidenBotWithin(max(requestLimit, .seconds(60))) { [transport, botID] in
                    try await transport.uploadBotAttachment(botId: botID, upload: upload)
                }
                guard reference.isValid(now: now()) else { throw AidenRemoteClientError.invalidResponse }
                if case let .image(_, _, data) = upload { attachmentImages[reference.id] = data }
                pendingAttachments.append(reference)
            } catch let error where aidenIsCancellation(error) {
                return items.count
            } catch {
                failures += 1
            }
        }
        if failures > 0 {
            errorMessage = failures == 1
                ? "One attachment couldn’t be added. The others are ready to send."
                : "\(failures) attachments couldn’t be added. The others are ready to send."
        }
        return failures
    }

    /// Takes a staged photo or file off the next message, and off the Mac.
    func removeAttachment(_ id: String) async {
        guard pendingAttachments.contains(where: { $0.id == id }) else { return }
        pendingAttachments.removeAll { $0.id == id }
        attachmentImages[id] = nil
        // Best effort: an upload left behind expires on the Mac within minutes.
        try? await transport.removeBotAttachment(botId: botID, attachmentId: id)
    }

    /// A staged photo's bytes, for its thumbnail in the composer.
    func attachmentImageData(_ id: String) -> Data? {
        attachmentImages[id]
    }

    static let outboxFull = "Too many messages are waiting. Send or remove some, then try again."

    /// What a message takes on disk at most: its text twice as JSON, its baseline ids, and fields.
    private static func storedBytes(_ text: String, baseline: Int) -> Int {
        let encoded = (try? JSONEncoder().encode(text).count) ?? text.utf8.count * 6
        return 2 * encoded + baseline * (AidenRemoteProtocol.maxBotIdentifierLength + 4) + 1_024
    }

    /// Adds a message, unless the chat already holds as many as it can keep: then it says so.
    private func enqueue(
        _ text: String,
        mode: AidenStreamInputMode?,
        retryOf: String?,
        attachments: [AidenAttachmentReference] = []
    ) -> Bool {
        let bytes = outbox.reduce(Self.storedBytes(text, baseline: entries.count)) {
            $0 + Self.storedBytes($1.text, baseline: $1.baseline.count)
        }
        guard outbox.count < AidenBotOutboxStore.maxMessages, bytes <= AidenBotOutboxStore.maxBytes else {
            errorMessage = Self.outboxFull
            return false
        }
        outbox.append(AidenBotOutgoingMessage(
            key: UUID(),
            text: text,
            mode: mode,
            enqueuedWhileRunning: isRunning,
            retryOf: retryOf,
            createdAt: now(),
            status: .sending,
            attachments: attachments
        ))
        return true
    }

    /// Try again on a message that couldn't be sent. A message the Mac may hold
    /// keeps its key, so the Mac replays its receipt instead of taking it twice.
    @discardableResult
    func retrySend(_ id: String) async -> Bool {
        guard let index = outbox.firstIndex(where: { $0.id == id }), outbox[index].status == .failed,
              !attachmentsExpired(outbox[index]) else { return false }
        if !outbox[index].keepsKey {
            outbox[index].key = UUID()
            outbox[index].request = nil
        }
        outbox[index] = AidenBotOutgoingMessage(
            key: outbox[index].key,
            text: outbox[index].text,
            mode: outbox[index].mode,
            enqueuedWhileRunning: outbox[index].enqueuedWhileRunning,
            retryOf: outbox[index].retryOf,
            // Try again starts its day again.
            createdAt: now(),
            status: .sending,
            attachments: outbox[index].attachments,
            request: outbox[index].request,
            baseline: outbox[index].baseline,
            foreignSubmissionIDs: outbox[index].foreignSubmissionIDs,
            keepsKey: outbox[index].keepsKey
        )
        await runFlush()
        return true
    }

    /// Whether a failed message can't go again because its photos and files are
    /// gone from the Mac. One that may have reached the Mac keeps its key and
    /// is tried as it was, so a sent message is never sent twice.
    func attachmentsExpired(_ message: AidenBotOutgoingMessage) -> Bool {
        guard message.status == .failed, !message.keepsKey, !message.attachments.isEmpty else { return false }
        return message.attachmentsGone || message.attachments.contains { $0.expiresAt <= now() }
    }

    /// Takes a message whose uploads expired off the list and returns the
    /// composer's new text: its words ahead of anything already typed, so
    /// neither is lost and the files can be attached again.
    func reattach(_ id: String, into draft: String) -> String? {
        guard let index = outbox.firstIndex(where: { $0.id == id }), attachmentsExpired(outbox[index]) else { return nil }
        let words = outbox.remove(at: index).text
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.isEmpty { return words }
        if words.isEmpty { return draft }
        return words + "\n\n" + draft
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
        guard enqueue(text, mode: offersBusyModes ? .queue : nil, retryOf: turn.id) else { return false }
        await runFlush()
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
        let writes = stateWrites
        if let optimistic { stateView = optimistic }
        inFlight.insert(action)
        defer { inFlight.remove(action) }
        do {
            let view = try await aidenBotWithin(requestLimit) { try await request(key) }
            // The Mac's answer stands unless it has written the state again since.
            if stateWrites == writes { setStateView(view) }
            retainedKeys[action] = nil
            return true
        } catch {
            // Only what the Mac hasn't written since the tap goes back.
            if optimistic != nil, stateWrites == writes { stateView = previous }
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
            let result = try await aidenBotWithin(requestLimit) { [transport, botID] in
                try await transport.respondToBotRoutineProposal(
                    botId: botID,
                    proposalId: proposalId,
                    request: AidenBotRoutineProposalRespondRequest(decision: decision),
                    idempotencyKey: key
                )
            }
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

    /// Revision 45 (`bot:images`): the bytes of an image the Bot shared, or nil
    /// when the Mac can't send it (it left the chat, or the phone is offline).
    /// Images are kept while this chat is open, within a byte budget and only
    /// while the transcript still shows them; one that was dropped, or whose
    /// read failed, is read again the next time it is drawn.
    func sharedImageData(entryId: String) async -> Data? {
        if let cached = sharedImages.data(for: entryId) { return cached }
        guard shownSharedImageIDs.contains(entryId) else { return nil }
        guard let data = try? await aidenBotWithin(requestLimit, { [transport, botID] in
            try await transport.botSessionImage(botId: botID, entryId: entryId)
        }) else { return nil }
        sharedImages.retainOnly(shownSharedImageIDs)
        sharedImages.insert(data, for: entryId)
        return data
    }

    /// Tests only: bytes of shared images held now.
    var sharedImageByteCount: Int { sharedImages.byteCount }

    private var shownSharedImageIDs: Set<String> {
        Set(entries.compactMap { entry in
            if case let .sharedImage(image) = entry { return image.id }
            return nil
        })
    }

    func requestConnection(pluginId: String) async {
        guard !sentConnectionRequests.contains(pluginId),
              let request = try? AidenBotConnectionRequest(pluginId: pluginId) else { return }
        let key = connectionKeys[pluginId] ?? UUID()
        connectionKeys[pluginId] = key
        sentConnectionRequests.insert(pluginId)
        do {
            _ = try await aidenBotWithin(requestLimit) { [transport, botID] in
                try await transport.requestBotConnection(botId: botID, request: request, idempotencyKey: key)
            }
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
