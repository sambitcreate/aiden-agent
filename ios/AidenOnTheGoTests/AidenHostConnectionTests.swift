#if DEBUG
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenHostConnectionTests: XCTestCase {
    private let revokedJSON = Data("""
    {"error":{"code":"credential_revoked","message":"Pair this device again.",
    "requestId":"request-revoked","retryable":false}}
    """.utf8)

    /// A connection on its own, with no coordinator behind it.
    private func standalone(_ instanceId: String, responder: AidenDemoResponder) -> AidenHostConnection {
        AidenHostConnection(
            installation: AidenDemoHosts.installation(instanceId: instanceId, name: instanceId),
            credential: { "demo-test-credential" },
            clientFactory: { installation, credential in
                AidenRemoteClient(endpoint: installation.endpoint, credential: credential, session: responder.session)
            }
        )
    }

    private func waitForRequest(
        _ request: String,
        instanceId: String,
        responder: AidenDemoResponder
    ) async throws {
        let deadline = Date().addingTimeInterval(30)
        while !responder.requests(instanceId: instanceId).contains(request), Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(responder.requests(instanceId: instanceId).contains(request), "\(request) never arrived")
    }

    func testConnectFillsServerAndWorkspacesForItsOwnInstallation() async throws {
        let responder = AidenDemoResponder()
        _ = AidenDemoHosts.coordinator(.four, responder: responder)
        let connection = standalone("laptop", responder: responder)

        await connection.connect()

        XCTAssertEqual(connection.connectionState, .connected)
        XCTAssertNil(connection.connectionIssue)
        XCTAssertEqual(connection.server?.instanceId, "laptop")
        XCTAssertFalse(connection.workspaces.isEmpty)
        XCTAssertTrue(responder.requests(instanceId: "laptop").contains("GET /server"))
        XCTAssertTrue(responder.requests(instanceId: "studio").isEmpty, "Another machine must not be asked")
    }

    func testAnUnreachableMachineGoesOfflineWithAnIssue() async throws {
        let responder = AidenDemoResponder()
        _ = AidenDemoHosts.coordinator(.four, responder: responder)
        let connection = standalone("build", responder: responder)

        await connection.connect()

        guard case .offline = connection.connectionState else {
            return XCTFail("Expected offline, got \(connection.connectionState)")
        }
        XCTAssertNotNil(connection.connectionIssue)
        XCTAssertNil(connection.server)
    }

    func testDisconnectMovesGenerationSoOldContextsGoStale() async throws {
        let responder = AidenDemoResponder()
        _ = AidenDemoHosts.coordinator(.one, responder: responder)
        let connection = standalone("studio", responder: responder)
        await connection.connect()
        let old = try connection.requestContext()
        let oldClient = try connection.client()

        connection.disconnect()

        let fresh = try connection.requestContext()
        XCTAssertEqual(old.generation + 1, connection.generation)
        XCTAssertEqual(fresh.generation, connection.generation)
        XCTAssertNotEqual(fresh, old)
        XCTAssertNil(connection.server)
        XCTAssertTrue(connection.workspaces.isEmpty)
        XCTAssertFalse(try connection.client() === oldClient, "A new lease needs a new client")
    }

    func testReconnectingKeepsTheGeneration() async throws {
        let responder = AidenDemoResponder()
        _ = AidenDemoHosts.coordinator(.one, responder: responder)
        let connection = standalone("studio", responder: responder)
        await connection.connect()
        let context = try connection.requestContext()

        await connection.connect()

        XCTAssertEqual(try connection.requestContext(), context)
    }

    func testAnAnswerThatArrivesAfterDisconnectIsDropped() async throws {
        let responder = AidenDemoResponder()
        _ = AidenDemoHosts.coordinator(.one, responder: responder)
        let connection = standalone("studio", responder: responder)
        let release = responder.hold(instanceId: "studio", path: "/server")
        let connecting = Task { await connection.connect() }
        try await waitForRequest("GET /server", instanceId: "studio", responder: responder)

        connection.disconnect()
        release()
        await connecting.value

        XCTAssertNil(connection.server)
        XCTAssertTrue(connection.workspaces.isEmpty)
        XCTAssertNotEqual(connection.connectionState, .connected)
    }

    func testARevokedMachineIssuesNoContextOrClientAndStopsConnecting() async throws {
        let responder = AidenDemoResponder()
        _ = AidenDemoHosts.coordinator(.one, responder: responder)
        responder.reply(instanceId: "studio", path: "/server", status: 401, json: revokedJSON)
        let connection = standalone("studio", responder: responder)

        await connection.connect()

        XCTAssertTrue(connection.isRevoked)
        XCTAssertEqual(connection.connectionState, .needsPairing)
        XCTAssertThrowsError(try connection.requestContext())
        XCTAssertThrowsError(try connection.client())
        let requestsBefore = responder.requests(instanceId: "studio").count
        await connection.connect()
        XCTAssertEqual(responder.requests(instanceId: "studio").count, requestsBefore)
    }

    func testCoordinatorForwardsTheSelectedConnectionsState() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let studio = try XCTUnwrap(coordinator.selectedConnection)

        XCTAssertEqual(studio.instanceId, "studio")
        XCTAssertNotNil(coordinator.server)
        XCTAssertEqual(coordinator.server, studio.server)
        XCTAssertEqual(coordinator.connectionState, studio.connectionState)
        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertFalse(coordinator.workspaces.isEmpty)
        XCTAssertEqual(coordinator.workspaces, studio.workspaces)

        await coordinator.switchInstallation(to: "build")

        let build = try XCTUnwrap(coordinator.selectedConnection)
        XCTAssertEqual(build.instanceId, "build")
        XCTAssertEqual(coordinator.connectionState, build.connectionState)
        XCTAssertEqual(coordinator.connectionIssue, build.connectionIssue)
        XCTAssertNotNil(coordinator.connectionIssue)
    }

    func testRequestContextsComeFromTheSelectedConnection() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()
        let connection = try XCTUnwrap(coordinator.selectedConnection)

        XCTAssertEqual(try coordinator.requestContext(), try connection.requestContext())
        XCTAssertTrue(try coordinator.remoteClient() === connection.client())
    }

    func testReconnectingLeavesACoordinatorContextCurrent() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()
        let context = try coordinator.requestContext()

        await coordinator.connectActiveInstallation()

        XCTAssertTrue(coordinator.isCurrent(context))
    }

    func testSwitchingAwayAndBackNeverReissuesAnOldContext() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        let first = try coordinator.requestContext()

        await coordinator.switchInstallation(to: "laptop")
        XCTAssertFalse(coordinator.isCurrent(first))
        await coordinator.switchInstallation(to: "studio")

        XCTAssertEqual(coordinator.selectedConnection?.instanceId, "studio")
        XCTAssertFalse(coordinator.isCurrent(first))
        XCTAssertNotEqual(try coordinator.requestContext(), first)

        // The first context sits at the starting generation, so only a second
        // round shows the count carrying across replaced connections.
        let second = try coordinator.requestContext()
        let attempt = try XCTUnwrap(coordinator.selectedConnection).connectionGeneration

        await coordinator.switchInstallation(to: "laptop")
        await coordinator.switchInstallation(to: "studio")

        XCTAssertFalse(coordinator.isCurrent(second))
        let third = try coordinator.requestContext()
        XCTAssertGreaterThan(third.generation, second.generation)
        XCTAssertGreaterThan(try XCTUnwrap(coordinator.selectedConnection).connectionGeneration, attempt)
    }

    func testALateAnswerFromTheOldSelectionNeverReachesTheNewOne() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let release = responder.hold(instanceId: "studio", path: "/server")
        let connecting = Task { await coordinator.start() }
        try await waitForRequest("GET /server", instanceId: "studio", responder: responder)

        await coordinator.switchInstallation(to: "laptop")
        let savedStudio = coordinator.installationStore.installations.first { $0.id == "studio" }
        let revision = coordinator.workspaceSnapshotRevision
        release()
        await connecting.value

        XCTAssertEqual(coordinator.server?.instanceId, "laptop")
        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertNotNil(savedStudio)
        XCTAssertEqual(coordinator.installationStore.installations.first { $0.id == "studio" }, savedStudio)
        XCTAssertEqual(coordinator.workspaceSnapshotRevision, revision)
    }

    func testForgettingTheLastMachineDropsTheConnectionAndAsksForPairing() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.one, responder: responder)
        await coordinator.start()

        await coordinator.removeInstallation("studio")

        XCTAssertNil(coordinator.selectedConnection)
        XCTAssertEqual(coordinator.connectionState, .needsPairing)
        XCTAssertNil(coordinator.server)
        XCTAssertTrue(coordinator.workspaces.isEmpty)
        XCTAssertThrowsError(try coordinator.requestContext())
    }
}
#endif
