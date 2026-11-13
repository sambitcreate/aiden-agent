import Foundation

// Contract revision 61 (provisional): Phase 6 of the Bot UX simplification on
// the wire (`docs/aiden-remote-api-v1.md`, "Bot UX on phones, revision 61").
// Each shape is decoded as strictly as the host's own parsers
// (`main/services/aiden-remote-bot-ux.ts`, `parseAidenRemotePhoneStreamApproval`)
// so the shared `bot-ux-revision-61.json` fixture round-trips the same way.

enum AidenBotUXWire {
    static let cardTitleMax = 200
    static let cardArgumentsMax = 16
    static let cardKeyMax = 40
    static let cardValueMax = 500
    static let cardBodyMax = 16_000
    static let cardRowsMax = 60
    static let cardNotesMax = 6
    static let cardNoteMax = 400
    static let cardButtonsMax = 5
    static let cardButtonLabelMax = 80
    static let cardAllowOnMacMax = 120
    static let instructionsMax = 32_000
    static let diffLinesMax = 2_000
    static let skillPreviewMax = 16_000
    static let templateSampleLines = 8
    static let templateSampleLineMax = 280

    /// A bounded string, in Unicode scalars (the host counts code points). Unless
    /// `blank` is allowed it must hold something besides whitespace.
    static func text(_ value: String, field: String, max: Int, blank: Bool = false) throws -> String {
        guard value.unicodeScalars.count <= max,
              blank || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AidenBotContractError.invalidField(field)
        }
        return value
    }

    static func text<Key: CodingKey>(
        _ values: KeyedDecodingContainer<Key>, _ key: Key, max: Int, blank: Bool = false
    ) throws -> String {
        try text(try values.decode(String.self, forKey: key), field: key.stringValue, max: max, blank: blank)
    }

    static func optionalText<Key: CodingKey>(
        _ values: KeyedDecodingContainer<Key>, _ key: Key, max: Int, blank: Bool = false
    ) throws -> String? {
        guard values.contains(key) else { return nil }
        return try text(values, key, max: max, blank: blank)
    }

    /// `^[A-Za-z0-9._:-]{1,160}$`, the host's opaque id grammar for these shapes.
    static func opaqueID<Key: CodingKey>(_ values: KeyedDecodingContainer<Key>, _ key: Key) throws -> String {
        let value = try values.decode(String.self, forKey: key)
        try AidenBotWire.validateIdentifier(value, field: key.stringValue, maxLength: 160)
        return value
    }

    static func timestamp<Key: CodingKey>(_ values: KeyedDecodingContainer<Key>, _ key: Key) throws -> AidenRemoteTimestamp? {
        try AidenBotWire.optional(AidenRemoteTimestamp.self, from: values, forKey: key)
    }
}

// MARK: - The typed approval card (`approval:cards`)

enum AidenApprovalCardKind: String, Codable, Sendable {
    case generic, explicit, mac, batch, schedule
    case heldChange = "held_change"
}

enum AidenApprovalCardMac: String, Codable, Sendable {
    case shell, files
    case computerUse = "computer_use"
}

/// A remembered allow on a button. A one-time allow and Deny carry none.
enum AidenApprovalCardScope: String, Codable, Sendable {
    case chat, always

    var approvalScope: AidenApprovalScope { self == .chat ? .chat : .always }
}

struct AidenApprovalCardText: Codable, Equatable, Sendable {
    enum Format: String, Codable, Sendable { case command, text }
    let format: Format
    let text: String

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["format", "text"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        format = try values.decode(Format.self, forKey: .format)
        text = try AidenBotUXWire.text(values, .text, max: AidenBotUXWire.cardBodyMax)
    }

    private enum CodingKeys: String, CodingKey { case format, text }
}

struct AidenApprovalCardArgument: Codable, Equatable, Sendable {
    let key: String
    let value: String

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["key", "value"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        key = try AidenBotUXWire.text(values, .key, max: AidenBotUXWire.cardKeyMax)
        value = try AidenBotUXWire.text(values, .value, max: AidenBotUXWire.cardValueMax)
    }

    private enum CodingKeys: String, CodingKey { case key, value }
}

