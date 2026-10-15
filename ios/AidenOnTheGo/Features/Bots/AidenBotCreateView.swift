import Observation
import SwiftUI

/// What New Bot was asked for, kept so a failed create can be tried again as it was.
struct AidenBotCreateInput: Codable, Equatable, Sendable {
    var name: String
    var purpose: String
    /// The model the person picked; nil uses the Mac's recommended one.
    var draft: AidenBotEditorDraft?
}

/// A New Bot on its way, kept on disk per pairing (in `AidenBotOutboxStore`, with the
/// outbox's protection and purge) so a relaunch mid-create never loses it (R15, R17).
struct AidenBotPendingCreate: Codable, Equatable, Sendable {
    /// The request as it first went out, with its keys: a retry sends exactly this.
    struct Frozen: Codable, Equatable, Sendable {
        let request: AidenBotCreateRequest
        /// The model the request was built from, for the chat step.
        let draft: AidenBotEditorDraft?
        let key: UUID
        let chatKey: UUID
        /// The Bot, once the Mac made it.
        var created: AidenBotDetail?
    }

    let input: AidenBotCreateInput
    /// Nil until the request was built: nothing of it can have reached the Mac.
    var frozen: Frozen?
    /// When this ask was made, or its request built: the replay window starts here.
    let createdAt: Date
    /// A request that may have reached the Mac, kept past the replay window: its keys are gone, so
    /// it never goes out again as it was, and Try Again first looks for the Bot it may have made.
    var lapsed: AidenBotCreateRequest? = nil

    /// The Mac forgets a Create's Idempotency-Key 24 hours after it answered, and then runs the
    /// same key again. Within this window, an hour short of that for the two clocks, the same key
    /// gets the Mac's one Bot back; past it, the same key could make a second.
    static let replayWindow: TimeInterval = 23 * 60 * 60
    /// How far apart the phone's and the Mac's clocks may be (as on Android).
    static let clockSkew: TimeInterval = 2 * 60

    /// True while a request first sent at `sentAt` may go out again on its key. A clock that went
    /// back since can't tell how long it has been, so that is past the window too.
    static func canReplay(sentAt: Date, now: Date) -> Bool {
        let age = now.timeIntervalSince(sentAt)
        return age > -clockSkew && age < replayWindow
    }
}

/// The requests one Bot create makes; the remote client provides them, tests a fake.
struct AidenBotCreateOperations {
    /// The pairing the create is for: a retry matches only its own attempt, and
    /// what waits on disk is kept under it.
    var instanceId: String
    var deviceId: String
    var usesDurableSession: Bool
    var waitForConnection: @MainActor (Duration) async -> Bool
    var catalog: @MainActor () async throws -> AidenBotCapabilityCatalog
    var create: @MainActor (AidenBotCreateRequest, UUID) async throws -> AidenBotDetail
    /// Older Macs need the Bot chat created explicitly.
    var createChat: @MainActor (_ botID: String, AidenBotChatCreateRequest, UUID) async throws -> Void
    var readBot: @MainActor (_ botID: String) async throws -> AidenBotDetail
    /// The pairing the create started on is still the active one.
    var isCurrent: @MainActor () -> Bool = { true }
    /// True when the error revoked this phone; the create then stops quietly.
    var handleRevocation: @MainActor (Error) async -> Bool = { _ in false }

    var scope: String { AidenBotCreateFlow.scope(instanceId: instanceId, deviceId: deviceId) }
}

