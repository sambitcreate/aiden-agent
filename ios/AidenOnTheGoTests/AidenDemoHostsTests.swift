#if DEBUG
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenDemoHostsTests: XCTestCase {
    private func client(
        for installation: AidenInstallation,
        responder: AidenDemoResponder
    ) -> AidenRemoteClient {
        AidenRemoteClient(
            endpoint: installation.endpoint,
            credential: "demo-test-credential",
            session: responder.session
        )
    }

    private func status(
        of path: String,
        instanceId: String,
        responder: AidenDemoResponder
    ) async throws -> Int {
        let url = try XCTUnwrap(URL(string: "https://\(instanceId).demo.invalid/api/aiden/v1\(path)"))
        let (_, response) = try await responder.session.data(for: URLRequest(url: url))
        return try XCTUnwrap(response as? HTTPURLResponse).statusCode
    }

    func testEveryScenarioServesRowsThatDecodeWithTheRealModels() async throws {
        for scenario in AidenDemoScenario.allCases {
            let responder = AidenDemoResponder()
            let coordinator = AidenDemoHosts.coordinator(scenario, responder: responder)
            let installations = coordinator.installationStore.installations
            XCTAssertFalse(installations.isEmpty, "\(scenario) has no machines")

            var servedMachines = 0
            for installation in installations {
                do {
                    let page = try await client(for: installation, responder: responder).chatSummaries()
                    servedMachines += 1
                    if scenario == .empty {
                        XCTAssertTrue(page.summaries.isEmpty, "\(scenario) must have no rows")
                    } else {
                        XCTAssertFalse(page.summaries.isEmpty, "\(scenario)/\(installation.instanceId) has no rows")
                    }
                } catch let error as URLError {
                    // An offline machine is the only acceptable failure.
                    XCTAssertEqual(error.code, .notConnectedToInternet, "\(scenario)/\(installation.instanceId)")
                }
            }
            XCTAssertGreaterThan(servedMachines, 0, "\(scenario) has no reachable machine")
        }
    }

    func testBusyScenarioCoversEveryRowStateTheInboxRenders() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.busy, responder: responder)
        let installation = try XCTUnwrap(coordinator.installationStore.activeInstallation)
        let page = try await client(for: installation, responder: responder).chatSummaries()

        XCTAssertGreaterThanOrEqual(page.summaries.count, 12)
        let states = Set(page.summaries.compactMap(\.rowState))
        XCTAssertEqual(states, [.needsApproval, .needsInput, .working, .idle])
        XCTAssertTrue(page.summaries.contains { $0.lastRunFailed })
        XCTAssertTrue(page.summaries.contains { $0.unread })
    }

    func testUnknownPathsAreRefusedSoNoEndpointGetsInvented() async throws {
        let responder = AidenDemoResponder()
        _ = AidenDemoHosts.coordinator(.one, responder: responder)

        let known = try await status(of: "/server", instanceId: "studio", responder: responder)
        XCTAssertEqual(known, 200)
        let unknown = try await status(of: "/no-such-endpoint", instanceId: "studio", responder: responder)
        XCTAssertEqual(unknown, 404)
        let unknownMachine = try await status(of: "/server", instanceId: "nobody", responder: responder)
        XCTAssertEqual(unknownMachine, 404)
    }

    func testFourScenarioHasOneOfflineMachine() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let installations = coordinator.installationStore.installations
        XCTAssertEqual(Set(installations.map(\.instanceId)), ["studio", "laptop", "mini", "build"])
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: installations.map { ($0.instanceId, $0.name) }),
            ["studio": "Studio Mac", "laptop": "Laptop", "mini": "Home Mini", "build": "Build Box"]
        )

        for installation in installations {
            let machine = client(for: installation, responder: responder)
            if installation.instanceId == "build" {
                do {
                    _ = try await machine.server()
                    XCTFail("The build machine must be offline")
                } catch let error as URLError {
                    XCTAssertEqual(error.code, .notConnectedToInternet)
                }
            } else {
                let server = try await machine.server()
                XCTAssertEqual(server.instanceId, installation.instanceId)
                XCTAssertEqual(server.name, installation.name)
            }
        }
    }

    func testOfflineMixHasTwoReachableAndTwoOfflineMachines() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.offlineMix, responder: responder)
        var reachable = Set<String>()
        for installation in coordinator.installationStore.installations {
            if (try? await client(for: installation, responder: responder).server()) != nil {
                reachable.insert(installation.instanceId)
            }
        }
        XCTAssertEqual(reachable, ["studio", "mini"])
    }

    func testOldHostAdvertisesNoFeaturesAndServesChatsThroughTheLegacyList() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.oldHost, responder: responder)
        let installation = try XCTUnwrap(coordinator.installationStore.activeInstallation)
        let machine = client(for: installation, responder: responder)

        let server = try await machine.server()
        XCTAssertNil(server.serverCapabilities)
        XCTAssertTrue(server.features.isEmpty)
        XCTAssertFalse(installation.isBotsEligible)

        let page = try await machine.preferredChatSummaries(advertised: false)
        XCTAssertFalse(page.summaries.isEmpty)
    }

    func testCoordinatorConnectsToTheFirstMachineThroughTheRealLaunchPath() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")

        await coordinator.start()

        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertEqual(coordinator.server?.name, "Studio Mac")
        XCTAssertFalse(coordinator.workspaces.isEmpty)
        let asked = responder.requests(instanceId: "studio")
        XCTAssertTrue(asked.contains("GET /server"))
        XCTAssertTrue(asked.contains("GET /workspaces"))
        // Only the selected machine is contacted on launch.
        XCTAssertTrue(responder.requests(instanceId: "build").isEmpty)
    }

    func testOfflineActiveMachineLandsOnAConnectionIssueNotPairing() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(
            installations: [AidenDemoHosts.installation(instanceId: "build", name: "Build Box")],
            responder: responder
        )
        responder.fail(instanceId: "build", path: "/server", code: .notConnectedToInternet)

        await coordinator.start()

        guard case .offline = coordinator.connectionState else {
            return XCTFail("Expected offline, got \(coordinator.connectionState)")
        }
        XCTAssertEqual(coordinator.defaultInstanceId, "build", "An offline machine stays paired")
    }

    func testReplyOverridesTheDefaultAndRecordsTheRequest() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        let installation = try XCTUnwrap(coordinator.installationStore.activeInstallation)
        responder.reply(
            instanceId: "studio",
            method: "GET",
            path: "/chat-summaries",
            status: 200,
            json: Data(#"{"summaries":[]}"#.utf8)
        )

        let page = try await client(for: installation, responder: responder).chatSummaries()

        XCTAssertTrue(page.summaries.isEmpty)
        XCTAssertEqual(responder.requests(instanceId: "studio"), ["GET /chat-summaries"])
    }

    func testReplyKeepsAnswersForOtherMethodsOnTheSamePath() async throws {
        let responder = AidenDemoResponder()
        responder.reply(instanceId: "studio", method: "POST", path: "/widgets", status: 201, json: Data("{}".utf8))
        responder.reply(instanceId: "studio", method: "GET", path: "/widgets", status: 200, json: Data("{}".utf8))

        let url = try XCTUnwrap(URL(string: "https://studio.demo.invalid/api/aiden/v1/widgets"))
        var post = URLRequest(url: url)
        post.httpMethod = "POST"
        let (_, postResponse) = try await responder.session.data(for: post)
        XCTAssertEqual((postResponse as? HTTPURLResponse)?.statusCode, 201, "A later GET answer must not erase the POST answer")
        let (_, getResponse) = try await responder.session.data(for: URLRequest(url: url))
        XCTAssertEqual((getResponse as? HTTPURLResponse)?.statusCode, 200)

        // A second answer for the same method still replaces the first.
        responder.reply(instanceId: "studio", method: "POST", path: "/widgets", status: 409, json: Data("{}".utf8))
        let (_, replaced) = try await responder.session.data(for: post)
        XCTAssertEqual((replaced as? HTTPURLResponse)?.statusCode, 409)
        let (_, untouched) = try await responder.session.data(for: URLRequest(url: url))
        XCTAssertEqual((untouched as? HTTPURLResponse)?.statusCode, 200)
    }

    func testFailStillReplacesEveryMethodOnThePath() async throws {
        let responder = AidenDemoResponder()
        responder.reply(instanceId: "studio", method: "POST", path: "/widgets", status: 201, json: Data("{}".utf8))
        responder.reply(instanceId: "studio", method: "GET", path: "/widgets", status: 200, json: Data("{}".utf8))
        responder.fail(instanceId: "studio", path: "/widgets", code: .timedOut)

        let url = try XCTUnwrap(URL(string: "https://studio.demo.invalid/api/aiden/v1/widgets"))
        var post = URLRequest(url: url)
        post.httpMethod = "POST"
        for request in [post, URLRequest(url: url)] {
            do {
                _ = try await responder.session.data(for: request)
                XCTFail("\(request.httpMethod ?? "GET") should have failed")
            } catch let error as URLError {
                XCTAssertEqual(error.code, .timedOut)
            }
        }
    }

    func testTwoDemoCoordinatorsDoNotShareArchiveState() throws {
        let first = AidenDemoHosts.coordinator(.one, responder: AidenDemoResponder())
        first.workspaceArchiveStore.archive(workspaceID: "workspace_notes", instanceID: "studio")
        XCTAssertTrue(first.workspaceArchiveStore.isArchived(workspaceID: "workspace_notes", instanceID: "studio"))

        // Building another coordinator must not wipe, or inherit, the first one's state.
        let second = AidenDemoHosts.coordinator(.one, responder: AidenDemoResponder())
        XCTAssertFalse(second.workspaceArchiveStore.isArchived(workspaceID: "workspace_notes", instanceID: "studio"))
        XCTAssertTrue(
            first.workspaceArchiveStore.isArchived(workspaceID: "workspace_notes", instanceID: "studio"),
            "A second coordinator must not clear the first one's archive"
        )

        second.workspaceArchiveStore.archive(workspaceID: "workspace_app", instanceID: "studio")
        XCTAssertFalse(first.workspaceArchiveStore.isArchived(workspaceID: "workspace_app", instanceID: "studio"))
    }

    func testTwoDemoCoordinatorsDoNotShareDefaultsOnDisk() {
        // The archive store keeps its snapshot in the defaults it is given. What
        // the first coordinator saved must survive building a second one.
        let first = AidenDemoHosts.isolatedDefaults()
        first.set("kept", forKey: "demo.marker")
        let second = AidenDemoHosts.isolatedDefaults()

        XCTAssertEqual(first.string(forKey: "demo.marker"), "kept", "Building a second coordinator wiped the first")
        XCTAssertNil(second.string(forKey: "demo.marker"), "The second coordinator inherited the first one's state")
        second.set("other", forKey: "demo.marker")
        XCTAssertEqual(first.string(forKey: "demo.marker"), "kept")
    }

    func testEveryChatRowOpensWithAConversationThatDecodes() async throws {
        for scenario in [AidenDemoScenario.one, .busy, .oldHost] {
            let responder = AidenDemoResponder()
            let coordinator = AidenDemoHosts.coordinator(scenario, responder: responder)
            let installation = try XCTUnwrap(coordinator.installationStore.activeInstallation)
            let machine = client(for: installation, responder: responder)
            let rows = try await machine.preferredChatSummaries(advertised: installation.serverCapabilities != nil).summaries
            XCTAssertFalse(rows.isEmpty, "\(scenario)")

            for row in rows {
                let chat = try await machine.chat(id: row.id)
                XCTAssertEqual(chat.title, row.title, "\(scenario)/\(row.id)")
                XCTAssertGreaterThanOrEqual(chat.messages.count, 2, "\(scenario)/\(row.id) needs a user and an assistant message")
            }
        }
    }

    func testDemoBotOpensWithASessionThatDecodes() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        let installation = try XCTUnwrap(coordinator.installationStore.activeInstallation)
        let machine = client(for: installation, responder: responder)

        let bots = try await machine.bots().bots
        let bot = try XCTUnwrap(bots.first)
        XCTAssertEqual(bots.count, 1)
        let detail = try await machine.bot(id: bot.id)
        XCTAssertEqual(detail.name, bot.name)
        let session = try await machine.botSession(botId: bot.id)
        XCTAssertFalse(session.entries.isEmpty)
    }

    func testSettingsScreenCanReadMemorySettings() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        let installation = try XCTUnwrap(coordinator.installationStore.activeInstallation)

        let settings = try await client(for: installation, responder: responder).memorySettings()

        XCTAssertTrue(settings.enabled)
    }

    func testEmptyScenarioHasNoBotSoTheEmptyStateCanBeCaptured() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.empty, responder: responder)
        let installation = try XCTUnwrap(coordinator.installationStore.activeInstallation)

        let bots = try await client(for: installation, responder: responder).bots().bots
        XCTAssertTrue(bots.isEmpty)
    }

    func testHeldRequestStaysPendingUntilReleased() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        let installation = try XCTUnwrap(coordinator.installationStore.activeInstallation)
        let release = responder.hold(instanceId: "studio", path: "/server")
        let machine = client(for: installation, responder: responder)

        let finished = LockedFlag()
        let task = Task {
            let server = try await machine.server()
            finished.set()
            return server
        }
        let deadline = Date().addingTimeInterval(30)
        while responder.requests(instanceId: "studio").isEmpty, Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(responder.requests(instanceId: "studio"), ["GET /server"])
        // Logged is not held: give a broken hold time to finish the request.
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(finished.value, "A held request must not complete")

        release()
        let server = try await task.value
        XCTAssertEqual(server.instanceId, "studio")
        XCTAssertTrue(finished.value)
    }

    func testScenarioArgumentIsParsedFromLaunchArguments() {
        XCTAssertEqual(
            AidenDemoScenario.requested(in: ["Aiden", "-AidenDemoScenario", "offline-mix"]),
            .offlineMix
        )
        XCTAssertEqual(
            AidenDemoScenario.requested(in: ["-AidenDemoScenario", "old-host", "-other", "x"]),
            .oldHost
        )
        XCTAssertNil(AidenDemoScenario.requested(in: ["Aiden", "-AidenInboxFixture"]))
    }

    // MARK: Full scenario

    /// Every screen the full scenario feeds decodes through the real client
    /// and its validators, on both machines, and the answers agree with each
    /// other: a task's script and MCP servers are offered, a diff opens from
    /// the review's own snapshot, and the archived workspace is listed.
    func testFullScenarioFeedsEveryScreenThroughTheRealClient() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.full, responder: responder)
        let installations = coordinator.installationStore.installations
        XCTAssertEqual(installations.count, 2)

        for installation in installations {
            let label = installation.instanceId
            let client = client(for: installation, responder: responder)

            let bots = try await client.bots().bots
            XCTAssertEqual(bots.count, 2, label)
            let running = try XCTUnwrap(bots.first { $0.sessionState == .running }, "\(label): no running Bot")
            let detail = try await client.bot(id: running.id)
            XCTAssertEqual(detail.id, running.id)
            let session = try await client.botSession(botId: running.id)
            XCTAssertEqual(session.stateView.state, .running, label)
            XCTAssertNotNil(session.partial, label)
            for bot in bots {
                let memory = try await client.botMemory(botId: bot.id)
                XCTAssertTrue(memory.readable, label)
                XCTAssertFalse(memory.memory.entries.isEmpty, "\(label)/\(bot.id)")
                XCTAssertFalse(memory.memory.overBudget || memory.user.overBudget, "\(label)/\(bot.id)")
            }
            let routines = try await client.botRoutineNotifications(since: nil)
            XCTAssertEqual(Set(routines.notifications.map(\.botId)), Set(bots.map(\.id)), label)

            let workspaces = try await client.workspaces()
            XCTAssertTrue(workspaces.contains { $0.id == AidenDemoFull.archivedWorkspaceId }, label)
            XCTAssertTrue(
                coordinator.workspaceArchiveStore.isArchived(workspaceID: AidenDemoFull.archivedWorkspaceId, instanceID: label),
                "\(label): the prototype workspace is archived on this device"
            )

            let tasks = try await client.scheduledTasks()
            XCTAssertEqual(Set(tasks.map(\.mode)), [.llm, .script], label)
            let scripts = Set(try await client.scheduledScripts(workspaceId: nil).map(\.id))
            let servers = Set(try await client.scheduledMcpServers().map(\.id))
            for task in tasks {
                let fetched = try await client.scheduledTask(id: task.id)
                XCTAssertEqual(fetched, task)
                let runs = try await client.scheduledRuns(taskId: task.id)
                XCTAssertFalse(runs.isEmpty, "\(label)/\(task.id)")
                XCTAssertEqual(runs.contains { $0.finishedAt == nil }, task.running, "\(label)/\(task.id): a running task has a run in flight")
                if let scriptId = task.scriptId { XCTAssertTrue(scripts.contains(scriptId), task.id) }
                XCTAssertTrue(Set(task.mcpServerIds ?? []).isSubset(of: servers), task.id)
            }
            let feed = try await client.scheduledRunNotifications()
            XCTAssertFalse(feed.notifications.isEmpty, label)
            XCTAssertTrue(feed.notifications.allSatisfy { item in tasks.contains { $0.id == item.taskId } }, label)
            let settings = try await client.scheduledSettings()
            XCTAssertEqual(settings.defaultTimezone, TimeZone.current.identifier)

            let workspace = AidenDemoFull.gitWorkspaceId
            let review = try await client.gitReview(workspaceId: workspace)
            guard case .review(let changes) = review.result else { return XCTFail("\(label): no review") }
            XCTAssertEqual(changes.files.count, changes.uncommitted, label)
            let first = try XCTUnwrap(changes.files.first)
            let diff = try await client.gitDiff(
                workspaceId: workspace,
                snapshotId: try XCTUnwrap(review.snapshotId),
                fileId: first.id
            )
            guard case .diff(let shown) = diff.result else { return XCTFail("\(label): no diff") }
            XCTAssertEqual(shown.displayPath, first.displayPath, label)
            guard case .branches(let branches) = try await client.gitBranches(workspaceId: workspace).result else {
                return XCTFail("\(label): no branches")
            }
            XCTAssertTrue(branches.branches.contains(branches.current), label)
            XCTAssertEqual(branches.current, changes.branch, label)
            guard case .pushCapability(let push) = try await client.gitPushCapability(workspaceId: workspace).result else {
                return XCTFail("\(label): no push capability")
            }
            XCTAssertTrue(push.allowed, label)
            guard case .worktrees(let worktrees) = try await client.gitWorktrees(workspaceId: workspace).result else {
                return XCTFail("\(label): no worktrees")
            }
            XCTAssertTrue(worktrees.worktrees.contains { $0.branch == changes.branch }, label)
        }
    }

    /// Usage reads like a real Mac's summary in every range: totals are the
    /// sum of the listed days and of the models, days are sparse, in order and
    /// inside the range, and streaks agree with the active days.
    func testFullScenarioUsageTotalsAgreeWithItsDaysInEveryRange() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.full, responder: responder)
        var requestsByMachine: [String: Int] = [:]
        for installation in coordinator.installationStore.installations {
            let client = client(for: installation, responder: responder)
            var previousDays = 0
            for range in ["7d", "30d", "90d", "1y", "all"] {
                let label = "\(installation.instanceId)/\(range)"
                let usage = try await client.usage(range: range)
                XCTAssertEqual(usage.range, range, label)
                let totals = usage.totals
                XCTAssertEqual(totals.requests, usage.days.reduce(0) { $0 + $1.requests }, label)
                XCTAssertEqual(totals.tokens.total, usage.days.reduce(0) { $0 + $1.tokens.total }, label)
                XCTAssertEqual(totals.hostedCostUsd, usage.days.reduce(0) { $0 + $1.hostedCostUsd }, accuracy: 0.0001, label)
                XCTAssertEqual(totals.requests, usage.models.reduce(0) { $0 + $1.requests }, label)
                XCTAssertEqual(totals.localRequests, usage.models.filter(\.local).reduce(0) { $0 + $1.requests }, label)
                XCTAssertEqual(
                    totals.requests,
                    totals.completedRequests + totals.failedRequests + totals.cancelledRequests,
                    label
                )
                XCTAssertEqual(totals.activeDays, usage.days.filter { $0.requests > 0 }.count, label)
                XCTAssertEqual(usage.days.map(\.date), usage.days.map(\.date).sorted(), label)
                XCTAssertEqual(Set(usage.days.map(\.date)).count, usage.days.count, label)
                XCTAssertTrue(usage.days.allSatisfy { $0.date >= usage.startDate && $0.date <= usage.endDate }, label)
                XCTAssertEqual(usage.models.map(\.requests), usage.models.map(\.requests).sorted(by: >), label)
                XCTAssertGreaterThan(totals.currentStreak, 0, label)
                XCTAssertGreaterThanOrEqual(totals.longestStreak, totals.currentStreak, label)
                XCTAssertLessThanOrEqual(totals.longestStreak, totals.activeDays, label)
                XCTAssertGreaterThanOrEqual(usage.days.count, previousDays, "\(label): a longer range lists fewer days")
                previousDays = usage.days.count
                if range == "7d" { XCTAssertLessThanOrEqual(usage.days.count, 7, label) }
                if range == "all" {
                    XCTAssertEqual(usage.startDate, usage.days.first?.date, label)
                    XCTAssertLessThan(usage.days.count, 120, "\(label): the history has gaps")
                    requestsByMachine[installation.instanceId] = totals.requests
                }
            }
        }
        XCTAssertEqual(Set(requestsByMachine.values).count, 2, "two machines must not show the same usage")
    }

}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return flag
    }

    func set() {
        lock.lock()
        flag = true
        lock.unlock()
    }
}
#endif
