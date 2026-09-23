import AVFoundation
import Foundation
import Photos
import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

final class AidenChatTests: XCTestCase {
    func testProducedFileProvenanceRejectsForeignPathsAndUnrelatedTools() throws {
        let file = AidenProducedFile(relativePath: "out/report.txt", operation: "written", bytes: 12)
        XCTAssertTrue(file.isValid(toolName: "write_file"))
        XCTAssertTrue(AidenProducedFile(relativePath: "foo:bar.txt", operation: "written", bytes: 12).isValid(toolName: "write_file"))
        XCTAssertTrue(AidenProducedFile(relativePath: String(repeating: "😀", count: 121), operation: "written", bytes: 12).isValid(toolName: "write_file"))
        XCTAssertFalse(AidenProducedFile(relativePath: String(repeating: "😀", count: 241), operation: "written", bytes: 12).isValid(toolName: "write_file"))
        XCTAssertFalse(file.isValid(toolName: "mcp_write"))
        XCTAssertFalse(file.isValid(toolName: "edit_file"))
        for path in ["C:/private", "/Users/private", "../secret", "a/../b", "a//b", "a\\b", "bad\nname"] {
            XCTAssertFalse(AidenProducedFile(relativePath: path, operation: "written", bytes: 12).isValid(toolName: "write_file"))
        }
        let data = try JSONEncoder().encode(file)
        XCTAssertEqual(try JSONDecoder().decode(AidenProducedFile.self, from: data), file)
    }

    func testHistoryReasoningRejectsBotChatAndAcceptsRegularChat() throws {
        let regular = """
        {"id":"chat-1","workspaceId":"workspace-1","title":"Chat","messages":[{"id":"message-1","role":"assistant","text":"Done","reasoning":"Visible","createdAt":"2026-08-20T12:00:00Z"}],"createdAt":"2026-08-20T12:00:00Z","updatedAt":"2026-08-20T12:00:00Z","revision":"rev-1"}
        """
        let decoder = JSONDecoder.aidenRemote()
        XCTAssertEqual(try decoder.decodeAidenRemote(AidenChat.self, from: Data(regular.utf8)).messages[0].reasoning, "Visible")
        let bot = regular.replacingOccurrences(of: "\"workspaceId\"", with: "\"botId\":\"bot-1\",\"workspaceId\"")
        XCTAssertThrowsError(try decoder.decodeAidenRemote(AidenChat.self, from: Data(bot.utf8)))
    }