struct AidenApprovalCardRow: Codable, Equatable, Sendable {
    let label: String
    let value: String

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["label", "value"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        label = try AidenBotUXWire.text(values, .label, max: AidenBotUXWire.cardKeyMax * 2)
        value = try AidenBotUXWire.text(values, .value, max: AidenBotUXWire.cardValueMax, blank: true)
    }

    private enum CodingKeys: String, CodingKey { case label, value }
}

/// One button. Pressing it sends exactly its `decision` and `scope` to the
/// approval's existing respond route, and `answered` is the line shown after.
struct AidenApprovalCardButton: Codable, Equatable, Hashable, Sendable {
    let label: String
    let decision: AidenApprovalDecision
    let scope: AidenApprovalCardScope?
    let answered: String

    init(label: String, decision: AidenApprovalDecision, scope: AidenApprovalCardScope? = nil, answered: String) {
        self.label = label
        self.decision = decision
        self.scope = scope
        self.answered = answered
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["label", "decision", "scope", "answered"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        decision = try values.decode(AidenApprovalDecision.self, forKey: .decision)
        scope = try AidenBotWire.optional(AidenApprovalCardScope.self, from: values, forKey: .scope)
        guard scope == nil || decision == .allow else {
            throw AidenBotContractError.invalidCombination("only an allow button carries a scope")
        }
        label = try AidenBotUXWire.text(values, .label, max: AidenBotUXWire.cardButtonLabelMax)
        answered = try AidenBotUXWire.text(values, .answered, max: AidenBotUXWire.cardButtonLabelMax)
    }

    /// The scope a respond request carries: nil for Deny and a one-time allow.
    var requestScope: AidenApprovalScope? { decision == .allow ? scope?.approvalScope : nil }
    /// The scope as the summary fields name it (`once` for a one-time allow).
    var offeredScope: AidenApprovalScope { scope?.approvalScope ?? .once }

    private enum CodingKeys: String, CodingKey { case label, decision, scope, answered }
}

/// The one card model the desktop and the wire share
/// (`renderer/shared/approval-card-model.ts`). It is complete or deny-only:
/// `allowOnMac` is present exactly when no allow button is.
struct AidenApprovalCardModel: Codable, Equatable, Sendable {
    let kind: AidenApprovalCardKind
    let mac: AidenApprovalCardMac?
    let title: String
    let arguments: [AidenApprovalCardArgument]
    let body: AidenApprovalCardText?
    let previous: AidenApprovalCardText?
    let rows: [AidenApprovalCardRow]?
    let notes: [String]?
    /// Deny first, then the allow buttons the desktop offers.
    let buttons: [AidenApprovalCardButton]
    let allowOnMac: String?

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(
            decoder,
            allowed: ["kind", "mac", "title", "arguments", "body", "previous", "rows", "notes", "buttons", "allowOnMac"]
        )
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(AidenApprovalCardKind.self, forKey: .kind)
        mac = try AidenBotWire.optional(AidenApprovalCardMac.self, from: values, forKey: .mac)
        guard mac == nil || kind == .mac else {
            throw AidenBotContractError.invalidCombination("only a Mac card names a part of the Mac")
        }
        buttons = try values.decode([AidenApprovalCardButton].self, forKey: .buttons)
        guard (1...AidenBotUXWire.cardButtonsMax).contains(buttons.count), buttons[0].decision == .deny else {
            throw AidenBotContractError.invalidField("buttons")
        }
        let allows = buttons.contains { $0.decision == .allow }
        guard values.contains(.allowOnMac) != allows else {
            throw AidenBotContractError.invalidCombination("allowOnMac exactly when no allow button")
        }
        title = try AidenBotUXWire.text(values, .title, max: AidenBotUXWire.cardTitleMax)
        arguments = try values.decode([AidenApprovalCardArgument].self, forKey: .arguments)
        guard arguments.count <= AidenBotUXWire.cardArgumentsMax else { throw AidenBotContractError.invalidField("arguments") }
        body = try AidenBotWire.optional(AidenApprovalCardText.self, from: values, forKey: .body)
        previous = try AidenBotWire.optional(AidenApprovalCardText.self, from: values, forKey: .previous)
        rows = try AidenBotWire.optional([AidenApprovalCardRow].self, from: values, forKey: .rows)
        guard (rows?.count ?? 0) <= AidenBotUXWire.cardRowsMax else { throw AidenBotContractError.invalidField("rows") }
        if values.contains(.notes) {
            let raw = try values.decode([String].self, forKey: .notes)
            guard raw.count <= AidenBotUXWire.cardNotesMax else { throw AidenBotContractError.invalidField("notes") }
            notes = try raw.map { try AidenBotUXWire.text($0, field: "notes", max: AidenBotUXWire.cardNoteMax) }
        } else {
            notes = nil
        }
        allowOnMac = try AidenBotUXWire.optionalText(values, .allowOnMac, max: AidenBotUXWire.cardAllowOnMacMax)
    }