/// Bot creation that never waits on the sheet (R15). Create closes New Bot at
/// once and the Bot shows in Bots as on its way; it goes out after a short wait
/// for the Mac, and a failure takes the row away with an error and Try Again,
/// which reopens New Bot as it was. The same request keeps its Idempotency-Key
/// (and a Bot already made) across tries, so a retry never makes two Bots.
///
/// The ask is on disk before anything goes out and until the Bot is made or the
/// person lets it go, so a relaunch mid-create brings it back to Bots home as not
/// made, and its Try Again sends the same request on the same key. When it can't be
/// written nothing goes out, and the failure says so.
///
/// Everything a create leaves behind is its pairing's alone: Bots home shows only the
/// active pairing's, and Try Again sends only to the Mac it was for, so one Mac's
/// answers never become a Bot on another.
@MainActor
@Observable
final class AidenBotCreateFlow {
    struct Pending: Equatable, Identifiable {
        let id: UUID
        let name: String
        let purpose: String
        /// The pairing it is on its way to; Bots home shows it there only.
        let instanceId: String
        let deviceId: String

        var scope: String { AidenBotCreateFlow.scope(instanceId: instanceId, deviceId: deviceId) }
    }

    struct Failure: Equatable {
        let message: String
        var input: AidenBotCreateInput
        /// An earlier launch's create that may have reached the Mac: Try Again sends
        /// its frozen request again rather than reopening New Bot.
        var replays = false
        /// The pairing it was for.
        var instanceId = ""
        var deviceId = ""
        /// The request that may have reached the Mac without an answer, and when it first went
        /// out: past the replay window, Try Again looks for its Bot instead of sending it again.
        var sent: AidenBotCreateRequest?
        var sentAt: Date?
    }

    static let unreachable = "Aiden couldn’t reach your Mac, so the Bot wasn’t made. Try again."
    static let interrupted = "Aiden closed before the Bot was ready. Try again to finish making it."
    static let notKept = "Aiden couldn’t store this Bot on your iPhone, so it wasn’t sent to your Mac. Try again."

    /// What Try Again on Bots home does with a failure.
    enum Retry: Equatable {
        /// Send it again as it was: an earlier launch's, on its key. Hand its input to `submit`.
        case send(AidenBotCreateInput)
        /// Reopen New Bot with these answers.
        case reopen(Failure)
        /// Nothing goes out: the Mac's list shows the Bot it may have made, so it is let go quietly.
        case settled
        /// Nothing: it is another Mac's, and waits for that Mac.
        case none
    }

    private(set) var pending: Pending?
    /// Each pairing's failed create, kept for that pairing alone.
    private var failures: [String: Failure] = [:]

    private struct Attempt {
        let scope: String
        /// What the person asked for; a retry is the same attempt while this is unchanged.
        let input: AidenBotCreateInput
        var frozen: AidenBotPendingCreate.Frozen
        let createdAt: Date
        /// Left by an earlier launch: New Bot can't be trusted to rebuild the same ask, so Try Again replays it.
        var restored = false
    }

    /// Each pairing's last attempt, kept for a retry of the same ask.
    @ObservationIgnored private var retained: [String: Attempt] = [:]
    @ObservationIgnored private let connectionHold: Duration
    @ObservationIgnored private let requestLimit: Duration
    @ObservationIgnored private let store: AidenBotOutboxStore?
    @ObservationIgnored private let now: () -> Date
    /// The disk writes, made one after another in the order they were asked for; each says whether it was kept.
    @ObservationIgnored private var writes: Task<Bool, Never>?
    /// Pairings this flow already looked on disk for; an earlier launch's create comes back once.
    @ObservationIgnored private var restoredScopes: Set<String> = []
    /// The look on disk under way for each pairing; a newer one supersedes it.
    @ObservationIgnored private var restoring: [String: UUID] = [:]
    /// Pairings a create of this launch is sending for, in any flow: theirs is never shown as cut off.
    private static var sending: Set<String> = []

    init(
        connectionHold: Duration = .seconds(8),
        requestLimit: Duration = .seconds(12),
        store: AidenBotOutboxStore? = .shared,
        now: @escaping () -> Date = { Date() }
    ) {
        self.connectionHold = connectionHold
        self.requestLimit = requestLimit
        self.store = store
        self.now = now
    }

    nonisolated static func scope(instanceId: String, deviceId: String) -> String { "\(instanceId)|\(deviceId)" }

