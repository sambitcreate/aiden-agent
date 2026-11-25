import Foundation
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenForeignRunObserverTests: XCTestCase {
    private let sampleContext = AidenRemoteRequestContext(
        instanceId: "inst-1",
        deviceId: "dev-1",
        generation: 1,
        hostGeneration: 1,
        scope: .owner
    )

    private func decodeEvent(_ json: String) throws -> AidenRemoteRunEvent {
        try AidenRemoteJSONDecoder.decode(AidenRemoteRunEvent.self, from: Data(json.utf8))
    }

    private func startedEvent(runId: String, sequence: Int = 1) throws -> AidenRemoteRunEvent {
        try decodeEvent("""
        {"protocolVersion":1,"streamId":"\(runId)","sequence":\(sequence),"timestamp":"2026-11-24T00:00:00Z","type":"run.started","terminal":false,"payload":{"runId":"\(runId)","chatId":"chat-1","origin":"desktop"}}
        """)
    }

    private func textDeltaEvent(runId: String, sequence: Int, text: String) throws -> AidenRemoteRunEvent {
        try decodeEvent("""
        {"protocolVersion":1,"streamId":"\(runId)","sequence":\(sequence),"timestamp":"2026-11-24T00:00:01Z","type":"text_delta","terminal":false,"payload":{"text":"\(text)"}}
        """)
    }

    private func endedEvent(runId: String, sequence: Int, state: String = "done") throws -> AidenRemoteRunEvent {
        try decodeEvent("""
        {"protocolVersion":1,"streamId":"\(runId)","sequence":\(sequence),"timestamp":"2026-11-24T00:00:02Z","type":"run.ended","terminal":true,"payload":{"runId":"\(runId)","chatId":"chat-1","state":"\(state)"}}
        """)
    }

    private func serverError(_ status: Int, code: String) throws -> AidenRemoteClientError {
        let body = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: Data(#"{"code":"\#(code)","message":"Refused.","requestId":"req-1","retryable":false}"#.utf8)
        )
        return .server(statusCode: status, body: body)
    }

    private func makeHost(
        isRemoved: @escaping @MainActor () -> Bool = { false },
        isContextLive: @escaping @MainActor (AidenRemoteRequestContext) -> Bool = { _ in true },
        hasActiveStream: @escaping @MainActor () -> Bool = { false },
        isStarting: @escaping @MainActor () -> Bool = { false },
        openEventStream: @escaping @MainActor (AidenRemoteRequestContext, AidenForeignRunProjection?) throws -> AsyncThrowingStream<AidenRemoteRunEvent, Error>,
        handleCredentialRevocation: @escaping @MainActor (Error, AidenRemoteRequestContext) async -> Bool = { _, _ in false },
        reconcileChat: @escaping @MainActor (AidenRemoteRequestContext) async -> Bool = { _ in true },
        onGoLive: @escaping @MainActor (AidenForeignRunProjection, AidenRemoteRequestContext) async -> Void = { _, _ in },
        onPublishUpdate: @escaping @MainActor (AidenForeignRunProjection, Bool, AidenRemoteRequestContext) -> Void = { _, _, _ in },
        onPerformEffect: @escaping @MainActor (AidenForeignRunProjection.Effect, String, AidenRemoteRequestContext) async -> Bool = { effect, _, _ in
            if case .ended = effect { return true }
            return false
        },
        onReconnectExhaustedLive: @escaping @MainActor (String, AidenRemoteRequestContext) async -> Void = { _, _ in },
        onFlushBeforeQuietEnd: @escaping @MainActor () -> Void = {},
        onEndedQuietlyLive: @escaping @MainActor (AidenRemoteRunEndState?, Bool) -> Void = { _, _ in },
        onClearLiveOutput: @escaping @MainActor () -> Void = {},
        onClearLiveOutputAndPrompts: @escaping @MainActor () -> Void = {},
        onObservationFinished: @escaping @MainActor () -> Void = {}
    ) -> AidenForeignRunObserver.Host {
        AidenForeignRunObserver.Host(
            currencyInputs: { context in
                AidenForeignRunObserver.CurrencyInputs(
                    isTaskCancelled: Task.isCancelled,
                    isRemoved: isRemoved(),
                    isContextLive: isContextLive(context),
                    hasActiveStream: hasActiveStream(),
                    isStarting: isStarting()
                )
            },
            isRemoved: isRemoved,
            hasActiveStream: hasActiveStream,
            openEventStream: openEventStream,
            handleCredentialRevocation: handleCredentialRevocation,
            reconcileChat: reconcileChat,
            bumpTranscriptGeneration: {},
            onGoLive: onGoLive,
            onPublishUpdate: onPublishUpdate,
            onPerformEffect: onPerformEffect,
            onReconnectExhaustedLive: onReconnectExhaustedLive,
            onFlushBeforeQuietEnd: onFlushBeforeQuietEnd,
            onEndedQuietlyLive: onEndedQuietlyLive,
            onClearLiveOutput: onClearLiveOutput,
            onClearLiveOutputAndPrompts: onClearLiveOutputAndPrompts,
            onObservationFinished: onObservationFinished
        )
    }

    func testSixConditionCurrencyFenceRejectsEachViolationIndependently() {
        let observer = AidenForeignRunObserver()
        let currentGen = observer.generation

        let baseline = AidenForeignRunObserver.CurrencyInputs(
            isTaskCancelled: false,
            isRemoved: false,
            isContextLive: true,
            hasActiveStream: false,
            isStarting: false
        )
        XCTAssertTrue(observer.isCurrent(generation: currentGen, inputs: baseline))
        XCTAssertFalse(observer.isRecoveryFenced(inputs: baseline))

        // 1. Wrong generation
        XCTAssertFalse(observer.isCurrent(generation: currentGen &+ 1, inputs: baseline))
        // 2. Task cancelled
        XCTAssertFalse(observer.isCurrent(generation: currentGen, inputs: .init(
            isTaskCancelled: true, isRemoved: false, isContextLive: true, hasActiveStream: false, isStarting: false
        )))
        // 3. Chat removed
        XCTAssertFalse(observer.isCurrent(generation: currentGen, inputs: .init(
            isTaskCancelled: false, isRemoved: true, isContextLive: true, hasActiveStream: false, isStarting: false
        )))
        // 4. Context not live
        XCTAssertFalse(observer.isCurrent(generation: currentGen, inputs: .init(
            isTaskCancelled: false, isRemoved: false, isContextLive: false, hasActiveStream: false, isStarting: false
        )))
        // 5. Active owned stream
        XCTAssertFalse(observer.isCurrent(generation: currentGen, inputs: .init(
            isTaskCancelled: false, isRemoved: false, isContextLive: true, hasActiveStream: true, isStarting: false
        )))
        // 6. Starting a local send
        XCTAssertFalse(observer.isCurrent(generation: currentGen, inputs: .init(
            isTaskCancelled: false, isRemoved: false, isContextLive: true, hasActiveStream: false, isStarting: true
        )))

        // Recovery fence trips on active stream, starting, removed, cancelled, or dead context.
        XCTAssertTrue(observer.isRecoveryFenced(inputs: .init(
            isTaskCancelled: false, isRemoved: false, isContextLive: true, hasActiveStream: true, isStarting: false
        )))
        XCTAssertTrue(observer.isRecoveryFenced(inputs: .init(
            isTaskCancelled: false, isRemoved: false, isContextLive: true, hasActiveStream: false, isStarting: true
        )))
    }

    func testProbeBackoffFollows5s10s20s30sCapAndResetsWhenBusyOrLive() {
        let delays = (0..<6).map { AidenForeignRunObserver.probeDelay(afterIdleProbes: $0) }
        XCTAssertEqual(delays, [.seconds(5), .seconds(10), .seconds(20), .seconds(30), .seconds(30), .seconds(30)])
        XCTAssertEqual(AidenForeignRunObserver.probeDelay(afterIdleProbes: -3), .seconds(5))
    }

    func testAttachPromotesToLiveAfterSettleAndEndsQuietlyOnTerminalEvent() async throws {
        let observer = AidenForeignRunObserver()
        observer.settleSleep = { _ in }
        observer.reconnectSleep = { _ in }

        let started = try startedEvent(runId: "run-live")
        let delta = try textDeltaEvent(runId: "run-live", sequence: 2, text: "Hello from Mac")
        let ended = try endedEvent(runId: "run-live", sequence: 3, state: "done")

        var wentLiveRunId: String?
        var publishedTexts: [String] = []
        var reconcileCount = 0
        var endedStates: [AidenRemoteRunEndState?] = []
        var finishedCalls = 0
        var streamContinuation: AsyncThrowingStream<AidenRemoteRunEvent, Error>.Continuation?

        let host = makeHost(
            openEventStream: { _, _ in
                AsyncThrowingStream { continuation in
                    streamContinuation = continuation
                    continuation.yield(started)
                }
            },
            reconcileChat: { _ in
                reconcileCount += 1
                return true
            },
            onGoLive: { projection, _ in
                wentLiveRunId = projection.runId
            },
            onPublishUpdate: { projection, _, _ in
                publishedTexts.append(projection.liveText)
            },
            onEndedQuietlyLive: { endState, _ in
                endedStates.append(endState)
            },
            onObservationFinished: {
                finishedCalls += 1
            }
        )

        let task = try XCTUnwrap(observer.startObservation(context: sampleContext, reason: .load, host: host))
        let deadline = ContinuousClock.now + .seconds(5)
        while !observer.isLive, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(observer.isLive)
        XCTAssertEqual(wentLiveRunId, "run-live")
        XCTAssertEqual(observer.shownLiveCount, 1)
        XCTAssertEqual(observer.accountedRunId, "run-live")

        streamContinuation?.yield(delta)
        streamContinuation?.yield(ended)
        streamContinuation?.finish()
        await task.value

        XCTAssertFalse(observer.isLive)
        XCTAssertFalse(observer.isLookingForRun)
        XCTAssertNil(observer.projection)
        XCTAssertEqual(publishedTexts.last, "Hello from Mac")
        XCTAssertEqual(reconcileCount, 1)
        XCTAssertEqual(endedStates, [.done])
        XCTAssertEqual(finishedCalls, 1)
    }

    func testAnnouncedTurnRetriesOnceOn404ThenReconcilesChat() async throws {
        let observer = AidenForeignRunObserver()
        observer.announcedRunRetrySleep = { _ in }
        observer.reconnectSleep = { _ in }
        let notFound = try serverError(404, code: "run_gone")

        var openCount = 0
        var reconcileCount = 0
        let host = makeHost(
            openEventStream: { _, _ in
                openCount += 1
                return AsyncThrowingStream { continuation in
                    continuation.finish(throwing: notFound)
                }
            },
            reconcileChat: { _ in
                reconcileCount += 1
                return true
            }
        )

        let task = try XCTUnwrap(observer.startObservation(context: sampleContext, reason: .announcedTurn, host: host))
        await task.value

        XCTAssertEqual(openCount, 2, "Announced turn should retry 404 exactly once")
        XCTAssertEqual(reconcileCount, 1, "Unobservable announced run should still reconcile chat")
        XCTAssertFalse(observer.isLookingForRun)
    }

    func testEndedBeforeAttachSkipsLiveAndReconcilesOnlyForNewRun() async throws {
        let observer = AidenForeignRunObserver()
        // Keep settleSleep pending so the replay ends before settling.
        observer.settleSleep = { _ in try await Task.sleep(for: .seconds(60)) }

        let started = try startedEvent(runId: "run-old")
        let ended = try endedEvent(runId: "run-old", sequence: 2, state: "done")

        var wentLive = false
        var reconcileCount = 0
        let host = makeHost(
            openEventStream: { _, _ in
                AsyncThrowingStream { continuation in
                    continuation.yield(started)
                    continuation.yield(ended)
                    continuation.finish()
                }
            },
            reconcileChat: { _ in
                reconcileCount += 1
                return true
            },
            onGoLive: { _, _ in wentLive = true }
        )

        let first = try XCTUnwrap(observer.startObservation(context: sampleContext, reason: .load, host: host))
        await first.value

        XCTAssertFalse(wentLive)
        XCTAssertEqual(reconcileCount, 1)
        XCTAssertEqual(observer.accountedRunId, "run-old")

        // Seeing the same accounted run again does not trigger another reconcile.
        let second = try XCTUnwrap(observer.startObservation(context: sampleContext, reason: .load, host: host))
        await second.value

        XCTAssertEqual(reconcileCount, 1)
    }

    func testStopProbeCancelsUnsettledProbeLookupAndPreservesAnnouncedTurnPrecedence() async throws {
        let observer = AidenForeignRunObserver()
        observer.queueAnnouncedTurn(reason: .firstRosterTurn)
        observer.queueAnnouncedTurn(reason: .announcedTurn)
        observer.queueAnnouncedTurn(reason: .firstRosterTurn)
        XCTAssertEqual(observer.consumeQueuedAnnouncedTurn(), .announcedTurn)
        XCTAssertNil(observer.consumeQueuedAnnouncedTurn())

        var streamContinuation: AsyncThrowingStream<AidenRemoteRunEvent, Error>.Continuation?
        let host = makeHost(
            openEventStream: { _, _ in
                AsyncThrowingStream { continuation in
                    streamContinuation = continuation
                }
            }
        )
        let attach = try XCTUnwrap(observer.startObservation(context: sampleContext, reason: .probe, host: host))
        XCTAssertTrue(observer.isLookingForRun)
        XCTAssertTrue(observer.lookupIsProbes)

        observer.stopProbe(hasActiveStream: false, onClearLiveOutputAndPrompts: {})
        XCTAssertFalse(observer.isLookingForRun)
        streamContinuation?.finish()
        await attach.value
    }
}
