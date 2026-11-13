import Foundation
import Observation

/// Contract revision 61 (`approvals:settings`): the routes the Approvals page reads and writes.
protocol AidenApprovalSettingsTransport: Sendable {
    func approvalMode() async throws -> AidenApprovalModeView
    func setApprovalMode(_ mode: AidenApprovalMode) async throws -> AidenApprovalModeView
    func approvalRules() async throws -> AidenApprovalRulesView
    func approvalRulePicker() async throws -> AidenApprovalRulePicker
    func addApprovalRule(_ request: AidenApprovalRuleAddRequest) async throws -> AidenApprovalRulesView
    func changeApprovalRule(_ request: AidenApprovalRuleChangeRequest) async throws -> AidenApprovalRulesView
    func removeApprovalRule(_ request: AidenApprovalRuleRemoveRequest) async throws -> AidenApprovalRulesView
}

extension AidenRemoteClient: AidenApprovalSettingsTransport {}

enum AidenApprovalSettingsCopy {
    static func title(_ mode: AidenApprovalMode) -> String {
        switch mode {
        case .auto: "Auto"
        case .ask: "Ask"
        case .never: "Never ask"
        }
    }

    /// The Mac's one-line helper for each mode.
    static func help(_ mode: AidenApprovalMode) -> String {
        switch mode {
        case .auto: "A model approves routine actions and asks you about the rest."
        case .ask: "Asks before sending, spending or changing anything."
        case .never: "Asks only before purchases, sharing your data and the first use of your Mac. Only Block rules apply."
        }
    }

    static let autoUnavailable = "Auto needs an approval model. Choose one on your Mac."

    static func groupTitle(_ group: AidenApprovalRuleGroup) -> String {
        switch group {
        case .allow: "Always allow"
        case .ask: "Always ask"
        case .block: "Blocked"
        case .mac: "Allowed on this Mac"
        }
    }

    static func groupEmpty(_ group: AidenApprovalRuleGroup) -> String {
        switch group {
        case .allow: "Nothing yet. Choose Always on a card, or add a rule, to stop a question you keep answering."
        case .ask: "Add a rule to be asked before something that would otherwise run."
        case .block: "Add a rule to stop something in every mode."
        case .mac: ""
        }
    }

    static func decisionTitle(_ decision: AidenApprovalRuleDecision) -> String {
        switch decision {
        case .allow: "Allow"
        case .ask: "Ask"
        case .block: "Block"
        }
    }

    static func scope(_ row: AidenApprovalRuleRow) -> String {
        switch row.scope.kind {
        case .mac: "Every Bot and workspace"
        case .workspace: "Only in \(row.scope.label ?? "a workspace")"
        case .bot: "Only for \(row.scope.label ?? "a Bot")"
        case .chat: "\(row.scope.label ?? "A Bot") · one chat"
        }
    }

    static let unreadable = "Aiden couldn’t read your rules. Fix them on your Mac, then try again."
    static let failed = "That didn’t reach your machine. Please try again."
}

/// The Approvals page: the Mac's approval mode and its rules. Every change
/// shows at once and goes back if the Mac refuses it (R18). `ref` and
/// `target` are sent back exactly as the Mac gave them.
@MainActor
@Observable
final class AidenApprovalSettingsModel {
    private(set) var mode: AidenApprovalModeView?
    private(set) var rules: AidenApprovalRulesView?
    private(set) var picker: AidenApprovalRulePicker?
    private(set) var isLoading = false
    private(set) var isSavingMode = false
    private(set) var isAdding = false
    /// Rows with a change on its way, by `ref`.
    private(set) var busyRefs: Set<AidenOpaqueJSON> = []
    var errorMessage: String?

    @ObservationIgnored private let transport: any AidenApprovalSettingsTransport

    init(transport: any AidenApprovalSettingsTransport) {
        self.transport = transport
    }

    /// Auto can be picked only when the Mac has a usable approval model.
    var canPickAuto: Bool { mode?.autoAvailable == true }

    func rows(in group: AidenApprovalRuleGroup) -> [AidenApprovalRuleRow] {
        rules?.rows.filter { $0.group == group } ?? []
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        async let loadedMode = try? transport.approvalMode()
        async let loadedRules = try? transport.approvalRules()
        let (nextMode, nextRules) = await (loadedMode, loadedRules)
        if let nextMode { mode = nextMode }
        if let nextRules { rules = nextRules }
        if nextMode == nil || nextRules == nil { errorMessage = "Aiden couldn’t read your approvals. Please try again." }
    }