    /// The failed create Bots home shows for this pairing; another pairing's is never shown here.
    func failure(instanceId: String, deviceId: String) -> Failure? {
        failures[Self.scope(instanceId: instanceId, deviceId: deviceId)]
    }

    /// Makes the Bot; returns once it exists on the Mac (and `onCreated` ran) or failed,
    /// with what waits on disk written. `retrying` is the failure a Try Again (or the New Bot
    /// it reopened) came from: it is sent only to its own Mac, and otherwise waits for it.
    func submit(
        _ input: AidenBotCreateInput,
        operations: AidenBotCreateOperations,
        retrying: Failure? = nil,
        onCreated: @MainActor (AidenBotDetail) async -> Void
    ) async {
        let ownMac = retrying.map { $0.instanceId == operations.instanceId && $0.deviceId == operations.deviceId } ?? true
        guard pending == nil, ownMac else {
            // Another Bot is still on its way (one is made at a time), or another Mac is the active
            // one now: nothing goes out. A Try Again's answers wait as they were, for their own Mac.
            if let retrying {
                let scope = Self.scope(instanceId: retrying.instanceId, deviceId: retrying.deviceId)
                if failures[scope] == nil {
                    var kept = retrying
                    kept.input = input
                    failures[scope] = kept
                }
            }
            return
        }
        await make(input, operations: operations, onCreated: onCreated)
        _ = await writes?.value
    }

    /// Try Again on `failure` while the pairing (`instanceId`, `deviceId`) is the active one.
    /// Another Mac's failure does nothing here and stays for its own Mac. `bots` is that pairing's
    /// list, for a request that may have reached the Mac past the replay window: if the list shows
    /// its Bot it is let go quietly; otherwise New Bot reopens with its answers, and Create there
    /// is a new request. It never goes out again on a key the Mac may have forgotten.
    func retry(_ failure: Failure, instanceId: String, deviceId: String, bots: [AidenBotSummary] = []) -> Retry {
        guard failure.instanceId == instanceId, failure.deviceId == deviceId else { return .none }
        let scope = Self.scope(instanceId: instanceId, deviceId: deviceId)
        if failures[scope] == failure { failures[scope] = nil }
        guard let sent = failure.sent, let sentAt = failure.sentAt,
              !AidenBotPendingCreate.canReplay(sentAt: sentAt, now: now()) else {
            // An earlier launch's create: the same request, on the same key.
            return failure.replays ? .send(failure.input) : .reopen(failure)
        }
        // Its key is past the Mac's memory: it is never sent again.
        if let held = retained[scope], held.frozen.created == nil, Self.isSameAsk(held, failure.input) {
            retained[scope] = nil
        }
        if Self.listShows(sent, sentAt: sentAt, in: bots) {
            // The Mac made it after all: nothing is left to try again.
            if pending?.scope != scope, !Self.sending.contains(scope) {
                persist(nil, instanceId: instanceId, deviceId: deviceId)
            }
            return .settled
        }
        // The person sees the answers in New Bot and decides.
        var reopened = failure
        reopened.replays = false
        return .reopen(reopened)
    }

    /// True when the Mac's list shows the Bot `sent` may have made: the same name and subtitle,
    /// made since it went out, allowing for the two clocks (as Android's `aidenBotCreateWasTaken`).
    nonisolated static func listShows(_ sent: AidenBotCreateRequest, sentAt: Date, in bots: [AidenBotSummary]) -> Bool {
        let since = sentAt.addingTimeInterval(-AidenBotPendingCreate.clockSkew)
        return bots.contains { $0.name == sent.name && $0.purpose == sent.purpose && $0.createdAt >= since }
    }