    func testChronologicalReasoningSurvivesRemoteDecodeAndKeepsToolOrder() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let message = try decoder.decode(AidenChatMessage.self, from: Data(
            #"{"id":"message-1","role":"assistant","text":"Before.After.","reasoning":"First\n\nSecond","createdAt":"2026-08-20T12:00:00Z","timeline":{"version":3,"generationId":"stream-1","status":"completed","startedAt":1000,"finishedAt":3000,"steps":[{"id":"think-1","order":0,"kind":"thinking","startedAt":1000,"updatedAt":1200,"finishedAt":1200,"contentOffset":0,"reasoningStartOffset":0,"reasoningEndOffset":5},{"id":"tool-1","order":1,"kind":"tool","toolCallId":"call-1","toolName":"read_file","label":"Read file","status":"completed","startedAt":1200,"updatedAt":1400,"finishedAt":1400,"contentOffset":0},{"id":"think-2","order":2,"kind":"thinking","startedAt":1400,"updatedAt":1600,"finishedAt":1600,"contentOffset":7,"reasoningStartOffset":7,"reasoningEndOffset":13}]}}"#.utf8
        ))
        XCTAssertTrue(message.isWireSafe)
        XCTAssertEqual(
            AidenChronologicalProjection.rows(text: message.text, reasoning: message.reasoning ?? "", timeline: message.timeline)?
                .map { ($0.kind, $0.text) }
                .map { "\($0.0):\($0.1)" },
            ["reasoning:First", "tool:", "text:Before.", "reasoning:Second", "text:After."]
        )
        XCTAssertNil(AidenChronologicalProjection.rows(text: message.text, reasoning: "First", timeline: message.timeline))
        let noReasoningTimeline = try decoder.decode(AidenGenerationTimeline.self, from: Data(
            #"{"version":3,"generationId":"stream-2","status":"completed","startedAt":1000,"finishedAt":2000,"steps":[{"id":"think-1","order":0,"kind":"thinking","startedAt":1000,"updatedAt":1100,"finishedAt":1100,"contentOffset":7},{"id":"tool-1","order":1,"kind":"tool","toolCallId":"call-1","toolName":"read_file","label":"Read file","status":"completed","startedAt":1100,"updatedAt":1200,"finishedAt":1200,"contentOffset":7}]}"#.utf8
        ))
        XCTAssertEqual(
            AidenChronologicalProjection.rows(text: "Before.After.", reasoning: "", timeline: noReasoningTimeline)?
                .map(\.kind),
            [.text, .reasoning, .tool, .text]
        )
        let legacyTimeline = try decoder.decode(AidenGenerationTimeline.self, from: Data(
            #"{"version":2,"generationId":"stream-old","status":"completed","startedAt":1000,"finishedAt":2000,"steps":[{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"read_file","label":"Read file","status":"completed","startedAt":1000,"updatedAt":2000,"finishedAt":2000}]}"#.utf8
        ))
        XCTAssertNil(AidenChronologicalProjection.rows(text: "Before.After.", reasoning: "", timeline: legacyTimeline))
    }

    func testProgressPresentationFiltersDeletedTasksAndUsesVisibleOrderForActiveStep() throws {
        let progress = try AidenRemoteJSONDecoder.decode(
            AidenRemoteChatTaskProgress.self,
            from: Data(
                """
                {"version":1,"chatId":"chat-1","availability":"ready","epoch":"epoch-1","revision":4,"updatedAt":"2026-09-14T12:00:00Z","tasks":[
                  {"id":10,"subject":"Finished first","status":"completed"},
                  {"id":20,"subject":"Pending second","status":"pending"},
                  {"id":30,"subject":"Active third","status":"in_progress","activeForm":"Working third"},
                  {"id":40,"subject":"Removed fourth","status":"deleted"}
                ]}
                """.utf8
            )
        )

        XCTAssertEqual(AidenProgressPresentation.visibleTasks(progress).map(\.id), [10, 20, 30])
        XCTAssertEqual(AidenProgressPresentation.completedTaskCount(progress), 1)
        XCTAssertEqual(AidenProgressPresentation.remainingTaskCount(progress), 2)
        XCTAssertEqual(AidenProgressPresentation.activeTask(progress)?.id, 30)
        XCTAssertTrue(AidenProgressPresentation.showsTaskChip(progress))
    }

    func testProgressCompletionAnnouncementRequiresAnIncompleteToCompletedTransition() throws {
        let incomplete = try AidenRemoteJSONDecoder.decode(
            AidenRemoteChatTaskProgress.self,
            from: Data(
                """
                {"version":1,"chatId":"chat-1","availability":"ready","epoch":"epoch-1","revision":1,"updatedAt":"2026-09-14T12:00:00Z","tasks":[
                  {"id":1,"subject":"First","status":"in_progress","activeForm":"Working first"},
                  {"id":2,"subject":"Second","status":"pending"}
                ]}
                """.utf8
            )
        )
        let complete = try AidenRemoteJSONDecoder.decode(
            AidenRemoteChatTaskProgress.self,
            from: Data(
                """
                {"version":1,"chatId":"chat-1","availability":"ready","epoch":"epoch-1","revision":2,"updatedAt":"2026-09-14T12:01:00Z","tasks":[
                  {"id":1,"subject":"First","status":"completed"},
                  {"id":2,"subject":"Second","status":"completed"}
                ]}
                """.utf8
            )
        )

        XCTAssertTrue(
            AidenProgressPresentation.transitionedToAllTasksCompleted(
                previous: incomplete,
                current: complete
            )
        )
        XCTAssertFalse(
            AidenProgressPresentation.transitionedToAllTasksCompleted(
                previous: nil,
                current: complete
            )
        )
        XCTAssertFalse(
            AidenProgressPresentation.transitionedToAllTasksCompleted(
                previous: complete,
                current: complete
            )
        )
    }

    func testProgressRevisionFenceRejectsLateTurnAndDuplicateSnapshots() {
        XCTAssertFalse(
            AidenProgressPresentation.acceptsSnapshot(
                currentEpoch: "epoch-1",
                currentRevision: 8,
                incomingEpoch: "epoch-1",
                incomingRevision: 8
            )
        )
        XCTAssertFalse(
            AidenProgressPresentation.acceptsSnapshot(
                currentEpoch: "epoch-1",
                currentRevision: 8,
                incomingEpoch: "epoch-1",
                incomingRevision: 7
            )
        )
        XCTAssertTrue(
            AidenProgressPresentation.acceptsSnapshot(
                currentEpoch: "epoch-1",
                currentRevision: 8,
                incomingEpoch: "epoch-1",
                incomingRevision: 9
            )
        )
        XCTAssertTrue(
            AidenProgressPresentation.acceptsSnapshot(
                currentEpoch: "epoch-1",
                currentRevision: 8,
                incomingEpoch: "epoch-2",
                incomingRevision: 1
            )
        )
        XCTAssertTrue(
            AidenProgressPresentation.acceptsSnapshot(
                currentEpoch: nil,
                currentRevision: nil,
                incomingEpoch: "epoch-1",
                incomingRevision: 1
            )
        )
    }

    func testInvalidAgentProjectionStaysReachableWhileUnsupportedRemainsHidden() throws {
        let invalid = try AidenRemoteJSONDecoder.decode(
            AidenRemoteChatAgentRoster.self,
            from: Data(
                #"{"version":1,"chatId":"chat-1","availability":"unavailable","unavailableReason":"invalid_snapshot","epoch":"epoch-1","revision":1,"updatedAt":"2026-09-14T12:00:00Z","agents":[]}"#.utf8
            )
        )
        let unsupported = try AidenRemoteJSONDecoder.decode(
            AidenRemoteChatAgentRoster.self,
            from: Data(
                #"{"version":1,"chatId":"chat-1","availability":"unavailable","unavailableReason":"unsupported","epoch":"epoch-1","revision":1,"updatedAt":"2026-09-14T12:00:00Z","agents":[]}"#.utf8
            )
        )

        XCTAssertTrue(AidenProgressPresentation.showsAgentChip(invalid))
        XCTAssertFalse(AidenProgressPresentation.showsAgentChip(unsupported))
    }

    @MainActor
    func testProgressObservationReleasesCompletedHandleAndCanRestart() async throws {
        let model = try await makeProgressLifecycleModel(mode: .denied)
        defer {
            model.stopProgressObservation()
            AidenChatProgressLifecycleURLProtocol.reset()
        }

        model.startProgressObservation()
        try await waitForProgressRequestCount(1)
        try await waitForProgressObservationToStop(model)
        XCTAssertFalse(model.isProgressObservationRunning)

        // The first observer exited through a completed task body. A later
        // activation must be able to create a fresh observer for the same chat.
        model.startProgressObservation()
        try await waitForProgressRequestCount(2)
        try await waitForProgressObservationToStop(model)
        XCTAssertFalse(model.isProgressObservationRunning)
        XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.progressRequestCount, 2)
    }

    @MainActor
    func testCancelledOlderProgressObserverCannotClearNewerHandle() async throws {
        let model = try await makeProgressLifecycleModel(mode: .finite)
        defer {
            model.stopProgressObservation()
            AidenChatProgressLifecycleURLProtocol.reset()
        }

        model.startProgressObservation()
        try await waitForProgressRequestCount(1)
        XCTAssertTrue(model.isProgressObservationRunning)

        // The completed SSE response leaves the observer in its reconnect
        // sleep. Cancel that observer and immediately arm a new generation;
        // the old task's completion must not clear the new task handle.
        model.stopProgressObservation()
        model.startProgressObservation()
        try await waitForProgressRequestCount(2)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(model.isProgressObservationRunning)
        XCTAssertTrue(model.isProgressStale, "A finished stream should retain a last-known label while reconnecting.")
    }

    @MainActor
    func testRosterRefreshFailureDoesNotMarkFreshTaskProgressStale() async throws {
        let model = try await makeProgressLifecycleModel(mode: .rosterFailsAfterFirst)
        defer {
            model.stopProgressObservation()
            AidenChatProgressLifecycleURLProtocol.reset()
        }

        model.startProgressObservation()
        try await waitForAgentRequestCount(2)
        try await Task.sleep(for: .milliseconds(150))

        XCTAssertFalse(model.isTaskProgressStale)
        XCTAssertTrue(model.isAgentRosterStale)
    }

    @MainActor
    func testRosterEpochRotationPrunesHistoryAndRejectsSupersededFetch() async throws {
        let model = try await makeProgressLifecycleModel(mode: .rosterEpochRotates)
        defer {
            model.stopProgressObservation()
            AidenChatProgressLifecycleURLProtocol.reset()
        }

        model.startProgressObservation()
        try await waitForAgentRequestCount(2)
        try await Task.sleep(for: .milliseconds(150))

        XCTAssertEqual(model.agentRoster?.epoch, "epoch-old")
        XCTAssertTrue(model.historicalAgentRosters.contains { $0.turnId == "turn-current-old" })

        try await waitForAgentRequestCount(3)
        try await Task.sleep(for: .milliseconds(150))

        XCTAssertEqual(model.agentRoster?.epoch, "epoch-new")
        XCTAssertTrue(model.historicalAgentRosters.isEmpty)

        await model.loadAgentRoster(turnId: "turn-old")
        XCTAssertTrue(model.historicalAgentRosters.isEmpty)
        XCTAssertFalse(model.availableAgentTurnIds.contains("turn-old"))
    }

    @MainActor
    func testApprovalTapUsesDisplayedIDAndBlocksDuplicateDecisions() async throws {
        try await exerciseControlResponse(stop: false, nextApproval: "approval-current")
    }

    @MainActor
    func testUnknownApprovalResponseRefreshesCurrentRequestWithoutResending() async throws {
        try await exerciseControlResponse(stop: false, nextApproval: "approval-next")
    }

    @MainActor
    func testStopWaitsForHostAndBlocksDuplicateTaps() async throws {
        try await exerciseControlResponse(stop: true, nextApproval: "approval-current")
    }

    @MainActor
    func testLegacyWorkspaceRunStillOffersStop() async throws {
        try await exerciseControlResponse(stop: true, nextApproval: "approval-current", mode: .legacyControls)
    }

    @MainActor
    func testMismatchedStopAcknowledgementShowsFailure() async throws {
        try await exerciseControlResponse(stop: true, nextApproval: "approval-current", mode: .mismatchedStop)
    }

    @MainActor
    func testRevokedInstallationCannotRestoreApprovalAfterLateFailure() async throws {
        try await exerciseControlResponse(stop: false, nextApproval: "approval-current", mode: .revokedControls)
    }

    @MainActor
    func testUnsupportedApprovalCapabilityNeverSendsDecision() async throws {
        try await exerciseControlResponse(stop: false, nextApproval: "approval-current", mode: .unsupportedControls)
    }

    @MainActor
    func testFallbackDoesNotCoalesceWithPreResponseApprovalState() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root); AidenChatProgressLifecycleURLProtocol.reset() }
        let cache = AidenChatCache(root: root)
        var coordinator: AidenRemoteCoordinator!
        let model = try await makeProgressLifecycleModel(mode: .controls, cache: cache, onCoordinator: { coordinator = $0 })
        try await cache.saveActiveStream(.init(deviceId: "device-progress-lifecycle", streamId: "stream-control", turnId: "turn-control", lastSequence: 0), instanceId: "instance-progress-lifecycle", chatId: model.chat.id, chatWriteToken: cache.reserveChatWrite())
        await model.load(observeProgress: false)
        let context = try coordinator.requestContext(for: "instance-progress-lifecycle")
        let arrived = expectation(description: "pre-response approval read held")
        AidenChatProgressLifecycleURLProtocol.setApprovalID("approval-old")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/approval") { arrived.fulfill() }
        let read = Task { await model.restorePendingApproval(streamID: "stream-control", context: context) }
        await fulfillment(of: [arrived], timeout: 5)
        AidenChatProgressLifecycleURLProtocol.setApprovalID("approval-new")
        await model.respondToApproval(.allow, approvalID: "approval-current")
        XCTAssertEqual(model.pendingApproval?.id, "approval-new")
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        await read.value
        XCTAssertEqual(model.pendingApproval?.id, "approval-new")
    }

    @MainActor
    func testAmbiguousResponseDoesNotSupersedeHeldAuthoritativeApproval() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root); AidenChatProgressLifecycleURLProtocol.reset() }
        let cache = AidenChatCache(root: root)
        var coordinator: AidenRemoteCoordinator!
        let model = try await makeProgressLifecycleModel(mode: .controls, cache: cache, onCoordinator: { coordinator = $0 })
        try await cache.saveActiveStream(.init(deviceId: "device-progress-lifecycle", streamId: "stream-control", turnId: "turn-control", lastSequence: 0), instanceId: "instance-progress-lifecycle", chatId: model.chat.id, chatWriteToken: cache.reserveChatWrite())
        await model.load(observeProgress: false)
        let context = try coordinator.requestContext(for: "instance-progress-lifecycle")
        let responseArrived = expectation(description: "A response held")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/respond") { responseArrived.fulfill() }
        let response = Task { await model.respondToApproval(.allow, approvalID: "approval-current") }
        await fulfillment(of: [responseArrived], timeout: 5)
        let releaseResponse = AidenChatProgressLifecycleURLProtocol.takeHeldRequest()
        let readArrived = expectation(description: "authoritative B read held")
        AidenChatProgressLifecycleURLProtocol.setApprovalID("approval-new")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/approval") { readArrived.fulfill() }
        let read = Task { await model.restorePendingApproval(streamID: "stream-control", context: context) }
        await fulfillment(of: [readArrived], timeout: 5)
        // Any redundant fallback would fail, but must not supersede this admitted read.
        AidenChatProgressLifecycleURLProtocol.failApprovalReads()
        releaseResponse?()
        await response.value
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        await read.value
        XCTAssertEqual(model.pendingApproval?.id, "approval-new")
        XCTAssertEqual(model.streamState, .waitingForApproval)
    }

    @MainActor
    func testLatestAdmittedApprovalSnapshotWinsOverOlderCompletion() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root); AidenChatProgressLifecycleURLProtocol.reset() }
        let cache = AidenChatCache(root: root)
        var coordinator: AidenRemoteCoordinator!
        let model = try await makeProgressLifecycleModel(mode: .controls, cache: cache, onCoordinator: { coordinator = $0 })
        try await cache.saveActiveStream(.init(deviceId: "device-progress-lifecycle", streamId: "stream-control", turnId: "turn-control", lastSequence: 0), instanceId: "instance-progress-lifecycle", chatId: model.chat.id, chatWriteToken: cache.reserveChatWrite())
        await model.load(observeProgress: false)
        let context = try coordinator.requestContext(for: "instance-progress-lifecycle")
        let firstArrived = expectation(description: "older approval read held")
        AidenChatProgressLifecycleURLProtocol.setApprovalID("approval-old")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/approval") { firstArrived.fulfill() }
        let first = Task { await model.restorePendingApproval(streamID: "stream-control", context: context) }
        await fulfillment(of: [firstArrived], timeout: 5)
        let releaseFirst = AidenChatProgressLifecycleURLProtocol.takeHeldRequest()
        let secondArrived = expectation(description: "newer approval read held")
        AidenChatProgressLifecycleURLProtocol.setApprovalID("approval-new")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/approval") { secondArrived.fulfill() }
        let second = Task { await model.restorePendingApproval(streamID: "stream-control", context: context) }
        await fulfillment(of: [secondArrived], timeout: 5)
        await model.restorePendingApproval(streamID: "stale-stream", context: context)
        releaseFirst?()
        await first.value
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        await second.value
        XCTAssertEqual(model.pendingApproval?.id, "approval-new")
    }

    @MainActor
    func testMismatchedApprovalReceiptCannotReplaceNewerRequest() async throws {
        try await exerciseControlResponse(stop: false, nextApproval: "approval-next", mode: .mismatchedApproval)
    }

    @MainActor
    private func exerciseControlResponse(stop: Bool, nextApproval: String, mode: AidenChatProgressLifecycleURLProtocol.Mode = .controls) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let cache = AidenChatCache(root: root)
        var coordinator: AidenRemoteCoordinator?
        let model = try await makeProgressLifecycleModel(mode: mode, cache: cache) { coordinator = $0 }
        defer {
            model.stopProgressObservation()
            AidenChatProgressLifecycleURLProtocol.reset()
            try? FileManager.default.removeItem(at: root)
        }
        try await cache.saveActiveStream(.init(deviceId: "device-progress-lifecycle", streamId: "stream-control", turnId: "turn-control", lastSequence: 0), instanceId: "instance-progress-lifecycle", chatId: "chat-progress-lifecycle", chatWriteToken: cache.reserveChatWrite())
        await model.load(observeProgress: false)
        XCTAssertEqual(model.pendingApproval?.id, "approval-current")
        await model.respondToApproval(.allow, approvalID: "approval-stale")
        XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.controlWriteCount, 0)
        if mode == .unsupportedControls {
            await model.respondToApproval(.allow, approvalID: "approval-current")
            XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.controlWriteCount, 0)
            XCTAssertEqual(model.pendingApproval?.canRespond, false)
            return
        }
        let arrived = expectation(description: "Control request is held")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: stop ? "/cancel" : "/respond") { arrived.fulfill() }
        let task = Task { @MainActor in
            if stop { await model.stop() }
            else { await model.respondToApproval(.allow, approvalID: "approval-current") }
        }
        await fulfillment(of: [arrived], timeout: 5)
        if stop {
            XCTAssertTrue(model.canControlCurrentRun)
            XCTAssertTrue(model.isStopping)
            XCTAssertEqual(model.streamState, .waitingForApproval)
            await model.stop()
        } else {
            XCTAssertTrue(model.isRespondingToApproval)
            await model.respondToApproval(.deny, approvalID: "approval-current")
        }
        XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.controlWriteCount, 1)
        if mode == .revokedControls, let coordinator,
           let installation = coordinator.installationStore.activeInstallation {
            await coordinator.removeInstallation(installation.id)
        }
        AidenChatProgressLifecycleURLProtocol.setApprovalID(nextApproval)
        if mode == .mismatchedApproval {
            await model.load(observeProgress: false)
            XCTAssertEqual(model.pendingApproval?.id, nextApproval)
            AidenChatProgressLifecycleURLProtocol.failApprovalReads()
        }
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        await task.value
        XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.controlWriteCount, 1)
        if stop {
            XCTAssertFalse(model.isStopping)
            XCTAssertEqual(model.streamState, .waitingForApproval)
            XCTAssertTrue(model.presentedError?.contains("Stop was not confirmed") == true)
        } else {
            XCTAssertFalse(model.isRespondingToApproval)
            if mode == .revokedControls {
                XCTAssertNil(model.pendingApproval)
                XCTAssertFalse(model.canControlCurrentRun)
            } else {
                XCTAssertEqual(model.pendingApproval?.id, nextApproval)
            }
        }
    }

    @MainActor
    private func makeProgressLifecycleModel(
        mode: AidenChatProgressLifecycleURLProtocol.Mode,
        cache: AidenChatCache = .shared,
        draftStore: AidenChatDraftStore = .shared,
        onCoordinator: (@MainActor (AidenRemoteCoordinator) -> Void)? = nil,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in }
    ) async throws -> AidenChatViewModel {
        AidenChatProgressLifecycleURLProtocol.reset(mode: mode)
        let keychain = AidenChatProgressMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let endpoint = URL(string: "https://aiden.test/api/aiden/v1")!
        let exchange = AidenRemoteContractFixture.PairingExchange(
            protocolVersion: 1,
            instanceId: "instance-progress-lifecycle",
            deviceId: "device-progress-lifecycle",
            credential: "credential-progress-lifecycle",
            capabilities: [.serverRead, .workspaceRead, .chatRead, .chatWrite, .tasksRead, .agentsRead, .approvalRespond],
            endpoint: endpoint,
            serverSpkiSha256: "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        )
        _ = try store.savePairing(
            exchange,
            trust: AidenRemoteContractFixture.PairingTrust(mode: .system),
            name: "Progress Lifecycle Mac"
        )

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AidenChatProgressLifecycleURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            chatCache: cache,
            clientFactory: { installation, credential in
                AidenRemoteClient(
                    endpoint: installation.endpoint,
                    credential: credential,
                    session: session
                )
            }
        )
        await coordinator.start()
        XCTAssertEqual(coordinator.connectionState, .connected)
        onCoordinator?(coordinator)

        let chat = try AidenRemoteJSONDecoder.decode(
            AidenChat.self,
            from: Data(
                """
                {"id":"chat-progress-lifecycle","workspaceId":"workspace-1","title":"Progress lifecycle","messages":[],"createdAt":"2026-09-14T12:00:00Z","updatedAt":"2026-09-14T12:00:01Z","revision":"revision-1"}
                """.utf8
            )
        )
        return AidenChatViewModel(coordinator: coordinator, chat: chat, cache: cache, draftStore: draftStore, onChatUpdated: onChatUpdated)
    }

    @MainActor
    func testRejectedDetailLoadDoesNotMutateOrPublish() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-rejected-load-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = AidenChatWriteTestGate()
        let cache = AidenChatCache(root: root, beforeChatWrite: { await gate.waitIfArmed() })
        var publications: [AidenChat] = []
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache) { publications.append($0) }
        let originalTitle = model.chat.title
        var remote = model.chat
        remote.title = "Rejected remote title"
        let fixture = AidenStreamRecoveryFixture(chat: remote)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { fixture.response($0) }
        await gate.arm()
        let loading = Task { await model.load() }
        await waitForChatWrite(gate)
        await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        await gate.release()
        await loading.value
        XCTAssertEqual(model.chat.title, originalTitle)
        XCTAssertTrue(publications.isEmpty)
        let persisted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertNil(persisted)
        model.stopProgressObservation()
    }

    @MainActor
    func testRejectedAcceptedTurnDoesNotRecreateStreamOrStartConsumer() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-rejected-turn-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = AidenChatWriteTestGate()
        let cache = AidenChatCache(root: root, beforeChatWrite: { await gate.waitIfArmed() })
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
            if request.url?.path.hasSuffix("/turns") == true {
                return (202, "application/json", Data(#"{"turnId":"turn-recovery","streamId":"stream-recovery","status":"queued","message":{"id":"accepted-message","role":"user","text":"Hello","createdAt":"2026-09-22T00:00:00Z"}}"#.utf8))
            }
            return fixture.response(request)
        }
        await model.load()
        model.draft = "Hello"
        XCTAssertTrue(model.canSend)
        await gate.arm()
        let sending = Task { await model.send() }
        await waitForChatWrite(gate)
        await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        await gate.release()
        await sending.value
        let stream = await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        let persisted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertNil(stream)
        XCTAssertNil(persisted)
        XCTAssertTrue(fixture.eventCursors.isEmpty)
        XCTAssertFalse(model.chat.messages.contains { $0.id == "accepted-message" })
        XCTAssertNil(model.streamState)
        model.stopProgressObservation()
    }

    @MainActor
    func testRemovalBetweenChatAndStreamWritesDoesNotStartConsumer() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-stream-companion-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = AidenChatWriteTestGate()
        let cache = AidenChatCache(root: root, beforeActiveStreamWrite: { await gate.waitIfArmed() })
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
            if request.url?.path.hasSuffix("/turns") == true {
                return (202, "application/json", Data(#"{"turnId":"turn-recovery","streamId":"stream-recovery","status":"queued","message":{"id":"accepted-message","role":"user","text":"Hello","createdAt":"2026-09-22T00:00:00Z"}}"#.utf8))
            }
            return fixture.response(request)
        }
        await model.load()
        model.draft = "Hello"
        XCTAssertTrue(model.canSend)
        await gate.arm()
        let sending = Task { await model.send() }
        await waitForChatWrite(gate)
        let admitted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertTrue(admitted?.messages.contains { $0.id == "accepted-message" } == true)
        await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        await gate.release()
        await sending.value
        let stream = await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        let persisted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertNil(stream)
        XCTAssertNil(persisted)
        XCTAssertTrue(fixture.eventCursors.isEmpty)
        XCTAssertFalse(model.chat.messages.contains { $0.id == "accepted-message" })
        XCTAssertNil(model.streamState)
        model.stopProgressObservation()
    }

    @MainActor
    func testRemovalAfterFinalRetentionCheckDoesNotAdmitConsumer() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-stream-companion-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = AidenChatWriteTestGate()
        let cache = AidenChatCache(root: root)
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        model.beforeConsumerAdmission = { await gate.waitIfArmed() }
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
            if request.url?.path.hasSuffix("/turns") == true {
                return (202, "application/json", Data(#"{"turnId":"turn-recovery","streamId":"stream-recovery","status":"queued","message":{"id":"accepted-message","role":"user","text":"Hello","createdAt":"2026-09-22T00:00:00Z"}}"#.utf8))
            }
            return fixture.response(request)
        }
        await model.load()
        model.draft = "Hello"
        XCTAssertTrue(model.canSend)
        await gate.arm()
        let sending = Task { await model.send() }
        await waitForChatWrite(gate)
        let admitted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertTrue(admitted?.messages.contains { $0.id == "accepted-message" } == true)
        await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        await gate.release()
        await sending.value
        let stream = await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        let persisted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertNil(stream)
        XCTAssertNil(persisted)
        XCTAssertTrue(fixture.eventCursors.isEmpty)
        XCTAssertFalse(model.chat.messages.contains { $0.id == "accepted-message" })
        XCTAssertNil(model.streamState)
        model.stopProgressObservation()
    }

    @MainActor
    func testRemovalWhileTurnResponseIsHeldDoesNotReviveDetail() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-stream-companion-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
            if request.url?.path.hasSuffix("/turns") == true {
                return (202, "application/json", Data(#"{"turnId":"turn-recovery","streamId":"stream-recovery","status":"queued","message":{"id":"accepted-message","role":"user","text":"Hello","createdAt":"2026-09-22T00:00:00Z"}}"#.utf8))
            }
            return fixture.response(request)
        }
        await model.load()
        model.draft = "Hello"
        XCTAssertTrue(model.canSend)
        let arrived = expectation(description: "turn response held")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/turns") { arrived.fulfill() }
        defer { AidenChatProgressLifecycleURLProtocol.releaseHeldRequest() }
        let sending = Task { await model.send() }
        await fulfillment(of: [arrived], timeout: 2)
        await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        await sending.value
        let stream = await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        let persisted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertNil(stream)
        XCTAssertNil(persisted)
        XCTAssertTrue(fixture.eventCursors.isEmpty)
        XCTAssertFalse(model.chat.messages.contains { $0.id == "accepted-message" })
        XCTAssertNil(model.streamState)
        model.stopProgressObservation()
    }

    @MainActor
    func testRemovalCancelsAdmittedConsumerBeforeHeldEventsPublish() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-stream-companion-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
            if request.url?.path.hasSuffix("/turns") == true {
                return (202, "application/json", Data(#"{"turnId":"turn-recovery","streamId":"stream-recovery","status":"queued","message":{"id":"accepted-message","role":"user","text":"Hello","createdAt":"2026-09-22T00:00:00Z"}}"#.utf8))
            }
            return fixture.response(request)
        }
        await model.load()
        model.draft = "Hello"
        XCTAssertTrue(model.canSend)
        let arrived = expectation(description: "consumer events held")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/events") { arrived.fulfill() }
        defer { AidenChatProgressLifecycleURLProtocol.releaseHeldRequest() }
        await model.send()
        await fulfillment(of: [arrived], timeout: 2)
        let admitted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertTrue(admitted?.messages.contains { $0.id == "accepted-message" } == true)
        await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        for _ in 0..<10 { await Task.yield() }
        let stream = await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        let persisted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertNil(stream)
        XCTAssertNil(persisted)
        XCTAssertEqual(fixture.eventCursors, [0])
        XCTAssertEqual(model.liveText, "")
        XCTAssertFalse(model.canSend)
        XCTAssertNil(model.streamState)
        model.stopProgressObservation()
    }

    @MainActor
    func testSupersededAcceptedTurnRetainsReceiptWithoutAnotherNetworkRead() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-superseded-turn-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = AidenChatWriteTestGate()
        let cache = AidenChatCache(root: root, beforeChatWrite: { await gate.waitIfArmed() })
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
            if request.url?.path.hasSuffix("/turns") == true {
                return (202, "application/json", Data(#"{"turnId":"turn-recovery","streamId":"stream-recovery","status":"queued","message":{"id":"accepted-message","role":"user","text":"Hello","createdAt":"2026-09-22T00:00:00Z"}}"#.utf8))
            }
            return fixture.response(request)
        }
        await model.load()
        model.draft = "Hello"
        XCTAssertTrue(model.canSend)
        await gate.arm()
        let sending = Task { await model.send() }
        await waitForChatWrite(gate)
        var newer = model.chat
        newer.title = "Newer snapshot"
        try await cache.saveChat(newer, instanceId: "instance-progress-lifecycle", writeToken: cache.reserveChatWrite())
        await gate.release()
        await sending.value
        for _ in 0..<200 {
            if !fixture.eventCursors.isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let stream = await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        let persisted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertEqual(stream?.streamId, "stream-recovery")
        XCTAssertEqual(persisted?.title, "Newer snapshot")
        XCTAssertFalse(fixture.eventCursors.isEmpty)
        XCTAssertTrue(model.chat.messages.contains { $0.id == "accepted-message" })
        fixture.allowReconciliation = true
        for _ in 0..<200 {
            if await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id) == nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        model.stopProgressObservation()
    }

    @MainActor
    func testAcceptedCreateSurvivesUnrelatedRowAndEmptyListUpdates() async throws {
        for refresh in [false, true] {
            let root = FileManager.default.temporaryDirectory.appending(path: "aiden-create-interleaving-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let gate = AidenChatWriteTestGate()
            let cache = AidenChatCache(root: root, beforeChatWrite: { await gate.waitIfArmed() })
            var workspace: AidenWorkspaceChatsModel!
            var publications: [AidenChat] = []
            let detail = try await makeProgressLifecycleModel(mode: .denied, cache: cache, onCoordinator: { coordinator in
                workspace = AidenWorkspaceChatsModel(coordinator: coordinator, workspaceId: "workspace-1", cache: cache, onChatUpdated: { publications.append($0) })
            })
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(detail.chat)
            AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
                guard request.url?.path.hasSuffix("/chats") == true else { return nil }
                return request.httpMethod == "POST" ? (201, "application/json", data) : (200, "application/json", Data(#"{"chats":[]}"#.utf8))
            }
            await gate.arm()
            let creating = Task { await workspace.create() }
            await waitForChatWrite(gate)
            if refresh { await workspace.load() } else { workspace.accept(sampleChat()) }
            await gate.release()
            let created = await creating.value
            XCTAssertEqual(created?.id, detail.chat.id)
            XCTAssertTrue(workspace.chats.contains { $0.id == detail.chat.id })
            XCTAssertEqual(publications.map(\.id), [detail.chat.id])
            let list = await cache.loadChats(instanceId: "instance-progress-lifecycle", workspaceId: "workspace-1")
            XCTAssertTrue(list?.contains { $0.id == detail.chat.id } == true)
        }
    }

    @MainActor
    func testAcceptedRenameSurvivesUnrelatedRowAndEmptyListUpdates() async throws {
        for refresh in [false, true] {
            let root = FileManager.default.temporaryDirectory.appending(path: "aiden-rename-interleaving-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let gate = AidenChatWriteTestGate()
            let cache = AidenChatCache(root: root, beforeChatWrite: { await gate.waitIfArmed() })
            var workspace: AidenWorkspaceChatsModel!
            var publications: [AidenChat] = []
            let detail = try await makeProgressLifecycleModel(mode: .denied, cache: cache, onCoordinator: { coordinator in
                workspace = AidenWorkspaceChatsModel(coordinator: coordinator, workspaceId: "workspace-1", cache: cache, onChatUpdated: { publications.append($0) })
            })
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            var renamed = detail.chat
            renamed.title = "Renamed successfully"
            let data = try encoder.encode(renamed)
            AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
                guard request.url?.path.contains("/chats") == true else { return nil }
                return request.httpMethod == "PATCH" ? (200, "application/json", data) : (200, "application/json", Data(#"{"chats":[]}"#.utf8))
            }
            await gate.arm()
            let creating = Task { await workspace.rename(detail.chat, to: "Renamed successfully") }
            await waitForChatWrite(gate)
            if refresh { await workspace.load() } else { workspace.accept(sampleChat()) }
            await gate.release()
            await creating.value
            XCTAssertEqual(workspace.chats.first { $0.id == detail.chat.id }?.title, "Renamed successfully")
            XCTAssertTrue(workspace.chats.contains { $0.id == detail.chat.id })
            XCTAssertEqual(publications.map(\.id), [detail.chat.id])
            let list = await cache.loadChats(instanceId: "instance-progress-lifecycle", workspaceId: "workspace-1")
            XCTAssertTrue(list?.contains { $0.id == detail.chat.id } == true)
        }
    }

    @MainActor
    func testRejectedWorkspaceMutationDoesNotPublishOrReplaceNewerList() async throws {
        for creating in [false, true] {
            let root = FileManager.default.temporaryDirectory.appending(path: "aiden-rejected-workspace-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let gate = AidenChatWriteTestGate()
            let cache = AidenChatCache(root: root, beforeChatWrite: { await gate.waitIfArmed() })
            var workspace: AidenWorkspaceChatsModel!
            var publications: [AidenChat] = []
            let detail = try await makeProgressLifecycleModel(mode: .denied, cache: cache, onCoordinator: { coordinator in
                workspace = AidenWorkspaceChatsModel(coordinator: coordinator, workspaceId: "workspace-1", cache: cache, onChatUpdated: { publications.append($0) })
            })
            var remote = detail.chat
            remote.title = "Rejected mutation"
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(remote)
            AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
                guard request.httpMethod == "POST" || request.httpMethod == "PATCH" else { return nil }
                return (request.httpMethod == "POST" ? 201 : 200, "application/json", data)
            }
            await gate.arm()
            let mutation = Task { () -> AidenChat? in
                if creating { return await workspace.create() }
                await workspace.rename(detail.chat, to: "Requested title")
                return nil
            }
            await waitForChatWrite(gate)
            var newer = detail.chat
            newer.title = "Newer owner"
            workspace.accept(newer)
            try await cache.saveChat(newer, instanceId: "instance-progress-lifecycle", writeToken: cache.reserveChatWrite())
            await gate.release()
            let result = await mutation.value
            XCTAssertEqual(result?.title, creating ? "Newer owner" : nil)
            XCTAssertEqual(publications.map(\.title), ["Newer owner"])
            XCTAssertEqual(workspace.chats.first?.title, "Newer owner")
            let persisted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: detail.chat.id)
            XCTAssertEqual(persisted?.title, "Newer owner")
        }
    }

    @MainActor
    func testFailedDetailReadmissionKeepsDeletedChatOutOfOfflineLists() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-failed-readmission-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        let instanceId = "instance-progress-lifecycle"
        try await cache.saveChats([model.chat], instanceId: instanceId, workspaceId: "workspace-1", writeToken: cache.reserveChatWrite())
        await cache.removeChat(instanceId: instanceId, chatId: model.chat.id)
        // Make only detailed persistence fail; workspace list storage remains writable.
        let chatsDirectory = root.appending(path: "chats")
        try? FileManager.default.removeItem(at: chatsDirectory)
        try Data("not a directory".utf8).write(to: chatsDirectory)
        do {
            try await cache.saveChat(model.chat, instanceId: instanceId, writeToken: cache.reserveChatWrite())
            XCTFail("The detail write must fail")
        } catch {}
        try await cache.saveChats([model.chat], instanceId: instanceId, workspaceId: "workspace-1", writeToken: cache.reserveChatWrite())
        let reopened = AidenChatCache(root: root)
        let offline = await reopened.loadChats(instanceId: instanceId, workspaceId: "workspace-1")
        XCTAssertEqual(offline?.count, 0)
    }

    @MainActor
    func testRemovedWorkspaceMutationDoesNotPublishOrKeepOptimisticRow() async throws {
        for creating in [false, true] {
            let root = FileManager.default.temporaryDirectory.appending(path: "aiden-rejected-workspace-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let gate = AidenChatWriteTestGate()
            let cache = AidenChatCache(root: root, beforeChatWrite: { await gate.waitIfArmed() })
            var workspace: AidenWorkspaceChatsModel!
            var publications: [AidenChat] = []
            var removals: [String] = []
            let detail = try await makeProgressLifecycleModel(mode: .denied, cache: cache, onCoordinator: { coordinator in
                workspace = AidenWorkspaceChatsModel(coordinator: coordinator, workspaceId: "workspace-1", cache: cache, onChatUpdated: { publications.append($0) }, onChatRemoved: { removals.append($0) })
            })
            var remote = detail.chat
            remote.title = "Rejected mutation"
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(remote)
            AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
                guard request.httpMethod == "POST" || request.httpMethod == "PATCH" else { return nil }
                return (request.httpMethod == "POST" ? 201 : 200, "application/json", data)
            }
            try await cache.saveChats([detail.chat], instanceId: "instance-progress-lifecycle", workspaceId: "workspace-1", writeToken: cache.reserveChatWrite())
            await gate.arm()
            let mutation = Task { () -> AidenChat? in
                if creating { return await workspace.create() }
                await workspace.rename(detail.chat, to: "Requested title")
                return nil
            }
            await waitForChatWrite(gate)
            await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: detail.chat.id)
            await gate.release()
            let result = await mutation.value
            XCTAssertNil(result)
            XCTAssertTrue(publications.isEmpty)
            XCTAssertTrue(workspace.chats.isEmpty)
            XCTAssertEqual(removals, [detail.chat.id])
            let persisted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: detail.chat.id)
            XCTAssertNil(persisted)
            // A delayed list producer cannot put the removed identity back.
            try await cache.saveChats([remote], instanceId: "instance-progress-lifecycle", workspaceId: "workspace-1", writeToken: cache.reserveChatWrite())
            let reopened = AidenChatCache(root: root)
            let offline = await reopened.loadChats(instanceId: "instance-progress-lifecycle", workspaceId: "workspace-1")
            XCTAssertEqual(offline?.count, 0)
        }
    }

    @MainActor
    func testRejectedOldWorkspaceMutationCannotRemoveNewerParentRow() async throws {
        for creating in [false, true] {
            let root = FileManager.default.temporaryDirectory.appending(path: "aiden-superseded-removal-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let gate = AidenChatWriteTestGate()
            let cache = AidenChatCache(root: root, beforeChatWrite: { await gate.waitIfArmed() })
            var workspace: AidenWorkspaceChatsModel!
            var publications: [AidenChat] = []
            var removals: [String] = []
            let detail = try await makeProgressLifecycleModel(mode: .denied, cache: cache, onCoordinator: { coordinator in
                workspace = AidenWorkspaceChatsModel(coordinator: coordinator, workspaceId: "workspace-1", cache: cache, onChatUpdated: { publications.append($0) }, onChatRemoved: { removals.append($0) })
            })
            var remote = detail.chat
            remote.title = "Rejected mutation"
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(remote)
            AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
                guard request.httpMethod == "POST" || request.httpMethod == "PATCH" else { return nil }
                return (request.httpMethod == "POST" ? 201 : 200, "application/json", data)
            }
            await gate.arm()
            let mutation = Task { () -> AidenChat? in
                if creating { return await workspace.create() }
                await workspace.rename(detail.chat, to: "Requested title")
                return nil
            }
            await waitForChatWrite(gate)
            var newer = detail.chat
            newer.title = "Newer presentation"
            workspace.accept(newer)
            await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: detail.chat.id)
            await gate.release()
            let result = await mutation.value
            XCTAssertNil(result)
            XCTAssertTrue(publications.isEmpty)
            XCTAssertEqual(workspace.chats.first?.title, "Newer presentation")
            XCTAssertTrue(removals.isEmpty)
            let persisted = await cache.loadChat(instanceId: "instance-progress-lifecycle", chatId: detail.chat.id)
            XCTAssertNil(persisted)
        }
    }

    @MainActor
    func testRejectedBotPresentationUsesNewerCacheAndHonorsRemoval() async throws {
        for removed in [false, true] {
            let root = FileManager.default.temporaryDirectory.appending(path: "aiden-rejected-bot-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let gate = AidenChatWriteTestGate()
            let cache = AidenChatCache(root: root, beforeChatWrite: { await gate.waitIfArmed() })
            var coordinator: AidenRemoteCoordinator!
            let detail = try await makeProgressLifecycleModel(mode: .denied, cache: cache, onCoordinator: { coordinator = $0 })
            var remote = detail.chat
            remote.botId = "bot-test"
            remote.title = "Rejected response"
            let context = try coordinator.requestContext()
            await gate.arm()
            let presenting = Task { await aidenPersistBotChatForPresentation(remote, context: context, coordinator: coordinator, cache: cache) }
            await waitForChatWrite(gate)
            if removed {
                await cache.removeChat(instanceId: context.instanceId, chatId: remote.id)
            } else {
                var newer = remote
                newer.title = "Newer owner"
                try await cache.saveChat(newer, instanceId: context.instanceId, writeToken: cache.reserveChatWrite())
            }
            await gate.release()
            let admitted = await presenting.value
            XCTAssertEqual(admitted?.title, removed ? nil : "Newer owner")
            let persisted = await cache.loadChat(instanceId: context.instanceId, chatId: remote.id)
            XCTAssertEqual(persisted?.title, removed ? nil : "Newer owner")
        }
    }

    @MainActor
    private func waitForChatWrite(_ gate: AidenChatWriteTestGate) async {
        for _ in 0..<200 {
            if await gate.isHolding { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Expected caller to reach held chat write")
    }

    @MainActor
    func testHeldRecoveryStatusOwnsSendBeforeStreamConsumerStarts() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-held-status-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let drafts = AidenChatDraftStore(root: root.appending(path: "drafts"))
        let session = await drafts.beginSession(instanceId: "instance-progress-lifecycle", chatId: "chat-progress-lifecycle")
        _ = try await drafts.save("Visible while offline", session: session)
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache, draftStore: drafts)
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        fixture.allowReconciliation = true
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { fixture.response($0) }
        try await cache.saveActiveStream(
            .init(deviceId: "device-progress-lifecycle", streamId: "stream-recovery", turnId: "turn-recovery", lastSequence: 27),
            instanceId: "instance-progress-lifecycle", chatId: model.chat.id, chatWriteToken: cache.reserveChatWrite()
        )
        let arrived = expectation(description: "recovery status held")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/streams/stream-recovery") { arrived.fulfill() }
        defer { AidenChatProgressLifecycleURLProtocol.releaseHeldRequest() }
        let load = Task { await model.load(observeProgress: false) }
        await fulfillment(of: [arrived], timeout: 5)
        XCTAssertEqual(model.draft, "Visible while offline")
        model.draft = "Must wait for recovery"
        XCTAssertFalse(model.canSend)
        await model.send()
        XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.turnRequestCount, 0)
        let retained = await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertEqual(retained?.streamId, "stream-recovery")
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        await load.value
        for _ in 0..<200 {
            if await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id) == nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(fixture.eventCursors.isEmpty)
    }

    @MainActor
    func testCacheWriteCannotPublishPreSendSnapshotAfterSendStarts() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-held-cache-write-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let files = AidenHeldChatCacheFileManager()
        let cache = AidenChatCache(root: root, fileManager: files)
        var publications: [AidenChat] = []
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache) { publications.append($0) }
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { fixture.response($0) }
        let writing = expectation(description: "chat cache write held")
        files.holdNextChatWrite { writing.fulfill() }
        defer { files.releaseWrite() }
        let reading = expectation(description: "old GET held while empty recovery probe settles")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/chats/" + model.chat.id) { reading.fulfill() }
        let load = Task { await model.load(observeProgress: false) }
        await fulfillment(of: [reading], timeout: 5)
        model.draft = "New optimistic message"
        for _ in 0..<100 {
            if model.canSend { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(model.canSend)
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        await fulfillment(of: [writing], timeout: 5)
        let sending = expectation(description: "send held across old publication")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/turns") { sending.fulfill() }
        defer { AidenChatProgressLifecycleURLProtocol.releaseHeldRequest() }
        model.draft = "New optimistic message"
        XCTAssertTrue(model.canSend)
        let send = Task { await model.send() }
        await fulfillment(of: [sending], timeout: 5)
        files.releaseWrite()
        await load.value
        XCTAssertTrue(publications.isEmpty)
        XCTAssertEqual(model.chat.messages.last?.text, "New optimistic message")
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        await send.value
        XCTAssertFalse(files.didTimeOut)
    }

    @MainActor
    func testHeldLoadCannotOverwriteTerminalTranscriptOrCache() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-held-terminal-load-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let drafts = AidenChatDraftStore(root: root.appending(path: "drafts"))
        let session = await drafts.beginSession(instanceId: "instance-progress-lifecycle", chatId: "chat-progress-lifecycle")
        _ = try await drafts.save("Saved composer", session: session)
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache, draftStore: drafts)
        var final = model.chat
        final.messages.append(AidenChatMessage(id: "final-reply", role: .assistant, text: "Authoritative final", createdAt: Date()))
        let staleSnapshot = model.chat
        let staleWriteToken = cache.reserveChatWrite()
        let fixture = AidenStreamRecoveryFixture(chat: model.chat, finalChat: final)
        fixture.allowReconciliation = true
        fixture.allowTerminal = false
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { fixture.response($0) }
        try await cache.saveActiveStream(
            .init(deviceId: "device-progress-lifecycle", streamId: "stream-recovery", turnId: "turn-recovery", lastSequence: 27),
            instanceId: "instance-progress-lifecycle", chatId: model.chat.id, chatWriteToken: cache.reserveChatWrite()
        )
        let arrived = expectation(description: "old transcript GET held")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/chats/" + model.chat.id) { arrived.fulfill() }
        defer { AidenChatProgressLifecycleURLProtocol.releaseHeldRequest() }
        let load = Task { await model.load() }
        await fulfillment(of: [arrived], timeout: 5)
        fixture.allowTerminal = true
        for _ in 0..<200 {
            if await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id) == nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(model.chat.messages.last?.id, "final-reply")
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        await load.value
        XCTAssertEqual(model.chat.messages.last?.id, "final-reply")
        // Deliver an already-admitted old write after the terminal write. This
        // deterministically models actor mailbox reordering, not a held GET.
        try await cache.saveChat(staleSnapshot, instanceId: "instance-progress-lifecycle", writeToken: staleWriteToken)
        let reopenedCache = AidenChatCache(root: root)
        let persisted = await reopenedCache.loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertEqual(persisted?.messages.last?.id, "final-reply")
        XCTAssertEqual(model.draft, "Saved composer")
        XCTAssertNotNil(model.catalog)
        for _ in 0..<100 {
            if AidenChatProgressLifecycleURLProtocol.progressRequestCount > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertGreaterThan(AidenChatProgressLifecycleURLProtocol.progressRequestCount, 0)
        model.stopProgressObservation()
    }

    @MainActor
    func testColdStreamReplayKeepsWarmCursorWithoutPerEventPersistence() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-recovery-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { fixture.response($0) }
        try await cache.saveActiveStream(
            .init(deviceId: "device-progress-lifecycle", streamId: "stream-recovery", turnId: "turn-recovery", lastSequence: 27),
            instanceId: "instance-progress-lifecycle", chatId: model.chat.id, chatWriteToken: cache.reserveChatWrite()
        )
        await model.load(observeProgress: false)
        for _ in 0..<200 {
            if model.streamState == .done, fixture.chatReads >= 2 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(model.streamState, .done)
        model.draft = "Next turn"
        XCTAssertFalse(model.canSend)
        XCTAssertEqual(model.liveText, "prefix suffix")
        XCTAssertEqual(fixture.eventCursors, [0, 1])
        let persisted = await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertEqual(persisted?.lastSequence, 27)
        XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.turnRequestCount, 0)
        // A warm foreground load must not restart from the cold cache cursor.
        await model.load(observeProgress: false)
        XCTAssertEqual(fixture.eventCursors, [0, 1])
        XCTAssertEqual(model.liveText, "prefix suffix")
        fixture.allowReconciliation = true
        for _ in 0..<200 {
            if await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id) == nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let finished = await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertNil(finished)
        XCTAssertTrue(model.canSend)
    }

    @MainActor
    func testStopStillCancelsAnInMemoryRecoveredStream() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-recovery-stop-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { fixture.response($0) }
        try await cache.saveActiveStream(
            .init(deviceId: "device-progress-lifecycle", streamId: "stream-recovery", turnId: "turn-recovery", lastSequence: 27),
            instanceId: "instance-progress-lifecycle", chatId: model.chat.id, chatWriteToken: cache.reserveChatWrite()
        )
        await model.load(observeProgress: false)
        for _ in 0..<100 {
            if !model.liveText.isEmpty { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        XCTAssertTrue(model.isStreaming)
        await model.stop()
        XCTAssertEqual(fixture.cancelReads, 1)
        fixture.allowReconciliation = true
        for _ in 0..<200 {
            if await cache.loadActiveStream(instanceId: "instance-progress-lifecycle", chatId: model.chat.id) == nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    @MainActor
    func testReloadCannotRemovePendingOptimisticMessage() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-send-reload-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: AidenChatCache(root: root))
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { fixture.response($0) }
        await model.load(observeProgress: false)
        let arrived = expectation(description: "turn POST pending")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/turns") { arrived.fulfill() }
        defer { AidenChatProgressLifecycleURLProtocol.releaseHeldRequest() }
        model.draft = "Optimistic message"
        XCTAssertTrue(model.canSend)
        let send = Task { await model.send() }
        await fulfillment(of: [arrived], timeout: 5)
        await model.load(observeProgress: false)
        XCTAssertEqual(model.chat.messages.last?.text, "Optimistic message")
        XCTAssertTrue(model.chat.messages.last?.id.hasPrefix("local-") == true)
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        await send.value
        XCTAssertTrue(model.chat.messages.isEmpty)
        XCTAssertEqual(model.draft, "Optimistic message")
    }

    @MainActor
    func testDraftRestorationPreservesTypingDuringDiskRead() async throws {
        try await assertDraftRestoration(edit: "New message", expected: "New message")
    }

    @MainActor
    func testDraftRestorationPreservesAnIntentionalClearDuringDiskRead() async throws {
        try await assertDraftRestoration(edit: "", expected: "")
    }

    @MainActor
    func testDraftRestorationStillLoadsAnUntouchedComposer() async throws {
        try await assertDraftRestoration(edit: nil, expected: "Previously saved draft")
    }

    @MainActor
    func testDraftRestorationDoesNotAddOldTextToAnUploadedAttachment() async throws {
        try await assertDraftRestoration(edit: nil, expected: "") { model in
            let failures = await model.upload(.text(name: "fixture.txt", mimeType: "text/plain", text: "fixture"))
            XCTAssertEqual(failures, 0)
            XCTAssertEqual(model.pendingAttachments.count, 1)
            return nil
        }
    }

    @MainActor
    func testDraftRestorationStillLoadsAfterAnEmptyUploadSelection() async throws {
        try await assertDraftRestoration(edit: nil, expected: "Previously saved draft") { model in
            let failures = await model.upload([])
            XCTAssertEqual(failures, 0)
            return nil
        }
    }

    @MainActor
    func testDraftRestorationDoesNotResumeAfterRemovingAnUploadedAttachment() async throws {
        try await assertDraftRestoration(edit: nil, expected: "") { model in
            let failures = await model.upload(.text(name: "fixture.txt", mimeType: "text/plain", text: "fixture"))
            XCTAssertEqual(failures, 0)
            await model.removeAttachment(try XCTUnwrap(model.pendingAttachments.first))
            XCTAssertTrue(model.pendingAttachments.isEmpty)
            return nil
        }
    }

    @MainActor
    func testDraftRestorationDoesNotAddOldTextWhileAnUploadIsPending() async throws {
        try await assertDraftRestoration(edit: nil, expected: "") { model in
            let requested = self.expectation(description: "Attachment upload reached the server")
            AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/attachments") { requested.fulfill() }
            let upload = Task {
                let failures = await model.upload(.text(name: "fixture.txt", mimeType: "text/plain", text: "fixture"))
                XCTAssertEqual(failures, 0)
            }
            await self.fulfillment(of: [requested], timeout: 5)
            XCTAssertTrue(model.isUploadingAttachment)
            XCTAssertTrue(model.pendingAttachments.isEmpty)
            return upload
        }
    }

    @MainActor
    func testDraftRestorationDoesNotResumeAfterAnAttachmentOnlySend() async throws {
        try await assertDraftRestoration(edit: nil, expected: "") { model in
            let failures = await model.upload(.text(name: "fixture.txt", mimeType: "text/plain", text: "fixture"))
            XCTAssertEqual(failures, 0)
            XCTAssertTrue(model.canSend)
            let requested = self.expectation(description: "Attachment-only turn reached the server")
            AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/turns") { requested.fulfill() }
            let send = Task { await model.send() }
            await self.fulfillment(of: [requested], timeout: 5)
            XCTAssertTrue(model.isStarting)
            XCTAssertTrue(model.draft.isEmpty)
            XCTAssertTrue(model.pendingAttachments.isEmpty)
            return send
        }
    }

    @MainActor
    func testOverlappingPurgeWaitsForAlreadyClaimedLifetimeCleanup() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-overlapping-cleanup-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = AidenChatWriteTestGate()
        let cache = AidenChatCache(root: root)
        let lifetime = cache.registerLifetime(instanceId: "instance", chatId: "chat")
        lifetime.onRemovalCleanup = { await gate.waitIfArmed() }
        await gate.arm()
        let removing = Task { await cache.removeChat(instanceId: "instance", chatId: "chat") }
        await waitForChatWrite(gate)
        let returned = expectation(description: "purge cannot return before claimed cleanup")
        returned.isInverted = true
        var cleanupIsHeld = true
        let purgeStarted = expectation(description: "overlapping purge started")
        let purging = Task {
            purgeStarted.fulfill()
            await cache.purge(instanceId: "instance")
            if cleanupIsHeld { returned.fulfill() }
        }
        await fulfillment(of: [purgeStarted], timeout: 2)
        await fulfillment(of: [returned], timeout: 0.1)
        cleanupIsHeld = false
        await gate.release()
        await removing.value
        await purging.value
        XCTAssertTrue(lifetime.isRemoved)
    }

    @MainActor
    func testRemovalCancelsHeldDraftWriteBeforeItCanRecreateDisk() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-held-draft-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = AidenChatWriteTestGate()
        let drafts = AidenChatDraftStore(root: root.appending(path: "drafts"), beforeWrite: { await gate.waitIfArmed() })
        let cache = AidenChatCache(root: root.appending(path: "cache"))
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache, draftStore: drafts)
        let fixture = AidenStreamRecoveryFixture(chat: model.chat)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { fixture.response($0) }
        await model.load(observeProgress: false)
        await gate.arm()
        model.draft = "Must not survive removal"
        await waitForChatWrite(gate)
        let started = expectation(description: "capture scheduled draft owner")
        let completion = Task {
            started.fulfill()
            await model.waitForDraftPersistence()
        }
        await fulfillment(of: [started], timeout: 2)
        await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        await gate.release()
        await completion.value
        let reopened = AidenChatDraftStore(root: root.appending(path: "drafts"))
        let session = await reopened.beginSession(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        let persisted = await reopened.load(session: session)
        XCTAssertNil(persisted)
    }

    @MainActor
    func testRemovalRejectsCancellationIgnoringAttachmentPreparation() async throws {
        for fails in [false, true] {
            let root = FileManager.default.temporaryDirectory.appending(path: "aiden-removed-preparation-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let cache = AidenChatCache(root: root)
            let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
            let preparation = AidenHeldAttachmentPreparation()
            defer { preparation.release() }
            let started = expectation(description: "preparation held")
            let task = try XCTUnwrap(model.prepareAttachments(.success(["selection"])) { _ in
                await preparation.wait { started.fulfill() }
                if fails { throw CocoaError(.fileReadUnknown) }
                return .text(name: "fixture.txt", mimeType: "text/plain", text: "fixture")
            })
            await fulfillment(of: [started], timeout: 2)
            await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
            preparation.release()
            await task.value
            XCTAssertFalse(model.isPreparingAttachments)
            XCTAssertFalse(model.isUploadingAttachment)
            XCTAssertTrue(model.pendingAttachments.isEmpty)
            XCTAssertNil(model.presentedError)
            XCTAssertNil(model.prepareAttachments(.success(["removed"])) { _ in
                XCTFail("Removed detail cannot restart preparation")
                return .text(name: "fixture.txt", mimeType: "text/plain", text: "fixture")
            })
        }
    }

    @MainActor
    func testRemovalCancelsOwnedUploadAndRejectsHeldImageCompletion() async throws {
        try await assertRemovalJoinsUploadCleanup()
    }

    @MainActor
    func testPurgeJoinsUploadCleanup() async throws {
        try await assertRemovalJoinsUploadCleanup(purging: true)
    }

    @MainActor
    func testUploadCleanupRevocationDoesNotDeadlockRemoval() async throws {
        try await assertRemovalJoinsUploadCleanup(revokedCleanup: true)
    }

    @MainActor
    private func assertRemovalJoinsUploadCleanup(purging: Bool = false, revokedCleanup: Bool = false) async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-removed-upload-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = AidenChatWriteTestGate()
        let cache = AidenChatCache(root: root, beforeAttachmentImageWrite: { await gate.waitIfArmed() })
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        let png = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).pngData { $0.fill(CGRect(x: 0, y: 0, width: 2, height: 2)) }
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
            if request.httpMethod == "DELETE" {
                if revokedCleanup {
                    return (401, "application/json", Data(#"{"error":{"code":"credential_revoked","message":"Pair again.","requestId":"revoked-cleanup","retryable":false}}"#.utf8))
                }
                return (204, "application/json", Data())
            }
            guard request.httpMethod == "POST" else { return nil }
            return (201, "application/json", try! JSONSerialization.data(withJSONObject: [
                "id": "att_" + String(repeating: "a", count: 43), "name": "fixture.png", "mimeType": "image/png", "kind": "image", "size": png.count,
                "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)),
            ]))
        }
        await gate.arm()
        let uploading = Task { await model.upload([.image(name: "fixture.png", mimeType: "image/png", data: png), .text(name: "next.txt", mimeType: "text/plain", text: "next")]) }
        await waitForChatWrite(gate)
        let returned = expectation(description: "removal waits for remote cleanup")
        returned.isInverted = true
        var cleanupHeld = true
        let started = expectation(description: "removal started")
        let removing = Task {
            started.fulfill()
            if purging { await cache.purge(instanceId: "instance-progress-lifecycle") }
            else { await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id) }
            if cleanupHeld { returned.fulfill() }
        }
        await fulfillment(of: [started], timeout: 2)
        let deleteArrived = expectation(description: "remote DELETE held")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/attachments/att_" + String(repeating: "a", count: 43)) { deleteArrived.fulfill() }
        defer { AidenChatProgressLifecycleURLProtocol.releaseHeldRequest() }
        await gate.release()
        await fulfillment(of: [deleteArrived], timeout: 2)
        await fulfillment(of: [returned], timeout: 0.1)
        cleanupHeld = false
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        let finished = expectation(description: "upload and removal finish without self-await")
        let completion = Task { await removing.value; _ = await uploading.value; finished.fulfill() }
        await fulfillment(of: [finished], timeout: 3)
        await completion.value
        let failures = await uploading.value
        XCTAssertEqual(failures, 2)
        XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.uploadRequestCount, 1)
        XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.attachmentDeleteCount, 1)
        XCTAssertTrue(model.pendingAttachments.isEmpty)
        XCTAssertFalse(model.isUploadingAttachment)
        XCTAssertNil(model.presentedError)
        let image = AidenMessageAttachment(id: "att_" + String(repeating: "a", count: 43), name: "fixture.png", mimeType: "image/png", kind: .image, size: png.count)
        let reopened = AidenChatCache(root: root)
        let persisted = await reopened.attachmentImage(instanceId: "instance-progress-lifecycle", deviceId: "device-progress-lifecycle", chatId: model.chat.id, attachment: image)
        XCTAssertNil(persisted)
    }

    @MainActor
    func testUploadPostRevocationCompletesPurgeWithoutSelfAwait() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-upload-revocation-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        try await cache.saveChat(model.chat, instanceId: "instance-progress-lifecycle", writeToken: cache.reserveChatWrite())
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
            guard request.httpMethod == "POST" else { return nil }
            return (401, "application/json", Data(#"{"error":{"code":"credential_revoked","message":"Pair again.","requestId":"revoked-upload","retryable":false}}"#.utf8))
        }
        let finished = expectation(description: "revoked upload finishes purge")
        let task = Task {
            let failed = await model.upload([.text(name: "fixture.txt", mimeType: "text/plain", text: "fixture")])
            XCTAssertEqual(failed, 1)
            finished.fulfill()
        }
        await fulfillment(of: [finished], timeout: 3)
        await task.value
        let persisted = await AidenChatCache(root: root).loadChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        XCTAssertNil(persisted)
        XCTAssertTrue(model.pendingAttachments.isEmpty)
        XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.uploadRequestCount, 1)
    }

    @MainActor
    func testCompletedUploadsRemainOwnedThroughRemovalAndExplicitCleanup() async throws {
        for mode in ["remove", "purge", "explicit", "unpair", "consumed", "failed", "removal_wins", "invalid"] {
            let root = FileManager.default.temporaryDirectory.appending(path: "aiden-completed-upload-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let cache = AidenChatCache(root: root)
            var coordinator: AidenRemoteCoordinator!
            let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache, onCoordinator: { coordinator = $0 })
            let fixture = AidenStreamRecoveryFixture(chat: model.chat)
            AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
                if request.httpMethod == "DELETE" { return (204, "application/json", Data()) }
                if request.url?.path.hasSuffix("/turns") == true {
                    if mode == "consumed" || mode == "removal_wins" {
                        return (202, "application/json", Data(#"{"turnId":"turn-recovery","streamId":"stream-recovery","status":"queued","message":{"id":"accepted-message","role":"user","text":"Hello","createdAt":"2026-09-22T00:00:00Z"}}"#.utf8))
                    }
                    return fixture.response(request)
                }
                guard request.httpMethod == "POST" else { return fixture.response(request) }
                return (201, "application/json", try! JSONSerialization.data(withJSONObject: [
                    "id": "att_" + String(repeating: "b", count: 43), "name": "fixture.txt", "mimeType": "text/plain", "kind": "text", "size": 7,
                    "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(mode == "invalid" ? -3600 : 3600)),
                ]))
            }
            let failed = await model.upload(.text(name: "fixture.txt", mimeType: "text/plain", text: "fixture"))
            if mode == "invalid" {
                XCTAssertEqual(failed, 1)
                await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
                XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.attachmentDeleteCount, 0)
                continue
            }
            XCTAssertEqual(failed, 0)
            XCTAssertFalse(model.isUploadingAttachment)
            let reference = try XCTUnwrap(model.pendingAttachments.first)
            if mode == "removal_wins" {
                await model.load(observeProgress: false)
                model.draft = "Hello"
                let turnArrived = expectation(description: "turn receipt held")
                AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/turns") { turnArrived.fulfill() }
                let sending = Task { await model.send() }
                await fulfillment(of: [turnArrived], timeout: 2)
                let gate = AidenChatWriteTestGate()
                model.beforeRemovalAttachmentCleanup = { await gate.waitIfArmed() }
                await gate.arm()
                let removing = Task { await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id) }
                await waitForChatWrite(gate)
                AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
                await sending.value
                await gate.release()
                await removing.value
                XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.attachmentDeleteCount, 1)
                continue
            }
            if mode == "consumed" || mode == "failed" {
                await model.load(observeProgress: false)
                model.draft = "Hello"
                XCTAssertTrue(model.canSend)
                await model.send()
                XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.turnRequestCount, 1)
            }
            if mode == "consumed" {
                await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
                XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.attachmentDeleteCount, 0)
                continue
            }
            let arrived = expectation(description: "completed reference DELETE held")
            AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/attachments/" + reference.id) { arrived.fulfill() }
            defer { AidenChatProgressLifecycleURLProtocol.releaseHeldRequest() }
            var explicit: Task<Void, Never>?
            if mode == "explicit" {
                explicit = Task { await model.removeAttachment(reference) }
                await fulfillment(of: [arrived], timeout: 2)
            }
            let early = expectation(description: "removal waits for completed upload cleanup")
            early.isInverted = true
            var held = true
            let removal = Task {
                if mode == "unpair" { await coordinator.removeInstallation("instance-progress-lifecycle") }
                else if mode == "purge" { await cache.purge(instanceId: "instance-progress-lifecycle") }
                else { await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id) }
                if held { early.fulfill() }
            }
            if mode != "explicit" { await fulfillment(of: [arrived], timeout: 2) }
            await fulfillment(of: [early], timeout: 0.1)
            held = false
            AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
            await removal.value
            await explicit?.value
            XCTAssertTrue(model.pendingAttachments.isEmpty)
            XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.uploadRequestCount, 1)
            XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.attachmentDeleteCount, 1)
        }
    }

    @MainActor
    func testCallerCancellationDuringImageCacheWriteCleansAcceptedUploads() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-removed-upload-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = AidenChatWriteTestGate()
        let cache = AidenChatCache(root: root, beforeAttachmentImageWrite: { await gate.waitIfArmed() })
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        let png = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).pngData { $0.fill(CGRect(x: 0, y: 0, width: 2, height: 2)) }
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
            guard request.httpMethod == "POST" else { return nil }
            return (201, "application/json", try! JSONSerialization.data(withJSONObject: [
                "id": "att_" + String(repeating: "a", count: 43), "name": "fixture.png", "mimeType": "image/png", "kind": "image", "size": png.count,
                "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)),
            ]))
        }
        await gate.arm()
        let uploading = Task { await model.upload([.image(name: "fixture.png", mimeType: "image/png", data: png), .text(name: "next.txt", mimeType: "text/plain", text: "next")]) }
        await waitForChatWrite(gate)
        uploading.cancel()
        await gate.release()
        let failures = await uploading.value
        XCTAssertEqual(failures, 2)
        XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.uploadRequestCount, 1)
        XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.attachmentDeleteCount, 1)
        XCTAssertTrue(model.pendingAttachments.isEmpty)
        XCTAssertFalse(model.isUploadingAttachment)
        XCTAssertNil(model.presentedError)
        let image = AidenMessageAttachment(id: "att_" + String(repeating: "a", count: 43), name: "fixture.png", mimeType: "image/png", kind: .image, size: png.count)
        let reopened = AidenChatCache(root: root)
        let persisted = await reopened.attachmentImage(instanceId: "instance-progress-lifecycle", deviceId: "device-progress-lifecycle", chatId: model.chat.id, attachment: image)
        XCTAssertNil(persisted)
    }

    @MainActor
    func testRemovedDetailDoesNotReturnHeldSpeechText() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-removed-speech-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
        AidenChatProgressLifecycleURLProtocol.setResponseOverride { request in
            if request.url?.path.hasSuffix("/speech") == true {
                return (200, "application/json", Data(#"{"engine":{"ready":true,"error":null},"selectedModelId":"parakeet-v3","models":[{"id":"parakeet-v3","name":"Parakeet","description":"Local speech","sizeLabel":"620 MB","quant":"int8","languagesLabel":"25 languages","accuracy":0.8,"speed":0.85,"recommended":true,"installed":true}],"input":{"encoding":"pcm_s16le","sampleRate":16000,"channels":1,"maximumSeconds":60,"partialResults":false}}"#.utf8))
            }
            return (200, "application/json", Data(#"{"text":"late text","modelId":"parakeet-v3","durationSeconds":1}"#.utf8))
        }
        let arrived = expectation(description: "speech result held")
        AidenChatProgressLifecycleURLProtocol.holdNextRequest(endingIn: "/transcriptions") { arrived.fulfill() }
        defer { AidenChatProgressLifecycleURLProtocol.releaseHeldRequest() }
        let speech = Task { try await model.transcribeMacSpeech(Data([0, 0])) }
        await fulfillment(of: [arrived], timeout: 2)
        await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id)
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        do { _ = try await speech.value; XCTFail("Removed detail must discard speech text") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(model.draft.isEmpty)
    }

    @MainActor
    func testFileSelectionOwnsDraftBeforeDeferredPreparationOrUpload() async throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "selected-\(UUID()).txt")
        try Data("fixture".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let preparation = AidenHeldAttachmentPreparation()
        defer { preparation.release() }
        let started = expectation(description: "Selected file preparation is suspended")
        try await assertDraftRestoration(edit: nil, expected: "", afterRestore: { model in
            XCTAssertTrue(model.isPreparingAttachments)
            XCTAssertFalse(model.isUploadingAttachment)
            preparation.release()
        }) { model in
            // This is the exact synchronous entry point used by both picker
            // callbacks, with real file conversion held before its first await.
            let task = try XCTUnwrap(model.prepareAttachments(.success([file])) { url in
                await preparation.wait { started.fulfill() }
                return try await AidenAttachmentPreparation.fileUploadAsync(url: url)
            })
            XCTAssertTrue(model.isPreparingAttachments, "Selection must claim ownership before its task starts")
            await self.fulfillment(of: [started], timeout: 5)
            XCTAssertTrue(model.pendingAttachments.isEmpty)
            return Task {
                await task.value
                XCTAssertFalse(model.isPreparingAttachments)
                XCTAssertEqual(model.pendingAttachments.count, 1)
            }
        }
    }

    @MainActor
    func testSelectedAttachmentPreparationBlocksTextSendUntilItFinishes() async throws {
        let preparation = AidenHeldAttachmentPreparation()
        defer { preparation.release() }
        let started = expectation(description: "Preparation blocks Send")
        try await assertDraftRestoration(edit: "New message", expected: "New message", afterRestore: { _ in
            preparation.release()
        }) { model in
            XCTAssertTrue(model.canSend)
            let task = try XCTUnwrap(model.prepareAttachments(.success(["synthetic selection"])) { _ in
                await preparation.wait { started.fulfill() }
                return .text(name: "fixture.txt", mimeType: "text/plain", text: "fixture")
            })
            await self.fulfillment(of: [started], timeout: 5)
            XCTAssertFalse(model.canSend)
            await model.send()
            XCTAssertEqual(AidenChatProgressLifecycleURLProtocol.turnRequestCount, 0)
            return Task {
                await task.value
                XCTAssertTrue(model.canSend)
            }
        }
    }

    @MainActor
    func testEmptyAndCancelledPickerSelectionsLeaveDraftRestorationUntouched() async throws {
        for selection in [Result<[URL], Error>.success([]), .failure(CancellationError()), .failure(CocoaError(.userCancelled))] {
            try await assertDraftRestoration(edit: nil, expected: "Previously saved draft") { model in
                let task = model.prepareAttachments(selection) { _ in
                    XCTFail("An empty or cancelled picker must not prepare a file")
                    return .text(name: "fixture.txt", mimeType: "text/plain", text: "fixture")
                }
                XCTAssertNil(task)
                XCTAssertFalse(model.isPreparingAttachments)
                XCTAssertNil(model.presentedError)
                return nil
            }
        }
    }

    @MainActor
    func testCancelledPreparationCannotClearTheNextSelectionsSendBlocker() async throws {
        let oldPreparation = AidenHeldAttachmentPreparation()
        let newPreparation = AidenHeldAttachmentPreparation()
        defer { oldPreparation.release(); newPreparation.release() }
        let oldStarted = expectation(description: "Old selection is preparing")
        let newStarted = expectation(description: "New selection is preparing")
        try await assertDraftRestoration(edit: "New message", expected: "New message", afterRestore: { _ in
            newPreparation.release()
        }) { model in
            let oldTask = try XCTUnwrap(model.prepareAttachments(.success(["old selection"])) { _ in
                await oldPreparation.wait { oldStarted.fulfill() }
                return .text(name: "old.txt", mimeType: "text/plain", text: "old")
            })
            await self.fulfillment(of: [oldStarted], timeout: 5)
            model.cancelAttachmentPreparation()
            XCTAssertTrue(model.canSend)
            let newTask = try XCTUnwrap(model.prepareAttachments(.success(["new selection"])) { _ in
                await newPreparation.wait { newStarted.fulfill() }
                return .text(name: "fixture.txt", mimeType: "text/plain", text: "fixture")
            })
            await self.fulfillment(of: [newStarted], timeout: 5)
            oldPreparation.release()
            await oldTask.value
            XCTAssertTrue(model.isPreparingAttachments)
            XCTAssertFalse(model.canSend)
            XCTAssertTrue(model.pendingAttachments.isEmpty, "Cancelled conversion must not upload")
            return Task {
                await newTask.value
                XCTAssertFalse(model.isPreparingAttachments)
                XCTAssertTrue(model.canSend)
            }
        }
    }

    @MainActor
    private func assertDraftRestoration(
        edit: String?,
        expected: String,
        afterRestore: @MainActor (AidenChatViewModel) -> Void = { _ in },
        whileReading: @MainActor (AidenChatViewModel) async throws -> Task<Void, Never>? = { _ in nil }
    ) async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "draft-load-\(UUID().uuidString)")
        let fileManager = AidenHeldDraftReadFileManager()
        let draftStore = AidenChatDraftStore(root: root.appending(path: "drafts"), fileManager: fileManager)
        defer {
            fileManager.releaseRead()
            try? FileManager.default.removeItem(at: root)
            AidenChatProgressLifecycleURLProtocol.reset()
        }
        let session = await draftStore.beginSession(
            instanceId: "instance-progress-lifecycle", chatId: "chat-progress-lifecycle"
        )
        let saved = try await draftStore.save("Previously saved draft", session: session)
        XCTAssertTrue(saved)
        let model = try await makeProgressLifecycleModel(
            mode: .denied,
            cache: AidenChatCache(root: root.appending(path: "chats")),
            draftStore: draftStore
        )
        let readStarted = expectation(description: "Draft read is waiting on disk")
        fileManager.holdNextRead { readStarted.fulfill() }
        let load = Task { await model.load(observeProgress: false) }
        await fulfillment(of: [readStarted], timeout: 5)
        if let edit {
            model.draft = "Typing while restoration is pending"
            model.draft = edit
        }
        let pendingAction = try await whileReading(model)
        fileManager.releaseRead()
        await load.value
        XCTAssertFalse(fileManager.didTimeOut, "The held read must be released by the test")
        XCTAssertEqual(model.draft, expected)
        afterRestore(model)
        AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()
        await pendingAction?.value
        XCTAssertEqual(model.draft, expected, "Completing the attachment action must not revive the old draft")
        // Cancel the debounce before removing this test's temporary directory.
        model.setAllowsMutations(false)
    }

    @MainActor
    private func waitForProgressRequestCount(_ expected: Int) async throws {
        for _ in 0..<100 {
            if AidenChatProgressLifecycleURLProtocol.progressRequestCount >= expected { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for progress SSE request (expected).")
    }

    @MainActor
    private func waitForProgressObservationToStop(_ model: AidenChatViewModel) async throws {
        for _ in 0..<100 {
            if !model.isProgressObservationRunning { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for the progress observer to finish.")
    }

    @MainActor
    private func waitForAgentRequestCount(_ expected: Int) async throws {
        for _ in 0..<200 {
            if AidenChatProgressLifecycleURLProtocol.agentRequestCount >= expected { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for agent snapshot requests (expected).")
    }

    func testJumpToLatestThresholdOnlyAppearsWhenTranscriptIsMeaningfullyAboveBottom() {
        XCTAssertFalse(
            aidenChatIsScrolledAwayFromLatest(
                contentOffsetY: 0,
                containerHeight: 700,
                contentHeight: 650,
                bottomInset: 0
            )
        )
        XCTAssertFalse(
            aidenChatIsScrolledAwayFromLatest(
                contentOffsetY: 220,
                containerHeight: 700,
                contentHeight: 980,
                bottomInset: 0
            )
        )
        XCTAssertTrue(
            aidenChatIsScrolledAwayFromLatest(
                contentOffsetY: 100,
                containerHeight: 700,
                contentHeight: 980,
                bottomInset: 0
            )
        )
        XCTAssertTrue(
            aidenChatIsScrolledAwayFromLatest(
                contentOffsetY: 180,
                containerHeight: 700,
                contentHeight: 980,
                bottomInset: 24
            )
        )
    }

    func testBotBubbleIsRoundedWithoutATail() {
        let rect = CGRect(x: 0, y: 0, width: 100, height: 50)
        let bubble = AidenBotMessageBubbleShape().path(in: rect)

        XCTAssertEqual(bubble.boundingRect, rect)
        XCTAssertTrue(bubble.contains(CGPoint(x: 50, y: 25)))
        XCTAssertFalse(bubble.contains(CGPoint(x: 1, y: 1)))
        XCTAssertFalse(bubble.contains(CGPoint(x: 99, y: 49)))
    }

    func testBotMessageGroupingOnlyJoinsNearbyMessagesFromTheSameSpeaker() {
        let start = Date(timeIntervalSince1970: 1_000)
        let first = AidenChatMessage(
            id: "first",
            role: .assistant,
            text: "First",
            createdAt: start
        )
        let nearby = AidenChatMessage(
            id: "nearby",
            role: .assistant,
            text: "Second",
            createdAt: start.addingTimeInterval(30)
        )
        let later = AidenChatMessage(
            id: "later",
            role: .assistant,
            text: "Later",
            createdAt: start.addingTimeInterval(61)
        )
        let reply = AidenChatMessage(
            id: "reply",
            role: .user,
            text: "Reply",
            createdAt: start.addingTimeInterval(15)
        )

        XCTAssertTrue(aidenMessagesJoin(first, nearby))
        XCTAssertFalse(aidenMessagesJoin(first, later))
        XCTAssertFalse(aidenMessagesJoin(first, reply))
        XCTAssertFalse(aidenMessagesJoin(nil, nearby))
    }

    func testFailedSendRestoresSubmittedTextWithoutClobberingTheNextDraft() {
        XCTAssertEqual(
            AidenDraftSendReconciliation.failedDraft(submitted: "First message", current: ""),
            "First message"
        )
        XCTAssertEqual(
            AidenDraftSendReconciliation.failedDraft(
                submitted: "First message",
                current: "Next message"
            ),
            "First message\n\nNext message"
        )
    }

    @MainActor
    func testLiveChatMutationAuthorizationCanBeRevokedAndRestored() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chat = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-bot","workspaceId":"managed-home","botId":"bot-1","title":"Bot","messages":[],"createdAt":"2026-08-23T12:00:00Z","updatedAt":"2026-08-23T12:00:01Z","revision":"rev-1"}"#.utf8
            )
        )
        let model = AidenChatViewModel(
            coordinator: AidenRemoteCoordinator(),
            chat: chat,
            allowsMutations: true
        )

        XCTAssertFalse(model.isReadOnlyPresentation)
        model.setAllowsMutations(false)
        XCTAssertTrue(model.isReadOnlyPresentation)
        model.setAllowsMutations(true)
        XCTAssertFalse(model.isReadOnlyPresentation)
    }

    func testRemoteChatDecodesOptionalBotIdentityAndWorkspaceProjectionStaysDisjoint() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chats = try decoder.decode(
            [AidenChat].self,
            from: Data(
                """
                [{"id":"chat-workspace","workspaceId":"workspace-1","title":"Workspace",
                "messages":[],"createdAt":"2026-08-20T12:00:00Z",
                "updatedAt":"2026-08-20T12:00:01Z","revision":"rev-workspace"},
                {"id":"chat-bot","workspaceId":"managed-bot-home","botId":"bot-1",
                "title":"Bot","messages":[],"createdAt":"2026-08-20T12:00:00Z",
                "updatedAt":"2026-08-20T12:00:01Z","revision":"rev-bot",
                "futurePresentation":{"safe":true}}]
                """.utf8
            )
        )

        XCTAssertNil(chats[0].botId)
        XCTAssertEqual(chats[1].botId, "bot-1")
        XCTAssertFalse(chats[0].isBotChat)
        XCTAssertTrue(chats[1].isBotChat)
        XCTAssertEqual(
            AidenChat.regularWorkspaceChats(from: chats).map(\.id),
            ["chat-workspace"]
        )
    }

    func testRemoteChatRejectsMalformedPresentBotIdentity() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        for botMember in ["\"botId\":null", "\"botId\":\"\""] {
            let data = Data(
                """
                {"id":"chat-1","workspaceId":"workspace-1",\(botMember),"title":"Bot",
                "messages":[],"createdAt":"2026-08-20T12:00:00Z",
                "updatedAt":"2026-08-20T12:00:01Z","revision":"rev-1"}
                """.utf8
            )
            XCTAssertThrowsError(try decoder.decode(AidenChat.self, from: data))
        }

        let oversizedBotID = String(
            repeating: "b",
            count: AidenRemoteProtocol.maxBotIdentifierLength + 1
        )
        let oversized = Data(
            """
            {"id":"chat-1","workspaceId":"workspace-1","botId":"\(oversizedBotID)",
            "title":"Bot","messages":[],"createdAt":"2026-08-20T12:00:00Z",
            "updatedAt":"2026-08-20T12:00:01Z","revision":"rev-1"}
            """.utf8
        )
        XCTAssertThrowsError(try decoder.decode(AidenChat.self, from: oversized))
    }

    func testRemoteChatDecodesPendingBackgroundTitleAndUsesABoundedRetryWindow() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chat = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-1","workspaceId":"workspace-1","title":"Tell me about this repo","messages":[],"createdAt":"2026-08-20T12:00:00Z","updatedAt":"2026-08-20T12:00:01Z","revision":"rev_1","titlePending":true}"#.utf8
            )
        )

        XCTAssertTrue(chat.isTitlePending)
        XCTAssertFalse(AidenChatTitleReconciliation.retryMilliseconds.isEmpty)
        XCTAssertLessThanOrEqual(
            AidenChatTitleReconciliation.retryMilliseconds.reduce(0, +),
            15_000
        )
    }

    func testRemoteChatDecodesAssistantImageAttachmentsForTheSharedGallery() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chat = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-1","workspaceId":"workspace-1","title":"Image","messages":[{"id":"message-1","role":"assistant","text":"Here it is.","createdAt":"2026-08-20T12:00:00Z","attachments":[{"id":"attachment-1","name":"Result.png","mimeType":"image/png","kind":"image","size":70}]}],"createdAt":"2026-08-20T12:00:00Z","updatedAt":"2026-08-20T12:00:01Z","revision":"rev_1"}"#.utf8
            )
        )

        XCTAssertEqual(chat.messages.first?.role, .assistant)
        XCTAssertEqual(chat.messages.first?.attachments?.first?.name, "Result.png")
        XCTAssertEqual(AidenMessageMediaEdge.forRole(chat.messages.first?.role ?? .user), .leading)
    }

    func testRemoteChatDecodesHtmlArtifactsWithoutRenderingThem() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chat = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-1","workspaceId":"workspace-1","title":"Viz","messages":[{"id":"message-1","role":"assistant","text":"Chart.","createdAt":"2026-08-20T12:00:00Z","htmlArtifacts":[{"id":"html-1","title":"Dependencies"}]}],"createdAt":"2026-08-20T12:00:00Z","updatedAt":"2026-08-20T12:00:01Z","revision":"rev_1"}"#.utf8
            )
        )

        XCTAssertEqual(chat.messages.first?.htmlArtifacts?.first?.id, "html-1")
        XCTAssertEqual(chat.messages.first?.htmlArtifacts?.first?.title, "Dependencies")
        XCTAssertTrue(chat.messages.first?.htmlArtifacts?.first?.isWireSafe ?? false)
    }

    func testFormFillActivityDecodesCountOnlyOutcome() throws {
        let step = try JSONDecoder().decode(AidenAgentStep.self, from: Data(
            #"{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"form_fill","label":"Form fill","status":"completed","startedAt":1000,"updatedAt":2000,"finishedAt":2000,"contentOffset":0,"detail":"1 filled · 1 not attempted · stopped early"}"#.utf8
        ))
        XCTAssertEqual(AidenAgentActivityPresentation.line(for: step), "Form fill 1 filled · 1 not attempted · stopped early")
    }

    func testRemoteChatDecodesDurableMacActivityAndUsesMacPresentationLanguage() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chat = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-1","workspaceId":"workspace-1","title":"Activity","messages":[{"id":"message-1","role":"assistant","text":"Done.","createdAt":"2026-08-20T12:00:00Z","timeline":{"version":3,"generationId":"stream-1","status":"completed","startedAt":1000,"finishedAt":3000,"steps":[{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"read_file","label":"Read file","status":"completed","startedAt":1000,"updatedAt":1500,"finishedAt":1500,"contentOffset":0,"target":"README.md"},{"id":"think-1","order":1,"kind":"thinking","startedAt":1500,"updatedAt":2500,"finishedAt":2500,"contentOffset":0,"durationMs":1000},{"id":"tool-2","order":2,"kind":"tool","toolCallId":"call-2","toolName":"run_command","label":"Run command","status":"completed","startedAt":2500,"updatedAt":3000,"finishedAt":3000,"contentOffset":0,"detail":"Run tests"}]}}],"createdAt":"2026-08-20T12:00:00Z","updatedAt":"2026-08-20T12:00:01Z","revision":"rev_1"}"#.utf8
            )
        )

        let timeline = try XCTUnwrap(chat.messages.first?.timeline)
        XCTAssertTrue(timeline.isRendererSafe)
        XCTAssertEqual(AidenAgentActivityPresentation.line(for: timeline.steps[0]), "Read README.md")
        XCTAssertEqual(AidenAgentActivityPresentation.line(for: timeline.steps[1]), "Thought briefly")
        XCTAssertEqual(AidenAgentActivityPresentation.line(for: timeline.steps[2]), "Ran Run tests")
        XCTAssertEqual(AidenAgentActivityPresentation.summary(timeline), "Explored 1 file, ran 1 command")
    }

    func testReasoningActivityUsesOneDisclosureAndSurfacesVisualizationPhase() throws {
        let activeThinking = AidenGenerationTimeline(
            version: 3,
            generationId: "stream-thinking",
            status: .running,
            startedAt: 1_000,
            finishedAt: nil,
            steps: [
                AidenAgentStep(
                    id: "think-1",
                    order: 0,
                    kind: .thinking,
                    toolName: nil,
                    label: nil,
                    status: nil,
                    startedAt: 1_000,
                    updatedAt: 1_500,
                    finishedAt: nil,
                    contentOffset: 0,
                    durationMs: nil,
                    target: nil,
                    detail: nil,
                    lineChanges: nil
                )
            ]
        )
        XCTAssertTrue(AidenAgentActivityPresentation.hasActiveThinkingStep(activeThinking))
        XCTAssertEqual(
            AidenAgentActivityPresentation.reasoningLabel(activeThinking, active: true),
            "Thinking"
        )

        let visualizing = AidenGenerationTimeline(
            version: 3,
            generationId: "stream-visualizing",
            status: .running,
            startedAt: 1_000,
            finishedAt: nil,
            steps: [
                AidenAgentStep(
                    id: "think-1",
                    order: 0,
                    kind: .thinking,
                    toolName: nil,
                    label: nil,
                    status: nil,
                    startedAt: 1_000,
                    updatedAt: 2_000,
                    finishedAt: 2_000,
                    contentOffset: 0,
                    durationMs: 1_000,
                    target: nil,
                    detail: nil,
                    lineChanges: nil
                ),
                AidenAgentStep(
                    id: "tool-1",
                    order: 1,
                    kind: .tool,
                    toolCallId: "call-1",
                    toolName: AidenAgentActivityPresentation.renderArtifactToolName,
                    label: "Render artifact",
                    status: .running,
                    startedAt: 2_000,
                    updatedAt: 2_500,
                    finishedAt: nil,
                    contentOffset: 0,
                    durationMs: nil,
                    target: nil,
                    detail: nil,
                    lineChanges: nil
                )
            ]
        )
        XCTAssertFalse(AidenAgentActivityPresentation.hasActiveThinkingStep(visualizing))
        XCTAssertTrue(
            AidenAgentActivityPresentation.hasActiveToolStep(
                visualizing,
                named: AidenAgentActivityPresentation.renderArtifactToolName
            )
        )
        XCTAssertEqual(AidenAgentActivityPresentation.visualizingLabel(visualizing), "Visualizing")
        XCTAssertEqual(
            AidenAgentActivityPresentation.reasoningLabel(visualizing, active: false),
            "Thought briefly"
        )
        XCTAssertEqual(
            AidenAgentActivityPresentation.activitySteps(visualizing, reasoningVisible: true).map(\.kind),
            [.tool]
        )
        XCTAssertEqual(
            AidenAgentActivityPresentation.activitySteps(visualizing, reasoningVisible: false).map(\.kind),
            [.thinking, .tool]
        )
        XCTAssertNil(AidenAgentActivityPresentation.visualizingLabel(activeThinking))
    }

    func testActivityTimelineRejectsAbsoluteTargetsBeforePresentation() throws {
        let timeline = try JSONDecoder().decode(
            AidenGenerationTimeline.self,
            from: Data(
                #"{"version":3,"generationId":"stream-1","status":"running","startedAt":1000,"steps":[{"id":"tool-1","order":0,"kind":"tool","toolName":"read_file","label":"Read file","status":"running","startedAt":1000,"updatedAt":1000,"contentOffset":0,"target":"/Users/private/secret"}]}"#.utf8
            )
        )
        XCTAssertFalse(timeline.isRendererSafe)
    }

    func testActivityTimelineRejectsWindowsAbsoluteAndTraversalTargets() throws {
        for target in [#"C:\Users\private\secret"#, #"folder\..\secret"#, #"\\server\share\secret"#] {
            let timeline = AidenGenerationTimeline(
                version: 3,
                generationId: "stream-1",
                status: .running,
                startedAt: 1_000,
                finishedAt: nil,
                steps: [
                    AidenAgentStep(
                        id: "tool-1",
                        order: 0,
                        kind: .tool,
                        toolName: "read_file",
                        label: "Read file",
                        status: .running,
                        startedAt: 1_000,
                        updatedAt: 1_000,
                        finishedAt: nil,
                        contentOffset: 0,
                        durationMs: nil,
                        target: target,
                        detail: nil,
                        lineChanges: nil
                    )
                ]
            )
            XCTAssertFalse(timeline.isRendererSafe, "Expected to reject unsafe target: \(target)")
        }
    }

    func testCurrentChatRecallUsesFixedPrivateActivityLabel() {
        let browserLabels = [
            "browser": "Loaded browser tools",
            "browser_status": "Checked browser",
            "browser_open": "Opened browser",
            "browser_navigate": "Navigated browser",
            "browser_resize": "Resized browser",
            "browser_set_appearance": "Set browser appearance",
            "browser_snapshot": "Inspected browser",
            "browser_click": "Clicked in browser",
            "browser_type": "Typed in browser",
            "browser_press": "Pressed browser keys",
            "browser_scroll": "Scrolled browser",
            "browser_evaluate": "Evaluated page",
            "browser_wait_for": "Waited for page",
            "browser_recording_start": "Started browser recording",
            "browser_recording_stop": "Stopped browser recording",
        ]
        for (name, expected) in browserLabels {
            let browserStep = AidenAgentStep(
                id: name, order: 0, kind: .tool, toolName: name,
                label: name, status: .completed, startedAt: 1_000,
                updatedAt: 2_000, finishedAt: 2_000, contentOffset: 0,
                durationMs: 1_000, target: nil, detail: nil, lineChanges: nil
            )
            XCTAssertEqual(AidenAgentActivityPresentation.line(for: browserStep), expected)
        }
        let step = AidenAgentStep(
            id: "recall-1", order: 0, kind: .tool, toolName: "vcc_recall",
            label: "Recall chat history", status: .completed, startedAt: 1_000,
            updatedAt: 2_000, finishedAt: 2_000, contentOffset: 0,
            durationMs: 1_000, target: nil, detail: nil, lineChanges: nil
        )
        XCTAssertEqual(AidenAgentActivityPresentation.line(for: step), "Recalled chat history")
    }

    func testCompactionMetricsUseExistingActivityDetail() throws {
        let step = AidenAgentStep(
            id: "compact-1", order: 0, kind: .tool, toolName: "compact_context",
            label: "Compact context", status: .completed, startedAt: 1_000,
            updatedAt: 2_000, finishedAt: 2_000, contentOffset: 0,
            durationMs: 1_000, target: nil, detail: "pi-vcc · 0.4s · ~25900 → 6758 tokens", lineChanges: nil
        )
        XCTAssertEqual(AidenAgentActivityPresentation.line(for: step), "Compacted context pi-vcc · 0.4s · ~25900 → 6758 tokens")
        let decoded = try JSONDecoder().decode(AidenAgentStep.self, from: JSONEncoder().encode(step))
        XCTAssertEqual(decoded.detail, step.detail)
    }

    func testActivitySummaryMatchesMacCategories() throws {
        let timeline = AidenGenerationTimeline(
            version: 3,
            generationId: "stream-1",
            status: .completed,
            startedAt: 1_000,
            finishedAt: 2_000,
            steps: ["web_search", "computer_use", "compact_context", "custom_tool"].enumerated().map { index, name in
                AidenAgentStep(
                    id: "tool-\(index)", order: index, kind: .tool, toolName: name,
                    label: "Tool", status: .completed, startedAt: 1_000, updatedAt: 2_000,
                    finishedAt: 2_000, contentOffset: 0, durationMs: 1_000,
                    target: nil, detail: nil, lineChanges: nil
                )
            }
        )
        XCTAssertEqual(
            AidenAgentActivityPresentation.summary(timeline),
            "1 web search, 1 Mac action, compacted context, 1 tool call"
        )
    }

    func testModelCatalogHidesPresentationOnlyModelsWithoutDroppingTheirIdentity() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"google","label":"Google","models":[{"id":"gemini-pro","label":"Gemini Pro","hidden":true},{"id":"gemini-flash","label":"Gemini Flash"}]},{"id":"all-hidden","label":"Hidden","models":[{"id":"legacy","label":"Legacy","hidden":true}]}],"defaults":{"providerId":"google","modelId":"gemini-flash"}}"#.utf8
            )
        )

        XCTAssertEqual(catalog.providers.first?.models.map(\.id), ["gemini-pro", "gemini-flash"])
        XCTAssertEqual(catalog.visibleProviders.map(\.id), ["google"])
        XCTAssertEqual(catalog.visibleProviders.first?.models.map(\.id), ["gemini-flash"])
    }

    func testCustomModelOverridesPreserveImageAndVisibilityFlags() throws {
        let catalog = try JSONDecoder().decode(AidenModelCatalog.self, from: Data(
            #"{"providers":[{"id":"custom:tailnet","label":"Private","models":[{"id":"text","label":"Text","supportsImages":false},{"id":"vision","label":"Vision","supportsImages":true,"hidden":true}]}],"defaults":{}}"#.utf8
        ))
        XCTAssertFalse(try XCTUnwrap(catalog.providers.first?.models.first).acceptsImageInput)
        XCTAssertTrue(try XCTUnwrap(catalog.providers.first?.models.last).acceptsImageInput)
        XCTAssertEqual(catalog.visibleProviders.first?.models.map(\.id), ["text"])
    }

    func testModelCatalogPreservesThinkingDefaultAndRequiredThinkingPresentation() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"opencode-go","label":"OpenCode Go","models":[{"id":"ox-alpha-free","label":"Ox Alpha","supportsImages":false,"thinkingLevels":["low","high","max"],"defaultThinkingLevel":"high","thinkingCanDisable":false},{"id":"legacy","label":"Legacy","supportsImages":true,"thinkingLevels":["low","high"]}]}],"defaults":{}}"#.utf8
            )
        )

        let models = try XCTUnwrap(catalog.providers.first?.models)
        XCTAssertEqual(models[0].effectiveThinkingLevel, "high")
        XCTAssertEqual(models[0].thinkingLabel(for: "off"), "Hide")
        XCTAssertFalse(models[0].acceptsImageInput)
        XCTAssertTrue(models[1].acceptsImageInput)
        XCTAssertEqual(models[1].effectiveThinkingLevel, "high")
    }

    func testBotChatModelAuthorityPinsEachChatsPersistedPairInsteadOfCatalogDefaults() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"openai","label":"OpenAI","models":[{"id":"gpt-5.6","label":"GPT-5.6","thinkingLevels":["low","max"],"defaultThinkingLevel":"max"}]},{"id":"google","label":"Google","models":[{"id":"gemini-flash","label":"Gemini Flash"}]}],"defaults":{"providerId":"google","modelId":"gemini-flash"}}"#.utf8
            )
        )
        var chat = sampleChat()
        chat.botId = "bot-life-manager"

        let resolved = AidenChatModelAuthority.resolvedSelection(
            chat: chat,
            catalog: catalog,
            selectedProviderId: "google",
            selectedModelId: "gemini-flash",
            selectedThinkingLevel: "low"
        )
        let turn = AidenChatModelAuthority.turnSelection(
            chat: chat,
            selectedProviderId: "google",
            selectedModelId: "gemini-flash",
            selectedThinkingLevel: resolved.thinkingLevel
        )

        XCTAssertEqual(resolved.providerId, "openai")
        XCTAssertEqual(resolved.modelId, "gpt-5.6")
        XCTAssertEqual(resolved.thinkingLevel, "max")
        XCTAssertEqual(turn.providerId, "openai")
        XCTAssertEqual(turn.modelId, "gpt-5.6")
    }

    func testBotChatModelAuthorityNeverFallsBackWhenPersistedPairIsUnavailable() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"google","label":"Google","models":[{"id":"gemini-flash","label":"Gemini Flash"}]}],"defaults":{"providerId":"google","modelId":"gemini-flash"}}"#.utf8
            )
        )
        var chat = sampleChat()
        chat.botId = "bot-life-manager"
        chat.providerId = "saved-provider"
        chat.modelId = "saved-model"

        let resolved = AidenChatModelAuthority.resolvedSelection(
            chat: chat,
            catalog: catalog,
            selectedProviderId: "google",
            selectedModelId: "gemini-flash",
            selectedThinkingLevel: "high"
        )

        XCTAssertEqual(resolved.providerId, "saved-provider")
        XCTAssertEqual(resolved.modelId, "saved-model")
        XCTAssertNil(resolved.thinkingLevel)
    }

    func testBotChatModelAuthorityRemainsScopedToEachBotsSingleChat() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"openai","label":"OpenAI","models":[{"id":"gpt-5.6","label":"GPT-5.6"}]},{"id":"google","label":"Google","models":[{"id":"gemini-flash","label":"Gemini Flash"}]}],"defaults":{"providerId":"google","modelId":"gemini-flash"}}"#.utf8
            )
        )
        var firstChat = sampleChat()
        firstChat.botId = "bot-life-manager"
        firstChat.providerId = "openai"
        firstChat.modelId = "gpt-5.6"
        var secondChat = sampleChat()
        secondChat.botId = "bot-travel"
        secondChat.providerId = "google"
        secondChat.modelId = "gemini-flash"

        let firstSelection = AidenChatModelAuthority.resolvedSelection(
            chat: firstChat,
            catalog: catalog,
            selectedProviderId: secondChat.providerId,
            selectedModelId: secondChat.modelId,
            selectedThinkingLevel: nil
        )
        let secondSelection = AidenChatModelAuthority.resolvedSelection(
            chat: secondChat,
            catalog: catalog,
            selectedProviderId: firstChat.providerId,
            selectedModelId: firstChat.modelId,
            selectedThinkingLevel: nil
        )

        XCTAssertEqual(firstSelection.providerId, "openai")
        XCTAssertEqual(firstSelection.modelId, "gpt-5.6")
        XCTAssertEqual(secondSelection.providerId, "google")
        XCTAssertEqual(secondSelection.modelId, "gemini-flash")
    }

    func testWorkspaceChatModelAuthorityRetainsExistingCatalogFallbackBehavior() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"google","label":"Google","models":[{"id":"gemini-flash","label":"Gemini Flash"}]}],"defaults":{"providerId":"google","modelId":"gemini-flash"}}"#.utf8
            )
        )
        let chat = sampleChat()

        let resolved = AidenChatModelAuthority.resolvedSelection(
            chat: chat,
            catalog: catalog,
            selectedProviderId: "missing-provider",
            selectedModelId: "missing-model",
            selectedThinkingLevel: nil
        )
        let turn = AidenChatModelAuthority.turnSelection(
            chat: chat,
            selectedProviderId: resolved.providerId,
            selectedModelId: resolved.modelId,
            selectedThinkingLevel: resolved.thinkingLevel
        )

        XCTAssertEqual(resolved.providerId, "google")
        XCTAssertEqual(resolved.modelId, "gemini-flash")
        XCTAssertEqual(turn.providerId, "google")
        XCTAssertEqual(turn.modelId, "gemini-flash")
    }

    func testModelCatalogKeepsNormalizedCustomProviderArtworkThroughVisibleProjection() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"custom:server","label":"Server","artwork":{"mimeType":"image/png","dataBase64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="},"models":[{"id":"chat","label":"Chat"}]}],"defaults":{}}"#.utf8
            )
        )

        XCTAssertEqual(catalog.visibleProviders.first?.artwork?.mimeType, "image/png")
        XCTAssertNotNil(catalog.visibleProviders.first?.artwork?.boundedPNGData)

        var oversizedHeader = Data(repeating: 0, count: 24)
        oversizedHeader.replaceSubrange(0..<8, with: [137, 80, 78, 71, 13, 10, 26, 10])
        oversizedHeader.replaceSubrange(12..<16, with: [73, 72, 68, 82])
        oversizedHeader.replaceSubrange(16..<20, with: [0, 0, 0, 65])
        oversizedHeader.replaceSubrange(20..<24, with: [0, 0, 0, 1])
        XCTAssertNil(
            AidenProviderArtwork(
                mimeType: "image/png",
                dataBase64: oversizedHeader.base64EncodedString()
            ).boundedPNGData
        )
    }

    func testRelativeTimestampUsesProductSpecificBoundaries() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now, now: now), "just now")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-59), now: now), "just now")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-60), now: now), "1 min ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-120), now: now), "2 mins ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-3_600), now: now), "1 hr ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-7_200), now: now), "2 hrs ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-86_400), now: now), "1 day ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-172_800), now: now), "2 days ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(30), now: now), "just now")
    }

    func testNewAgentPopoverKeepsTheThreeReviewedWorkspaceChoices() {
        XCTAssertEqual(
            AidenNewAgentChoice.allCases,
            [.existingWorkspace, .newWorkspace, .scratchWorkspace]
        )
        XCTAssertEqual(
            AidenNewAgentChoice.allCases.map(\.title),
            ["Existing Workspace", "New Workspace", "Managed Scratch Workspace"]
        )
        XCTAssertEqual(
            AidenNewAgentChoice.allCases.map(\.symbol),
            ["folder", "folder.badge.plus", "hammer.fill"]
        )
        XCTAssertTrue(AidenNewAgentChoice.allCases.allSatisfy { !$0.detail.isEmpty })
    }

    func testProviderIconResolverMatchesDesktopAliasesAndFallbackRules() {
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "openai"), "openai")
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "concentrate"), "concentrate")
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "gemini"), "google")
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "moonshot"), "moonshotai")
        XCTAssertEqual(
            AidenProviderIconResolver.slug(providerID: "anthropic", modelID: "claude-sonnet-4"),
            "claude"
        )
        XCTAssertEqual(
            AidenProviderIconResolver.slug(providerID: "xai", modelID: "grok-4-fast"),
            "grok"
        )
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "custom:lmstudio-2"), "lmstudio")
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "custom:ollama-42"), "ollama")
        XCTAssertNil(AidenProviderIconResolver.slug(providerID: "custom:lmstudio-1"))
        XCTAssertNil(AidenProviderIconResolver.slug(providerID: "future-provider"))
    }

    func testAgentReplyCopyKeepsOriginalMarkdownAndRejectsNonReplies() {
        let assistant = AidenChatMessage(
            id: "assistant-1",
            role: .assistant,
            text: "## Result\n\nUse `xcodebuild test`.",
            createdAt: Date(timeIntervalSince1970: 1)
        )
        let user = AidenChatMessage(
            id: "user-1",
            role: .user,
            text: "Please test it",
            createdAt: Date(timeIntervalSince1970: 2)
        )
        let emptyAssistant = AidenChatMessage(
            id: "assistant-2",
            role: .assistant,
            text: "",
            createdAt: Date(timeIntervalSince1970: 3)
        )

        XCTAssertEqual(
            AidenMessageActionContent.copyText(for: assistant),
            "## Result\n\nUse `xcodebuild test`."
        )
        XCTAssertNil(AidenMessageActionContent.copyText(for: user))
        XCTAssertNil(AidenMessageActionContent.copyText(for: emptyAssistant))
    }

    func testBotReplyKeepsOnlyPostToolFinalTextVisible() {
        let progress = "Checking the workspace 🍎\n\nI found the destination.\n\n"
        let final = "## Done\n\nThe repository is ready."
        let timeline = AidenGenerationTimeline(
            version: 3,
            generationId: "stream-1",
            status: .completed,
            startedAt: 1_000,
            finishedAt: 2_000,
            steps: [
                AidenAgentStep(
                    id: "tool-1", order: 0, kind: .tool, toolName: "list_dir",
                    label: "List directory", status: .completed,
                    startedAt: 1_000, updatedAt: 1_500, finishedAt: 1_500,
                    contentOffset: 0, durationMs: nil, target: nil,
                    detail: nil, lineChanges: nil
                ),
                AidenAgentStep(
                    id: "tool-2", order: 1, kind: .tool, toolName: "run_command",
                    label: "Run command", status: .completed,
                    startedAt: 1_500, updatedAt: 2_000, finishedAt: 2_000,
                    contentOffset: progress.utf16.count, durationMs: nil, target: nil,
                    detail: "Clone repository", lineChanges: nil
                )
            ]
        )

        let projection = AidenBotReplyProjection.resolve(
            text: progress + final,
            timeline: timeline,
            isActive: false
        )

        XCTAssertEqual(projection.progressText, progress.trimmingCharacters(in: .whitespacesAndNewlines))
        XCTAssertEqual(projection.finalText, final)

        let message = AidenChatMessage(
            id: "assistant-bot",
            role: .assistant,
            text: progress + final,
            timeline: timeline,
            createdAt: Date(timeIntervalSince1970: 1)
        )
        XCTAssertEqual(
            AidenMessageActionContent.copyText(for: message, presentationStyle: .botMessages),
            final
        )
        XCTAssertEqual(
            AidenMessageActionContent.copyText(for: message, presentationStyle: .workspace),
            progress + final
        )
    }

    func testActiveBotReplyCollapsesAndDeduplicatesProgressUntilTerminal() {
        let repeated = "Locating the workspace.\n\nLocating   the workspace.\n\nRunning the clone."
        let projection = AidenBotReplyProjection.resolve(
            text: repeated,
            timeline: nil,
            isActive: true
        )

        XCTAssertEqual(projection.finalText, "")
        XCTAssertEqual(projection.progressText, "Locating the workspace.\n\nRunning the clone.")
    }

    func testBotReplyWithoutToolActivityRemainsAVisibleFinalAnswer() {
        let timeline = AidenGenerationTimeline(
            version: 3,
            generationId: "stream-plain",
            status: .completed,
            startedAt: 1_000,
            finishedAt: 1_100,
            steps: []
        )
        let projection = AidenBotReplyProjection.resolve(
            text: "A direct answer.",
            timeline: timeline,
            isActive: false
        )

        XCTAssertEqual(projection.finalText, "A direct answer.")
        XCTAssertEqual(projection.progressText, "")
    }

    func testMarkdownDocumentParsesHeadingsListsAndInlineEmphasis() {
        let markdown = """
        I'll explore the repository to understand what it is.

        ## Long Live Kodak 📷

        - **Film Frame Editor** — adjustable parameters
        - `Batch processing` and export
        """

        let plainText = AidenMarkdownDocument.plainText(from: markdown)
        XCTAssertTrue(plainText.hasPrefix("I'll explore"))
        XCTAssertTrue(plainText.contains("Long Live Kodak 📷"))
        XCTAssertTrue(plainText.contains("Film Frame Editor — adjustable parameters"))
        XCTAssertTrue(plainText.contains("Batch processing and export"))
        XCTAssertFalse(plainText.contains("##"))
        XCTAssertFalse(plainText.contains("**"))
        XCTAssertFalse(plainText.contains("`"))
    }

    func testMarkdownRenderingPolicyBoundsCharactersAndCrossPlatformLineBreaks() {
        XCTAssertNil(AidenMarkdownRenderingPolicy.fallbackReason(
            for: String(repeating: "a", count: AidenMarkdownRenderingPolicy.maximumCharacterCount)
        ))
        XCTAssertEqual(
            AidenMarkdownRenderingPolicy.fallbackReason(
                for: String(repeating: "a", count: AidenMarkdownRenderingPolicy.maximumCharacterCount + 1)
            ),
            .tooManyCharacters
        )

        let allowedLines = Array(
            repeating: "line",
            count: AidenMarkdownRenderingPolicy.maximumLineCount
        ).joined(separator: "\r\n")
        XCTAssertNil(AidenMarkdownRenderingPolicy.fallbackReason(for: allowedLines))
        XCTAssertEqual(
            AidenMarkdownRenderingPolicy.fallbackReason(for: allowedLines + "\u{2028}overflow"),
            .tooManyLines
        )
    }

    @MainActor
    func testMarkdownViewRendersBlockContentAtTheFullProposedWidth() throws {
        let renderer = ImageRenderer(content: AidenMarkdownView(content: """
        ## Heading

        - First item
        - Second item
        """).frame(width: 320))
        renderer.scale = 1

        let image = try XCTUnwrap(renderer.uiImage)
        XCTAssertEqual(image.size.width, 320, accuracy: 0.5)
        XCTAssertGreaterThan(try XCTUnwrap(image.pngData()).count, 1_000)
    }

    @MainActor
    func testUserTextStaysContentSizedWhileAssistantMarkdownUsesTranscriptWidth() {
        let userHost = UIHostingController(rootView: AidenMessageTextView(
            role: .user,
            content: "Short prompt"
        ))
        let assistantHost = UIHostingController(rootView: AidenMessageTextView(
            role: .assistant,
            content: "A short reply"
        ))
        let proposal = CGSize(width: 320, height: 1_000)

        let userSize = userHost.sizeThatFits(in: proposal)
        let assistantSize = assistantHost.sizeThatFits(in: proposal)

        XCTAssertLessThan(userSize.width, 200)
        XCTAssertEqual(assistantSize.width, proposal.width, accuracy: 0.5)
    }

    @MainActor
    func testAssistantMarkdownKeepsTheFirstGlyphInsideItsRenderedBounds() throws {
        let renderer = ImageRenderer(content: AidenMessageTextView(
            role: .assistant,
            content: "Sounds good — the first letter must remain visible."
        ).frame(width: 320, alignment: .leading))
        renderer.scale = 3

        let image = try XCTUnwrap(renderer.cgImage)
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        let firstPaintedColumn = (0..<width).first { x in
            (0..<height).contains { y in pixels[((y * width + x) * 4) + 3] > 8 }
        }
        XCTAssertGreaterThan(try XCTUnwrap(firstPaintedColumn), 0)
    }

    func testSSEParserAcceptsCanonicalFrameAndRejectsIdentityMismatches() throws {
        let json = eventJSON(sequence: 1, type: "text_delta", payload: "{\"text\":\"Hello\"}")
        var parser = AidenSSEParser()
        XCTAssertNil(try parser.consume(line: "id: 1"))
        XCTAssertNil(try parser.consume(line: "event: text_delta"))
        XCTAssertNil(try parser.consume(line: "data: \(json)"))
        let event = try XCTUnwrap(parser.consume(line: ""))
        XCTAssertEqual(event.sequence, 1)
        XCTAssertEqual(event.payload?.text, "Hello")

        var wrongID = AidenSSEParser()
        _ = try wrongID.consume(line: "id: 2")
        _ = try wrongID.consume(line: "data: \(json)")
        XCTAssertThrowsError(try wrongID.consume(line: "")) {
            XCTAssertEqual($0 as? AidenSSEParserError, .eventIDMismatch)
        }

        var wrongName = AidenSSEParser()
        _ = try wrongName.consume(line: "id: 1")
        _ = try wrongName.consume(line: "event: reasoning_delta")
        _ = try wrongName.consume(line: "data: \(json)")
        XCTAssertThrowsError(try wrongName.consume(line: "")) {
            XCTAssertEqual($0 as? AidenSSEParserError, .eventNameMismatch)
        }
    }

    func testSSEParserRejectsDuplicateJSONKeysAndOversizedFrames() throws {
        let duplicate = """
        {"protocolVersion":1,"streamId":"stream-1","sequence":1,"sequence":1,
        "timestamp":"2026-08-19T07:00:00.000Z","type":"heartbeat","terminal":false,"payload":{}}
        """
        var parser = AidenSSEParser()
        _ = try parser.consume(line: "id: 1")
        _ = try parser.consume(line: "data: \(duplicate)")
        XCTAssertThrowsError(try parser.consume(line: "")) {
            guard case .duplicateJSONKey("sequence") = $0 as? AidenRemoteContractError else {
                return XCTFail("Expected duplicate key rejection, received \($0)")
            }
        }

        var oversized = AidenSSEParser()
        XCTAssertThrowsError(
            try oversized.consume(line: String(repeating: "x", count: AidenRemoteProtocol.maxSSEFrameBytes + 1))
        ) {
            XCTAssertEqual($0 as? AidenSSEParserError, .frameTooLarge)
        }
    }

    func testStreamCompanionRetainsReceiptAcrossNewerWritesButNotDeletion() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-stream-authority-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let chat = sampleChat()
        let token = cache.reserveChatWrite()
        try await cache.saveChat(chat, instanceId: "instance-a", writeToken: token)
        try await cache.saveChat(chat, instanceId: "instance-a", writeToken: cache.reserveChatWrite())
        let stream = AidenChatCache.ActiveStream(deviceId: "device-a", streamId: "stream-a", turnId: "turn-a", lastSequence: 0)
        let admitted = try await cache.saveActiveStream(stream, instanceId: "instance-a", chatId: chat.id, chatWriteToken: token)
        XCTAssertTrue(admitted)
        await cache.removeChat(instanceId: "instance-a", chatId: chat.id)
        XCTAssertFalse(cache.isChatWriteRetained(token, instanceId: "instance-a", chatId: chat.id))
        let rejected = try await cache.saveActiveStream(stream, instanceId: "instance-a", chatId: chat.id, chatWriteToken: token)
        XCTAssertFalse(rejected)
        XCTAssertTrue(cache.isChatWriteRetained(token, instanceId: "instance-b", chatId: chat.id))
        let newToken = cache.reserveChatWrite()
        XCTAssertTrue(cache.isChatWriteRetained(newToken, instanceId: "instance-a", chatId: chat.id))
        await cache.purge(instanceId: "instance-a")
        XCTAssertFalse(cache.isChatWriteRetained(newToken, instanceId: "instance-a", chatId: chat.id))
    }

    func testChatWriteFencesSurviveRemovalAndPurgeWithoutCrossingInstances() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "aiden-chat-write-fence-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let chat = sampleChat()
        let beforeRemoval = cache.reserveChatWrite()
        let independent = cache.reserveChatWrite()
        await cache.removeChat(instanceId: "instance-a", chatId: chat.id)
        try await cache.saveChat(chat, instanceId: "instance-a", writeToken: beforeRemoval)
        let removed = await cache.loadChat(instanceId: "instance-a", chatId: chat.id)
        XCTAssertNil(removed)
        var recreated = chat
        recreated.title = "Recreated chat"
        try await cache.saveChat(recreated, instanceId: "instance-a", writeToken: cache.reserveChatWrite())
        try await cache.saveChat(chat, instanceId: "instance-a", writeToken: beforeRemoval)
        let latest = await cache.loadChat(instanceId: "instance-a", chatId: chat.id)
        XCTAssertEqual(latest?.title, "Recreated chat")
        try await cache.saveChat(chat, instanceId: "instance-b", writeToken: independent)
        let other = await cache.loadChat(instanceId: "instance-b", chatId: chat.id)
        XCTAssertEqual(other?.id, chat.id)

        let beforePurge = cache.reserveChatWrite()
        await cache.purge(instanceId: "instance-a")
        try await cache.saveChat(chat, instanceId: "instance-a", writeToken: beforePurge)
        let purged = await cache.loadChat(instanceId: "instance-a", chatId: chat.id)
        XCTAssertNil(purged)
        // A later view model uses the cache's clock, not a counter reset to zero.
        try await cache.saveChat(chat, instanceId: "instance-a", writeToken: cache.reserveChatWrite())
        let restored = await cache.loadChat(instanceId: "instance-a", chatId: chat.id)
        XCTAssertEqual(restored?.id, chat.id)
    }

    func testChatCacheIsScopedByInstallationAndRestoresStreamCursor() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-chat-cache-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let chat = sampleChat()

        try await cache.saveChats([chat], instanceId: "instance-a", workspaceId: "workspace-1", writeToken: cache.reserveChatWrite())
        try await cache.saveChat(chat, instanceId: "instance-a", writeToken: cache.reserveChatWrite())
        try await cache.saveActiveStream(
            .init(deviceId: "device-a", streamId: "stream-1", turnId: "turn-1", lastSequence: 14),
            instanceId: "instance-a",
            chatId: chat.id, chatWriteToken: cache.reserveChatWrite()
        )
        try await cache.saveChats([chat], instanceId: "instance-b", workspaceId: "workspace-1", writeToken: cache.reserveChatWrite())
        try await cache.saveActiveStream(
            .init(deviceId: "device-b", streamId: "stream-2", turnId: "turn-2", lastSequence: 3),
            instanceId: "instance-b",
            chatId: chat.id, chatWriteToken: cache.reserveChatWrite()
        )

        let chatsA = await cache.loadChats(instanceId: "instance-a", workspaceId: "workspace-1")
        let chatsB = await cache.loadChats(instanceId: "instance-b", workspaceId: "workspace-1")
        let cachedChatA = await cache.loadChat(instanceId: "instance-a", chatId: chat.id)
        let cachedChatB = await cache.loadChat(instanceId: "instance-b", chatId: chat.id)
        let stream = await cache.loadActiveStream(instanceId: "instance-a", chatId: chat.id)
        XCTAssertEqual(chatsA, [chat])
        XCTAssertEqual(chatsB, [chat])
        XCTAssertEqual(cachedChatA, chat)
        XCTAssertNil(cachedChatB)
        XCTAssertEqual(
            stream,
            .init(deviceId: "device-a", streamId: "stream-1", turnId: "turn-1", lastSequence: 14)
        )

        await cache.removeChat(instanceId: "instance-a", chatId: chat.id)
        let removedChat = await cache.loadChat(instanceId: "instance-a", chatId: chat.id)
        let removedStream = await cache.loadActiveStream(instanceId: "instance-a", chatId: chat.id)
        XCTAssertNil(removedChat)
        XCTAssertNil(removedStream)

        let legacyStreamURL = root
            .appending(path: "streams", directoryHint: .isDirectory)
            .appending(path: "legacy-stream.json")
        try Data("""
        {"instanceId":"instance-a","chatId":"legacy-chat","stream":{
        "streamId":"legacy-stream","turnId":"legacy-turn","lastSequence":2}}
        """.utf8).write(to: legacyStreamURL, options: .atomic)

        await cache.purge(instanceId: "instance-a")
        let purgedChats = await cache.loadChats(instanceId: "instance-a", workspaceId: "workspace-1")
        let retainedChats = await cache.loadChats(instanceId: "instance-b", workspaceId: "workspace-1")
        let retainedActiveStream = await cache.loadActiveStream(instanceId: "instance-b", chatId: chat.id)
        XCTAssertNil(purgedChats)
        XCTAssertNotNil(retainedChats)
        XCTAssertNotNil(retainedActiveStream)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyStreamURL.path))
    }

    func testInstallationPurgeClearsV1AndV2CachesWithoutTouchingAnotherInstallation() async throws {
        let base = FileManager.default.temporaryDirectory
            .appending(path: "aiden-versioned-chat-cache-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: base) }
        let legacyRoot = base.appending(path: "RemoteChatCache-v1", directoryHint: .isDirectory)
        let currentRoot = base.appending(path: "RemoteChatCache-v2", directoryHint: .isDirectory)
        let legacyCache = AidenChatCache(root: legacyRoot)
        let currentCache = AidenChatCache(root: currentRoot, legacyRoots: [legacyRoot])
        let chat = sampleChat()

        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        let png = renderer.pngData { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let attachment = AidenMessageAttachment(
            id: "attachment-versioned-cache",
            name: "Versioned.png",
            mimeType: "image/png",
            kind: .image,
            size: png.count
        )

        for cache in [legacyCache, currentCache] {
            try await cache.saveChats([chat], instanceId: "instance-a", workspaceId: chat.workspaceId, writeToken: cache.reserveChatWrite())
            try await cache.saveChat(chat, instanceId: "instance-a", writeToken: cache.reserveChatWrite())
            try await cache.saveActiveStream(
                .init(deviceId: "device-a", streamId: "stream-a", turnId: "turn-a", lastSequence: 1),
                instanceId: "instance-a",
                chatId: chat.id, chatWriteToken: cache.reserveChatWrite()
            )
            try await cache.saveAttachmentImage(
                png,
                instanceId: "instance-a",
                deviceId: "device-a",
                chatId: chat.id,
                attachment: attachment,
            writeToken: cache.reserveChatWrite()
            )

            try await cache.saveChats([chat], instanceId: "instance-b", workspaceId: chat.workspaceId, writeToken: cache.reserveChatWrite())
            try await cache.saveChat(chat, instanceId: "instance-b", writeToken: cache.reserveChatWrite())
            try await cache.saveActiveStream(
                .init(deviceId: "device-b", streamId: "stream-b", turnId: "turn-b", lastSequence: 2),
                instanceId: "instance-b",
                chatId: chat.id, chatWriteToken: cache.reserveChatWrite()
            )
            try await cache.saveAttachmentImage(
                png,
                instanceId: "instance-b",
                deviceId: "device-b",
                chatId: chat.id,
                attachment: attachment,
            writeToken: cache.reserveChatWrite()
            )
        }

        await currentCache.purge(instanceId: "instance-a")

        for cache in [legacyCache, currentCache] {
            let removedList = await cache.loadChats(instanceId: "instance-a", workspaceId: chat.workspaceId)
            let removedChat = await cache.loadChat(instanceId: "instance-a", chatId: chat.id)
            let removedStream = await cache.loadActiveStream(instanceId: "instance-a", chatId: chat.id)
            let removedAttachment = await cache.attachmentImage(
                instanceId: "instance-a",
                deviceId: "device-a",
                chatId: chat.id,
                attachment: attachment
            )
            XCTAssertNil(removedList)
            XCTAssertNil(removedChat)
            XCTAssertNil(removedStream)
            XCTAssertNil(removedAttachment)

            let retainedList = await cache.loadChats(instanceId: "instance-b", workspaceId: chat.workspaceId)
            let retainedChat = await cache.loadChat(instanceId: "instance-b", chatId: chat.id)
            let retainedStream = await cache.loadActiveStream(instanceId: "instance-b", chatId: chat.id)
            let retainedAttachment = await cache.attachmentImage(
                instanceId: "instance-b",
                deviceId: "device-b",
                chatId: chat.id,
                attachment: attachment
            )
            XCTAssertEqual(retainedList, [chat])
            XCTAssertEqual(retainedChat, chat)
            XCTAssertEqual(retainedStream?.streamId, "stream-b")
            XCTAssertEqual(retainedAttachment, png)
        }
    }

    func testChatSummaryCacheIsInstallationScopedAndReconcilesMutations() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-summary-cache-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let chat = sampleChat()
        let activeSummary = AidenChatSummary(chat: chat, preservingActivity: .active)
        let cursor = "cur_page_2." + String(repeating: "C", count: 43)
        try await cache.saveChatSummaries(
            .init(summaries: [activeSummary], nextCursor: cursor),
            instanceId: "instance-a", writeToken: cache.reserveChatWrite()
        )
        try await cache.saveChatSummaries(
            .init(summaries: [], nextCursor: nil),
            instanceId: "instance-b", writeToken: cache.reserveChatWrite()
        )

        let cachedA = await cache.loadChatSummaries(instanceId: "instance-a")
        let cachedB = await cache.loadChatSummaries(instanceId: "instance-b")
        XCTAssertEqual(cachedA?.summaries, [activeSummary])
        XCTAssertEqual(cachedB?.summaries, [])

        var renamed = chat
        renamed.title = "Renamed from detail"
        renamed.revision = "legacy-revision-2"
        renamed.updatedAt = chat.updatedAt.addingTimeInterval(1)
        try await cache.reconcileChatSummary(renamed, instanceId: "instance-a", writeToken: cache.reserveChatWrite())
        let reconciled = await cache.loadChatSummaries(instanceId: "instance-a")
        XCTAssertEqual(reconciled?.summaries.first?.title, "Renamed from detail")
        XCTAssertEqual(reconciled?.summaries.first?.revision, "legacy-revision-2")
        XCTAssertEqual(reconciled?.summaries.first?.activity, .active)
        XCTAssertEqual(reconciled?.nextCursor, cursor)

        await cache.removeChat(instanceId: "instance-a", chatId: chat.id)
        let removedA = await cache.loadChatSummaries(instanceId: "instance-a")
        let retainedB = await cache.loadChatSummaries(instanceId: "instance-b")
        XCTAssertEqual(removedA?.summaries, [])
        XCTAssertEqual(retainedB?.summaries, [])
    }

    func testSummaryCacheSupportsMaximumBoundedProjectionAndRevalidatesFields() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-summary-max-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let base = Date(timeIntervalSince1970: 5_000)
        let maximumTitle = String(repeating: "🧪", count: 1_024)
        let summaries = (0..<10_000).map { index in
            AidenChatSummary(
                id: String(format: "chat-%05d", index),
                workspaceId: "workspace-maximum",
                title: maximumTitle,
                titlePending: false,
                createdAt: base,
                updatedAt: base.addingTimeInterval(TimeInterval(10_000 - index)),
                revision: "rev_" + String(repeating: "M", count: 43),
                activity: .idle
            )
        }
        try await cache.saveChatSummaries(
            .init(summaries: summaries, nextCursor: nil),
            instanceId: "instance-maximum", writeToken: cache.reserveChatWrite()
        )
        let hydrated = await cache.loadChatSummaries(instanceId: "instance-maximum")
        XCTAssertEqual(hydrated?.summaries.count, 10_000)
        XCTAssertEqual(hydrated?.summaries.first?.title.unicodeScalars.count, 1_024)

        let invalid = AidenChatSummary(
            id: "unsafe/id",
            workspaceId: "workspace-maximum",
            title: "Invalid cache projection",
            titlePending: false,
            createdAt: base,
            updatedAt: base,
            revision: "legacy-revision",
            activity: .idle
        )
        XCTAssertFalse(AidenChatSummary.isValidCachedProjection(invalid))
        do {
            try await cache.saveChatSummaries(
                .init(summaries: [invalid], nextCursor: nil),
                instanceId: "instance-invalid", writeToken: cache.reserveChatWrite()
            )
            XCTFail("Invalid cached summary fields must fail before persistence.")
        } catch {}
    }

    func testChatSummaryPaginationMergeReplacesCanonicalActivityWithoutDuplicates() throws {
        let now = Date(timeIntervalSince1970: 2_000)
        let stale = AidenChatSummary(
            id: "chat-a",
            workspaceId: "workspace-a",
            title: "Stale",
            titlePending: true,
            createdAt: now,
            updatedAt: now.addingTimeInterval(1),
            revision: "revision-1",
            activity: .active
        )
        let canonical = AidenChatSummary(
            id: "chat-a",
            workspaceId: "workspace-a",
            title: "Canonical",
            titlePending: false,
            createdAt: now,
            updatedAt: now.addingTimeInterval(3),
            revision: "revision-2",
            activity: .idle
        )
        let second = AidenChatSummary(
            id: "chat-b",
            workspaceId: "workspace-a",
            title: "Second",
            titlePending: false,
            createdAt: now,
            updatedAt: now.addingTimeInterval(2),
            revision: "revision-1",
            activity: .active
        )

        let merged = AidenChatSummaryPage.merged(current: [stale], appending: [second, canonical])
        XCTAssertEqual(merged.map(\.id), ["chat-a", "chat-b"])
        XCTAssertEqual(merged.first?.title, "Canonical")
        XCTAssertEqual(merged.first?.activity, .idle)
    }

    @MainActor
    func testHomePaginationRejectsDuplicateCursorStallAndOrderingRegression() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-pagination-validation-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let now = Date(timeIntervalSince1970: 3_000)
        func summary(_ id: String, updatedOffset: TimeInterval) -> AidenChatSummary {
            AidenChatSummary(
                id: id,
                workspaceId: "workspace-a",
                title: id,
                titlePending: false,
                createdAt: now,
                updatedAt: now.addingTimeInterval(updatedOffset),
                revision: "rev_" + String(repeating: "R", count: 43),
                activity: .idle
            )
        }
        let cursor = "cur_page_2." + String(repeating: "A", count: 43)
        let nextCursor = "cur_page_3." + String(repeating: "B", count: 43)
        let initial = try AidenChatSummaryPage(
            summaries: [summary("chat-a", updatedOffset: 3), summary("chat-b", updatedOffset: 2)],
            nextCursor: cursor
        )

        for invalidPage in [
            try AidenChatSummaryPage(
                summaries: [summary("chat-b", updatedOffset: 1)],
                nextCursor: nil
            ),
            try AidenChatSummaryPage(
                summaries: [summary("chat-c", updatedOffset: 1)],
                nextCursor: cursor
            ),
            try AidenChatSummaryPage(
                summaries: [summary("chat-c", updatedOffset: 4)],
                nextCursor: nextCursor
            ),
        ] {
            let model = AidenHomeModel(chatCache: cache)
            model.acceptInitialChatSummaryPage(initial)
            do {
                try await model.acceptChatSummaryContinuation(
                    invalidPage,
                    requestedCursor: cursor,
                    instanceId: "instance-pagination", writeToken: cache.reserveChatWrite()
                )
                XCTFail("Invalid continuation must fail closed.")
            } catch {}
            XCTAssertEqual(model.chats, initial.summaries)
            XCTAssertEqual(model.nextChatCursor, cursor)
            guard case .failed = model.paginationState else {
                return XCTFail("Invalid continuations must expose Retry without mutating the page.")
            }
        }

        let model = AidenHomeModel(chatCache: cache)
        model.acceptInitialChatSummaryPage(initial)
        let terminal = try AidenChatSummaryPage(
            summaries: [summary("chat-c", updatedOffset: 1)],
            nextCursor: nil
        )
        try await model.acceptChatSummaryContinuation(
            terminal,
            requestedCursor: cursor,
            instanceId: "instance-pagination", writeToken: cache.reserveChatWrite()
        )
        XCTAssertEqual(model.chats.map(\.id), ["chat-a", "chat-b", "chat-c"])
        XCTAssertNil(model.nextChatCursor)
        XCTAssertEqual(model.paginationState, .idle)
    }

    @MainActor
    func testPaginationCacheFailurePreservesPageAndCanRetry() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-pagination-cache-failure-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root, maxSummaryCacheFileBytes: 4_096)
        let model = AidenHomeModel(chatCache: cache)
        let now = Date(timeIntervalSince1970: 4_000)
        func summary(_ id: String, offset: TimeInterval, title: String = "Summary") -> AidenChatSummary {
            AidenChatSummary(
                id: id,
                workspaceId: "workspace-a",
                title: title,
                titlePending: false,
                createdAt: now,
                updatedAt: now.addingTimeInterval(offset),
                revision: "rev_" + String(repeating: "S", count: 43),
                activity: .idle
            )
        }
        let cursor = "cur_page_2." + String(repeating: "A", count: 43)
        let initial = try AidenChatSummaryPage(
            summaries: [summary("chat-initial", offset: 100)],
            nextCursor: cursor
        )
        model.acceptInitialChatSummaryPage(initial)
        try await cache.saveChatSummaries(
            .init(summaries: initial.summaries, nextCursor: cursor),
            instanceId: "instance-cache-failure", writeToken: cache.reserveChatWrite()
        )

        let oversized = try AidenChatSummaryPage(
            summaries: (0..<20).map { index in
                summary(
                    String(format: "chat-%03d", index),
                    offset: TimeInterval(99 - index),
                    title: String(repeating: "x", count: 1_024)
                )
            },
            nextCursor: nil
        )
        model.paginationState = .loading
        do {
            try await model.acceptChatSummaryContinuation(
                oversized,
                requestedCursor: cursor,
                instanceId: "instance-cache-failure", writeToken: cache.reserveChatWrite()
            )
            XCTFail("The bounded cache write must fail.")
        } catch {}
        XCTAssertEqual(model.chats, initial.summaries)
        XCTAssertEqual(model.nextChatCursor, cursor)
        guard case .failed = model.paginationState else {
            return XCTFail("Cache failure must expose the pagination Retry state.")
        }
        let preserved = await cache.loadChatSummaries(instanceId: "instance-cache-failure")
        XCTAssertEqual(preserved?.summaries, initial.summaries)

        let retry = try AidenChatSummaryPage(
            summaries: [summary("chat-retry", offset: 99)],
            nextCursor: nil
        )
        try await model.acceptChatSummaryContinuation(
            retry,
            requestedCursor: cursor,
            instanceId: "instance-cache-failure", writeToken: cache.reserveChatWrite()
        )
        XCTAssertEqual(model.chats.map(\.id), ["chat-initial", "chat-retry"])
        XCTAssertNil(model.nextChatCursor)
        XCTAssertEqual(model.paginationState, .idle)
        let retried = await cache.loadChatSummaries(instanceId: "instance-cache-failure")
        XCTAssertEqual(retried?.summaries, model.chats)
    }

    @MainActor
    func testHomeSummaryReconciliationPreservesActivityUntilCanonicalTransition() {
        let chat = sampleChat()
        let model = AidenHomeModel()
        model.chats = [AidenChatSummary(chat: chat, preservingActivity: .active)]

        var renamed = chat
        renamed.title = "Renamed while active"
        renamed.updatedAt = chat.updatedAt.addingTimeInterval(1)
        model.accept(renamed)
        XCTAssertEqual(model.chats.first?.title, "Renamed while active")
        XCTAssertEqual(model.chats.first?.activity, .active)

        model.setActivity(.idle, forChatID: chat.id)
        XCTAssertEqual(model.chats.first?.activity, .idle)
        model.removeChat(id: chat.id)
        XCTAssertTrue(model.chats.isEmpty)
    }

    func testTerminalCleanupCannotDeleteANewerActiveStream() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-stream-generation-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        try await cache.saveActiveStream(
            .init(deviceId: "device-a", streamId: "stream-new", turnId: "turn-new", lastSequence: 0),
            instanceId: "instance-a",
            chatId: "chat-1", chatWriteToken: cache.reserveChatWrite()
        )

        let staleRemoval = await cache.removeActiveStream(
            instanceId: "instance-a",
            chatId: "chat-1",
            ifStreamId: "stream-old"
        )
        XCTAssertFalse(staleRemoval)
        let retained = await cache.loadActiveStream(instanceId: "instance-a", chatId: "chat-1")
        XCTAssertEqual(retained?.streamId, "stream-new")
        let currentRemoval = await cache.removeActiveStream(
            instanceId: "instance-a",
            chatId: "chat-1",
            ifStreamId: "stream-new"
        )
        XCTAssertTrue(currentRemoval)
    }

    func testApprovalSnapshotMustBeLiveAndBoundToTheExactStreamAndChat() {
        let now = Date(timeIntervalSince1970: 10_000)
        let valid = AidenStreamPendingApproval(
            approvalId: "approval-1",
            streamId: "stream-1",
            chatId: "chat-1",
            summary: "Review",
            toolCallId: "tool-1",
            toolName: "run",
            expiresAt: now.addingTimeInterval(60),
            canAllow: false
        )
        XCTAssertEqual(
            AidenPendingApprovalResolution.resolve(valid, streamId: "stream-1", chatId: "chat-1", now: now)?.canAllow,
            false
        )
        XCTAssertNil(AidenPendingApprovalResolution.resolve(nil, streamId: "stream-1", chatId: "chat-1", now: now))
        XCTAssertNil(AidenPendingApprovalResolution.resolve(valid, streamId: "stream-2", chatId: "chat-1", now: now))
        XCTAssertNil(AidenPendingApprovalResolution.resolve(valid, streamId: "stream-1", chatId: "chat-2", now: now))
        XCTAssertNil(
            AidenPendingApprovalResolution.resolve(
                .init(
                    approvalId: valid.approvalId,
                    streamId: valid.streamId,
                    chatId: valid.chatId,
                    summary: valid.summary,
                    toolCallId: valid.toolCallId,
                    toolName: valid.toolName,
                    expiresAt: now,
                    canAllow: true
                ),
                streamId: "stream-1",
                chatId: "chat-1",
                now: now
            )
        )
    }

    func testScheduledTaskApprovalRequiresResponseAndScheduleWriteCapabilities() {
        let now = Date(timeIntervalSince1970: 10_000)
        let proposal = AidenStreamPendingApproval(
            approvalId: "approval-schedule-1",
            streamId: "stream-1",
            chatId: "chat-1",
            summary: "Daily report · weekdays at 9:00 AM · Read Only",
            toolCallId: "tool-1",
            toolName: "schedule_task",
            expiresAt: now.addingTimeInterval(60),
            canAllow: true
        )

        let allowed = AidenPendingApprovalResolution.resolve(
            proposal,
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .init(canRespond: true, canWriteSchedules: true),
            now: now
        )
        XCTAssertEqual(allowed?.kind, .scheduledTask)
        XCTAssertEqual(allowed?.summary, proposal.summary)
        XCTAssertEqual(allowed?.canRespond, true)
        XCTAssertEqual(allowed?.hasRequiredWriteCapability, true)
        XCTAssertEqual(allowed?.hostCanAllow, true)
        XCTAssertEqual(allowed?.canAllow, true)

        let readOnlySchedules = AidenPendingApprovalResolution.resolve(
            proposal,
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .init(canRespond: true, canWriteSchedules: false),
            now: now
        )
        XCTAssertEqual(readOnlySchedules?.canRespond, true)
        XCTAssertEqual(readOnlySchedules?.hasRequiredWriteCapability, false)
        XCTAssertEqual(readOnlySchedules?.canAllow, false)

        let cannotRespond = AidenPendingApprovalResolution.resolve(
            proposal,
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .init(canRespond: false, canWriteSchedules: true),
            now: now
        )
        XCTAssertEqual(cannotRespond?.canRespond, false)
        XCTAssertEqual(cannotRespond?.hasRequiredWriteCapability, true)
        XCTAssertEqual(cannotRespond?.canAllow, false)

        let hostOnly = AidenPendingApprovalResolution.resolve(
            AidenStreamPendingApproval(
                approvalId: proposal.approvalId,
                streamId: proposal.streamId,
                chatId: proposal.chatId,
                summary: proposal.summary,
                toolCallId: proposal.toolCallId,
                toolName: proposal.toolName,
                expiresAt: proposal.expiresAt,
                canAllow: false
            ),
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .init(canRespond: true, canWriteSchedules: true),
            now: now
        )
        XCTAssertEqual(hostOnly?.canRespond, true)
        XCTAssertEqual(hostOnly?.hasRequiredWriteCapability, true)
        XCTAssertEqual(hostOnly?.hostCanAllow, false)
        XCTAssertEqual(hostOnly?.canAllow, false)
    }

    func testScheduledTaskApprovalPresentationUsesUnattendedWorkCopy() {
        XCTAssertEqual(AidenApprovalKind(toolName: "schedule_task"), .scheduledTask)
        XCTAssertEqual(AidenApprovalKind(toolName: "edit_automation"), .scheduledTask)
        XCTAssertEqual(AidenApprovalKind(toolName: "run_command"), .action)
        XCTAssertEqual(AidenApprovalPresentation.title(for: .scheduledTask), "Review scheduled task")
        XCTAssertEqual(AidenApprovalPresentation.allowTitle(for: .scheduledTask), "Approve task")
        XCTAssertEqual(AidenApprovalPresentation.denyTitle(for: .scheduledTask), "Cancel")
    }

    func testScheduledTaskApprovalRechecksNarrowedCapabilitiesBeforeResponding() throws {
        let now = Date(timeIntervalSince1970: 10_000)
        let proposal = AidenStreamPendingApproval(
            approvalId: "approval-schedule-current",
            streamId: "stream-1",
            chatId: "chat-1",
            summary: "Daily report · weekdays at 9:00 AM · Read Only",
            toolCallId: "tool-1",
            toolName: "schedule_task",
            expiresAt: now.addingTimeInterval(60),
            canAllow: true
        )
        let approval = try XCTUnwrap(AidenPendingApprovalResolution.resolve(
            proposal,
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .unrestricted,
            now: now
        ))

        XCTAssertEqual(
            AidenApprovalResponseAuthorization.resolve(
                approval: approval,
                decision: .allow,
                capabilities: .init(canRespond: true, canWriteSchedules: false)
            ),
            .scheduleWriteRequired
        )
        XCTAssertEqual(
            AidenApprovalResponseAuthorization.resolve(
                approval: approval,
                decision: .deny,
                capabilities: .init(canRespond: true, canWriteSchedules: false)
            ),
            .allowed,
            "Deny remains available without schedule write authority."
        )
        XCTAssertEqual(
            AidenApprovalResponseAuthorization.resolve(
                approval: approval,
                decision: .allow,
                capabilities: .init(canRespond: false, canWriteSchedules: true)
            ),
            .approvalResponseRequired
        )

        let hostOnly = try XCTUnwrap(AidenPendingApprovalResolution.resolve(
            .init(
                approvalId: proposal.approvalId,
                streamId: proposal.streamId,
                chatId: proposal.chatId,
                summary: proposal.summary,
                toolCallId: proposal.toolCallId,
                toolName: proposal.toolName,
                expiresAt: proposal.expiresAt,
                canAllow: false
            ),
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .unrestricted,
            now: now
        ))
        XCTAssertEqual(
            AidenApprovalResponseAuthorization.resolve(
                approval: hostOnly,
                decision: .allow,
                capabilities: .unrestricted
            ),
            .hostApprovalRequired
        )
    }

    func testApprovalSummaryCollapsesWhitespaceForCompactDisclosure() {
        XCTAssertEqual(
            AidenApprovalPresentation.oneLineSummary("Run command:\n  find ~/Downloads   -type f"),
            "Run command: find ~/Downloads -type f"
        )
        XCTAssertEqual(AidenApprovalPresentation.oneLineSummary(" \n\t "), "Review requested action")
    }

    @MainActor
    func testHeldImageReadCannotPersistOrReturnBytesAfterRemovalOrPurge() async throws {
        for purging in [false, true] {
            let root = FileManager.default.temporaryDirectory.appending(path: "aiden-held-image-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let gate = AidenChatWriteTestGate()
            let cache = AidenChatCache(root: root, beforeAttachmentImageWrite: { await gate.waitIfArmed() })
            let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
            let png = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).pngData { $0.fill(CGRect(x: 0, y: 0, width: 2, height: 2)) }
            let attachment = AidenMessageAttachment(id: "attachment-image-1", name: "Preview.png", mimeType: "image/png", kind: .image, size: png.count)
            AidenChatProgressLifecycleURLProtocol.setResponseOverride { _ in (200, "image/png", png) }
            await gate.arm()
            let reading = Task { await model.attachmentImageData(for: attachment) }
            await waitForChatWrite(gate)
            if purging { await cache.purge(instanceId: "instance-progress-lifecycle") }
            else { await cache.removeChat(instanceId: "instance-progress-lifecycle", chatId: model.chat.id) }
            await gate.release()
            let result = await reading.value
            XCTAssertNil(result)
            let reopened = AidenChatCache(root: root)
            let bytes = await reopened.attachmentImage(instanceId: "instance-progress-lifecycle", deviceId: "device-progress-lifecycle", chatId: model.chat.id, attachment: attachment)
            XCTAssertNil(bytes)
            let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey])?.allObjects as? [URL] ?? []
            XCTAssertFalse(files.contains { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true })
        }
    }

    @MainActor
    func testEveryMetadataWriterRejectsHeldDeletionAndPurgeSnapshots() async throws {
        for purging in [false, true] {
            for writer in ["workspace", "home", "reconcile"] {
                let root = FileManager.default.temporaryDirectory.appending(path: "aiden-held-metadata-\(UUID())")
                defer { try? FileManager.default.removeItem(at: root) }
                let gate = AidenChatWriteTestGate()
                let cache = AidenChatCache(root: root, beforeMetadataWrite: { await gate.waitIfArmed() })
                let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
                let chat = model.chat
                let instanceId = "instance-progress-lifecycle"
                let summary = AidenChatCache.SummarySnapshot(summaries: [AidenChatSummary(chat: chat)], nextCursor: nil)
                try await cache.saveChats([chat], instanceId: instanceId, workspaceId: chat.workspaceId, writeToken: cache.reserveChatWrite())
                try await cache.saveChatSummaries(summary, instanceId: instanceId, writeToken: cache.reserveChatWrite())
                let token = cache.reserveChatWrite()
                await gate.arm()
                let writing = Task {
                    switch writer {
                    case "workspace": try await cache.saveChats([chat], instanceId: instanceId, workspaceId: chat.workspaceId, writeToken: token)
                    case "home": try await cache.saveChatSummaries(summary, instanceId: instanceId, generation: 999, writeToken: token)
                    default: try await cache.reconcileChatSummary(chat, instanceId: instanceId, writeToken: token)
                    }
                }
                await waitForChatWrite(gate)
                if purging { await cache.purge(instanceId: instanceId) }
                else { await cache.removeChat(instanceId: instanceId, chatId: chat.id) }
                await gate.release()
                try await writing.value
                let reopened = AidenChatCache(root: root)
                let home = await reopened.loadChatSummaries(instanceId: instanceId)
                let workspace = await reopened.loadChats(instanceId: instanceId, workspaceId: chat.workspaceId)
                if purging { XCTAssertNil(home); XCTAssertNil(workspace) }
                else { XCTAssertEqual(home?.summaries.count, 0); XCTAssertEqual(workspace?.count, 0) }
                // A new admitted owner remains usable after deletion/purge.
                try await cache.saveChat(chat, instanceId: instanceId, writeToken: cache.reserveChatWrite())
                try await cache.saveChatSummaries(summary, instanceId: instanceId, writeToken: cache.reserveChatWrite())
                let fresh = await reopened.loadChatSummaries(instanceId: instanceId)
                XCTAssertEqual(fresh?.summaries.map(\.id), [chat.id])
            }
        }
    }

    @MainActor
    func testOldMetadataCannotEraseFreshReadmissionAfterDeletionOrPurge() async throws {
        for purging in [false, true] {
            for writer in ["workspace", "home", "reconcile"] {
                let root = FileManager.default.temporaryDirectory.appending(path: "aiden-held-metadata-\(UUID())")
                defer { try? FileManager.default.removeItem(at: root) }
                let gate = AidenChatWriteTestGate()
                let cache = AidenChatCache(root: root, beforeMetadataWrite: { await gate.waitIfArmed() })
                let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
                let chat = model.chat
                let instanceId = "instance-progress-lifecycle"
                let summary = AidenChatCache.SummarySnapshot(summaries: [AidenChatSummary(chat: chat)], nextCursor: nil)
                try await cache.saveChats([chat], instanceId: instanceId, workspaceId: chat.workspaceId, writeToken: cache.reserveChatWrite())
                try await cache.saveChatSummaries(summary, instanceId: instanceId, writeToken: cache.reserveChatWrite())
                let token = cache.reserveChatWrite()
                await gate.arm()
                let writing = Task {
                    switch writer {
                    case "workspace": try await cache.saveChats([chat], instanceId: instanceId, workspaceId: chat.workspaceId, writeToken: token)
                    case "home": try await cache.saveChatSummaries(summary, instanceId: instanceId, generation: 999, writeToken: token)
                    default: try await cache.reconcileChatSummary(chat, instanceId: instanceId, writeToken: token)
                    }
                }
                await waitForChatWrite(gate)
                if purging { await cache.purge(instanceId: instanceId) }
                else { await cache.removeChat(instanceId: instanceId, chatId: chat.id) }
                var freshChat = chat
                freshChat.title = "Fresh owner"
                try await cache.saveChat(freshChat, instanceId: instanceId, writeToken: cache.reserveChatWrite())
                try await cache.saveChats([freshChat], instanceId: instanceId, workspaceId: chat.workspaceId, writeToken: cache.reserveChatWrite())
                try await cache.saveChatSummaries(.init(summaries: [AidenChatSummary(chat: freshChat)], nextCursor: nil), instanceId: instanceId, writeToken: cache.reserveChatWrite())
                await gate.release()
                try await writing.value
                let reopened = AidenChatCache(root: root)
                let home = await reopened.loadChatSummaries(instanceId: instanceId)
                let workspace = await reopened.loadChats(instanceId: instanceId, workspaceId: chat.workspaceId)
                XCTAssertEqual(home?.summaries.map(\.title), ["Fresh owner"])
                XCTAssertEqual(workspace?.map(\.title), ["Fresh owner"])
            }
        }
    }

    @MainActor
    func testDeletionFencesMetadataWithAbsentFileOrRowAfterDetailReadmission() async throws {
        for existingRow in [false, true] {
            for writer in ["workspace", "home"] {
                let root = FileManager.default.temporaryDirectory.appending(path: "aiden-absent-metadata-\(UUID())")
                defer { try? FileManager.default.removeItem(at: root) }
                let gate = AidenChatWriteTestGate()
                let cache = AidenChatCache(root: root, beforeMetadataWrite: { await gate.waitIfArmed() })
                let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
                let chat = model.chat
                let instanceId = "instance-progress-lifecycle"
                let other = AidenChat(id: "unrelated-chat", workspaceId: chat.workspaceId, title: "Retained row", providerId: chat.providerId, modelId: chat.modelId, messages: [], createdAt: chat.createdAt, updatedAt: chat.updatedAt, revision: chat.revision)
                if existingRow {
                    try await cache.saveChats([other], instanceId: instanceId, workspaceId: chat.workspaceId, writeToken: cache.reserveChatWrite())
                    try await cache.saveChatSummaries(.init(summaries: [AidenChatSummary(chat: other)], nextCursor: nil), instanceId: instanceId, writeToken: cache.reserveChatWrite())
                }
                let token = cache.reserveChatWrite()
                await gate.arm()
                let writing = Task {
                    if writer == "workspace" {
                        try await cache.saveChats([chat], instanceId: instanceId, workspaceId: chat.workspaceId, writeToken: token)
                    } else {
                        try await cache.saveChatSummaries(.init(summaries: [AidenChatSummary(chat: chat)], nextCursor: nil), instanceId: instanceId, writeToken: token)
                    }
                }
                await waitForChatWrite(gate)
                await cache.removeChat(instanceId: instanceId, chatId: chat.id)
                var fresh = chat
                fresh.title = "Fresh detail only"
                try await cache.saveChat(fresh, instanceId: instanceId, writeToken: cache.reserveChatWrite())
                await gate.release()
                try await writing.value
                let reopened = AidenChatCache(root: root)
                let workspace = await reopened.loadChats(instanceId: instanceId, workspaceId: chat.workspaceId)
                let home = await reopened.loadChatSummaries(instanceId: instanceId)
                XCTAssertEqual(workspace?.map(\.id), existingRow ? [other.id] : nil)
                XCTAssertEqual(home?.summaries.map(\.id), existingRow ? [other.id] : nil)
                // Fresh metadata admission and another installation remain usable.
                try await cache.saveChats([fresh, other], instanceId: instanceId, workspaceId: chat.workspaceId, writeToken: cache.reserveChatWrite())
                try await cache.saveChatSummaries(.init(summaries: [AidenChatSummary(chat: fresh), AidenChatSummary(chat: other)], nextCursor: nil), instanceId: instanceId, writeToken: cache.reserveChatWrite())
                try await cache.saveChats([chat], instanceId: "other-instance", workspaceId: chat.workspaceId, writeToken: token)
                let admitted = await reopened.loadChats(instanceId: instanceId, workspaceId: chat.workspaceId)
                let isolated = await reopened.loadChats(instanceId: "other-instance", workspaceId: chat.workspaceId)
                XCTAssertEqual(admitted?.map(\.title), [fresh.title, other.title])
                XCTAssertEqual(isolated?.map(\.id), [chat.id])
            }
        }
    }

    @MainActor
    func testMetadataCannotWriteWhileChatRemovalCleanupIsPending() async throws {
        for writer in ["workspace", "home"] {
            let root = FileManager.default.temporaryDirectory.appending(path: "aiden-pending-metadata-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let cache = AidenChatCache(root: root)
            let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
            let chat = model.chat
            let instance = "instance-progress-lifecycle"
            let other = AidenChat(id: "unrelated-chat", workspaceId: chat.workspaceId, title: "Retained row", providerId: chat.providerId, modelId: chat.modelId, messages: [], createdAt: chat.createdAt, updatedAt: chat.updatedAt, revision: chat.revision)
            try await cache.saveChats([other], instanceId: instance, workspaceId: chat.workspaceId, writeToken: cache.reserveChatWrite())
            try await cache.saveChatSummaries(.init(summaries: [AidenChatSummary(chat: other)], nextCursor: nil), instanceId: instance, writeToken: cache.reserveChatWrite())
            let oldToken = cache.reserveChatWrite()
            let gate = AidenChatWriteTestGate()
            let lifetime = cache.registerLifetime(instanceId: instance, chatId: chat.id)
            lifetime.onRemovalCleanup = { await gate.waitIfArmed() }
            await gate.arm()
            let removing = Task { await cache.removeChat(instanceId: instance, chatId: chat.id) }
            await waitForChatWrite(gate)
            for token in [oldToken, cache.reserveChatWrite()] {
                if writer == "workspace" {
                    try await cache.saveChats([chat], instanceId: instance, workspaceId: chat.workspaceId, writeToken: token)
                } else {
                    try await cache.saveChatSummaries(.init(summaries: [AidenChatSummary(chat: chat)], nextCursor: nil), instanceId: instance, writeToken: token)
                }
            }
            let reopened = AidenChatCache(root: root)
            let list = await reopened.loadChats(instanceId: instance, workspaceId: chat.workspaceId)
            let home = await reopened.loadChatSummaries(instanceId: instance)
            XCTAssertEqual(list?.map(\.id), [other.id])
            XCTAssertEqual(home?.summaries.map(\.id), [other.id])
            try await cache.saveChats([chat], instanceId: "other-instance", workspaceId: chat.workspaceId, writeToken: oldToken)
            let isolated = await reopened.loadChats(instanceId: "other-instance", workspaceId: chat.workspaceId)
            XCTAssertEqual(isolated?.map(\.id), [chat.id])
            await gate.release()
            await removing.value
        }
    }

    @MainActor
    func testPendingEraMetadataPreservesUnrelatedRowsAfterCleanupAndReadmission() async throws {
        let cachedCursor = "cur_cached." + String(repeating: "a", count: 43)
        let incomingCursor = "cur_incoming." + String(repeating: "b", count: 43)
        let freshCursor = "cur_fresh." + String(repeating: "c", count: 43)
        for cursor in [cachedCursor, incomingCursor, freshCursor] {
            XCTAssertTrue(AidenChatSummaryPage.isValidCursor(cursor))
        }
        for existing in ["absent", "unrelated", "both", "cached-nil"] {
            for writer in ["workspace", "home", "reconcile"] {
                for delayed in [false, true] {
                    let root = FileManager.default.temporaryDirectory.appending(path: "aiden-cleanup-epoch-\(UUID())")
                    defer { try? FileManager.default.removeItem(at: root) }
                    let writeGate = AidenChatWriteTestGate()
                    let cleanupGate = AidenChatWriteTestGate()
                    let cache = AidenChatCache(root: root, beforeMetadataWrite: { await writeGate.waitIfArmed() })
                    let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
                    let chat = model.chat
                    let instance = "instance-progress-lifecycle"
                    var other = AidenChat(id: "unrelated-chat", workspaceId: chat.workspaceId, title: "Old unrelated", providerId: chat.providerId, modelId: chat.modelId, messages: [], createdAt: chat.createdAt, updatedAt: chat.updatedAt, revision: chat.revision)
                    let omitted = AidenChat(id: "omitted-chat", workspaceId: chat.workspaceId, title: "Preserved omitted", providerId: chat.providerId, modelId: chat.modelId, messages: [], createdAt: chat.createdAt, updatedAt: chat.updatedAt, revision: chat.revision)
                    if existing != "absent" {
                        let rows = existing == "both" ? [chat, other, omitted] : [other, omitted]
                        try await cache.saveChats(rows, instanceId: instance, workspaceId: chat.workspaceId, writeToken: cache.reserveChatWrite())
                        try await cache.saveChatSummaries(.init(summaries: AidenChatSummaryPage.merged(current: [], appending: rows.map { AidenChatSummary(chat: $0) }), nextCursor: existing == "cached-nil" ? nil : cachedCursor), instanceId: instance, writeToken: cache.reserveChatWrite())
                    }
                    let preRemovalToken = cache.reserveChatWrite()
                    let lifetime = cache.registerLifetime(instanceId: instance, chatId: chat.id)
                    lifetime.onRemovalCleanup = { await cleanupGate.waitIfArmed() }
                    await cleanupGate.arm()
                    let removing = Task { await cache.removeChat(instanceId: instance, chatId: chat.id) }
                    await waitForChatWrite(cleanupGate)
                    var staleOther = other
                    staleOther.title = "Stale pre-removal"
                    try await cache.saveChats([staleOther], instanceId: instance, workspaceId: chat.workspaceId, writeToken: preRemovalToken)
                    try await cache.saveChatSummaries(.init(summaries: [AidenChatSummary(chat: staleOther)], nextCursor: nil), instanceId: instance, writeToken: preRemovalToken)
                    try await cache.reconcileChatSummary(staleOther, instanceId: instance, writeToken: preRemovalToken)
                    let preRows = await cache.loadChats(instanceId: instance, workspaceId: chat.workspaceId)
                    let preHome = await cache.loadChatSummaries(instanceId: instance)
                    XCTAssertEqual(preRows?.first(where: { $0.id == other.id })?.title, existing == "absent" ? nil : "Old unrelated")
                    XCTAssertEqual(preHome?.summaries.first(where: { $0.id == other.id })?.title, existing == "absent" ? nil : "Old unrelated")
                    other.title = "Updated unrelated"
                    let pendingToken = cache.reserveChatWrite()
                    if delayed { await writeGate.arm() }
                    let updatedOther = other
                    let writing = Task {
                        switch writer {
                        case "workspace": try await cache.saveChats([chat, updatedOther], instanceId: instance, workspaceId: chat.workspaceId, writeToken: pendingToken)
                        case "home": try await cache.saveChatSummaries(.init(summaries: [AidenChatSummary(chat: chat), AidenChatSummary(chat: updatedOther)], nextCursor: incomingCursor), instanceId: instance, generation: 999, writeToken: pendingToken)
                        default: try await cache.reconcileChatSummary(updatedOther, instanceId: instance, writeToken: pendingToken)
                        }
                    }
                    if delayed { await waitForChatWrite(writeGate) }
                    else { try await writing.value }
                    await cleanupGate.release()
                    await removing.value
                    var fresh = chat
                    fresh.title = "Fresh detail"
                    try await cache.saveChat(fresh, instanceId: instance, writeToken: cache.reserveChatWrite())
                    await writeGate.release()
                    try await writing.value
                    let reopened = AidenChatCache(root: root)
                    if writer == "workspace" {
                        let rows = await reopened.loadChats(instanceId: instance, workspaceId: chat.workspaceId)
                        XCTAssertEqual(Set(rows?.map(\.id) ?? []), Set(existing == "absent" ? [other.id] : [other.id, omitted.id]))
                        XCTAssertEqual(rows?.first(where: { $0.id == other.id })?.title, "Updated unrelated")
                    } else {
                        let rows = await reopened.loadChatSummaries(instanceId: instance)
                        XCTAssertEqual(Set(rows?.summaries.map(\.id) ?? []), Set(existing == "absent" ? [other.id] : [other.id, omitted.id]))
                        XCTAssertEqual(rows?.summaries.first(where: { $0.id == other.id })?.title, "Updated unrelated")
                        XCTAssertEqual(rows?.nextCursor, existing == "absent" ? (writer == "home" ? incomingCursor : nil) : (existing == "cached-nil" ? nil : cachedCursor))
                    }
                    if writer == "home" {
                        try await cache.saveChatSummaries(.init(summaries: [AidenChatSummary(chat: fresh)], nextCursor: freshCursor), instanceId: instance, generation: 1, writeToken: cache.reserveChatWrite())
                        let freshHome = await reopened.loadChatSummaries(instanceId: instance)
                        XCTAssertEqual(freshHome?.summaries.map(\.title), [fresh.title])
                        XCTAssertEqual(freshHome?.nextCursor, freshCursor)
                    }
                    let rejectedDetail = try await cache.saveChat(chat, instanceId: instance, writeToken: pendingToken)
                    XCTAssertFalse(rejectedDetail)
                    XCTAssertFalse(cache.isChatWriteRetained(pendingToken, instanceId: instance, chatId: chat.id))
                    XCTAssertTrue(cache.isChatWriteRetained(pendingToken, instanceId: instance, chatId: other.id))
                }
            }
        }
    }

    @MainActor
    func testPendingMetadataCannotReplaceFreshFullSnapshotAfterRemovalOrPurge() async throws {
        let freshCursor = "cur_fresh." + String(repeating: "d", count: 43)
        XCTAssertTrue(AidenChatSummaryPage.isValidCursor(freshCursor))
        for purging in [false, true] {
            let root = FileManager.default.temporaryDirectory.appending(path: "aiden-finished-cleanup-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let cache = AidenChatCache(root: root)
            let model = try await makeProgressLifecycleModel(mode: .denied, cache: cache)
            let chat = model.chat
            let instance = "instance-progress-lifecycle"
            let cleanupGate = AidenChatWriteTestGate()
            let lifetime = cache.registerLifetime(instanceId: instance, chatId: chat.id)
            lifetime.onRemovalCleanup = { await cleanupGate.waitIfArmed() }
            await cleanupGate.arm()
            let removing = Task {
                if purging { await cache.purge(instanceId: instance) }
                else { await cache.removeChat(instanceId: instance, chatId: chat.id) }
            }
            await waitForChatWrite(cleanupGate)
            let pendingToken = cache.reserveChatWrite()
            await cleanupGate.release()
            await removing.value
            var fresh = chat
            fresh.title = "Fresh full snapshot"
            try await cache.saveChat(fresh, instanceId: instance, writeToken: cache.reserveChatWrite())
            try await cache.saveChats([fresh], instanceId: instance, workspaceId: chat.workspaceId, writeToken: cache.reserveChatWrite())
            try await cache.saveChatSummaries(.init(summaries: [AidenChatSummary(chat: fresh)], nextCursor: freshCursor), instanceId: instance, generation: 1, writeToken: cache.reserveChatWrite())
            try await cache.saveChats([chat], instanceId: instance, workspaceId: chat.workspaceId, writeToken: pendingToken)
            try await cache.saveChatSummaries(.init(summaries: [AidenChatSummary(chat: chat)], nextCursor: nil), instanceId: instance, generation: 999, writeToken: pendingToken)
            try await cache.reconcileChatSummary(chat, instanceId: instance, writeToken: pendingToken)
            let reopened = AidenChatCache(root: root)
            let rows = await reopened.loadChats(instanceId: instance, workspaceId: chat.workspaceId)
            let home = await reopened.loadChatSummaries(instanceId: instance)
            XCTAssertEqual(rows?.map(\.title), [fresh.title])
            XCTAssertEqual(home?.summaries.map(\.title), [fresh.title])
            XCTAssertEqual(home?.nextCursor, freshCursor)
            try await cache.saveChats([chat], instanceId: "other-instance", workspaceId: chat.workspaceId, writeToken: pendingToken)
            let isolated = await reopened.loadChats(instanceId: "other-instance", workspaceId: chat.workspaceId)
            XCTAssertEqual(isolated?.map(\.id), [chat.id])
        }
    }

    func testAttachmentImageValidationAndProtectedCacheFailClosed() async throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 16))
        let png = renderer.pngData { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 24, height: 16))
        }
        let attachment = AidenMessageAttachment(
            id: "attachment-image-1",
            name: "Preview.png",
            mimeType: "image/png",
            kind: .image,
            size: png.count
        )
        XCTAssertEqual(
            AidenAttachmentImageValidation.validatedData(
                png,
                mimeType: attachment.mimeType,
                declaredSize: attachment.size
            ),
            png
        )
        XCTAssertNil(AidenAttachmentImageValidation.validatedData(
            png,
            mimeType: "image/jpeg",
            declaredSize: png.count
        ))
        XCTAssertNil(AidenAttachmentImageValidation.validatedData(
            png,
            mimeType: "image/png",
            declaredSize: png.count + 1
        ))

        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-attachment-cache-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        try await cache.saveAttachmentImage(
            png,
            instanceId: "instance-a",
            deviceId: "device-a",
            chatId: "chat-a",
            attachment: attachment,
            writeToken: cache.reserveChatWrite()
        )
        let cachedImage = await cache.attachmentImage(
            instanceId: "instance-a",
            deviceId: "device-a",
            chatId: "chat-a",
            attachment: attachment
        )
        XCTAssertEqual(cachedImage, png)
        let wrongDeviceImage = await cache.attachmentImage(
            instanceId: "instance-a",
            deviceId: "device-b",
            chatId: "chat-a",
            attachment: attachment
        )
        XCTAssertNil(wrongDeviceImage)
        await cache.removeChat(instanceId: "instance-a", chatId: "chat-a")
        let removedImage = await cache.attachmentImage(
            instanceId: "instance-a",
            deviceId: "device-a",
            chatId: "chat-a",
            attachment: attachment
        )
        XCTAssertNil(removedImage)
    }

    func testAttachmentThumbnailDownsamplesOffTheDisplayPath() async throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1_200, height: 800))
        let data = renderer.pngData { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1_200, height: 800))
        }
        let decodedImage = await AidenAttachmentImageDecoding.thumbnail(
            data: data,
            maximumPixelSize: 320
        )
        let image = try XCTUnwrap(decodedImage)
        XCTAssertLessThanOrEqual(max(image.size.width, image.size.height), 320)
        XCTAssertEqual(image.size.width / image.size.height, 1.5, accuracy: 0.02)
    }

    func testPersistedMessageOutcomesUseFixedSafePresentation() {
        XCTAssertEqual(
            AidenMessageOutcomePresentation.make(.init(
                status: .failed,
                category: "authentication",
                attempts: 1,
                retryExhausted: false
            )),
            .init(
                title: "Generation failed",
                detail: "The model provider rejected its credentials. Check Provider Settings on your Mac.",
                symbol: "exclamationmark.triangle",
                isFailure: true
            )
        )
        XCTAssertEqual(
            AidenMessageOutcomePresentation.make(.init(
                status: .failed,
                category: "invalid_request",
                attempts: 1,
                retryExhausted: false
            )).detail,
            "The model provider could not accept this request. For a Bot, change its model in Edit Bot; for a Workspace chat, use the composer."
        )
        XCTAssertEqual(
            AidenMessageOutcomePresentation.make(.init(
                status: .failed,
                category: "private-provider-detail",
                attempts: nil,
                retryExhausted: nil
            )).detail,
            "The model provider could not complete this response."
        )
        XCTAssertEqual(
            AidenMessageOutcomePresentation.make(.init(
                status: .cancelled,
                category: nil,
                attempts: nil,
                retryExhausted: nil
            )).title,
            "Response cancelled"
        )
    }

    func testTerminalStreamCursorGetsExactlyOneFinalReplayBeforeCleanup() {
        var gate = AidenTerminalReplayGate()
        XCTAssertFalse(gate.shouldReplay(.running))
        XCTAssertTrue(gate.shouldReplay(.cancelled))
        XCTAssertFalse(gate.shouldReplay(.cancelled))
        XCTAssertFalse(gate.shouldReplay(.error))
    }

    func testTerminalReconciliationRetriesIndefinitelyWithACappedBackoff() {
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: -1), 1_000)
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: 0), 1_000)
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: 1), 2_000)
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: 4), 16_000)
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: 5), 30_000)
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: 500), 30_000)
    }

    func testTypedMissingStreamFallsBackToDurableChatReconciliation() throws {
        let gone = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.self,
            from: Data(#"{"error":{"code":"stream_gone","message":"Gone","requestId":"req-1","retryable":false}}"#.utf8)
        )
        let notFound = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.self,
            from: Data(#"{"error":{"code":"not_found","message":"Missing","requestId":"req-2","retryable":false}}"#.utf8)
        )
        let transient = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.self,
            from: Data(#"{"error":{"code":"internal_error","message":"Retry","requestId":"req-3","retryable":true}}"#.utf8)
        )

        XCTAssertTrue(AidenTerminalReconciliation.isDefinitiveMissingStream(
            AidenRemoteClientError.server(statusCode: 404, body: gone.error)
        ))
        XCTAssertTrue(AidenTerminalReconciliation.isDefinitiveMissingStream(
            AidenRemoteClientError.server(statusCode: 404, body: notFound.error)
        ))
        XCTAssertFalse(AidenTerminalReconciliation.isDefinitiveMissingStream(
            AidenRemoteClientError.server(statusCode: 503, body: transient.error)
        ))
        XCTAssertFalse(AidenTerminalReconciliation.isDefinitiveMissingStream(
            AidenRemoteClientError.unexpectedStatus(404)
        ))
    }

    func testMissingStreamResolutionNeverReusesAnEarlierTurnOutcome() {
        let earlierFailed = AidenChatMessage(
            id: "assistant-old",
            role: .assistant,
            text: "",
            outcome: AidenMessageOutcome(
                status: .failed,
                category: "network",
                attempts: 1,
                retryExhausted: false
            ),
            createdAt: Date(timeIntervalSince1970: 1)
        )
        let earlierComplete = AidenChatMessage(
            id: "assistant-complete",
            role: .assistant,
            text: "Done",
            createdAt: Date(timeIntervalSince1970: 2)
        )
        let currentUser = AidenChatMessage(
            id: "user-current",
            role: .user,
            text: "Continue",
            createdAt: Date(timeIntervalSince1970: 3)
        )

        XCTAssertEqual(
            AidenMissingStreamResolution.resolve(messages: [earlierFailed, currentUser]),
            .interrupted
        )
        XCTAssertEqual(
            AidenMissingStreamResolution.resolve(messages: [earlierComplete, currentUser]),
            .interrupted
        )
        XCTAssertEqual(
            AidenMissingStreamResolution.resolve(messages: [currentUser, earlierComplete]),
            .complete
        )
    }

    func testFullscreenAttachmentGalleryOnlyKeepsTheSelectedPageAndNeighborsActive() {
        XCTAssertTrue(AidenAttachmentGalleryWindow.contains(index: 0, selectedIndex: 0, count: 20))
        XCTAssertTrue(AidenAttachmentGalleryWindow.contains(index: 9, selectedIndex: 10, count: 20))
        XCTAssertTrue(AidenAttachmentGalleryWindow.contains(index: 10, selectedIndex: 10, count: 20))
        XCTAssertTrue(AidenAttachmentGalleryWindow.contains(index: 11, selectedIndex: 10, count: 20))
        XCTAssertFalse(AidenAttachmentGalleryWindow.contains(index: 8, selectedIndex: 10, count: 20))
        XCTAssertFalse(AidenAttachmentGalleryWindow.contains(index: 19, selectedIndex: 10, count: 20))
        XCTAssertFalse(AidenAttachmentGalleryWindow.contains(index: -1, selectedIndex: 0, count: 20))
        XCTAssertFalse(AidenAttachmentGalleryWindow.contains(index: 0, selectedIndex: 0, count: 0))
    }

    func testInlineCardDeckPagesWithBoundedVisibleNeighborsAndFlicks() {
        XCTAssertEqual(AidenInlineCardDeckLayout.viewportAspectRatio, 1)
        XCTAssertEqual(AidenInlineCardDeckLayout.singleImageCornerRadius, 16)
        XCTAssertEqual(AidenInlineCardDeckLayout.cardCornerRadius, 18)
        XCTAssertTrue(AidenInlineCardDeckLayout.isVisible(index: 0, selection: 0, count: 5))
        XCTAssertTrue(AidenInlineCardDeckLayout.isVisible(index: 1, selection: 0, count: 5))
        XCTAssertFalse(AidenInlineCardDeckLayout.isVisible(index: 2, selection: 0, count: 5))
        XCTAssertFalse(AidenInlineCardDeckLayout.isVisible(index: 3, selection: 0, count: 5))
        XCTAssertEqual(
            AidenInlineCardDeckLayout.resistedTranslation(
                current: 0,
                count: 5,
                translation: 100
            ),
            22,
            accuracy: 0.001
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.resistedTranslation(
                current: 1,
                count: 5,
                translation: -100
            ),
            -100,
            accuracy: 0.001
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.dragProgress(translation: -80, width: 320),
            0.25,
            accuracy: 0.001
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.selectedCardOffset(translation: -80),
            -70.4,
            accuracy: 0.001
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.preferredBackgroundIndex(
                selection: 2,
                count: 5,
                translation: -40
            ),
            3
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.preferredBackgroundIndex(
                selection: 2,
                count: 5,
                translation: 40
            ),
            1
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.preferredBackgroundIndex(
                selection: 0,
                count: 5,
                translation: 40
            ),
            1
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.resolvedSelection(
                current: 1,
                count: 5,
                translation: -20,
                predictedTranslation: -120
            ),
            2
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.resolvedSelection(
                current: 1,
                count: 5,
                translation: 20,
                predictedTranslation: 30
            ),
            1
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.resolvedSelection(
                current: 0,
                count: 5,
                translation: 120,
                predictedTranslation: 160
            ),
            0
        )
    }

    func testInlineCardDeckAnchorsToTheMessageSenderEdge() {
        XCTAssertEqual(AidenMessageMediaEdge.forRole(.user), .trailing)
        XCTAssertEqual(AidenMessageMediaEdge.forRole(.assistant), .leading)
        XCTAssertLessThan(AidenMessageMediaEdge.trailing.backgroundRotationDegrees, 0)
        XCTAssertGreaterThan(AidenMessageMediaEdge.leading.backgroundRotationDegrees, 0)
    }

    func testUserImageAttachmentsSitOutsideTheTextBubble() {
        XCTAssertTrue(AidenMessageContentSurface.usesRaisedBubble(role: .user, content: .text))
        XCTAssertTrue(AidenMessageContentSurface.usesRaisedBubble(
            role: .user,
            content: .fallbackAttachment
        ))
        XCTAssertFalse(AidenMessageContentSurface.usesRaisedBubble(
            role: .user,
            content: .imageAttachment
        ))
        XCTAssertFalse(AidenMessageContentSurface.usesRaisedBubble(
            role: .assistant,
            content: .text
        ))
    }

    func testAttachmentThumbnailCacheSeparatesContentAndRequestedResolution() {
        let imageA = Data("image-a".utf8)
        let imageB = Data("image-b".utf8)
        let key = AidenAttachmentThumbnailCacheKey.make(data: imageA, maximumPixelSize: 960)

        XCTAssertEqual(
            key,
            AidenAttachmentThumbnailCacheKey.make(data: imageA, maximumPixelSize: 960)
        )
        XCTAssertNotEqual(
            key,
            AidenAttachmentThumbnailCacheKey.make(data: imageB, maximumPixelSize: 960)
        )
        XCTAssertNotEqual(
            key,
            AidenAttachmentThumbnailCacheKey.make(data: imageA, maximumPixelSize: 2_560)
        )
    }

    func testPhotoLibraryUsageDescriptionIsExplicitAndSaveOnly() throws {
        let value = try XCTUnwrap(
            Bundle.main.object(forInfoDictionaryKey: "NSPhotoLibraryAddUsageDescription") as? String
        )
        XCTAssertTrue(value.contains("only when you choose"))
        XCTAssertTrue(value.contains("Save Image"))
    }

    func testAttachmentModelsRoundTripMetadataWithoutInlineContents() throws {
        let json = """
        {"id":"message-1","role":"user","text":"",
        "attachments":[{"id":"att_\(String(repeating: "A", count: 43))","name":"notes.md",
        "mimeType":"text/markdown","kind":"text","size":7}],
        "createdAt":"2026-08-19T07:00:00.000Z"}
        """
        let message = try AidenRemoteJSONDecoder.decode(AidenChatMessage.self, from: Data(json.utf8))
        XCTAssertEqual(message.attachments?.first?.name, "notes.md")
        let encoded = try JSONEncoder().encode(message)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let attachment = try XCTUnwrap((object["attachments"] as? [[String: Any]])?.first)
        XCTAssertNil(attachment["text"])
        XCTAssertNil(attachment["data"])
        XCTAssertNil(attachment["path"])
    }

    func testAttachmentReferenceValidationFailsClosed() {
        let valid = AidenAttachmentReference(
            id: "att_\(String(repeating: "A", count: 43))",
            name: "notes.md",
            mimeType: "text/markdown",
            kind: .text,
            size: 7,
            expiresAt: Date().addingTimeInterval(60)
        )
        XCTAssertTrue(valid.isValid())
        XCTAssertFalse(AidenAttachmentReference(
            id: valid.id,
            name: "../notes.md",
            mimeType: valid.mimeType,
            kind: valid.kind,
            size: valid.size,
            expiresAt: valid.expiresAt
        ).isValid())
        XCTAssertFalse(AidenAttachmentReference(
            id: "attachment-1",
            name: valid.name,
            mimeType: "application/octet-stream",
            kind: valid.kind,
            size: valid.size,
            expiresAt: valid.expiresAt
        ).isValid())
        XCTAssertFalse(AidenAttachmentReference(
            id: valid.id,
            name: valid.name,
            mimeType: valid.mimeType,
            kind: valid.kind,
            size: valid.size,
            expiresAt: Date().addingTimeInterval(-1)
        ).isValid())
    }

    func testTextAttachmentPreparationIsBoundedUTF8AndAllowlisted() throws {
        let upload = try AidenAttachmentPreparation.textUpload(
            data: Data("let value = 1".utf8),
            name: "Example.swift",
            mimeType: "application/octet-stream"
        )
        XCTAssertEqual(
            upload,
            .text(name: "Example.swift", mimeType: "text/plain", text: "let value = 1")
        )
        XCTAssertThrowsError(
            try AidenAttachmentPreparation.textUpload(
                data: Data([0xC3, 0x28]),
                name: "bad.txt",
                mimeType: "text/plain"
            )
        ) { XCTAssertEqual($0 as? AidenAttachmentPreparationError, .invalidText) }
        XCTAssertThrowsError(
            try AidenAttachmentPreparation.textUpload(
                data: Data(repeating: 0x61, count: AidenAttachmentPreparation.maximumTextBytes + 1),
                name: "large.txt",
                mimeType: "text/plain"
            )
        ) { XCTAssertEqual($0 as? AidenAttachmentPreparationError, .fileTooLarge) }
    }

    func testImageAttachmentPreparationPreservesValidPNGBytesAndExtension() throws {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(
            size: CGSize(width: 4_096, height: 2_048),
            format: format
        )
        let source = renderer.pngData { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4_096, height: 2_048))
        }
        let upload = try AidenAttachmentPreparation.imageUpload(data: source, name: "camera.heic")
        guard case .image(let name, let mimeType, let data) = upload else {
            return XCTFail("Expected an image upload")
        }
        XCTAssertEqual(name, "camera.png")
        XCTAssertEqual(mimeType, "image/png")
        XCTAssertEqual(data, source)
        XCTAssertLessThanOrEqual(data.count, AidenAttachmentPreparation.maximumImageBytes)
    }

    func testImageAttachmentPreparationDoesNotFlattenTransparentPNG() throws {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = false
        let source = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32), format: format).pngData { context in
            UIColor.clear.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
            UIColor.systemPink.withAlphaComponent(0.5).setFill()
            context.fill(CGRect(x: 8, y: 8, width: 16, height: 16))
        }
        let upload = try AidenAttachmentPreparation.imageUpload(data: source, name: "diagram.png")
        guard case .image(let name, let mimeType, let data) = upload else {
            return XCTFail("Expected an image upload")
        }
        XCTAssertEqual(name, "diagram.png")
        XCTAssertEqual(mimeType, "image/png")
        XCTAssertEqual(data, source)
    }

    func testImageAttachmentValidationRejectsTruncatedPixelData() throws {
        let source = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).pngData { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        }
        let truncated = Data(source.prefix(source.count / 2))
        XCTAssertNil(AidenAttachmentImageValidation.validatedData(
            truncated,
            mimeType: "image/png",
            declaredSize: truncated.count
        ))
    }

    func testTextFilePreparationReadsABoundedPrefixAndMarksTruncation() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "aiden-attachment-\(UUID().uuidString).txt")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data(repeating: 0x61, count: AidenAttachmentPreparation.maximumTextBytes + 100).write(to: url)
        let upload = try AidenAttachmentPreparation.fileUpload(url: url)
        guard case .text(_, let mimeType, let text) = upload else {
            return XCTFail("Expected a text upload")
        }
        XCTAssertEqual(mimeType, "text/plain")
        XCTAssertTrue(text.hasSuffix("… [truncated]"))
        XCTAssertLessThanOrEqual(text.unicodeScalars.count, AidenAttachmentPreparation.maximumTextScalars)
        XCTAssertLessThanOrEqual(Data(text.utf8).count, AidenAttachmentPreparation.maximumTextBytes)
    }

    func testPhotoTransferPreservesOriginalNameWithoutDependingOnTemporaryExtension() throws {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "aiden-extensionless-photo-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: url) }
        let source = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).pngData { context in
            UIColor.systemPurple.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        }
        try source.write(to: url)

        let upload = try AidenAttachmentPreparation.fileUpload(
            url: url,
            preferredName: "Summer Photo.PNG",
            forceImage: true
        )
        guard case .image(let name, let mimeType, _) = upload else {
            return XCTFail("Expected an image upload")
        }
        XCTAssertEqual(name, "Summer Photo.png")
        XCTAssertEqual(mimeType, "image/png")
    }

    func testTurnAttemptTrackerReusesOnlyTheExactAmbiguousRequestKey() {
        var tracker = AidenTurnAttemptTracker()
        let request = AidenTurnStart(text: "Hello", attachmentIds: ["att_\(String(repeating: "A", count: 43))"])
        let first = tracker.key(for: request)
        XCTAssertEqual(tracker.key(for: request), first)
        XCTAssertNotEqual(tracker.key(for: AidenTurnStart(text: "Edited")), first)
        tracker.reset()
        XCTAssertNotEqual(tracker.key(for: request), first)
    }

    func testTurnRequestBuilderPreservesUploadedAttachmentReferences() {
        let firstID = "att_\(String(repeating: "A", count: 43))"
        let secondID = "att_\(String(repeating: "B", count: 43))"
        let attachments = [
            AidenAttachmentReference(
                id: firstID,
                name: "photo.jpg",
                mimeType: "image/jpeg",
                kind: .image,
                size: 128,
                expiresAt: Date(timeIntervalSince1970: 2_000_000_000)
            ),
            AidenAttachmentReference(
                id: secondID,
                name: "notes.md",
                mimeType: "text/markdown",
                kind: .text,
                size: 64,
                expiresAt: Date(timeIntervalSince1970: 2_000_000_000)
            ),
        ]

        let request = AidenTurnRequestBuilder.make(
            text: "Review these",
            providerId: "provider",
            modelId: "model",
            thinkingLevel: "high",
            attachments: attachments
        )

        XCTAssertEqual(request.attachmentIds, [firstID, secondID])
        XCTAssertNil(AidenTurnRequestBuilder.make(
            text: "No files",
            providerId: nil,
            modelId: nil,
            thinkingLevel: nil,
            attachments: []
        ).attachmentIds)
    }

