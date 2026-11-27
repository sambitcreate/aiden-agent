import Foundation
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenChatMutationSubMachinesTests: XCTestCase {
    private let contextA = AidenRemoteRequestContext(
        instanceId: "inst-1",
        deviceId: "dev-1",
        generation: 1,
        hostGeneration: 1,
        scope: .owner
    )

    private let contextB = AidenRemoteRequestContext(
        instanceId: "inst-1",
        deviceId: "dev-2",
        generation: 2,
        hostGeneration: 2,
        scope: .owner
    )

    private func serverError(_ status: Int, code: String) throws -> AidenRemoteClientError {
        let body = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: Data(#"{"code":"\#(code)","message":"Refused.","requestId":"req-1","retryable":false}"#.utf8)
        )
        return .server(statusCode: status, body: body)
    }

    private func sampleChat(workspaceId: String = "ws-new", revision: String = "rev-2") -> AidenChat {
        AidenChat(
            id: "chat-1",
            workspaceId: workspaceId,
            title: "New chat",
            providerId: nil,
            modelId: nil,
            messages: [],
            createdAt: Date(timeIntervalSince1970: 1_000),
            updatedAt: Date(timeIntervalSince1970: 1_000),
            revision: revision
        )
    }

    // MARK: - Worktree Setup Sub-Machine

    func testWorktreeSetupKeyReuseAndDefinitiveSpending() throws {
        let machine = AidenWorktreeSetupMachine()
        let firstKey = UUID()
        let secondKey = UUID()

        let attempt1 = machine.begin(for: "Build feature", makeKey: { firstKey })
        XCTAssertEqual(attempt1.idempotencyKey, firstKey)
        XCTAssertTrue(machine.isSettingUp)

        // Ambiguous transport error retains key for identical text retry.
        machine.recordFailure(URLError(.timedOut))
        machine.endPhase()
        XCTAssertFalse(machine.isSettingUp)
        XCTAssertEqual(machine.retainedAttempt?.idempotencyKey, firstKey)

        let retry = machine.begin(for: "Build feature", makeKey: { secondKey })
        XCTAssertEqual(retry.idempotencyKey, firstKey)

        // 409 idempotency_in_flight also retains key.
        machine.recordFailure(try serverError(409, code: "idempotency_in_flight"))
        machine.endPhase()
        XCTAssertEqual(machine.retainedAttempt?.idempotencyKey, firstKey)

        // Definitive server refusal spends the key.
        machine.recordFailure(try serverError(409, code: "revision_conflict"))
        XCTAssertNil(machine.retainedAttempt)

        let fresh = machine.begin(for: "Build feature", makeKey: { secondKey })
        XCTAssertEqual(fresh.idempotencyKey, secondKey)
    }

    func testWorktreeSetupCancelAfterFinishGuardAdoptsWorktreeThenThrowsCancellation() async throws {
        let machine = AidenWorktreeSetupMachine()
        let movedChat = sampleChat(workspaceId: "ws-worktree", revision: "rev-wt")
        let movedResult = AidenChatNewWorktree(chat: movedChat, branch: "aiden/build-feature")

        var adoptedWorkspaceId: String?

        // Simulate Cancel pressed right as the Mac returns its moved worktree,
        // after `setup` already finished (so `setup.isCancelled` is false).
        do {
            _ = try await machine.execute(
                text: "Build feature",
                operation: { _ in movedResult },
                onMoved: { moved in
                    // Press cancel while adopting the already-finished result.
                    machine.cancel()
                    XCTAssertTrue(machine.isCanceled)
                    adoptedWorkspaceId = moved.chat.workspaceId
                    return true
                }
            )
            XCTFail("Expected CancellationError from cancel-after-finish guard")
        } catch is CancellationError {
            XCTAssertEqual(adoptedWorkspaceId, "ws-worktree", "Worktree must still be adopted")
            XCTAssertFalse(machine.isSettingUp)
            XCTAssertNil(machine.retainedAttempt, "Moved worktree spends the attempt key")
        }
    }

    // MARK: - Fork & Continue-in-New-Chat Sub-Machines

    func testForkAttemptRetainsKeyOnAmbiguousFailureAndClearsOnSuccessOrRefusal() throws {
        var machine = AidenChatForkAttemptMachine()
        let request = AidenChatForkAttempt.Request(
            chatId: "chat-1",
            revision: "rev-1",
            messageId: "msg-2",
            position: .after,
            summaryFocus: nil
        )
        let key1 = UUID()
        let key2 = UUID()

        let first = machine.begin(context: contextA, request: request, makeKey: { key1 })
        XCTAssertEqual(first.idempotencyKey, key1)

        // Cancellation and transport errors keep the key.
        machine.recordFailure(CancellationError(), for: first)
        XCTAssertEqual(machine.retained?.idempotencyKey, key1)

        machine.recordFailure(URLError(.networkConnectionLost), for: first)
        XCTAssertEqual(machine.retained?.idempotencyKey, key1)

        // 409 idempotency_in_flight keeps the key.
        machine.recordFailure(try serverError(409, code: "idempotency_in_flight"), for: first)
        XCTAssertEqual(machine.retained?.idempotencyKey, key1)

        // Re-attempt with same context + request reuses key1.
        let retry = machine.begin(context: contextA, request: request, makeKey: { key2 })
        XCTAssertEqual(retry.idempotencyKey, key1)

        // Different context mints a new key.
        let otherContext = machine.begin(context: contextB, request: request, makeKey: { key2 })
        XCTAssertEqual(otherContext.idempotencyKey, key2)

        // Definitive server refusal clears retained key.
        machine.recordFailure(try serverError(409, code: "revision_conflict"), for: otherContext)
        XCTAssertNil(machine.retained)

        // Success clears retained key.
        let third = machine.begin(context: contextA, request: request, makeKey: { key1 })
        machine.recordSuccess(third)
        XCTAssertNil(machine.retained)
    }

    func testContinueInNewChatAttemptRetainsKeyOnAmbiguousFailureAndClearsOnDefinitiveRefusal() throws {
        var machine = AidenContinueInNewChatAttemptMachine()
        let key1 = UUID()
        let key2 = UUID()

        let first = machine.begin(
            context: contextA,
            chatId: "chat-1",
            revision: "rev-1",
            workspaceId: "ws-2",
            makeKey: { key1 }
        )
        XCTAssertEqual(first.idempotencyKey, key1)

        machine.recordFailure(URLError(.timedOut), for: first)
        XCTAssertEqual(machine.retained?.idempotencyKey, key1)

        let sameTarget = machine.begin(
            context: contextA,
            chatId: "chat-1",
            revision: "rev-1",
            workspaceId: "ws-2",
            makeKey: { key2 }
        )
        XCTAssertEqual(sameTarget.idempotencyKey, key1)

        // Different destination workspace mints a fresh key.
        let differentTarget = machine.begin(
            context: contextA,
            chatId: "chat-1",
            revision: "rev-1",
            workspaceId: "ws-3",
            makeKey: { key2 }
        )
        XCTAssertEqual(differentTarget.idempotencyKey, key2)

        machine.recordFailure(try serverError(404, code: "not_found"), for: differentTarget)
        XCTAssertNil(machine.retained)
    }

    // MARK: - Approval & Question Snapshot Generation Fences

    func testApprovalSnapshotFenceCoalescesIdenticalFallbackAndRejectsStaleGenerations() {
        var fence = AidenApprovalSnapshotFence()

        let first = fence.begin(
            streamID: "stream-1",
            context: contextA,
            pendingApproval: nil,
            streamState: .running,
            isFallback: false,
            isInFlightContextLive: false
        )
        XCTAssertNotNil(first)
        XCTAssertEqual(first?.generation, 1)

        // Fallback read with identical stream/live context/approval/state coalesces.
        let coalesced = fence.begin(
            streamID: "stream-1",
            context: contextA,
            pendingApproval: nil,
            streamState: .running,
            isFallback: true,
            isInFlightContextLive: true
        )
        XCTAssertNil(coalesced)

        // Non-fallback read advances generation and supersedes `first`.
        let second = fence.begin(
            streamID: "stream-1",
            context: contextA,
            pendingApproval: nil,
            streamState: .running,
            isFallback: false,
            isInFlightContextLive: true
        )
        XCTAssertEqual(second?.generation, 2)

        XCTAssertFalse(fence.accepts(
            first!,
            activeStreamID: "stream-1",
            pendingApproval: nil,
            streamState: .running,
            isRemoved: false,
            isContextLive: true
        ))
        XCTAssertTrue(fence.accepts(
            second!,
            activeStreamID: "stream-1",
            pendingApproval: nil,
            streamState: .running,
            isRemoved: false,
            isContextLive: true
        ))

        // Finishing `first` must not clear `second`'s in-flight token.
        fence.finish(first!)
        XCTAssertEqual(fence.inFlight, second)

        // State mutation, stream change, removal, or dead context rejects `second`.
        XCTAssertFalse(fence.accepts(
            second!,
            activeStreamID: "stream-1",
            pendingApproval: nil,
            streamState: .done,
            isRemoved: false,
            isContextLive: true
        ))
        XCTAssertFalse(fence.accepts(
            second!,
            activeStreamID: "stream-2",
            pendingApproval: nil,
            streamState: .running,
            isRemoved: false,
            isContextLive: true
        ))
        XCTAssertFalse(fence.accepts(
            second!,
            activeStreamID: "stream-1",
            pendingApproval: nil,
            streamState: .running,
            isRemoved: true,
            isContextLive: true
        ))

        fence.finish(second!)
        XCTAssertNil(fence.inFlight)
    }

    func testQuestionSnapshotFenceAdvancesMonotonicallyAndRejectsSupersededReads() {
        var fence = AidenQuestionSnapshotFence()
        let q1 = AidenPendingQuestion(id: "q-1", questions: [], expiresAt: .distantFuture, canRespond: true)

        let first = fence.begin(streamID: "stream-1", pendingQuestion: nil, streamState: .waitingForApproval)
        let second = fence.begin(streamID: "stream-1", pendingQuestion: nil, streamState: .waitingForApproval)
        XCTAssertEqual(first.generation, 1)
        XCTAssertEqual(second.generation, 2)

        XCTAssertFalse(fence.accepts(
            first,
            activeStreamID: "stream-1",
            pendingQuestion: nil,
            streamState: .waitingForApproval,
            isContextLive: true
        ))
        XCTAssertTrue(fence.accepts(
            second,
            activeStreamID: "stream-1",
            pendingQuestion: nil,
            streamState: .waitingForApproval,
            isContextLive: true
        ))
        XCTAssertFalse(fence.accepts(
            second,
            activeStreamID: "stream-1",
            pendingQuestion: q1,
            streamState: .waitingForApproval,
            isContextLive: true
        ))
        XCTAssertFalse(fence.accepts(
            second,
            activeStreamID: "stream-1",
            pendingQuestion: nil,
            streamState: .waitingForApproval,
            isContextLive: false
        ))
    }
}
