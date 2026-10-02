import ActivityKit
import AVFoundation
import Foundation
import XCTest
@testable import AidenOnTheGo

final class AidenNativeIntegrationTests: XCTestCase {
    func testDiagnosticVocabularyIsClosedAndContentFree() {
        XCTAssertEqual(
            Set(AidenDiagnosticArea.allCases.map(\.rawValue)),
            Set(["connection", "authentication", "contract", "cache", "stream", "speech", "notification", "liveActivity", "priorTermination", "app"])
        )
        XCTAssertTrue(AidenDiagnosticEvent.allCases.contains(.contractRejected))
        XCTAssertTrue(AidenDiagnosticCode.allCases.contains(.metricDiagnostic))
        let vocabulary = [
            AidenDiagnosticArea.allCases.map(\.rawValue),
            AidenDiagnosticEvent.allCases.map(\.rawValue),
            AidenDiagnosticOutcome.allCases.map(\.rawValue),
            AidenDiagnosticCode.allCases.map(\.rawValue),
        ].flatMap { $0 }.joined(separator: " ").lowercased()
        for forbidden in ["prompt", "credential", "endpoint", "path", "token", "message"] {
            XCTAssertFalse(vocabulary.contains(forbidden))
        }
    }

    func testBinaryContractRejectionsEmitExactlyOneDiagnosticEach() async throws {
        var records: [(AidenDiagnosticArea, AidenDiagnosticEvent, AidenDiagnosticOutcome, AidenDiagnosticCode)] = []
        AidenDiagnostics.testSink = { records.append(($0, $1, $2, $3)) }
        defer {
            AidenDiagnostics.testSink = nil
            AidenNativeActivityURLProtocol.handler = nil
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AidenNativeActivityURLProtocol.self]
        let client = AidenRemoteClient(
            endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
            credential: "proof-credential",
            session: URLSession(configuration: configuration)
        )

        AidenNativeActivityURLProtocol.handler = { request in
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "image/gif"]
            ))
            return (response, Data("GIF89a".utf8))
        }
        do {
            _ = try await client.attachmentContent(chatId: "chat-1", attachmentId: "attachment-1")
            XCTFail("Expected the attachment MIME contract to be rejected.")
        } catch AidenRemoteClientError.invalidResponse {}

        AidenNativeActivityURLProtocol.handler = { request in
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: [
                    "Content-Type": "image/png",
                    "Cache-Control": "public",
                    "X-Content-Type-Options": "nosniff",
                ]
            ))
            return (response, Data([137, 80, 78, 71, 13, 10, 26, 10]))
        }
        do {
            _ = try await client.botAvatar(
                botId: "bot-1",
                assetRevision: "avatar_revision_0123456789abcdef0123456789abcdef"
            )
            XCTFail("Expected the avatar cache/security contract to be rejected.")
        } catch AidenRemoteClientError.invalidResponse {}

        XCTAssertEqual(records.count, 2)
        XCTAssertTrue(records.allSatisfy {
            $0.0 == .contract && $0.1 == .contractRejected && $0.2 == .failed && $0.3 == .invalidResponse
        })
    }

    @MainActor
    func testLiveActivityLookupScopesIdenticalStreamIDsToInstallation() {
        let attributes = AgentRunActivityAttributes(
            instanceID: "instance-a",
            sessionID: "chat-1",
            sessionTitle: "Chat",
            streamID: "stream-shared",
            startedAt: Date()
        )
        XCTAssertTrue(AidenRemoteLiveActivityManager.matches(
            attributes,
            instanceID: "instance-a",
            streamID: "stream-shared"
        ))
        XCTAssertFalse(AidenRemoteLiveActivityManager.matches(
            attributes,
            instanceID: "instance-b",
            streamID: "stream-shared"
        ))
    }

    func testIntentCatalogContainsOnlyBoundedDisplayNamesAndStableIDs() throws {
        let suiteName = "AidenNativeIntegrationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = AidenIntentCatalogStore(defaults: defaults)

        try store.update(
            installations: [.init(id: "instance-1", name: "Studio Mac")],
            activeInstallationId: "instance-1",
            workspaces: [.init(id: "workspace-1", instanceId: "instance-1", name: "Aiden")],
            for: "instance-1"
        )

        XCTAssertEqual(store.load(), AidenIntentCatalogSnapshot(
            installations: [.init(id: "instance-1", name: "Studio Mac")],
            workspaces: [.init(id: "workspace-1", instanceId: "instance-1", name: "Aiden")],
            activeInstallationId: "instance-1"
        ))
        let data = try XCTUnwrap(defaults.data(forKey: "aiden.intent-catalog.v1"))
        let serialized = try XCTUnwrap(String(data: data, encoding: .utf8)).lowercased()
        for forbidden in ["https://", "credential", "token", "pin", "/users/"] {
            XCTAssertFalse(serialized.contains(forbidden))
        }
    }

    func testIntentCatalogDropsUnsafeAndOrphanedRecords() throws {
        let suiteName = "AidenNativeIntegrationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = AidenIntentCatalogStore(defaults: defaults)
        try store.update(
            installations: [
                .init(id: "instance-1", name: "Studio"),
                .init(id: "instance-2", name: "Laptop"),
            ],
            activeInstallationId: "instance-1",
            workspaces: [
                .init(id: "../../secret", instanceId: "instance-1", name: "Unsafe"),
                .init(id: "workspace-2", instanceId: "missing", name: "Orphan"),
                .init(id: "shared-id", instanceId: "instance-1", name: "First"),
                .init(id: "shared-id", instanceId: "instance-2", name: "Second"),
            ],
            for: "instance-1"
        )
        XCTAssertEqual(store.load().workspaces.map(\.name).sorted(), ["First", "Second"])
        XCTAssertNotEqual(
            AidenWorkspaceIntentEntity(workspaceId: "shared-id", instanceId: "instance-1", name: "First").id,
            AidenWorkspaceIntentEntity(workspaceId: "shared-id", instanceId: "instance-2", name: "Second").id
        )
        let serialized = try XCTUnwrap(String(
            data: try XCTUnwrap(defaults.data(forKey: "aiden.intent-catalog.v1")),
            encoding: .utf8
        ))
        XCTAssertFalse(serialized.contains("../../secret"))
        XCTAssertFalse(serialized.contains("Orphan"))
    }

    func testDeepLinksCarryOnlyStableIdentifiersAndRejectAmbiguousInput() throws {
        let newChat = try XCTUnwrap(AidenDeepLink.newChatURL(
            instanceId: "instance-1",
            workspaceId: "workspace-1",
            startsVoice: true
        ))
        XCTAssertEqual(
            AidenDeepLink.request(from: newChat),
            AidenNavigationRequest(
                destination: .newChat,
                instanceId: "instance-1",
                workspaceId: "workspace-1",
                startsVoice: true
            )
        )
        XCTAssertFalse(newChat.absoluteString.lowercased().contains("prompt"))
        XCTAssertFalse(newChat.absoluteString.lowercased().contains("token"))
        XCTAssertFalse(newChat.absoluteString.contains("/Users/"))

        let chat = try XCTUnwrap(AidenDeepLink.chatURL(instanceId: "instance-1", chatId: "chat-1"))
        XCTAssertEqual(AidenDeepLink.request(from: chat)?.destination, .chat("chat-1"))
        XCTAssertNil(AidenDeepLink.request(from: URL(string: "aiden-otg://chat?instance=a&instance=b&chat=c")!))
        XCTAssertNil(AidenDeepLink.request(from: URL(string: "aiden-otg://chat?instance=a&chat=../../secret")!))
        XCTAssertNil(AidenDeepLink.request(from: URL(string: "aiden-otg://chat/path?instance=a&chat=c")!))
        XCTAssertNil(AidenDeepLink.request(from: URL(string: "aiden-otg://chat?instance=a&chat=c&prompt=hello")!))
    }

    func testBotChatDeepLinkRoundTripsAndRejectsAmbiguousOrUnsafeShapes() throws {
        let link = try XCTUnwrap(AidenDeepLink.botChatURL(instanceId: "instance-1", botId: "bot_fixture_01"))
        XCTAssertEqual(link.absoluteString, "aiden-otg://bot/bot_fixture_01/chat?instance=instance-1")
        XCTAssertEqual(
            AidenDeepLink.request(from: link),
            AidenNavigationRequest(
                destination: .botChat("bot_fixture_01"),
                instanceId: "instance-1",
                workspaceId: nil,
                startsVoice: false
            )
        )

        let bare = try XCTUnwrap(URL(string: "aiden-otg://bot/bot:ops.1/chat"))
        XCTAssertEqual(AidenDeepLink.request(from: bare)?.destination, .botChat("bot:ops.1"))
        XCTAssertNil(AidenDeepLink.request(from: bare)?.instanceId)
        XCTAssertEqual(AidenDeepLink.request(from: URL(string: "AIDEN-OTG://BOT/b1/chat")!)?.destination, .botChat("b1"))

        for rejected in [
            "aiden-otg://bot/b1",
            "aiden-otg://bot/b1/chat/extra",
            "aiden-otg://bot//chat",
            "aiden-otg://bot/b1/settings",
            "aiden-otg://bot/..%2Fsecret/chat",
            "aiden-otg://bot/b%31/chat",
            "aiden-otg://bot/b1/chat?chat=c1",
            "aiden-otg://bot/b1/chat?workspace=w1",
            "aiden-otg://bot/b1/chat?instance=a&instance=b",
            "aiden-otg://bot/b1/chat?instance=../x",
            "aiden-otg://bot/b1/chat?prompt=hello",
            "aiden-otg://bot/b1/chat#frag",
            "aiden-otg://user@bot/b1/chat",
            "https://bot/b1/chat",
        ] {
            XCTAssertNil(AidenDeepLink.request(from: try XCTUnwrap(URL(string: rejected))), rejected)
        }
        XCTAssertNil(AidenDeepLink.botChatURL(instanceId: nil, botId: "../secret"))
        XCTAssertNil(AidenDeepLink.botChatURL(instanceId: "bad id", botId: "b1"))
        XCTAssertNil(AidenDeepLink.botChatURL(instanceId: nil, botId: String(repeating: "b", count: 161)))
    }

    func testLiveActivityFreshnessCountsToolCallsAcrossTransitionsAndKeepsLastUpdateWhenStale() {
        let start = Date(timeIntervalSince1970: 1_000)
        var state = AgentRunActivityStateReducer.initialState(
            sessionID: "chat-1",
            sessionTitle: "Chat",
            startedAt: start
        )
        XCTAssertEqual(state.toolCallCount, 0)
        XCTAssertNil(AgentRunFreshness.toolCallLabel(count: state.toolCallCount))

        state = AgentRunActivityStateReducer.toolStarted(name: "read_file", state: state, now: start + 1)
        state = AgentRunActivityStateReducer.toolCompleted(state: state, now: start + 2)
        state = AgentRunActivityStateReducer.appendingToken("partial", to: state, now: start + 3)
        state = AgentRunActivityStateReducer.reasoning("", state: state, now: start + 4)
        state = AgentRunActivityStateReducer.toolStarted(name: "bash", state: state, now: start + 5)
        state = AgentRunActivityStateReducer.waitingForApproval(state: state, now: start + 6)
        state = AgentRunActivityStateReducer.settingInterimAssistant("interim", on: state, now: start + 7)
        state = AgentRunActivityStateReducer.clearingResponseExcerpt(state: state)
        state = AgentRunActivityStateReducer.updatingSessionTitle("Renamed", state: state)
        XCTAssertEqual(state.toolCallCount, 2)
        XCTAssertEqual(AgentRunFreshness.toolCallLabel(count: state.toolCallCount), "2 tools")
        XCTAssertEqual(state.updatedAt, start + 7)

        // Status events and reconciliation update labels without extending the
        // progress-based freshness window or resetting it to the run start.
        let reconciledRunning = AgentRunActivityStateReducer.refreshedStatus(
            .responding,
            activity: "Writing response",
            state: state
        )
        XCTAssertEqual(reconciledRunning.updatedAt, start + 7)
        XCTAssertEqual(
            AgentRunFreshness.staleDate(for: reconciledRunning),
            start.addingTimeInterval(307)
        )
        let reconciledQueued = AgentRunActivityStateReducer.refreshedStatus(
            .starting,
            activity: "Starting response",
            state: state
        )
        XCTAssertEqual(reconciledQueued.updatedAt, start + 7)
        XCTAssertEqual(reconciledQueued.toolCallCount, 2)
        let reconciledApproval = AgentRunActivityStateReducer.refreshedStatus(
            .waitingForApproval,
            activity: "Waiting for approval",
            state: state
        )
        XCTAssertEqual(reconciledApproval.updatedAt, start + 7)
        XCTAssertEqual(reconciledApproval.status, .waitingForApproval)

        // Going stale is not agent progress: the "updated … ago" chip keeps aging.
        let stale = AgentRunActivityStateReducer.stale(state: state)
        XCTAssertTrue(stale.isStale)
        XCTAssertEqual(stale.updatedAt, start + 7)
        XCTAssertEqual(stale.toolCallCount, 2)
        XCTAssertTrue(AgentRunFreshness.isStale(stale, systemMarkedStale: false))

        // The system's staleDate alone also marks a running activity stale,
        // but a finished run is never presented as stale.
        XCTAssertFalse(AgentRunFreshness.isStale(state, systemMarkedStale: false))
        XCTAssertTrue(AgentRunFreshness.isStale(state, systemMarkedStale: true))
        let done = AgentRunActivityStateReducer.final(
            status: .complete,
            activity: "Response complete",
            state: stale,
            now: start + 700
        )
        XCTAssertEqual(done.toolCallCount, 2)
        XCTAssertFalse(AgentRunFreshness.isStale(done, systemMarkedStale: true))
        XCTAssertNil(AgentRunFreshness.staleDate(for: done))

        // A queued/reconciling restart keeps the count the run already earned.
        let restarted = AgentRunActivityStateReducer.initialState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            startedAt: state.startedAt,
            toolCallCount: state.toolCallCount
        )
        XCTAssertEqual(restarted.toolCallCount, 2)
    }

    func testLiveActivityToolCallChipIsBoundedAndSingular() {
        XCTAssertEqual(AgentRunFreshness.toolCallLabel(count: 1), "1 tool")
        XCTAssertEqual(AgentRunFreshness.toolCallLabel(count: 99), "99 tools")
        XCTAssertEqual(AgentRunFreshness.toolCallLabel(count: 100), "99+ tools")
        XCTAssertNil(AgentRunFreshness.toolCallLabel(count: -3))
        let negative = AgentRunActivityAttributes.ContentState(
            sessionID: "chat-1",
            sessionTitle: "Chat",
            status: .usingTool,
            currentActivity: "Using tool",
            startedAt: Date(),
            updatedAt: Date(),
            toolCallCount: -5
        )
        XCTAssertEqual(negative.toolCallCount, 0)
    }

    func testLiveActivityStateEncodedBeforeFreshnessChipsStillDecodes() throws {
        // Activities persisted by an older build have no `toolCallCount`.
        let legacy = Data("""
        {"sessionID":"chat-1","sessionTitle":"Chat","status":"usingTool",
         "currentActivity":"Using tool","responseExcerpt":"","startedAt":0,
         "updatedAt":12,"isStale":false,"isFinal":false}
        """.utf8)
        let decoded = try JSONDecoder().decode(AgentRunActivityAttributes.ContentState.self, from: legacy)
        XCTAssertEqual(decoded.toolCallCount, 0)
        XCTAssertEqual(decoded.status, .usingTool)
        XCTAssertEqual(decoded.updatedAt, Date(timeIntervalSinceReferenceDate: 12))

        let counted = AgentRunActivityStateReducer.toolStarted(name: "bash", state: decoded)
        let roundTripped = try JSONDecoder().decode(
            AgentRunActivityAttributes.ContentState.self,
            from: JSONEncoder().encode(counted)
        )
        XCTAssertEqual(roundTripped, counted)
        XCTAssertEqual(roundTripped.toolCallCount, 1)
    }

    @MainActor
    func testLiveActivityStateIsBoundedAndResponseExcerptDefaultsOff() throws {
        let longTitle = String(repeating: "Title ", count: 30)
        let longText = String(repeating: "private response ", count: 30)
        let initial = AgentRunActivityStateReducer.initialState(
            sessionID: "chat-1",
            sessionTitle: longTitle
        )
        let updated = AgentRunActivityStateReducer.appendingToken(longText, to: initial)
        XCTAssertLessThanOrEqual(updated.sessionTitle.count, AgentRunActivitySanitizer.maximumSessionTitleCharacters)
        XCTAssertLessThanOrEqual(updated.responseExcerpt.count, AgentRunActivitySanitizer.maximumExcerptCharacters)

        let suiteName = "AidenNativeIntegrationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let manager = AidenRemoteLiveActivityManager(defaults: defaults)
        XCTAssertFalse(manager.includesResponseExcerpts)
        XCTAssertEqual(initial.responseExcerpt, "")
    }

    @MainActor
    func testPhysicalActivityKitLifecycleUsesPrivateBoundedStateAndImmediateCleanup() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this physical device.")
        }

        let proofID = "physical-proof-\(UUID().uuidString)"
        let suiteName = "AidenNativeIntegrationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let manager = AidenRemoteLiveActivityManager(defaults: defaults)

        await manager.start(
            instanceID: proofID,
            chatID: proofID,
            title: "Aiden verification",
            streamID: proofID
        )

        guard let activity = Activity<AgentRunActivityAttributes>.activities.first(where: {
            $0.attributes.instanceID == proofID && $0.attributes.streamID == proofID
        }) else {
            await manager.endAll(forInstanceID: proofID)
            XCTFail("ActivityKit did not create the requested Aiden Live Activity.")
            return
        }

        XCTAssertEqual(activity.content.state.status, .starting)
        XCTAssertEqual(activity.content.state.responseExcerpt, "")
        XCTAssertFalse(activity.content.state.isFinal)

        await manager.toolStarted(name: "read_file", instanceID: proofID, streamID: proofID)
        await manager.appendResponse("private response text", instanceID: proofID, streamID: proofID)
        await manager.markStale(instanceID: proofID, streamID: proofID)

        guard let stale = await deliveredContent(of: activity, expecting: "the stale state", where: { $0.isStale }) else {
            await manager.endAll(forInstanceID: proofID)
            return
        }
        XCTAssertTrue(stale.isStale)
        XCTAssertEqual(stale.status, .responding)
        XCTAssertEqual(stale.responseExcerpt, "")

        await manager.endAll(forInstanceID: proofID)

        XCTAssertTrue(activity.activityState == .ended || activity.activityState == .dismissed)
        XCTAssertFalse(Activity<AgentRunActivityAttributes>.activities.contains(where: { $0.id == activity.id }))
    }

    @MainActor
    func testFreshManagerReconcilesPersistedActivityThroughAuthenticatedClient() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this physical device.")
        }

        let proofID = "relaunch-proof-\(UUID().uuidString)"
        let suiteName = "AidenNativeIntegrationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer {
            defaults.removePersistentDomain(forName: suiteName)
            AidenNativeActivityURLProtocol.handler = nil
        }

        var originalManager: AidenRemoteLiveActivityManager? = AidenRemoteLiveActivityManager(defaults: defaults)
        await originalManager?.start(
            instanceID: proofID,
            chatID: proofID,
            title: "Relaunch verification",
            streamID: proofID
        )

        guard let activity = Activity<AgentRunActivityAttributes>.activities.first(where: {
            $0.attributes.instanceID == proofID && $0.attributes.streamID == proofID
        }) else {
            await originalManager?.endAll(forInstanceID: proofID)
            XCTFail("ActivityKit did not persist the Aiden activity for adoption.")
            return
        }
        originalManager = nil

        AidenNativeActivityURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/aiden/v1/streams/\(proofID)")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer proof-credential")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Aiden-Protocol-Version"), "1")
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            ))
            return (response, Data("""
            {"streamId":"\(proofID)","chatId":"\(proofID)","turnId":"turn-1",
            "state":"running","lastSequence":3,"updatedAt":"2026-08-19T19:00:00.000Z"}
            """.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AidenNativeActivityURLProtocol.self]
        let client = AidenRemoteClient(
            endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
            credential: "proof-credential",
            session: URLSession(configuration: configuration)
        )
        let adoptingManager = AidenRemoteLiveActivityManager(defaults: defaults)

        let persisted = activity.content.state
        await adoptingManager.reconcile(instanceID: proofID, client: client, isCurrent: { true })
        guard let reconciled = await deliveredContent(
            of: activity,
            expecting: "a reconciled state after the persisted one",
            where: { $0 != persisted }
        ) else {
            await adoptingManager.endAll(forInstanceID: proofID)
            return
        }
        XCTAssertEqual(reconciled.status, .responding)
        XCTAssertFalse(reconciled.isStale)
        XCTAssertEqual(reconciled.responseExcerpt, "")

        await adoptingManager.endAll(forInstanceID: proofID)
        XCTAssertTrue(activity.activityState == .ended || activity.activityState == .dismissed)
        XCTAssertFalse(Activity<AgentRunActivityAttributes>.activities.contains(where: { $0.id == activity.id }))
    }

    @MainActor
    func testOptInPhysicalActivityKitProcessBoundaryPhase() async throws {
        let environment = ProcessInfo.processInfo.environment
        let proofIDValue = environment["AIDEN_ACTIVITYKIT_PROCESS_PROOF_ID"]
        let phaseValue = environment["AIDEN_ACTIVITYKIT_PROCESS_PHASE"]

        guard proofIDValue != nil || phaseValue != nil else {
            XCTAssertNil(proofIDValue)
            XCTAssertNil(phaseValue)
            return
        }

        let proofID = try XCTUnwrap(proofIDValue)
        let phase = try XCTUnwrap(phaseValue)
        let permittedProofCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        XCTAssertFalse(proofID.isEmpty)
        XCTAssertLessThanOrEqual(proofID.utf8.count, 128)
        XCTAssertNil(proofID.unicodeScalars.first(where: { !permittedProofCharacters.contains($0) }))
        guard !proofID.isEmpty,
              proofID.utf8.count <= 128,
              proofID.unicodeScalars.allSatisfy(permittedProofCharacters.contains)
        else {
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this physical device.")
        }

        let suiteName = "AidenNativeIntegrationTests.ProcessBoundary.\(proofID)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        switch phase {
        case "start":
            let manager = AidenRemoteLiveActivityManager(defaults: defaults)
            await manager.endAll(forInstanceID: proofID)
            await manager.start(
                instanceID: proofID,
                chatID: proofID,
                title: "Process relaunch verification",
                streamID: proofID
            )
            let activity = try XCTUnwrap(Activity<AgentRunActivityAttributes>.activities.first(where: {
                $0.attributes.instanceID == proofID && $0.attributes.streamID == proofID
            }))
            XCTAssertTrue(activity.activityState == .active || activity.activityState == .stale)
            XCTAssertEqual(activity.content.state.status, .starting)
            XCTAssertEqual(activity.content.state.responseExcerpt, "")
            print("AIDEN_ACTIVITYKIT_PROCESS checkpoint=started proof=\(proofID)")

        case "reconcile":
            guard let activity = Activity<AgentRunActivityAttributes>.activities.first(where: {
                $0.attributes.instanceID == proofID && $0.attributes.streamID == proofID
            }) else {
                XCTFail("The system-persisted Aiden Live Activity was not available after process relaunch.")
                return
            }

            AidenNativeActivityURLProtocol.handler = { request in
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/streams/\(proofID)")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer process-proof-credential")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Aiden-Protocol-Version"), "1")
                let response = try XCTUnwrap(HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                ))
                return (response, Data("""
                {"streamId":"\(proofID)","chatId":"\(proofID)","turnId":"turn-process-proof",
                "state":"running","lastSequence":4,"updatedAt":"2026-08-19T19:00:00.000Z"}
                """.utf8))
            }
            defer { AidenNativeActivityURLProtocol.handler = nil }

            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [AidenNativeActivityURLProtocol.self]
            let client = AidenRemoteClient(
                endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
                credential: "process-proof-credential",
                session: URLSession(configuration: configuration)
            )
            let manager = AidenRemoteLiveActivityManager(defaults: defaults)
            let persisted = activity.content.state
            await manager.reconcile(instanceID: proofID, client: client, isCurrent: { true })

            guard let reconciled = await deliveredContent(
                of: activity,
                expecting: "a reconciled state after the persisted one",
                where: { $0 != persisted }
            ) else {
                await manager.endAll(forInstanceID: proofID)
                return
            }
            XCTAssertEqual(reconciled.status, .responding)
            XCTAssertFalse(reconciled.isStale)
            XCTAssertEqual(reconciled.responseExcerpt, "")

            await manager.endAll(forInstanceID: proofID)
            XCTAssertTrue(activity.activityState == .ended || activity.activityState == .dismissed)
            XCTAssertFalse(Activity<AgentRunActivityAttributes>.activities.contains(where: { $0.id == activity.id }))
            print("AIDEN_ACTIVITYKIT_PROCESS checkpoint=reconciled-and-ended proof=\(proofID)")

        case "cleanup":
            let manager = AidenRemoteLiveActivityManager(defaults: defaults)
            await manager.endAll(forInstanceID: proofID)
            XCTAssertFalse(Activity<AgentRunActivityAttributes>.activities.contains(where: {
                $0.attributes.instanceID == proofID
            }))
            print("AIDEN_ACTIVITYKIT_PROCESS checkpoint=cleanup proof=\(proofID)")

        default:
            XCTFail("AIDEN_ACTIVITYKIT_PROCESS_PHASE must be start, reconcile, or cleanup.")
        }
    }

    func testVoiceDraftIsLocalExplicitAndRejectsInvalidAudioInput() throws {
        XCTAssertEqual(
            ComposerVoiceDraftComposer.composedDraft(baseDraft: "Please", transcript: "summarize locally"),
            "Please summarize locally"
        )
        XCTAssertFalse(ComposerVoiceInputStartPolicy.canStart(appIsActive: false))
        XCTAssertThrowsError(try ComposerVoiceInputStartPolicy.validateAudioSessionInput(
            isInputAvailable: false,
            sampleRate: 44_100,
            inputNumberOfChannels: 1
        ))
    }

    func testHostedAppDeclaresVoiceAndLiveActivityPrivacyKeys() throws {
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription"))
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription"))
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription"))
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSLocalNetworkUsageDescription"))
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "NSSupportsLiveActivities") as? Bool, true)
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity"))

        let privacyManifestURL = try XCTUnwrap(Bundle.main.url(
            forResource: "PrivacyInfo",
            withExtension: "xcprivacy"
        ))
        let privacyManifest = try XCTUnwrap(
            PropertyListSerialization.propertyList(
                from: try Data(contentsOf: privacyManifestURL),
                format: nil
            ) as? [String: Any]
        )
        XCTAssertEqual(privacyManifest["NSPrivacyTracking"] as? Bool, false)
        XCTAssertTrue((privacyManifest["NSPrivacyCollectedDataTypes"] as? [Any])?.isEmpty == true)

        let noticeURL = try XCTUnwrap(Bundle.main.url(
            forResource: "NOTICE",
            withExtension: "txt",
            subdirectory: "ThirdPartyNotices"
        ))
        let notice = try String(contentsOf: noticeURL, encoding: .utf8)
        XCTAssertTrue(notice.contains("Hermex (adapted SwiftUI interaction and implementation foundation)"))
        XCTAssertTrue(notice.contains("KeychainAccess 4.2.2"))
        XCTAssertTrue(notice.contains("MarkdownUI 2.4.1"))
        XCTAssertTrue(notice.contains("NetworkImage 6.0.1"))
        XCTAssertTrue(notice.contains("swift-cmark 0.8.0"))
        XCTAssertFalse(notice.contains("swift-eventsource"))

        for licenseName in ["MarkdownUI-LICENSE", "NetworkImage-LICENSE", "swift-cmark-COPYING"] {
            let licenseURL = try XCTUnwrap(Bundle.main.url(
                forResource: licenseName,
                withExtension: "txt",
                subdirectory: "ThirdPartyNotices"
            ))
            XCTAssertFalse(try String(contentsOf: licenseURL, encoding: .utf8).isEmpty)
        }

        let hermexLicenseURL = try XCTUnwrap(Bundle.main.url(
            forResource: "Hermex-LICENSE",
            withExtension: "txt",
            subdirectory: "ThirdPartyNotices"
        ))
        let hermexLicense = try String(contentsOf: hermexLicenseURL, encoding: .utf8)
        XCTAssertTrue(hermexLicense.contains("MIT License"))
        XCTAssertTrue(hermexLicense.contains("Copyright (c) 2026 Uzair Ansar"))
    }

    func testPublicPolicyAndSupportLinksUseCanonicalHTTPSDestinations() {
        XCTAssertEqual(AppConfig.privacyPolicyURL.absoluteString, "https://chatwithaiden.com/privacy")
        XCTAssertEqual(
            AppConfig.supportURL.absoluteString,
            "https://chatwithaiden.com/"
        )
        XCTAssertEqual(AppConfig.privacyPolicyURL.scheme, "https")
        XCTAssertEqual(AppConfig.supportURL.scheme, "https")
    }

    func testUnpairedDeepLinkUsesGenericAidenErrorPresentation() {
        XCTAssertEqual(AidenPairingAlertCopy.title, "Aiden On The Go")
        XCTAssertEqual(
            AidenPairingAlertCopy.fallbackMessage,
            "Try again from Aiden Agent → Settings → Aiden On The Go."
        )
    }

    func testPairingMethodsMirrorEveryMacConnectionChoice() {
        XCTAssertEqual(
            AidenPairingMethod.primary,
            [.scanQRCode, .nearbyMac, .privateAddress]
        )
        XCTAssertEqual(AidenPairingMethod.advanced, [.pastePayload])
        XCTAssertEqual(
            Set(AidenPairingMethod.allCases),
            [.scanQRCode, .nearbyMac, .privateAddress, .pastePayload]
        )
        XCTAssertEqual(AidenPairingMethod.scanQRCode.badge, "Recommended")
        XCTAssertEqual(AidenPairingMethod.nearbyMac.badge, "Local Network")
        XCTAssertEqual(AidenPairingMethod.privateAddress.badge, "Tailscale")
        XCTAssertNil(AidenPairingMethod.pastePayload.badge)
        XCTAssertEqual(
            AidenPairingMethod.primary.map(\.tabTitle),
            ["QR", "Nearby", "Tailscale"]
        )
        XCTAssertTrue(AidenPairingMethod.nearbyMac.detail.contains("local Wi-Fi"))
        XCTAssertTrue(AidenPairingMethod.privateAddress.detail.contains("Tailscale"))
    }

    func testMobileOnboardingMirrorsMacCapabilityGroups() {
        XCTAssertEqual(AidenMobileOnboardingPhase.allCases, [.build, .extend, .control])
        XCTAssertEqual(
            AidenMobileOnboardingPhase.allCases.map(\.imageName),
            ["OnboardingBuild", "OnboardingExtend", "OnboardingControl"]
        )
        XCTAssertEqual(AidenMobileOnboardingPhase.build.eyebrow, "BOTS AND WORKSPACES")
        XCTAssertEqual(AidenMobileOnboardingPhase.extend.eyebrow, "CHOOSE AND EXTEND")
        XCTAssertEqual(
            AidenMobileOnboardingPhase.control.eyebrow,
            "AUTOMATE AND STAY IN CONTROL"
        )
        XCTAssertTrue(AidenMobileOnboardingPhase.build.detail.contains("Git"))
        XCTAssertTrue(AidenMobileOnboardingPhase.build.detail.contains("Bots"))
        XCTAssertTrue(AidenMobileOnboardingPhase.build.detail.contains("Workspaces"))
        XCTAssertTrue(AidenMobileOnboardingPhase.build.detail.contains("Aiden logo"))
        XCTAssertTrue(AidenMobileOnboardingPhase.extend.detail.contains("MCP"))
        XCTAssertTrue(AidenMobileOnboardingPhase.control.detail.contains("scheduled"))
    }

    func testMobileOnboardingUsesAvailableWindowSizeAndReadableMaximums() {
        XCTAssertEqual(AidenMobileOnboardingLayout.contentWidth(for: 390), 390)
        XCTAssertEqual(AidenMobileOnboardingLayout.contentWidth(for: 834), 620)
        XCTAssertEqual(AidenMobileOnboardingLayout.contentWidth(for: 320), 320)
        XCTAssertEqual(AidenMobileOnboardingLayout.contentHeight(for: 700), 700)
        XCTAssertEqual(AidenMobileOnboardingLayout.contentHeight(for: 1_194), 760)
        XCTAssertLessThan(
            AidenMobileOnboardingLayout.maximumActionWidth,
            AidenMobileOnboardingLayout.maximumContentWidth
        )
        XCTAssertEqual(AidenMobileOnboardingLayout.actionHorizontalPadding, 24)
        XCTAssertEqual(AidenMobileOnboardingLayout.actionBottomPadding, 12)
    }

    func testVoiceInputModeDefaultsAndLabelsRemainStable() {
        XCTAssertEqual(AidenVoiceInputMode.defaultsKey, "aiden.voiceInput.mode")
        XCTAssertEqual(AidenVoiceInputMode.allCases, [.onDevice, .pairedMac])
        XCTAssertEqual(AidenVoiceInputMode.onDevice.title, "On this device")
        XCTAssertEqual(AidenVoiceInputMode.pairedMac.title, "Paired desktop")
    }

    func testVoiceSessionFenceRejectsCallbacksFromAnInvalidatedSession() {
        var fence = ComposerVoiceSessionFence()
        let first = fence.advance()
        XCTAssertTrue(fence.accepts(first))

        let second = fence.advance()
        XCTAssertFalse(fence.accepts(first))
        XCTAssertTrue(fence.accepts(second))
    }

    func testVoiceDraftSessionStopsAcceptingResultsAfterCancellation() {
        var session = ComposerVoiceDraftUpdateSession()
        session.begin(baseDraft: "Keep")
        XCTAssertEqual(session.composedDraft(for: "this"), "Keep this")

        session.stopAcceptingUpdates()
        XCTAssertNil(session.composedDraft(for: "stale result"))
    }

    func testVoiceCaptureLifecycleAllowsPermissionPromptsButStopsInBackground() {
        XCTAssertFalse(AidenVoiceCaptureLifecyclePolicy.shouldDiscardRecording(for: .active))
        XCTAssertFalse(AidenVoiceCaptureLifecyclePolicy.shouldDiscardRecording(for: .inactive))
        XCTAssertTrue(AidenVoiceCaptureLifecyclePolicy.shouldDiscardRecording(for: .background))
    }

    func testMacSpeechAccumulatorProducesBoundedLittleEndian16kPCM() throws {
        let format = try XCTUnwrap(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4))
        buffer.frameLength = 4
        let channel = try XCTUnwrap(buffer.floatChannelData?[0])
        channel[0] = -1
        channel[1] = 0
        channel[2] = 0.5
        channel[3] = 1

        let accumulator = ComposerMacSpeechPCMAccumulator()
        accumulator.append(buffer)
        let pcm = accumulator.data
        XCTAssertEqual(pcm.count, 8)
        XCTAssertEqual(pcm.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 0, as: Int16.self) }, -32_767)
        XCTAssertEqual(pcm.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 2, as: Int16.self) }, 0)
        XCTAssertEqual(pcm.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 4, as: Int16.self) }, 16_383)
        XCTAssertEqual(pcm.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 6, as: Int16.self) }, 32_767)
    }
}

