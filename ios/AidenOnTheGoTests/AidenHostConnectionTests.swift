import XCTest
@testable import AidenOnTheGo

#if DEBUG

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

    func testAMachineIsKnownOnlineOnlyOnceItHasAnswered() async throws {
        let responder = AidenDemoResponder()
        _ = AidenDemoHosts.coordinator(.four, responder: responder)
        let connection = standalone("laptop", responder: responder)
        XCTAssertFalse(connection.isKnownOnline)

        await connection.connect()

        XCTAssertTrue(connection.isKnownOnline)
    }

    func testAReconnectingMachineStaysKnownOnlineUntilTheAttemptFails() async throws {
        let responder = AidenDemoResponder()
        _ = AidenDemoHosts.coordinator(.four, responder: responder)
        let connection = standalone("laptop", responder: responder)
        await connection.connect()
        let release = responder.hold(instanceId: "laptop", path: "/server")
        defer { release() }

        let attempt = Task { await connection.connect() }
        let deadline = Date().addingTimeInterval(30)
        while connection.connectionState != .connecting, Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(connection.connectionState, .connecting)
        XCTAssertTrue(connection.isKnownOnline)

        responder.fail(instanceId: "laptop", path: "/server", code: .notConnectedToInternet)
        release()
        await attempt.value

        XCTAssertFalse(connection.isKnownOnline)
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

    func testExpireAfterRevokeLeavesConnectionAtNeedsPairing() async throws {
        let responder = AidenDemoResponder()
        _ = AidenDemoHosts.coordinator(.one, responder: responder)
        let connection = standalone("studio", responder: responder)
        let releaseServer = responder.hold(instanceId: "studio", path: "/server")
        var deadlinePassed = false
        connection.waitForDeadline = { _ in
            while !deadlinePassed, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
        }

        let attempt = Task { await connection.connect(over: .probe, timeout: 10) }
        try await waitForRequest("GET /server", instanceId: "studio", responder: responder)
        XCTAssertTrue(connection.isConnectInFlight)

        connection.markRevokedWithPurgePending()
        XCTAssertTrue(connection.isRevoked)
        XCTAssertTrue(connection.isPurgePending)
        XCTAssertFalse(connection.isConnectInFlight)
        XCTAssertEqual(connection.connectionState, .needsPairing)

        deadlinePassed = true
        releaseServer()
        await attempt.value

        XCTAssertTrue(connection.isRevoked)
        XCTAssertTrue(connection.isPurgePending)
        XCTAssertEqual(connection.connectionState, .needsPairing)
        XCTAssertNil(connection.connectionIssue)
        XCTAssertNil(connection.server)
    }
}
#endif

final class AidenHostConnectionLifecycleTests: XCTestCase {
    private let sampleIssue = AidenConnectionIssue(
        title: "Computer unavailable",
        message: "Offline.",
        canRetry: true
    )

    func testRevokeDuringConnectInvalidatesInFlightAttemptAndBlocksReconnect() {
        var lifecycle = AidenHostConnectionLifecycle(
            generation: 2,
            hostGeneration: 3,
            connectionGeneration: 4,
            connectionState: .connected
        )

        let started = lifecycle.beginConnect(over: .interactive)
        XCTAssertEqual(started, .init(attempt: 5, notifyWillConnect: true))
        XCTAssertTrue(lifecycle.isConnectInFlight)
        XCTAssertTrue(lifecycle.isKnownOnline)
        XCTAssertTrue(lifecycle.isCurrent(attempt: 5))

        lifecycle.markRevoked()

        XCTAssertEqual(lifecycle.custody, .revoked(purgePending: false))
        XCTAssertTrue(lifecycle.isRevoked)
        XCTAssertFalse(lifecycle.isPurgePending)
        XCTAssertFalse(lifecycle.isConnectInFlight)
        XCTAssertFalse(lifecycle.isCurrent(attempt: 5))
        XCTAssertEqual(lifecycle.hostGeneration, 4)
        XCTAssertEqual(lifecycle.connectionGeneration, 6)
        XCTAssertFalse(lifecycle.markConnected(attempt: 5))
        XCTAssertNil(lifecycle.beginConnect(over: .interactive))
        XCTAssertNil(lifecycle.beginConnect(over: .probe))
    }

    func testExpireAfterRevokeIsNoOpAndPreservesNeedsPairing() {
        var lifecycle = AidenHostConnectionLifecycle()
        let started = lifecycle.beginConnect(over: .probe)
        XCTAssertEqual(started, .init(attempt: 1, notifyWillConnect: false))

        let notifyNeedsPairing = lifecycle.markRevokedWithPurgePending()
        XCTAssertTrue(notifyNeedsPairing)
        XCTAssertEqual(lifecycle.connectionState, .needsPairing)
        let generationAfterRevoke = lifecycle.connectionGeneration

        XCTAssertFalse(lifecycle.expireConnect(attempt: 1))
        XCTAssertFalse(lifecycle.recordNonRevocationFailure(isServerError: false, issue: sampleIssue))
        XCTAssertEqual(lifecycle.connectionState, .needsPairing)
        XCTAssertNil(lifecycle.connectionIssue)
        XCTAssertEqual(lifecycle.connectionGeneration, generationAfterRevoke)
        XCTAssertFalse(lifecycle.acceptsPollError(sinceConnect: generationAfterRevoke, isRevocation: false))
        XCTAssertFalse(lifecycle.acceptsPollError(sinceConnect: generationAfterRevoke, isRevocation: true))
    }

