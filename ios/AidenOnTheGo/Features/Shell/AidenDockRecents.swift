import Foundation

/// One row of a dock tab's recents: where it goes and what it says.
struct AidenDockRecent: Identifiable, Equatable {
    enum Icon: Equatable {
        case symbol(String)
        /// A Bot's own sprite. Drawn from the summary alone, so opening the
        /// list never asks a machine for a photo.
        case bot(AidenBotSemanticAvatar)
    }

    /// A row's mark at its trailing edge. Waiting on the person outranks
    /// working, as it does in the Inbox.
    enum Status: Equatable {
        case none, running, needsYou
    }

    let route: AidenAppRoute
    let title: String
    let subtitle: String?
    let icon: Icon
    let status: Status

    var id: AidenAppRoute { route }
}

/// What the chosen dock tab offers when it's tapped again: its newest few
/// rows and, where the tab can start something, one action under them.
struct AidenDockRecentsList: Identifiable, Equatable {
    enum Footer: Equatable {
        case newChat, newWorkspaceChat

        var title: String {
            switch self {
            case .newChat: String(localized: "New chat")
            case .newWorkspaceChat: String(localized: "New workspace chat")
            }
        }
    }

    let tab: AidenAppTab
    let rows: [AidenDockRecent]
    let footer: Footer?

    var id: AidenAppTab { tab }

    /// VoiceOver's name for the list.
    var title: String {
        switch tab {
        case .chats: String(localized: "Recent chats")
        case .bots: String(localized: "Recent Bots")
        case .workspaces: String(localized: "Recent workspaces")
        case .inbox: String(localized: "Latest in Inbox")
        }
    }

    /// What it says with no rows.
    var emptyText: String {
        switch tab {
        case .chats: String(localized: "No chats yet")
        case .bots: String(localized: "No Bots yet")
        case .workspaces: String(localized: "No workspaces yet")
        case .inbox: String(localized: "You’re all caught up")
        }
    }
}

/// The dock's recents, built from what the phone already holds: the Inbox
/// snapshots and each machine's workspace list. Nothing here reads the
/// network, and nothing is kept: a list is made when its tab is tapped.
///
/// Every list is capped at `cap`. Work in progress leads (the row a person
/// most likely wants to get back to), then the newest; ties fall back to the
/// host-scoped id, so the order never depends on how the snapshots arrive.
enum AidenDockRecents {
    static let cap = 4

    /// The newest chats on every listed machine. `running` and `needsYou`
    /// are the Inbox's own sets, so a row's mark agrees with the Inbox.
    static func chats(
        snapshots: [AidenHostInboxSnapshot],
        hiddenMachines: Set<String>,
        running: Set<AidenHostObjectID>,
        needsYou: Set<AidenHostObjectID>,
        canStart: Bool
    ) -> AidenDockRecentsList {
        let entries = AidenChatsList.entries(snapshots: snapshots, hiddenMachines: hiddenMachines)
        let rows = runningFirst(entries, isRunning: { running.contains($0.id) }).prefix(cap).map { entry in
            AidenDockRecent(
                route: entry.route,
                title: entry.title,
                subtitle: entry.workspaceName,
                icon: .symbol("bubble"),
                status: status(running: running.contains(entry.id), needsYou: needsYou.contains(entry.id))
            )
        }
        return AidenDockRecentsList(tab: .chats, rows: rows, footer: canStart ? .newChat : nil)
    }

    /// The Bots last heard from, as the Bots tab lists them.
    static func bots(_ bots: [AidenMachineBotRow]) -> AidenDockRecentsList {
        let newest = bots.sorted { lhs, rhs in
            if lhs.bot.updatedAt != rhs.bot.updatedAt { return lhs.bot.updatedAt > rhs.bot.updatedAt }
            return precedes(lhs.id, rhs.id)
        }
        let rows = runningFirst(newest, isRunning: { AidenBotAttention.isRunning($0.bot) }).prefix(cap).map { row in
            let purpose = row.bot.purpose.trimmingCharacters(in: .whitespacesAndNewlines)
            return AidenDockRecent(
                route: .bot(row.id),
                title: row.bot.name,
                subtitle: AidenBotAttention.reason(row.bot) ?? (purpose.isEmpty ? nil : purpose),
                icon: .bot(row.bot.avatar.semantic),
                status: status(
                    running: AidenBotAttention.isRunning(row.bot),
                    needsYou: AidenBotAttention.needsYou(row.bot)
                )
            )
        }
        return AidenDockRecentsList(tab: .bots, rows: rows, footer: nil)
    }

