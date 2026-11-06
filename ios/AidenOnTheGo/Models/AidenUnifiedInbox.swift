import Foundation

/// One machine's chats as the Inbox last saw them. The Inbox merges these
/// into a single list (`AidenUnifiedInbox`); nothing here reads the network.
struct AidenHostInboxSnapshot: Equatable, Sendable {
    let instanceId: String
    let deviceId: String
    var chats: [AidenChatSummary]
    /// Workspace names for this machine only. Workspace ids are per machine
    /// ("default" exists everywhere), so rows are matched against their own
    /// machine's names, never a merged map.
    var workspaceNames: [String: String]
    var isOnline: Bool
    var isBlocked: Bool
    var fetchedAt: Date?
}

/// Which machines the Inbox lists. `machine` carries an `instanceId`.
enum AidenMachineFilter: Hashable, Codable, Sendable {
    case all
    case machine(String)
}

enum AidenUnifiedInboxRowContent: Equatable {
    case chat(AidenChatSummary, AidenInboxPlacement)
}

struct AidenUnifiedInboxRow: Identifiable, Equatable {
    /// Host-scoped: two machines can hold the same chat id.
    let id: AidenHostObjectID
    let content: AidenUnifiedInboxRowContent
    /// False for a machine that is offline; its rows stay, dimmed.
    let isOnline: Bool
    let isPinned: Bool
}

/// Every machine's chats merged into the Inbox sections (spec, "Inbox").
/// Each machine's rows are placed by `AidenInboxProjection` on the phone's
/// clock, then merged: tier, then `placement.sortAt`, then the host-scoped
/// key, so the order is the same whatever order the snapshots arrive in.
struct AidenUnifiedInbox: Equatable {
    var needsYou: [AidenUnifiedInboxRow] = []
    /// Pinned rows first, then replies, each newest first.
    var updates: [AidenUnifiedInboxRow] = []
    var earlier: [AidenUnifiedInboxRow] = []
    /// Running chats, oldest run first. The accessory shows these; the
    /// lists do not.
    var running: [AidenUnifiedInboxRow] = []
    var earlierOverflow = 0
    /// Rows that need the person on online, visible machines. Ignores the
    /// machine filter and the search text.
    var needsYouCount = 0

    /// A machine that is blocked, or hidden from the Inbox, contributes
    /// nothing, whatever the filter says. A duplicate snapshot of one
    /// machine (same instance and device) counts once, the first wins.
    static func make(
        snapshots: [AidenHostInboxSnapshot],
        filter: AidenMachineFilter,
        hiddenMachines: Set<String>,
        openChat: AidenHostObjectID?,
        now: Date,
        searchText: String = "",
        showAllEarlier: Bool = false
    ) -> Self {
        let searching = !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        var inbox = Self()
        var needsYou: [Entry] = []
        var pinned: [Entry] = []
        var updates: [Entry] = []
        var earlier: [Entry] = []
        var running: [Entry] = []
        var seenHosts = Set<String>()
        var seenRows = Set<String>()

        for snapshot in snapshots {
            guard !snapshot.isBlocked, !hiddenMachines.contains(snapshot.instanceId) else { continue }
            let hostKey = AidenHostObjectID(instanceId: snapshot.instanceId, deviceId: snapshot.deviceId, objectId: "").storageKey
            guard seenHosts.insert(hostKey).inserted else { continue }
            let listed: Bool
            switch filter {
            case .all: listed = true
            case .machine(let instanceId): listed = instanceId == snapshot.instanceId
            }
            guard listed || snapshot.isOnline else { continue }

            // The open chat belongs to one machine; another machine's chat
            // with the same id is not open.
            let openChatID = openChat.flatMap {
                $0.instanceId == snapshot.instanceId && $0.deviceId == snapshot.deviceId ? $0.objectId : nil
            }
            func project(searchText: String) -> AidenInboxProjection {
                AidenInboxProjection.make(
                    chats: snapshot.chats,
                    workspaceNames: snapshot.workspaceNames,
                    openChatID: openChatID,
                    now: now,
                    searchText: searchText,
                    showAllEarlier: true,
                    earlierLimit: .max
                )
            }
            let projection = project(searchText: searchText)
            if snapshot.isOnline {
                inbox.needsYouCount += (searching ? project(searchText: "") : projection).needsYou.count
            }
            guard listed else { continue }

            func entries(_ rows: [AidenInboxProjection.Row], isPinned: Bool = false) -> [Entry] {
                rows.compactMap { row in
                    let id = AidenHostObjectID(instanceId: snapshot.instanceId, deviceId: snapshot.deviceId, objectId: row.id)
                    let key = id.storageKey
                    guard seenRows.insert(key).inserted else { return nil }
                    return Entry(
                        row: AidenUnifiedInboxRow(
                            id: id,
                            content: .chat(row.summary, row.placement),
                            isOnline: snapshot.isOnline,
                            isPinned: isPinned
                        ),
                        key: key,
                        tier: row.placement.tier,
                        sortAt: row.placement.sortAt
                    )
                }
            }
            needsYou += entries(projection.needsYou)
            pinned += entries(projection.pinned, isPinned: true)
            updates += entries(projection.updates)
            earlier += entries(projection.earlier)
            running += entries(projection.working)
        }

        needsYou.sort { left, right in
            if left.tier != right.tier { return left.tier < right.tier }
            return Self.oldestFirst(left, right)
        }
        pinned.sort(by: Self.newestFirst)
        updates.sort(by: Self.newestFirst)
        earlier.sort(by: Self.newestFirst)
        running.sort(by: Self.oldestFirst)

        inbox.needsYou = needsYou.map(\.row)
        inbox.updates = (pinned + updates).map(\.row)
        inbox.running = running.map(\.row)
        let earlierRows = earlier.map(\.row)
        if searching || showAllEarlier {
            inbox.earlier = earlierRows
        } else {
            let capped = AidenInboxProjection.capEarlier(earlierRows, limit: AidenInbox.earlierLimit) { $0.id == openChat }
            inbox.earlier = capped.rows
            inbox.earlierOverflow = capped.overflow
        }
        return inbox
    }

    /// A row with its sort inputs, computed once so the sort never rebuilds
    /// a key.
    private struct Entry {
        let row: AidenUnifiedInboxRow
        let key: String
        let tier: Int
        let sortAt: Date
    }

    private static func newestFirst(_ left: Entry, _ right: Entry) -> Bool {
        left.sortAt == right.sortAt ? left.key < right.key : left.sortAt > right.sortAt
    }

    private static func oldestFirst(_ left: Entry, _ right: Entry) -> Bool {
        left.sortAt == right.sortAt ? left.key < right.key : left.sortAt < right.sortAt
    }
}