    private func make(
        _ input: AidenBotCreateInput,
        operations: AidenBotCreateOperations,
        onCreated: @MainActor (AidenBotDetail) async -> Void
    ) async {
        let scope = operations.scope
        failures[scope] = nil
        pending = Pending(
            id: UUID(),
            name: input.name.trimmingCharacters(in: .whitespacesAndNewlines),
            purpose: input.purpose.trimmingCharacters(in: .whitespacesAndNewlines),
            instanceId: operations.instanceId,
            deviceId: operations.deviceId
        )
        Self.sending.insert(scope)
        defer {
            pending = nil
            Self.sending.remove(scope)
        }
        // The same ask as a failed try: its frozen request and key, whatever the catalog says now,
        // while the Mac still keeps that key. A Bot already made is never made again.
        let held = retained[scope].flatMap { Self.isSameAsk($0, input) ? $0 : nil }
        let replay = held.flatMap {
            $0.frozen.created != nil || AidenBotPendingCreate.canReplay(sentAt: $0.createdAt, now: now()) ? $0 : nil
        }
        // Past it, the same key could make a second Bot: this Create is a new request.
        if held != nil, replay == nil { retained[scope] = nil }
        // On disk before anything goes out, so a relaunch never loses it; nothing goes out when it can't be.
        guard await persist(
            AidenBotPendingCreate(input: input, frozen: replay?.frozen, createdAt: replay?.createdAt ?? now()),
            operations
        ).value else {
            failures[scope] = makeFailure(Self.notKept, input, operations)
            return
        }
        var sent = false
        do {
            // Another Mac became the active one meanwhile: nothing goes out, and the ask waits for its own Mac.
            guard await operations.waitForConnection(connectionHold), operations.isCurrent() else {
                failures[scope] = makeFailure(Self.unreachable, input, operations)
                return
            }
            var attempt: Attempt
            if let replay {
                attempt = replay
            } else {
                let (request, draft) = try await resolve(input, operations: operations)
                attempt = Attempt(
                    scope: scope,
                    input: input,
                    frozen: AidenBotPendingCreate.Frozen(request: request, draft: draft, key: UUID(), chatKey: UUID()),
                    createdAt: now()
                )
                // Its keys reach the disk before the request reaches the Mac.
                guard await persist(record(attempt), operations).value else {
                    failures[scope] = makeFailure(Self.notKept, input, operations)
                    return
                }
            }
            retained[scope] = attempt
            sent = true
            let created: AidenBotDetail
            if let made = attempt.frozen.created {
                created = made
            } else {
                let frozen = attempt.frozen
                created = try await bounded { try await operations.create(frozen.request, frozen.key) }
                attempt.frozen.created = created
                retained[scope] = attempt
                persist(record(attempt), operations)
            }
            guard operations.isCurrent() else { return }
            if !operations.usesDurableSession, let draft = attempt.frozen.draft {
                let chat = try AidenBotChatCreateRequest(
                    providerId: draft.customAccess.providerID,
                    modelId: draft.customAccess.modelID
                )
                let chatKey = attempt.frozen.chatKey
                try await bounded { try await operations.createChat(created.id, chat, chatKey) }
                guard operations.isCurrent() else { return }
            }
            let authoritative = try await bounded { try await operations.readBot(created.id) }
            guard operations.isCurrent() else { return }
            retained[scope] = nil
            persist(nil, operations)
            await onCreated(authoritative)
        } catch is CancellationError {
            return
        } catch {
            if await operations.handleRevocation(error) {
                retained[scope] = nil
                persist(nil, operations)
                return
            }
            if Self.isAccessLoss(error) {
                // Access ended: nothing of this ask is kept on disk.
                retained[scope] = nil
                persist(nil, operations)
            } else if sent, retained[scope]?.frozen.created == nil, !aidenBotEditorCreateFailureIsAmbiguous(error) {
                // Refused before anything was made: a retry is a new request. The answers stay.
                retained[scope] = nil
                persist(AidenBotPendingCreate(input: input, frozen: nil, createdAt: now()), operations)
            }
            // A Bot already made, or a request that may have arrived, is tried again as it was,
            // and only on its own Mac: Bots home shows it once that Mac is the active one.
            failures[scope] = makeFailure(aidenBotFriendlyLoadError(error), input, operations)
        }
    }

