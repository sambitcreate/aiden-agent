#if DEBUG
import CryptoKit
import XCTest
@testable import AidenOnTheGo

/// A Keychain whose reads can fail, or come back empty, on demand.
private final class AidenUnreliableKeychain: KeychainStoring {
    enum Read { case normal, failing, empty }
    struct ReadError: Error {}

    var read = Read.normal
    private var values: [String: String] = [:]

    private func value(_ key: String) throws -> String? {
        switch read {
        case .normal: values[key]
        case .failing: throw ReadError()
        case .empty: nil
        }
    }

    func save(_ value: String, forKey key: KeychainStore.Key) throws { values[key.rawValue] = value }
    func load(_ key: KeychainStore.Key) throws -> String? { try value(key.rawValue) }
    func delete(_ key: KeychainStore.Key) throws { values[key.rawValue] = nil }

    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        values[KeychainStore.scopedKey(key, scope: scope)] = value
    }

    func load(_ key: KeychainStore.Key, scope: String) throws -> String? {
        try value(KeychainStore.scopedKey(key, scope: scope))
    }

    func delete(_ key: KeychainStore.Key, scope: String) throws {
        values[KeychainStore.scopedKey(key, scope: scope)] = nil
    }
}

@MainActor
final class AidenHostConnectSchedulerTests: XCTestCase {
    private let responder = AidenDemoResponder()
    private let revokedJSON = Data("""
    {"error":{"code":"credential_revoked","message":"Pair this device again.",
    "requestId":"request-revoked","retryable":false}}
    """.utf8)
    private let everyMachine = ["studio", "laptop", "mini", "build"]

    /// Four machines, all reachable, in the order `.four` pairs them.
    private func fourOnlineMachines() -> AidenRemoteCoordinator {
        AidenDemoHosts.coordinator(
            installations: everyMachine.map { AidenDemoHosts.installation(instanceId: $0, name: $0) },
            responder: responder
        )
    }

    /// Registering a machine again gives it the standard answers.
    private func bringOnline(_ instanceId: String) {
        _ = AidenDemoHosts.coordinator(
            installations: [AidenDemoHosts.installation(instanceId: instanceId, name: instanceId)],
            responder: responder
        )
    }

    private func scheduler(
        for coordinator: AidenRemoteCoordinator,
        pathChanges: AsyncStream<Void> = AsyncStream { _ in },
        timeout: TimeInterval = 30
    ) -> AidenHostConnectScheduler {
        AidenHostConnectScheduler(
            registry: coordinator.hosts,
            pathChanges: pathChanges,
            maxConcurrentConnects: 2,
            probeTimeout: timeout
        )
    }

    private func connection(
        _ instanceId: String,
        in coordinator: AidenRemoteCoordinator
    ) throws -> AidenHostConnection {
        try XCTUnwrap(coordinator.hosts.connection(for: instanceId))
    }

    private func waitUntil(
        _ what: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: () async -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for \(what)", file: file, line: line)
    }

    private func serverRequests(_ instanceId: String) -> Int {
        responder.requests(instanceId: instanceId).filter { $0 == "GET /server" }.count
    }

    /// Time for a request that shouldn't happen to show up if it were coming.
    private func settle() async throws {
        try await Task.sleep(nanoseconds: 100_000_000)
    }

    private func isOffline(_ connection: AidenHostConnection) -> Bool {
        if case .offline = connection.connectionState { return true }
        return false
    }

    // MARK: Connecting every machine

    func testAnUnreachableMachineDoesNotDelayTheOthers() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let release = responder.hold(instanceId: "build", path: "/server")
        defer { release() }
        let scheduler = scheduler(for: coordinator, timeout: 0.2)

        await scheduler.foregrounded()