    var denyButton: AidenApprovalCardButton { buttons[0] }
    var allowButtons: [AidenApprovalCardButton] { buttons.filter { $0.decision == .allow } }
    /// The allow buttons the answer route can send: a one-time allow always,
    /// a wider scope only when the route takes it for this approval.
    func allowButtons(sendable scopes: Set<AidenApprovalScope>) -> [AidenApprovalCardButton] {
        allowButtons.filter { $0.offeredScope == .once || scopes.contains($0.offeredScope) }
    }

    /// The card has an allow button: the same as the summary's `canAllow`.
    var canAllow: Bool { !allowButtons.isEmpty }

    /// Whether a button offers this answer. Deny is always offered; an allow
    /// must match a button's scope (`once` for a one-time allow).
    func offers(_ decision: AidenApprovalDecision, scope: AidenApprovalScope? = nil) -> Bool {
        decision == .deny || allowButtons.contains { $0.offeredScope == (scope ?? .once) }
    }

    /// Strict check of the summary fields a revision-61 approval carries beside
    /// its card: `canAllow` is exactly whether it has an allow button, and every
    /// offered scope is one a button offers.
    func validateSummary(canAllow: Bool, scopes: [String]?) throws {
        guard canAllow == self.canAllow else {
            throw AidenBotContractError.invalidCombination("canAllow must match its card")
        }
        for raw in scopes ?? [] {
            guard let scope = AidenApprovalScope(rawValue: raw), offers(.allow, scope: scope) else {
                throw AidenBotContractError.invalidCombination("scopes must be ones its card offers")
            }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, mac, title, arguments, body, previous, rows, notes, buttons, allowOnMac
    }
}

// MARK: - Bot session entries (`bot:settings-changes`, `bot:suggestions`)

enum AidenBotSettingsField: String, Codable, Sendable, CaseIterable {
    case name, description, look, instructions, selfWakeUps, interruptions, model
}

/// A held `update_bot` card (Apply / Dismiss while pending; Edit happens on
/// the Mac) or an applied-change receipt (Undo while pending and undoable).
struct AidenBotSettingsChangeEntry: Codable, Equatable, Sendable {
    enum Mode: String, Codable, Sendable { case applied, held }
    enum Status: String, Codable, Sendable {
        case pending, restored, applied, edited, dismissed
        case undoRefused = "undo_refused"
    }
    enum HeldReason: String, Codable, Sendable {
        case notOwner = "not_owner"
        case outsideContent = "outside_content"
        case widens
    }
    struct DiffLine: Codable, Equatable, Sendable {
        enum Kind: String, Codable, Sendable { case same, added, removed }
        let kind: Kind
        let text: String

        init(kind: Kind, text: String) { self.kind = kind; self.text = text }

        init(from decoder: Decoder) throws {
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "text"])
            let values = try decoder.container(keyedBy: CodingKeys.self)
            kind = try values.decode(Kind.self, forKey: .kind)
            text = try AidenBotUXWire.text(values, .text, max: 4_000, blank: true)
        }