#if DEBUG
    @MainActor
    func testBotChatViewModelRejectsProviderAndModelPickerMutations() {
        var chat = sampleChat()
        chat.botId = "bot-life-manager"
        let model = AidenChatViewModel(readOnlyFixture: chat)

        model.selectProvider("google")
        model.selectModel("gemini-flash")

        XCTAssertTrue(model.usesPersistedBotModelAuthority)
        XCTAssertFalse(model.showsComposerModelControl)
        XCTAssertEqual(model.selectedProviderId, "openai")
        XCTAssertEqual(model.selectedModelId, "gpt-5.6")

        var workspaceChat = sampleChat()
        workspaceChat.botId = nil
        let workspaceModel = AidenChatViewModel(readOnlyFixture: workspaceChat)
        XCTAssertFalse(workspaceModel.usesPersistedBotModelAuthority)
        XCTAssertTrue(workspaceModel.showsComposerModelControl)
    }

    @MainActor
    func testBotImageAuthorityFailsClosedAndUsesSetupRecoveryForPendingImages() {
        var chat = sampleChat()
        chat.botId = "bot-life-manager"
        let model = AidenChatViewModel(readOnlyFixture: chat)

        XCTAssertFalse(model.acceptsImageAttachments)
        XCTAssertEqual(
            aidenImageSendRecovery(
                isBotChat: true,
                acceptsImages: model.acceptsImageAttachments,
                hasPendingImage: true
            ),
            .configureBotVision
        )

        model.setBotVisionModelSelection(AidenBotModelSelection(
            providerId: "provider-vision",
            modelId: "model-vision"
        ))
        XCTAssertTrue(model.acceptsImageAttachments)
        model.setBotVisionModelSelection(nil)
        model.setBotPrimarySupportsImages(true)
        XCTAssertTrue(model.acceptsImageAttachments)
    }

    @MainActor
    func testReadOnlyFixtureChatRejectsEveryLiveEntryPointWithoutMutatingItsChat() async {
        let chat = sampleChat()
        let model = AidenChatViewModel(readOnlyFixture: chat)

        XCTAssertFalse(model.isConnected)
        XCTAssertFalse(model.canSend)
        XCTAssertFalse(model.isLoading)
        XCTAssertFalse(model.isStreaming)
        XCTAssertTrue(model.isReadOnlyPresentation)

        model.draft = "This must stay local"
        await model.load()
        await model.send()
        let rejectedUploads = await model.upload([
            .text(name: "fixture.txt", mimeType: "text/plain", text: "fixture")
        ])
        await model.stop()
        await model.respondToApproval(.allow, approvalID: "stale")

        XCTAssertEqual(rejectedUploads, 1)
        XCTAssertEqual(model.chat, chat)
        XCTAssertEqual(model.draft, "This must stay local")
        XCTAssertTrue(model.pendingAttachments.isEmpty)
        XCTAssertNil(model.presentedError)
    }
