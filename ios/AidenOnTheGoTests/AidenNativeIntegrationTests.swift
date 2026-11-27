import ActivityKit
import AVFoundation
import Foundation
import SwiftUI
import UIKit
import UserNotifications
import Vision
import XCTest
@testable import AidenOnTheGo

final class AidenNativeIntegrationTests: XCTestCase {
    @MainActor
    func testOfflineRecoveryOffersSwitchingOrPairAgainWhenRetryIsUnsafe() throws {
        let forgotten = try alertServerError(401, code: "authentication_required")
        for error in [URLError(.cannotConnectToHost) as Error, AidenServerTrustError.publicKeyPinMismatch, forgotten] {
            let coordinator = AidenRemoteCoordinator(installationStore: AidenInstallationStore(keychain: AidenRecoveryMemoryKeychain()))
            let issue = AidenConnectionIssue.classify(error)
            let host = UIHostingController(rootView:
                AidenConnectionRecoveryView(coordinator: coordinator, issue: issue, switchConnection: {}, pairAgain: {})
                    .environment(AidenHapticCenter())
                    .environment(\.colorScheme, .light)
            )
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 320, height: 700)
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            window.layoutIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))

            // Inspect the rendered text, since a hosted SwiftUI view does not
            // publish its virtual accessibility buttons to unit-test callers.
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = issue.title
            add(attachment)
            let recognition = VNRecognizeTextRequest()
            recognition.recognitionLevel = .accurate
            try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage)).perform([recognition])
            let raw = (recognition.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
            let text = raw.lowercased()
            // A forgotten device offers one way back, Pair again, so VoiceOver hears no duplicate.
            XCTAssertEqual(text.contains("switch connection"), !issue.pairAgain, "\(issue.title): \(text)")
            // The button's capital P: the trust message also says "pair again".
            XCTAssertEqual(raw.contains("Pair again"), issue.pairAgain, "\(issue.title): \(raw)")
            XCTAssertEqual(text.contains("retry connection"), issue.canRetry, text)
        }
    }

    @MainActor
    func testExternalVoiceLinkHasNoRecordingAuthorityAndForgedProvenanceIsRejected() throws {
        let external = try XCTUnwrap(AidenDeepLink.request(from: URL(string: "aiden-otg://new-chat-voice?instance=mac&workspace=workspace")!))
        XCTAssertEqual(external.destination, .newChat)
        XCTAssertFalse(external.startsVoice)
        for query in ["internal=true", "trusted=1", "startsVoice=true", "action=voice"] {
            XCTAssertNil(AidenDeepLink.request(from: URL(string: "aiden-otg://new-chat-voice?\(query)")!))
        }
    }

    @MainActor
    func testExternalNewChatWaitsForReadinessThenOffersConsentOnlyOnce() throws {
        let queue = AidenExternalNewChatQueue()
        let request = try XCTUnwrap(AidenDeepLink.request(from: URL(string: "aiden-otg://new-chat-voice?instance=mac&workspace=project")!))
        let entry = AidenExternalNewChatQueue.Entry(request: request, origin: nil, instanceID: "mac", deviceID: "phone", pairedAt: Date())
        queue.receive(entry)
        var presentations = 0
        for _ in 0..<3 {
            if queue.takeIfReady(false, isValid: { _ in true }) != nil { presentations += 1 }
        }
        XCTAssertEqual(presentations, 0)
        XCTAssertEqual(queue.waiting?.request.workspaceId, "project")
        if let ready = queue.takeIfReady(true, isValid: { _ in true }) {
            presentations += 1
            XCTAssertFalse(ready.request.startsVoice)
        }
        XCTAssertNil(queue.takeIfReady(true, isValid: { _ in true }))
        XCTAssertEqual(presentations, 1)
    }

    @MainActor
    func testNewerNavigationAndRevocationDiscardWaitingNewChatRequests() throws {
        let queue = AidenExternalNewChatQueue()
        func entry(_ workspace: String) -> AidenExternalNewChatQueue.Entry {
            .init(request: .init(destination: .newChat, instanceId: "mac", workspaceId: workspace, startsVoice: false),
                  origin: nil, instanceID: "mac", deviceID: "phone", pairedAt: Date())
        }
        queue.receive(entry("older"))
        XCTAssertNil(queue.takeIfReady(false, isValid: { _ in true }))
        queue.receive(entry("newer"))
        XCTAssertEqual(queue.takeIfReady(true, isValid: { _ in true })?.request.workspaceId, "newer")
        queue.receive(entry("revoked"))
        XCTAssertNil(queue.takeIfReady(false, isValid: { _ in false }))
        XCTAssertNil(queue.takeIfReady(true, isValid: { _ in true }))
        queue.receive(entry("superseded-by-shortcut"))
        queue.invalidate()
        XCTAssertNil(queue.takeIfReady(true, isValid: { _ in true }))
    }

    @MainActor
    func testForegroundIntentIsRetainedBeforeConsumerMounts() async throws {
        let router = AidenForegroundIntentRouter.shared
        router.discardActions()
        _ = try await NewChatVoiceIntent().perform()
        let action = try XCTUnwrap(router.pending)
        XCTAssertTrue(action.startsVoice)
        router.discardActions()
        XCTAssertNil(router.pending)
    }

    @MainActor
    func testNewChatConsentCancellationStalePairingAndDuplicateDeliveryNeverCreate() async throws {
        let consent = AidenNewChatLinkConsent()
        let now = Date()
        func target(_ workspace: String = "workspace") -> AidenNewChatLinkConsent.Target {
            .init(instanceID: "mac", deviceID: "phone", pairedAt: now, installationName: "My Mac",
                  workspaceID: workspace, workspaceName: workspace, origin: nil, startsVoice: false, createdAt: now)
        }
        var creates = 0
        let cancelled = target()
        XCTAssertTrue(consent.propose(cancelled))
        XCTAssertFalse(consent.propose(target("other")))
        consent.invalidate()
        let cancelledResult = await consent.perform(id: cancelled.id, isValid: { true }) { _ in creates += 1; return 1 }
        XCTAssertNil(cancelledResult)
        let stale = target()
        XCTAssertTrue(consent.propose(stale))
        let staleResult = await consent.perform(id: stale.id, isValid: { false }) { _ in creates += 1; return 1 }
        XCTAssertNil(staleResult)
        XCTAssertEqual(creates, 0)
        let accepted = target()
        XCTAssertTrue(consent.propose(accepted))
        let result = await consent.perform(id: accepted.id, isValid: { true }) { frozen in
            XCTAssertEqual(frozen.workspaceID, "workspace")
            creates += 1
            let duplicate = await consent.perform(id: accepted.id, isValid: { true }) { _ in creates += 1; return 2 }
            XCTAssertNil(duplicate)
            return 1
        }
        XCTAssertEqual(result, 1)
        XCTAssertEqual(creates, 1)
    }

    @MainActor
    func testNewChatConsentDropsLateResultsAndExpiredApproval() async {
        let consent = AidenNewChatLinkConsent()
        let now = Date()
        let target = AidenNewChatLinkConsent.Target(instanceID: "mac", deviceID: "phone", pairedAt: now,
            installationName: "My Mac", workspaceID: "workspace", workspaceName: "Project", origin: nil,
            startsVoice: false, createdAt: now)
        _ = consent.propose(target)
        var creates = 0
        let expired = await consent.perform(id: target.id, now: now.addingTimeInterval(60), isValid: { true }) { _ in creates += 1; return 1 }
        XCTAssertNil(expired)
        XCTAssertEqual(creates, 0)
        _ = consent.propose(target)
        let late = await consent.perform(id: target.id, isValid: { true }) { _ in
            creates += 1
            consent.invalidate() // Revocation/background/navigation won while the request was suspended.
            return 1
        }
        XCTAssertNil(late)
        XCTAssertEqual(creates, 1)
    }

    func testDiagnosticVocabularyIsClosedAndContentFree() {
        XCTAssertEqual(
            Set(AidenDiagnosticArea.allCases.map(\.rawValue)),
            Set(["connection", "authentication", "contract", "cache", "stream", "speech", "notification", "liveActivity", "priorTermination", "app"])
        )
        XCTAssertTrue(AidenDiagnosticEvent.allCases.contains(.contractRejected))
        XCTAssertTrue(AidenDiagnosticEvent.allCases.contains(.keyboardReachMissed))
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
        // The sink is process-wide, and other suites trigger the same contract rejections from
        // async work that can finish while this test runs. Count only diagnostics emitted inside
        // this test's own task, so the "exactly one each" check measures these two calls alone.
        let scope = UUID()
        AidenDiagnostics.testSink = { area, event, outcome, code in
            guard DiagnosticsTestScope.current == scope else { return }
            records.append((area, event, outcome, code))
        }
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

        try await DiagnosticsTestScope.$current.withValue(scope) {
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
        }

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
                startsVoice: false
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

    func testLiveActivityToolCallCountIsBounded() {
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

    func testStaleLiveActivityKeepsWaitingForApprovalAskAndOtherStatusesShowLatestStatus() {
        let start = Date(timeIntervalSince1970: 1_000)
        for status in AgentRunActivityStatus.allCases {
            let fresh = AgentRunActivityAttributes.ContentState(
                sessionID: "chat-1",
                sessionTitle: "Chat",
                status: status,
                currentActivity: "Running bash",
                responseExcerpt: "Earlier reply",
                startedAt: start,
                updatedAt: start + 5,
                errorSummary: status == .failed ? "Provider error" : nil
            )
            // A fresh run, whichever way it is checked, has no stale override.
            XCTAssertNil(AgentRunStalePresentation.copy(for: fresh, systemMarkedStale: false), "\(status)")

            let reducerStale = AgentRunActivityStateReducer.stale(state: fresh)
            for (label, state, systemMarkedStale) in [
                ("reducer", reducerStale, false),
                ("system", fresh, true),
            ] {
                let copy = AgentRunStalePresentation.copy(for: state, systemMarkedStale: systemMarkedStale)
                if status == .waitingForApproval {
                    XCTAssertEqual(copy?.lead, "Waiting for approval", label)
                    XCTAssertEqual(copy?.action, "Open to answer", label)
                    // Stale styling still applies to the waiting state.
                    XCTAssertTrue(AgentRunFreshness.isStale(state, systemMarkedStale: systemMarkedStale), label)
                } else {
                    XCTAssertEqual(copy?.lead, "Latest status shown", "\(status) \(label)")
                    XCTAssertNil(copy?.action, "\(status) \(label)")
                }
            }
        }
    }

    func testFinishedLiveActivityIsNeverPresentedAsStaleWaiting() {
        let start = Date(timeIntervalSince1970: 1_000)
        let waiting = AgentRunActivityStateReducer.waitingForApproval(
            state: AgentRunActivityStateReducer.initialState(sessionID: "chat-1", sessionTitle: "Chat", startedAt: start),
            now: start + 1
        )
        let done = AgentRunActivityStateReducer.final(
            status: .cancelled,
            activity: "Cancelled",
            state: AgentRunActivityStateReducer.stale(state: waiting),
            now: start + 2
        )
        XCTAssertNil(AgentRunStalePresentation.copy(for: done, systemMarkedStale: true))
    }

    func testStaleWaitingStateWithoutActivityLineFallsBackToWaitingTitle() throws {
        // State persisted by an older build: no `toolCallCount`, empty activity line.
        let legacy = Data("""
        {"sessionID":"chat-1","sessionTitle":"Chat","status":"waitingForApproval",
         "currentActivity":"","responseExcerpt":"","startedAt":0,
         "updatedAt":12,"isStale":true,"isFinal":false}
        """.utf8)
        let decoded = try JSONDecoder().decode(AgentRunActivityAttributes.ContentState.self, from: legacy)
        XCTAssertEqual(
            AgentRunStalePresentation.copy(for: decoded, systemMarkedStale: false),
            AgentRunStalePresentation.Copy(lead: "Waiting for approval", action: "Open to answer")
        )

        XCTAssertEqual(AgentRunActivityStateReducer.stale(state: decoded).currentActivity, "Waiting for approval")
        var thinking = decoded
        thinking.status = .thinking
        XCTAssertEqual(AgentRunActivityStateReducer.stale(state: thinking).currentActivity, "Latest status shown")
    }

    func testTextPresentationNamesBlockingWaitsInPlainWords() {
        let started = Date(timeIntervalSince1970: 1_000)
        let approval = liveState(status: .waitingForApproval, startedAt: started, updatedAt: started)
        let p = AgentRunTextPresentation.make(state: approval, systemMarkedStale: false)
        XCTAssertEqual(p.status, "Needs your approval")
        XCTAssertEqual(p.compactStatus, "Needs you")
        XCTAssertEqual(p.timing, .running(startedAt: started))
        XCTAssertEqual(
            AgentRunTextPresentation.make(state: liveState(status: .waitingForAnswer), systemMarkedStale: false).status,
            "Has a question for you"
        )
    }

    func testTextPresentationWorkingUsesTheSanitizedActivityLine() {
        let p = AgentRunTextPresentation.make(
            state: liveState(status: .runningCommand, activity: "Running   npm\ntest"),
            systemMarkedStale: false
        )
        XCTAssertEqual(p.status, "Running npm test")
        XCTAssertEqual(p.compactStatus, AgentRunActivityStatus.runningCommand.compactTitle)
        XCTAssertNil(p.detail)
        XCTAssertEqual(
            AgentRunTextPresentation.make(state: liveState(status: .thinking, activity: ""), systemMarkedStale: false).status,
            "Thinking"
        )
    }

    func testTextPresentationForStaleRunsUsesLatestStatusCopy() {
        let updated = Date(timeIntervalSince1970: 2_000)
        let reading = AgentRunTextPresentation.make(
            state: liveState(status: .readingFiles, updatedAt: updated),
            systemMarkedStale: true
        )
        XCTAssertEqual(reading.status, "Latest status shown")
        XCTAssertEqual(reading.compactStatus, "Latest")
        XCTAssertEqual(reading.timing, .updated(at: updated))
        let waiting = AgentRunTextPresentation.make(state: liveState(status: .waitingForApproval), systemMarkedStale: true)
        XCTAssertEqual(waiting.status, "Waiting for approval · Open to answer")
    }

    func testTextPresentationFinalStates() {
        let done = AgentRunTextPresentation.make(
            state: liveState(status: .complete, excerpt: "All 12 tests pass.", isFinal: true),
            systemMarkedStale: true
        )
        XCTAssertEqual(done.status, "Done")
        XCTAssertEqual(done.compactStatus, "Done")
        XCTAssertEqual(done.detail, "All 12 tests pass.")
        XCTAssertEqual(done.timing, .none)
        XCTAssertNil(
            AgentRunTextPresentation.make(state: liveState(status: .complete, isFinal: true), systemMarkedStale: false).detail
        )
        XCTAssertEqual(
            AgentRunTextPresentation.make(
                state: liveState(status: .failed, error: "Mac went to sleep", isFinal: true),
                systemMarkedStale: false
            ).status,
            "Mac went to sleep"
        )
        XCTAssertEqual(
            AgentRunTextPresentation.make(state: liveState(status: .failed, isFinal: true), systemMarkedStale: false).status,
            "Failed"
        )
        XCTAssertEqual(
            AgentRunTextPresentation.make(state: liveState(status: .cancelled, isFinal: true), systemMarkedStale: false).status,
            "Stopped"
        )
    }

    func testApprovalTargetIsSetWhileWaitingAndClearedByAnyLaterTransition() {
        let target = AgentRunApprovalTarget(approvalID: "ap-1", runID: nil)
        let waiting = AgentRunActivityStateReducer.waitingForApproval(state: approvalBase(), target: target)
        XCTAssertEqual(waiting.approval, target)
        // Relabeling and going stale keep the ask the person can still answer.
        XCTAssertEqual(AgentRunActivityStateReducer.stale(state: waiting).approval, target)
        XCTAssertEqual(AgentRunActivityStateReducer.refreshedWaiting(state: waiting).approval, target)
        XCTAssertEqual(AgentRunActivityStateReducer.updatingSessionTitle("Renamed", state: waiting).approval, target)
        XCTAssertNil(AgentRunActivityStateReducer.toolStarted(name: "bash", state: waiting).approval)
        XCTAssertNil(AgentRunActivityStateReducer.reasoning("", state: waiting).approval)
        XCTAssertNil(
            AgentRunActivityStateReducer.final(status: .complete, activity: "Done", state: waiting, errorSummary: nil).approval
        )
        let denied = AgentRunActivityStateReducer.answered(decision: .deny, state: waiting)
        XCTAssertNil(denied.approval)
        XCTAssertEqual(denied.status, .thinking)
        XCTAssertEqual(denied.currentActivity, "Denied")
    }

    func testCardOffersReviewAndDenyOnlyForAFreshAnswerableApproval() {
        let target = AgentRunApprovalTarget(approvalID: "ap-1", runID: nil)
        let fresh = AgentRunActivityStateReducer.waitingForApproval(state: approvalBase(), target: target)
        XCTAssertEqual(AgentRunTextPresentation.make(state: fresh, systemMarkedStale: false).actions, [.review, .deny])
        XCTAssertEqual(AgentRunTextPresentation.make(state: fresh, systemMarkedStale: true).actions, [.review])
        let unanswerable = AgentRunActivityStateReducer.waitingForApproval(state: approvalBase(), target: nil)
        XCTAssertEqual(AgentRunTextPresentation.make(state: unanswerable, systemMarkedStale: false).actions, [.review])
        let question = AgentRunActivityStateReducer.waitingForAnswer(state: approvalBase())
        XCTAssertEqual(AgentRunTextPresentation.make(state: question, systemMarkedStale: false).actions, [.review])
        XCTAssertEqual(AgentRunTextPresentation.make(state: approvalBase(), systemMarkedStale: false).actions, [])
        let done = AgentRunActivityStateReducer.final(status: .complete, activity: "Done", state: fresh)
        XCTAssertEqual(AgentRunTextPresentation.make(state: done, systemMarkedStale: false).actions, [])
    }

    func testStateWithoutApprovalTargetDecodesWithoutActions() throws {
        // Encoded by a build before approval targets existed.
        let json = Data("""
        {"sessionID":"chat-1","sessionTitle":"Chat","status":"waitingForApproval",
         "currentActivity":"Needs your approval","responseExcerpt":"","startedAt":0,
         "updatedAt":12,"isStale":false,"isFinal":false,"toolCallCount":1}
        """.utf8)
        let state = try JSONDecoder().decode(AgentRunActivityAttributes.ContentState.self, from: json)
        XCTAssertNil(state.approval)
        XCTAssertEqual(AgentRunTextPresentation.make(state: state, systemMarkedStale: false).actions, [.review])

        let target = AgentRunApprovalTarget(approvalID: "ap-1", runID: "run-1")
        let waiting = AgentRunActivityStateReducer.waitingForApproval(state: state, target: target)
        let roundTripped = try JSONDecoder().decode(
            AgentRunActivityAttributes.ContentState.self,
            from: JSONEncoder().encode(waiting)
        )
        XCTAssertEqual(roundTripped.approval, target)
    }

    @MainActor
    func testResponderDeniesOnTheStreamOrRunRoute() async throws {
        let fake = FakeAlertTransport()
        let responder = AidenAlertActionResponder(lookup: { _ in .client(fake) })
        let streamOutcome = await responder.run(.deny(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap", runID: nil)))
        XCTAssertEqual(streamOutcome, .done)
        let runOutcome = await responder.run(.deny(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap", runID: "r1")))
        XCTAssertEqual(runOutcome, .done)
        let approveOutcome = await responder.run(.approve(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap2", runID: nil)))
        XCTAssertEqual(approveOutcome, .done)
        XCTAssertEqual(fake.calls, [
            .streamApproval(id: "ap", decision: .deny, scope: nil),
            .runApproval(runId: "r1", approvalId: "ap", decision: .deny, scope: nil),
            .streamApproval(id: "ap2", decision: .allow, scope: nil),
        ])
        // Every attempt carries its own idempotency key.
        XCTAssertEqual(Set(fake.idempotencyKeys).count, 3)
    }

    @MainActor
    func testResponderTreatsResolvedApprovalAsDone() async throws {
        for code in ["approval_resolved", "approval_already_resolved", "approval_expired",
                     "question_already_resolved", "question_expired"] {
            let fake = FakeAlertTransport(failure: try alertServerError(409, code: code))
            let outcome = await AidenAlertActionResponder(lookup: { _ in .client(fake) })
                .run(.deny(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap", runID: nil)))
            XCTAssertEqual(outcome, .alreadyResolved(winner: nil), code)
        }
        let other = FakeAlertTransport(failure: try alertServerError(500, code: "internal_error"))
        let outcome = await AidenAlertActionResponder(lookup: { _ in .client(other) })
            .run(.deny(instanceID: "mac", chatID: "c1", target: .init(approvalID: "ap", runID: nil)))
        XCTAssertEqual(outcome, .openApp(AidenDeepLink.chatURL(instanceId: "mac", chatId: "c1")))
    }

    /// Someone answered on the Mac first: the outcome carries what they chose,
    /// not what the phone asked for.
    @MainActor
    func testResponderReportsTheMacsWinningDecision() async throws {
        for (decision, winner) in [("allow", AgentRunApprovalAnswer.allow), ("deny", .deny)] {
            let fake = FakeAlertTransport(
                failure: try alertServerError(409, code: "approval_resolved", details: ["decision": decision])
            )
            let outcome = await AidenAlertActionResponder(lookup: { _ in .client(fake) })
                .run(.deny(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap", runID: "r1")))
            XCTAssertEqual(outcome, .alreadyResolved(winner: winner), decision)
        }
        let expired = FakeAlertTransport(
            failure: try alertServerError(409, code: "approval_resolved", details: ["decision": "expired"])
        )
        let outcome = await AidenAlertActionResponder(lookup: { _ in .client(expired) })
            .run(.approve(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap", runID: "r1")))
        XCTAssertEqual(outcome, .alreadyResolved(winner: nil))
    }

    func testAnswerFromElsewhereWithoutAKnownDecisionReadsNeutrally() {
        let target = AgentRunApprovalTarget(approvalID: "ap-1", runID: nil)
        let waiting = AgentRunActivityStateReducer.waitingForApproval(state: approvalBase(), target: target)
        let closed = AgentRunActivityStateReducer.answered(decision: nil, state: waiting)
        XCTAssertNil(closed.approval)
        XCTAssertEqual(closed.currentActivity, "No longer waiting")
    }

    /// The card shows the Mac's answer when the phone's Deny lost the race:
    /// someone allowed it on the Mac, so the card must not say "Denied".
    @MainActor
    func testBrokerShowsTheMacsDecisionWhenThePhonesAnswerLost() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let mac = "broker-\(UUID().uuidString)"
        let manager = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        defer { Task { @MainActor in await manager.endAll(forInstanceID: mac) } }
        let target = AgentRunApprovalTarget(approvalID: "ap-\(UUID().uuidString)", runID: "r1")
        await manager.start(instanceID: mac, chatID: "c1", title: "Fix login", streamID: "s1")
        await manager.approvalRequired(instanceID: mac, streamID: "s1", target: target)
        let activity = try XCTUnwrap(Activity<AgentRunActivityAttributes>.activities.first {
            $0.attributes.instanceID == mac && $0.attributes.streamID == "s1"
        })
        // The card starts without an approval, so wait for the approval to land
        // before answering; otherwise the opening state reads as "answered".
        let waiting = await deliveredContent(of: activity, expecting: "the approval", where: { $0.approval != nil })
        XCTAssertNotNil(waiting)

        let fake = FakeAlertTransport(
            failure: try alertServerError(409, code: "approval_resolved", details: ["decision": "allow"])
        )
        let perform = AidenBackgroundActionBroker.perform(lookup: { _ in .client(fake) }, liveActivities: manager)
        let outcome = await perform(.deny(instanceID: mac, chatID: "c1", target: target))
        XCTAssertEqual(outcome, .alreadyResolved(winner: .allow))
        let shown = await deliveredContent(of: activity, expecting: "the answered state", where: { $0.approval == nil })
        XCTAssertEqual(shown?.currentActivity, "Approved")
    }

    @MainActor
    func testResponderOpensChatWhenMacUnreachable() async {
        let outcome = await AidenAlertActionResponder(lookup: { _ in .unreachable })
            .run(.deny(instanceID: "mac", chatID: "c1", target: .init(approvalID: "ap", runID: nil)))
        XCTAssertEqual(outcome, .openApp(AidenDeepLink.chatURL(instanceId: "mac", chatId: "c1")))
    }

    @MainActor
    func testResponderDropsActionForForgottenMac() async {
        let outcome = await AidenAlertActionResponder(lookup: { _ in .forgotten })
            .run(.deny(instanceID: "gone", chatID: "c", target: .init(approvalID: "ap", runID: nil)))
        XCTAssertEqual(outcome, .dropped)
    }

    /// A run that already finished, or that the Mac no longer has, has nothing
    /// left to answer: the action counts as settled instead of coming back.
    @MainActor
    func testResponderTreatsAFinishedOrGoneRunAsNoLongerWaiting() async throws {
        for (status, code) in [(409, "operation_stale"), (404, "run_gone")] {
            let fake = FakeAlertTransport(failure: try alertServerError(status, code: code))
            let responder = AidenAlertActionResponder(lookup: { _ in .client(fake) })
            let deny = await responder.run(.deny(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap", runID: "r1")))
            XCTAssertEqual(deny, .alreadyResolved(winner: nil), code)
            let reply = await responder.run(.reply(instanceID: "mac", chatID: "c", promptID: "q", runID: "r1", text: "Yes"))
            XCTAssertEqual(reply, .alreadyResolved(winner: nil), code)
        }
    }

    /// A Mac that revoked this phone will never take the answer, so trying
    /// again later is pointless: the action is dropped, not re-posted.
    @MainActor
    func testResponderDropsAnAnswerTheMacRefusesAsRevoked() async throws {
        let fake = FakeAlertTransport(failure: try alertServerError(401, code: "credential_revoked"))
        let outcome = await AidenAlertActionResponder(lookup: { _ in .client(fake) })
            .run(.approve(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap", runID: nil)))
        XCTAssertEqual(outcome, .dropped)
    }

    @MainActor
    func testTheAppDropsAnAnswerForAMacKnownToBeRevoked() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: AidenDemoResponder())
        await coordinator.start()
        coordinator.hosts.connection(for: "mini")?.markRevoked()
        let perform = AidenBackgroundActionBroker.perform(
            coordinator: coordinator,
            liveActivities: AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        )
        let outcome = await perform(.deny(instanceID: "mini", chatID: "c", target: .init(approvalID: "ap", runID: nil)))
        XCTAssertEqual(outcome, .dropped)
    }

    @MainActor
    func testResponderRepliesAsTheFirstQuestionsCustomAnswer() async {
        let fake = FakeAlertTransport()
        let responder = AidenAlertActionResponder(lookup: { _ in .client(fake) })
        _ = await responder.run(.reply(instanceID: "mac", chatID: "c", promptID: "q1", runID: nil, text: "Just the App Store version"))
        _ = await responder.run(.reply(instanceID: "mac", chatID: "c", promptID: "q2", runID: "r1", text: "Yes"))
        XCTAssertEqual(fake.calls, [
            .question(id: "q1", request: .init(cancelled: false, answers: [.custom(questionIndex: 0, answer: "Just the App Store version")])),
            .runQuestion(runId: "r1", promptId: "q2", request: .init(cancelled: false, answers: [.custom(questionIndex: 0, answer: "Yes")])),
        ])
    }

    @MainActor
    func testBackgroundBrokerOpensTheAppUntilWired() async {
        let broker = AidenBackgroundActionBroker()
        let deny = AidenAlertAction.deny(instanceID: "mac", chatID: "c", target: .init(approvalID: "ap", runID: nil))
        let unwired = await broker.run(deny)
        XCTAssertEqual(unwired, .openApp(nil))
        broker.perform = { _ in .done }
        let wired = await broker.run(deny)
        XCTAssertEqual(wired, .done)
    }

    /// Deny on the card that can't reach the Mac tells the person, with an
    /// alert that opens the chat to answer there. A Deny that lands, or a
    /// forgotten Mac, posts nothing.
    @MainActor
    func testCardDenyThatCannotReachTheMacPostsAnAlertThatOpensTheChat() async throws {
        let center = AidenNotificationCenterFake()
        let broker = AidenBackgroundActionBroker()
        broker.onCardActionUnanswered = { action, link in
            await AidenUnansweredCardAction.post(action, link: link, center: center)
        }
        let deny = AidenAlertAction.deny(instanceID: "mac", chatID: "c1", target: .init(approvalID: "ap", runID: nil))

        for outcome in [AidenAlertActionOutcome.done, .alreadyResolved(winner: .allow), .dropped] {
            broker.perform = { _ in outcome }
            _ = await broker.runFromCard(deny)
        }
        XCTAssertTrue(center.posted.isEmpty)

        let chatURL = AidenDeepLink.chatURL(instanceId: "mac", chatId: "c1")
        broker.perform = { _ in .openApp(chatURL) }
        let outcome = await broker.runFromCard(deny)
        XCTAssertEqual(outcome, .openApp(chatURL))
        XCTAssertEqual(center.posted.count, 1)
        let posted = try XCTUnwrap(center.posted.first)
        XCTAssertEqual(posted.content.title, "Deny didn't reach your computer")
        XCTAssertEqual(posted.content.body, "Open the chat to answer there.")
        let tap = await AidenNotificationPresentationDelegate.respond(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: posted.content.userInfo,
            replyText: nil,
            broker: broker
        )
        XCTAssertEqual(tap, AidenNotificationTap(link: chatURL, instanceID: "mac"))
    }

    // MARK: Run alert actions

    func testApprovalAlertCarriesApproveOnlyWhenThePhoneMayAllow() {
        let target = AgentRunApprovalTarget(approvalID: "ap", runID: nil)
        let allowed = make(.needsApproval, .approval(target: target, summary: "Run npm run test:e2e", canAllow: true))
        XCTAssertEqual(allowed.categoryIdentifier, AidenRunAlertCategory.approval)
        let denyOnly = make(.needsApproval, .approval(target: target, summary: "Run npm run test:e2e", canAllow: false))
        XCTAssertEqual(denyOnly.categoryIdentifier, AidenRunAlertCategory.approvalDenyOnly)
    }

    func testAlertBodyShowsMessageTextOnlyWhenAllowed() {
        let detail = AidenRunAlertDetail.approval(
            target: .init(approvalID: "ap", runID: nil),
            summary: "Run npm run test:e2e",
            canAllow: true
        )
        XCTAssertEqual(make(.needsApproval, detail, showMessageText: true).body, "Run npm run test:e2e")
        XCTAssertEqual(make(.needsApproval, detail, showMessageText: false).body, AidenRunAlertKind.needsApproval.body)
        let question = AidenRunAlertDetail.question(promptID: "q", runID: nil, text: "Which build?\u{202E}", acceptsReply: true)
        XCTAssertEqual(make(.needsAnswer, question).body, "Which build?")
        XCTAssertEqual(make(.completed, nil).body, AidenRunAlertKind.completed.body)
    }

    func testAlertTitleThreadAndUrgencyStayAsBefore() {
        let content = make(.needsAnswer, .question(promptID: "q", runID: nil, text: "Which build?", acceptsReply: true))
        XCTAssertEqual(content.title, "Fix flaky login test")
        XCTAssertEqual(content.threadIdentifier, "aiden.run.mac.c1")
        XCTAssertEqual(content.interruptionLevel, .timeSensitive)
        XCTAssertEqual(make(.completed, nil).interruptionLevel, .active)
        XCTAssertEqual(make(.completed, nil).categoryIdentifier, "")
    }

    func testMultiQuestionPromptGetsOpenOnly() {
        let content = make(.needsAnswer, .question(promptID: "q", runID: nil, text: "Which build?", acceptsReply: false))
        XCTAssertEqual(content.categoryIdentifier, AidenRunAlertCategory.question)
        let single = make(.needsAnswer, .question(promptID: "q", runID: nil, text: "Which build?", acceptsReply: true))
        XCTAssertEqual(single.categoryIdentifier, AidenRunAlertCategory.questionReply)
    }

    func testAlertActionRoundTripsThroughUserInfo() {
        let target = AgentRunApprovalTarget(approvalID: "ap", runID: "r1")
        let content = make(.needsApproval, .approval(target: target, summary: "x", canAllow: true))
        XCTAssertEqual(
            AidenAlertAction(actionIdentifier: AidenRunAlertCategory.actionDeny, userInfo: content.userInfo, replyText: nil),
            .deny(instanceID: "mac", chatID: "c1", target: target)
        )
        XCTAssertEqual(
            AidenAlertAction(actionIdentifier: AidenRunAlertCategory.actionApprove, userInfo: content.userInfo, replyText: nil),
            .approve(instanceID: "mac", chatID: "c1", target: target)
        )
        XCTAssertNil(AidenAlertAction(actionIdentifier: "unknown", userInfo: content.userInfo, replyText: nil))
        XCTAssertNil(AidenAlertAction(actionIdentifier: AidenRunAlertCategory.actionReply, userInfo: content.userInfo, replyText: "  "))

        let question = make(.needsAnswer, .question(promptID: "q", runID: "r2", text: "Which build?", acceptsReply: true))
        XCTAssertEqual(
            AidenAlertAction(actionIdentifier: AidenRunAlertCategory.actionReply, userInfo: question.userInfo, replyText: " staging "),
            .reply(instanceID: "mac", chatID: "c1", promptID: "q", runID: "r2", text: "staging")
        )
        XCTAssertNil(AidenAlertAction(actionIdentifier: AidenRunAlertCategory.actionReply, userInfo: question.userInfo, replyText: "  "))
        XCTAssertNil(AidenAlertAction(actionIdentifier: AidenRunAlertCategory.actionDeny, userInfo: question.userInfo, replyText: nil))
    }

    func testAlertTapOpensTheChatOnItsOwnMac() {
        let content = make(.needsApproval, .approval(target: .init(approvalID: "ap", runID: nil), summary: "x", canAllow: true))
        let tap = AidenNotificationTap(userInfo: content.userInfo)
        XCTAssertEqual(tap.link, AidenDeepLink.chatURL(instanceId: "mac", chatId: "c1"))
        XCTAssertEqual(tap.instanceID, "mac")
    }

    func testRegisteredApproveActionRequiresUnlock() {
        let categories = AidenRunAlertCategory.all()
        let approval = categories.first { $0.identifier == AidenRunAlertCategory.approval }!
        let approve = approval.actions.first { $0.identifier == AidenRunAlertCategory.actionApprove }!
        XCTAssertTrue(approve.options.contains(.authenticationRequired))
        XCTAssertTrue(approval.actions.first { $0.identifier == AidenRunAlertCategory.actionDeny }!.options.contains(.destructive))
        let denyOnly = categories.first { $0.identifier == AidenRunAlertCategory.approvalDenyOnly }!
        XCTAssertFalse(denyOnly.actions.contains { $0.identifier == AidenRunAlertCategory.actionApprove })
        let reply = categories.first { $0.identifier == AidenRunAlertCategory.questionReply }!
        XCTAssertTrue(reply.actions.contains { $0 is UNTextInputNotificationAction })
        XCTAssertEqual(categories.count, 4)
    }

    @MainActor
    func testNotificationActionAnswersInPlaceOrOpensTheChat() async {
        let content = make(.needsApproval, .approval(target: .init(approvalID: "ap", runID: nil), summary: "x", canAllow: true))
        let chatURL = AidenDeepLink.chatURL(instanceId: "mac", chatId: "c1")
        let broker = AidenBackgroundActionBroker()
        var ran: [AidenAlertAction] = []
        broker.perform = { action in ran.append(action); return .done }

        let answered = await AidenNotificationPresentationDelegate.respond(
            actionIdentifier: AidenRunAlertCategory.actionDeny, userInfo: content.userInfo, replyText: nil, broker: broker
        )
        XCTAssertNil(answered)
        XCTAssertEqual(ran, [.deny(instanceID: "mac", chatID: "c1", target: .init(approvalID: "ap", runID: nil))])

        broker.perform = { _ in .openApp(nil) }
        let failed = await AidenNotificationPresentationDelegate.respond(
            actionIdentifier: AidenRunAlertCategory.actionDeny, userInfo: content.userInfo, replyText: nil, broker: broker
        )
        XCTAssertEqual(failed?.link, chatURL)
        XCTAssertEqual(failed?.instanceID, "mac")

        broker.perform = { _ in .dropped }
        let forgotten = await AidenNotificationPresentationDelegate.respond(
            actionIdentifier: AidenRunAlertCategory.actionDeny, userInfo: content.userInfo, replyText: nil, broker: broker
        )
        XCTAssertNil(forgotten)

        ran = []
        broker.perform = { action in ran.append(action); return .done }
        let blankReply = await AidenNotificationPresentationDelegate.respond(
            actionIdentifier: AidenRunAlertCategory.actionReply, userInfo: content.userInfo, replyText: " ", broker: broker
        )
        XCTAssertEqual(blankReply?.link, chatURL)
        let tapped = await AidenNotificationPresentationDelegate.respond(
            actionIdentifier: UNNotificationDefaultActionIdentifier, userInfo: content.userInfo, replyText: nil, broker: broker
        )
        XCTAssertEqual(tapped?.link, chatURL)
        let dismissed = await AidenNotificationPresentationDelegate.respond(
            actionIdentifier: UNNotificationDismissActionIdentifier, userInfo: content.userInfo, replyText: nil, broker: broker
        )
        XCTAssertNil(dismissed)
        XCTAssertEqual(ran, [])
    }

    // MARK: Runs summary

    private func row(
        _ chatID: String,
        _ status: AgentRunActivityStatus,
        t: Double = 0,
        final: Bool = false
    ) -> AidenRunsSummaryActivityAttributes.Row {
        AidenRunsSummaryActivityAttributes.Row(
            streamID: "stream-\(chatID)",
            chatID: chatID,
            title: "Chat \(chatID)",
            status: status,
            updatedAt: Date(timeIntervalSince1970: t),
            isFinal: final
        )
    }

    func testSummaryOrdersByUrgencyThenRecency() {
        let rows = [
            row("a", .complete, t: 5, final: true),
            row("b", .runningCommand, t: 4),
            row("c", .waitingForApproval, t: 1),
            row("d", .failed, t: 2, final: true),
            row("e", .thinking, t: 6),
            row("f", .waitingForAnswer, t: 3),
        ]
        XCTAssertEqual(AidenRunsSummaryPolicy.ordered(rows).map(\.chatID), ["f", "c", "d", "e", "b", "a"])
        XCTAssertEqual(AidenRunsSummaryPolicy.tapChatID(rows), "f")
        XCTAssertNil(AidenRunsSummaryPolicy.tapChatID([]))
    }

    func testSummaryHeadlineCountsRunsAndAsks() {
        let rows = [row("a", .waitingForApproval), row("b", .thinking), row("c", .complete, final: true)]
        let headline = AidenRunsSummaryPolicy.headline(rows: rows, machineName: "MacBook Pro")
        XCTAssertEqual(headline.title, "3 runs on MacBook Pro")
        XCTAssertEqual(headline.trailing, "1 needs you")
        let two = AidenRunsSummaryPolicy.headline(
            rows: [row("a", .waitingForApproval), row("b", .waitingForAnswer)],
            machineName: "Mac"
        )
        XCTAssertEqual(two.trailing, "2 need you")
        XCTAssertNil(AidenRunsSummaryPolicy.headline(rows: [row("b", .thinking), row("c", .thinking)], machineName: "Mac").trailing)
    }

    func testSummaryRowStatusUsesPlainWords() {
        XCTAssertEqual(AidenRunsSummaryPolicy.rowStatus(row("a", .waitingForApproval)), "Needs approval")
        XCTAssertEqual(AidenRunsSummaryPolicy.rowStatus(row("a", .waitingForAnswer)), "Has a question")
        XCTAssertEqual(AidenRunsSummaryPolicy.rowStatus(row("a", .runningCommand)), AgentRunActivityStatus.runningCommand.title)
        XCTAssertEqual(AidenRunsSummaryPolicy.rowStatus(row("a", .complete, final: true)), "Done")
        XCTAssertEqual(AidenRunsSummaryPolicy.rowStatus(row("a", .failed, final: true)), "Failed")
        XCTAssertEqual(AidenRunsSummaryPolicy.rowStatus(row("a", .cancelled, final: true)), "Stopped")
    }

    func testSummaryShowsThreeRowsAndCountsTheRest() {
        let rows = (0..<5).map { row("r\($0)", .thinking, t: Double($0)) }
        let visible = AidenRunsSummaryPolicy.visible(rows)
        XCTAssertEqual(visible.shown.map(\.chatID), ["r4", "r3", "r2"])
        XCTAssertEqual(visible.hiddenCount, 2)
        XCTAssertEqual(AidenRunsSummaryPolicy.visible(Array(rows.prefix(2))).hiddenCount, 0)
    }

    /// A summary saved by the build before rows recorded staleness still
    /// reads after an update, with its rows current; a stale row keeps its
    /// flag through a round trip.
    func testASummaryRowFromTheEarlierBuildStillDecodes() throws {
        typealias Row = AidenRunsSummaryActivityAttributes.Row
        let earlier = Data("""
        {"streamID":"s1","chatID":"c1","title":"One","status":"thinking","updatedAt":0,"isFinal":false}
        """.utf8)
        let row = try JSONDecoder().decode(Row.self, from: earlier)
        XCTAssertEqual(row.streamID, "s1")
        XCTAssertFalse(row.isStale)

        let stale = Row(streamID: "s2", chatID: "c2", title: "Two", status: .thinking,
                        updatedAt: Date(timeIntervalSince1970: 0), isFinal: false, isStale: true)
        let decoded = try JSONDecoder().decode(Row.self, from: JSONEncoder().encode(stale))
        XCTAssertTrue(decoded.isStale)
    }

    /// A summary is no more trustworthy than a single card: once the app
    /// stops updating it, it says so until every run has ended.
    func testSummaryNotesStalenessUntilEveryRunEnds() {
        let working = AidenRunsSummaryActivityAttributes.ContentState(rows: [
            row("a", .runningCommand, t: 100),
            row("b", .waitingForApproval, t: 150),
            row("c", .complete, t: 200, final: true),
        ])
        XCTAssertNil(AidenRunsSummaryPolicy.staleNote(working, systemMarkedStale: false))
        XCTAssertEqual(AidenRunsSummaryPolicy.staleNote(working, systemMarkedStale: true), "Latest status shown")
        var marked = working
        marked.isStale = true
        XCTAssertEqual(AidenRunsSummaryPolicy.staleNote(marked, systemMarkedStale: false), "Latest status shown")

        let allDone = AidenRunsSummaryActivityAttributes.ContentState(
            rows: [row("c", .complete, t: 200, final: true)],
            isStale: true
        )
        XCTAssertNil(AidenRunsSummaryPolicy.staleNote(allDone, systemMarkedStale: true))

        // ActivityKit marks it stale once the newest unfinished run has gone
        // as long without news as a single card would.
        XCTAssertEqual(
            AidenRunsSummaryPolicy.staleDate(working),
            Date(timeIntervalSince1970: 150 + AgentRunFreshness.staleAfter)
        )
        XCTAssertNil(AidenRunsSummaryPolicy.staleDate(allDone))
    }

    @MainActor
    func testLeavingTheAppMarksASummaryStaleUntilItsNextUpdate() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let mac = "summary-stale-\(UUID().uuidString)"
        let manager = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        defer { Task { @MainActor in await manager.endAll(forInstanceID: mac) } }
        await manager.start(instanceID: mac, chatID: "c1", title: "One", streamID: "s1", machineName: "Mac")
        await manager.start(instanceID: mac, chatID: "c2", title: "Two", streamID: "s2", machineName: "Mac")
        let summary = try XCTUnwrap(Activity<AidenRunsSummaryActivityAttributes>.activities.first {
            $0.attributes.instanceID == mac
        })

        await manager.markAllStale()
        let stale = await eventually("the summary to be marked stale") { summary.content.state.isStale }
        XCTAssertTrue(stale)

        await manager.updateStatus(instanceID: mac, streamID: "s1", state: .waitingForApproval)
        let fresh = await eventually("the next update to clear it") { !summary.content.state.isStale }
        XCTAssertTrue(fresh)
    }

    /// A chat whose approval read never reached the Mac marks its run stale.
    /// On a summary that reads as old too, until that run's next real update.
    @MainActor
    func testAStaleRunOnASummaryMarksTheSummaryStaleUntilItsNextUpdate() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let mac = "summary-run-stale-\(UUID().uuidString)"
        let manager = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        defer { Task { @MainActor in await manager.endAll(forInstanceID: mac) } }
        await manager.start(instanceID: mac, chatID: "c1", title: "One", streamID: "s1", machineName: "Mac")
        await manager.start(instanceID: mac, chatID: "c2", title: "Two", streamID: "s2", machineName: "Mac")
        let summary = try XCTUnwrap(Activity<AidenRunsSummaryActivityAttributes>.activities.first {
            $0.attributes.instanceID == mac
        })
        await manager.approvalRequired(instanceID: mac, streamID: "s1", target: nil)

        await manager.markStale(instanceID: mac, streamID: "s1")
        let stale = await eventually("the summary to read as old") { summary.content.state.isStale }
        XCTAssertTrue(stale)

        await manager.updateStatus(instanceID: mac, streamID: "s1", state: .waitingForApproval)
        let fresh = await eventually("the run's next update to clear it") { !summary.content.state.isStale }
        XCTAssertTrue(fresh)
    }

    /// After a relaunch the summary still knows which run is stale: another
    /// run's update keeps it reading as old, and only the stale run's own
    /// next update clears it.
    @MainActor
    func testAStaleRunKeepsTheSummaryStaleAcrossARelaunch() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let mac = "summary-relaunch-stale-\(UUID().uuidString)"
        let before = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        defer { Task { @MainActor in await before.endAll(forInstanceID: mac) } }
        await before.start(instanceID: mac, chatID: "c1", title: "One", streamID: "s1", machineName: "Mac")
        await before.start(instanceID: mac, chatID: "c2", title: "Two", streamID: "s2", machineName: "Mac")
        let summary = try XCTUnwrap(Activity<AidenRunsSummaryActivityAttributes>.activities.first {
            $0.attributes.instanceID == mac
        })
        await before.approvalRequired(instanceID: mac, streamID: "s1", target: nil)
        await before.markStale(instanceID: mac, streamID: "s1")
        let stale = await eventually("the summary to read as old") { summary.content.state.isStale }
        XCTAssertTrue(stale)

        let relaunched = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        await relaunched.updateStatus(instanceID: mac, streamID: "s2", state: .waitingForApproval)
        let otherUpdated = await eventually("s2's update to land") {
            summary.content.state.rows.first { $0.streamID == "s2" }?.status == .waitingForApproval
        }
        XCTAssertTrue(otherUpdated)
        XCTAssertTrue(summary.content.state.isStale, "another run's update leaves the stale run's status old")

        await relaunched.updateStatus(instanceID: mac, streamID: "s1", state: .waitingForApproval)
        let fresh = await eventually("the stale run's own update to clear it") { !summary.content.state.isStale }
        XCTAssertTrue(fresh)
    }

    @MainActor
    func testSecondRunOnTheSameMacMergesIntoOneSummaryCard() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let mac = "summary-mac-\(UUID().uuidString)"
        let manager = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        defer { Task { @MainActor in await manager.endAll(forInstanceID: mac) } }
        func summaries() -> [Activity<AidenRunsSummaryActivityAttributes>] {
            Activity<AidenRunsSummaryActivityAttributes>.activities.filter {
                $0.attributes.instanceID == mac && ($0.activityState == .active || $0.activityState == .stale)
            }
        }

        await manager.start(instanceID: mac, chatID: "c1", title: "Fix login", streamID: "s1", machineName: "MacBook Pro")
        let first = try XCTUnwrap(Activity<AgentRunActivityAttributes>.activities.first {
            $0.attributes.instanceID == mac && $0.attributes.streamID == "s1"
        })
        XCTAssertTrue(summaries().isEmpty, "one run keeps its own card")

        await manager.start(instanceID: mac, chatID: "c2", title: "Write docs", streamID: "s2", machineName: "MacBook Pro")
        await assertDeliveredEnd(of: first)
        XCTAssertFalse(Activity<AgentRunActivityAttributes>.activities.contains {
            $0.attributes.instanceID == mac && ($0.activityState == .active || $0.activityState == .stale)
        })
        let summary = try XCTUnwrap(summaries().first)
        XCTAssertEqual(summaries().count, 1)
        XCTAssertEqual(summary.attributes.machineName, "MacBook Pro")
        XCTAssertEqual(Set(summary.content.state.rows.map(\.streamID)), ["s1", "s2"])

        await manager.approvalRequired(instanceID: mac, streamID: "s1", target: nil)
        let waiting = await eventually("s1 to read Needs approval") {
            summary.content.state.rows.first { $0.streamID == "s1" }?.status == .waitingForApproval
        }
        XCTAssertTrue(waiting)

        await manager.finish(instanceID: mac, streamID: "s1", status: .complete, message: "Done")
        XCTAssertEqual(summaries().count, 1, "a summary stays while any run is live")
        await manager.finish(instanceID: mac, streamID: "s2", status: .failed, message: "Failed")
        let ended = await eventually("the summary to end") { summaries().isEmpty }
        XCTAssertTrue(ended)
        XCTAssertEqual(summary.content.state.rows.filter(\.isFinal).count, 2)
    }

    /// A run already on the summary that reattaches (the app comes back, the
    /// stream restores) keeps its row; it doesn't go back to "Starting".
    @MainActor
    func testARunReattachingInsideASummaryKeepsItsRow() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let mac = "summary-reattach-\(UUID().uuidString)"
        let manager = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        defer { Task { @MainActor in await manager.endAll(forInstanceID: mac) } }
        await manager.start(instanceID: mac, chatID: "c1", title: "Fix login", streamID: "s1", machineName: "Mac")
        await manager.start(instanceID: mac, chatID: "c2", title: "Write docs", streamID: "s2", machineName: "Mac")
        let summary = try XCTUnwrap(Activity<AidenRunsSummaryActivityAttributes>.activities.first {
            $0.attributes.instanceID == mac
        })
        await manager.approvalRequired(instanceID: mac, streamID: "s1", target: nil)
        let waiting = await eventually("s1 to read Needs approval") {
            summary.content.state.rows.first { $0.streamID == "s1" }?.status == .waitingForApproval
        }
        XCTAssertTrue(waiting)

        await manager.start(instanceID: mac, chatID: "c1", title: "Fix login", streamID: "s1", machineName: "Mac")
        await manager.toolFinished(instanceID: mac, streamID: "s2")
        let settled = await eventually("the summary to take the later update") {
            summary.content.state.rows.first { $0.streamID == "s2" }?.status == .responding
        }
        XCTAssertTrue(settled)
        XCTAssertEqual(summary.content.state.rows.first { $0.streamID == "s1" }?.status, .waitingForApproval)
        XCTAssertEqual(summary.content.state.rows.count, 2)
    }

    /// Once a Reply lands, the card stops saying the run has a question.
    @MainActor
    func testAReplyThatLandsTakesTheQuestionOffTheCard() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let mac = "reply-\(UUID().uuidString)"
        let manager = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        defer { Task { @MainActor in await manager.endAll(forInstanceID: mac) } }
        await manager.start(instanceID: mac, chatID: "c1", title: "Fix login", streamID: "s1")
        await manager.questionRequired(instanceID: mac, streamID: "s1")
        let activity = try XCTUnwrap(Activity<AgentRunActivityAttributes>.activities.first {
            $0.attributes.instanceID == mac && $0.attributes.streamID == "s1"
        })
        let asking = await deliveredContent(of: activity, expecting: "the question", where: { $0.status == .waitingForAnswer })
        XCTAssertNotNil(asking)

        let perform = AidenBackgroundActionBroker.perform(lookup: { _ in .client(FakeAlertTransport()) }, liveActivities: manager)
        let outcome = await perform(.reply(instanceID: mac, chatID: "c1", promptID: "q1", runID: nil, text: "Yes"))
        XCTAssertEqual(outcome, .done)
        let shown = await deliveredContent(of: activity, expecting: "the answered state", where: { $0.status != .waitingForAnswer })
        XCTAssertEqual(shown?.currentActivity, "Answered")
    }

    /// A Reply can launch a fresh app process that knows nothing of the
    /// summary yet; the summary row still stops asking.
    @MainActor
    func testAReplyFromAFreshLaunchTakesTheQuestionOffTheSummary() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let mac = "reply-relaunch-\(UUID().uuidString)"
        let before = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        defer { Task { @MainActor in await before.endAll(forInstanceID: mac) } }
        await before.start(instanceID: mac, chatID: "c1", title: "Fix login", streamID: "s1", machineName: "Mac")
        await before.start(instanceID: mac, chatID: "c2", title: "Write docs", streamID: "s2", machineName: "Mac")
        let summary = try XCTUnwrap(Activity<AidenRunsSummaryActivityAttributes>.activities.first {
            $0.attributes.instanceID == mac
        })
        await before.questionRequired(instanceID: mac, streamID: "s1")
        let asking = await eventually("s1 to ask") {
            summary.content.state.rows.first { $0.streamID == "s1" }?.status == .waitingForAnswer
        }
        XCTAssertTrue(asking)

        let relaunched = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        let perform = AidenBackgroundActionBroker.perform(lookup: { _ in .client(FakeAlertTransport()) }, liveActivities: relaunched)
        let outcome = await perform(.reply(instanceID: mac, chatID: "c1", promptID: "q1", runID: nil, text: "Yes"))
        XCTAssertEqual(outcome, .done)
        let answered = await eventually("s1 to stop asking") {
            summary.content.state.rows.first { $0.streamID == "s1" }?.status != .waitingForAnswer
        }
        XCTAssertTrue(answered)
        XCTAssertEqual(summary.content.state.rows.count, 2)
    }

    @MainActor
    func testRunsOnDifferentMacsNeverMergeIntoOneSummary() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let macA = "summary-a-\(UUID().uuidString)"
        let macB = "summary-b-\(UUID().uuidString)"
        let manager = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        await manager.start(instanceID: macA, chatID: "c1", title: "One", streamID: "s1", machineName: "Mac A")
        await manager.start(instanceID: macB, chatID: "c2", title: "Two", streamID: "s2", machineName: "Mac B")
        let runs = Activity<AgentRunActivityAttributes>.activities.filter {
            ($0.attributes.instanceID == macA || $0.attributes.instanceID == macB) && $0.activityState == .active
        }
        XCTAssertEqual(runs.count, 2)
        XCTAssertFalse(Activity<AidenRunsSummaryActivityAttributes>.activities.contains {
            $0.attributes.instanceID == macA || $0.attributes.instanceID == macB
        })
        await manager.endAll(forInstanceID: macA)
        await manager.endAll(forInstanceID: macB)
    }

    /// A run that finishes while its card is being merged into the summary
    /// still counts as finished, so the summary ends once every run has.
    @MainActor
    func testARunFinishingDuringTheMergeStillEndsTheSummary() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let mac = "summary-race-\(UUID().uuidString)"
        let manager = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        defer { Task { @MainActor in await manager.endAll(forInstanceID: mac) } }
        await manager.start(instanceID: mac, chatID: "c1", title: "One", streamID: "s1", machineName: "Mac")

        // The finish runs while the merge waits on ActivityKit.
        let merge = Task { @MainActor in
            await manager.start(instanceID: mac, chatID: "c2", title: "Two", streamID: "s2", machineName: "Mac")
        }
        let finishFirst = Task { @MainActor in
            await manager.finish(instanceID: mac, streamID: "s1", status: .complete, message: "Done")
        }
        await merge.value
        await finishFirst.value
        let summary = try XCTUnwrap(Activity<AidenRunsSummaryActivityAttributes>.activities.first {
            $0.attributes.instanceID == mac
        })
        await manager.finish(instanceID: mac, streamID: "s2", status: .complete, message: "Done")

        let ended = await eventually("the summary to end once both runs finished") {
            summary.activityState == .ended || summary.activityState == .dismissed
        }
        XCTAssertTrue(ended)
    }

    @MainActor
    func testEndAllEndsAMacsSummaryToo() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let mac = "summary-forget-\(UUID().uuidString)"
        let manager = AidenRemoteLiveActivityManager(preferences: { AidenNotificationPreferences() })
        await manager.start(instanceID: mac, chatID: "c1", title: "One", streamID: "s1", machineName: "Mac")
        await manager.start(instanceID: mac, chatID: "c2", title: "Two", streamID: "s2", machineName: "Mac")
        let summary = try XCTUnwrap(Activity<AidenRunsSummaryActivityAttributes>.activities.first {
            $0.attributes.instanceID == mac
        })
        await manager.endAll(forInstanceID: mac)
        let ended = await eventually("the summary to end") {
            summary.activityState == .ended || summary.activityState == .dismissed
        }
        XCTAssertTrue(ended)
    }

    // MARK: Background grace

    @MainActor
    func testGraceBeginsOnlyWithLiveRunsAndEndsWhenTheyFinish() {
        let host = FakeBackgroundTaskHost()
        let grace = AidenBackgroundGrace(host: host)
        grace.appDidEnterBackground(hasLiveRuns: false)
        XCTAssertEqual(host.begun, 0)
        grace.appDidEnterBackground(hasLiveRuns: true)
        XCTAssertEqual(host.begun, 1)
        grace.appDidEnterBackground(hasLiveRuns: true)
        XCTAssertEqual(host.begun, 1, "never two tasks")
        grace.liveRunsDidChange(hasLiveRuns: false)
        XCTAssertEqual(host.ended, 1)
    }

    @MainActor
    func testGraceEndsExactlyOnceOnExpirationOrForeground() {
        let host = FakeBackgroundTaskHost()
        let grace = AidenBackgroundGrace(host: host)
        grace.appDidEnterBackground(hasLiveRuns: true)
        host.expire()
        grace.appWillEnterForeground()
        grace.liveRunsDidChange(hasLiveRuns: false)
        XCTAssertEqual(host.ended, 1)
    }

    /// The grace is for alerts too, so it counts runs even when Live
    /// Activities are off; a run merged into a Mac's summary still counts.
    @MainActor
    func testLiveRunsCountStartedRunsUntilEachFinishes() async {
        let manager = AidenRemoteLiveActivityManager(
            drivesActivityKit: false,
            preferences: { AidenNotificationPreferences() }
        )
        var changes: [Bool] = []
        manager.onLiveRunsChange = { changes.append($0) }
        XCTAssertFalse(manager.hasLiveRuns)

        await manager.start(instanceID: "mac", chatID: "c1", title: "One", streamID: "s1")
        await manager.start(instanceID: "mac", chatID: "c2", title: "Two", streamID: "s2")
        XCTAssertTrue(manager.hasLiveRuns)
        await manager.finish(instanceID: "mac", streamID: "s1", status: .complete, message: "Done")
        XCTAssertTrue(manager.hasLiveRuns, "one run is still going")
        await manager.updateStatus(instanceID: "mac", streamID: "s2", state: .done)
        XCTAssertFalse(manager.hasLiveRuns)

        await manager.start(instanceID: "other", chatID: "c3", title: "Three", streamID: "s3")
        await manager.endAll(forInstanceID: "other")
        XCTAssertFalse(manager.hasLiveRuns, "forgetting a Mac ends its runs")
        XCTAssertEqual(changes, [true, false, true, false], "one call per change, never a repeat")
    }


    @MainActor
    private func eventually(
        _ what: String,
        ceiling: TimeInterval = 30,
        _ check: () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(ceiling)
        while Date() < deadline {
            if check() { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("Timed out waiting for \(what)")
        return false
    }

    // MARK: Notification preferences

    func testPreferencesDefaultAndRoundTrip() throws {
        let suiteName = "AidenNativeIntegrationTests.\(UUID().uuidString)"
        let suite = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { suite.removePersistentDomain(forName: suiteName) }
        var prefs = AidenNotificationPreferences.load(from: suite)
        XCTAssertTrue(prefs.needsAnswer)
        XCTAssertTrue(prefs.responseReady)
        XCTAssertTrue(prefs.runFailed)
        XCTAssertTrue(prefs.botNeedsMe)
        XCTAssertTrue(prefs.showMessageText)
        XCTAssertFalse(prefs.replyTextOnLockScreen)
        XCTAssertTrue(prefs.quietInOpenChat)
        prefs.responseReady = false
        prefs.replyTextOnLockScreen = true
        prefs.save(to: suite)
        let loaded = AidenNotificationPreferences.load(from: suite)
        XCTAssertFalse(loaded.responseReady)
        XCTAssertTrue(loaded.replyTextOnLockScreen)
        XCTAssertTrue(loaded.runFailed)

        suite.set(Data("not json".utf8), forKey: AidenNotificationPreferences.defaultsKey)
        XCTAssertEqual(AidenNotificationPreferences.load(from: suite), AidenNotificationPreferences())
    }

    func testPreferencesGateEachAlertKind() {
        func posts(_ kind: AidenRunAlertKind, _ prefs: AidenNotificationPreferences) -> Bool {
            AidenRunAlertPolicy.shouldPost(
                kind: kind, appState: .background, isChatOnScreen: false,
                alreadyAlerted: false, isAuthorized: true, preferences: prefs
            )
        }
        var prefs = AidenNotificationPreferences()
        prefs.needsAnswer = false
        XCTAssertFalse(posts(.needsApproval, prefs))
        XCTAssertFalse(posts(.needsAnswer, prefs))
        XCTAssertTrue(posts(.completed, prefs))
        XCTAssertTrue(posts(.failed, prefs))
        prefs = AidenNotificationPreferences()
        prefs.responseReady = false
        XCTAssertFalse(posts(.completed, prefs))
        XCTAssertTrue(posts(.failed, prefs))
        prefs = AidenNotificationPreferences()
        prefs.runFailed = false
        XCTAssertFalse(posts(.failed, prefs))
        XCTAssertTrue(posts(.needsApproval, prefs))
    }

    func testQuietInOpenChatOffAlertsForTheChatOnScreenWhileInactive() {
        var prefs = AidenNotificationPreferences()
        XCTAssertFalse(AidenRunAlertPolicy.shouldPost(
            kind: .completed, appState: .inactive, isChatOnScreen: true,
            alreadyAlerted: false, isAuthorized: true, preferences: prefs
        ))
        prefs.quietInOpenChat = false
        XCTAssertTrue(AidenRunAlertPolicy.shouldPost(
            kind: .completed, appState: .inactive, isChatOnScreen: true,
            alreadyAlerted: false, isAuthorized: true, preferences: prefs
        ))
        XCTAssertFalse(AidenRunAlertPolicy.shouldPost(
            kind: .completed, appState: .active, isChatOnScreen: true,
            alreadyAlerted: false, isAuthorized: true, preferences: prefs
        ))
    }

    func testDeniedPermissionBlocksEveryKindAndShowsOpenSettings() {
        for kind in [AidenRunAlertKind.needsApproval, .needsAnswer, .completed, .failed] {
            XCTAssertFalse(AidenRunAlertPolicy.shouldPost(
                kind: kind, appState: .background, isChatOnScreen: false,
                alreadyAlerted: false, isAuthorized: false, preferences: .init()
            ))
        }
        XCTAssertEqual(AidenNotificationPermissionRow.state(for: .denied), .off(canAsk: false))
        XCTAssertEqual(AidenNotificationPermissionRow.state(for: .notDetermined), .off(canAsk: true))
        XCTAssertEqual(AidenNotificationPermissionRow.state(for: .authorized), .on)
        XCTAssertEqual(AidenNotificationPermissionRow.state(for: .provisional), .on)
    }

    @MainActor
    func testReplyTextStaysOffTheLockScreenUnlessTurnedOn() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        func finalExcerpt(replyTextOnLockScreen: Bool) async -> String? {
            var prefs = AidenNotificationPreferences()
            prefs.replyTextOnLockScreen = replyTextOnLockScreen
            let id = "reply-text-\(UUID().uuidString)"
            let manager = AidenRemoteLiveActivityManager(preferences: { prefs })
            await manager.start(instanceID: id, chatID: id, title: "Fix flaky login test", streamID: id)
            guard let activity = Activity<AgentRunActivityAttributes>.activities.first(where: {
                $0.attributes.instanceID == id && $0.attributes.streamID == id
            }) else {
                XCTFail("ActivityKit did not create the requested Aiden Live Activity.")
                return nil
            }
            await manager.appendResponse("All 12 tests pass.", instanceID: id, streamID: id)
            await manager.finish(instanceID: id, streamID: id, status: .complete, message: "Done")
            let final = await deliveredContent(of: activity, expecting: "the final state", where: { $0.isFinal })
            await manager.endAll(forInstanceID: id)
            return final?.responseExcerpt
        }

        let hidden = await finalExcerpt(replyTextOnLockScreen: false)
        XCTAssertEqual(hidden, "")
        XCTAssertNil(AgentRunTextPresentation.make(
            state: liveState(status: .complete, excerpt: hidden ?? "", isFinal: true),
            systemMarkedStale: false
        ).detail)
        let shown = await finalExcerpt(replyTextOnLockScreen: true)
        XCTAssertEqual(shown, "All 12 tests pass.")
    }

    private func make(
        _ kind: AidenRunAlertKind,
        _ detail: AidenRunAlertDetail?,
        showMessageText: Bool = true
    ) -> UNMutableNotificationContent {
        AidenRunAlertContent.make(
            kind: kind,
            detail: detail,
            instanceID: "mac",
            chatID: "c1",
            chatTitle: "Fix flaky login test",
            deepLink: AidenDeepLink.chatURL(instanceId: "mac", chatId: "c1")!,
            showMessageText: showMessageText
        )
    }

    private func approvalBase() -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityStateReducer.initialState(
            sessionID: "chat-1",
            sessionTitle: "Chat",
            startedAt: Date(timeIntervalSince1970: 1_000)
        )
    }

    private func alertServerError(
        _ status: Int,
        code: String,
        details: [String: Any]? = nil
    ) throws -> AidenRemoteClientError {
        var envelope: [String: Any] = [
            "code": code, "message": "Refused", "requestId": "request-1", "retryable": false,
        ]
        if let details { envelope["details"] = details }
        let body = try JSONDecoder().decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: JSONSerialization.data(withJSONObject: envelope)
        )
        return .server(statusCode: status, body: body)
    }

    private func liveState(
        status: AgentRunActivityStatus,
        activity: String = "Working",
        excerpt: String = "",
        error: String? = nil,
        startedAt: Date = Date(timeIntervalSince1970: 1_000),
        updatedAt: Date = Date(timeIntervalSince1970: 1_005),
        isFinal: Bool = false
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: "chat-1",
            sessionTitle: "Fix the flaky test",
            status: status,
            currentActivity: activity,
            responseExcerpt: excerpt,
            startedAt: startedAt,
            updatedAt: updatedAt,
            isFinal: isFinal,
            errorSummary: error
        )
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

        await assertDeliveredEnd(of: activity)
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
        await assertDeliveredEnd(of: activity)
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
            await assertDeliveredEnd(of: activity)
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
            "Try again from Aiden Agent → Settings → Connections."
        )
    }

    func testPairingInputParserNormalizesEndpointsRejectsHTTPAndDetectsPayloads() {
        XCTAssertEqual(
            AidenPairingInputParser.normalizedEndpointURL(from: "sambits-mbp.local:49220")?.absoluteString,
            "https://sambits-mbp.local:49220/api/aiden/v1"
        )
        XCTAssertEqual(
            AidenPairingInputParser.normalizedEndpointURL(from: "mac.tailnet.ts.net")?.absoluteString,
            "https://mac.tailnet.ts.net/api/aiden/v1"
        )
        XCTAssertEqual(
            AidenPairingInputParser.normalizedEndpointURL(from: "https://mac.tailnet.ts.net/")?.absoluteString,
            "https://mac.tailnet.ts.net/api/aiden/v1"
        )
        XCTAssertEqual(
            AidenPairingInputParser.normalizedEndpointURL(from: "https://mac.local:49220/api/aiden/v1")?.absoluteString,
            "https://mac.local:49220/api/aiden/v1"
        )
        XCTAssertNil(AidenPairingInputParser.normalizedEndpointURL(from: "http://mac.local:49220/api/aiden/v1"))
        XCTAssertNil(AidenPairingInputParser.normalizedEndpointURL(from: "   "))
        XCTAssertEqual(
            AidenPairingInputParser.compactDisplayAddress("https://mac.local:49220/api/aiden/v1"),
            "mac.local:49220"
        )
    }

    func testPairingInputParserFormatsManualCodeAndResolvesSubmissions() {
        XCTAssertEqual(
            AidenPairingInputParser.formattedManualCodeInput("k7m29p4xv8q34r1nt6b8"),
            "K7M2-9P4X-V8Q3-4R1N-T6B8"
        )
        let jsonPayload = "{\"kind\":\"aiden-pairing\"}"
        XCTAssertEqual(
            AidenPairingInputParser.formattedManualCodeInput(jsonPayload),
            jsonPayload,
            "Pasted JSON pairing payloads must not be rewritten as setup codes"
        )

        let manual = AidenPairingInputParser.submission(
            address: "mac.local:49220",
            code: "K7M2-9P4X-V8Q3-4R1N-T6B8"
        )
        XCTAssertEqual(
            manual,
            .success(.manual(
                endpoint: URL(string: "https://mac.local:49220/api/aiden/v1")!,
                code: "K7M2-9P4X-V8Q3-4R1N-T6B8"
            ))
        )
        XCTAssertEqual(
            AidenPairingInputParser.submission(address: "", code: jsonPayload),
            .success(.payload(jsonPayload))
        )
        XCTAssertEqual(
            AidenPairingInputParser.submission(address: jsonPayload, code: ""),
            .success(.payload(jsonPayload))
        )
    }

    func testManualPairingReportsWhatNeedsCorrectingBeforeNetworking() {
        let validCode = "K7M2-9P4X-V8Q3-4R1N-T6B8"
        XCTAssertEqual(
            AidenPairingInputParser.submission(address: " HTTP://mac.local:49220 ", code: validCode),
            .failure(.insecureAddress)
        )
        XCTAssertEqual(
            AidenPairingInputParser.submission(address: "mac.local:not-a-port", code: validCode),
            .failure(.invalidAddress)
        )
        XCTAssertEqual(AidenPairingInputParser.submission(address: "", code: validCode), .failure(.missingAddress))
        XCTAssertEqual(AidenPairingInputParser.submission(address: "mac.local", code: ""), .failure(.missingCode))
        XCTAssertEqual(AidenPairingInputParser.submission(address: "mac.local", code: "SHORT"), .failure(.invalidCode))
    }

    @MainActor
    func testPairingScanWindowRejectsCodesOutsideTheVisibleCutout() {
        let portrait = CGRect(x: 0, y: 0, width: 360, height: 244)
        let wider = CGRect(x: 0, y: 0, width: 560, height: 244)
        XCTAssertTrue(AidenPairingScanWindow.containsCode(center: CGPoint(x: 180, y: 105), in: portrait))
        XCTAssertFalse(AidenPairingScanWindow.containsCode(center: CGPoint(x: 280, y: 105), in: portrait))
        XCTAssertFalse(AidenPairingScanWindow.containsCode(center: CGPoint(x: 180, y: 195), in: portrait))
        XCTAssertFalse(AidenPairingScanWindow.containsCode(center: CGPoint(x: 110, y: 36), in: portrait))
        XCTAssertTrue(AidenPairingScanWindow.containsCode(center: CGPoint(x: 280, y: 105), in: wider))
        XCTAssertFalse(AidenPairingScanWindow.containsCode(center: CGPoint(x: 180, y: 105), in: wider))
    }

    func testDesktopDownloadLinksPointToWebsiteForMacAndGitHubForLinuxAndServer() {
        XCTAssertEqual(AidenDesktopDownloadLinks.macURL.absoluteString, "https://chatwithaiden.com/")
        XCTAssertEqual(AidenDesktopDownloadLinks.linuxURL.absoluteString, "https://github.com/sambitcreate/aiden-agent")
        XCTAssertEqual(AidenDesktopDownloadLinks.serverURL.absoluteString, "https://github.com/sambitcreate/aiden-agent")
    }

    func testVoiceInputModeDefaultsAndLabelsRemainStable() {
        XCTAssertEqual(AidenVoiceInputMode.defaultsKey, "aiden.voiceInput.mode")
        XCTAssertEqual(AidenVoiceInputMode.allCases, [.onDevice, .pairedMac])
        XCTAssertEqual(AidenVoiceInputMode.onDevice.title, "On this device")
        XCTAssertEqual(AidenVoiceInputMode.pairedMac.title, "Paired computer")
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

    func testWaitingStatusDistinguishesApprovalFromAnswerFromPendingPrompts() {
        XCTAssertEqual(
            AgentRunBlockingStatus.status(hasPendingApproval: false, hasPendingQuestion: true),
            .waitingForAnswer
        )
        XCTAssertEqual(
            AgentRunBlockingStatus.status(hasPendingApproval: true, hasPendingQuestion: false),
            .waitingForApproval
        )
        // The approval gates the tool call, so it wins when both are pending.
        XCTAssertEqual(
            AgentRunBlockingStatus.status(hasPendingApproval: true, hasPendingQuestion: true),
            .waitingForApproval
        )

        let start = Date(timeIntervalSince1970: 1_000)
        let running = AgentRunActivityStateReducer.toolStarted(
            name: "bash",
            state: AgentRunActivityStateReducer.initialState(sessionID: "chat-1", sessionTitle: "Chat", startedAt: start),
            now: start + 1
        )
        let answer = AgentRunActivityStateReducer.waitingForAnswer(state: running, now: start + 2)
        let approval = AgentRunActivityStateReducer.waitingForApproval(state: running, now: start + 2)
        XCTAssertEqual(answer.status, .waitingForAnswer)
        XCTAssertEqual(answer.currentActivity, "Needs your answer")
        XCTAssertEqual(approval.status, .waitingForApproval)
        XCTAssertEqual(approval.currentActivity, "Needs your approval")
        XCTAssertNotEqual(answer.status.title, approval.status.title)
        XCTAssertEqual(answer.toolCallCount, 1)
        XCTAssertTrue(answer.status.isAwaitingUser)
        XCTAssertTrue(approval.status.isAwaitingUser)
        XCTAssertFalse(running.status.isAwaitingUser)
    }

    func testServerWaitingSnapshotAndStaleMarkingKeepAQuestionWait() {
        let start = Date(timeIntervalSince1970: 1_000)
        let initial = AgentRunActivityStateReducer.initialState(sessionID: "chat-1", sessionTitle: "Chat", startedAt: start)
        let answer = AgentRunActivityStateReducer.waitingForAnswer(state: initial, now: start + 3)

        // A reconcile reports only `waiting_for_approval`; it must not flip a
        // known question back to approval or claim new progress.
        let refreshed = AgentRunActivityStateReducer.refreshedWaiting(state: answer)
        XCTAssertEqual(refreshed.status, .waitingForAnswer)
        XCTAssertEqual(refreshed.currentActivity, "Needs your answer")
        XCTAssertEqual(refreshed.updatedAt, start + 3)

        // Without a known question, the snapshot reads as an approval wait.
        let refreshedRunning = AgentRunActivityStateReducer.refreshedWaiting(state: initial)
        XCTAssertEqual(refreshedRunning.status, .waitingForApproval)
        XCTAssertEqual(refreshedRunning.currentActivity, "Needs your approval")

        let stale = AgentRunActivityStateReducer.stale(state: answer)
        XCTAssertTrue(stale.isStale)
        XCTAssertEqual(stale.status, .waitingForAnswer)
        XCTAssertEqual(stale.currentActivity, "Needs your answer")
        XCTAssertTrue(stale.status.isAwaitingUser)
    }

    func testQuestionWaitRoundTripsAndOlderApprovalStateStillDecodes() throws {
        let start = Date(timeIntervalSince1970: 1_000)
        let answer = AgentRunActivityStateReducer.waitingForAnswer(
            state: AgentRunActivityStateReducer.initialState(sessionID: "chat-1", sessionTitle: "Chat", startedAt: start),
            now: start + 1
        )
        let roundTripped = try JSONDecoder().decode(
            AgentRunActivityAttributes.ContentState.self,
            from: JSONEncoder().encode(answer)
        )
        XCTAssertEqual(roundTripped, answer)

        // State persisted by a build that predates the question status.
        let legacy = Data("""
        {"sessionID":"chat-1","sessionTitle":"Chat","status":"waitingForApproval",
         "currentActivity":"Waiting for approval","responseExcerpt":"","startedAt":0,
         "updatedAt":12,"isStale":false,"isFinal":false}
        """.utf8)
        let decoded = try JSONDecoder().decode(AgentRunActivityAttributes.ContentState.self, from: legacy)
        XCTAssertEqual(decoded.status, .waitingForApproval)
        XCTAssertEqual(AgentRunActivityStateReducer.refreshedWaiting(state: decoded).status, .waitingForApproval)
    }

#if DEBUG
    // MARK: Routing by machine

    func testTwoMachinesWithTheSameScheduleIDPostTwoNotifications() async throws {
        let defaults = AidenDemoHosts.isolatedDefaults()
        let center = AidenNotificationCenterFake()
        let notifier = AidenScheduledRunNotifier(defaults: defaults, center: center)
        let run = scheduledRun(id: "run-1")

        for instanceId in ["studio", "laptop"] {
            // The first poll only sets a baseline, so the run comes on the second.
            await notifier.deliver(instanceId: instanceId, client: AidenScheduledFeedFake(notifications: []))
            await notifier.deliver(instanceId: instanceId, client: AidenScheduledFeedFake(notifications: [run]))
        }

        XCTAssertEqual(
            center.posted.map(\.identifier),
            ["aiden.schedule.studio.run-1", "aiden.schedule.laptop.run-1"]
        )
    }

    func testTwoMachinesWithTheSameRoutineRunIDPostTwoNotifications() throws {
        let item = try botRoutineNotification(id: "run-1")

        XCTAssertEqual(
            ["studio", "laptop"].map { AidenBotRoutineNotifier.request(for: item, instanceId: $0).identifier },
            ["aiden.bot-routine.studio.run-1", "aiden.bot-routine.laptop.run-1"]
        )
    }

    func testOldIdentifiersAreCancelledOnce() async throws {
        let defaults = AidenDemoHosts.isolatedDefaults()
        let center = AidenNotificationCenterFake()
        let notifier = AidenScheduledRunNotifier(defaults: defaults, center: center)
        await notifier.deliver(instanceId: "studio", client: AidenScheduledFeedFake(notifications: []))
        await notifier.deliver(
            instanceId: "studio",
            client: AidenScheduledFeedFake(notifications: [scheduledRun(id: "new-run")])
        )
        let oldBotContent = UNMutableNotificationContent()
        oldBotContent.userInfo = [AidenRunAlertNotifier.deepLinkUserInfoKey: "aiden-otg://bot/bot_1/chat?instance=studio"]
        center.posted += [
            UNNotificationRequest(identifier: "aiden.schedule.old-run", content: UNNotificationContent(), trigger: nil),
            // An old server's run ID can look just like a machine and a run.
            UNNotificationRequest(identifier: "aiden.schedule.studio.old-run", content: UNNotificationContent(), trigger: nil),
            UNNotificationRequest(identifier: "aiden.bot-routine.old-run", content: oldBotContent, trigger: nil),
            AidenBotRoutineNotifier.request(for: try botRoutineNotification(id: "new-run"), instanceId: "studio"),
            UNNotificationRequest(identifier: "aiden.run.completed.studio.s1", content: UNNotificationContent(), trigger: nil),
        ]
        let kept = ["aiden.schedule.studio.new-run", "aiden.bot-routine.studio.new-run", "aiden.run.completed.studio.s1"]

        await AidenNotificationIdentifierMigration.runOnce(center: center, defaults: defaults)

        XCTAssertEqual(center.posted.map(\.identifier), kept)
        XCTAssertEqual(center.removalPasses, 1)

        // A relaunch reads the same saved flag, and nothing is looked at again.
        center.posted.append(
            UNNotificationRequest(identifier: "aiden.schedule.unmarked", content: UNNotificationContent(), trigger: nil)
        )
        await AidenNotificationIdentifierMigration.runOnce(center: center, defaults: defaults)

        XCTAssertEqual(center.posted.map(\.identifier), kept + ["aiden.schedule.unmarked"])
        XCTAssertEqual(center.removalPasses, 1)
    }

    func testTheIdentifierMigrationFinishesOnlyOnceNothingOldRemains() async throws {
        let defaults = AidenDemoHosts.isolatedDefaults()
        let center = AidenNotificationCenterFake()
        center.posted = [
            UNNotificationRequest(identifier: "aiden.schedule.old-run", content: UNNotificationContent(), trigger: nil),
        ]
        center.ignoresRemovals = true

        await AidenNotificationIdentifierMigration.runOnce(center: center, defaults: defaults)

        XCTAssertEqual(center.posted.map(\.identifier), ["aiden.schedule.old-run"])
        XCTAssertFalse(defaults.bool(forKey: AidenNotificationIdentifierMigration.completedKey))

        // The next launch still finds it, and tries again.
        center.ignoresRemovals = false
        await AidenNotificationIdentifierMigration.runOnce(center: center, defaults: defaults)

        XCTAssertEqual(center.posted, [])
        XCTAssertTrue(defaults.bool(forKey: AidenNotificationIdentifierMigration.completedKey))
    }

    func testAnInstanceIDHoldingADotOrPercentKeepsItsNotificationsApart() async throws {
        let defaults = AidenDemoHosts.isolatedDefaults()
        let center = AidenNotificationCenterFake()
        let notifier = AidenScheduledRunNotifier(defaults: defaults, center: center)
        let pairs = [["a.b", "c"], ["a", "b.c"], ["a%2Eb", "c"], ["a%b", "c.d"], ["a.b.c", "d.e"]]

        for pair in pairs {
            await notifier.deliver(instanceId: pair[0], client: AidenScheduledFeedFake(notifications: []))
            await notifier.deliver(
                instanceId: pair[0],
                client: AidenScheduledFeedFake(notifications: [scheduledRun(id: pair[1])])
            )
        }
        let schedules = center.posted.map(\.identifier)
        let routines = try pairs.map {
            AidenBotRoutineNotifier.request(for: try botRoutineNotification(id: $0[1]), instanceId: $0[0]).identifier
        }

        XCTAssertEqual(Set(schedules).count, pairs.count)
        XCTAssertEqual(Set(routines).count, pairs.count)
        XCTAssertEqual(try schedules.map { try machineAndRun(in: $0, after: "aiden.schedule.") }, pairs)
        XCTAssertEqual(try routines.map { try machineAndRun(in: $0, after: "aiden.bot-routine.") }, pairs)
    }

    @MainActor
    func testReconcileReachesEveryConnectedMachineAndNoOther() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        coordinator.hosts.connection(for: "mini")?.markRevoked()
        let manager = AidenRemoteLiveActivityManager(defaults: AidenDemoHosts.isolatedDefaults(), drivesActivityKit: false)

        // Build Box is offline, and Home Mini was revoked.
        XCTAssertEqual(manager.reconcileTargets(of: coordinator).map(\.instanceId), ["studio", "laptop"])
    }

    @MainActor
    func testReconcileKeepsActivitiesForNonDefaultMachines() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        let stream = "reconcile-\(UUID().uuidString)"
        responder.reply(instanceId: "laptop", path: "/streams/\(stream)", status: 200, json: Data("""
        {"streamId":"\(stream)","chatId":"chat_laptop_1","turnId":"turn-1",
        "state":"running","lastSequence":3,"updatedAt":"2026-08-19T19:00:00.000Z"}
        """.utf8))
        let manager = AidenRemoteLiveActivityManager(defaults: AidenDemoHosts.isolatedDefaults())
        await manager.start(instanceID: "laptop", chatID: "chat_laptop_1", title: "Laptop chat", streamID: stream)
        guard let activity = Activity<AgentRunActivityAttributes>.activities.first(where: {
            $0.attributes.streamID == stream
        }) else {
            return XCTFail("ActivityKit did not start the activity.")
        }
        await manager.markStale(instanceID: "laptop", streamID: stream)
        _ = await deliveredContent(of: activity, expecting: "the stale state", where: { $0.isStale })

        await manager.reconcileConnectedMachines(of: coordinator)

        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
        XCTAssertTrue(responder.requests(instanceId: "laptop").contains("GET /streams/\(stream)"))
        XCTAssertFalse(responder.requests(instanceId: "studio").contains("GET /streams/\(stream)"))
        let reconciled = await deliveredContent(of: activity, expecting: "a live state", where: { !$0.isStale })
        XCTAssertEqual(reconciled?.status, .responding)
        await manager.endAll(forInstanceID: "laptop")
        await assertDeliveredEnd(of: activity)
    }

    @MainActor
    func testReconcileEndsAnActivityFromAnOlderPairing() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this device.")
        }
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        let stream = "older-pairing-\(UUID().uuidString)"
        let manager = AidenRemoteLiveActivityManager(defaults: AidenDemoHosts.isolatedDefaults())
        await manager.start(instanceID: "laptop", deviceID: "older-device", chatID: "c", title: "Chat", streamID: stream)
        guard let activity = Activity<AgentRunActivityAttributes>.activities.first(where: {
            $0.attributes.streamID == stream
        }) else {
            return XCTFail("ActivityKit did not start the activity.")
        }
        XCTAssertEqual(activity.attributes.deviceID, "older-device")

        await manager.reconcileConnectedMachines(of: coordinator)

        XCTAssertFalse(responder.requests(instanceId: "laptop").contains("GET /streams/\(stream)"))
        await assertDeliveredEnd(of: activity)
    }

    func testLiveActivityAttributesFromAnOlderBuildStillDecode() throws {
        let older = Data("""
        {"instanceID":"studio","sessionID":"chat-1","sessionTitle":"Chat","streamID":"stream-1","startedAt":0}
        """.utf8)
        let decoded = try JSONDecoder().decode(AgentRunActivityAttributes.self, from: older)
        XCTAssertEqual(decoded.instanceID, "studio")
        XCTAssertEqual(decoded.streamID, "stream-1")
        XCTAssertNil(decoded.deviceID)

        let current = AgentRunActivityAttributes(
            instanceID: "studio",
            deviceID: "device-1",
            sessionID: "chat-1",
            sessionTitle: "Chat",
            streamID: "stream-1",
            startedAt: Date(timeIntervalSinceReferenceDate: 0)
        )
        let encoded = try JSONEncoder().encode(current)
        XCTAssertEqual(try JSONDecoder().decode(AgentRunActivityAttributes.self, from: encoded).deviceID, "device-1")

        // A widget process still on the older build reads what this one writes.
        struct OlderAttributes: Decodable {
            let instanceID: String
            let sessionID: String
            let sessionTitle: String
            let streamID: String?
            let startedAt: Date
        }
        XCTAssertEqual(try JSONDecoder().decode(OlderAttributes.self, from: encoded).instanceID, "studio")
    }

    @MainActor
    func testANotificationTapOpensItsOwnMachine() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
        let device = try XCTUnwrap(coordinator.hosts.connection(for: "laptop")).installation.deviceId
        let intents = AidenForegroundIntentRouter()
        let taps = try await taps(from: "laptop")

        for tap in taps {
            tap.open(coordinator: coordinator, intents: intents)
        }
        let navigation = AidenAppNavigation()
        for queued in intents.takeRoutes(openableOn: coordinator) {
            navigation.open(queued.route, startsVoice: queued.startsVoice)
        }

        XCTAssertEqual(navigation.inboxPath, [
            .chat(AidenHostObjectID(instanceId: "laptop", deviceId: device, objectId: "chat_laptop_1")),
            .machine(instanceId: "laptop"),
        ])
        XCTAssertEqual(navigation.botsPath, [
            .bot(AidenHostObjectID(instanceId: "laptop", deviceId: device, objectId: "bot_fixture_01")),
        ])
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
        XCTAssertNil(coordinator.presentedError)
    }

    @MainActor
    func testANotificationForAMachineNoLongerPairedOrRevokedDropsQuietly() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: AidenDemoResponder())
        await coordinator.start()
        let intents = AidenForegroundIntentRouter()
        let forgotten = try await taps(from: "laptop")
        let revoked = try await taps(from: "mini")
        await coordinator.removeInstallation("laptop")
        coordinator.hosts.connection(for: "mini")?.markRevoked()

        for tap in forgotten + revoked {
            tap.open(coordinator: coordinator, intents: intents)
        }

        XCTAssertEqual(intents.routes, [])
        XCTAssertNil(coordinator.presentedError)
    }

    @MainActor
    func testAQueuedRouteLeavesWithItsMachine() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: AidenDemoResponder())
        await coordinator.start()
        let intents = AidenForegroundIntentRouter()
        intents.submit(route: .machine(instanceId: "laptop"))
        intents.submit(route: .machine(instanceId: "mini"))
        intents.submit(route: .machine(instanceId: "studio"))

        await coordinator.removeInstallation("laptop")
        intents.dropUnopenable(on: coordinator)
        XCTAssertEqual(intents.routes.map(\.route), [.machine(instanceId: "mini"), .machine(instanceId: "studio")])

        // Revoked after it was queued, and caught only as the shell takes it.
        coordinator.hosts.connection(for: "mini")?.markRevoked()
        XCTAssertEqual(intents.takeRoutes(openableOn: coordinator).map(\.route), [.machine(instanceId: "studio")])
        XCTAssertEqual(intents.routes, [])
    }

    @MainActor
    func testTwoIntentsArrivingTogetherBothRoute() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        replyToNewChats(responder, on: ["studio", "laptop"])
        let device = try XCTUnwrap(coordinator.hosts.connection(for: "laptop")).installation.deviceId
        let intents = AidenForegroundIntentRouter()

        intents.submit(instanceID: "studio", workspaceID: nil, startsVoice: false)
        intents.submit(instanceID: "laptop", workspaceID: "workspace_app", startsVoice: false)
        // The view asks again on every change, so a pass can start during a pass.
        async let first: Void = intents.openWaitingChats(coordinator: coordinator, isForeground: { true })
        async let second: Void = intents.openWaitingChats(coordinator: coordinator, isForeground: { true })
        _ = await (first, second)

        XCTAssertEqual(intents.actions, [])
        let navigation = AidenAppNavigation()
        for queued in intents.takeRoutes(openableOn: coordinator) {
            navigation.open(queued.route, startsVoice: queued.startsVoice)
        }
        XCTAssertEqual(navigation.inboxPath, [
            .chat(AidenHostObjectID(instanceId: "studio", deviceId: device, objectId: "chat_new_studio")),
            .chat(AidenHostObjectID(instanceId: "laptop", deviceId: device, objectId: "chat_new_laptop")),
        ])
        XCTAssertEqual(coordinator.defaultInstanceId, "studio", "An intent moved the selection")
        XCTAssertEqual(responder.requests(instanceId: "studio").filter { $0 == "POST /chats" }.count, 1)
        XCTAssertEqual(responder.requests(instanceId: "laptop").filter { $0 == "POST /chats" }.count, 1)
    }

    @MainActor
    func testAnIntentWaitsForItsOwnMachineWithoutHoldingUpAnother() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        XCTAssertNotEqual(coordinator.hosts.connection(for: "laptop")?.connectionState, .connected)
        replyToNewChats(responder, on: ["studio", "laptop"])
        let intents = AidenForegroundIntentRouter()
        let start = Date()

        intents.submit(instanceID: "laptop", workspaceID: nil, startsVoice: false, now: start)
        intents.submit(instanceID: "studio", workspaceID: nil, startsVoice: false, now: start)
        await intents.openWaitingChats(coordinator: coordinator, isForeground: { true }, now: { start })

        XCTAssertEqual(intents.routes.count, 1)
        XCTAssertEqual(intents.actions.map(\.instanceID), ["laptop"])

        await AidenHostConnectScheduler(registry: coordinator.hosts, pathChanges: AsyncStream { _ in }).foregrounded()
        await intents.openWaitingChats(coordinator: coordinator, isForeground: { true }, now: { start })

        XCTAssertEqual(intents.routes.count, 2)
        XCTAssertEqual(intents.actions, [])
    }

    @MainActor
    func testAnIntentThatOutlivesItsMinuteCreatesNothing() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        replyToNewChats(responder, on: ["laptop"])
        let intents = AidenForegroundIntentRouter()
        let start = Date()

        intents.submit(instanceID: "laptop", workspaceID: nil, startsVoice: false, now: start)
        await intents.openWaitingChats(
            coordinator: coordinator,
            isForeground: { true },
            now: { start.addingTimeInterval(60) }
        )

        XCTAssertEqual(intents.actions, [])
        XCTAssertEqual(intents.routes, [])
        XCTAssertFalse(responder.requests(instanceId: "laptop").contains("POST /chats"))
    }

    @MainActor
    func testAnIntentThatHasNotStartedSurvivesSuspendingAndCreatesOnReturn() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        replyToNewChats(responder, on: ["laptop"])
        let installation = try XCTUnwrap(coordinator.hosts.connection(for: "laptop")).installation
        let intents = AidenForegroundIntentRouter()
        let start = Date()

        intents.submit(instanceID: "laptop", workspaceID: nil, startsVoice: false, now: start)
        await intents.openWaitingChats(
            coordinator: coordinator,
            isForeground: { false },
            now: { start.addingTimeInterval(1) }
        )

        XCTAssertEqual(intents.actions.count, 1)
        XCTAssertFalse(responder.requests(instanceId: "laptop").contains("POST /chats"))

        await intents.openWaitingChats(
            coordinator: coordinator,
            isForeground: { true },
            now: { start.addingTimeInterval(59) }
        )

        XCTAssertEqual(intents.actions, [])
        XCTAssertEqual(
            intents.routes.map(\.route),
            [.chat(AidenHostObjectID(instanceId: "laptop", deviceId: installation.deviceId, objectId: "chat_new_laptop"))]
        )
    }

    @MainActor
    func testAnIntentThatStaysSuspendedPastItsMinuteCreatesNothing() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        replyToNewChats(responder, on: ["laptop"])
        let intents = AidenForegroundIntentRouter()
        let start = Date()

        intents.submit(instanceID: "laptop", workspaceID: nil, startsVoice: false, now: start)
        XCTAssertEqual(intents.actions.count, 1)
        await intents.openWaitingChats(
            coordinator: coordinator,
            isForeground: { true },
            now: { start.addingTimeInterval(60) }
        )

        XCTAssertEqual(intents.actions, [])
        XCTAssertEqual(intents.routes, [])
        XCTAssertFalse(responder.requests(instanceId: "laptop").contains("POST /chats"))
    }

    @MainActor
    func testRoutesSurviveDiscardingActions() {
        let intents = AidenForegroundIntentRouter()
        let route = AidenAppRoute.machine(instanceId: "laptop")
        intents.submit(route: route)
        intents.submit(instanceID: "laptop", workspaceID: nil, startsVoice: false)

        intents.discardActions()

        XCTAssertEqual(intents.actions, [])
        XCTAssertEqual(intents.routes.map(\.route), [route])
    }

    @MainActor
    func testAChatInAFreshHiddenWorkspaceRefreshesItsMachineThenOpens() async throws {
        for machine in ["studio", "laptop"] {
            let responder = AidenDemoResponder()
            let coordinator = try await connectedDemoMachines(responder)
            let connection = try XCTUnwrap(coordinator.hosts.connection(for: machine))
            replyToNewChats(responder, on: [machine], workspaceId: "workspace_fresh")
            responder.reply(instanceId: machine, path: "/workspaces", status: 200, json: hiddenWorkspaces(["default", "workspace_fresh"]))
            let intents = AidenForegroundIntentRouter()

            intents.submit(instanceID: machine, workspaceID: "default", startsVoice: false)
            await intents.openWaitingChats(coordinator: coordinator, isForeground: { true })

            XCTAssertTrue(connection.workspaces.contains { $0.id == "workspace_fresh" }, machine)
            XCTAssertEqual(
                intents.routes.map(\.route),
                [.chat(AidenHostObjectID(instanceId: machine, deviceId: connection.installation.deviceId, objectId: "chat_new_\(machine)"))]
            )
            XCTAssertNil(coordinator.presentedError, machine)
            XCTAssertEqual(coordinator.defaultInstanceId, "studio", "The selection moved")
        }
    }

    @MainActor
    func testAChatStillUnlistedAfterTheRefreshSaysSoAndOpensNothing() async throws {
        for machine in ["studio", "laptop"] {
            for readFails in [false, true] {
                let responder = AidenDemoResponder()
                let coordinator = try await connectedDemoMachines(responder)
                replyToNewChats(responder, on: [machine], workspaceId: "workspace_fresh")
                if readFails {
                    responder.fail(instanceId: machine, path: "/workspaces", code: .timedOut)
                }
                let reads = responder.requests(instanceId: machine).filter { $0 == "GET /workspaces" }.count
                let intents = AidenForegroundIntentRouter()

                intents.submit(instanceID: machine, workspaceID: "default", startsVoice: false)
                await intents.openWaitingChats(coordinator: coordinator, isForeground: { true })

                XCTAssertEqual(responder.requests(instanceId: machine).filter { $0 == "GET /workspaces" }.count, reads + 1)
                XCTAssertEqual(intents.routes, [])
                XCTAssertEqual(coordinator.presentedError, AidenNoWorkspace.startedButUnlistedMessage)
            }
        }
    }

    @MainActor
    func testAMachineRevokedDuringTheWorkspaceRefreshDropsQuietly() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        replyToNewChats(responder, on: ["laptop"], workspaceId: "workspace_fresh")
        responder.reply(
            instanceId: "laptop",
            path: "/workspaces",
            status: 401,
            json: Data(#"{"error":{"code":"credential_revoked","message":"Revoked.","requestId":"r","retryable":false}}"#.utf8)
        )
        let intents = AidenForegroundIntentRouter()

        intents.submit(instanceID: "laptop", workspaceID: "default", startsVoice: false)
        await intents.openWaitingChats(coordinator: coordinator, isForeground: { true })

        XCTAssertEqual(intents.routes, [])
        XCTAssertNil(coordinator.presentedError)
    }

    @MainActor
    func testAnIntentForAMachineNoLongerPairedOrRevokedDropsQuietly() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        replyToNewChats(responder, on: ["laptop", "mini"])
        let intents = AidenForegroundIntentRouter()
        await coordinator.removeInstallation("laptop")
        coordinator.hosts.connection(for: "mini")?.markRevoked()

        intents.submit(instanceID: "laptop", workspaceID: nil, startsVoice: false)
        intents.submit(instanceID: "mini", workspaceID: "workspace_notes", startsVoice: true)
        await intents.openWaitingChats(coordinator: coordinator, isForeground: { true })

        XCTAssertEqual(intents.actions, [])
        XCTAssertEqual(intents.routes, [])
        XCTAssertNil(coordinator.presentedError)
        XCTAssertFalse(responder.requests(instanceId: "laptop").contains("POST /chats"))
        XCTAssertFalse(responder.requests(instanceId: "mini").contains("POST /chats"))
    }

    @MainActor
    func testAnIntentWhoseMachineFindsItRevokedDropsQuietly() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        responder.reply(
            instanceId: "laptop",
            method: "POST",
            path: "/chats",
            status: 401,
            json: try JSONSerialization.data(withJSONObject: ["error": [
                "code": "credential_revoked",
                "message": "This device was removed.",
                "requestId": "request_demo_revoked",
                "retryable": false,
            ]])
        )
        let intents = AidenForegroundIntentRouter()

        intents.submit(instanceID: "laptop", workspaceID: nil, startsVoice: false)
        await intents.openWaitingChats(coordinator: coordinator, isForeground: { true })

        XCTAssertEqual(intents.actions, [])
        XCTAssertEqual(intents.routes, [])
        XCTAssertNil(coordinator.presentedError)
    }

    @MainActor
    func testAVoiceIntentOpensItsChatListeningOnce() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        replyToNewChats(responder, on: ["laptop"])
        let installation = try XCTUnwrap(coordinator.hosts.connection(for: "laptop")).installation
        let chat = AidenHostObjectID(instanceId: "laptop", deviceId: installation.deviceId, objectId: "chat_new_laptop")
        let intents = AidenForegroundIntentRouter()

        intents.submit(instanceID: "laptop", workspaceID: nil, startsVoice: true)
        await intents.openWaitingChats(coordinator: coordinator, isForeground: { true })
        let navigation = AidenAppNavigation()
        for queued in intents.takeRoutes(openableOn: coordinator, isForeground: { true }) {
            navigation.open(queued.route, startsVoice: queued.startsVoice)
        }

        XCTAssertEqual(navigation.inboxPath, [.chat(chat)])
        XCTAssertEqual(navigation.chatStartingVoice, chat)

        // Saved navigation never carries it: a relaunch must not open the microphone.
        let saved = try JSONDecoder().decode(
            AidenAppNavigationSnapshot.self,
            from: JSONEncoder().encode(navigation.snapshot)
        )
        XCTAssertNil(AidenAppNavigation(restoring: saved, installations: [installation]).chatStartingVoice)

        navigation.finishStartingVoice(AidenHostObjectID(instanceId: "laptop", deviceId: installation.deviceId, objectId: "other"))
        XCTAssertEqual(navigation.chatStartingVoice, chat, "Another chat closing ended the voice start")
        navigation.finishStartingVoice(chat)
        XCTAssertNil(navigation.chatStartingVoice)

        navigation.open(.chat(chat), startsVoice: true)
        navigation.open(.settings)
        XCTAssertNil(navigation.chatStartingVoice, "A voice start outlived the intent that asked for it")
    }

    @MainActor
    func testAVoiceIntentThatLosesTheForegroundStillOpensItsChatSilently() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        replyToNewChats(responder, on: ["laptop"])
        let intents = AidenForegroundIntentRouter()

        intents.submit(instanceID: "laptop", workspaceID: nil, startsVoice: true)
        await intents.openWaitingChats(coordinator: coordinator, isForeground: { true })
        let taken = intents.takeRoutes(openableOn: coordinator, isForeground: { false })

        XCTAssertEqual(taken.count, 1)
        XCTAssertEqual(taken.map(\.startsVoice), [false])
        XCTAssertEqual(intents.routes, [])
    }

    @MainActor
    func testAVoiceRouteIsJudgedWhenTakenNotWhenQueued() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        replyToNewChats(responder, on: ["laptop"])
        let intents = AidenForegroundIntentRouter()
        var foregroundChecks = 0

        // Away while the chat was created, back in front of the person by the take.
        intents.submit(instanceID: "laptop", workspaceID: nil, startsVoice: true)
        await intents.openWaitingChats(coordinator: coordinator, isForeground: {
            foregroundChecks += 1
            return foregroundChecks == 1
        })

        XCTAssertEqual(intents.takeRoutes(openableOn: coordinator, isForeground: { true }).map(\.startsVoice), [true])
    }

    @MainActor
    func testAVoiceRouteThatWaitedPastItsMinuteOpensSilently() async throws {
        let responder = AidenDemoResponder()
        let coordinator = try await connectedDemoMachines(responder)
        replyToNewChats(responder, on: ["laptop"])
        let intents = AidenForegroundIntentRouter()
        let start = Date()

        intents.submit(instanceID: "laptop", workspaceID: nil, startsVoice: true, now: start)
        await intents.openWaitingChats(coordinator: coordinator, isForeground: { true }, now: { start })
        let taken = intents.takeRoutes(
            openableOn: coordinator,
            isForeground: { true },
            now: start.addingTimeInterval(60)
        )

        XCTAssertEqual(taken.count, 1)
        XCTAssertEqual(taken.map(\.startsVoice), [false])
    }

    @MainActor
    func testARouteQueuedBeforeTheShellMountsOpensExactlyOnce() async throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: AidenDemoResponder())
        await coordinator.start()
        let store = AidenAppNavigationStore(defaults: AidenDemoHosts.isolatedDefaults())
        let intents = AidenForegroundIntentRouter()
        let early = AidenAppRoute.machine(instanceId: "laptop")
        let late = AidenAppRoute.machine(instanceId: "mini")

        intents.submit(route: early)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(intents.routes.map(\.route), [early], "Nothing is mounted to take it yet")

        let first = try showShell(coordinator, store: store, intents: intents)
        await waitUntil { store.load().inboxPath == [early] }
        XCTAssertEqual(store.load().inboxPath, [early])
        XCTAssertEqual(intents.routes, [])

        intents.submit(route: late)
        await waitUntil { store.load().inboxPath == [early, late] }
        XCTAssertEqual(store.load().inboxPath, [early, late])
        first.isHidden = true
        first.rootViewController = nil

        // A shell mounting again starts from what was saved and opens nothing twice.
        let second = try showShell(coordinator, store: store, intents: intents)
        defer {
            second.isHidden = true
            second.rootViewController = nil
        }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(store.load().inboxPath, [early, late])
    }

    @MainActor
    private func connectedDemoMachines(_ responder: AidenDemoResponder) async throws -> AidenRemoteCoordinator {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        await AidenHostConnectScheduler(registry: coordinator.hosts, pathChanges: AsyncStream { _ in }).foregrounded()
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
        XCTAssertEqual(coordinator.hosts.connection(for: "laptop")?.connectionState, .connected)
        return coordinator
    }

    private func replyToNewChats(
        _ responder: AidenDemoResponder,
        on machines: [String],
        workspaceId: String = "workspace_app"
    ) {
        for instanceId in machines {
            responder.reply(
                instanceId: instanceId,
                method: "POST",
                path: "/chats",
                status: 201,
                json: Data("""
                {"id":"chat_new_\(instanceId)","workspaceId":"\(workspaceId)","title":"New chat","messages":[],
                "createdAt":"2026-08-19T19:00:00.000Z","updatedAt":"2026-08-19T19:00:00.000Z","revision":"chat_revision_1"}
                """.utf8)
            )
        }
    }

    /// Hidden No workspace records, as `GET /workspaces` lists them.
    private func hiddenWorkspaces(_ ids: [String]) -> Data {
        let records = ids.map { id in
            """
            {"id":"\(id)","name":"No workspace","permission":"ask","memoryEnabled":true,"hasFolder":true,
            "isManagedWorktree":false,"noWorkspace":true,"createdAt":"2026-08-19T19:00:00.000Z",
            "updatedAt":"2026-08-19T19:00:00.000Z","revision":"workspace_revision_1"}
            """
        }
        return Data(#"{"workspaces":[\#(records.joined(separator: ","))]}"#.utf8)
    }

    /// Reads `<prefix><instance>.<run>` back: the first dot ends the instance.
    private func machineAndRun(in identifier: String, after prefix: String) throws -> [String] {
        let rest = identifier.dropFirst(prefix.count)
        let dot = try XCTUnwrap(rest.firstIndex(of: "."), identifier)
        let instance = try XCTUnwrap(String(rest[..<dot]).removingPercentEncoding, identifier)
        return [instance, String(rest[rest.index(after: dot)...])]
    }

    private func scheduledRun(id: String) -> AidenScheduledRunNotification {
        AidenScheduledRunNotification(
            id: id,
            taskId: "task-1",
            taskName: "Nightly report",
            status: "succeeded",
            startedAt: Date(timeIntervalSince1970: 100),
            finishedAt: Date(timeIntervalSince1970: 101),
            summary: "Done",
            errorCode: nil,
            notify: true
        )
    }

    private func botRoutineNotification(id: String) throws -> AidenBotRoutineNotification {
        let feed = try AidenRemoteJSONDecoder.decode(
            AidenBotRoutineNotificationFeed.self,
            from: JSONSerialization.data(withJSONObject: [
                "notifications": [[
                    "id": id, "botId": "bot_fixture_01", "botName": "Scout",
                    "routineId": "task_fixture_routine_01", "routineName": "Morning brief",
                    "status": "succeeded", "finishedAt": "2026-08-19T15:30:00.000Z", "preview": "Ready.",
                ]],
                "now": "2026-08-19T16:00:00.000Z",
            ])
        )
        return try XCTUnwrap(feed.notifications.first)
    }

    /// What tapping each kind of notification from `instanceId` hands the app:
    /// a run alert, a Bot routine, and a scheduled run, as the notifiers post them.
    @MainActor
    private func taps(from instanceId: String) async throws -> [AidenNotificationTap] {
        let defaults = AidenDemoHosts.isolatedDefaults()
        let center = AidenNotificationCenterFake()
        await AidenRunAlertNotifier(defaults: defaults, center: center, appState: { .background }).notify(
            .completed,
            id: "stream-1",
            instanceID: instanceId,
            chatID: "chat_\(instanceId)_1",
            chatTitle: "Chat",
            isChatOnScreen: false
        )
        center.posted.append(AidenBotRoutineNotifier.request(for: try botRoutineNotification(id: "run-1"), instanceId: instanceId))
        let notifier = AidenScheduledRunNotifier(defaults: defaults, center: center)
        await notifier.deliver(instanceId: instanceId, client: AidenScheduledFeedFake(notifications: []))
        await notifier.deliver(instanceId: instanceId, client: AidenScheduledFeedFake(notifications: [scheduledRun(id: "run-2")]))
        XCTAssertEqual(center.posted.count, 3)
        return center.posted.map { AidenNotificationTap(userInfo: $0.content.userInfo) }
    }

    @MainActor
    private func showShell(
        _ coordinator: AidenRemoteCoordinator,
        store: AidenAppNavigationStore,
        intents: AidenForegroundIntentRouter
    ) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        window.rootViewController = UIHostingController(rootView:
            AidenAppShellView(
                coordinator: coordinator,
                inboxStore: AidenUnifiedInboxStore(coordinator: coordinator),
                navigationStore: store,
                intents: intents
            )
                .environment(AidenHapticCenter())
                .environment(AidenAppearanceStore())
        )
        window.makeKeyAndVisible()
        return window
    }

    @MainActor
    private func waitUntil(_ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(10)
        while !condition(), Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }
#endif
}

#if DEBUG
/// Posts as the system does: a second request with one identifier replaces the first.
private final class AidenNotificationCenterFake: AidenRunAlertCenter, AidenNotificationInventory {
    var posted: [UNNotificationRequest] = []
    private(set) var removalPasses = 0
    /// The system's removal calls report nothing back, so one can quietly fail.
    var ignoresRemovals = false

    func currentAuthorizationStatus() async -> UNAuthorizationStatus { .authorized }
    func requestAlertAuthorization() async -> Bool { true }

    func add(_ request: UNNotificationRequest) async throws {
        posted.removeAll { $0.identifier == request.identifier }
        posted.append(request)
    }

    func postedRequests() async -> [UNNotificationRequest] { posted }

    func removeNotifications(withIdentifiers identifiers: [String]) {
        removalPasses += 1
        guard !ignoresRemovals else { return }
        posted.removeAll { identifiers.contains($0.identifier) }
    }
}

private struct AidenScheduledFeedFake: AidenScheduledRunNotificationTransport {
    let notifications: [AidenScheduledRunNotification]

    func scheduledRunNotifications(since: Date?) async throws -> AidenScheduledRunNotificationFeed {
        AidenScheduledRunNotificationFeed(notifications: notifications, serverNow: Date(timeIntervalSince1970: 50))
    }
}
#endif

