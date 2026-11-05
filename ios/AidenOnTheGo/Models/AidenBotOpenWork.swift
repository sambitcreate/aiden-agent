import Foundation

/// Revision 58. Text is bounded by both Unicode scalars and UTF-8 bytes;
/// submission/entry identities remain decimal strings, including above 2^53.
enum AidenOpenWorkWire {
    static func text(_ value: String, scalars: Int, bytes: Int, empty: Bool = false) throws {
        guard !value.contains("\0"), value.unicodeScalars.count <= scalars, value.utf8.count <= bytes,
              empty || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AidenBotContractError.invalidField("Open work text")
        }
    }
    static func id(_ value: String) throws {
        guard (1...160).contains(value.utf8.count), value.utf8.allSatisfy({
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 46, 58, 95].contains($0)
        }) else { throw AidenBotContractError.invalidField("Open work identity") }
    }
    static func decimal(_ value: String) throws {
        guard (1...32).contains(value.utf8.count), value.first != "0",
              value.utf8.allSatisfy({ (48...57).contains($0) }) else {
            throw AidenBotContractError.invalidField("Open work entry identity")
        }
    }
    static func timestamp(_ value: Int) throws {
        guard (0...AidenRemoteProtocol.maxSafeInteger).contains(value) else {
            throw AidenBotContractError.invalidField("Open work timestamp")
        }
    }
    static func uuid(_ value: String) throws -> UUID {
        guard value.range(of: "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$", options: .regularExpression) != nil,
              let id = UUID(uuidString: value) else { throw AidenBotContractError.invalidField("Open work mutation identity") }
        return id
    }
    static func string<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K, scalars: Int, bytes: Int, empty: Bool = false) throws -> String {
        let value = try c.decode(String.self, forKey: key)
        try text(value, scalars: scalars, bytes: bytes, empty: empty)
        return value
    }
    static func identity<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) throws -> String {
        let value = try c.decode(String.self, forKey: key)
        try id(value)
        return value
    }
}

enum AidenOpenWorkState: String, Codable, CaseIterable, Identifiable, Sendable {
    case open, waiting, done, dismissed
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var isActive: Bool { self == .open || self == .waiting }
}

struct AidenOpenWorkEntry: Codable, Equatable, Hashable, Sendable {
    let submissionId: String
    let entryId: String
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        submissionId = try c.decode(String.self, forKey: .submissionId)
        entryId = try c.decode(String.self, forKey: .entryId)
        try AidenOpenWorkWire.decimal(submissionId)
        try AidenOpenWorkWire.decimal(entryId)
    }
    private enum CodingKeys: String, CodingKey { case submissionId, entryId }
}

struct AidenOpenWorkSource: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable { case person, routine, peer }
    enum Role: String, Codable, Sendable { case incoming, outgoing }
    let kind: Kind
    let submissionId: String?; let entryId: String?; let routineId: String?; let runId: String?
    let exchangeId: String?; let role: Role?; let peerBotId: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(Kind.self, forKey: .kind)
        submissionId = try AidenRoutineModelWire.optional(String.self, c, .submissionId); entryId = try AidenRoutineModelWire.optional(String.self, c, .entryId)
        routineId = try AidenRoutineModelWire.optional(String.self, c, .routineId); runId = try AidenRoutineModelWire.optional(String.self, c, .runId)
        exchangeId = try AidenRoutineModelWire.optional(String.self, c, .exchangeId); role = try AidenRoutineModelWire.optional(Role.self, c, .role); peerBotId = try AidenRoutineModelWire.optional(String.self, c, .peerBotId)
        guard (submissionId == nil) == (entryId == nil) else { throw AidenBotContractError.invalidField("Open work source") }
        if let submissionId { try AidenOpenWorkWire.decimal(submissionId) }; if let entryId { try AidenOpenWorkWire.decimal(entryId) }
        switch kind {
        case .person:
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "submissionId", "entryId"])
        case .routine:
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "submissionId", "entryId", "routineId", "runId"])
            guard submissionId != nil, let routineId, let runId else { throw AidenBotContractError.invalidField("routine source") }
            try AidenOpenWorkWire.id(routineId); try AidenOpenWorkWire.id(runId)
        case .peer:
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "exchangeId", "role", "peerBotId", "submissionId", "entryId"])
            guard let exchangeId, let peerBotId, role != nil else { throw AidenBotContractError.invalidField("peer source") }
            try AidenOpenWorkWire.id(exchangeId); try AidenOpenWorkWire.id(peerBotId)
        }
    }
    private enum CodingKeys: String, CodingKey { case kind, submissionId, entryId, routineId, runId, exchangeId, role, peerBotId }
}

