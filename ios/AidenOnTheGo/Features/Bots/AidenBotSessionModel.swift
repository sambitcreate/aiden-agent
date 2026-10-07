import Foundation
import Observation

/// Host feature tokens added in contract revision 25.
enum AidenBotHostFeature {
    static let durableSession = "bot-durable-session-v1"
    static let routines = "bot-routines-v1"
    static let connectionRequests = "bot-connection-requests-v1"
    static let presets = "bot-presets-v1"

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
    func requestBotConnection(
        botId: String,
        request: AidenBotConnectionRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotConnectionRequestReceipt
}

extension AidenRemoteClient: AidenBotSessionTransport {}

/// The exact copy shared with desktop and Android.
enum AidenBotSessionCopy {
    static let interrupted = "I got interrupted while working on this."
    static let resume = "Resume"
    static let dismiss = "Dismiss"
    static let accessChanged = "This Bot's access changed. Review it on your Mac."
    static let pausedSubtitle = "Paused — tap to resume"
    static let needsModel = "Needs an AI model"
    static let needsModelHint = "Set up on your Mac"
    static let sessionReset = "This chat was restarted."
    static let finishOnMac = "Finish on your Mac"
    static let finishOnMacReadOnly = "Finish this on your Mac."
    static let checkYourMac = "Check your Mac to finish."
    static let connected = "Connected ✓"

    static func connectTitle(_ name: String) -> String { "Connect \(name)" }
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
        case send, resume, dismiss, stop
    }

    let botID: String
    private let transport: any AidenBotSessionTransport

    private(set) var entries: [AidenBotSessionEntry] = []
    private(set) var partial: String?
    private(set) var stateView: AidenBotSessionStateView?
    private(set) var epoch: String?
    private(set) var seq = 0
    private(set) var hasLoaded = false
    private(set) var inFlight: Set<Action> = []
    private(set) var sentConnectionRequests: Set<String> = []
    var errorMessage: String?

    @ObservationIgnored private var retainedKeys: [Action: UUID] = [:]
    @ObservationIgnored private var retainedMessage: (text: String, key: UUID)?
    @ObservationIgnored private var connectionKeys: [String: UUID] = [:]

    init(botID: String, transport: any AidenBotSessionTransport) {
        self.botID = botID
        self.transport = transport
    }

    var state: AidenBotSessionStateKind? { stateView?.state }
    var needsModel: Bool { state == .needsModel }
    var isRunning: Bool { state == .running }
    var isInterrupted: Bool { stateView?.interrupted == true }
    var isAccessBlocked: Bool { stateView?.blocked == .accessChanged }
    var canSend: Bool { hasLoaded && !needsModel && state != .unavailable && !inFlight.contains(.send) }

    // MARK: Loading and the event stream

    func load() async {
        do {
            apply(snapshot: try await transport.botSession(botId: botID))
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = hasLoaded ? "Couldn’t refresh this chat." : error.localizedDescription
        }
    }

    /// Listens until cancelled, reconnecting after a close or a dropped
    /// connection. Each connection starts with a snapshot.
    func listen() async {
        var failures = 0
        while !Task.isCancelled {
            do {
                for try await event in transport.botSessionEvents(botId: botID) {
                    failures = 0
                    if await apply(event) == .closed { break }
                }
            } catch is CancellationError {
                return
            } catch {
                failures += 1
            }
            guard !Task.isCancelled else { return }
            let delay = min(30.0, 0.5 * pow(2.0, Double(min(failures, 6))))
            try? await Task.sleep(for: .seconds(failures == 0 ? 0.2 : delay))
        }
    }

    enum EventOutcome: Equatable {
        case applied, ignored, refetched, closed
    }