        private enum CodingKeys: String, CodingKey { case kind, text }
    }

    let type = "settings_change"
    let id: String
    let changeId: String
    let mode: Mode
    var status: Status
    let title: String
    let fields: [AidenBotSettingsField]
    let lines: [String]
    let heldReason: HeldReason?
    let instructions: String?
    let previousInstructions: String?
    let instructionsDiff: [DiffLine]?
    let undoable: Bool
    let createdAt: AidenRemoteTimestamp?

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: [
            "type", "id", "changeId", "mode", "status", "title", "fields", "lines", "heldReason",
            "instructions", "previousInstructions", "instructionsDiff", "undoable", "createdAt",
        ])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        try AidenBotSessionWire.validateEntryID(id, field: "entry.id")
        mode = try values.decode(Mode.self, forKey: .mode)
        guard mode == .held || !(values.contains(.heldReason) || values.contains(.instructions) || values.contains(.previousInstructions)) else {
            throw AidenBotContractError.invalidCombination("only a held change carries a reason and proposed instructions")
        }
        changeId = try AidenBotUXWire.opaqueID(values, .changeId)
        status = try values.decode(Status.self, forKey: .status)
        title = try AidenBotUXWire.text(values, .title, max: 80)
        fields = try values.decode([AidenBotSettingsField].self, forKey: .fields)
        guard fields.count <= AidenBotSettingsField.allCases.count else { throw AidenBotContractError.invalidField("fields") }
        let rawLines = try values.decode([String].self, forKey: .lines)
        guard rawLines.count <= 10 else { throw AidenBotContractError.invalidField("lines") }
        lines = try rawLines.map { try AidenBotUXWire.text($0, field: "lines", max: 400) }
        heldReason = try AidenBotWire.optional(HeldReason.self, from: values, forKey: .heldReason)
        instructions = try AidenBotUXWire.optionalText(values, .instructions, max: AidenBotUXWire.instructionsMax, blank: true)
        previousInstructions = try AidenBotUXWire.optionalText(values, .previousInstructions, max: AidenBotUXWire.instructionsMax, blank: true)
        instructionsDiff = try AidenBotWire.optional([DiffLine].self, from: values, forKey: .instructionsDiff)
        guard (instructionsDiff?.count ?? 0) <= AidenBotUXWire.diffLinesMax else { throw AidenBotContractError.invalidField("instructionsDiff") }
        undoable = try values.decode(Bool.self, forKey: .undoable)
        createdAt = try AidenBotUXWire.timestamp(values, .createdAt)
    }

    var isHeld: Bool { mode == .held }
    var isWaiting: Bool { status == .pending }

    private enum CodingKeys: String, CodingKey {
        case type, id, changeId, mode, status, title, fields, lines, heldReason
        case instructions, previousInstructions, instructionsDiff, undoable, createdAt
    }
}

/// A skill the Bot suggests (Add / Not now while pending).
struct AidenBotSkillProposalEntry: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable { case pending, added, dismissed }

    let type = "skill_proposal"
    let id: String
    let proposalId: String
    let name: String
    let description: String
    let reason: String?
    let update: Bool
    let preview: String
    /// The preview was cut to fit: such a skill is added on the Mac only.
    let previewTruncated: Bool
    var status: Status
    let createdAt: AidenRemoteTimestamp?

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: [
            "type", "id", "proposalId", "name", "description", "reason", "update", "preview",
            "previewTruncated", "status", "createdAt",
        ])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        try AidenBotSessionWire.validateEntryID(id, field: "entry.id")
        if values.contains(.previewTruncated) {
            guard try values.decode(Bool.self, forKey: .previewTruncated) else {
                throw AidenBotContractError.invalidField("previewTruncated")
            }
            previewTruncated = true
        } else {
            previewTruncated = false
        }
        proposalId = try AidenBotUXWire.opaqueID(values, .proposalId)
        name = try AidenBotUXWire.text(values, .name, max: 120)
        description = try AidenBotUXWire.text(values, .description, max: 400, blank: true)
        reason = try AidenBotUXWire.optionalText(values, .reason, max: 400)
        update = try values.decode(Bool.self, forKey: .update)
        preview = try AidenBotUXWire.text(values, .preview, max: AidenBotUXWire.skillPreviewMax, blank: true)
        status = try values.decode(Status.self, forKey: .status)
        createdAt = try AidenBotUXWire.timestamp(values, .createdAt)
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(type, forKey: .type)
        try values.encode(id, forKey: .id)
        try values.encode(proposalId, forKey: .proposalId)
        try values.encode(name, forKey: .name)
        try values.encode(description, forKey: .description)
        try values.encodeIfPresent(reason, forKey: .reason)
        try values.encode(update, forKey: .update)
        try values.encode(preview, forKey: .preview)
        if previewTruncated { try values.encode(true, forKey: .previewTruncated) }
        try values.encode(status, forKey: .status)
        try values.encodeIfPresent(createdAt, forKey: .createdAt)
    }

    /// Add is offered only when the whole skill is here to review.
    var canAddHere: Bool { !previewTruncated }

    private enum CodingKeys: String, CodingKey {
        case type, id, proposalId, name, description, reason, update, preview, previewTruncated, status, createdAt
    }
}