private final class AidenRecoveryMemoryKeychain: KeychainStoring {
    func save(_ value: String, forKey key: KeychainStore.Key) throws {}
    func load(_ key: KeychainStore.Key) throws -> String? { nil }
    func delete(_ key: KeychainStore.Key) throws {}
    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {}
    func load(_ key: KeychainStore.Key, scope: String) throws -> String? { nil }
    func delete(_ key: KeychainStore.Key, scope: String) throws {}
}

private final class FakeAlertTransport: AidenAlertActionTransport, @unchecked Sendable {
    enum Call: Equatable {
        case streamApproval(id: String, decision: AidenApprovalDecision, scope: AidenApprovalScope?)
        case runApproval(runId: String, approvalId: String, decision: AidenApprovalDecision, scope: AidenApprovalScope?)
        case question(id: String, request: AidenQuestionRespondRequest)
        case runQuestion(runId: String, promptId: String, request: AidenQuestionRespondRequest)
    }

    private let lock = NSLock()
    private var recorded: [Call] = []
    private var keys: [UUID] = []
    private let failure: AidenRemoteClientError?

    init(failure: AidenRemoteClientError? = nil) {
        self.failure = failure
    }

    var calls: [Call] { lock.withLock { recorded } }
    var idempotencyKeys: [UUID] { lock.withLock { keys } }

