import Foundation

/// Revision 59: owner controls only. Peer text never grants execution authority.
enum AidenPeerWire {
    static func closed(_ decoder: Decoder, _ keys: Set<String>) throws { try AidenRoutineModelWire.closed(decoder, keys) }
    static func optional<T: Decodable, K: CodingKey>(_ type: T.Type, _ c: KeyedDecodingContainer<K>, _ key: K) throws -> T? { try AidenRoutineModelWire.optional(type, c, key) }
    static func id(_ value: String) throws { try AidenOpenWorkWire.id(value) }
    static func text(_ value: String, scalars: Int = 160, bytes: Int = 640, empty: Bool = false) throws { try AidenOpenWorkWire.text(value, scalars: scalars, bytes: bytes, empty: empty) }
    static func unique(_ ids: [String], limit: Int = 128) throws {
        guard ids.count <= limit, Set(ids).count == ids.count else { throw AidenRemoteClientError.invalidResponse }
    }
    static func owns(_ exchange: AidenPeerExchangeSummary, botID: String) -> Bool {
        (exchange.direction == .sent ? exchange.sender : exchange.recipient).botId == botID
    }
}
struct AidenPeerIdentity: Codable, Equatable, Sendable {
    let botId: String; let name: String
    init(from decoder: Decoder) throws {
        try AidenPeerWire.closed(decoder, ["botId", "name"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        botId = try AidenOpenWorkWire.identity(c, .botId); name = try c.decode(String.self, forKey: .name); try AidenPeerWire.text(name)
    }
    private enum CodingKeys: String, CodingKey { case botId, name }
}
struct AidenPeerPair: Codable, Equatable, Identifiable, Sendable {
    let id: String; let revision: String; let peer: AidenPeerIdentity; let approvedAt: Int
    init(from decoder: Decoder) throws {
        try AidenPeerWire.closed(decoder, ["id", "revision", "peer", "approvedAt"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenOpenWorkWire.identity(c, .id); revision = try AidenOpenWorkWire.identity(c, .revision)
        peer = try c.decode(AidenPeerIdentity.self, forKey: .peer); approvedAt = try c.decode(Int.self, forKey: .approvedAt); try AidenOpenWorkWire.timestamp(approvedAt)
    }
    private enum CodingKeys: String, CodingKey { case id, revision, peer, approvedAt }
}
struct AidenPeerSettings: Codable, Equatable, Sendable {
    let botId: String; let revision: String; let routingDescription: String; let pairs: [AidenPeerPair]; let updatedAt: Int; let lastMutationId: UUID?
    init(from decoder: Decoder) throws {
        try AidenPeerWire.closed(decoder, ["botId", "revision", "routingDescription", "pairs", "updatedAt", "lastMutationId"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        botId = try AidenOpenWorkWire.identity(c, .botId); revision = try AidenOpenWorkWire.identity(c, .revision)
        routingDescription = try c.decode(String.self, forKey: .routingDescription); try AidenPeerWire.text(routingDescription, scalars: 1000, bytes: 2048, empty: true)
        pairs = try c.decode([AidenPeerPair].self, forKey: .pairs); try AidenPeerWire.unique(pairs.map(\.id)); try AidenPeerWire.unique(pairs.map { $0.peer.botId })
        let owner = botId
        guard pairs.allSatisfy({ $0.peer.botId != owner }) else { throw AidenRemoteClientError.invalidResponse }
        updatedAt = try c.decode(Int.self, forKey: .updatedAt); try AidenOpenWorkWire.timestamp(updatedAt)
        lastMutationId = try AidenPeerWire.optional(String.self, c, .lastMutationId).map(AidenOpenWorkWire.uuid)
    }
    private enum CodingKeys: String, CodingKey { case botId, revision, routingDescription, pairs, updatedAt, lastMutationId }
}
struct AidenPeerCatalog: Decodable, Equatable, Sendable {
    struct Bot: Decodable, Equatable, Identifiable, Sendable {
        let botId: String; var id: String { botId }; let name: String; let available: Bool
        init(from decoder: Decoder) throws {
            try AidenPeerWire.closed(decoder, ["botId", "name", "available"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            botId = try AidenOpenWorkWire.identity(c, .botId); name = try c.decode(String.self, forKey: .name); try AidenPeerWire.text(name)
            available = try c.decode(Bool.self, forKey: .available)
        }
        private enum CodingKeys: String, CodingKey { case botId, name, available }
    }
    let botId: String; let revision: String; let bots: [Bot]
    init(from decoder: Decoder) throws {
        try AidenPeerWire.closed(decoder, ["botId", "revision", "bots"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        botId = try AidenOpenWorkWire.identity(c, .botId); revision = try AidenOpenWorkWire.identity(c, .revision)
        bots = try c.decode([Bot].self, forKey: .bots); try AidenPeerWire.unique(bots.map(\.botId))
        guard bots.allSatisfy({ $0.botId != botId }) else { throw AidenRemoteClientError.invalidResponse }
    }
    private enum CodingKeys: String, CodingKey { case botId, revision, bots }
}
struct AidenPeerMutation: Codable, Equatable, Sendable {
    enum Action: String, Codable, Sendable { case describe, approve, revoke }
    let action: Action; let botId: String; let mutationId: UUID; let expectedRevision: String
    var routingDescription: String?; var catalogRevision: String?; var peerBotId: String?; var pairId: String?; var pairRevision: String?
    init(action: Action, botId: String, mutationId: UUID = UUID(), expectedRevision: String, routingDescription: String? = nil, catalogRevision: String? = nil, peerBotId: String? = nil, pairId: String? = nil, pairRevision: String? = nil) {
        self.action = action; self.botId = botId; self.mutationId = mutationId; self.expectedRevision = expectedRevision
        self.routingDescription = routingDescription; self.catalogRevision = catalogRevision; self.peerBotId = peerBotId; self.pairId = pairId; self.pairRevision = pairRevision
    }
    func validate() throws {
        try AidenPeerWire.id(botId); try AidenPeerWire.id(expectedRevision); _ = try AidenOpenWorkWire.uuid(mutationId.uuidString)
        switch action {
        case .describe:
            guard let routingDescription, catalogRevision == nil, peerBotId == nil, pairId == nil, pairRevision == nil else { throw AidenRemoteClientError.invalidResponse }
            try AidenPeerWire.text(routingDescription, scalars: 1000, bytes: 2048, empty: true)
        case .approve:
            guard let catalogRevision, let peerBotId, routingDescription == nil, pairId == nil, pairRevision == nil else { throw AidenRemoteClientError.invalidResponse }
            try AidenPeerWire.id(catalogRevision); try AidenPeerWire.id(peerBotId)
        case .revoke:
            guard let pairId, let pairRevision, routingDescription == nil, catalogRevision == nil, peerBotId == nil else { throw AidenRemoteClientError.invalidResponse }
            try AidenPeerWire.id(pairId); try AidenPeerWire.id(pairRevision)
        }
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self); action = try c.decode(Action.self, forKey: .action)
        var keys: Set<String> = ["action", "botId", "mutationId", "expectedRevision"]
        switch action { case .describe: keys.insert("routingDescription"); case .approve: keys.formUnion(["catalogRevision", "peerBotId"]); case .revoke: keys.formUnion(["pairId", "pairRevision"]) }
        try AidenPeerWire.closed(decoder, keys)
        botId = try c.decode(String.self, forKey: .botId); mutationId = try AidenOpenWorkWire.uuid(c.decode(String.self, forKey: .mutationId)); expectedRevision = try c.decode(String.self, forKey: .expectedRevision)
        routingDescription = try AidenPeerWire.optional(String.self, c, .routingDescription); catalogRevision = try AidenPeerWire.optional(String.self, c, .catalogRevision)
        peerBotId = try AidenPeerWire.optional(String.self, c, .peerBotId); pairId = try AidenPeerWire.optional(String.self, c, .pairId); pairRevision = try AidenPeerWire.optional(String.self, c, .pairRevision)
        try validate()
    }
    private enum CodingKeys: String, CodingKey { case action, botId, mutationId, expectedRevision, routingDescription, catalogRevision, peerBotId, pairId, pairRevision }
}
enum AidenPeerErrorCode: String, Decodable, Sendable { case invalid, conflict, unavailable, historyFull = "history_full", accessChanged = "access_changed", notFound = "not_found" }
enum AidenPeerMutationResult: Decodable, Equatable, Sendable {
    case accepted(snapshot: AidenPeerSettings, mutationId: UUID, replayed: Bool)
    case rejected(code: AidenPeerErrorCode, error: String, snapshot: AidenPeerSettings?)
    var snapshot: AidenPeerSettings? { switch self { case let .accepted(snapshot, _, _): snapshot; case let .rejected(_, _, snapshot): snapshot } }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if try c.decode(Bool.self, forKey: .ok) {
            try AidenPeerWire.closed(decoder, ["ok", "snapshot", "mutationId", "replayed"])
            self = .accepted(snapshot: try c.decode(AidenPeerSettings.self, forKey: .snapshot), mutationId: try AidenOpenWorkWire.uuid(c.decode(String.self, forKey: .mutationId)), replayed: try c.decode(Bool.self, forKey: .replayed))
        } else {
            try AidenPeerWire.closed(decoder, ["ok", "code", "error", "snapshot"])
            let error = try c.decode(String.self, forKey: .error); try AidenPeerWire.text(error, scalars: 1000, bytes: 2048)
            self = .rejected(code: try c.decode(AidenPeerErrorCode.self, forKey: .code), error: error, snapshot: try AidenPeerWire.optional(AidenPeerSettings.self, c, .snapshot))
        }
    }
    private enum CodingKeys: String, CodingKey { case ok, snapshot, mutationId, replayed, code, error }
}
enum AidenPeerExchangeKind: String, Codable, Sendable { case request, question, status, fyi }
enum AidenPeerExchangeState: String, Codable, Sendable { case waiting, queued, running, interrupted, stopping, completed, failed, cancelled, expired, uncertain }
enum AidenPeerDirection: String, Codable, Sendable { case sent, received }
enum AidenPeerReturnState: String, Codable, Sendable { case reserved, waiting, queued, delivered, notApplicable = "not_applicable" }
struct AidenPeerStopReceipt: Decodable, Equatable, Sendable {
    enum State: String, Decodable, Sendable { case requested, uncertain, stopped, notRunning = "not_running", blocked
        var terminal: Bool { self != .requested && self != .uncertain }
    }
    enum Reason: String, Decodable, Sendable { case mixedInputs = "mixed_inputs", hostUnavailable = "host_unavailable", staleSource = "stale_source" }
    let mutationId: UUID; let state: State; let at: Int; let reason: Reason?
    init(from decoder: Decoder) throws {
        try AidenPeerWire.closed(decoder, ["mutationId", "state", "at", "reason"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mutationId = try AidenOpenWorkWire.uuid(c.decode(String.self, forKey: .mutationId)); state = try c.decode(State.self, forKey: .state)
        at = try c.decode(Int.self, forKey: .at); try AidenOpenWorkWire.timestamp(at); reason = try AidenPeerWire.optional(Reason.self, c, .reason)
    }
    private enum CodingKeys: String, CodingKey { case mutationId, state, at, reason }
}
struct AidenPeerExchangeSummary: Decodable, Equatable, Identifiable, Sendable {
    let id: String; let revision: String; let pairId: String; let sender: AidenPeerIdentity; let recipient: AidenPeerIdentity
    let direction: AidenPeerDirection; let kind: AidenPeerExchangeKind; let title: String; let state: AidenPeerExchangeState
    let createdAt: Int; let updatedAt: Int; let expiresAt: Int; let canStop: Bool; let returnState: AidenPeerReturnState
    let parentExchangeId: String?; let rootExchangeId: String?; let blockedReason: String?; let lastStop: AidenPeerStopReceipt?
    init(from decoder: Decoder) throws { try self.init(from: decoder, detail: false) }
    init(from decoder: Decoder, detail: Bool) throws {
        var keys: Set<String> = ["id", "revision", "pairId", "sender", "recipient", "direction", "kind", "title", "state", "createdAt", "updatedAt", "expiresAt", "canStop", "returnState", "parentExchangeId", "rootExchangeId", "blockedReason", "lastStop"]
        if detail { keys.formUnion(["request", "result"]) }; try AidenPeerWire.closed(decoder, keys)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenOpenWorkWire.identity(c, .id); revision = try AidenOpenWorkWire.identity(c, .revision); pairId = try AidenOpenWorkWire.identity(c, .pairId)
        sender = try c.decode(AidenPeerIdentity.self, forKey: .sender); recipient = try c.decode(AidenPeerIdentity.self, forKey: .recipient)
        guard sender.botId != recipient.botId else { throw AidenRemoteClientError.invalidResponse }
        direction = try c.decode(AidenPeerDirection.self, forKey: .direction); kind = try c.decode(AidenPeerExchangeKind.self, forKey: .kind)
        title = try c.decode(String.self, forKey: .title); try AidenPeerWire.text(title); state = try c.decode(AidenPeerExchangeState.self, forKey: .state)
        createdAt = try c.decode(Int.self, forKey: .createdAt); updatedAt = try c.decode(Int.self, forKey: .updatedAt); expiresAt = try c.decode(Int.self, forKey: .expiresAt)
        for stamp in [createdAt, updatedAt, expiresAt] { try AidenOpenWorkWire.timestamp(stamp) }
        canStop = try c.decode(Bool.self, forKey: .canStop); returnState = try c.decode(AidenPeerReturnState.self, forKey: .returnState)
        parentExchangeId = try AidenPeerWire.optional(String.self, c, .parentExchangeId); rootExchangeId = try AidenPeerWire.optional(String.self, c, .rootExchangeId)
        for id in [parentExchangeId, rootExchangeId].compactMap({ $0 }) { try AidenPeerWire.id(id) }
        blockedReason = try AidenPeerWire.optional(String.self, c, .blockedReason); if let blockedReason { try AidenPeerWire.text(blockedReason, scalars: 1000, bytes: 2048) }
        lastStop = try AidenPeerWire.optional(AidenPeerStopReceipt.self, c, .lastStop)
    }
    private enum CodingKeys: String, CodingKey { case id, revision, pairId, sender, recipient, direction, kind, title, state, createdAt, updatedAt, expiresAt, canStop, returnState, parentExchangeId, rootExchangeId, blockedReason, lastStop }
}
struct AidenPeerExchangeDetail: Decodable, Equatable, Identifiable, Sendable {
    struct Request: Decodable, Equatable, Sendable {
        let text: String
        init(from decoder: Decoder) throws { try AidenPeerWire.closed(decoder, ["text"]); let c = try decoder.container(keyedBy: CodingKeys.self); text = try c.decode(String.self, forKey: .text); try AidenPeerWire.text(text, scalars: 8192, bytes: 8192) }
        private enum CodingKeys: String, CodingKey { case text }
    }
    struct Result: Decodable, Equatable, Sendable {
        enum Outcome: String, Decodable, Sendable { case completed, failed, cancelled, expired }
        let outcome: Outcome; let text: String; let truncated: Bool; let createdAt: Int
        init(from decoder: Decoder) throws {
            try AidenPeerWire.closed(decoder, ["outcome", "text", "truncated", "createdAt"]); let c = try decoder.container(keyedBy: CodingKeys.self)
            outcome = try c.decode(Outcome.self, forKey: .outcome); text = try c.decode(String.self, forKey: .text); try AidenPeerWire.text(text, scalars: 16384, bytes: 16384, empty: true)
            truncated = try c.decode(Bool.self, forKey: .truncated); createdAt = try c.decode(Int.self, forKey: .createdAt); try AidenOpenWorkWire.timestamp(createdAt)
        }
        private enum CodingKeys: String, CodingKey { case outcome, text, truncated, createdAt }
    }
    let summary: AidenPeerExchangeSummary; var id: String { summary.id }; let request: Request; let result: Result?
    init(from decoder: Decoder) throws {
        summary = try AidenPeerExchangeSummary(from: decoder, detail: true); let c = try decoder.container(keyedBy: CodingKeys.self)
        request = try c.decode(Request.self, forKey: .request); result = try AidenPeerWire.optional(Result.self, c, .result)
    }
    private enum CodingKeys: String, CodingKey { case request, result }
}
struct AidenPeerExchangeList: Decodable, Equatable, Sendable {
    let botId: String; let revision: String; let exchanges: [AidenPeerExchangeSummary]
    init(from decoder: Decoder) throws {
        try AidenPeerWire.closed(decoder, ["botId", "revision", "exchanges"]); let c = try decoder.container(keyedBy: CodingKeys.self)
        botId = try AidenOpenWorkWire.identity(c, .botId); revision = try AidenOpenWorkWire.identity(c, .revision); exchanges = try c.decode([AidenPeerExchangeSummary].self, forKey: .exchanges)
        try AidenPeerWire.unique(exchanges.map(\.id)); guard exchanges.allSatisfy({ AidenPeerWire.owns($0, botID: botId) }) else { throw AidenRemoteClientError.invalidResponse }
    }
    private enum CodingKeys: String, CodingKey { case botId, revision, exchanges }
}
struct AidenPeerStopMutation: Codable, Equatable, Sendable {
    let botId: String; let exchangeId: String; let mutationId: UUID; let expectedRevision: String
    init(botId: String, exchangeId: String, mutationId: UUID = UUID(), expectedRevision: String) { self.botId = botId; self.exchangeId = exchangeId; self.mutationId = mutationId; self.expectedRevision = expectedRevision }
    func validate() throws { for value in [botId, exchangeId, expectedRevision] { try AidenPeerWire.id(value) }; _ = try AidenOpenWorkWire.uuid(mutationId.uuidString) }
    init(from decoder: Decoder) throws {
        try AidenPeerWire.closed(decoder, ["botId", "exchangeId", "mutationId", "expectedRevision"]); let c = try decoder.container(keyedBy: CodingKeys.self)
        botId = try c.decode(String.self, forKey: .botId); exchangeId = try c.decode(String.self, forKey: .exchangeId); mutationId = try AidenOpenWorkWire.uuid(c.decode(String.self, forKey: .mutationId)); expectedRevision = try c.decode(String.self, forKey: .expectedRevision); try validate()
    }
    private enum CodingKeys: String, CodingKey { case botId, exchangeId, mutationId, expectedRevision }
}
enum AidenPeerStopResult: Decodable, Equatable, Sendable {
    case accepted(exchange: AidenPeerExchangeDetail, mutationId: UUID, replayed: Bool)
    case rejected(code: AidenPeerErrorCode, error: String, exchange: AidenPeerExchangeDetail?)
    var exchange: AidenPeerExchangeDetail? { switch self { case let .accepted(exchange, _, _): exchange; case let .rejected(_, _, exchange): exchange } }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if try c.decode(Bool.self, forKey: .ok) {
            try AidenPeerWire.closed(decoder, ["ok", "exchange", "mutationId", "replayed"])
            self = .accepted(exchange: try c.decode(AidenPeerExchangeDetail.self, forKey: .exchange), mutationId: try AidenOpenWorkWire.uuid(c.decode(String.self, forKey: .mutationId)), replayed: try c.decode(Bool.self, forKey: .replayed))
        } else {
            try AidenPeerWire.closed(decoder, ["ok", "code", "error", "exchange"]); let error = try c.decode(String.self, forKey: .error); try AidenPeerWire.text(error, scalars: 1000, bytes: 2048)
            self = .rejected(code: try c.decode(AidenPeerErrorCode.self, forKey: .code), error: error, exchange: try AidenPeerWire.optional(AidenPeerExchangeDetail.self, c, .exchange))
        }
    }
    private enum CodingKeys: String, CodingKey { case ok, exchange, mutationId, replayed, code, error }
}
struct AidenPeerEvidence: Decodable, Equatable, Sendable {
    let exchangeId: String; let kind: AidenOpenWorkEvidenceKind; let botId: String; let submissionId: String; let entryId: String
    let title: String; let text: String; let truncated: Bool; let createdAt: Int?
    init(from decoder: Decoder) throws {
        try AidenPeerWire.closed(decoder, ["exchangeId", "kind", "botId", "submissionId", "entryId", "title", "text", "truncated", "createdAt"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        exchangeId = try AidenOpenWorkWire.identity(c, .exchangeId); kind = try c.decode(AidenOpenWorkEvidenceKind.self, forKey: .kind); botId = try AidenOpenWorkWire.identity(c, .botId)
        submissionId = try c.decode(String.self, forKey: .submissionId); entryId = try c.decode(String.self, forKey: .entryId); try AidenOpenWorkWire.decimal(submissionId); try AidenOpenWorkWire.decimal(entryId)
        title = try c.decode(String.self, forKey: .title); try AidenPeerWire.text(title); text = try c.decode(String.self, forKey: .text); try AidenPeerWire.text(text, scalars: 32768, bytes: 32768, empty: true)
        truncated = try c.decode(Bool.self, forKey: .truncated); createdAt = try AidenPeerWire.optional(Int.self, c, .createdAt); if let createdAt { try AidenOpenWorkWire.timestamp(createdAt) }
    }
    private enum CodingKeys: String, CodingKey { case exchangeId, kind, botId, submissionId, entryId, title, text, truncated, createdAt }
}