/// A lesson the Bot proposes (Keep / Not now while pending) or a Learned line
/// (Undo while active).
struct AidenBotLessonEntry: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable { case proposal, learned }
    enum Status: String, Codable, Sendable { case pending, active, dismissed, retired }

    let type = "lesson"
    let id: String
    let lessonId: String
    let kind: Kind
    let text: String
    let routineName: String?
    let runs: Int?
    var status: Status
    let createdAt: AidenRemoteTimestamp?

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: [
            "type", "id", "lessonId", "kind", "text", "routineName", "runs", "status", "createdAt",
        ])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        try AidenBotSessionWire.validateEntryID(id, field: "entry.id")
        runs = try AidenBotWire.optional(Int.self, from: values, forKey: .runs)
        guard (runs ?? 0) >= 0, (runs ?? 0) <= AidenRemoteProtocol.maxSafeInteger else {
            throw AidenBotContractError.invalidField("runs")
        }
        lessonId = try AidenBotUXWire.opaqueID(values, .lessonId)
        kind = try values.decode(Kind.self, forKey: .kind)
        text = try AidenBotUXWire.text(values, .text, max: 400)
        routineName = try AidenBotUXWire.optionalText(values, .routineName, max: 200)
        status = try values.decode(Status.self, forKey: .status)
        createdAt = try AidenBotUXWire.timestamp(values, .createdAt)
    }

    private enum CodingKeys: String, CodingKey {
        case type, id, lessonId, kind, text, routineName, runs, status, createdAt
    }
}

/// "Tidied memory" receipt; Undo while `changeId` is present.
struct AidenBotMemoryTidyEntry: Codable, Equatable, Sendable {
    let type = "memory_tidy"
    let id: String
    var changeId: String?
    let createdAt: AidenRemoteTimestamp?

    init(id: String, changeId: String?, createdAt: AidenRemoteTimestamp?) {
        self.id = id
        self.changeId = changeId
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["type", "id", "changeId", "createdAt"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        try AidenBotSessionWire.validateEntryID(id, field: "entry.id")
        changeId = values.contains(.changeId) ? try AidenBotUXWire.opaqueID(values, .changeId) : nil
        createdAt = try AidenBotUXWire.timestamp(values, .createdAt)
    }

    private enum CodingKeys: String, CodingKey { case type, id, changeId, createdAt }
}

// MARK: - Bot item answers

enum AidenBotSettingsChangeDecision: String, Codable, Sendable { case apply, dismiss, undo }
enum AidenBotSkillProposalDecision: String, Codable, Sendable { case add, dismiss }
enum AidenBotLessonDecision: String, Codable, Sendable { case keep, dismiss }

/// Exactly `{decision}`.
struct AidenBotUXDecisionRequest<Decision: Codable & Sendable & Equatable>: Codable, Equatable, Sendable {
    let decision: Decision
}

struct AidenBotSettingsChangeReceipt: Codable, Equatable, Sendable {
    let changeId: String
    let status: AidenBotSettingsChangeEntry.Status
    let message: String?
}

struct AidenBotSkillProposalReceipt: Codable, Equatable, Sendable {
    let proposalId: String
    let status: AidenBotSkillProposalEntry.Status
}

struct AidenBotLessonReceipt: Codable, Equatable, Sendable {
    let lessonId: String
    let status: AidenBotLessonEntry.Status
}

struct AidenBotLearningUndoReceipt: Codable, Equatable, Sendable {
    let changeId: String
    let undone: Bool
}

// MARK: - Templates (`bot:templates`)

/// What a `bot:templates` holder reads beside each preset row.
struct AidenBotTemplateFields: Codable, Equatable, Sendable {
    let version: Int
    let instructions: String
    let sample: [String]
    /// The live Bot this template already made: offer Open instead of Create Bot.
    let existingBotId: String?

