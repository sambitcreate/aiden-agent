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

    func testDemoBotMemoryPageLoadsBothGroupsAndForgetAllEmptiesIt() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        let installation = try XCTUnwrap(coordinator.installationStore.activeInstallation)
        let machine = client(for: installation, responder: responder)
        let bots = try await machine.bots().bots
        let bot = try XCTUnwrap(bots.first)
        let model = AidenBotMemoryModel(botID: bot.id, botName: bot.name, transport: machine)

        let loaded = await model.load()

        XCTAssertTrue(loaded, "The demo Bot's memory did not decode")
        let memory = try XCTUnwrap(model.memory)
        XCTAssertTrue(memory.readable)
        XCTAssertFalse(memory.user.entries.isEmpty)
        XCTAssertFalse(memory.memory.entries.isEmpty)
        let longest = memory.memory.entries.map(\.text.count).max() ?? 0
        XCTAssertGreaterThan(longest, AidenBotMemoryWire.maxEntryLength * 4 / 5, "No entry near the length limit")

        let forgot = await model.erase()

        XCTAssertTrue(forgot)
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.memory?.entryCount, 0)
    }

    func testDemoBotMemoryEditsChangeOnlyTheEntryTheyName() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        let installation = try XCTUnwrap(coordinator.installationStore.activeInstallation)
        let machine = client(for: installation, responder: responder)
        let bots = try await machine.bots().bots
        let bot = try XCTUnwrap(bots.first)
        let model = AidenBotMemoryModel(botID: bot.id, botName: bot.name, transport: machine)
        _ = await model.load()
        let start = try XCTUnwrap(model.memory)
        let removed = try XCTUnwrap(start.user.entries.first)
        let rewritten = try XCTUnwrap(start.memory.entries.first)

        await model.delete(target: .user, entryId: removed.id)
        let failure = await model.save(target: .memory, entryId: rewritten.id, text: "Meal plan is vegan on weekdays.")

        XCTAssertNil(model.errorMessage)
        XCTAssertNil(failure)
        // A second reader sees the Mac's view, not this page's optimistic one.
        let reread = try await machine.botMemory(botId: bot.id)
        XCTAssertEqual(reread.user.entries.map(\.id), start.user.entries.dropFirst().map(\.id))
        XCTAssertEqual(reread.memory.entries.count, start.memory.entries.count)
        XCTAssertEqual(reread.memory.entries.first?.text, "Meal plan is vegan on weekdays.")
        XCTAssertNotEqual(reread.memory.entries.first?.id, rewritten.id, "A rewritten entry gets a new id, as on a Mac")
        XCTAssertEqual(Array(reread.memory.entries.dropFirst()), Array(start.memory.entries.dropFirst()))
        XCTAssertNotEqual(reread.revision, start.revision)
        XCTAssertEqual(model.memory, reread, "The page shows the Mac's answer, new id included")

        await model.delete(target: .user, entryId: removed.id)

        XCTAssertEqual(model.errorMessage, AidenBotMemoryCopy.entryChanged, "A deleted entry can't be deleted twice")
        XCTAssertEqual(model.memory, reread)

        let stale = await model.save(target: .memory, entryId: rewritten.id, text: "Meal plan is vegan every day.")

        XCTAssertEqual(stale, AidenBotMemoryCopy.entryChanged, "The old id no longer names an entry")
        XCTAssertEqual(model.memory, reread)

        // A retried request (same key) gets its first answer back and isn't applied again.
        let second = try XCTUnwrap(reread.memory.entries.dropFirst().first)
        let key = UUID()
        let removal = AidenBotMemoryEditRequest(edit: try .removing(target: .memory, entryId: second.id))
        let first = try await machine.editBotMemory(botId: bot.id, request: removal, idempotencyKey: key)
        let retried = try await machine.editBotMemory(botId: bot.id, request: removal, idempotencyKey: key)
        XCTAssertEqual(retried, first)
        XCTAssertEqual(first.memory.entries.count, reread.memory.entries.count - 1)
        do {
            _ = try await machine.editBotMemory(botId: bot.id, request: removal, idempotencyKey: UUID())
            XCTFail("A new key applies the edit again, and the entry is gone")
        } catch {
            XCTAssertEqual(AidenBotMemoryEditFailure(error), .entryNotFound)
        }
        _ = await model.load()

        let forgot = await model.erase()

        XCTAssertTrue(forgot)
        let cleared = try await machine.botMemory(botId: bot.id)
        XCTAssertEqual(cleared.entryCount, 0)
        XCTAssertEqual(cleared.user.usedChars + cleared.memory.usedChars, 0)
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