#endif

    private func eventJSON(sequence: Int, type: String, payload: String) -> String {
        """
        {"protocolVersion":1,"streamId":"stream-1","sequence":\(sequence),
        "timestamp":"2026-08-19T07:00:00.000Z","type":"\(type)","terminal":false,"payload":\(payload)}
        """
    }

    private func sampleChat() -> AidenChat {
        AidenChat(
            id: "chat-1",
            workspaceId: "workspace-1",
            title: "Aiden chat",
            providerId: "openai",
            modelId: "gpt-5.6",
            messages: [
                AidenChatMessage(
                    id: "message-1",
                    role: .user,
                    text: "Hello",
                    createdAt: Date(timeIntervalSince1970: 1_787_100_000)
                ),
            ],
            createdAt: Date(timeIntervalSince1970: 1_787_100_000),
            updatedAt: Date(timeIntervalSince1970: 1_787_100_001),
            revision: "revision-1"
        )
    }
}

@MainActor
private final class AidenHeldAttachmentPreparation {
    private var continuation: CheckedContinuation<Void, Never>?

    func wait(onStart: () -> Void) async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            onStart()
        }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private final class AidenHeldDraftReadFileManager: FileManager, @unchecked Sendable {
    private let lock = NSLock()
    private let release = DispatchSemaphore(value: 0)
    private var onRead: (@Sendable () -> Void)?
    private var timedOut = false

    var didTimeOut: Bool { lock.withLock { timedOut } }

    func holdNextRead(_ onRead: @escaping @Sendable () -> Void) {
        lock.withLock { self.onRead = onRead }
    }

    func releaseRead() { release.signal() }

    override func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any] {
        let callback = lock.withLock {
            let callback = onRead
            onRead = nil
            return callback
        }
        if let callback {
            callback()
            if release.wait(timeout: .now() + 10) == .timedOut {
                lock.withLock { timedOut = true }
            }
        }
        return try super.attributesOfItem(atPath: path)
    }
}