    init(version: Int, instructions: String, sample: [String], existingBotId: String?) {
        self.version = version
        self.instructions = instructions
        self.sample = sample
        self.existingBotId = existingBotId
    }

    /// Reads the template fields from a preset row's own container, or nil
    /// for a row without them (an older Mac, or a device without the opt-in).
    /// Present at all, all three are required.
    static func decodeIfPresent<Key: CodingKey>(
        _ values: KeyedDecodingContainer<Key>,
        version: Key, instructions: Key, sample: Key, existingBotId: Key
    ) throws -> Self? {
        guard values.contains(version) || values.contains(instructions) || values.contains(sample) || values.contains(existingBotId) else {
            return nil
        }
        let number = try values.decode(Int.self, forKey: version)
        guard number >= 1, number <= AidenRemoteProtocol.maxSafeInteger else { throw AidenBotContractError.invalidField("version") }
        let lines = try values.decode([String].self, forKey: sample)
        guard lines.count <= AidenBotUXWire.templateSampleLines else { throw AidenBotContractError.invalidField("sample") }
        return Self(
            version: number,
            instructions: try AidenBotUXWire.text(values, instructions, max: AidenBotUXWire.instructionsMax),
            sample: try lines.map { try AidenBotUXWire.text($0, field: "sample", max: AidenBotUXWire.templateSampleLineMax) },
            existingBotId: values.contains(existingBotId) ? try AidenBotUXWire.opaqueID(values, existingBotId) : nil
        )
    }
}

// MARK: - Approval mode and rules (`approvals:settings`)

enum AidenApprovalMode: String, Codable, Sendable, CaseIterable, Identifiable {
    /// In the desktop's order (`APPROVAL_MODES`): Auto, Ask, Never ask.
    case auto, ask, never
    var id: String { rawValue }
}

struct AidenApprovalModeView: Codable, Equatable, Sendable {
    let mode: AidenApprovalMode
    /// Auto can be chosen: the Mac has a usable model.
    let autoAvailable: Bool