        for instanceId in ["studio", "laptop", "mini"] {
            XCTAssertEqual(try connection(instanceId, in: coordinator).connectionState, .connected, instanceId)
        }
        let build = try connection("build", in: coordinator)
        XCTAssertTrue(isOffline(build), "Got \(build.connectionState)")
        XCTAssertNotNil(build.connectionIssue)
    }

    func testAnUnreachableMachineGivesUpItsSlotForTheNextInLine() async throws {
        let coordinator = fourOnlineMachines()
        let releaseStudio = responder.hold(instanceId: "studio", path: "/server")
        let releaseLaptop = responder.hold(instanceId: "laptop", path: "/server")
        defer {
            releaseStudio()
            releaseLaptop()
        }
        let scheduler = scheduler(for: coordinator, timeout: 0.2)

        await scheduler.foregrounded()

        XCTAssertTrue(isOffline(try connection("studio", in: coordinator)))
        XCTAssertTrue(isOffline(try connection("laptop", in: coordinator)))
        XCTAssertEqual(try connection("mini", in: coordinator).connectionState, .connected)
        XCTAssertEqual(try connection("build", in: coordinator).connectionState, .connected)
    }

    func testAnAnswerAfterTheTimeoutIsDropped() async throws {
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        let release = responder.hold(instanceId: "studio", path: "/server")
        let scheduler = scheduler(for: coordinator, timeout: 0.1)

        await scheduler.foregrounded()
        release()
        try await settle()

        let studio = try connection("studio", in: coordinator)
        XCTAssertTrue(isOffline(studio))
        XCTAssertNil(studio.server)
    }

    func testAtMostTwoMachinesConnectAtOnce() async throws {
        let coordinator = fourOnlineMachines()
        let release = Dictionary(uniqueKeysWithValues: everyMachine.map {
            ($0, responder.hold(instanceId: $0, path: "/server"))
        })
        defer { release.values.forEach { $0() } }
        let scheduler = AidenHostConnectScheduler(registry: coordinator.hosts, pathChanges: AsyncStream { _ in })

        let pass = Task { await scheduler.foregrounded() }
        try await waitUntil("the first two machines") {
            self.serverRequests("studio") == 1 && self.serverRequests("laptop") == 1
        }
        try await settle()
        XCTAssertEqual(serverRequests("mini"), 0)
        XCTAssertEqual(serverRequests("build"), 0)

        release["studio"]?()
        release["laptop"]?()
        try await waitUntil("the next two machines") {
            self.serverRequests("mini") == 1 && self.serverRequests("build") == 1
        }
        release["mini"]?()
        release["build"]?()
        await pass.value

        for instanceId in everyMachine {
            XCTAssertEqual(try connection(instanceId, in: coordinator).connectionState, .connected, instanceId)
        }
    }

    func testTheSelectedMachineConnectsFirst() async throws {
        let coordinator = fourOnlineMachines()
        await coordinator.switchInstallation(to: "build")
        await coordinator.removeInstallation("studio")
        coordinator.selectedConnection?.disconnect()
        let release = everyMachine.map { responder.hold(instanceId: $0, path: "/server") }
        defer { release.forEach { $0() } }
        let before = serverRequests("build")
        let scheduler = scheduler(for: coordinator)

        let pass = Task { await scheduler.foregrounded() }
        try await waitUntil("the selected machine") { self.serverRequests("build") == before + 1 }

        release.forEach { $0() }
        await pass.value
    }

    func testAConnectedMachineIsLeftAlone() async throws {
        let coordinator = fourOnlineMachines()
        await coordinator.start()
        let before = serverRequests("studio")
        let scheduler = scheduler(for: coordinator)

        await scheduler.foregrounded()

        XCTAssertEqual(serverRequests("studio"), before)
        XCTAssertEqual(serverRequests("laptop"), 1)
    }

    func testABackgroundAnswerPersistsItsOwnMachinesRecord() async throws {
        let coordinator = fourOnlineMachines()
        await coordinator.start()
        let revision = coordinator.workspaceSnapshotRevision
        let shown = coordinator.workspaces
        let scheduler = scheduler(for: coordinator)

        await scheduler.foregrounded()

        let saved = try XCTUnwrap(coordinator.installationStore.installations.first { $0.id == "laptop" })
        XCTAssertNotNil(saved.lastConnectedAt)
        XCTAssertEqual(try connection("laptop", in: coordinator).server?.instanceId, "laptop")
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
        XCTAssertEqual(coordinator.server?.instanceId, "studio")
        XCTAssertEqual(coordinator.workspaces, shown)
        XCTAssertEqual(coordinator.workspaceSnapshotRevision, revision, "The revision describes the selected machine")
    }

    // MARK: The probe client

    func testAProbeConnectUsesTheProbeClient() async throws {
        _ = AidenDemoHosts.coordinator(.one, responder: responder)
        var interactive = 0
        var probes = 0
        let client = { [responder] (installation: AidenInstallation, credential: String) in
            AidenRemoteClient(endpoint: installation.endpoint, credential: credential, session: responder.session)
        }
        let connection = AidenHostConnection(
            installation: AidenDemoHosts.installation(instanceId: "studio", name: "Studio"),
            credential: { "demo-test-credential" },
            clientFactory: { interactive += 1; return client($0, $1) },
            probeClientFactory: { probes += 1; return client($0, $1) }
        )

        await connection.connect(over: .probe)

        XCTAssertEqual(connection.connectionState, .connected)
        XCTAssertEqual(probes, 1)
        XCTAssertEqual(interactive, 0)
        XCTAssertTrue(try connection.probeClient() === connection.probeClient())
        XCTAssertFalse(try connection.probeClient() === connection.client())
    }

    func testTheProbeClientGivesUpWhereTheInteractiveClientWaits() throws {
        let installation = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")

        let probe = try AidenRemoteCoordinator.probeClientFactory(installation, "credential").requestPolicy
        let interactive = try AidenRemoteClient(installation: installation, credential: "credential").requestPolicy

        XCTAssertFalse(probe.waitsForConnectivity)
        XCTAssertEqual(probe.requestTimeout, 10)
        XCTAssertTrue(interactive.waitsForConnectivity)
        XCTAssertEqual(interactive.requestTimeout, AidenRemoteClient.SessionPolicy.idleTimeout)
    }

    // MARK: Path changes

    func testAPathChangeReconnectsOfflineMachines() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let (pathChanges, pathChanged) = AsyncStream<Void>.makeStream()
        let scheduler = scheduler(for: coordinator, pathChanges: pathChanges)
        await scheduler.foregrounded()
        let build = try connection("build", in: coordinator)
        XCTAssertTrue(isOffline(build))
        let studioRequests = serverRequests("studio")

        bringOnline("build")
        pathChanged.yield()

        try await waitUntil("build to reconnect") { build.connectionState == .connected }
        XCTAssertEqual(serverRequests("studio"), studioRequests, "A connected machine stays as it is")
    }

    func testAPathChangeInTheBackgroundConnectsNothing() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let (pathChanges, pathChanged) = AsyncStream<Void>.makeStream()
        let scheduler = scheduler(for: coordinator, pathChanges: pathChanges)
        await scheduler.foregrounded()
        scheduler.backgrounded()
        let before = responder.requests(instanceId: "build").count

        pathChanged.yield()
        try await settle()

        XCTAssertEqual(responder.requests(instanceId: "build").count, before)
    }

    func testAFailedProbeOnTheSelectedMachineRaisesNoAlert() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.switchInstallation(to: "build")
        coordinator.presentedError = nil
        let (pathChanges, pathChanged) = AsyncStream<Void>.makeStream()
        let scheduler = scheduler(for: coordinator, pathChanges: pathChanges)
        await scheduler.foregrounded()
        let before = responder.requests(instanceId: "build").count
        coordinator.presentedError = "Shown to the person"

        pathChanged.yield()
        try await waitUntil("another attempt on build") {
            responder.requests(instanceId: "build").count > before && !(coordinator.selectedConnection?.isConnectInFlight ?? true)
        }

        XCTAssertEqual(coordinator.presentedError, "Shown to the person")
        XCTAssertTrue(isOffline(try connection("build", in: coordinator)))
    }

    // MARK: Backgrounding

    func testBackgroundingCancelsPendingConnects() async throws {
        let coordinator = fourOnlineMachines()
        let release = everyMachine.map { responder.hold(instanceId: $0, path: "/server") }
        defer { release.forEach { $0() } }
        let scheduler = scheduler(for: coordinator)

        let pass = Task { await scheduler.foregrounded() }
        try await waitUntil("the first two machines") {
            self.serverRequests("studio") == 1 && self.serverRequests("laptop") == 1
        }
        scheduler.backgrounded()
        await pass.value
        release.forEach { $0() }
        try await settle()

        XCTAssertEqual(serverRequests("mini"), 0)
        XCTAssertEqual(serverRequests("build"), 0)
        for instanceId in ["studio", "laptop"] {
            let connection = try connection(instanceId, in: coordinator)
            XCTAssertFalse(connection.isConnectInFlight, instanceId)
            XCTAssertNil(connection.server, "The cancelled attempt's answer must not land")
        }
    }

    func testNothingStaysConnectingAfterComingBack() async throws {
        let coordinator = fourOnlineMachines()
        let release = everyMachine.map { responder.hold(instanceId: $0, path: "/server") }
        let scheduler = scheduler(for: coordinator)
        let pass = Task { await scheduler.foregrounded() }
        try await waitUntil("the first two machines") {
            self.serverRequests("studio") == 1 && self.serverRequests("laptop") == 1
        }
        scheduler.backgrounded()
        await pass.value
        release.forEach { $0() }

        await scheduler.foregrounded()

        for instanceId in everyMachine {
            XCTAssertEqual(try connection(instanceId, in: coordinator).connectionState, .connected, instanceId)
        }
    }

    func testCancellingDuringNegotiationKeepsTheConnectedState() async throws {
        var laptopInstallation = AidenDemoHosts.installation(instanceId: "laptop", name: "laptop")
        laptopInstallation.deviceCapabilities.removeAll { $0 == .tasksRead }
        let coordinator = AidenDemoHosts.coordinator(
            installations: [AidenDemoHosts.installation(instanceId: "studio", name: "studio"), laptopInstallation],
            responder: responder
        )
        let laptop = try connection("laptop", in: coordinator)
        responder.fail(instanceId: "laptop", path: "*", code: .notConnectedToInternet)
        await laptop.connect(over: .probe)
        XCTAssertTrue(isOffline(laptop))
        bringOnline("laptop")
        let release = responder.hold(instanceId: "laptop", path: "/device/capabilities")
        defer { release() }

        let attempt = Task { await laptop.connect(over: .probe) }
        try await waitUntil("negotiation to start") {
            responder.requests(instanceId: "laptop").contains { $0.hasSuffix("/device/capabilities") }
        }
        XCTAssertEqual(laptop.connectionState, .connected)
        XCTAssertTrue(laptop.isConnectInFlight)

        laptop.cancelConnect()

        XCTAssertEqual(laptop.connectionState, .connected, "A good answer outranks the state before it")
        XCTAssertNil(laptop.connectionIssue)
        XCTAssertFalse(laptop.isConnectInFlight)
        release()
        await attempt.value
    }

    func testBackgroundingLeavesAnOfflineMachineOfflineAndNotConnecting() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let scheduler = scheduler(for: coordinator)
        await scheduler.foregrounded()
        let build = try connection("build", in: coordinator)
        let issue = build.connectionIssue
        XCTAssertNotNil(issue)
        let release = responder.hold(instanceId: "build", path: "/server")
        defer { release() }

        let attempt = Task { await scheduler.foregrounded() }
        try await waitUntil("build's retry") { build.connectionState == .connecting && build.isConnectInFlight }
        scheduler.backgrounded()
        await attempt.value

        XCTAssertTrue(isOffline(build))
        XCTAssertEqual(build.connectionIssue, issue)
    }

    func testBackgroundingKeepsEveryOwnerContextLive() async throws {
        let coordinator = fourOnlineMachines()
        let scheduler = scheduler(for: coordinator)
        await scheduler.foregrounded()
        let contexts = try everyMachine.map { try coordinator.ownerContext(for: $0) }
        let release = responder.hold(instanceId: "laptop", path: "/server")
        defer { release() }
        scheduler.backgrounded()
        let pass = Task { await scheduler.foregrounded() }
        try await waitUntil("laptop's check") { self.serverRequests("laptop") == 2 }

        scheduler.backgrounded()
        await pass.value

        for context in contexts {
            XCTAssertTrue(coordinator.isLive(context), context.instanceId)
            XCTAssertNoThrow(try coordinator.remoteClient(for: context))
        }
    }

    func testComingBackChecksConnectedMachinesAgain() async throws {
        let coordinator = fourOnlineMachines()
        let scheduler = scheduler(for: coordinator)
        await scheduler.foregrounded()
        scheduler.backgrounded()

        responder.fail(instanceId: "laptop", path: "*", code: .cannotConnectToHost)
        await scheduler.foregrounded()

        XCTAssertTrue(isOffline(try connection("laptop", in: coordinator)), "A connection from before can't be trusted")
        XCTAssertEqual(try connection("mini", in: coordinator).connectionState, .connected)
    }

    func testADisconnectedMachineIsConnectedAgainRatherThanLeftConnecting() async throws {
        let coordinator = fourOnlineMachines()
        let scheduler = scheduler(for: coordinator)
        await scheduler.foregrounded()
        let laptop = try connection("laptop", in: coordinator)

        laptop.disconnect()
        XCTAssertEqual(laptop.connectionState, .connecting)
        XCTAssertFalse(laptop.isConnectInFlight)
        await scheduler.foregrounded()

        XCTAssertEqual(laptop.connectionState, .connected)
    }

    func testAMachineLeftMidConnectIsConnectedInTheBackground() async throws {
        let coordinator = fourOnlineMachines()
        let release = responder.hold(instanceId: "studio", path: "/server")
        let starting = Task { await coordinator.start() }
        try await waitUntil("studio's connect") { self.serverRequests("studio") == 1 }

        await coordinator.switchInstallation(to: "laptop")
        await starting.value
        let studio = try connection("studio", in: coordinator)
        XCTAssertFalse(studio.isConnectInFlight, "The selection leaving stops the attempt")
        XCTAssertEqual(coordinator.connectionState, .connected)
        release()

        await scheduler(for: coordinator).foregrounded()

        XCTAssertEqual(studio.connectionState, .connected)
        XCTAssertEqual(studio.server?.instanceId, "studio")
    }

    // MARK: Failures stay on their own machine

    func testANonSelectedFailureShowsNothing() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        coordinator.presentedError = "Shown to the person"
        let scheduler = scheduler(for: coordinator)

        await scheduler.foregrounded()

        let build = try connection("build", in: coordinator)
        XCTAssertTrue(isOffline(build), "Its failure lands on its own connection")
        XCTAssertNotNil(build.connectionIssue)
        XCTAssertEqual(coordinator.presentedError, "Shown to the person")
        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertNil(coordinator.connectionIssue)
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
    }

    func testPairingScreenOnlyShowsWhenNoMachinesRemain() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let ordered = coordinator.hosts.ordered
        let selected = try XCTUnwrap(coordinator.selectedConnection)
        let position = try XCTUnwrap(ordered.firstIndex { $0 === selected })
        let next = ordered[(position + 1) % ordered.count]

        selected.markRevoked()
        await coordinator.refreshWorkspaces()

        XCTAssertEqual(coordinator.activeInstanceId, next.instanceId)
        XCTAssertNotEqual(coordinator.connectionState, .needsPairing)
        try await waitUntil("the next machine to connect") { coordinator.connectionState == .connected }
        XCTAssertEqual(coordinator.server?.instanceId, next.instanceId)
    }

    func testPairingScreenShowsWhenTheOnlyMachineNeedsIt() async throws {
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()
        let selected = try XCTUnwrap(coordinator.selectedConnection)

        selected.markRevoked()
        await coordinator.refreshWorkspaces()

        XCTAssertEqual(coordinator.connectionState, .needsPairing)
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
    }

    func testAMachineThatNeedsPairingIsNeitherChosenNorRetried() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let laptop = try connection("laptop", in: coordinator)
        laptop.adopt(connectionState: .needsPairing)

        let studio = try connection("studio", in: coordinator)
        studio.adopt(connectionState: .needsPairing)

        XCTAssertNotEqual(coordinator.activeInstanceId, "laptop")
        XCTAssertNotEqual(coordinator.activeInstanceId, "studio")
        await scheduler(for: coordinator).foregrounded()
        XCTAssertEqual(laptop.connectionState, .needsPairing)
        XCTAssertTrue(responder.requests(instanceId: "laptop").isEmpty)
    }

    // MARK: Forgetting and revoking

    func testForgettingANonSelectedMachineDoesNotRestartTheSelectedOne() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let before = serverRequests("studio")
        let server = coordinator.server
        let workspaces = coordinator.workspaces
        let context = try coordinator.requestContext()

        await coordinator.removeInstallation("laptop")

        XCTAssertEqual(serverRequests("studio"), before)
        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertEqual(coordinator.server, server)
        XCTAssertEqual(coordinator.workspaces, workspaces)
        XCTAssertTrue(coordinator.isCurrent(context))
    }

    func testRevokedBackgroundMachineKeepsItsOnScreenChatUntilLeft() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let scheduler = scheduler(for: coordinator)
        await scheduler.foregrounded()
        let laptop = try connection("laptop", in: coordinator)
        try await waitUntil("laptop's saved rows") {
            await coordinator.hostConnectionSavedWorkspaces(laptop) != nil
        }
        let chatOnScreen = NSObject()
        coordinator.setOnScreen(true, view: chatOnScreen, instanceId: "laptop")
        coordinator.presentedError = nil
        scheduler.backgrounded()
        responder.reply(instanceId: "laptop", path: "/server", status: 401, json: revokedJSON)

        await scheduler.foregrounded()

        XCTAssertTrue(laptop.isRevoked)
        XCTAssertTrue(laptop.isPurgePending)
        XCTAssertEqual(laptop.connectionState, .needsPairing)
        let kept = await coordinator.hostConnectionSavedWorkspaces(laptop)
        XCTAssertNotNil(kept, "Cached rows stay while the chat is on screen")
        XCTAssertNotNil(coordinator.installationStore.installations.first { $0.id == "laptop" })
        XCTAssertNil(coordinator.presentedError)
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
        XCTAssertEqual(coordinator.connectionState, .connected)

        await coordinator.completeRevokedPurge(instanceId: "laptop")?.value

        XCTAssertFalse(laptop.isPurgePending)
        XCTAssertNil(coordinator.installationStore.installations.first { $0.id == "laptop" })
        XCTAssertNil(coordinator.hosts.connection(for: "laptop"))
        let purged = await coordinator.hostConnectionSavedWorkspaces(laptop)
        XCTAssertNil(purged)
        XCTAssertEqual(coordinator.activeInstanceId, "studio")
        XCTAssertEqual(coordinator.connectionState, .connected)
    }

    func testTheLastViewLeavingARevokedMachineEndsTheWait() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let laptop = try connection("laptop", in: coordinator)
        let first = NSObject()
        let second = NSObject()
        coordinator.setOnScreen(true, view: first, instanceId: "laptop")
        coordinator.setOnScreen(true, view: second, instanceId: "laptop")

        await coordinator.hostConnectionWasRevokedInBackground(laptop)
        coordinator.setOnScreen(false, view: first, instanceId: "laptop")
        try await settle()
        XCTAssertTrue(laptop.isPurgePending)
        XCTAssertNotNil(coordinator.hosts.connection(for: "laptop"))

        coordinator.setOnScreen(false, view: second, instanceId: "laptop")

        try await waitUntil("the purge") { coordinator.hosts.connection(for: "laptop") == nil }
    }

    func testARevokedMachineWithNothingOnScreenIsPurgedAtOnce() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let scheduler = scheduler(for: coordinator)
        await scheduler.foregrounded()
        let laptop = try connection("laptop", in: coordinator)
        try await waitUntil("laptop's saved rows") {
            await coordinator.hostConnectionSavedWorkspaces(laptop) != nil
        }
        coordinator.presentedError = nil
        let studioSaved = await coordinator.hostConnectionSavedWorkspaces(try connection("studio", in: coordinator))
        scheduler.backgrounded()
        responder.reply(instanceId: "laptop", path: "/server", status: 401, json: revokedJSON)

        await scheduler.foregrounded()

        XCTAssertTrue(laptop.isRevoked)
        XCTAssertFalse(laptop.isPurgePending)
        XCTAssertNil(coordinator.installationStore.installations.first { $0.id == "laptop" })
        XCTAssertNil(coordinator.hosts.connection(for: "laptop"))
        let purged = await coordinator.hostConnectionSavedWorkspaces(laptop)
        XCTAssertNil(purged)
        XCTAssertNil(coordinator.presentedError, "A non-selected machine shows nothing")
        let stillSaved = await coordinator.hostConnectionSavedWorkspaces(try connection("studio", in: coordinator))
        XCTAssertEqual(stillSaved, studioSaved, "Another machine's data stays")
    }

    func testA401FromAContextOnANonSelectedMachineReachesThatMachine() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let laptop = try connection("laptop", in: coordinator)
        let view = NSObject()
        coordinator.setOnScreen(true, view: view, instanceId: "laptop")
        let context = try coordinator.ownerContext(for: "laptop")
        let body = try AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.self, from: revokedJSON).error

        let handled = await coordinator.handleCredentialRevocation(
            AidenRemoteClientError.server(statusCode: 401, body: body),
            context: context
        )

        XCTAssertTrue(handled)
        XCTAssertTrue(laptop.isRevoked)
        XCTAssertTrue(laptop.isPurgePending)
        XCTAssertFalse(coordinator.isLive(context))
        XCTAssertFalse(try connection("studio", in: coordinator).isRevoked)
    }

    func testA401OnAMachineSelectedAgainTakesTheSelectedPath() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let context = try coordinator.ownerContext(for: "studio")
        await coordinator.switchInstallation(to: "laptop")
        await coordinator.switchInstallation(to: "studio")
        XCTAssertFalse(coordinator.isCurrent(context))
        let body = try AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.self, from: revokedJSON).error

        let handled = await coordinator.handleCredentialRevocation(
            AidenRemoteClientError.server(statusCode: 401, body: body),
            context: context
        )

        XCTAssertTrue(handled)
        XCTAssertNil(coordinator.installationStore.installations.first { $0.id == "studio" })
        XCTAssertTrue(coordinator.presentedError?.contains("revoked") == true)
    }

    func testAContextFromBeforeARepairCannotRevokeTheNewPairing() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let laptop = try connection("laptop", in: coordinator)
        let old = try coordinator.ownerContext(for: "laptop")
        laptop.advanceHostGeneration()
        let body = try AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.self, from: revokedJSON).error

        let handled = await coordinator.handleCredentialRevocation(
            AidenRemoteClientError.server(statusCode: 401, body: body),
            context: old
        )

        XCTAssertFalse(handled)
        XCTAssertFalse(laptop.isRevoked)
    }

    func testSelectingAMachineRevokedInTheBackgroundMovesOn() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let view = NSObject()
        coordinator.setOnScreen(true, view: view, instanceId: "laptop")
        await coordinator.hostConnectionWasRevokedInBackground(try connection("laptop", in: coordinator))

        await coordinator.switchInstallation(to: "laptop")

        XCTAssertNil(coordinator.hosts.connection(for: "laptop"))
        XCTAssertNil(coordinator.installationStore.installations.first { $0.id == "laptop" })
        XCTAssertNotEqual(coordinator.connectionState, .needsPairing)
        XCTAssertTrue(coordinator.presentedError?.contains("revoked") == true)
    }

    func testSelectingARevokedMachineRemovesItsLegacyEnvironmentFiles() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "AidenEnvironment-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let coordinator = AidenDemoHosts.coordinator(
            installations: ["studio", "laptop"].map { AidenDemoHosts.installation(instanceId: $0, name: $0) },
            responder: responder,
            workspaceEnvironmentCache: AidenWorkspaceEnvironmentCache(directory: directory)
        )
        await coordinator.start()
        let laptop = try connection("laptop", in: coordinator)
        await laptop.connect(over: .probe)
        let workspaceId = try XCTUnwrap(laptop.workspaces.first?.id)
        let digest = SHA256.hash(data: Data("laptop\u{0}\(workspaceId)".utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        let legacyFile = directory.appending(path: "\(digest).json")
        try Data("{}".utf8).write(to: legacyFile, options: .atomic)
        let view = NSObject()
        coordinator.setOnScreen(true, view: view, instanceId: "laptop")
        await coordinator.hostConnectionWasRevokedInBackground(laptop)

        await coordinator.switchInstallation(to: "laptop")

        XCTAssertNil(coordinator.hosts.connection(for: "laptop"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyFile.path))
    }

    func testARevokedSelectionConnectsTheNextMachinePastTheDeadline() async throws {
        let coordinator = AidenDemoHosts.coordinator(
            installations: ["studio", "laptop"].map { AidenDemoHosts.installation(instanceId: $0, name: $0) },
            responder: responder
        )
        await coordinator.start()
        responder.reply(instanceId: "studio", path: "/server", status: 401, json: revokedJSON)
        let release = responder.hold(instanceId: "laptop", path: "/server")
        defer { release() }
        let studio = try connection("studio", in: coordinator)

        let attempt = Task { await studio.connect(over: .probe, timeout: 0.1) }
        try await waitUntil("the next machine's connect") { serverRequests("laptop") == 1 }
        try await Task.sleep(nanoseconds: 300_000_000)
        release()
        await attempt.value

        XCTAssertEqual(coordinator.activeInstanceId, "laptop")
        XCTAssertEqual(coordinator.connectionState, .connected)
    }

    private func keychainCoordinator(_ keychain: AidenUnreliableKeychain) -> AidenRemoteCoordinator {
        AidenDemoHosts.coordinator(
            installations: ["studio", "laptop"].map { AidenDemoHosts.installation(instanceId: $0, name: $0) },
            responder: responder,
            keychain: keychain
        )
    }

    func testAKeychainReadErrorDoesNotMoveTheSelection() async throws {
        let keychain = AidenUnreliableKeychain()
        let coordinator = keychainCoordinator(keychain)
        keychain.read = .failing

        await coordinator.refreshWorkspaces()

        XCTAssertEqual(coordinator.activeInstanceId, "studio")
        XCTAssertNotEqual(coordinator.connectionState, .needsPairing)
        XCTAssertTrue(isOffline(try connection("studio", in: coordinator)))
    }

    func testAMissingCredentialStillMovesTheSelection() async throws {
        let keychain = AidenUnreliableKeychain()
        let coordinator = keychainCoordinator(keychain)
        keychain.read = .empty

        await coordinator.refreshWorkspaces()

        XCTAssertEqual(try connection("studio", in: coordinator).connectionState, .needsPairing)
        XCTAssertEqual(coordinator.activeInstanceId, "laptop")
    }

    func testPairingARevokedMachineAgainGivesItAWorkingConnection() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let laptop = try connection("laptop", in: coordinator)
        let view = NSObject()
        coordinator.setOnScreen(true, view: view, instanceId: "laptop")
        await coordinator.hostConnectionWasRevokedInBackground(laptop)
        let installation = laptop.installation

        try await coordinator.activatePairing(
            payload: AidenRemotePairing.PairingPayload(
                bootstrap: AidenRemotePairing.PairingBootstrap(
                    protocolVersion: AidenRemoteProtocol.version,
                    instanceId: "laptop",
                    endpoint: installation.endpoint,
                    serverSpkiSha256: installation.serverSpkiSha256,
                    secret: String(repeating: "B", count: 43),
                    expiresAt: Date().addingTimeInterval(120)
                ),
                trust: .init(mode: .system)
            ),
            exchange: AidenRemotePairing.PairingExchange(
                protocolVersion: AidenRemoteProtocol.version,
                instanceId: "laptop",
                deviceId: installation.deviceId,
                credential: "repaired-credential",
                capabilities: installation.deviceCapabilities,
                endpoint: installation.endpoint,
                serverSpkiSha256: installation.serverSpkiSha256,
                displayName: installation.name
            )
        )

        let fresh = try connection("laptop", in: coordinator)
        XCTAssertFalse(fresh === laptop)
        XCTAssertFalse(fresh.isRevoked)
        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertNoThrow(try coordinator.remoteClient(for: coordinator.ownerContext(for: "laptop")))
    }

    // MARK: Arriving at a machine

    func testSwitchingToAConnectedMachineKeepsItsData() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        await scheduler(for: coordinator).foregrounded()
        let laptop = try connection("laptop", in: coordinator)
        let workspaces = laptop.workspaces
        XCTAssertFalse(workspaces.isEmpty)
        let release = responder.hold(instanceId: "laptop", path: "/server")

        let switching = Task { await coordinator.switchInstallation(to: "laptop") }
        try await waitUntil("laptop's check") { self.serverRequests("laptop") == 2 }

        XCTAssertEqual(coordinator.server?.instanceId, "laptop")
        XCTAssertEqual(coordinator.workspaces, workspaces)

        release()
        await switching.value
    }

    func testSwitchingToAnOfflineMachineStillClearsIt() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        await scheduler(for: coordinator).foregrounded()
        let laptop = try connection("laptop", in: coordinator)
        laptop.adopt(connectionState: .offline(message: "Unreachable"))
        let release = responder.hold(instanceId: "laptop", path: "/server")

        let switching = Task { await coordinator.switchInstallation(to: "laptop") }
        try await waitUntil("laptop's check") { self.serverRequests("laptop") == 2 }

        XCTAssertNil(coordinator.server)

        release()
        await switching.value
    }

    /// Holds the installation-data lock, so a purge can be seen part way
    /// through. `body` hands back the work that is waiting on the lock.
    private func holdingThePurge(
        in coordinator: AidenRemoteCoordinator,
        during body: () async throws -> Task<Void, Never>
    ) async throws {
        let context = try coordinator.ownerContext(for: "mini")
        let (held, holdStarted) = AsyncStream<Void>.makeStream()
        let (gate, open) = AsyncStream<Void>.makeStream()
        let holder = Task {
            _ = await coordinator.withRetainedInstallationData(for: context) {
                holdStarted.finish()
                for await _ in gate {}
            }
        }
        for await _ in held {}
        let waiting = try await body()
        open.finish()
        await holder.value
        await waiting.value
    }

    func testForgettingTheSelectedMachineShowsAConnectedArrivalAsItIs() async throws {
        let coordinator = fourOnlineMachines()
        await coordinator.start()
        await scheduler(for: coordinator).foregrounded()
        let next = try XCTUnwrap(coordinator.installationStore.installations.first { $0.id != "studio" })
        let arriving = try connection(next.id, in: coordinator)
        // The store falls back to its first record, so that one must be connected.
        guard arriving.connectionState == .connected else { return XCTFail("\(next.id) isn't connected") }

        try await holdingThePurge(in: coordinator) {
            let forgetting = Task { await coordinator.removeInstallation("studio") }
            try await waitUntil("the selection to move") { coordinator.activeInstanceId == next.id }

            XCTAssertEqual(coordinator.connectionState, .connected)
            XCTAssertEqual(coordinator.server?.instanceId, next.id)
            XCTAssertEqual(coordinator.workspaces, arriving.workspaces)
            XCTAssertFalse(coordinator.workspaces.isEmpty)
            return forgetting
        }
    }

    func testForgettingTheSelectedMachineNeverShowsAStaleArrival() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let next = try XCTUnwrap(coordinator.installationStore.installations.first { $0.id != "studio" })
        let arriving = try connection(next.id, in: coordinator)
        arriving.adopt(connectionState: .offline(message: "From earlier"))
        arriving.adopt(connectionIssue: AidenConnectionIssue.classify(URLError(.cannotConnectToHost)))

        try await holdingThePurge(in: coordinator) {
            let forgetting = Task { await coordinator.removeInstallation("studio") }
            try await waitUntil("the selection to move") { coordinator.activeInstanceId == next.id }

            XCTAssertEqual(coordinator.connectionState, .connecting)
            XCTAssertNil(coordinator.connectionIssue)
            XCTAssertNil(coordinator.server)
            return forgetting
        }
    }

    func testARevokedSelectionNeverShowsAStaleArrival() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let studio = try connection("studio", in: coordinator)
        let next = try XCTUnwrap(coordinator.installationStore.installations.first { $0.id != "studio" })
        let arriving = try connection(next.id, in: coordinator)
        arriving.adopt(connectionState: .offline(message: "From earlier"))
        arriving.adopt(connectionIssue: AidenConnectionIssue.classify(URLError(.cannotConnectToHost)))

        try await holdingThePurge(in: coordinator) {
            let revoking = Task { await coordinator.hostConnectionWasRevoked(studio) }
            try await waitUntil("the selection to move") { coordinator.activeInstanceId == next.id }

            XCTAssertEqual(coordinator.connectionState, .connecting)
            XCTAssertNil(coordinator.connectionIssue)
            return revoking
        }
    }
}
#endif