    private func record(_ call: Call, key: UUID) throws {
        lock.withLock {
            recorded.append(call)
            keys.append(key)
        }
        if let failure { throw failure }
    }

    func respondToApproval(id: String, decision: AidenApprovalDecision, scope: AidenApprovalScope?, idempotencyKey: UUID) async throws -> AidenApprovalResponse {
        try record(.streamApproval(id: id, decision: decision, scope: scope), key: idempotencyKey)
        return AidenApprovalResponse(approvalId: id, decision: decision, scope: scope, resolvedAt: Date())
    }

    func respondToRunApproval(runId: String, approvalId: String, decision: AidenApprovalDecision, scope: AidenApprovalScope?, idempotencyKey: UUID) async throws -> AidenRemoteRunApprovalResult {
        try record(.runApproval(runId: runId, approvalId: approvalId, decision: decision, scope: scope), key: idempotencyKey)
        return AidenRemoteRunApprovalResult(runId: runId, approvalId: approvalId, decision: decision, scope: scope, resolvedAt: Date())
    }

    func respondToQuestion(id: String, request: AidenQuestionRespondRequest, idempotencyKey: UUID) async throws -> AidenQuestionRespondResponse {
        try record(.question(id: id, request: request), key: idempotencyKey)
        return AidenQuestionRespondResponse(promptId: id, resolvedAt: Date())
    }

