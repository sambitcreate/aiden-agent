import Foundation

struct AidenOpenWorkPatch: Codable, Equatable, Sendable {
    var title: String?
    var note: String?
    var state: AidenOpenWorkState?
    var waitingReason: String?
    func validate() throws {
        guard title != nil || note != nil || state != nil || waitingReason != nil else { throw AidenBotContractError.invalidField("empty Open work patch") }
        if let title { try AidenOpenWorkWire.text(title, scalars: 160, bytes: 640) }
        if let note { try AidenOpenWorkWire.text(note, scalars: 1000, bytes: 2048, empty: true) }
        if let waitingReason { try AidenOpenWorkWire.text(waitingReason, scalars: 160, bytes: 640) }
        if let state {
            guard (state == .waiting) == (waitingReason != nil) else { throw AidenBotContractError.invalidField("waiting reason") }
        }
    }
}

/// Only owner-authored metadata and host-issued item/Undo IDs can be encoded.
struct AidenOpenWorkMutation: Codable, Equatable, Sendable {
    enum Action: String, Codable, Sendable {
        case add, edit, dismiss, stop, stopAndDismiss = "stop_and_dismiss", undo
        var isStop: Bool { self == .stop || self == .stopAndDismiss }
        var isReversible: Bool { self == .add || self == .edit || self == .dismiss }
    }
    let mutationId: UUID
    let action: Action
    let expectedRevision: String
    let id: String?
    let title: String?
    let note: String?
    let patch: AidenOpenWorkPatch?
    let undoOf: UUID?

    init(action: Action, expectedRevision: String, id: String? = nil, title: String? = nil, note: String? = nil,
         patch: AidenOpenWorkPatch? = nil, undoOf: UUID? = nil, mutationId: UUID = UUID()) throws {
        self.action = action; self.expectedRevision = expectedRevision; self.id = id
        self.title = title; self.note = note; self.patch = patch; self.undoOf = undoOf; self.mutationId = mutationId
        try validate()
    }
    func validate() throws {
        try AidenOpenWorkWire.id(expectedRevision)
        _ = try AidenOpenWorkWire.uuid(mutationId.uuidString)
        switch action {
        case .add:
            guard let title, id == nil, patch == nil, undoOf == nil else { throw AidenBotContractError.invalidField("add") }
            try AidenOpenWorkWire.text(title, scalars: 160, bytes: 640)
            if let note { try AidenOpenWorkWire.text(note, scalars: 1000, bytes: 2048, empty: true) }
        case .edit:
            guard let id, let patch, title == nil, note == nil, undoOf == nil else { throw AidenBotContractError.invalidField("edit") }
            try AidenOpenWorkWire.id(id)
            try patch.validate()
        case .dismiss, .stop, .stopAndDismiss:
            guard let id, title == nil, note == nil, patch == nil, undoOf == nil else { throw AidenBotContractError.invalidField("item action") }
            try AidenOpenWorkWire.id(id)
        case .undo:
            guard let undoOf, id == nil, title == nil, note == nil, patch == nil else { throw AidenBotContractError.invalidField("undo") }
            _ = try AidenOpenWorkWire.uuid(undoOf.uuidString)
        }
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(action: c.decode(Action.self, forKey: .action), expectedRevision: c.decode(String.self, forKey: .expectedRevision),
            id: c.decodeIfPresent(String.self, forKey: .id), title: c.decodeIfPresent(String.self, forKey: .title),
            note: c.decodeIfPresent(String.self, forKey: .note), patch: c.decodeIfPresent(AidenOpenWorkPatch.self, forKey: .patch),
            undoOf: c.decodeIfPresent(String.self, forKey: .undoOf).map(AidenOpenWorkWire.uuid),
            mutationId: AidenOpenWorkWire.uuid(c.decode(String.self, forKey: .mutationId)))
    }
    private enum CodingKeys: String, CodingKey { case mutationId, action, expectedRevision, id, title, note, patch, undoOf }
}