/// ActivityKit echoes an app's own `update(_:)` back to its `Activity`
/// instances asynchronously and throttles those echoes: an update issued right
/// after `request` can take seconds to reach `content`, even though the awaited
/// `update` call has already returned. Await the delivered content event
/// instead of polling `content` against a wall-clock budget.
///
/// The ceiling is not a pass/fail timing budget, and it does not raise a
/// timeout to hide a race: correctness comes only from the delivered event.
/// The ceiling exists so that a regression where the expected state never
/// arrives fails promptly, with a message, instead of hanging the CI job.
/// It sits an order of magnitude above the throttled delivery latency (about
/// 3 s observed), so a correct run never reaches it. Returns nil after recording a failure when the ceiling passes or
/// the content stream finishes first.
@MainActor
private func deliveredContent(
    of activity: Activity<AgentRunActivityAttributes>,
    expecting expectation: String,
    failureCeiling: Duration = .seconds(30),
    file: StaticString = #filePath,
    line: UInt = #line,
    where isExpected: @escaping @Sendable (AgentRunActivityAttributes.ContentState) -> Bool
) async -> AgentRunActivityAttributes.ContentState? {
    // Race the stream against the ceiling without a task group: ActivityKit's
    // `contentUpdates` does not end when its task is cancelled, and a group
    // would wait for that child before returning, so it would hang anyway.
    let race = AidenDeliveredContentRace()
    let outcome = await withCheckedContinuation { continuation in
        race.continuation = continuation
        race.observer = Task { @MainActor in
            // `contentUpdates` starts with the current content, so an echo
            // that has already landed is observed rather than missed.
            for await content in activity.contentUpdates {
                race.last = content.state
                if isExpected(content.state) {
                    race.finish(.delivered(content.state))
                    return
                }
            }
            race.finish(.streamFinished)
        }
        race.ceiling = Task { @MainActor in
            guard (try? await Task.sleep(for: failureCeiling)) != nil else { return }
            race.finish(.ceilingReached)
        }
    }
    race.observer?.cancel()
    race.ceiling?.cancel()

    let lastSeen = race.last.map { "status \($0.status), stale \($0.isStale)" } ?? "no content"
    switch outcome {
    case let .delivered(state):
        return state
    case .streamFinished:
        XCTFail(
            "ActivityKit ended the content stream before delivering \(expectation); last seen: \(lastSeen).",
            file: file,
            line: line
        )
    case .ceilingReached:
        XCTFail(
            "ActivityKit did not deliver \(expectation) within the \(failureCeiling) failure ceiling; last seen: \(lastSeen).",
            file: file,
            line: line
        )
    }
    return nil
}

private enum AidenDeliveredContentOutcome: Sendable {
    case delivered(AgentRunActivityAttributes.ContentState)
    case streamFinished
    case ceilingReached
}

@MainActor
private final class AidenDeliveredContentRace {
    var last: AgentRunActivityAttributes.ContentState?
    var continuation: CheckedContinuation<AidenDeliveredContentOutcome, Never>?
    var observer: Task<Void, Never>?
    var ceiling: Task<Void, Never>?

    func finish(_ outcome: AidenDeliveredContentOutcome) {
        continuation?.resume(returning: outcome)
        continuation = nil
    }
}

private final class AidenNativeActivityURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