struct AidenOpenWorkLink: Codable, Equatable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable { case source, result, routine, issue, peer }
    let kind: Kind
    let submissionId: String?; let entryId: String?; let routineId: String?; let runId: String?; let issueId: String?
    let exchangeId: String?; let peerBotId: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self); kind = try c.decode(Kind.self, forKey: .kind)
        submissionId = try AidenRoutineModelWire.optional(String.self, c, .submissionId); entryId = try AidenRoutineModelWire.optional(String.self, c, .entryId)
        routineId = try AidenRoutineModelWire.optional(String.self, c, .routineId); runId = try AidenRoutineModelWire.optional(String.self, c, .runId); issueId = try AidenRoutineModelWire.optional(String.self, c, .issueId)
        exchangeId = try AidenRoutineModelWire.optional(String.self, c, .exchangeId); peerBotId = try AidenRoutineModelWire.optional(String.self, c, .peerBotId)
        switch kind {
        case .source, .result:
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "submissionId", "entryId"])
            guard let submissionId, let entryId else { throw AidenBotContractError.invalidField("entry link") }
            try AidenOpenWorkWire.decimal(submissionId); try AidenOpenWorkWire.decimal(entryId)
        case .routine:
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "routineId", "runId"])
            guard let routineId, let runId else { throw AidenBotContractError.invalidField("routine link") }
            try AidenOpenWorkWire.id(routineId); try AidenOpenWorkWire.id(runId)
        case .issue:
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "issueId"])
            guard let issueId else { throw AidenBotContractError.invalidField("issue link") }; try AidenOpenWorkWire.id(issueId)
        case .peer:
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "exchangeId", "peerBotId"])
            guard let exchangeId, let peerBotId else { throw AidenBotContractError.invalidField("peer link") }
            try AidenOpenWorkWire.id(exchangeId); try AidenOpenWorkWire.id(peerBotId)
        }
    }
    private enum CodingKeys: String, CodingKey { case kind, submissionId, entryId, routineId, runId, issueId, exchangeId, peerBotId }
}

struct AidenOpenWorkExecution: Codable, Equatable, Sendable {
    enum State: String, Codable, Sendable { case idle, queued, running, interrupted, stopping }
    enum BlockedReason: String, Codable, Sendable { case mixedInputs = "mixed_inputs", notLinked = "not_linked", hostUnavailable = "host_unavailable" }
    let state: State
    let canStop: Bool
    let blockedReason: BlockedReason?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(State.self, forKey: .state)
        canStop = try c.decode(Bool.self, forKey: .canStop)
        blockedReason = try c.decodeIfPresent(BlockedReason.self, forKey: .blockedReason)
        guard !canStop || blockedReason == nil && state != .idle && state != .stopping else {
            throw AidenBotContractError.invalidField("Open work Stop authority")
        }
    }
    var explanation: String? {
        switch blockedReason {
        case .mixedInputs: "This run includes other inputs. Stop it on your host to avoid interrupting unrelated work."
        case .notLinked: "There is no linked run to stop."
        case .hostUnavailable: "Your host can’t currently confirm the linked run."
        case nil: nil
        }
    }
    private enum CodingKeys: String, CodingKey { case state, canStop, blockedReason }
}

struct AidenOpenWorkStop: Codable, Equatable, Sendable {
    enum State: String, Codable, Sendable {
        case requested, stopped, alreadyFinished = "already_finished", notRunning = "not_running", uncertain, blocked
        var isTerminal: Bool { self != .requested && self != .uncertain }
    }
    enum Reason: String, Codable, Sendable { case mixedInputs = "mixed_inputs", hostUnavailable = "host_unavailable", deadline, sourceMissing = "source_missing" }
    let mutationId: UUID
    let state: State
    let requestedAt: Int
    let finishedAt: Int?
    let reason: Reason?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mutationId = try AidenOpenWorkWire.uuid(c.decode(String.self, forKey: .mutationId))
        state = try c.decode(State.self, forKey: .state)
        requestedAt = try c.decode(Int.self, forKey: .requestedAt)
        finishedAt = try c.decodeIfPresent(Int.self, forKey: .finishedAt)
        reason = try c.decodeIfPresent(Reason.self, forKey: .reason)
        try AidenOpenWorkWire.timestamp(requestedAt)
        if let finishedAt { try AidenOpenWorkWire.timestamp(finishedAt) }
    }
    var description: String {
        switch state {
        case .requested: "Stop requested. Waiting for host acknowledgement."
        case .uncertain: "Stop outcome is unknown. This item stays unfinished until the host confirms it."
        case .stopped: "The linked run stopped."
        case .alreadyFinished: "The linked run had already finished."
        case .notRunning: "No linked run was running."
        case .blocked: "The host refused Stop. This item has not been dismissed by that request."
        }
    }
    private enum CodingKeys: String, CodingKey { case mutationId, state, requestedAt, finishedAt, reason }
}

struct AidenOpenWorkCompletion: Codable, Equatable, Sendable {
    enum Author: String, Codable, Sendable { case person, bot }
    let by: Author
    let at: Int
    let result: AidenOpenWorkEntry?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        by = try c.decode(Author.self, forKey: .by)
        at = try c.decode(Int.self, forKey: .at)
        try AidenOpenWorkWire.timestamp(at)
        result = try c.decodeIfPresent(AidenOpenWorkEntry.self, forKey: .result)
    }
    private enum CodingKeys: String, CodingKey { case by, at, result }
}