enum AidenOpenWorkErrorCode: String, Codable, Sendable {
    case invalid, notFound = "not_found", stale, activeFull = "active_full", historyFull = "history_full"
    case receiptsFull = "receipts_full", mutationConflict = "mutation_conflict", undoConflict = "undo_conflict"
    case undoExpired = "undo_expired", mixedInputs = "mixed_inputs", unavailable, deleted
    var explanation: String {
        switch self {
        case .invalid: "Review the title, note and state before saving."
        case .notFound, .deleted: "This item or Bot was removed on your host. Your draft is kept."
        case .stale: "This item changed on your host. Your draft is kept; review the saved version before trying again."
        case .activeFull: "This Bot already has 64 active items. Finish or dismiss an item before adding another."
        case .historyFull: "This Bot’s retained history is full. Review Open work on your host."
        case .receiptsFull: "The host is retaining earlier changes for safe retry and Undo. Try again later."
        case .mutationConflict: "This request identity is already bound to another change. Inspect Open work on your host."
        case .undoConflict: "This item changed after that action. Undo won’t overwrite the newer change."
        case .undoExpired: "This Undo has expired. The saved item has not changed."
        case .mixedInputs: "This run includes other inputs. Stop it on your host to avoid interrupting unrelated work."
        case .unavailable: "The host may have saved this request. Check its state or retry the same request."
        }
    }
}

enum AidenOpenWorkResult: Decodable, Equatable, Sendable {
    struct Accepted: Decodable, Equatable, Sendable {
        let mutationId: UUID
        let replayed: Bool
        let itemId: String?
        let snapshot: AidenOpenWorkSnapshot
        let undo: AidenOpenWorkUndo?
        let stop: AidenOpenWorkStop?
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            mutationId = try AidenOpenWorkWire.uuid(c.decode(String.self, forKey: .mutationId))
            replayed = try c.decode(Bool.self, forKey: .replayed)
            itemId = try c.decodeIfPresent(String.self, forKey: .itemId)
            if let itemId { try AidenOpenWorkWire.id(itemId) }
            snapshot = try c.decode(AidenOpenWorkSnapshot.self, forKey: .snapshot)
            undo = try c.decodeIfPresent(AidenOpenWorkUndo.self, forKey: .undo)
            stop = try c.decodeIfPresent(AidenOpenWorkStop.self, forKey: .stop)
            guard undo == nil || undo?.mutationId == mutationId, stop == nil || stop?.mutationId == mutationId else {
                throw AidenBotContractError.invalidField("Open work receipt identity")
            }
        }
        private enum CodingKeys: String, CodingKey { case mutationId, replayed, itemId, snapshot, undo, stop }
    }
    struct Rejected: Decodable, Equatable, Sendable {
        let code: AidenOpenWorkErrorCode
        let error: String
        let snapshot: AidenOpenWorkSnapshot?
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            code = try c.decode(AidenOpenWorkErrorCode.self, forKey: .code)
            error = try AidenOpenWorkWire.string(c, .error, scalars: 280, bytes: 1120)
            snapshot = try c.decodeIfPresent(AidenOpenWorkSnapshot.self, forKey: .snapshot)
        }
        private enum CodingKeys: String, CodingKey { case code, error, snapshot }
    }
    case accepted(Accepted), rejected(Rejected)
    var snapshot: AidenOpenWorkSnapshot? {
        switch self { case let .accepted(receipt): receipt.snapshot; case let .rejected(refusal): refusal.snapshot }
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self = try c.decode(Bool.self, forKey: .ok) ? .accepted(Accepted(from: decoder)) : .rejected(Rejected(from: decoder))
    }
    private enum CodingKeys: String, CodingKey { case ok }
}

enum AidenOpenWorkEvidenceKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case source, result
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

struct AidenOpenWorkEvidence: Decodable, Equatable, Sendable {
    let itemId: String
    let kind: AidenOpenWorkEvidenceKind
    let submissionId: String
    let entryId: String
    let title: String
    let text: String
    let truncated: Bool
    let createdAt: Int?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = try AidenOpenWorkWire.identity(c, .itemId)
        kind = try c.decode(AidenOpenWorkEvidenceKind.self, forKey: .kind)
        submissionId = try c.decode(String.self, forKey: .submissionId)
        entryId = try c.decode(String.self, forKey: .entryId)
        try AidenOpenWorkWire.decimal(submissionId)
        try AidenOpenWorkWire.decimal(entryId)
        title = try AidenOpenWorkWire.string(c, .title, scalars: 160, bytes: 640)
        text = try AidenOpenWorkWire.string(c, .text, scalars: 32768, bytes: 32768, empty: true)
        truncated = try c.decode(Bool.self, forKey: .truncated)
        createdAt = try c.decodeIfPresent(Int.self, forKey: .createdAt)
        if let createdAt { try AidenOpenWorkWire.timestamp(createdAt) }
    }
    private enum CodingKeys: String, CodingKey { case itemId, kind, submissionId, entryId, title, text, truncated, createdAt }
}

extension AidenOpenWorkResult: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botOpenWorkResult") }
}
extension AidenOpenWorkEvidence: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botOpenWorkEvidence") }
}
