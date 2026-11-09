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
    /// What this machine takes from a row's swipes (`AidenInbox.rowOffer`).
    var supportsReadState = false
    var supportsTriage = false
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
    /// From the row's own machine, because workspace ids repeat across machines.
    let workspaceName: String?
    /// What this row's swipes offer, on its own machine.
    let offer: AidenInboxRowOffer
}

/// Every machine's chats merged into the Inbox sections (spec, "Inbox").
/// Each machine's rows are placed by `AidenInboxProjection` on the phone's
/// clock, then merged: tier, then `placement.sortAt`, then the host-scoped id
/// (instance, device, chat id, each compared as a plain string, as the old
/// single-machine projection compares chat ids), so the order is the same
/// whatever order the snapshots arrive in.
struct AidenUnifiedInbox: Equatable {
    var needsYou: [AidenUnifiedInboxRow] = []
    /// Pinned rows first, then replies, each newest first. A running chat on an
    /// offline machine is here too, because nothing can confirm it's still running.
    var updates: [AidenUnifiedInboxRow] = []
    var earlier: [AidenUnifiedInboxRow] = []
    /// Running chats on online machines, oldest run first. The accessory shows
    /// these; the lists do not.
    var running: [AidenUnifiedInboxRow] = []
    var earlierOverflow = 0
    /// Rows that need the person on online, visible machines. Ignores the
    /// machine filter and the search text.
    var needsYouCount = 0

    /// A machine that is blocked, or hidden from the Inbox, contributes
    /// nothing, whatever the filter says. A duplicate snapshot of one
    /// machine (same instance and device) counts once, the first wins. A chat
    /// id repeated within one snapshot is one row: the copy placed first, in
    /// section order (Needs you, Pinned, Updates, Earlier, Running), is kept
    /// and `needsYouCount` counts each such chat once.
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
        var seenHosts = Set<HostKey>()
        var seenRows = Set<AidenHostObjectID>()

        for snapshot in snapshots {
            guard !snapshot.isBlocked, !hiddenMachines.contains(snapshot.instanceId) else { continue }
            guard seenHosts.insert(HostKey(instanceId: snapshot.instanceId, deviceId: snapshot.deviceId)).inserted else { continue }
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
                // Distinct chats, to agree with the deduped rows.
                let counted = searching ? project(searchText: "") : projection
                inbox.needsYouCount += Set(counted.needsYou.map(\.id)).count
            }
            guard listed else { continue }

            func entries(_ rows: [AidenInboxProjection.Row], isPinned: Bool = false) -> [Entry] {
                rows.compactMap { row in
                    let id = AidenHostObjectID(instanceId: snapshot.instanceId, deviceId: snapshot.deviceId, objectId: row.id)
                    guard seenRows.insert(id).inserted else { return nil }
                    return Entry(
                        row: AidenUnifiedInboxRow(
                            id: id,
                            content: .chat(row.summary, row.placement),
                            isOnline: snapshot.isOnline,
                            isPinned: isPinned,
                            workspaceName: snapshot.workspaceNames[row.summary.workspaceId],
                            offer: AidenInbox.rowOffer(
                                for: row.summary,
                                isOpen: row.id == openChatID,
                                now: now,
                                supportsReadState: snapshot.supportsReadState,
                                supportsTriage: snapshot.supportsTriage
                            )
                        ),
                        tier: row.placement.tier,
                        sortAt: row.placement.sortAt
                    )
                }
            }
            needsYou += entries(projection.needsYou)
            pinned += entries(projection.pinned, isPinned: true)
            updates += entries(projection.updates)
            earlier += entries(projection.earlier)
            if snapshot.isOnline {
                running += entries(projection.working)
            } else {
                pinned += entries(projection.working.filter { $0.summary.inbox.pinnedAt != nil }, isPinned: true)
                updates += entries(projection.working.filter { $0.summary.inbox.pinnedAt == nil })
            }
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

    private struct HostKey: Hashable {
        let instanceId: String
        let deviceId: String
    }

    /// A row with its sort inputs, read once.
    private struct Entry {
        let row: AidenUnifiedInboxRow
        let tier: Int
        let sortAt: Date
    }

    private static func newestFirst(_ left: Entry, _ right: Entry) -> Bool {
        left.sortAt == right.sortAt ? precedes(left.row.id, right.row.id) : left.sortAt > right.sortAt
    }

    private static func oldestFirst(_ left: Entry, _ right: Entry) -> Bool {
        left.sortAt == right.sortAt ? precedes(left.row.id, right.row.id) : left.sortAt < right.sortAt
    }

    /// Instance, then device, then chat id, as plain strings.
    private static func precedes(_ left: AidenHostObjectID, _ right: AidenHostObjectID) -> Bool {
        if left.instanceId != right.instanceId { return left.instanceId < right.instanceId }
        if left.deviceId != right.deviceId { return left.deviceId < right.deviceId }
        return left.objectId < right.objectId
    }
}

/// One machine's chat list as the Inbox sees it. `failure` is what a machine that
/// answered said. A machine that can't be reached has none.
struct AidenInboxMachineRead: Equatable {
    var presentation: AidenReadPresentation
    var failure: String?
}

/// What the Inbox shows. Everything but `rows` is why it has nothing to list, and
/// each of those ends: only a machine still being read shows `loading`.
enum AidenInboxListState: Equatable {
    case rows
    case loading
    /// Chats exist, and none of them is asking for anything.
    case caughtUp
    case noChats
    case offline(machines: Int)
    case failed(String)
    case allHidden

    /// A machine that may yet bring rows outranks one that can't, and an answer
    /// outranks a machine that gave none.
    static func make(hasRows: Bool, machines: [AidenInboxMachineRead], hasHiddenMachines: Bool) -> Self {
        if hasRows { return .rows }
        if machines.isEmpty { return hasHiddenMachines ? .allHidden : .noChats }
        let presentations = machines.map(\.presentation)
        if presentations.contains(.content) { return .caughtUp }
        if presentations.contains(.skeleton) { return .loading }
        if presentations.contains(.empty) { return .noChats }
        if let failure = machines.lazy.compactMap(\.failure).first { return .failed(failure) }
        return .offline(machines: machines.count)
    }
}

/// Whether there are older chats to read, on any machine the Inbox lists.
enum AidenInboxMoreChats: Equatable {
    case none
    case available
    case loading
    case failed(String)
}