    /// Applies one frame under the `(epoch, seq)` rule: a snapshot replaces
    /// everything; a frame from another epoch or after a gap discards local
    /// state and refetches the session; a stale or repeated frame is ignored.
    @discardableResult
    func apply(_ event: AidenBotSessionEvent) async -> EventOutcome {
        guard event.botId == botID else { return .ignored }
        if case let .snapshot(session) = event.kind {
            apply(snapshot: session)
            return .applied
        }
        guard let epoch, event.epoch == epoch else {
            await refetch()
            return .refetched
        }
        if event.seq <= seq { return .ignored }
        guard event.seq == seq + 1 else {
            await refetch()
            return .refetched
        }
        seq = event.seq
        switch event.kind {
        case .snapshot:
            break
        case let .partial(text):
            partial = text.isEmpty ? nil : text
        case let .entry(entry):
            if let index = entries.firstIndex(where: { $0.id == entry.id }) {
                entries[index] = entry
            } else {
                entries.append(entry)
                if entries.count > AidenBotSessionWire.maxEntries {
                    entries.removeFirst(entries.count - AidenBotSessionWire.maxEntries)
                }
            }
            partial = nil
        case let .state(view):
            stateView = view
        case .closed:
            return .closed
        }
        return .applied
    }

    private func refetch() async {
        epoch = nil
        seq = 0
        entries = []
        partial = nil
        await load()
    }

    private func apply(snapshot session: AidenBotSession) {
        guard session.botId == botID else { return }
        epoch = session.epoch
        seq = session.seq
        entries = session.entries
        partial = session.partial.flatMap { $0.isEmpty ? nil : $0 }
        stateView = session.stateView
        hasLoaded = true
    }

    // MARK: Turn controls

    /// Sends one message. A Bot that needs an AI model sends nothing.
    @discardableResult
    func send(_ rawText: String) async -> Bool {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, let request = try? AidenBotMessageRequest(text: text) else { return false }
        let key: UUID
        if let retainedMessage, retainedMessage.text == text {
            key = retainedMessage.key
        } else {
            key = UUID()
            retainedMessage = (text, key)
        }
        inFlight.insert(.send)
        defer { inFlight.remove(.send) }
        do {
            let receipt = try await transport.sendBotMessage(botId: botID, request: request, idempotencyKey: key)
            retainedMessage = nil
            stateView = receipt.stateView
            return true
        } catch {
            if !aidenBotSessionFailureIsAmbiguous(error) { retainedMessage = nil }
            errorMessage = "That message wasn’t sent. Please try again."
            return false
        }
    }

    func resume() async {
        guard isInterrupted, !isAccessBlocked else { return }
        await perform(.resume) { [transport, botID] key in
            try await transport.resumeBotSession(botId: botID, idempotencyKey: key)
        }
    }

    func dismiss() async {
        guard isInterrupted else { return }
        await perform(.dismiss) { [transport, botID] key in
            try await transport.dismissBotSession(botId: botID, idempotencyKey: key)
        }
    }

    func stop() async {
        guard isRunning else { return }
        await perform(.stop) { [transport, botID] key in
            try await transport.stopBotSession(botId: botID, idempotencyKey: key)
        }
    }

    /// One request per logical action at a time. The key survives an
    /// ambiguous failure so a retry is deduplicated by the Mac.
    private func perform(
        _ action: Action,
        _ request: @escaping @Sendable (UUID) async throws -> AidenBotSessionStateView
    ) async {
        guard !inFlight.contains(action) else { return }
        let key = retainedKeys[action] ?? UUID()
        retainedKeys[action] = key
        inFlight.insert(action)
        defer { inFlight.remove(action) }
        do {
            stateView = try await request(key)
            retainedKeys[action] = nil
        } catch is CancellationError {
            return
        } catch {
            if !aidenBotSessionFailureIsAmbiguous(error) { retainedKeys[action] = nil }
            errorMessage = "That didn’t work. Please try again."
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
        } catch {
            sentConnectionRequests.remove(pluginId)
            if !aidenBotSessionFailureIsAmbiguous(error) { connectionKeys[pluginId] = nil }
            errorMessage = "Your Mac didn’t get that request. Please try again."
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
