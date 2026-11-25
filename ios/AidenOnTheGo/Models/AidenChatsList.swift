import Foundation

/// One chat as the Chats tab and the drawer's Recents list it.
struct AidenChatListEntry: Identifiable, Equatable, Sendable {
    /// Host-scoped: two machines can hold the same chat id.
    let id: AidenHostObjectID
    let title: String
    let updatedAt: Date
    /// False for a machine that is offline; its chats stay, marked offline.
    let isOnline: Bool
    /// From the chat's own machine, because workspace ids repeat across machines.
    let workspaceName: String?

    var route: AidenAppRoute { .chat(id) }
}

/// Every machine's chats, newest first, from the same snapshots the Inbox
/// merges. Unlike the Inbox this is not triage: a chat is listed whatever its
/// Inbox placement. Nothing here reads the network.
enum AidenChatsList {
    /// A machine that is blocked, or hidden from the Inbox, contributes
    /// nothing. A chat id repeated on one machine, within a snapshot or
    /// across two snapshots of it, is one entry, the newer copy kept. Ties in
    /// `updatedAt` fall back to the host-scoped id, so the list never depends
    /// on the order the snapshots arrive in. `limit` keeps only the newest
    /// entries.
    static func entries(
        snapshots: [AidenHostInboxSnapshot],
        hiddenMachines: Set<String>,
        limit: Int? = nil
    ) -> [AidenChatListEntry] {
        var byID: [AidenHostObjectID: AidenChatListEntry] = [:]
        for snapshot in snapshots {
            guard !snapshot.isBlocked, !hiddenMachines.contains(snapshot.instanceId) else { continue }
            for chat in snapshot.chats {
                let id = AidenHostObjectID(instanceId: snapshot.instanceId, deviceId: snapshot.deviceId, objectId: chat.id)
                // Equal times keep the larger title, so neither arrival order wins.
                if let kept = byID[id],
                   kept.updatedAt > chat.updatedAt || (kept.updatedAt == chat.updatedAt && kept.title >= chat.title) {
                    continue
                }
                byID[id] = AidenChatListEntry(
                    id: id,
                    title: chat.title,
                    updatedAt: chat.updatedAt,
                    isOnline: snapshot.isOnline,
                    workspaceName: snapshot.workspaceNames[chat.workspaceId]
                )
            }
        }
        let sorted = byID.values.sorted { lhs, rhs in
            if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
            return (lhs.id.instanceId, lhs.id.deviceId, lhs.id.objectId)
                < (rhs.id.instanceId, rhs.id.deviceId, rhs.id.objectId)
        }
        guard let limit else { return sorted }
        return Array(sorted.prefix(max(0, limit)))
    }
}
