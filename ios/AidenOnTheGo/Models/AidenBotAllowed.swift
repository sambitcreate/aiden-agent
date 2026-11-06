import Foundation

/// Remote 57 exposes display data only, never matching targets or private approval evidence.
struct AidenBotAllowedEntry: Decodable, Equatable, Identifiable, Sendable {
    enum Kind: String, Decodable { case rule, folder }
    let id: String
    let kind: Kind
    let what: String
    let addedAt: AidenRemoteTimestamp
    let uses: Int?
    let lastUsedAt: AidenRemoteTimestamp?
    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["id", "kind", "what", "addedAt", "uses", "lastUsedAt"])
        let v = try decoder.container(keyedBy: CodingKeys.self)
        id = try v.decode(String.self, forKey: .id)
        kind = try v.decode(Kind.self, forKey: .kind)
        what = try v.decode(String.self, forKey: .what)
        try AidenBotPlanWire.text(what, maximum: 200)
        addedAt = try v.decode(AidenRemoteTimestamp.self, forKey: .addedAt)
        uses = try AidenBotWire.optional(Int.self, from: v, forKey: .uses)
        lastUsedAt = try AidenBotWire.optional(AidenRemoteTimestamp.self, from: v, forKey: .lastUsedAt)
        guard Self.validID(id), !what.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              what.unicodeScalars.count <= 200,
              !what.unicodeScalars.contains(where: { $0.value < 9 || (14...31).contains($0.value) || (127...159).contains($0.value) }),
              kind == .rule ? (uses != nil && uses! >= 0 && uses! <= 9_007_199_254_740_991 && (lastUsedAt == nil || uses! > 0)) : (!v.contains(.uses) && !v.contains(.lastUsedAt)) else {
            throw AidenBotContractError.invalidField("allowed.entry")
        }
    }
    static func validID(_ text: String) -> Bool { text.range(of: "\\A[A-Za-z0-9_-]{1,80}\\z", options: .regularExpression) != nil }
    private enum CodingKeys: String, CodingKey { case id, kind, what, addedAt, uses, lastUsedAt }
}
struct AidenBotAllowedList: Decodable, Equatable, Sendable {
    let botId: String
    let entries: [AidenBotAllowedEntry]
    let nextCursor: String?
    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["botId", "entries", "nextCursor"])
        let v = try decoder.container(keyedBy: CodingKeys.self)
        botId = try v.decode(String.self, forKey: .botId)
        try AidenBotWire.validateIdentifier(botId, field: "botId", maxLength: AidenRemoteProtocol.maxBotIdentifierLength)
        entries = try v.decode([AidenBotAllowedEntry].self, forKey: .entries)
        nextCursor = try AidenBotWire.optional(String.self, from: v, forKey: .nextCursor)
        guard entries.count <= 50, Set(entries.map(\.id)).count == entries.count,
              nextCursor == nil || Self.validCursor(nextCursor!) else { throw AidenBotContractError.invalidField("allowed.list") }
    }
    static func validCursor(_ text: String) -> Bool { text.range(of: "\\Acur_[A-Za-z0-9_-]{43}\\z", options: .regularExpression) != nil }
    private enum CodingKeys: String, CodingKey { case botId, entries, nextCursor }
}

extension AidenBotAllowedList: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botAllowed") }
}

func aidenBotAllowedSupported(_ installation: AidenInstallation?) -> Bool {
    installation?.isBotsEligible == true && installation?.hasNegotiatedAccess(to: .botAllowed) == true
}