    /// Brings back the New Bot an earlier launch left on its way for this pairing: Bots home
    /// shows it as not made, and Try Again sends the same request on the same key. It looks
    /// once per pairing, and never over a create or failure of this launch.
    ///
    /// `isCurrent` says the pairing is still the active one, as its request context does. A look
    /// that lands after Bots home moved on (its task cancelled) or after another Mac became the
    /// active one shows nothing; the ask stays on disk and comes back when its Mac is active again.
    func restore(instanceId: String, deviceId: String, isCurrent: @MainActor () -> Bool = { true }) async {
        let scope = Self.scope(instanceId: instanceId, deviceId: deviceId)
        guard let store, isFree(for: scope), !restoredScopes.contains(scope) else { return }
        let look = UUID()
        restoring[scope] = look
        _ = await writes?.value
        let saved = await store.pendingCreate(instanceId: instanceId, deviceId: deviceId)
        // A newer look for this pairing is under way: it decides.
        guard restoring[scope] == look else { return }
        restoring[scope] = nil
        guard !Task.isCancelled, isCurrent() else { return }
        restoredScopes.insert(scope)
        guard let saved, isFree(for: scope) else { return }
        if let frozen = saved.frozen {
            retained[scope] = Attempt(scope: scope, input: saved.input, frozen: frozen, createdAt: saved.createdAt, restored: true)
        }
        // What may have reached the Mac without an answer: past the replay window (now, or while
        // this prompt stays open) Try Again looks for its Bot rather than sending it again.
        let unanswered = saved.frozen.flatMap { $0.created == nil ? $0.request : nil } ?? saved.lapsed
        failures[scope] = Failure(
            message: Self.interrupted,
            input: saved.input,
            replays: saved.frozen != nil,
            instanceId: instanceId,
            deviceId: deviceId,
            sent: unanswered,
            sentAt: unanswered == nil ? nil : saved.createdAt
        )
    }

    /// The person let the failed Bot go (OK, or New Bot closed after Try Again): it no
    /// longer waits on disk. In memory its key stays for the same ask, so asking again
    /// can't make a second Bot. Returns the write, for tests.
    @discardableResult
    func discard(_ failure: Failure) -> Task<Bool, Never>? {
        let scope = Self.scope(instanceId: failure.instanceId, deviceId: failure.deviceId)
        if failures[scope] == failure { failures[scope] = nil }
        guard pending?.scope != scope, !Self.sending.contains(scope) else { return nil }
        return persist(nil, instanceId: failure.instanceId, deviceId: failure.deviceId)
    }

    private func isFree(for scope: String) -> Bool {
        pending?.scope != scope && failures[scope] == nil && retained[scope] == nil && !Self.sending.contains(scope)
    }

    /// A restored create that fails again keeps replaying its frozen request on Try Again.
    private func makeFailure(_ message: String, _ input: AidenBotCreateInput, _ operations: AidenBotCreateOperations) -> Failure {
        let attempt = retained[operations.scope].flatMap { Self.isSameAsk($0, input) ? $0 : nil }
        let unanswered = attempt.flatMap { $0.frozen.created == nil ? $0 : nil }
        return Failure(
            message: message,
            input: input,
            replays: attempt?.restored ?? false,
            instanceId: operations.instanceId,
            deviceId: operations.deviceId,
            sent: unanswered?.frozen.request,
            sentAt: unanswered?.createdAt
        )
    }

    private func record(_ attempt: Attempt) -> AidenBotPendingCreate {
        AidenBotPendingCreate(input: attempt.input, frozen: attempt.frozen, createdAt: attempt.createdAt)
    }