    func respondToRunQuestion(runId: String, promptId: String, request: AidenQuestionRespondRequest, idempotencyKey: UUID) async throws -> AidenRemoteRunQuestionResult {
        try record(.runQuestion(runId: runId, promptId: promptId, request: request), key: idempotencyKey)
        return AidenRemoteRunQuestionResult(runId: runId, promptId: promptId, outcome: "answered", resolvedAt: Date())
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
    let race = AidenDeliveryRace<AgentRunActivityAttributes.ContentState>()
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

/// `Activity.activities` hands out a separate instance per call, so the
/// instance a test holds is not the one the manager ends. ActivityKit
/// propagates the ended state to other instances asynchronously, and under a
/// loaded simulator that lands after `end(_:dismissalPolicy:)` returns. Await
/// the delivered state event instead of reading `activityState` right away.
/// The ceiling has the same failure-only role as in `deliveredContent`.
@MainActor
private func assertDeliveredEnd(
    of activity: Activity<AgentRunActivityAttributes>,
    failureCeiling: Duration = .seconds(30),
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    let isEnded: @Sendable (ActivityState) -> Bool = { $0 == .ended || $0 == .dismissed }
    let race = AidenDeliveryRace<ActivityState>()
    let outcome = await withCheckedContinuation { continuation in
        race.continuation = continuation
        race.observer = Task { @MainActor in
            // Subscribe before reading the current state so a transition that
            // lands between the two is buffered rather than missed.
            let updates = activity.activityStateUpdates.makeAsyncIterator()
            let current = activity.activityState
            race.last = current
            if isEnded(current) {
                race.finish(.delivered(current))
                return
            }
            while let state = await updates.next() {
                race.last = state
                if isEnded(state) {
                    race.finish(.delivered(state))
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

    let lastSeen = race.last.map { "\($0)" } ?? "no state"
    switch outcome {
    case .delivered:
        break
    case .streamFinished:
        XCTFail(
            "ActivityKit ended the state stream before the activity ended; last seen: \(lastSeen).",
            file: file,
            line: line
        )
    case .ceilingReached:
        XCTFail(
            "ActivityKit did not deliver the ended state within the \(failureCeiling) failure ceiling; last seen: \(lastSeen).",
            file: file,
            line: line
        )
    }
}

private enum AidenDeliveryOutcome<Value: Sendable>: Sendable {
    case delivered(Value)
    case streamFinished
    case ceilingReached
}

@MainActor
private final class AidenDeliveryRace<Value: Sendable> {
    var last: Value?
    var continuation: CheckedContinuation<AidenDeliveryOutcome<Value>, Never>?
    var observer: Task<Void, Never>?
    var ceiling: Task<Void, Never>?

    func finish(_ outcome: AidenDeliveryOutcome<Value>) {
        continuation?.resume(returning: outcome)
        continuation = nil
    }
}

/// Tags diagnostics with the test task that caused them (see the binary contract test).
private enum DiagnosticsTestScope {
    @TaskLocal static var current: UUID?
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

@MainActor
private final class FakeBackgroundTaskHost: AidenBackgroundTaskHost {
    private(set) var begun = 0
    private(set) var ended = 0
    private var expirationHandler: (@MainActor () -> Void)?

    func beginBackgroundTask(expirationHandler: @escaping @MainActor () -> Void) -> UIBackgroundTaskIdentifier {
        begun += 1
        self.expirationHandler = expirationHandler
        return UIBackgroundTaskIdentifier(rawValue: begun)
    }

    func endBackgroundTask(_ identifier: UIBackgroundTaskIdentifier) {
        ended += 1
    }

    /// iOS calls the handler when the time runs out; the app must end the task.
    func expire() {
        expirationHandler?()
    }
}