private final class AidenChatProgressMemoryKeychain: KeychainStoring {
    private var values: [String: String] = [:]

    func save(_ value: String, forKey key: KeychainStore.Key) throws {
        values[key.rawValue] = value
    }

    func load(_ key: KeychainStore.Key) throws -> String? {
        values[key.rawValue]
    }

    func delete(_ key: KeychainStore.Key) throws {
        values[key.rawValue] = nil
    }

    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        values[KeychainStore.scopedKey(key, scope: scope)] = value
    }

    func load(_ key: KeychainStore.Key, scope: String) throws -> String? {
        values[KeychainStore.scopedKey(key, scope: scope)]
    }

    func delete(_ key: KeychainStore.Key, scope: String) throws {
        values[KeychainStore.scopedKey(key, scope: scope)] = nil
    }
}

private final class AidenChatProgressLifecycleURLProtocol: URLProtocol, @unchecked Sendable {
    enum Mode: Sendable, Equatable {
        case denied
        case finite
        case rosterFailsAfterFirst
        case rosterEpochRotates
        case controls
        case legacyControls
        case mismatchedStop
        case mismatchedApproval
        case revokedControls
        case unsupportedControls
    }

    typealias Override = @Sendable (URLRequest) -> (Int, String, Data)?
    nonisolated(unsafe) private static var responseOverride: Override?
    static func setResponseOverride(_ handler: @escaping Override) {
        lock.withLock { responseOverride = handler }
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var _controlWriteCount = 0
    nonisolated(unsafe) private static var approvalID = "approval-current"
    nonisolated(unsafe) private static var approvalReadFails = false
    static func failApprovalReads() { lock.withLock { approvalReadFails = true } }
    static var controlWriteCount: Int { lock.withLock { _controlWriteCount } }
    static func setApprovalID(_ id: String) { lock.withLock { approvalID = id } }
    nonisolated(unsafe) private static var mode: Mode = .denied
    nonisolated(unsafe) private static var _progressRequestCount = 0
    nonisolated(unsafe) private static var _agentRequestCount = 0
    nonisolated(unsafe) private static var _attachmentDeleteCount = 0
    static var attachmentDeleteCount: Int { lock.withLock { _attachmentDeleteCount } }
    nonisolated(unsafe) private static var _uploadRequestCount = 0
    static var uploadRequestCount: Int { lock.withLock { _uploadRequestCount } }
    nonisolated(unsafe) private static var _turnRequestCount = 0
    static var turnRequestCount: Int { lock.withLock { _turnRequestCount } }
    nonisolated(unsafe) private static var heldPathSuffix: String?
    nonisolated(unsafe) private static var onHeldRequest: (@Sendable () -> Void)?
    nonisolated(unsafe) private static var heldCompletion: (@Sendable () -> Void)?

    static func holdNextRequest(endingIn suffix: String, onRequest: @escaping @Sendable () -> Void) {
        lock.withLock {
            heldPathSuffix = suffix
            onHeldRequest = onRequest
        }
    }

    static func takeHeldRequest() -> (@Sendable () -> Void)? {
        lock.withLock {
            let completion = heldCompletion
            heldCompletion = nil
            return completion
        }
    }

    static func releaseHeldRequest() { takeHeldRequest()?() }

    static var progressRequestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _progressRequestCount
    }