struct AidenOpenWorkItem: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let revision: String
    let title: String
    let note: String
    let state: AidenOpenWorkState
    let waitingReason: String?
    let createdAt: Int
    let updatedAt: Int
    let source: AidenOpenWorkSource
    let links: [AidenOpenWorkLink]
    let completion: AidenOpenWorkCompletion?
    let execution: AidenOpenWorkExecution
    let lastStop: AidenOpenWorkStop?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenOpenWorkWire.identity(c, .id)
        revision = try AidenOpenWorkWire.identity(c, .revision)
        title = try AidenOpenWorkWire.string(c, .title, scalars: 160, bytes: 640)
        note = try AidenOpenWorkWire.string(c, .note, scalars: 1000, bytes: 2048, empty: true)
        state = try c.decode(AidenOpenWorkState.self, forKey: .state)
        waitingReason = try c.decodeIfPresent(String.self, forKey: .waitingReason)
        guard (state == .waiting) == (waitingReason != nil) else { throw AidenBotContractError.invalidField("waiting reason") }
        if let waitingReason { try AidenOpenWorkWire.text(waitingReason, scalars: 160, bytes: 640) }
        createdAt = try c.decode(Int.self, forKey: .createdAt)
        updatedAt = try c.decode(Int.self, forKey: .updatedAt)
        try AidenOpenWorkWire.timestamp(createdAt)
        try AidenOpenWorkWire.timestamp(updatedAt)
        source = try c.decode(AidenOpenWorkSource.self, forKey: .source)
        links = try c.decode([AidenOpenWorkLink].self, forKey: .links)
        guard links.count <= 4, Set(links).count == links.count else { throw AidenBotContractError.invalidField("Open work links") }
        completion = try c.decodeIfPresent(AidenOpenWorkCompletion.self, forKey: .completion)
        guard completion == nil || state == .done else { throw AidenBotContractError.invalidField("Open work completion") }
        execution = try c.decode(AidenOpenWorkExecution.self, forKey: .execution)
        lastStop = try c.decodeIfPresent(AidenOpenWorkStop.self, forKey: .lastStop)
    }
    var hasPendingStop: Bool { lastStop.map { !$0.state.isTerminal } ?? false }
    var hasSource: Bool { source.entryId != nil || links.contains { $0.kind == .source } }
    var hasResult: Bool { completion?.result != nil || links.contains { $0.kind == .result } }
    private enum CodingKeys: String, CodingKey {
        case id, revision, title, note, state, waitingReason, createdAt, updatedAt, source, links, completion, execution, lastStop
    }
}

struct AidenOpenWorkUndo: Codable, Equatable, Identifiable, Sendable {
    let mutationId: UUID
    let itemId: String
    let expectedRevision: String
    let expiresAt: Int
    var id: UUID { mutationId }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mutationId = try AidenOpenWorkWire.uuid(c.decode(String.self, forKey: .mutationId))
        itemId = try AidenOpenWorkWire.identity(c, .itemId)
        expectedRevision = try AidenOpenWorkWire.identity(c, .expectedRevision)
        expiresAt = try c.decode(Int.self, forKey: .expiresAt)
        try AidenOpenWorkWire.timestamp(expiresAt)
    }
    func isAvailable(at date: Date = Date()) -> Bool { Double(expiresAt) > date.timeIntervalSince1970 * 1000 }
    private enum CodingKeys: String, CodingKey { case mutationId, itemId, expectedRevision, expiresAt }
}

struct AidenOpenWorkSnapshot: Codable, Equatable, Sendable {
    let botId: String
    let revision: String
    let items: [AidenOpenWorkItem]
    let undo: [AidenOpenWorkUndo]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        botId = try AidenOpenWorkWire.identity(c, .botId)
        revision = try AidenOpenWorkWire.identity(c, .revision)
        items = try c.decode([AidenOpenWorkItem].self, forKey: .items)
        undo = try c.decode([AidenOpenWorkUndo].self, forKey: .undo)
        guard items.count <= 192, Set(items.map(\.id)).count == items.count,
              items.filter({ $0.state.isActive }).count <= 64, items.filter({ !$0.state.isActive }).count <= 128,
              undo.count <= 192, Set(undo.map(\.itemId)).count == undo.count,
              undo.allSatisfy({ option in items.contains { $0.id == option.itemId && $0.revision == option.expectedRevision } }) else {
            throw AidenBotContractError.invalidField("Open work snapshot")
        }
    }
    private enum CodingKeys: String, CodingKey { case botId, revision, items, undo }
}

extension AidenOpenWorkSnapshot: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botOpenWork") }
}

extension AidenOpenWorkItem: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botOpenWorkItem") }
}
