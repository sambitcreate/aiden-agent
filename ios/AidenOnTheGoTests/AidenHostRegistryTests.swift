#if DEBUG
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenHostRegistryTests: XCTestCase {
    private let responder = AidenDemoResponder()

    private func connection(
        _ instanceId: String,
        in coordinator: AidenRemoteCoordinator
    ) throws -> AidenHostConnection {
        try XCTUnwrap(coordinator.hosts.connection(for: instanceId))
    }

    private func exchange(
        _ installation: AidenInstallation,
        deviceId: String? = nil
    ) -> AidenRemotePairing.PairingExchange {
        AidenRemotePairing.PairingExchange(
            protocolVersion: AidenRemoteProtocol.version,
            instanceId: installation.instanceId,
            deviceId: deviceId ?? installation.deviceId,
            credential: "repaired-credential",
            capabilities: installation.deviceCapabilities,
            endpoint: installation.endpoint,
            serverSpkiSha256: installation.serverSpkiSha256,
            displayName: installation.name
        )
    }

    private func repair(
        _ instanceId: String,
        in coordinator: AidenRemoteCoordinator
    ) async throws {
        let installation = try XCTUnwrap(
            coordinator.installationStore.installations.first { $0.id == instanceId }
        )
        try await coordinator.activatePairing(
            payload: AidenRemotePairing.PairingPayload(
                bootstrap: AidenRemotePairing.PairingBootstrap(
                    protocolVersion: AidenRemoteProtocol.version,
                    instanceId: instanceId,
                    endpoint: installation.endpoint,
                    serverSpkiSha256: installation.serverSpkiSha256,
                    secret: String(repeating: "B", count: 43),
                    expiresAt: Date().addingTimeInterval(120)
                ),
                trust: .init(mode: .system)
            ),
            exchange: exchange(installation)
        )
    }

    private func waitForRequest(_ request: String, instanceId: String) async throws {
        let deadline = Date().addingTimeInterval(30)
        while !responder.requests(instanceId: instanceId).contains(request), Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(responder.requests(instanceId: instanceId).contains(request), "\(request) never arrived")
    }

    // MARK: The registry

    func testEveryPairedMachineHasOneConnectionInPairingOrder() throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)

        let expected = coordinator.installationStore.installations
            .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
            .map(\.id)

        XCTAssertEqual(Set(coordinator.hosts.connections.keys), ["studio", "laptop", "mini", "build"])
        XCTAssertEqual(coordinator.hosts.ordered.map(\.instanceId), expected)
        XCTAssertTrue(coordinator.selectedConnection === coordinator.hosts.connection(for: "studio"))
        XCTAssertNil(coordinator.hosts.connection(for: "nowhere"))
    }

    func testEveryConnectionReachesTheCoordinatorEvenOnesPairedLater() throws {
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        let later = AidenDemoHosts.installation(instanceId: "later", name: "Later")
        _ = try coordinator.installationStore.savePairing(exchange(later), trust: .init(mode: .system), name: later.name)

        _ = try coordinator.requestContext(for: "later")

        XCTAssertEqual(coordinator.hosts.ordered.map(\.instanceId).sorted(), ["later", "studio"])
        for connection in coordinator.hosts.ordered {
            XCTAssertTrue(connection.delegate === coordinator, "\(connection.instanceId) has no delegate")
        }
    }

    func testAKeptConnectionPicksUpItsSavedRecord() throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        var saved = try XCTUnwrap(coordinator.installationStore.installations.first { $0.id == "laptop" })
        saved.name = "Renamed"
        let before = try connection("laptop", in: coordinator)

        coordinator.hosts.sync(with: coordinator.installationStore.installations.map { $0.id == "laptop" ? saved : $0 })

        XCTAssertTrue(try connection("laptop", in: coordinator) === before)
        XCTAssertEqual(before.installation.name, "Renamed")
    }

    func testRemovingOneInstallationDropsOnlyItsConnection() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let studio = try connection("studio", in: coordinator)
        let mini = try connection("mini", in: coordinator)
        let selectedContext = try coordinator.requestContext()
        let forgotten = try coordinator.requestContext(for: "laptop")

        await coordinator.removeInstallation("laptop")

        XCTAssertEqual(Set(coordinator.hosts.connections.keys), ["studio", "mini", "build"])
        XCTAssertNil(coordinator.hosts.connection(for: "laptop"))
        XCTAssertTrue(try connection("studio", in: coordinator) === studio)
        XCTAssertTrue(try connection("mini", in: coordinator) === mini)
        XCTAssertTrue(coordinator.selectedConnection === studio)
        XCTAssertTrue(coordinator.isCurrent(selectedContext))
        XCTAssertFalse(coordinator.isLive(forgotten))
        XCTAssertThrowsError(try coordinator.remoteClient(for: forgotten))
    }

    func testForgettingTheSelectedMachineSelectsAnother() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let forgotten = try coordinator.requestContext()

        await coordinator.removeInstallation("studio")

        XCTAssertNil(coordinator.hosts.connection(for: "studio"))
        XCTAssertNotNil(coordinator.activeInstanceId)
        XCTAssertEqual(coordinator.selectedConnection?.instanceId, coordinator.activeInstanceId)
        XCTAssertFalse(coordinator.isLive(forgotten))
    }

    func testPairingAForgottenMachineAgainNeverReissuesAContext() async throws {
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()
        let installation = try XCTUnwrap(coordinator.installationStore.activeInstallation)
        let old = try coordinator.requestContext()
        let attempt = try connection("studio", in: coordinator).connectionGeneration

        await coordinator.removeInstallation("studio")
        _ = try coordinator.installationStore.savePairing(
            exchange(installation), trust: .init(mode: .system), name: installation.name
        )

        let fresh = try coordinator.requestContext()
        XCTAssertEqual(fresh.instanceId, old.instanceId)
        XCTAssertEqual(fresh.deviceId, old.deviceId)
        XCTAssertGreaterThan(fresh.generation, old.generation)
        XCTAssertGreaterThan(try connection("studio", in: coordinator).connectionGeneration, attempt)
        XCTAssertFalse(coordinator.isLive(old))
        XCTAssertFalse(coordinator.isCurrent(old))
    }

    // MARK: Contexts and clients

    func testAContextForAnotherMachineIsLiveButNotCurrent() async throws {
        let c = AidenDemoHosts.coordinator(.four, responder: responder)
        let ctx = try c.requestContext(for: "laptop")   // selected is studio
        XCTAssertTrue(c.isLive(ctx)); XCTAssertFalse(c.isCurrent(ctx))
    }

    func testIsCurrentKeepsItsMeaningAfterSwitching() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let old = try coordinator.requestContext()
        XCTAssertTrue(coordinator.isCurrent(old))

        await coordinator.switchInstallation(to: "laptop")

        XCTAssertFalse(coordinator.isCurrent(old))
        XCTAssertTrue(coordinator.isLive(old))
        XCTAssertTrue(coordinator.isCurrent(try coordinator.requestContext()))
    }

    func testIsLiveTurnsFalseWhenThatMachinesGenerationMoves() throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let laptop = try coordinator.requestContext(for: "laptop")
        let mini = try coordinator.requestContext(for: "mini")

        try connection("laptop", in: coordinator).advanceGeneration()

        XCTAssertFalse(coordinator.isLive(laptop))
        XCTAssertThrowsError(try coordinator.remoteClient(for: laptop))
        XCTAssertTrue(coordinator.isLive(mini), "Another machine's generation is its own")
        XCTAssertTrue(coordinator.isLive(try coordinator.requestContext(for: "laptop")))
    }

    func testIsLiveIsFalseForAContextWithAnotherDevice() throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let context = try coordinator.requestContext(for: "laptop")

        let otherDevice = AidenRemoteRequestContext(
            instanceId: context.instanceId,
            deviceId: "other-device",
            generation: context.generation
        )

        XCTAssertFalse(coordinator.isLive(otherDevice))
        XCTAssertThrowsError(try coordinator.remoteClient(for: otherDevice))
    }

    func testIsLiveIsFalseWhenTheMachineIsPairedToAnotherDevice() throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let context = try coordinator.requestContext(for: "laptop")
        let installation = try XCTUnwrap(coordinator.installationStore.installations.first { $0.id == "laptop" })

        _ = try coordinator.installationStore.savePairing(
            exchange(installation, deviceId: "replacement-device"),
            trust: .init(mode: .system),
            name: installation.name
        )

        XCTAssertFalse(coordinator.isLive(context))
        XCTAssertThrowsError(try coordinator.remoteClient(for: context))
    }

    func testPairingAMachineAgainEndsOnlyItsOwnContexts() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let studio = try coordinator.requestContext()
        let laptop = try coordinator.requestContext(for: "laptop")

        try await repair("laptop", in: coordinator)

        XCTAssertEqual(coordinator.activeInstanceId, "laptop")
        XCTAssertFalse(coordinator.isLive(laptop))
        XCTAssertTrue(coordinator.isLive(studio))
        XCTAssertFalse(coordinator.isCurrent(studio))
    }

    func testRequestContextForAnUnpairedInstanceThrows() {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)

        XCTAssertThrowsError(try coordinator.requestContext(for: "nowhere")) { error in
            guard case AidenRemoteClientError.installationChanged = error else {
                return XCTFail("Expected installationChanged, got \(error)")
            }
        }
    }

    func testANonSelectedMachineGivesAClientWithoutConnecting() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let context = try coordinator.requestContext(for: "laptop")

        let client = try coordinator.remoteClient(for: context)

        XCTAssertTrue(try coordinator.remoteClient(for: context) === client)
        XCTAssertTrue(responder.requests(instanceId: "laptop").isEmpty, "A client must not start a connection")
        XCTAssertEqual(coordinator.hosts.connection(for: "laptop")?.server, nil)

        let server = try await client.server()

        XCTAssertEqual(server.instanceId, "laptop")
        XCTAssertTrue(responder.requests(instanceId: "studio").isEmpty, "The selected machine must not be asked")
    }

    func testStartingConnectsOnlyTheSelectedMachine() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)

        await coordinator.start()

        XCTAssertFalse(responder.requests(instanceId: "studio").isEmpty)
        for instanceId in ["laptop", "mini", "build"] {
            XCTAssertTrue(responder.requests(instanceId: instanceId).isEmpty, "\(instanceId) must not connect yet")
        }
    }

    func testRetainedDataWorkRunsForANonSelectedMachineUntilItIsForgotten() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let context = try coordinator.requestContext(for: "laptop")
        var runs = 0

        let retained = await coordinator.withRetainedInstallationData(for: context) { runs += 1 }

        XCTAssertTrue(retained)
        XCTAssertEqual(runs, 1)

        await coordinator.removeInstallation("laptop")
        let afterForgetting = await coordinator.withRetainedInstallationData(for: context) { runs += 1 }

        XCTAssertFalse(afterForgetting)
        XCTAssertEqual(runs, 1)
    }

    // MARK: Selection

    func testSwitchingKeepsEachMachinesOwnConnection() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let studio = try connection("studio", in: coordinator)
        let laptop = try connection("laptop", in: coordinator)

        await coordinator.switchInstallation(to: "laptop")
        XCTAssertTrue(coordinator.selectedConnection === laptop)
        await coordinator.switchInstallation(to: "studio")

        XCTAssertTrue(coordinator.selectedConnection === studio)
        XCTAssertTrue(try connection("laptop", in: coordinator) === laptop)
    }

    func testComingBackToAMachineEndsContextsFromBeforeIt() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let first = try coordinator.requestContext()

        await coordinator.switchInstallation(to: "laptop")
        XCTAssertTrue(coordinator.isLive(first))
        await coordinator.switchInstallation(to: "studio")

        XCTAssertFalse(coordinator.isCurrent(first))
        XCTAssertFalse(coordinator.isLive(first))
        XCTAssertThrowsError(try coordinator.remoteClient(for: first))
    }

    func testAConnectionNeverHoldsAnotherMachinesData() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let studio = try connection("studio", in: coordinator)
        let laptop = try connection("laptop", in: coordinator)
        let studioWorkspaces = studio.workspaces
        XCTAssertFalse(studioWorkspaces.isEmpty)
        let release = responder.hold(instanceId: "laptop", path: "/server")

        let switching = Task { await coordinator.switchInstallation(to: "laptop") }
        try await waitForRequest("GET /server", instanceId: "laptop")

        XCTAssertNil(laptop.server)
        XCTAssertTrue(laptop.workspaces.isEmpty)
        XCTAssertEqual(studio.server?.instanceId, "studio")
        XCTAssertEqual(studio.workspaces, studioWorkspaces)

        release()
        await switching.value

        XCTAssertEqual(laptop.server?.instanceId, "laptop")
        XCTAssertEqual(studio.server?.instanceId, "studio")
        XCTAssertEqual(studio.workspaces, studioWorkspaces)
        XCTAssertNotEqual(laptop.workspaces, studioWorkspaces)
    }

    func testAMachineWithNoSelectionHoldsNoServerOrWorkspaces() async throws {
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()
        XCTAssertNotNil(coordinator.server)

        await coordinator.removeInstallation("studio")

        XCTAssertNil(coordinator.selectedConnection)
        XCTAssertNil(coordinator.server)
        XCTAssertTrue(coordinator.workspaces.isEmpty)
        XCTAssertTrue(coordinator.hosts.connections.isEmpty)
    }

    // MARK: App-wide state

    func testConnectingTheSelectedMachineClearsTheAppWideError() async {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        coordinator.presentedError = "Shown to the person"

        await coordinator.connectActiveInstallation()

        XCTAssertNil(coordinator.presentedError)
    }

    func testANonSelectedConnectionLeavesTheAppWideErrorAlone() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let build = try connection("build", in: coordinator)
        coordinator.presentedError = "Shown to the person"

        await build.connect()

        XCTAssertEqual(coordinator.presentedError, "Shown to the person")

        coordinator.hostConnection(build, didFailWith: URLError(.cannotConnectToHost))

        XCTAssertEqual(coordinator.presentedError, "Shown to the person")
        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertNil(coordinator.connectionIssue)
    }

    func testANonSelectedSnapshotLeavesAppWideWorkspaceStateAlone() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let laptop = try connection("laptop", in: coordinator)
        let revision = coordinator.workspaceSnapshotRevision
        let shown = coordinator.workspaces

        laptop.adopt(workspaces: try XCTUnwrap(coordinator.selectedConnection).workspaces.map {
            var workspace = $0
            workspace.name = "On the laptop"
            return workspace
        })
        coordinator.hostConnectionDidApplyWorkspaceSnapshot(laptop)
        let deadline = Date().addingTimeInterval(30)
        var laptopSaved = await coordinator.hostConnectionSavedWorkspaces(laptop)
        while laptopSaved == nil, Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
            laptopSaved = await coordinator.hostConnectionSavedWorkspaces(laptop)
        }

        XCTAssertEqual(coordinator.workspaceSnapshotRevision, revision)
        XCTAssertEqual(coordinator.workspaces, shown)
        XCTAssertEqual(laptopSaved, laptop.workspaces, "A machine's snapshot is saved under its own ID")
        let studioSaved = await coordinator.hostConnectionSavedWorkspaces(try connection("studio", in: coordinator))
        XCTAssertFalse(studioSaved?.contains { $0.name == "On the laptop" } == true)
    }

    func testANonSelectedRevocationDoesNotRunTheSelectedMachinesCleanup() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let laptop = try connection("laptop", in: coordinator)
        let context = try coordinator.requestContext()

        await coordinator.hostConnectionWasRevoked(laptop)

        XCTAssertNotNil(coordinator.hosts.connection(for: "laptop"))
        XCTAssertNil(coordinator.presentedError)
        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertNotNil(coordinator.server)
        XCTAssertTrue(coordinator.isCurrent(context))
    }

    func testALateAnswerOnANonSelectedConnectionIsDropped() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let laptop = try connection("laptop", in: coordinator)
        let saved = coordinator.installationStore.installations.first { $0.id == "laptop" }
        let revision = coordinator.workspaceSnapshotRevision

        await laptop.connect()

        XCTAssertNil(laptop.server, "A non-selected answer waits for Task 13")
        XCTAssertEqual(coordinator.installationStore.installations.first { $0.id == "laptop" }, saved)
        XCTAssertEqual(coordinator.workspaceSnapshotRevision, revision)
    }
}
#endif