    static var agentRequestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _agentRequestCount
    }

    static func reset(mode: Mode = .denied) {
        releaseHeldRequest()
        lock.lock()
        self.mode = mode
        _controlWriteCount = 0
        approvalID = "approval-current"
        approvalReadFails = false
        responseOverride = nil
        _progressRequestCount = 0
        _agentRequestCount = 0
        _turnRequestCount = 0
        _uploadRequestCount = 0
        _attachmentDeleteCount = 0
        heldPathSuffix = nil
        onHeldRequest = nil
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        if path.contains("/attachments/"), request.httpMethod == "DELETE" { Self.lock.withLock { Self._attachmentDeleteCount += 1 } }
        if path.hasSuffix("/attachments"), request.httpMethod == "POST" { Self.lock.withLock { Self._uploadRequestCount += 1 } }
        if path.hasSuffix("/turns") { Self.lock.withLock { Self._turnRequestCount += 1 } }
        let result: (HTTPURLResponse, Data)
        var shouldFinish = true
        if let custom = Self.lock.withLock({ Self.responseOverride })?(request) {
            result = Self.response(for: request, status: custom.0, contentType: custom.1, data: custom.2)
        } else {
        switch path {
        case "/api/aiden/v1/server":
            var body: [String: Any] = [
                "protocolVersion": 1, "instanceId": "instance-progress-lifecycle",
                "name": "Progress Lifecycle Mac", "appVersion": "1.0",
                "capabilities": ["server:read", "workspace:read", "chat:read", "chat:write", "tasks:read", "agents:read", "approval:respond"],
                "serverCapabilities": ["server:read", "workspace:read", "chat:read", "chat:write", "tasks:read", "agents:read", "approval:respond"],
                "features": ["chat-tasks-v1", "chat-agents-v1"],
                "connectionMode": "lan", "serverTime": "2026-09-14T12:00:00Z",
            ]
            if Self.lock.withLock({ Self.mode == .unsupportedControls }) {
                body["capabilities"] = (body["capabilities"] as! [String]).filter { $0 != "approval:respond" }
            }
            if Self.lock.withLock({ Self.mode == .legacyControls }) {
                body.removeValue(forKey: "serverCapabilities")
                body["features"] = [String]()
                body["capabilities"] = ["server:read", "workspace:read", "chat:read", "chat:write", "approval:respond"]
            }
            result = Self.response(for: request, status: 200, contentType: "application/json", data: try! JSONSerialization.data(withJSONObject: body))
        case "/api/aiden/v1/streams/stream-control":
            result = Self.response(for: request, status: 200, contentType: "application/json", data: Data(#"{"streamId":"stream-control","chatId":"chat-progress-lifecycle","turnId":"turn-control","state":"waiting_for_approval","lastSequence":0,"updatedAt":"2026-09-22T12:00:00Z"}"#.utf8))
        case "/api/aiden/v1/streams/stream-control/events":
            shouldFinish = false
            result = Self.response(for: request, status: 200, contentType: "text/event-stream", data: Data(": keepalive\n\n".utf8))
        case "/api/aiden/v1/streams/stream-control/approval":
            if Self.lock.withLock({ Self.approvalReadFails }) {
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                return
            }
            let id = Self.lock.withLock { Self.approvalID }
            result = Self.response(for: request, status: 200, contentType: "application/json", data: Data("""
                {"approval":{"approvalId":"\(id)","streamId":"stream-control","chatId":"chat-progress-lifecycle","summary":"Review action","toolCallId":"tool-control","toolName":"read_file","expiresAt":"2099-01-01T00:00:00Z","canAllow":true}}
                """.utf8))
        case "/api/aiden/v1/approvals/approval-current/respond", "/api/aiden/v1/streams/stream-control/cancel":
            Self.lock.withLock { Self._controlWriteCount += 1 }
            if Self.lock.withLock({ Self.mode == .mismatchedApproval }) {
                result = Self.response(for: request, status: 200, contentType: "application/json", data: Data(#"{"approvalId":"approval-other","decision":"allow","resolvedAt":"2026-09-22T12:00:00Z"}"#.utf8))
            } else if Self.lock.withLock({ Self.mode == .mismatchedStop }) {
                result = Self.response(for: request, status: 202, contentType: "application/json", data: Data(#"{"streamId":"stream-other","chatId":"chat-progress-lifecycle","turnId":"turn-control","state":"reconciling","lastSequence":0,"updatedAt":"2026-09-22T12:00:00Z"}"#.utf8))
            } else {
            result = Self.response(for: request, status: 503, contentType: "application/json", data: Data(#"{"error":{"code":"internal_error","message":"Unconfirmed","requestId":"request-control","retryable":true}}"#.utf8))
            }
        case "/api/aiden/v1/workspaces":
            result = Self.response(
                for: request,
                status: 200,
                contentType: "application/json",
                data: Data(#"{"workspaces":[]}"#.utf8)
            )
        case "/api/aiden/v1/chats/chat-progress-lifecycle/tasks":
            result = Self.response(
                for: request,
                status: 200,
                contentType: "application/json",
                data: Self.taskSnapshot
            )
        case "/api/aiden/v1/chats/chat-progress-lifecycle/agents":
            let requestedTurn = URLComponents(
                url: request.url!,
                resolvingAgainstBaseURL: false
            )?.queryItems?.first(where: { $0.name == "turnId" })?.value
            let currentMode: Mode
            let requestCount: Int
            Self.lock.lock()
            Self._agentRequestCount += 1
            requestCount = Self._agentRequestCount
            currentMode = Self.mode
            Self.lock.unlock()
            if currentMode == .rosterEpochRotates, requestedTurn == "turn-old" {
                result = Self.response(
                    for: request,
                    status: 200,
                    contentType: "application/json",
                    data: Self.oldHistoricalRosterSnapshot
                )
            } else if currentMode == .rosterEpochRotates {
                let snapshot = switch requestCount {
                case 1: Self.oldRosterSnapshot
                case 2: Self.sameEpochRosterSnapshot
                default: Self.newRosterSnapshot
                }
                result = Self.response(
                    for: request,
                    status: 200,
                    contentType: "application/json",
                    data: snapshot
                )
            } else if currentMode == .rosterFailsAfterFirst, requestCount > 1 {
                result = Self.response(
                    for: request,
                    status: 500,
                    contentType: "application/json",
                    data: Data(
                        #"{"error":{"code":"internal_error","message":"Roster unavailable.","requestId":"progress-request-2","retryable":true}}"#.utf8
                    )
                )
            } else {
                result = Self.response(
                    for: request,
                    status: 200,
                    contentType: "application/json",
                    data: Self.rosterSnapshot
                )
            }
        case "/api/aiden/v1/chats/chat-progress-lifecycle/progress/events":
            let currentMode: Mode
            Self.lock.lock()
            Self._progressRequestCount += 1
            let requestCount = Self._progressRequestCount
            currentMode = Self.mode
            Self.lock.unlock()
            if currentMode == .denied {
                result = Self.response(
                    for: request,
                    status: 403,
                    contentType: "application/json",
                    data: Data(
                        #"{"error":{"code":"capability_denied","message":"Progress access denied.","requestId":"progress-request-1","retryable":false}}"#.utf8
                    )
                )
            } else {
                let payload = String(decoding: Self.taskSnapshot, as: UTF8.self)
                shouldFinish = currentMode != .rosterFailsAfterFirst || requestCount < 2
                if currentMode == .rosterEpochRotates {
                    shouldFinish = requestCount < 3
                }
                result = Self.response(
                    for: request,
                    status: 200,
                    contentType: "text/event-stream",
                    data: Data("id: 1\nevent: task_update\ndata: {\"protocolVersion\":1,\"streamId\":\"chat-progress-lifecycle\",\"sequence\":1,\"timestamp\":\"2026-09-14T12:00:00Z\",\"type\":\"task_update\",\"terminal\":false,\"payload\":\(payload)}\n\n".utf8)
                )
            }
        case "/api/aiden/v1/chats/chat-progress-lifecycle/attachments":
            result = Self.response(
                for: request,
                status: 201,
                contentType: "application/json",
                data: try! JSONSerialization.data(withJSONObject: [
                    "id": "att_" + String(repeating: "a", count: 43),
                    "name": "fixture.txt", "mimeType": "text/plain", "kind": "text", "size": 7,
                    "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3_600)),
                ])
            )
        default:
            result = Self.response(
                for: request,
                status: 404,
                contentType: "application/json",
                data: Data(#"{}"#.utf8)
            )
        }

        }
        let finishes = shouldFinish
        let onHold = Self.lock.withLock { () -> (@Sendable () -> Void)? in
            guard let suffix = Self.heldPathSuffix, path.hasSuffix(suffix) else { return nil }
            Self.heldPathSuffix = nil
            let onHold = Self.onHeldRequest
            Self.onHeldRequest = nil
            Self.heldCompletion = { [self] in complete(result, shouldFinish: finishes) }
            return onHold
        }
        if let onHold {
            onHold()
            return
        }
        complete(result, shouldFinish: shouldFinish)
    }

    private func complete(_ result: (HTTPURLResponse, Data), shouldFinish: Bool) {
        client?.urlProtocol(self, didReceive: result.0, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.1)
        if shouldFinish {
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    private static let taskSnapshot = Data(
        """
        {"version":1,"chatId":"chat-progress-lifecycle","availability":"ready","epoch":"epoch-lifecycle","revision":1,"updatedAt":"2026-09-14T12:00:00Z","tasks":[{"id":1,"subject":"Observe lifecycle","status":"in_progress","activeForm":"Observing lifecycle"}]}
        """.utf8
    )

    private static let rosterSnapshot = Data(
        """
        {"version":1,"chatId":"chat-progress-lifecycle","availability":"unavailable","unavailableReason":"unsupported","epoch":"epoch-lifecycle","revision":1,"updatedAt":"2026-09-14T12:00:00Z","agents":[]}
        """.utf8
    )

    private static let oldRosterSnapshot = Data(
        """
        {"version":1,"chatId":"chat-progress-lifecycle","turnId":"turn-current-old","previousTurns":[{"turnId":"turn-old","startedAt":"2026-09-14T11:00:00Z"}],"availability":"ready","epoch":"epoch-old","revision":4,"updatedAt":"2026-09-14T12:00:00Z","agents":[]}
        """.utf8
    )

    private static let newRosterSnapshot = Data(
        """
        {"version":1,"chatId":"chat-progress-lifecycle","turnId":"turn-current-new","previousTurns":[],"availability":"ready","epoch":"epoch-new","revision":1,"updatedAt":"2026-09-14T12:01:00Z","agents":[]}
        """.utf8
    )

    private static let sameEpochRosterSnapshot = Data(
        """
        {"version":1,"chatId":"chat-progress-lifecycle","turnId":"turn-current-middle","previousTurns":[{"turnId":"turn-current-old","startedAt":"2026-09-14T12:00:00Z"},{"turnId":"turn-old","startedAt":"2026-09-14T11:00:00Z"}],"availability":"ready","epoch":"epoch-old","revision":5,"updatedAt":"2026-09-14T12:00:30Z","agents":[]}
        """.utf8
    )

    private static let oldHistoricalRosterSnapshot = Data(
        """
        {"version":1,"chatId":"chat-progress-lifecycle","turnId":"turn-old","previousTurns":[],"availability":"ready","epoch":"epoch-old","revision":5,"updatedAt":"2026-09-14T11:30:00Z","agents":[]}
        """.utf8
    )

    private static func response(
        for request: URLRequest,
        status: Int,
        contentType: String,
        data: Data
    ) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": contentType]
        )!
        return (response, data)
    }
}

final class AidenChatSummaryPerformanceTests: XCTestCase {
    private enum Profile: CaseIterable {
        case small, medium, large, pathological

        var chatCount: Int {
            switch self {
            case .small: 50
            case .medium: 250
            case .large: 1_000
            case .pathological: 2_000
            }
        }

        var messagesPerChat: Int {
            switch self {
            case .small: 10
            case .medium: 50
            case .large: 100
            case .pathological: 100
            }
        }

        var includesMaximumSizedMessages: Bool { self == .pathological }

        func messageCount(chatIndex: Int) -> Int {
            guard self == .pathological else { return messagesPerChat }
            return [1, 10, 100][chatIndex % 3]
        }
    }

    private struct FullChatList: Codable {
        let chats: [AidenChat]
    }

    private struct SummaryPageList: Codable {
        let pages: [AidenChatSummaryPage]
    }

    private struct Fixture {
        let full: Data
        let firstSummaryPage: Data
        let allSummaryPages: Data
        let cachedSummarySnapshot: Data
    }

    private static let fixture: Fixture = makeFixture(profile: .medium)

    func testDeterministicFixtureProfilesCoverRequiredScales() throws {
        XCTAssertEqual(Profile.allCases.map(\.chatCount), [50, 250, 1_000, 2_000])
        XCTAssertEqual(Profile.allCases.map(\.messagesPerChat), [10, 50, 100, 100])
        XCTAssertEqual(Profile.allCases.map(\.includesMaximumSizedMessages), [false, false, false, true])
        for profile in Profile.allCases {
            let fixture = Self.makeFixture(profile: profile)
            let full = try JSONDecoder.aidenRemote().decode(FullChatList.self, from: fixture.full)
            let pages = try JSONDecoder.aidenRemote().decode(
                SummaryPageList.self,
                from: fixture.allSummaryPages
            )
            XCTAssertEqual(full.chats.count, profile.chatCount)
            XCTAssertEqual(pages.pages.flatMap(\.summaries).count, profile.chatCount)
            XCTAssertTrue(pages.pages.allSatisfy { $0.summaries.count <= 200 })
            XCTAssertNil(pages.pages.last?.nextCursor)
        }
    }

    func testDeterministicSummaryFixtureIsMateriallySmallerThanFullChats() throws {
        let fixture = Self.fixture
        let full = try JSONDecoder.aidenRemote().decode(FullChatList.self, from: fixture.full)
        let pages = try JSONDecoder.aidenRemote().decode(SummaryPageList.self, from: fixture.allSummaryPages)

        XCTAssertEqual(full.chats.count, 250)
        XCTAssertEqual(pages.pages.flatMap(\.summaries).count, 250)
        XCTAssertLessThan(fixture.allSummaryPages.count * 5, fixture.full.count)
    }

    func testFullChatJSONDecoderPerformance() {
        let data = Self.fixture.full
        measure(metrics: [XCTClockMetric(), XCTMemoryMetric()]) {
            _ = try! JSONDecoder.aidenRemote().decode(FullChatList.self, from: data)
        }
    }

    func testFirstSummaryPageJSONDecoderPerformance() {
        let data = Self.fixture.firstSummaryPage
        measure(metrics: [XCTClockMetric(), XCTMemoryMetric()]) {
            _ = try! JSONDecoder.aidenRemote().decode(AidenChatSummaryPage.self, from: data)
        }
    }

    func testAllSummaryPagesJSONDecoderPerformance() {
        let data = Self.fixture.allSummaryPages
        measure(metrics: [XCTClockMetric(), XCTMemoryMetric()]) {
            _ = try! JSONDecoder.aidenRemote().decode(SummaryPageList.self, from: data)
        }
    }

    func testCachedSummarySnapshotJSONDecoderPerformance() {
        let data = Self.fixture.cachedSummarySnapshot
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        measure(metrics: [XCTClockMetric(), XCTMemoryMetric()]) {
            _ = try! decoder.decode(AidenChatCache.SummarySnapshot.self, from: data)
        }
    }

    private static func makeFixture(profile: Profile) -> Fixture {
        let chatCount = profile.chatCount
        let base = Date(timeIntervalSince1970: 1_787_100_000)
        let chats = (0..<chatCount).map { chatIndex in
            let messageCount = profile.messageCount(chatIndex: chatIndex)
            return AidenChat(
                id: String(format: "chat-%04d", chatIndex),
                workspaceId: String(format: "workspace-%03d", chatIndex % 25),
                title: "Deterministic performance chat \(chatIndex)",
                providerId: "openai",
                modelId: "gpt-5.6",
                messages: (0..<messageCount).map { messageIndex in
                    AidenChatMessage(
                        id: String(format: "message-%04d-%04d", chatIndex, messageIndex),
                        role: messageIndex.isMultiple(of: 2) ? .user : .assistant,
                        text: fixtureMessage(
                            profile: profile,
                            chatIndex: chatIndex,
                            messageIndex: messageIndex
                        ),
                        createdAt: base.addingTimeInterval(Double(chatIndex * 100 + messageIndex))
                    )
                },
                createdAt: base.addingTimeInterval(Double(chatIndex * 100)),
                updatedAt: base.addingTimeInterval(Double(chatIndex * 100 + messageCount + 1)),
                revision: summaryRevision(chatIndex),
                titlePending: chatIndex.isMultiple(of: 11) ? true : nil
            )
        }
        let summaries = chats.map { AidenChatSummary(chat: $0) }
            .sorted(by: AidenChatSummaryPage.areInCanonicalOrder)
        let pages = stride(from: 0, to: summaries.count, by: 200).enumerated().map { page, start in
            let end = min(start + 200, summaries.count)
            let nextCursor = end < summaries.count
                ? "cur_page_\(page + 2)." + String(repeating: "C", count: 43)
                : nil
            return try! AidenChatSummaryPage(
                summaries: Array(summaries[start..<end]),
                nextCursor: nextCursor
            )
        }
        let first = pages[0]
        let remoteEncoder = JSONEncoder()
        remoteEncoder.dateEncodingStrategy = .iso8601
        let cacheEncoder = JSONEncoder()
        cacheEncoder.dateEncodingStrategy = .iso8601
        return Fixture(
            full: try! remoteEncoder.encode(FullChatList(chats: chats)),
            firstSummaryPage: try! remoteEncoder.encode(first),
            allSummaryPages: try! remoteEncoder.encode(SummaryPageList(pages: pages)),
            cachedSummarySnapshot: try! cacheEncoder.encode(AidenChatCache.SummarySnapshot(
                summaries: summaries,
                nextCursor: nil
            ))
        )
    }

    private static func fixtureMessage(
        profile: Profile,
        chatIndex: Int,
        messageIndex: Int
    ) -> String {
        let prefix = "Deterministic message \(messageIndex) for chat \(chatIndex). "
        guard profile.includesMaximumSizedMessages,
              chatIndex == 0,
              messageIndex == 0 else {
            return prefix + String(repeating: "fixture ", count: 8)
        }
        return prefix + String(
            repeating: "x",
            count: AidenRemoteProtocol.maxTextLength - prefix.unicodeScalars.count
        )
    }

    private static func summaryRevision(_ chatIndex: Int) -> String {
        "rev_" + String(format: "%043d", chatIndex)
    }
}

final class AidenHapticTests: XCTestCase {
    @MainActor
    private final class RecordingEmitter: AidenHapticEmitting {
        private(set) var events: [AidenHapticEvent] = []

        func activate(scope: UUID) {}
        func deactivate(scope: UUID) {}

        func emit(_ event: AidenHapticEvent, scope: UUID?, dedupeKey: String?) {
            events.append(event)
        }
    }

    @MainActor
    func testPreferenceDefaultsOnAndPersistsDeviceLocally() throws {
        let suiteName = "AidenHapticTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let initial = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { true },
            isAudioCaptureActive: { false },
            supportsHaptics: true
        )
        XCTAssertTrue(initial.isEnabled)
        initial.isEnabled = false

        let restored = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { true },
            isAudioCaptureActive: { false },
            supportsHaptics: true
        )
        XCTAssertFalse(restored.isEnabled)
    }

    @MainActor
    func testDeliveryRequiresHardwareForegroundPreferenceAudioSilenceAndActiveScope() throws {
        let suiteName = "AidenHapticGateTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        var isActive = false
        var isCapturing = false
        let center = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { isActive },
            isAudioCaptureActive: { isCapturing },
            supportsHaptics: true
        )
        let scope = UUID()

        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 0)
        isActive = true
        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 0)
        center.activate(scope: scope)
        isCapturing = true
        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 0)
        isCapturing = false
        center.isEnabled = false
        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 0)
        center.isEnabled = true
        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 1)
        center.deactivate(scope: scope)
        center.play(.error, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 1)
    }

    @MainActor
    func testUnsupportedHardwareNeverAdvancesPulse() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "AidenHapticUnsupportedTests.\(UUID().uuidString)"))
        let center = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { true },
            isAudioCaptureActive: { false },
            supportsHaptics: false
        )
        center.play(.success)
        XCTAssertEqual(center.pulse.sequence, 0)
    }

    @MainActor
    func testDedupeIsConsumedBeforeDeliveryGatesAndIncludesSemanticEvent() throws {
        let suiteName = "AidenHapticDedupeTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        var isActive = false
        let center = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { isActive },
            isAudioCaptureActive: { false },
            supportsHaptics: true
        )

        center.play(.warning, dedupeKey: "operation-1")
        isActive = true
        center.play(.warning, dedupeKey: "operation-1")
        XCTAssertEqual(center.pulse.sequence, 0, "A background observation must never replay later")
        center.play(.success, dedupeKey: "operation-1")
        XCTAssertEqual(center.pulse.sequence, 1, "A different semantic outcome may share a caller key")
        center.play(.success, dedupeKey: "operation-1")
        XCTAssertEqual(center.pulse.sequence, 1)
    }

    @MainActor
    func testProtocolConveniencePlayDelegatesOnceWithoutRecursion() {
        let emitter = RecordingEmitter()
        emitter.play(.warning, dedupeKey: "approval-1")
        XCTAssertEqual(emitter.events, [.warning])
    }

    @MainActor
    func testDeliveryTimeGateRechecksForegroundAudioCaptureAndOriginatingScope() throws {
        let suiteName = "AidenHapticDeliveryRaceTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        var isActive = true
        var isCapturing = false
        let center = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { isActive },
            isAudioCaptureActive: { isCapturing },
            supportsHaptics: true
        )
        let scope = UUID()

        center.activate(scope: scope)
        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.scope, scope)
        XCTAssertTrue(center.shouldDeliverNow(scope: center.pulse.scope))
        center.deactivate(scope: scope)
        XCTAssertFalse(
            center.shouldDeliverNow(scope: center.pulse.scope),
            "A queued pulse must not survive its view being dismissed in the same render batch"
        )
        center.activate(scope: scope)
        isActive = false
        XCTAssertFalse(center.shouldDeliverNow(scope: center.pulse.scope))
        isActive = true
        isCapturing = true
        XCTAssertFalse(center.shouldDeliverNow(scope: center.pulse.scope))
    }

    func testCancellationRecognitionIncludesURLSessionCancellation() {
        XCTAssertTrue(aidenIsCancellation(CancellationError()))
        XCTAssertTrue(aidenIsCancellation(URLError(.cancelled)))
        XCTAssertFalse(aidenIsCancellation(URLError(.timedOut)))
    }

    func testOnlyLocallyStartedStreamsMayAnnounceFeedback() {
        XCTAssertTrue(AidenStreamFeedbackPolicy.localTurn.allowsFeedback)
        XCTAssertFalse(AidenStreamFeedbackPolicy.restoredStream.allowsFeedback)
        XCTAssertTrue(AidenStreamFeedbackDecision.announcesApproval(.localTurn))
        XCTAssertFalse(AidenStreamFeedbackDecision.announcesApproval(.restoredStream))
        XCTAssertEqual(
            AidenStreamFeedbackDecision.terminalEvent(for: .failed, policy: .localTurn),
            .error
        )
        XCTAssertEqual(
            AidenStreamFeedbackDecision.terminalEvent(for: .interrupted, policy: .localTurn),
            .error
        )
        XCTAssertNil(AidenStreamFeedbackDecision.terminalEvent(for: .failed, policy: .restoredStream))
        XCTAssertNil(AidenStreamFeedbackDecision.terminalEvent(for: .cancelled, policy: .localTurn))
        XCTAssertNil(AidenStreamFeedbackDecision.terminalEvent(for: .complete, policy: .localTurn))
    }

    @MainActor
    func testLocalStreamFeedbackIsExactlyOnceWhileRestoredAndDismissedFlowsStaySilent() throws {
        let suiteName = "AidenHapticStreamRaceTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let center = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { true },
            isAudioCaptureActive: { false },
            supportsHaptics: true
        )
        let scope = UUID()
        center.activate(scope: scope)

        if AidenStreamFeedbackDecision.announcesApproval(.localTurn) {
            center.play(.warning, scope: scope, dedupeKey: "approval:approval-1")
        }
        if AidenStreamFeedbackDecision.announcesApproval(.restoredStream) {
            center.play(.warning, scope: scope, dedupeKey: "approval:approval-1")
        }
        XCTAssertEqual(center.pulse.sequence, 1)

        if let event = AidenStreamFeedbackDecision.terminalEvent(for: .failed, policy: .localTurn) {
            center.play(event, scope: scope, dedupeKey: "terminal:stream-1")
            center.play(event, scope: scope, dedupeKey: "terminal:stream-1")
        }
        XCTAssertEqual(center.pulse.sequence, 2, "Response and SSE convergence must announce one terminal outcome")

        if let event = AidenStreamFeedbackDecision.terminalEvent(for: .failed, policy: .restoredStream) {
            center.play(event, scope: scope, dedupeKey: "terminal:restored-stream")
        }
        center.play(.actionStopped, scope: scope, dedupeKey: "turn-stop:stream-1")
        center.play(.actionStopped, scope: scope, dedupeKey: "turn-stop:stream-1")
        XCTAssertEqual(center.pulse.sequence, 3, "Stop response and SSE convergence must announce once")

        center.play(.success, scope: scope, dedupeKey: "pairing:pair-1")
        center.deactivate(scope: scope)
        XCTAssertFalse(center.shouldDeliverNow(scope: center.pulse.scope), "Dismissed pairing must not vibrate")
    }

    func testMutationOutcomesSeparateDefinitiveFailureFromSilentNonOutcomes() {
        let success = AidenRemoteMutationOutcome.success("workspace-1")
        let failure = AidenRemoteMutationOutcome<String>.failure
        let cancelled = AidenRemoteMutationOutcome<String>.cancelled
        let stale = AidenRemoteMutationOutcome<String>.stale
        let busy = AidenRemoteMutationOutcome<String>.busy

        XCTAssertEqual(success.value, "workspace-1")
        XCTAssertFalse(success.isDefinitiveFailure)
        XCTAssertTrue(failure.isDefinitiveFailure)
        XCTAssertFalse(cancelled.isDefinitiveFailure)
        XCTAssertFalse(stale.isDefinitiveFailure)
        XCTAssertFalse(busy.isDefinitiveFailure)
    }
}