    @discardableResult
    private func persist(_ create: AidenBotPendingCreate?, _ operations: AidenBotCreateOperations) -> Task<Bool, Never> {
        persist(create, instanceId: operations.instanceId, deviceId: operations.deviceId)
    }

    /// Queues a write behind the ones before it; nil removes what waits. Its value is false when
    /// `create` could not be kept on disk (without a store there is nothing to keep).
    @discardableResult
    private func persist(_ create: AidenBotPendingCreate?, instanceId: String, deviceId: String) -> Task<Bool, Never> {
        let previous = writes
        let store = store
        let task = Task { () -> Bool in
            _ = await previous?.value
            guard let store else { return true }
            guard let create else {
                await store.removePendingCreate(instanceId: instanceId, deviceId: deviceId)
                return true
            }
            return await store.savePendingCreate(create, instanceId: instanceId, deviceId: deviceId)
        }
        writes = task
        return task
    }

    /// 401 or 403, or a credential that's gone: this phone can no longer make Bots on this
    /// Mac. A pairing that merely stopped being the active one is not access loss; its ask
    /// stays for when it is active again.
    private static func isAccessLoss(_ error: Error) -> Bool {
        guard let error = error as? AidenRemoteClientError else { return false }
        switch error {
        case let .server(status, _), let .unexpectedStatus(status):
            return status == 401 || status == 403
        case .missingCredential:
            return true
        default:
            return false
        }
    }

    /// The request for `input`: its picked model, or the Mac's recommended one,
    /// or none on a Mac that lets a Bot start without one.
    private func resolve(
        _ input: AidenBotCreateInput,
        operations: AidenBotCreateOperations
    ) async throws -> (AidenBotCreateRequest, AidenBotEditorDraft?) {
        let name = input.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let purpose = input.purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        let catalog = try await bounded { try await operations.catalog() }
        var draft = input.draft
        if draft == nil {
            do {
                draft = try aidenBotEditorResolvedDraft(mode: .create(defaultAccess: .recommended), catalog: catalog, bot: nil)
            } catch AidenBotContractError.invalidCombination("no available provider and model") where operations.usesDurableSession {
                let request = try AidenBotCreateRequest(
                    name: name,
                    purpose: purpose,
                    instructions: AidenBotEditorDraft.seededInstructions(helpWith: purpose),
                    avatar: .recipe(AidenBotEditorDraft.defaultAvatar),
                    access: nil
                )
                return (request, nil)
            }
        }
        guard var draft else { throw AidenBotContractError.invalidCombination("no available provider and model") }
        draft.name = name
        draft.purpose = purpose
        draft.instructions = AidenBotEditorDraft.seededInstructions(helpWith: purpose)
        return (try draft.createRequest(catalog: catalog), draft)
    }

    /// The same ask as `attempt`, decided before any catalog is read: the same answers, or, when the
    /// first try went out before the Mac's models arrived, the model it was made with. A catalog that
    /// moved on since is not a change the person made.
    private static func isSameAsk(_ attempt: Attempt, _ input: AidenBotCreateInput) -> Bool {
        if attempt.input == input { return true }
        guard attempt.input.name == input.name, attempt.input.purpose == input.purpose,
              attempt.input.draft == nil, let made = attempt.frozen.draft, let draft = input.draft else { return false }
        return made.customAccess.providerID == draft.customAccess.providerID
            && made.customAccess.modelID == draft.customAccess.modelID
            && made.visionProviderID == draft.visionProviderID
            && made.visionModelID == draft.visionModelID
    }

    private func bounded<T: Sendable>(_ operation: @escaping @MainActor () async throws -> T) async throws -> T {
        let call = AidenBotMainActorCall(operation)
        return try await aidenBotWithin(requestLimit) { try await call.call() }
    }
}