    /// The workspaces last worked in. A workspace is as recent as its newest
    /// chat, or as its own last change with no chat listed; one with a chat
    /// running carries the spinner. `workspaces` are the Workspaces tab's own
    /// rows, so an archived workspace is never offered.
    static func workspaces(
        _ workspaces: [AidenMachineWorkspaceRow],
        snapshots: [AidenHostInboxSnapshot],
        running: Set<AidenHostObjectID>,
        canStart: Bool
    ) -> AidenDockRecentsList {
        var newestChat: [AidenHostObjectID: Date] = [:]
        var withRunningChat: Set<AidenHostObjectID> = []
        for snapshot in snapshots where !snapshot.isBlocked {
            for chat in snapshot.chats {
                let workspace = AidenHostObjectID(
                    instanceId: snapshot.instanceId, deviceId: snapshot.deviceId, objectId: chat.workspaceId
                )
                if newestChat[workspace].map({ $0 < chat.updatedAt }) ?? true {
                    newestChat[workspace] = chat.updatedAt
                }
                let id = AidenHostObjectID(instanceId: snapshot.instanceId, deviceId: snapshot.deviceId, objectId: chat.id)
                if running.contains(id) { withRunningChat.insert(workspace) }
            }
        }
        func lastUsed(_ row: AidenMachineWorkspaceRow) -> Date {
            max(newestChat[row.id] ?? .distantPast, row.workspace.updatedAt)
        }
        let newest = workspaces.sorted { lhs, rhs in
            let (left, right) = (lastUsed(lhs), lastUsed(rhs))
            if left != right { return left > right }
            return precedes(lhs.id, rhs.id)
        }
        let rows = runningFirst(newest, isRunning: { withRunningChat.contains($0.id) }).prefix(cap).map { row in
            AidenDockRecent(
                route: .workspace(row.id),
                title: row.workspace.name,
                subtitle: row.workspace.branchName ?? row.workspace.git?.branch ?? row.workspace.repositoryName,
                icon: .symbol("folder"),
                status: withRunningChat.contains(row.id) ? .running : .none
            )
        }
        return AidenDockRecentsList(tab: .workspaces, rows: rows, footer: canStart ? .newWorkspaceChat : nil)
    }

    /// The top of the Inbox, in its own order: what needs the person, then
    /// the updates.
    static func inbox(_ inbox: AidenUnifiedInbox) -> AidenDockRecentsList {
        let needsYou = inbox.needsYou.map { row(for: $0, needsYou: true) }
        let updates = inbox.updates.map { row(for: $0, needsYou: false) }
        var seen: Set<AidenAppRoute> = []
        let rows = (needsYou + updates).filter { seen.insert($0.route).inserted }
        return AidenDockRecentsList(tab: .inbox, rows: Array(rows.prefix(cap)), footer: nil)
    }

    private static func row(for row: AidenUnifiedInboxRow, needsYou: Bool) -> AidenDockRecent {
        switch row.content {
        case .chat(let chat, _):
            AidenDockRecent(
                route: row.route,
                title: chat.title,
                subtitle: row.workspaceName,
                icon: .symbol("bubble"),
                status: needsYou ? .needsYou : .none
            )
        case .bot(let bot):
            AidenDockRecent(
                route: row.route,
                title: bot.name,
                subtitle: AidenBotAttention.reason(bot),
                icon: .bot(bot.avatar.semantic),
                status: needsYou ? .needsYou : .none
            )
        }
    }

    private static func status(running: Bool, needsYou: Bool) -> AidenDockRecent.Status {
        needsYou ? .needsYou : running ? .running : .none
    }

    /// Stable: each group keeps the order it came in.
    private static func runningFirst<Row>(_ rows: [Row], isRunning: (Row) -> Bool) -> [Row] {
        rows.filter(isRunning) + rows.filter { !isRunning($0) }
    }

    private static func precedes(_ lhs: AidenHostObjectID, _ rhs: AidenHostObjectID) -> Bool {
        (lhs.instanceId, lhs.deviceId, lhs.objectId) < (rhs.instanceId, rhs.deviceId, rhs.objectId)
    }
}