final class AidenAppearanceTests: XCTestCase {
    private struct Fixture: Decodable {
        let version: Int
        let presets: [Preset]
    }

    private struct Preset: Decodable {
        let id: String
        let label: String
        let light: Palette
        let dark: Palette
    }

    private struct Palette: Decodable, Equatable {
        let canvas: String
        let sidebar: String
        let raised: String
        let foreground: String
        let secondary: String
        let accent: String
        let success: String
        let warning: String
        let danger: String

        init(_ value: AidenPalette) {
            canvas = value.canvasHex
            sidebar = value.sidebarHex
            raised = value.raisedHex
            foreground = value.foregroundHex
            secondary = value.secondaryHex
            accent = value.accentHex
            success = value.successHex
            warning = value.warningHex
            danger = value.dangerHex
        }
    }

    func testSwiftPalettesExactlyMatchSharedElectronFixture() throws {
        let bundle = Bundle(for: AidenAppearanceTests.self)
        let url = try XCTUnwrap(bundle.url(forResource: "aiden-appearance-v1", withExtension: "json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertEqual(fixture.version, 1)
        XCTAssertEqual(fixture.presets.map(\.id), AidenThemePresetID.allCases.map(\.rawValue))

        for entry in fixture.presets {
            let preset = try XCTUnwrap(AidenThemePresetID(rawValue: entry.id))
            XCTAssertEqual(entry.label, preset.title)
            XCTAssertEqual(entry.light, Palette(AidenThemeCatalog.palette(preset: preset, scheme: .light)))
            XCTAssertEqual(entry.dark, Palette(AidenThemeCatalog.palette(preset: preset, scheme: .dark)))
        }
    }

    @MainActor
    func testAppearanceSelectionIsDeviceLocalAndPersistsAllChoices() throws {
        let suiteName = "AidenAppearanceTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let initial = AidenAppearanceStore(defaults: defaults)
        XCTAssertEqual(initial.mode, .system)
        XCTAssertEqual(initial.lightPreset, .aiden)
        XCTAssertEqual(initial.darkPreset, .aiden)
        initial.mode = .dark
        initial.lightPreset = .berry
        initial.darkPreset = .moss
        initial.lightUIFont = .rounded
        initial.darkUIFont = .humanist
        initial.lightCodeFont = .menlo
        initial.darkCodeFont = .monaco
        initial.lightContrast = 72
        initial.darkContrast = 84
        initial.lightTranslucentSidebar = false
        initial.darkTranslucentSidebar = false
        initial.reduceMotion = .on
        initial.uiFontSize = 18
        initial.codeFontSize = 17
        initial.diffMarkers = .color

        let restored = AidenAppearanceStore(defaults: defaults)
        XCTAssertEqual(restored.mode, .dark)
        XCTAssertEqual(restored.lightPreset, .berry)
        XCTAssertEqual(restored.darkPreset, .moss)
        XCTAssertEqual(restored.lightUIFont, .rounded)
        XCTAssertEqual(restored.darkUIFont, .humanist)
        XCTAssertEqual(restored.lightCodeFont, .menlo)
        XCTAssertEqual(restored.darkCodeFont, .monaco)
        XCTAssertEqual(restored.lightContrast, 72)
        XCTAssertEqual(restored.darkContrast, 84)
        XCTAssertFalse(restored.lightTranslucentSidebar)
        XCTAssertFalse(restored.darkTranslucentSidebar)
        XCTAssertEqual(restored.reduceMotion, .on)
        XCTAssertEqual(restored.uiFontSize, 18)
        XCTAssertEqual(restored.codeFontSize, 17)
        XCTAssertEqual(restored.diffMarkers, .color)
        XCTAssertEqual(restored.palette(for: .light).accentHex, "#B42C70")
        XCTAssertEqual(restored.palette(for: .dark).accentHex, "#42B596")
        XCTAssertNotEqual(restored.palette(for: .light).secondaryHex, "#6E6470")
        XCTAssertTrue(restored.resolvedReduceMotion(system: false))

        restored.lightContrast = -10
        restored.darkContrast = 110
        restored.uiFontSize = 99
        restored.codeFontSize = 1
        let normalized = AidenAppearanceStore(defaults: defaults)
        XCTAssertEqual(normalized.lightContrast, 0)
        XCTAssertEqual(normalized.darkContrast, 100)
        XCTAssertEqual(normalized.uiFontSize, 18)
        XCTAssertEqual(normalized.codeFontSize, 10)
    }

    func testUnifiedWorkspaceSidebarProjectsOwnedChatsWithoutDuplicates() {
        let base = Date(timeIntervalSince1970: 1_000)
        let workspaces = [
            AidenWorkspace(
                id: "alpha",
                name: "Alpha",
                permission: .ask,
                hasFolder: true,
                isManagedWorktree: false,
                branchName: nil,
                repositoryName: nil,
                git: nil,
                createdAt: base,
                updatedAt: base.addingTimeInterval(20),
                revision: "alpha-r1"
            ),
            AidenWorkspace(
                id: "beta",
                name: "Beta",
                permission: .ask,
                hasFolder: false,
                isManagedWorktree: false,
                branchName: nil,
                repositoryName: nil,
                git: nil,
                createdAt: base,
                updatedAt: base.addingTimeInterval(10),
                revision: "beta-r1"
            ),
        ]
        let chats = [
            AidenChat(
                id: "alpha-chat",
                workspaceId: "alpha",
                title: "Review API",
                providerId: nil,
                modelId: nil,
                messages: [],
                createdAt: base,
                updatedAt: base.addingTimeInterval(30),
                revision: "chat-r1"
            ),
            AidenChat(
                id: "orphan-chat",
                workspaceId: "removed",
                title: "Removed",
                providerId: nil,
                modelId: nil,
                messages: [],
                createdAt: base,
                updatedAt: base.addingTimeInterval(40),
                revision: "chat-r2"
            ),
        ]

        let projection = AidenWorkspaceSidebarProjection.make(
            workspaces: workspaces,
            chats: chats,
            searchText: ""
        )
        XCTAssertEqual(projection.sections.map(\.workspace.id), ["alpha", "beta"])
        XCTAssertEqual(projection.sections[0].chats.map(\.id), ["alpha-chat"])
        XCTAssertEqual(projection.sections[1].chats, [])
        XCTAssertEqual(projection.recents.map(\.id), ["alpha-chat"])

        let search = AidenWorkspaceSidebarProjection.make(
            workspaces: workspaces,
            chats: chats,
            searchText: "api"
        )
        XCTAssertEqual(search.sections.map(\.workspace.id), ["alpha"])
        XCTAssertEqual(search.recents.map(\.id), ["alpha-chat"])
    }

    @MainActor
    func testUnifiedWorkspaceSidebarPreferencesPersistPerInstallation() throws {
        let suiteName = "AidenWorkspaceSidebarTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = AidenProductNavigationStore(defaults: defaults)
        XCTAssertEqual(store.workspaceSidebarOrganization(for: "mac-one"), .workspace)
        store.setWorkspaceSidebarOrganization(.recent, for: "mac-one")
        store.toggleExpandedSidebarWorkspace("alpha", for: "mac-one")
        store.toggleExpandedSidebarWorkspace("beta", for: "mac-two")

        let restored = AidenProductNavigationStore(defaults: defaults)
        XCTAssertEqual(restored.workspaceSidebarOrganization(for: "mac-one"), .recent)
        XCTAssertEqual(restored.workspaceSidebarOrganization(for: "mac-two"), .workspace)
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-one"), ["alpha"])
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-two"), ["beta"])

        restored.pruneExpandedSidebarWorkspaces(validWorkspaceIDs: ["other"], for: "mac-one")
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-one"), [])
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-two"), ["beta"])

        restored.purge(instanceID: "mac-one")
        XCTAssertEqual(restored.workspaceSidebarOrganization(for: "mac-one"), .workspace)
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-one"), [])
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-two"), ["beta"])
    }

    func testWorkspaceSelectionSurvivesAdaptiveLayoutChangesAndReconcilesCRUD() {
        let ids = ["workspace-a", "workspace-b", "workspace-c"]
        var selected = AidenWorkspaceNavigation.reconciledSelection(current: nil, workspaceIDs: ids)
        XCTAssertEqual(selected, "workspace-a")

        selected = "workspace-b"
        XCTAssertEqual(
            AidenWorkspaceNavigation.reconciledSelection(current: selected, workspaceIDs: ids),
            "workspace-b",
            "Compact/regular layout changes must not replace a valid selection"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.reconciledSelection(current: selected, workspaceIDs: ["workspace-a", "workspace-c"]),
            "workspace-a",
            "Removing the selected workspace should converge on an available detail"
        )
        XCTAssertNil(AidenWorkspaceNavigation.reconciledSelection(current: selected, workspaceIDs: []))
    }

    func testCompactWorkspacePathPreservesOnlyAnAvailableDestination() {
        let ids = ["workspace-a", "workspace-b", "workspace-c"]

        XCTAssertEqual(
            AidenWorkspaceNavigation.reconciledCompactPath(
                current: ["workspace-a", "workspace-b"],
                workspaceIDs: ids
            ),
            ["workspace-b"],
            "Compact navigation should preserve the visible workspace when SwiftUI reports a deeper path"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.reconciledCompactPath(
                current: ["workspace-b"],
                workspaceIDs: ["workspace-a", "workspace-c"]
            ),
            [],
            "Deleting the visible workspace should pop back to the workspace list"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.reconciledCompactPath(current: [], workspaceIDs: ids),
            []
        )
    }

    func testCompactWorkspacePathOnlyPushesWhenTransitioningFromSplitView() {
        let ids = ["workspace-a", "workspace-b"]

        XCTAssertEqual(
            AidenWorkspaceNavigation.compactPath(
                enteringFromSplit: true,
                current: [],
                selectedWorkspaceID: "workspace-b",
                workspaceIDs: ids
            ),
            ["workspace-b"],
            "An iPad size-class transition should preserve the workspace that was visible in split view"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.compactPath(
                enteringFromSplit: false,
                current: [],
                selectedWorkspaceID: "workspace-a",
                workspaceIDs: ids
            ),
            [],
            "Launching on iPhone should start at the workspace list instead of auto-pushing the first row"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.compactPath(
                enteringFromSplit: true,
                current: ["workspace-a"],
                selectedWorkspaceID: "workspace-b",
                workspaceIDs: ids
            ),
            ["workspace-a"],
            "An existing compact destination should win over stale split-view selection"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.compactPath(
                enteringFromSplit: true,
                current: [],
                selectedWorkspaceID: "workspace-missing",
                workspaceIDs: ids
            ),
            []
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.compactPath(
                enteringFromSplit: true,
                current: ["workspace-a"],
                selectedWorkspaceID: "workspace-a",
                workspaceIDs: ids,
                preservingSelectedChat: true
            ),
            [],
            "A selected chat should remain the compact destination across a size-class transition"
        )
    }

    @MainActor
    func testWorkspaceArchivesAreDeviceLocalPersistentAndInstallationScoped() throws {
        let suiteName = "AidenWorkspaceArchiveTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = AidenWorkspaceArchiveStore(defaults: defaults)
        XCTAssertFalse(store.hasAcknowledgedDeviceOnlyArchive)
        XCTAssertEqual(store.archivedWorkspaceIDs(for: "mac-one"), [])

        store.acknowledgeDeviceOnlyArchive()
        store.archive(workspaceID: "workspace-a", instanceID: "mac-one")
        store.archive(workspaceID: "workspace-b", instanceID: "mac-one")
        store.archive(workspaceID: "workspace-a", instanceID: "mac-two")

        let restored = AidenWorkspaceArchiveStore(defaults: defaults)
        XCTAssertTrue(restored.hasAcknowledgedDeviceOnlyArchive)
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-one"), ["workspace-a", "workspace-b"])
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-two"), ["workspace-a"])
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: nil), [])

        restored.unarchive(workspaceID: "workspace-a", instanceID: "mac-one")
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-one"), ["workspace-b"])
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-two"), ["workspace-a"])
    }

