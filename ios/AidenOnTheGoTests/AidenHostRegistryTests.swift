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

        _ = try coordinator.ownerContext(for: "later")

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
        let forgotten = try coordinator.ownerContext(for: "laptop")

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
        let oldOwner = try coordinator.ownerContext(for: "studio")
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
        XCTAssertGreaterThan(try coordinator.ownerContext(for: "studio").hostGeneration, oldOwner.hostGeneration)
        XCTAssertFalse(coordinator.isLive(oldOwner))
        XCTAssertThrowsError(try coordinator.remoteClient(for: oldOwner))
    }

    // MARK: Contexts and clients

    func testAContextForAnotherMachineIsLiveButNotCurrent() async throws {
        let c = AidenDemoHosts.coordinator(.four, responder: responder)
        let ctx = try c.ownerContext(for: "laptop")   // selected is studio
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
        let laptop = try coordinator.ownerContext(for: "laptop")
        let mini = try coordinator.ownerContext(for: "mini")

        try connection("laptop", in: coordinator).disconnect()

        XCTAssertFalse(coordinator.isLive(laptop))
        XCTAssertThrowsError(try coordinator.remoteClient(for: laptop))
        XCTAssertTrue(coordinator.isLive(mini), "Another machine's generation is its own")
        XCTAssertTrue(coordinator.isLive(try coordinator.ownerContext(for: "laptop")))
    }

    func testARevokedMachineEndsItsContexts() throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let context = try coordinator.ownerContext(for: "laptop")

        try connection("laptop", in: coordinator).markRevoked()

        XCTAssertFalse(coordinator.isLive(context))
        XCTAssertThrowsError(try coordinator.remoteClient(for: context))
        XCTAssertThrowsError(try coordinator.ownerContext(for: "laptop"))
    }

    func testIsLiveIsFalseForAContextWithAnotherDevice() throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let context = try coordinator.ownerContext(for: "laptop")

        let otherDevice = AidenRemoteRequestContext(
            instanceId: context.instanceId,
            deviceId: "other-device",
            generation: context.generation,
            hostGeneration: context.hostGeneration,
            scope: .owner
        )

        XCTAssertFalse(coordinator.isLive(otherDevice))
        XCTAssertThrowsError(try coordinator.remoteClient(for: otherDevice))
    }

    func testIsLiveIsFalseWhenTheMachineIsPairedToAnotherDevice() throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let context = try coordinator.ownerContext(for: "laptop")
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
        let laptop = try coordinator.ownerContext(for: "laptop")

        try await repair("laptop", in: coordinator)

        XCTAssertEqual(coordinator.activeInstanceId, "laptop")
        XCTAssertFalse(coordinator.isLive(laptop))
        XCTAssertTrue(coordinator.isLive(studio))
        XCTAssertFalse(coordinator.isCurrent(studio))
    }

    func testOwnerContextForAnUnpairedInstanceThrows() {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)

        XCTAssertThrowsError(try coordinator.ownerContext(for: "nowhere")) { error in
            guard case AidenRemoteClientError.installationChanged = error else {
                return XCTFail("Expected installationChanged, got \(error)")
            }
        }
    }

    func testRequestContextStaysOnTheSelectedMachine() throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)

        XCTAssertEqual(try coordinator.requestContext(for: "studio").instanceId, "studio")
        XCTAssertThrowsError(try coordinator.requestContext(for: "laptop")) { error in
            guard case AidenRemoteClientError.installationChanged = error else {
                return XCTFail("Expected installationChanged, got \(error)")
            }
        }
    }

    func testANonSelectedMachineGivesAClientWithoutConnecting() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let context = try coordinator.ownerContext(for: "laptop")

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
        let context = try coordinator.ownerContext(for: "laptop")
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

    func testASelectionContextLosesItsClientWhenTheSelectionMoves() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let context = try coordinator.requestContext()
        XCTAssertNoThrow(try coordinator.remoteClient(for: context))

        await coordinator.switchInstallation(to: "laptop")

        XCTAssertTrue(coordinator.isLive(context))
        XCTAssertThrowsError(try coordinator.remoteClient(for: context)) { error in
            guard case AidenRemoteClientError.installationChanged = error else {
                return XCTFail("Expected installationChanged, got \(error)")
            }
        }
    }

    func testComingBackToAMachineNeverRestoresASelectionContext() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let first = try coordinator.requestContext()

        await coordinator.switchInstallation(to: "laptop")
        await coordinator.switchInstallation(to: "studio")

        XCTAssertFalse(coordinator.isCurrent(first))
        XCTAssertThrowsError(try coordinator.remoteClient(for: first))
        XCTAssertNotEqual(try coordinator.requestContext(), first)
    }

    func testAnOwnerContextStaysLiveThroughAwayAndBack() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let context = try coordinator.ownerContext(for: "studio")

        await coordinator.switchInstallation(to: "laptop")
        XCTAssertTrue(coordinator.isLive(context))
        XCTAssertNoThrow(try coordinator.remoteClient(for: context))
        await coordinator.switchInstallation(to: "studio")

        XCTAssertFalse(coordinator.isCurrent(context))
        XCTAssertTrue(coordinator.isLive(context))
        let server = try await coordinator.remoteClient(for: context).server()
        XCTAssertEqual(server.instanceId, "studio")
    }

    func testAnOwnerContextStaysLiveWhenItsMachineBecomesSelected() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let context = try coordinator.ownerContext(for: "laptop")

        await coordinator.switchInstallation(to: "laptop")

        XCTAssertTrue(coordinator.isLive(context))
        XCTAssertNoThrow(try coordinator.remoteClient(for: context))
    }

    func testAReconnectLeavesAnOwnerContextLive() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let context = try coordinator.ownerContext(for: "studio")

        await coordinator.connectActiveInstallation()

        XCTAssertTrue(coordinator.isLive(context))
        XCTAssertTrue(coordinator.isCurrent(context))
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

    func testANonSelectedMachinesOwnConnectLandsOnItsOwnConnection() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let laptop = try connection("laptop", in: coordinator)
        let saved = coordinator.installationStore.installations.first { $0.id == "laptop" }
        let revision = coordinator.workspaceSnapshotRevision

        await laptop.connect()

        XCTAssertEqual(laptop.server?.instanceId, "laptop")
        XCTAssertFalse(laptop.workspaces.isEmpty)
        XCTAssertEqual(laptop.connectionState, .connected)
        XCTAssertNotEqual(coordinator.installationStore.installations.first { $0.id == "laptop" }, saved)
        XCTAssertEqual(coordinator.workspaceSnapshotRevision, revision)
        XCTAssertEqual(coordinator.server?.instanceId, "studio")
    }

    func testAnAnswerFromBeforeLeavingAndComingBackIsDropped() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let studio = try connection("studio", in: coordinator)
        let installation = studio.installation
        let release = responder.hold(instanceId: "studio", path: "/server")
        let starting = Task { await coordinator.start() }
        try await waitForRequest("GET /server", instanceId: "studio")

        await coordinator.switchInstallation(to: "laptop")
        // The way back gets its own answer. The first attempt's is still held.
        responder.hold(instanceId: "studio", path: "/server")()
        await coordinator.switchInstallation(to: "studio")
        XCTAssertEqual(coordinator.connectionState, .connected)
        let saved = coordinator.installationStore.installations.first { $0.id == "studio" }
        let revision = coordinator.workspaceSnapshotRevision

        var renamed = installation
        renamed.name = "From the old attempt"
        _ = AidenDemoHosts.coordinator(installations: [renamed], responder: responder)
        release()
        await starting.value
        try await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(studio.server?.name, installation.name)
        XCTAssertEqual(coordinator.installationStore.installations.first { $0.id == "studio" }, saved)
        XCTAssertEqual(coordinator.workspaceSnapshotRevision, revision)
        XCTAssertEqual(coordinator.connectionState, .connected)
    }
}
#endif