    @discardableResult
    func setMode(_ next: AidenApprovalMode) async -> Bool {
        guard let current = mode, current.mode != next, !isSavingMode else { return false }
        guard next != .auto || current.autoAvailable else { return false }
        mode = AidenApprovalModeView(mode: next, autoAvailable: current.autoAvailable)
        isSavingMode = true
        defer { isSavingMode = false }
        do {
            mode = try await transport.setApprovalMode(next)
            return true
        } catch {
            mode = current
            errorMessage = error is CancellationError ? nil : "Couldn’t change approvals."
            return false
        }
    }

    /// Moves a row to Allow, Ask or Block, as far as the row offers.
    @discardableResult
    func change(_ row: AidenApprovalRuleRow, to decision: AidenApprovalRuleDecision) async -> Bool {
        guard let page = rules, !page.unreadable, row.decisions.contains(decision),
              !busyRefs.contains(row.ref), let index = page.rows.firstIndex(where: { $0.ref == row.ref }) else { return false }
        var optimistic = page
        optimistic.rows[index].group = Self.group(for: decision)
        return await write(row.ref, optimistic: optimistic, original: page, failure: "Couldn’t change that rule.") { [transport] in
            try await transport.changeApprovalRule(AidenApprovalRuleChangeRequest(ref: row.ref, decision: decision))
        }
    }

    @discardableResult
    func remove(_ row: AidenApprovalRuleRow) async -> Bool {
        guard let page = rules, !page.unreadable, !busyRefs.contains(row.ref) else { return false }
        var optimistic = page
        optimistic.rows.removeAll { $0.ref == row.ref }
        return await write(row.ref, optimistic: optimistic, original: page, failure: "Couldn’t remove that rule.", goneIsDone: true) { [transport] in
            try await transport.removeApprovalRule(AidenApprovalRuleRemoveRequest(ref: row.ref))
        }
    }

    func loadPicker() async {
        do {
            picker = try await transport.approvalRulePicker()
        } catch {
            if !(error is CancellationError) { errorMessage = "Couldn’t load what a rule can be about." }
        }
    }

    /// Adds a rule for a picker option. The new row appears once the Mac
    /// returns the page.
    @discardableResult
    func add(_ option: AidenApprovalRulePickerOption, decision: AidenApprovalRuleDecision) async -> Bool {
        guard !isAdding, rules?.unreadable != true else { return false }
        isAdding = true
        defer { isAdding = false }
        do {
            rules = try await transport.addApprovalRule(AidenApprovalRuleAddRequest(target: option.target, decision: decision))
            return true
        } catch {
            if !(error is CancellationError) { errorMessage = message(for: error, fallback: "Couldn’t add that rule.") }
            return false
        }
    }

    private func write(
        _ ref: AidenOpaqueJSON,
        optimistic: AidenApprovalRulesView,
        original: AidenApprovalRulesView,
        failure: String,
        goneIsDone: Bool = false,
        send: @escaping @Sendable () async throws -> AidenApprovalRulesView
    ) async -> Bool {
        rules = optimistic
        busyRefs.insert(ref)
        defer { busyRefs.remove(ref) }
        do {
            rules = try await send()
            return true
        } catch {
            if case AidenRemoteClientError.server(404, _) = error {
                // The rule is gone on the Mac: it stays gone here.
                if goneIsDone { return true }
                rules = original
                rules?.rows.removeAll { $0.ref == ref }
                return false
            }
            rules = original
            if error is CancellationError { return false }
            errorMessage = message(for: error, fallback: failure)
            if case AidenRemoteClientError.server(409, _) = error {
                // The Mac's rules changed or became unreadable: show them as they are.
                if let fresh = try? await transport.approvalRules() { rules = fresh }
            }
            return false
        }
    }

    private func message(for error: Error, fallback: String) -> String {
        if case let AidenRemoteClientError.server(409, body) = error, !body.message.isEmpty { return body.message }
        return fallback
    }

    static func group(for decision: AidenApprovalRuleDecision) -> AidenApprovalRuleGroup {
        switch decision {
        case .allow: .allow
        case .ask: .ask
        case .block: .block
        }
    }
}