    @MainActor
    func testWorkspaceArchivePruningOnlyDropsMissingServerRecordsForActiveInstallation() throws {
        let suiteName = "AidenWorkspaceArchivePruneTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = AidenWorkspaceArchiveStore(defaults: defaults)
        store.archive(workspaceID: "keep", instanceID: "mac-one")
        store.archive(workspaceID: "removed", instanceID: "mac-one")
        store.archive(workspaceID: "other-installation", instanceID: "mac-two")

        store.prune(instanceID: "mac-one", validWorkspaceIDs: ["keep", "active"])

        XCTAssertEqual(store.archivedWorkspaceIDs(for: "mac-one"), ["keep"])
        XCTAssertEqual(store.archivedWorkspaceIDs(for: "mac-two"), ["other-installation"])

        let restored = AidenWorkspaceArchiveStore(defaults: defaults)
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-one"), ["keep"])
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-two"), ["other-installation"])
    }

    func testPhotoLibraryUsageDescriptionCoversPickerAndSaveActions() throws {
        let saveValue = try XCTUnwrap(
            Bundle.main.object(forInfoDictionaryKey: "NSPhotoLibraryAddUsageDescription") as? String
        )
        XCTAssertTrue(saveValue.contains("only when you choose"))
        XCTAssertTrue(saveValue.contains("Save Image"))

        let pickerValue = try XCTUnwrap(
            Bundle.main.object(forInfoDictionaryKey: "NSPhotoLibraryUsageDescription") as? String
        )
        XCTAssertTrue(pickerValue.contains("when you open the attachment picker"))
        XCTAssertTrue(pickerValue.contains("paired Mac"))
    }

    func testAttachmentPickerSelectionPreservesTapOrderAndHonorsCapacity() {
        var selected: [String] = []
        selected = AidenAttachmentPickerPolicy.toggledSelection(selected, id: "photo-2", capacity: 2)
        selected = AidenAttachmentPickerPolicy.toggledSelection(selected, id: "photo-1", capacity: 2)
        XCTAssertEqual(selected, ["photo-2", "photo-1"])

        selected = AidenAttachmentPickerPolicy.toggledSelection(selected, id: "photo-3", capacity: 2)
        XCTAssertEqual(selected, ["photo-2", "photo-1"])

        selected = AidenAttachmentPickerPolicy.toggledSelection(selected, id: "photo-2", capacity: 2)
        XCTAssertEqual(selected, ["photo-1"])
    }

    func testAttachmentPickerRefreshDropsInaccessibleSelectionAndKeepsOrder() {
        let selected = ["first", "removed", "last"]
        XCTAssertEqual(
            AidenAttachmentPickerPolicy.visibleSelection(selected, visibleIDs: ["last", "first"]),
            ["first", "last"]
        )
        XCTAssertTrue(AidenAttachmentPickerPolicy.visibleSelection(selected, visibleIDs: []).isEmpty)
    }

    func testPhotoLibraryBoundedRenderingKeepsTransparency() throws {
        XCTAssertEqual(AidenPhotoLibraryImageLoader.maximumRequestedPixelDimension, 2_048)
        let format = UIGraphicsImageRendererFormat.default()
        format.opaque = false
        let transparent = UIGraphicsImageRenderer(
            size: CGSize(width: 32, height: 32), format: format
        ).image { context in
            UIColor.red.withAlphaComponent(0.5).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        }
        let data = try AidenPhotoLibraryImageLoader.encodedData(from: transparent)
        XCTAssertTrue(data.starts(with: [0x89, 0x50, 0x4E, 0x47]))

        let opaqueFormat = UIGraphicsImageRendererFormat.default()
        opaqueFormat.opaque = true
        let opaque = UIGraphicsImageRenderer(
            size: CGSize(width: 32, height: 32), format: opaqueFormat
        ).image { context in
            UIColor.blue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        }
        let jpeg = try AidenPhotoLibraryImageLoader.encodedData(from: opaque)
        XCTAssertTrue(jpeg.starts(with: [0xFF, 0xD8]))
    }

    func testPhotoLibraryTerminalCallbacksAreNotDiscardedAsDegraded() {
        let degraded: [AnyHashable: Any] = [PHImageResultIsDegradedKey: true]
        XCTAssertTrue(AidenPhotoLibraryImageLoader.isNonterminalDegradedResult(degraded))
        XCTAssertFalse(AidenPhotoLibraryImageLoader.isNonterminalDegradedResult([
            PHImageResultIsDegradedKey: true,
            PHImageCancelledKey: true,
        ]))
        XCTAssertFalse(AidenPhotoLibraryImageLoader.isNonterminalDegradedResult([
            PHImageResultIsDegradedKey: true,
            PHImageErrorKey: NSError(domain: "PhotoKitTest", code: 1),
        ]))
    }

    func testAttachmentPickerCapacityAndConfirmationCopyAreBounded() {
        XCTAssertEqual(AidenAttachmentPickerPolicy.availableCapacity(pendingCount: 0), 10)
        XCTAssertEqual(AidenAttachmentPickerPolicy.availableCapacity(pendingCount: 9), 1)
        XCTAssertEqual(AidenAttachmentPickerPolicy.availableCapacity(pendingCount: 12), 0)
        XCTAssertEqual(AidenAttachmentPickerPolicy.confirmationLabel(count: 1), "Add 1 Photo")
        XCTAssertEqual(AidenAttachmentPickerPolicy.confirmationLabel(count: 3), "Add 3 Photos")
    }

    func testAttachmentPickerPresentationIsSubtleAsymmetricAndReducedMotionAware() {
        XCTAssertEqual(AidenAttachmentPickerPresentationMotion.hiddenScale, 0.96, accuracy: 0.001)
        XCTAssertEqual(AidenAttachmentPickerPresentationMotion.hiddenVerticalOffset, 8, accuracy: 0.001)
        XCTAssertEqual(AidenAttachmentPickerPresentationMotion.entranceDuration, 0.2, accuracy: 0.001)
        XCTAssertEqual(AidenAttachmentPickerPresentationMotion.exitDuration, 0.16, accuracy: 0.001)
        XCTAssertLessThan(
            AidenAttachmentPickerPresentationMotion.exitDuration,
            AidenAttachmentPickerPresentationMotion.entranceDuration
        )
        XCTAssertNil(AidenAttachmentPickerPresentationMotion.transition(
            isPresented: true,
            reduceMotion: true
        ))
        XCTAssertNotNil(AidenAttachmentPickerPresentationMotion.transition(
            isPresented: false,
            reduceMotion: false
        ))
    }

    func testAttachmentLifecycleFenceRejectsLateWorkWithoutClearingANewerOperation() {
        var fence = AidenAttachmentLifecycleFence()
        let first = fence.begin()
        fence.invalidate()
        let second = fence.begin()

        XCTAssertFalse(fence.consume(first))
        XCTAssertEqual(fence.activeID, second)
        XCTAssertTrue(fence.consume(second))
        XCTAssertNil(fence.activeID)
    }

    func testAttachmentPickerRespectsReadOnlyAndBusyStates() {
        XCTAssertTrue(AidenAttachmentPickerPolicy.canPresent(
            isReadOnly: false,
            isStreaming: false,
            isUploading: false,
            isPreparing: false,
            capacity: 10
        ))
        XCTAssertFalse(AidenAttachmentPickerPolicy.canPresent(
            isReadOnly: true,
            isStreaming: false,
            isUploading: false,
            isPreparing: false,
            capacity: 10
        ))
        XCTAssertFalse(AidenAttachmentPickerPolicy.canPresent(
            isReadOnly: false,
            isStreaming: true,
            isUploading: false,
            isPreparing: false,
            capacity: 10
        ))
        XCTAssertFalse(AidenAttachmentPickerPolicy.canPresent(
            isReadOnly: false,
            isStreaming: false,
            isUploading: false,
            isPreparing: true,
            capacity: 10
        ))
        XCTAssertFalse(AidenAttachmentPickerPolicy.canPresent(
            isReadOnly: false,
            isStreaming: false,
            isUploading: false,
            isPreparing: false,
            capacity: 0
        ))
    }

    func testAttachmentPickerLayoutStaysBoundedAcrossIPadWindowSizes() {
        let fullSize = AidenAttachmentPickerLayout.resolve(
            containerSize: CGSize(width: 1_024, height: 1_260),
            mode: .photos,
            attachmentButtonCenter: CGPoint(x: 50, y: 1_224),
            isPad: true
        )
        XCTAssertEqual(fullSize.panelSize.width, 620, accuracy: 0.001)
        XCTAssertEqual(fullSize.panelSize.height, 700, accuracy: 0.001)
        XCTAssertEqual(AidenAttachmentPickerLayout.photoCellSide(panelWidth: fullSize.panelSize.width), 205)

        let splitView = AidenAttachmentPickerLayout.resolve(
            containerSize: CGSize(width: 540, height: 720),
            mode: .camera,
            attachmentButtonCenter: CGPoint(x: 50, y: 684),
            isPad: true
        )
        XCTAssertEqual(splitView.panelSize.width, 516, accuracy: 0.001)
        XCTAssertLessThanOrEqual(splitView.panelSize.height + splitView.bottomPadding, 720)
        XCTAssertEqual(AidenAttachmentPickerLayout.photoColumnCount, 3)

        let narrowDetailInLandscapeWindow = AidenAttachmentPickerLayout.resolve(
            containerSize: CGSize(width: 540, height: 720),
            windowSize: CGSize(width: 1_024, height: 768),
            mode: .photos,
            attachmentButtonCenter: CGPoint(x: 50, y: 684),
            isPad: true
        )
        XCTAssertEqual(narrowDetailInLandscapeWindow.panelSize.width, 488, accuracy: 0.001)
        XCTAssertEqual(narrowDetailInLandscapeWindow.leadingPadding, 26, accuracy: 0.001)

        let unknownWindow = AidenChatReadableLayout.contentWidth(
            containerSize: CGSize(width: 1_024, height: 768),
            windowSize: .zero,
            isPad: true
        )
        XCTAssertEqual(unknownWindow, 512, accuracy: 0.001)
    }

    func testAttachmentPickerLayoutHandlesRotationAndCompactHeight() {
        let landscape = AidenAttachmentPickerLayout.resolve(
            containerSize: CGSize(width: 1_366, height: 900),
            mode: .photos,
            attachmentButtonCenter: CGPoint(x: 50, y: 864),
            isPad: true
        )
        XCTAssertEqual(landscape.panelSize.width, 620, accuracy: 0.001)
        XCTAssertEqual(landscape.panelSize.height, 594, accuracy: 0.001)

        let compactHeight = AidenAttachmentPickerLayout.resolve(
            containerSize: CGSize(width: 375, height: 300),
            mode: .camera,
            attachmentButtonCenter: CGPoint(x: 50, y: 264),
            isPad: false
        )
        XCTAssertEqual(compactHeight.panelSize.width, 351, accuracy: 0.001)
        XCTAssertEqual(compactHeight.panelSize.height, 280, accuracy: 0.001)
        XCTAssertLessThanOrEqual(compactHeight.panelSize.height + compactHeight.bottomPadding, 300)
    }

    @MainActor
    func testAttachmentPickerMovesBetweenMenuCameraAndPhotos() {
        let picker = AidenAttachmentPickerState()
        picker.openMenu()
        XCTAssertEqual(picker.mode, .menu)

        picker.beginShowingCamera()
        XCTAssertEqual(picker.mode, .camera)

        picker.backToMenu()
        picker.beginShowingPhotos()
        XCTAssertEqual(picker.mode, .photos)
        picker.markLibraryForRefresh()
        XCTAssertEqual(picker.libraryStatus, .loading)
    }

    @MainActor
    func testAttachmentPickerDismissalImmediatelyInvalidatesLibraryLoad() {
        let picker = AidenAttachmentPickerState()
        picker.openMenu()
        picker.beginShowingPhotos()
        let generation = picker.markLibraryForRefresh()

        picker.dismiss()

        XCTAssertEqual(picker.mode, .closed)
        XCTAssertFalse(picker.isPresented)
        XCTAssertFalse(picker.isCurrentLibraryLoad(generation))
        XCTAssertTrue(picker.selectedAssetIDs.isEmpty)
    }

    @MainActor
    func testAttachmentPickerIgnoresSupersededAndDismissedLibraryLoads() {
        let picker = AidenAttachmentPickerState()
        picker.openMenu()
        picker.beginShowingPhotos()
        let first = picker.markLibraryForRefresh()
        let second = picker.markLibraryForRefresh()
        picker.applyLibraryResult([], authorization: .denied, generation: first)
        XCTAssertEqual(picker.libraryStatus, .loading)
        picker.applyLibraryResult([], authorization: .authorized, generation: second)
        XCTAssertEqual(picker.libraryStatus, .empty)

        picker.dismiss()
        picker.openMenu()
        picker.beginShowingPhotos()
        let reopened = picker.markLibraryForRefresh()
        picker.applyLibraryResult([], authorization: .denied, generation: second)
        XCTAssertEqual(picker.libraryStatus, .loading)
        picker.applyLibraryResult([], authorization: .denied, generation: reopened)
        XCTAssertEqual(picker.libraryStatus, .denied)
    }

    func testCameraAuthorizationPolicyMapsEveryKnownState() {
        XCTAssertEqual(AidenAttachmentCameraPermissionPolicy.status(for: .authorized), .configuring)
        XCTAssertEqual(AidenAttachmentCameraPermissionPolicy.status(for: .notDetermined), .requestingPermission)
        XCTAssertEqual(AidenAttachmentCameraPermissionPolicy.status(for: .denied), .denied)
        XCTAssertEqual(AidenAttachmentCameraPermissionPolicy.status(for: .restricted), .restricted)
    }
}

private final class AidenStreamRecoveryFixture: @unchecked Sendable {
    private let lock = NSLock()
    private let chat: AidenChat
    private let finalChat: AidenChat?
    private var reads = 0
    private var permitsReconciliation = false
    private var permitsTerminal = true
    var allowTerminal: Bool {
        get { lock.withLock { permitsTerminal } }
        set { lock.withLock { permitsTerminal = newValue } }
    }
    var allowReconciliation: Bool {
        get { lock.withLock { permitsReconciliation } }
        set { lock.withLock { permitsReconciliation = newValue } }
    }
    private var cursors: [Int] = []
    private var cancellations = 0
    var cancelReads: Int { lock.withLock { cancellations } }
    var chatReads: Int { lock.withLock { reads } }
    var eventCursors: [Int] { lock.withLock { cursors } }
    init(chat: AidenChat, finalChat: AidenChat? = nil) { self.chat = chat; self.finalChat = finalChat }

    func response(_ request: URLRequest) -> (Int, String, Data)? {
        lock.withLock {
            let path = request.url!.path
            let error = Data(#"{"error":{"code":"internal_error","message":"Offline transcript","requestId":"r","retryable":true}}"#.utf8)
            if path.hasSuffix("/models") {
                return (200, "application/json", Data(#"{"providers":[{"id":"openai","label":"OpenAI","models":[{"id":"gpt-5.6","label":"GPT"}]}],"defaults":{"providerId":"openai","modelId":"gpt-5.6"}}"#.utf8))
            }
            if path.hasSuffix("/chats/" + chat.id) {
                reads += 1
                if reads > 1, !permitsReconciliation { return (503, "application/json", error) }
                let encoder = JSONEncoder()
                encoder.dateEncodingStrategy = .iso8601
                return (200, "application/json", try! encoder.encode(reads > 1 ? (finalChat ?? chat) : chat))
            }
            if path.hasSuffix("/streams/stream-recovery/cancel") {
                cancellations += 1
                return (202, "application/json", Data("""
                {"streamId":"stream-recovery","chatId":"\(chat.id)","turnId":"turn-recovery","state":"cancelled","lastSequence":2,"updatedAt":"2026-09-22T00:00:00Z"}
                """.utf8))
            }
            if path.hasSuffix("/streams/stream-recovery") {
                return (200, "application/json", Data("""
                {"streamId":"stream-recovery","chatId":"\(chat.id)","turnId":"turn-recovery","state":"running","lastSequence":1,"updatedAt":"2026-09-22T00:00:00Z"}
                """.utf8))
            }
            if path.hasSuffix("/streams/stream-recovery/events") {
                let after = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "after" }?.value
                cursors.append(Int(after ?? "0") ?? -1)
                if cursors.count > 1, !permitsTerminal { return (200, "text/event-stream", Data()) }
                let body = cursors.count == 1
                    ? event(1, "text_delta", #"{"text":"prefix "}"#)
                    : event(2, "text_delta", #"{"text":"suffix"}"#) + event(3, "done", #"{"messageId":"reply"}"#, terminal: true) + event(4, "text_delta", #"{"text":"LATE"}"#)
                return (200, "text/event-stream", Data(body.utf8))
            }
            if path.hasSuffix("/turns") { return (503, "application/json", error) }
            return nil
        }
    }

    private func event(_ sequence: Int, _ type: String, _ payload: String, terminal: Bool = false) -> String {
        "id: \(sequence)\nevent: \(type)\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-recovery\",\"sequence\":\(sequence),\"timestamp\":\"2026-09-22T00:00:00Z\",\"type\":\"\(type)\",\"terminal\":\(terminal),\"payload\":\(payload)}\n\n"
    }
}

private final class AidenHeldChatCacheFileManager: FileManager, @unchecked Sendable {
    private let lock = NSLock()
    private let release = DispatchSemaphore(value: 0)
    private var onWrite: (@Sendable () -> Void)?
    private var timedOut = false
    var didTimeOut: Bool { lock.withLock { timedOut } }
    func holdNextChatWrite(_ callback: @escaping @Sendable () -> Void) { lock.withLock { onWrite = callback } }
    func releaseWrite() { release.signal() }
    override func createDirectory(at url: URL, withIntermediateDirectories createIntermediates: Bool, attributes: [FileAttributeKey: Any]? = nil) throws {
        let callback = lock.withLock { () -> (@Sendable () -> Void)? in
            guard url.lastPathComponent == "chats" else { return nil }
            let result = onWrite
            onWrite = nil
            return result
        }
        if let callback {
            callback()
            if release.wait(timeout: .now() + 10) == .timedOut { lock.withLock { timedOut = true } }
        }
        try super.createDirectory(at: url, withIntermediateDirectories: createIntermediates, attributes: attributes)
    }
}

private actor AidenChatWriteTestGate {
    private var armed = false
    private var continuation: CheckedContinuation<Void, Never>?
    var isHolding: Bool { continuation != nil }
    func arm() { armed = true }
    func waitIfArmed() async {
        guard armed else { return }
        armed = false
        await withCheckedContinuation { continuation = $0 }
    }
    func release() {
        continuation?.resume()
        continuation = nil
    }
}