    init(mode: AidenApprovalMode, autoAvailable: Bool) {
        self.mode = mode
        self.autoAvailable = autoAvailable
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["mode", "autoAvailable"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        mode = try values.decode(AidenApprovalMode.self, forKey: .mode)
        autoAvailable = try values.decode(Bool.self, forKey: .autoAvailable)
    }

    private enum CodingKeys: String, CodingKey { case mode, autoAvailable }
}

struct AidenApprovalModeRequest: Codable, Equatable, Sendable {
    let mode: AidenApprovalMode
}

/// A value the Mac hands out and wants back exactly as it was (a rule row's
/// `ref`, a picker option's `target`). The phone never reads into it.
indirect enum AidenOpaqueJSON: Codable, Hashable, Sendable {
    case object([String: AidenOpaqueJSON])
    case array([AidenOpaqueJSON])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    /// Small enough for a reference: a few keys of short ids.
    static let maxEncodedBytes = 2_048

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let array = try? value.decode([AidenOpaqueJSON].self) { self = .array(array) }
        else { self = .object(try value.decode([String: AidenOpaqueJSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case let .object(object): try value.encode(object)
        case let .array(array): try value.encode(array)
        case let .string(string): try value.encode(string)
        case let .number(number): try value.encode(number)
        case let .bool(bool): try value.encode(bool)
        case .null: try value.encodeNil()
        }
    }

    /// An object no larger than `maxEncodedBytes` once encoded.
    static func boundedObject(_ value: AidenOpaqueJSON, field: String) throws -> AidenOpaqueJSON {
        guard case .object = value,
              let data = try? JSONEncoder().encode(value),
              data.count <= maxEncodedBytes else {
            throw AidenBotContractError.invalidField(field)
        }
        return value
    }
}

enum AidenApprovalRuleDecision: String, Codable, Sendable, CaseIterable {
    case allow, ask, block
}

enum AidenApprovalRuleGroup: String, Codable, Sendable, CaseIterable {
    case allow, ask, block, mac
}

struct AidenApprovalRuleRow: Codable, Equatable, Identifiable, Sendable {
    struct Scope: Codable, Equatable, Sendable {
        enum Kind: String, Codable, Sendable { case mac, workspace, bot, chat }
        let kind: Kind
        let label: String?

        init(from decoder: Decoder) throws {
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "label"])
            let values = try decoder.container(keyedBy: CodingKeys.self)
            kind = try values.decode(Kind.self, forKey: .kind)
            label = try AidenBotUXWire.optionalText(values, .label, max: 200)
        }

        private enum CodingKeys: String, CodingKey { case kind, label }
    }

    struct HandOff: Codable, Equatable, Sendable { let on: Bool }

    let ref: AidenOpaqueJSON
    var group: AidenApprovalRuleGroup
    let title: String
    let kind: String
    let scope: Scope
    let legacy: Bool
    /// The segments this row offers; empty means read and remove only.
    let decisions: [AidenApprovalRuleDecision]
    let handOff: HandOff?
    let createdAt: AidenRemoteTimestamp?

    /// Rows are told apart by their opaque reference.
    var id: AidenOpaqueJSON { ref }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: [
            "ref", "group", "title", "kind", "scope", "legacy", "decisions", "handOff", "createdAt",
        ])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        ref = try AidenOpaqueJSON.boundedObject(try values.decode(AidenOpaqueJSON.self, forKey: .ref), field: "ref")
        group = try values.decode(AidenApprovalRuleGroup.self, forKey: .group)
        title = try AidenBotUXWire.text(values, .title, max: 400)
        kind = try AidenBotUXWire.text(values, .kind, max: 80)
        scope = try values.decode(Scope.self, forKey: .scope)
        if values.contains(.legacy) {
            guard try values.decode(Bool.self, forKey: .legacy) else { throw AidenBotContractError.invalidField("legacy") }
            legacy = true
        } else {
            legacy = false
        }
        decisions = try values.decode([AidenApprovalRuleDecision].self, forKey: .decisions)
        guard decisions.count <= AidenApprovalRuleDecision.allCases.count, Set(decisions).count == decisions.count else {
            throw AidenBotContractError.invalidField("decisions")
        }
        handOff = try AidenBotWire.optional(HandOff.self, from: values, forKey: .handOff)
        createdAt = try AidenBotUXWire.timestamp(values, .createdAt)
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(ref, forKey: .ref)
        try values.encode(group, forKey: .group)
        try values.encode(title, forKey: .title)
        try values.encode(kind, forKey: .kind)
        try values.encode(scope, forKey: .scope)
        if legacy { try values.encode(true, forKey: .legacy) }
        try values.encode(decisions, forKey: .decisions)
        try values.encodeIfPresent(handOff, forKey: .handOff)
        try values.encodeIfPresent(createdAt, forKey: .createdAt)
    }

    private enum CodingKeys: String, CodingKey {
        case ref, group, title, kind, scope, legacy, decisions, handOff, createdAt
    }
}

/// `GET /approvals/rules` and every rules write: the page as it now is.
struct AidenApprovalRulesView: Codable, Equatable, Sendable {
    static let maxRows = 1_000
    var rows: [AidenApprovalRuleRow]
    /// The Mac couldn't read its rules file: every write is refused until it's fixed there.
    let unreadable: Bool

