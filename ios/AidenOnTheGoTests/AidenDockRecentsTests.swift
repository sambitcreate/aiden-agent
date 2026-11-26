#if DEBUG
import XCTest
@testable import AidenOnTheGo

/// What the chosen dock tab's recents list: which rows, how many, in what
/// order, and what each says.
@MainActor
final class AidenDockRecentsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }

    private func id(_ objectId: String, on instanceId: String = "studio") -> AidenHostObjectID {
        AidenHostObjectID(instanceId: instanceId, deviceId: "phone", objectId: objectId)
    }

    private func chat(
        _ chatID: String,
        minutesAgo: Double,
        workspace: String = "site",
        rowState: AidenChatRowState? = nil,
        activity: AidenChatSummaryActivity = .idle,
        unread: Bool = false,
        inbox: AidenChatInboxSignals = AidenChatInboxSignals()
    ) -> AidenChatSummary {
        AidenChatSummary(
            id: chatID, workspaceId: workspace, title: "Chat \(chatID)", titlePending: false,
            createdAt: ago(minutesAgo + 1), updatedAt: ago(minutesAgo),
            revision: "rev-\(chatID)", activity: activity, rowState: rowState, unread: unread, inbox: inbox
        )
    }

    private func snapshot(
        _ instanceId: String = "studio",
        chats: [AidenChatSummary] = [],
        bots: [AidenBotSummary] = [],
        blocked: Bool = false
    ) -> AidenHostInboxSnapshot {
        AidenHostInboxSnapshot(
            instanceId: instanceId, deviceId: "phone", chats: chats,
            workspaceNames: ["site": "Site-\(instanceId)", "api": "API-\(instanceId)"],
            isOnline: true, isBlocked: blocked, fetchedAt: now, bots: bots
        )
    }

    private func bot(
        _ botID: String,
        purpose: String = "",
        state: String = "idle",
        issues: Int? = nil,
        minutesAgo: Double
    ) throws -> AidenBotSummary {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var object: [String: Any] = [
            "id": botID, "name": "Bot \(botID)", "purpose": purpose,
            "avatar": ["semantic": ["version": 1, "shape": "orb", "color": "rose"]],
            "health": "ready", "sessionState": state,
            "createdAt": formatter.string(from: ago(minutesAgo + 60)),
            "updatedAt": formatter.string(from: ago(minutesAgo)),
            "revision": "bot_revision_\(botID)",
        ]
        if let issues { object["issueCount"] = issues }
        return try AidenRemoteJSONDecoder.decode(AidenBotSummary.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func workspace(
        _ workspaceID: String,
        on instanceId: String = "studio",
        branch: String? = nil,
        repository: String? = nil,
        checkedOut: String? = nil,
        updatedMinutesAgo: Double = 10_000
    ) -> AidenMachineWorkspaceRow {
        AidenMachineWorkspaceRow(
            id: id(workspaceID, on: instanceId),
            workspace: AidenWorkspace(
                id: workspaceID, name: "Workspace \(workspaceID)", permission: .ask, hasFolder: true,
                isManagedWorktree: false, noWorkspace: false, branchName: branch, repositoryName: repository,
                git: checkedOut.map { AidenWorkspaceGitSummary(isRepo: true, branch: $0, uncommitted: nil) }, createdAt: ago(20_000), updatedAt: ago(updatedMinutesAgo), revision: "r1"
            )
        )
    }

    // MARK: Chats

    func testChatsAreTheNewestFourWithTheRunningOneFirst() {
        let chats = (1...6).map { chat("c\($0)", minutesAgo: Double($0)) }
        let list = AidenDockRecents.chats(
            snapshots: [snapshot(chats: chats)],
            hiddenMachines: [],
            running: [id("c5")],
            needsYou: [],
            canStart: true
        )

        XCTAssertEqual(list.tab, .chats)
        // c5 is fifth by age, and leads because it's working; the cap then
        // keeps the three newest of the rest.
        XCTAssertEqual(list.rows.map(\.route), ["c5", "c1", "c2", "c3"].map { .chat(id($0)) })
        XCTAssertEqual(list.rows.map(\.status), [.running, .none, .none, .none])
        XCTAssertEqual(list.rows.first?.title, "Chat c5")
        XCTAssertEqual(list.rows.first?.subtitle, "Site-studio")
        XCTAssertEqual(list.footer, .newChat)
    }

    func testAChatWaitingOnThePersonShowsThatOverWorking() {
        let list = AidenDockRecents.chats(
            snapshots: [snapshot(chats: [chat("a", minutesAgo: 2), chat("b", minutesAgo: 1)])],
            hiddenMachines: [],
            running: [id("a")],
            needsYou: [id("a")],
            canStart: false
        )

        XCTAssertEqual(list.rows.map(\.status), [.needsYou, .none])
        XCTAssertNil(list.footer, "Nothing can start a chat, so the list offers none")
    }

    func testChatsOnAHiddenMachineAreLeftOut() {
        let list = AidenDockRecents.chats(
            snapshots: [
                snapshot("studio", chats: [chat("a", minutesAgo: 5)]),
                snapshot("laptop", chats: [chat("b", minutesAgo: 1)]),
            ],
            hiddenMachines: ["laptop"],
            running: [],
            needsYou: [],
            canStart: true
        )

        XCTAssertEqual(list.rows.map(\.route), [.chat(id("a"))])
    }

    // MARK: Bots

    func testBotsAreNewestFirstWithTheWorkingOneLeadingAndSayWhy() throws {
        let rows = try [
            bot("old", purpose: "Watches the build", minutesAgo: 50),
            bot("busy", state: "running", minutesAgo: 40),
            bot("stuck", issues: 2, minutesAgo: 30),
            bot("new", purpose: "  ", minutesAgo: 1),
            bot("oldest", minutesAgo: 90),
        ].map { AidenMachineBotRow(id: id($0.id), bot: $0) }

        let list = AidenDockRecents.bots(rows)

        XCTAssertEqual(list.rows.map(\.route), ["busy", "new", "stuck", "old"].map { .bot(id($0)) })
        XCTAssertEqual(list.rows.map(\.status), [.running, .none, .needsYou, .none])
        XCTAssertEqual(list.rows.map(\.subtitle), ["Working", nil, "2 things need you", "Watches the build"])
        XCTAssertNil(list.footer)
    }

    // MARK: Workspaces

    func testWorkspacesAreOrderedByTheirNewestChatAndCappedAtFour() {
        // Listed by name, as the tab gives them; used in a different order.
        let rows = ["a", "b", "c", "d", "e"].map { workspace($0, branch: "branch-\($0)") }
        let chats = [
            chat("1", minutesAgo: 50, workspace: "a"),
            chat("2", minutesAgo: 5, workspace: "c"),
            chat("3", minutesAgo: 60, workspace: "c"),
            chat("4", minutesAgo: 20, workspace: "e"),
            chat("5", minutesAgo: 30, workspace: "b"),
        ]

        let list = AidenDockRecents.workspaces(rows, snapshots: [snapshot(chats: chats)], running: [], canStart: true)

        XCTAssertEqual(list.rows.map(\.route), ["c", "e", "b", "a"].map { .workspace(id($0)) })
        XCTAssertEqual(list.rows.first?.title, "Workspace c")
        XCTAssertEqual(list.rows.first?.subtitle, "branch-c")
        XCTAssertEqual(list.rows.map(\.status), [.none, .none, .none, .none])
        XCTAssertEqual(list.footer, .newWorkspaceChat)
    }

    func testAWorkspaceWithARunningChatLeadsAndCarriesTheSpinner() {
        let rows = [workspace("a"), workspace("b"), workspace("c")]
        let chats = [
            chat("new", minutesAgo: 1, workspace: "a"),
            chat("run", minutesAgo: 90, workspace: "c"),
            chat("mid", minutesAgo: 10, workspace: "b"),
        ]

        let list = AidenDockRecents.workspaces(rows, snapshots: [snapshot(chats: chats)], running: [id("run")], canStart: true)

        XCTAssertEqual(list.rows.map(\.route), ["c", "a", "b"].map { .workspace(id($0)) })
        XCTAssertEqual(list.rows.map(\.status), [.running, .none, .none])
    }

    func testAWorkspaceIsCountedOnItsOwnMachineAndFallsBackToItsOwnDate() {
        // Both machines call a workspace "site"; only the laptop's has a chat.
        let rows = [
            workspace("site", on: "studio", repository: "aiden", updatedMinutesAgo: 30),
            workspace("site", on: "laptop", updatedMinutesAgo: 9_000),
            workspace("idle", on: "studio", checkedOut: "fix/upload", updatedMinutesAgo: 20),
        ]
        let snapshots = [
            snapshot("studio"),
            snapshot("laptop", chats: [chat("x", minutesAgo: 25, workspace: "site")]),
        ]

        let list = AidenDockRecents.workspaces(rows, snapshots: snapshots, running: [], canStart: false)

        XCTAssertEqual(list.rows.map(\.route), [
            .workspace(id("idle", on: "studio")),
            .workspace(id("site", on: "laptop")),
            .workspace(id("site", on: "studio")),
        ])
        XCTAssertEqual(list.rows.map(\.subtitle), ["fix/upload", nil, "aiden"], "The checked-out branch, else the repository, names it")
        XCTAssertNil(list.footer)
    }

    func testWorkspacesUsedAtTheSameMomentKeepOneOrderHoweverTheyArrive() {
        let rows = [workspace("b", updatedMinutesAgo: 10), workspace("a", updatedMinutesAgo: 10), workspace("c", updatedMinutesAgo: 10)]

        let forward = AidenDockRecents.workspaces(rows, snapshots: [], running: [], canStart: true)
        let backward = AidenDockRecents.workspaces(rows.reversed(), snapshots: [], running: [], canStart: true)

        XCTAssertEqual(forward.rows.map(\.route), ["a", "b", "c"].map { .workspace(id($0)) })
        XCTAssertEqual(backward, forward)
    }

    // MARK: Inbox

    func testInboxListsWhatNeedsThePersonThenTheUpdates() throws {
        let waiting = chat("ask", minutesAgo: 1, rowState: .needsInput, activity: .active,
                           inbox: AidenChatInboxSignals(attentionSince: ago(3)))
        let replies = (1...5).map { chat("r\($0)", minutesAgo: Double($0), unread: true) }
        let inbox = AidenUnifiedInbox.make(
            snapshots: [snapshot(chats: replies + [waiting], bots: [try bot("stuck", issues: 1, minutesAgo: 2)])],
            filter: .all, hiddenMachines: [], openChat: nil, now: now
        )
        XCTAssertEqual(inbox.needsYou.count, 2, "The fixture's chat and Bot both wait")

        let list = AidenDockRecents.inbox(inbox)

        XCTAssertEqual(list.rows.count, AidenDockRecents.cap)
        XCTAssertEqual(list.rows.prefix(2).map(\.route), inbox.needsYou.map(\.route))
        XCTAssertEqual(list.rows.suffix(2).map(\.route), [.chat(id("r1")), .chat(id("r2"))])
        XCTAssertEqual(list.rows.map(\.status), [.needsYou, .needsYou, .none, .none])
        XCTAssertNil(list.footer)
    }

    func testAnEmptyTabSaysSoAndKeepsItsAction() {
        let list = AidenDockRecents.workspaces([], snapshots: [], running: [], canStart: true)

        XCTAssertTrue(list.rows.isEmpty)
        XCTAssertEqual(list.emptyText, "No workspaces yet")
        XCTAssertEqual(list.footer?.title, "New workspace chat")
    }
}
#endif