/// Two questions: a name, and what the Bot should help with. The answer
/// becomes its subtitle and first instructions; everything else uses
/// sensible defaults that can be changed later in the Profile.
///
/// It opens at once (R15): the questions are there before the Mac answers, the
/// AI model row is a skeleton until the Mac's models arrive (from the cache
/// first), and Create works while connecting. Create hands the Bot to `onCreate`
/// and closes; the Bot is made after, without holding the sheet.
struct AidenBotCreateView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    /// What a Try Again brings back.
    var initial: AidenBotCreateInput?
    var onCreate: (AidenBotCreateInput) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @State private var catalog: AidenBotCapabilityCatalog?
    @State private var draft: AidenBotEditorDraft?
    @State private var name = ""
    @State private var purpose = ""
    @State private var didPrefill = false
    @State private var loadError: String?
    /// A durable-session host lets a Bot start without an AI model; it then
    /// reports `needs_model` until one is chosen on the Mac.
    @State private var allowsModellessCreate = false
    @FocusState private var nameIsFocused: Bool

    private var sessionIdentity: AidenBotCustomAccessSessionIdentity {
        AidenBotCustomAccessSessionIdentity(coordinator: coordinator)
    }

    private var usesDurableSession: Bool {
        AidenBotHostFeature.isAdvertised(AidenBotHostFeature.durableSession, coordinator: coordinator)
    }

    private var input: AidenBotCreateInput {
        var picked = draft
        picked?.name = name
        picked?.purpose = purpose
        return AidenBotCreateInput(name: name, purpose: purpose, draft: picked)
    }

    /// Valid answers are enough: the model is the picked one, or the Mac's
    /// recommended one once it answers.
    private var canCreate: Bool {
        guard coordinator.installationStore.activeInstallation?.canWriteBots == true,
              (try? AidenBotCreateRequest(
                  name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                  purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines),
                  instructions: AidenBotEditorDraft.seededInstructions(helpWith: purpose),
                  avatar: .recipe(AidenBotEditorDraft.defaultAvatar),
                  access: nil
              )) != nil else { return false }
        if let catalog, let draft {
            var named = draft
            named.name = name
            named.purpose = purpose
            named.instructions = AidenBotEditorDraft.seededInstructions(helpWith: purpose)
            return named.isSaveable(catalog: catalog)
        }
        return true
    }

    var body: some View {
        NavigationStack {
            form
                .navigationTitle("New Bot")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Create") {
                            onCreate(input)
                            dismiss()
                        }
                        .disabled(!canCreate)
                    }
                }
        }
        .task(id: sessionIdentity.pairing) {
            prefill()
            await load()
        }
        .onChange(of: coordinator.connectionState == .connected) { _, connected in
            if connected, catalog == nil || loadError != nil { Task { await load() } }
        }
    }

    private var form: some View {
        Form {
            Section {
                TextField("Name", text: $name)
                    .textContentType(.name)
                    .submitLabel(.next)
                    .focused($nameIsFocused)
                TextField("What should it help with?", text: $purpose, axis: .vertical)
                    .lineLimit(2...5)
            } footer: {
                Text(accessNote)
            }
            modelSection
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .onAppear { nameIsFocused = true }
    }

    @ViewBuilder
    private var modelSection: some View {
        if let catalog, let current = draft {
            Section {
                AidenBotModelRow(
                    title: "Model",
                    catalog: catalog,
                    providerID: current.customAccess.providerID,
                    modelID: current.customAccess.modelID,
                    recommended: AidenBotCustomAccessDraft(catalog: catalog).map {
                        AidenBotModelSelection(providerId: $0.providerID, modelId: $0.modelID)
                    }
                ) { providerID, modelID in
                    draft?.selectModel(providerID: providerID, modelID: modelID, catalog: catalog)
                }
                switch current.photoModelNeed(catalog: catalog) {
                case .none:
                    EmptyView()
                case .unavailable:
                    Text(current.noImageModelNote(catalog: catalog))
                        .foregroundStyle(palette.secondary)
                case .choose:
                    AidenBotModelRow(
                        title: "Photos",
                        catalog: catalog,
                        providerID: current.visionProviderID,
                        modelID: current.visionModelID,
                        imagesOnly: true
                    ) { providerID, modelID in
                        draft?.selectVisionModel(providerID: providerID, modelID: modelID, catalog: catalog)
                    }
                }
            } header: {
                Text("AI model")
            } footer: {
                Text("You can change this later in Advanced.")
            }
        } else if !allowsModellessCreate {
            Section {
                if let loadError {
                    // Never a blocking screen: the Bot is made with the recommended model.
                    HStack(spacing: 8) {
                        Text(loadError)
                            .font(.footnote)
                            .foregroundStyle(palette.secondary)
                        Spacer(minLength: 8)
                        Button("Try Again") { Task { await load() } }
                            .font(.footnote.weight(.semibold))
                            .frame(minHeight: 44)
                    }
                } else {
                    // The Mac's models are on their way: a skeleton row, never a spinner.
                    HStack {
                        AidenBotSkeletonBlock(width: 64, height: 16, radius: 8, reduceMotion: reduceMotion)
                        Spacer()
                        AidenBotSkeletonBlock(width: 120, height: 16, radius: 8, reduceMotion: reduceMotion)
                    }
                    .frame(minHeight: 28)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Loading models")
                }
            } header: {
                Text("AI model")
            } footer: {
                Text("It uses the recommended model unless you pick one.")
            }
        }
    }

    private var accessNote: String {
        if allowsModellessCreate {
            return "It needs an AI model before it can reply. Choose one on your Mac."
        }
        return "It can use everything your Mac allows. You can change this later in Advanced."
    }

    private func prefill() {
        guard !didPrefill else { return }
        didPrefill = true
        guard let initial else { return }
        name = initial.name
        purpose = initial.purpose
        draft = initial.draft
    }

    /// The Mac's models, from the cache at once and then fresh. A picked model stays.
    @MainActor
    private func load() async {
        let expected = sessionIdentity.pairing
        guard let context = try? coordinator.requestContext() else { return }
        if catalog == nil,
           let cached = await AidenBotCache.shared.load(instanceId: context.instanceId, deviceId: context.deviceId)?.catalog,
           sessionIdentity.pairing == expected {
            adopt(cached)
        }
        do {
            let loaded = try await coordinator.remoteClient(for: context).botCapabilityCatalog()
            guard coordinator.isCurrent(context), sessionIdentity.pairing == expected, !Task.isCancelled else { return }
            loadError = nil
            adopt(loaded)
        } catch is CancellationError {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard sessionIdentity.pairing == expected else { return }
            if catalog == nil { loadError = aidenBotFriendlyLoadError(error) }
        }
    }

    private func adopt(_ loaded: AidenBotCapabilityCatalog) {
        let resolved: AidenBotEditorDraft?
        do {
            resolved = try aidenBotEditorResolvedDraft(mode: .create(defaultAccess: .recommended), catalog: loaded, bot: nil)
        } catch {
            resolved = nil
        }
        catalog = loaded
        allowsModellessCreate = resolved == nil && usesDurableSession
        // A model already picked stays while the Mac still offers it.
        if let draft, draft.isSaveable(catalog: loaded) { return }
        draft = resolved
    }
}

/// The Bots row for a Bot on its way to the Mac (R15): its name at once,
/// a skeleton face, and "Creating…".
struct AidenBotPendingCreateRow: View {
    let pending: AidenBotCreateFlow.Pending

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            AidenBotSkeletonBlock(width: 52, height: 52, radius: 26, reduceMotion: reduceMotion)
            VStack(alignment: .leading, spacing: 4) {
                Text(pending.name)
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                Text(AidenBotCreateCopy.creating)
                    .font(.body)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(pending.name), \(AidenBotCreateCopy.creating)")
    }
}

enum AidenBotCreateCopy {
    static let creating = "Creating…"
    static let failedTitle = "Couldn’t Create Bot"
}