    func testBackgroundRevokeWithPurgePendingTransitionsCleanlyThroughPurgeStarted() {
        var lifecycle = AidenHostConnectionLifecycle(connectionState: .connected)

        // Active host ignores purgeStarted without changing custody.
        lifecycle.purgeStarted()
        XCTAssertEqual(lifecycle.custody, .active)

        XCTAssertTrue(lifecycle.markRevokedWithPurgePending())
        XCTAssertEqual(lifecycle.custody, .revoked(purgePending: true))
        XCTAssertTrue(lifecycle.isRevoked)
        XCTAssertTrue(lifecycle.isPurgePending)
        XCTAssertEqual(lifecycle.connectionState, .needsPairing)
        XCTAssertNil(lifecycle.connectionIssue)
        XCTAssertFalse(lifecycle.isKnownOnline)
        XCTAssertFalse(lifecycle.isKnownOffline)

        // Subsequent markRevoked preserves pending purge until purgeStarted runs.
        let hostGenBefore = lifecycle.hostGeneration
        lifecycle.markRevoked()
        XCTAssertEqual(lifecycle.custody, .revoked(purgePending: true))
        XCTAssertGreaterThan(lifecycle.hostGeneration, hostGenBefore)

        // Revoked host refuses non-pairing state adoptions.
        XCTAssertFalse(lifecycle.adopt(connectionState: .connected))
        XCTAssertEqual(lifecycle.connectionState, .needsPairing)
        XCTAssertTrue(lifecycle.adopt(connectionState: .needsPairing))

        // Starting purge clears purgePending while keeping terminal revocation.
        lifecycle.purgeStarted()
        XCTAssertEqual(lifecycle.custody, .revoked(purgePending: false))
        XCTAssertTrue(lifecycle.isRevoked)
        XCTAssertFalse(lifecycle.isPurgePending)

        // Disconnecting a revoked host keeps it at .needsPairing.
        lifecycle.disconnect()
        XCTAssertTrue(lifecycle.isRevoked)
        XCTAssertEqual(lifecycle.connectionState, .needsPairing)
    }

    func testGenerationMonotonicityAcrossConnectCancelExpireDisconnectAndRevoke() {
        var lifecycle = AidenHostConnectionLifecycle(
            generation: 10,
            hostGeneration: 20,
            connectionGeneration: 30
        )

        var lastGen = lifecycle.generation
        var lastHost = lifecycle.hostGeneration
        var lastConn = lifecycle.connectionGeneration

        func assertMonotonic(file: StaticString = #filePath, line: UInt = #line) {
            XCTAssertGreaterThanOrEqual(lifecycle.generation, lastGen, file: file, line: line)
            XCTAssertGreaterThanOrEqual(lifecycle.hostGeneration, lastHost, file: file, line: line)
            XCTAssertGreaterThanOrEqual(lifecycle.connectionGeneration, lastConn, file: file, line: line)
            lastGen = lifecycle.generation
            lastHost = lifecycle.hostGeneration
            lastConn = lifecycle.connectionGeneration
        }

        let first = lifecycle.beginConnect(over: .probe)
        XCTAssertEqual(first?.attempt, 31)
        assertMonotonic()

        // Route-filtered cancel for interactive does not cancel an in-flight probe.
        XCTAssertNil(lifecycle.cancelConnect(over: .interactive))
        XCTAssertTrue(lifecycle.isConnectInFlight)
        assertMonotonic()

        let cancelled = lifecycle.cancelConnect(over: .probe)
        XCTAssertEqual(cancelled, .init(cancelledAttempt: 31, route: .probe))
        XCTAssertGreaterThan(lifecycle.connectionGeneration, lastConn)
        assertMonotonic()

        let second = lifecycle.beginConnect(over: .interactive)
        XCTAssertEqual(second?.attempt, 33)
        assertMonotonic()

        XCTAssertTrue(lifecycle.expireConnect(attempt: 33))
        XCTAssertGreaterThan(lifecycle.connectionGeneration, lastConn)
        assertMonotonic()

        XCTAssertTrue(lifecycle.recordNonRevocationFailure(isServerError: false, issue: sampleIssue))
        XCTAssertTrue(lifecycle.isKnownOffline)
        assertMonotonic()

        // Reconnect from offline stays isKnownOffline and restores offline on cancel.
        let third = lifecycle.beginConnect(over: .probe)
        XCTAssertEqual(third?.attempt, 35)
        XCTAssertTrue(lifecycle.isKnownOffline)
        XCTAssertNotNil(lifecycle.cancelConnect(over: .probe))
        XCTAssertEqual(lifecycle.connectionState, .offline(message: sampleIssue.message))
        XCTAssertEqual(lifecycle.connectionIssue, sampleIssue)
        assertMonotonic()

        // Connecting and settling keeps .connected if cancelled during negotiation.
        let fourth = lifecycle.beginConnect(over: .interactive)
        XCTAssertEqual(fourth?.attempt, 37)
        XCTAssertTrue(lifecycle.markConnected(attempt: 37))
        XCTAssertNotNil(lifecycle.cancelConnect(over: .interactive))
        XCTAssertEqual(lifecycle.connectionState, .connected)
        assertMonotonic()

        lifecycle.disconnect()
        XCTAssertGreaterThan(lifecycle.generation, lastGen)
        XCTAssertGreaterThan(lifecycle.hostGeneration, lastHost)
        XCTAssertGreaterThan(lifecycle.connectionGeneration, lastConn)
        XCTAssertEqual(lifecycle.connectionState, .connecting)
        assertMonotonic()

        lifecycle.revokeStandalone()
        XCTAssertGreaterThan(lifecycle.generation, lastGen)
        XCTAssertGreaterThan(lifecycle.hostGeneration, lastHost)
        XCTAssertGreaterThan(lifecycle.connectionGeneration, lastConn)
        XCTAssertTrue(lifecycle.isRevoked)
        XCTAssertEqual(lifecycle.connectionState, .needsPairing)
        assertMonotonic()
    }
}