    init(rows: [AidenApprovalRuleRow], unreadable: Bool) {
        self.rows = rows
        self.unreadable = unreadable
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["rows", "unreadable"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        rows = try values.decode([AidenApprovalRuleRow].self, forKey: .rows)
        guard rows.count <= Self.maxRows else { throw AidenBotContractError.invalidField("rows") }
        if values.contains(.unreadable) {
            guard try values.decode(Bool.self, forKey: .unreadable) else { throw AidenBotContractError.invalidField("unreadable") }
            unreadable = true
        } else {
            unreadable = false
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(rows, forKey: .rows)
        if unreadable { try values.encode(true, forKey: .unreadable) }
    }

    private enum CodingKeys: String, CodingKey { case rows, unreadable }
}

struct AidenApprovalRulePickerOption: Codable, Equatable, Identifiable, Sendable {
    let target: AidenOpaqueJSON
    let label: String
    let group: String
    let description: String?

    var id: AidenOpaqueJSON { target }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["target", "label", "group", "description"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        target = try AidenOpaqueJSON.boundedObject(try values.decode(AidenOpaqueJSON.self, forKey: .target), field: "target")
        label = try AidenBotUXWire.text(values, .label, max: 200)
        group = try AidenBotUXWire.text(values, .group, max: 200)
        description = try AidenBotUXWire.optionalText(values, .description, max: 400)
    }

    private enum CodingKeys: String, CodingKey { case target, label, group, description }
}

struct AidenApprovalRulePicker: Codable, Equatable, Sendable {
    let options: [AidenApprovalRulePickerOption]

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["options"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        options = try values.decode([AidenApprovalRulePickerOption].self, forKey: .options)
        guard options.count <= 1_000 else { throw AidenBotContractError.invalidField("options") }
    }

    private enum CodingKeys: String, CodingKey { case options }
}

struct AidenApprovalRuleAddRequest: Codable, Equatable, Sendable {
    let target: AidenOpaqueJSON
    let decision: AidenApprovalRuleDecision
}

struct AidenApprovalRuleChangeRequest: Codable, Equatable, Sendable {
    let ref: AidenOpaqueJSON
    let decision: AidenApprovalRuleDecision
}

struct AidenApprovalRuleRemoveRequest: Codable, Equatable, Sendable {
    let ref: AidenOpaqueJSON
}

// MARK: - Capabilities

extension AidenRemoteCapability {
    /// Revision 61: the typed card on stream, run and Bot approvals.
    static let approvalCards = Self(rawValue: "approval:cards")
    /// Revision 61: the Mac's approval mode and rules page.
    static let approvalsSettings = Self(rawValue: "approvals:settings")
    /// Revision 61: held `update_bot` cards and applied-change receipts.
    static let botSettingsChanges = Self(rawValue: "bot:settings-changes")
    /// Revision 61: skill, lesson and tidy-up suggestion entries.
    static let botSuggestions = Self(rawValue: "bot:suggestions")
    /// Revision 61: template versions, Open, the stale check and one-field create.
    static let botTemplates = Self(rawValue: "bot:templates")

    /// The five revision-61 opt-ins, each negotiated in a call of its own.
    static let botUX: [Self] = [.approvalCards, .approvalsSettings, .botSettingsChanges, .botSuggestions, .botTemplates]
}

extension AidenInstallation {
    /// A Mac on revision 61 or later offers `approval:cards` wherever it
    /// serves approvals. The phone's client-only changes (two-step Take
    /// control, the single messaging switch, the device's Show tool activity
    /// switch, Disable a tool) follow it, so an older Mac keeps today's screens.
    var offersBotUX: Bool { serverCapabilities?.contains(.approvalCards) == true }
}

/// Revision 61, client only: one per-device Show tool activity switch. On a
/// Mac that offers the revision 61 cards it decides how a Bot's status line
/// reads (off: "Thinking"; on: the work as it happens) in place of each Bot's
/// stored wording, which stays on the wire for older phones. Off by default,
/// as on the Mac.
enum AidenToolActivityPreference {
    static let defaultsKey = "aiden.chat.showToolActivity"

    static func isOn(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: defaultsKey) as? Bool ?? false
    }

    /// The wording a Bot's status line uses on this phone.
    static func wording(
        botWording: AidenBotChatActivityWording?,
        hostOffersBotUX: Bool,
        showToolActivity: Bool
    ) -> AidenBotChatActivityWording {
        guard hostOffersBotUX else { return botWording ?? .follows }
        return showToolActivity ? .follows : .thinking
    }
}
