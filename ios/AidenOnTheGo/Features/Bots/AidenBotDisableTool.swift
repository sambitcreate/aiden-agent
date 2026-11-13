import Foundation

/// Revision 61, client only: Disable a tool, as on the Mac. One tool a Bot
/// may use, by the access set it lives in.
enum AidenBotTool: Hashable, Sendable {
    case shell
    case connection(String)
    case skill(String)
    case other(String)

    /// Every tool a Bot on Everything can use now, with its label.
    static func available(in catalog: AidenBotCapabilityCatalog) -> [(tool: AidenBotTool, label: String)] {
        var tools: [(AidenBotTool, String)] = []
        if catalog.shellAvailable { tools.append((.shell, "Run commands")) }
        tools += catalog.connections.filter(\.available).map { (.connection($0.id), $0.label) }
        tools += catalog.skills.filter(\.available).map { (.skill($0.id), $0.label) }
        tools += catalog.otherCapabilities.filter(\.available).map { (.other($0.id), $0.label) }
        return tools
    }
}

extension AidenBotEditorDraft {
    /// Turns one tool off. A Bot on Everything first becomes Only what I pick
    /// with everything available on and the widest file access (the whole
    /// machine, else its own folder and the approved places), so only that one
    /// tool goes. The draft saves through the existing capabilities route.
    func disabling(_ tool: AidenBotTool, catalog: AidenBotCapabilityCatalog) -> AidenBotEditorDraft {
        var next = self
        if next.usesFullAccess {
            next.usesFullAccess = false
            let scopes = catalog.fileScopes.filter(\.available)
            if let whole = scopes.first(where: { $0.kind == .fullMac }) {
                next.customAccess.fileScopeIDs = [whole.id]
            } else if let home = scopes.first(where: { $0.kind == .botHome }) {
                next.customAccess.fileScopeIDs = Set([home.id] + scopes.filter { $0.kind == .approvedLocation }.map(\.id))
            } else {
                next.customAccess.fileScopeIDs = []
            }
            next.customAccess.shellEnabled = catalog.shellAvailable
            next.customAccess.connectionIDs = Set(catalog.connections.filter(\.available).map(\.id))
            next.customAccess.skillIDs = Set(catalog.skills.filter { $0.available || !catalog.skillsEnabled }.map(\.id))
            next.customAccess.otherCapabilityIDs = Set(catalog.otherCapabilities.filter(\.available).map(\.id))
        }
        switch tool {
        case .shell: next.customAccess.shellEnabled = false
        case let .connection(id): next.customAccess.connectionIDs.remove(id)
        case let .skill(id): next.customAccess.skillIDs.remove(id)
        case let .other(id): next.customAccess.otherCapabilityIDs.remove(id)
        }
        return next
    }
}
