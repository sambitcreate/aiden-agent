import AVFoundation
import Foundation
import Speech
import XCTest
@testable import AidenOnTheGo

@MainActor
final class ComposerVoiceInputControllerTests: XCTestCase {
    private final class MockAudioSessionDriver: ComposerVoiceAudioSessionDriver {
        var metrics = ComposerVoiceAudioSessionInputMetrics(
            isInputAvailable: true,
            sampleRate: 48_000,
            inputNumberOfChannels: 1
        )
        var activateError: Error?
        private(set) var activateCount = 0
        private(set) var deactivateCount = 0
        private(set) var isActive = false

        func activateForRecording() throws -> ComposerVoiceAudioSessionInputMetrics {
            if let activateError { throw activateError }
            activateCount += 1
            isActive = true
            return metrics
        }

        func deactivateAfterRecording() {
            deactivateCount += 1
            isActive = false
        }
    }

    private final class MockNativeRecognitionRequest: ComposerVoiceNativeRecognitionRequest, @unchecked Sendable {
        private let lock = NSLock()
        private var ended = false

        var didEndAudio: Bool {
            lock.withLock { ended }
        }

        func append(_ buffer: AVAudioPCMBuffer) {}

        func endAudio() {
            lock.withLock { ended = true }
        }
    }

    private final class MockNativeRecognitionTask: ComposerVoiceNativeRecognitionTask {
        private(set) var cancelCount = 0

        func cancel() {
            cancelCount += 1
        }
    }

    private final class MockAudioEngineHandle: ComposerVoiceAudioEngineHandle {
        var isRunning = false
        var inputSampleRate: Double = 48_000
        var inputChannelCount: UInt32 = 1
        var startError: Error?
        var simulatedMacPCMBuffer: AVAudioPCMBuffer?

        private(set) var tapInstallCount = 0
        private(set) var tapRemoveCount = 0
        private(set) var stopAndResetCount = 0
        private(set) var isTapInstalled = false

        func installMacTap(into accumulator: ComposerMacSpeechPCMAccumulator) {
            tapInstallCount += 1
            isTapInstalled = true
            if let buffer = simulatedMacPCMBuffer {
                accumulator.append(buffer)
            }
        }

        func installNativeTap(forwardingTo request: any ComposerVoiceNativeRecognitionRequest) {
            tapInstallCount += 1
            isTapInstalled = true
        }

        func prepareAndStart() throws {
            if let startError { throw startError }
            isRunning = true
        }

        func stopAndReset(removeTap: Bool) {
            stopAndResetCount += 1
            isRunning = false
            if removeTap {
                tapRemoveCount += 1
                isTapInstalled = false
            }
        }
    }

    private final class MockNativeSpeechDriver: ComposerVoiceNativeSpeechDriver {
        var onDeviceSupported = true
        private(set) var lastRequest: MockNativeRecognitionRequest?
        private(set) var lastTask: MockNativeRecognitionTask?
        private var onUpdate: (@MainActor (ComposerVoiceRecognitionUpdate) -> Void)?

        func prepareOnDeviceRecognizer(for locale: Locale) -> Bool {
            onDeviceSupported
        }

        func makeRequest() -> any ComposerVoiceNativeRecognitionRequest {
            let request = MockNativeRecognitionRequest()
            lastRequest = request
            return request
        }

        func startRecognition(
            request: any ComposerVoiceNativeRecognitionRequest,
            onUpdate: @escaping @MainActor (ComposerVoiceRecognitionUpdate) -> Void
        ) -> (any ComposerVoiceNativeRecognitionTask)? {
            self.onUpdate = onUpdate
            let task = MockNativeRecognitionTask()
            lastTask = task
            return task
        }

        func emit(_ update: ComposerVoiceRecognitionUpdate) {
            onUpdate?(update)
        }
    }

    @MainActor
    private struct Harness {
        let controller: ComposerVoiceInputController
        let audioSession: MockAudioSessionDriver
        let engine: MockAudioEngineHandle
        let nativeSpeech: MockNativeSpeechDriver
        var capturingHistory: [Bool] { getCapturingHistory() }
        var isCapturing: Bool { getCapturingHistory().last ?? false }
        private let getCapturingHistory: @MainActor () -> [Bool]

        init(
            mode: AidenVoiceInputMode = .onDevice,
            isAppActive: Bool = true,
            micGranted: Bool = true,
            speechStatus: SFSpeechRecognizerAuthorizationStatus = .authorized,
            requestMic: (@MainActor () async -> Bool)? = nil,
            requestSpeech: (@MainActor () async -> SFSpeechRecognizerAuthorizationStatus)? = nil,
            finalizationSleep: @escaping @Sendable (Duration) async throws -> Void = { _ in }
        ) {
            let audioSession = MockAudioSessionDriver()
            let engine = MockAudioEngineHandle()
            let nativeSpeech = MockNativeSpeechDriver()
            var history: [Bool] = []
            let dependencies = ComposerVoiceInputController.Dependencies(
                selectedMode: { mode },
                isAppActive: { isAppActive },
                requestMicrophonePermission: requestMic ?? { micGranted },
                requestSpeechAuthorization: requestSpeech ?? { speechStatus },
                audioSession: audioSession,
                audioEngineFactory: { engine },
                nativeSpeech: nativeSpeech,
                makeMacAccumulator: { ComposerMacSpeechPCMAccumulator() },
                finalizationSleep: finalizationSleep,
                setCapturing: { history.append($0) }
            )
            self.controller = ComposerVoiceInputController(dependencies: dependencies)
            self.audioSession = audioSession
            self.engine = engine
            self.nativeSpeech = nativeSpeech
            self.getCapturingHistory = { history }
        }
    }

    private func makeNonEmptyPCMBuffer() throws -> AVAudioPCMBuffer {
        let format = try XCTUnwrap(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4))
        buffer.frameLength = 4
        let channel = try XCTUnwrap(buffer.floatChannelData?[0])
        channel[0] = 0.25
        channel[1] = -0.25
        channel[2] = 0.5
        channel[3] = -0.5
        return buffer
    }

    // MARK: - Pure Reducer Invariants

    func testReducerGuaranteesFullResourceCleanupOnEveryExitToIdle() throws {
        var reducer = ComposerVoiceInputReducer()
        XCTAssertEqual(reducer.state, .idle)
        XCTAssertTrue(reducer.resources.isClean)

        // Start native session and acquire all capture resources.
        let begun = try XCTUnwrap(reducer.beginSession(backend: .nativeOnDevice))
        XCTAssertEqual(reducer.state, .requestingPermission)
        XCTAssertEqual(reducer.backend, .nativeOnDevice)
        reducer.didActivateAudioSession()
        reducer.didAttachAudioEngine()
        reducer.didInstallAudioTap()
        reducer.didCreateRecognitionRequest()
        reducer.didStartRecognitionTask()
        let listeningEffects = try XCTUnwrap(reducer.didStartListening(session: begun.session))
        XCTAssertEqual(listeningEffects, [.setCapturing(true)])
        XCTAssertEqual(reducer.state, .listening)

        // Failure mid-listening must tear down tap, audio session, recognition, and capturing.
        let failEffects = try XCTUnwrap(reducer.fail(
            session: begun.session,
            message: "Boom",
            logCategory: .audioStartup
        ))
        XCTAssertEqual(reducer.state, .idle)
        XCTAssertEqual(reducer.backend, .none)
        XCTAssertTrue(reducer.resources.isClean)
        XCTAssertTrue(failEffects.contains(.setCapturing(false)))
        XCTAssertTrue(failEffects.contains(.teardownAudioCapture(removeTap: true, deactivateAudioSession: true)))
        XCTAssertTrue(failEffects.contains(.releaseRecognition(cancelTask: true)))
        XCTAssertTrue(failEffects.contains(.stopAcceptingDraftUpdates))
        XCTAssertTrue(failEffects.contains(.setErrorMessage("Boom")))
    }

    func testReducerSuppressesExpectedErrorAfterNativeStopKeepingTranscript() throws {
        var reducer = ComposerVoiceInputReducer()
        let begun = try XCTUnwrap(reducer.beginSession(backend: .nativeOnDevice))
        reducer.didActivateAudioSession()
        reducer.didAttachAudioEngine()
        reducer.didInstallAudioTap()
        reducer.didCreateRecognitionRequest()
        reducer.didStartRecognitionTask()
        _ = reducer.didStartListening(session: begun.session)

        guard case let .finalizeNative(session, stopEffects) = reducer.stopKeepingTranscript() else {
            return XCTFail("Expected finalizeNative")
        }
        XCTAssertEqual(session, begun.session)
        XCTAssertEqual(reducer.state, .transcribing)
        XCTAssertTrue(reducer.suppressNextRecognitionError)
        XCTAssertTrue(stopEffects.contains(.teardownAudioCapture(removeTap: true, deactivateAudioSession: true)))
        XCTAssertTrue(stopEffects.contains(.endRecognitionAudio))
        XCTAssertTrue(stopEffects.contains(.scheduleNativeFinalizationTimeout(session: begun.session)))

        // Recognition error after stopKeepingTranscript is suppressed, and finalization task is cancelled.
        let termEffects = try XCTUnwrap(reducer.nativeRecognitionTerminated(
            session: begun.session,
            errorDescription: "Cancelled by endAudio"
        ))
        XCTAssertEqual(reducer.state, .idle)
        XCTAssertTrue(reducer.resources.isClean)
        XCTAssertFalse(reducer.suppressNextRecognitionError)
        XCTAssertTrue(termEffects.contains(.cancelNativeFinalizationTask))
        XCTAssertTrue(termEffects.contains(.releaseRecognition(cancelTask: false)))
        XCTAssertFalse(termEffects.contains {
            if case .setErrorMessage = $0 { return true }
            return false
        })
    }

    // MARK: - Native On-Device Controller Flows

    func testNativeDictationStreamsPartialAndFinalTranscriptAndCleansUpResources() async {
        let harness = Harness(mode: .onDevice)
        var drafts: [String] = []

        await harness.controller.toggle(
            currentDraft: "Hello",
            updateDraft: { drafts.append($0) },
            macTranscriber: { _ in XCTFail("On-device mode must not call macTranscriber"); return "" }
        )

        XCTAssertEqual(harness.controller.state, .listening)
        XCTAssertTrue(harness.controller.isListening)
        XCTAssertTrue(harness.audioSession.isActive)
        XCTAssertTrue(harness.engine.isTapInstalled)
        XCTAssertTrue(harness.isCapturing)

        harness.nativeSpeech.emit(.init(transcript: "world", isFinal: false, errorDescription: nil))
        XCTAssertEqual(harness.controller.liveTranscript, "world")
        XCTAssertEqual(drafts, ["Hello world"])

        harness.nativeSpeech.emit(.init(transcript: "world!", isFinal: true, errorDescription: nil))
        XCTAssertEqual(harness.controller.state, .idle)
        XCTAssertFalse(harness.controller.isBusy)
        XCTAssertNil(harness.controller.errorMessage)
        XCTAssertEqual(drafts, ["Hello world", "Hello world!"])
        XCTAssertFalse(harness.audioSession.isActive)
        XCTAssertEqual(harness.audioSession.deactivateCount, 1)
        XCTAssertFalse(harness.engine.isTapInstalled)
        XCTAssertEqual(harness.engine.tapRemoveCount, 1)
        XCTAssertFalse(harness.isCapturing)
        XCTAssertTrue(harness.controller.reducer.resources.isClean)
    }

    func testNativeStopKeepingTranscriptFinalizesViaTimeoutWhenRecognizerNeverCompletes() async throws {
        let harness = Harness(
            mode: .onDevice,
            finalizationSleep: { _ in }
        )
        var drafts: [String] = []

        await harness.controller.toggle(
            currentDraft: "",
            updateDraft: { drafts.append($0) },
            macTranscriber: { _ in "" }
        )
        XCTAssertEqual(harness.controller.state, .listening)

        harness.nativeSpeech.emit(.init(transcript: "Draft text", isFinal: false, errorDescription: nil))
        // Toggling while listening invokes stopKeepingTranscript().
        await harness.controller.toggle(
            currentDraft: "Draft text",
            updateDraft: { drafts.append($0) },
            macTranscriber: { _ in "" }
        )

        // Audio capture stops immediately before timeout finishes.
        XCTAssertFalse(harness.audioSession.isActive)
        XCTAssertFalse(harness.engine.isTapInstalled)
        XCTAssertTrue(harness.nativeSpeech.lastRequest?.didEndAudio == true)

        let deadline = ContinuousClock.now + .seconds(2)
        while harness.controller.state != .idle, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }

        XCTAssertEqual(harness.controller.state, .idle)
        XCTAssertEqual(harness.nativeSpeech.lastTask?.cancelCount, 1)
        XCTAssertNil(harness.controller.errorMessage)
        XCTAssertTrue(harness.controller.reducer.resources.isClean)

        // Late recognition callback after timeout must not mutate draft.
        harness.nativeSpeech.emit(.init(transcript: "Late text", isFinal: true, errorDescription: nil))
        XCTAssertEqual(drafts, ["Draft text"])
    }

    func testNativeEngineStartFailureCleansUpTapAndAudioSessionOnExitToIdle() async {
        let harness = Harness(mode: .onDevice)
        harness.engine.startError = NSError(
            domain: "TestAudio",
            code: 42,
            userInfo: [NSLocalizedDescriptionKey: "Engine failed to start."]
        )

        await harness.controller.toggle(
            currentDraft: "",
            updateDraft: { _ in XCTFail("Failed start must not update draft") },
            macTranscriber: { _ in "" }
        )

        XCTAssertEqual(harness.controller.state, .idle)
        XCTAssertEqual(harness.controller.errorMessage, "Engine failed to start.")
        XCTAssertEqual(harness.engine.tapInstallCount, 1)
        XCTAssertEqual(harness.engine.tapRemoveCount, 1)
        XCTAssertFalse(harness.engine.isTapInstalled)
        XCTAssertEqual(harness.audioSession.activateCount, 1)
        XCTAssertEqual(harness.audioSession.deactivateCount, 1)
        XCTAssertFalse(harness.audioSession.isActive)
        XCTAssertEqual(harness.nativeSpeech.lastTask?.cancelCount, 1)
        XCTAssertTrue(harness.controller.reducer.resources.isClean)
    }

    func testNativePermissionAndPreflightFailuresReturnToIdleWithoutActivatingAudio() async {
        let deniedSpeech = Harness(mode: .onDevice, speechStatus: .denied)
        await deniedSpeech.controller.toggle(currentDraft: "", updateDraft: { _ in }, macTranscriber: { _ in "" })
        XCTAssertEqual(deniedSpeech.controller.state, .idle)
        XCTAssertNotNil(deniedSpeech.controller.errorMessage)
        XCTAssertEqual(deniedSpeech.audioSession.activateCount, 0)
        XCTAssertTrue(deniedSpeech.controller.reducer.resources.isClean)

        let inactiveApp = Harness(mode: .onDevice, isAppActive: false)
        await inactiveApp.controller.toggle(currentDraft: "", updateDraft: { _ in }, macTranscriber: { _ in "" })
        XCTAssertEqual(inactiveApp.controller.state, .idle)
        XCTAssertEqual(inactiveApp.controller.errorMessage, ComposerVoiceInputError.appNotActive.localizedDescription)
        XCTAssertEqual(inactiveApp.audioSession.activateCount, 0)
        XCTAssertTrue(inactiveApp.controller.reducer.resources.isClean)
    }

    // MARK: - Paired Mac Controller Flows

    func testPairedMacDictationCapturesAudioStopsSessionBeforeTranscribingAndUpdatesDraft() async throws {
        let harness = Harness(mode: .pairedMac)
        harness.engine.simulatedMacPCMBuffer = try makeNonEmptyPCMBuffer()

        var drafts: [String] = []
        var receivedPCMBytes = 0
        var sessionWasInactiveDuringTranscription = false

        await harness.controller.toggle(
            currentDraft: "Note:",
            updateDraft: { drafts.append($0) },
            macTranscriber: { pcm in
                receivedPCMBytes = pcm.count
                sessionWasInactiveDuringTranscription = !harness.audioSession.isActive && !harness.engine.isTapInstalled
                return "ship it"
            }
        )

        XCTAssertEqual(harness.controller.state, .listening)
        XCTAssertTrue(harness.audioSession.isActive)
        XCTAssertTrue(harness.engine.isTapInstalled)
        XCTAssertTrue(harness.isCapturing)

        harness.controller.stopKeepingTranscript()

        let deadline = ContinuousClock.now + .seconds(2)
        while harness.controller.state != .idle, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }

        XCTAssertEqual(harness.controller.state, .idle)
        XCTAssertGreaterThan(receivedPCMBytes, 0)
        XCTAssertTrue(sessionWasInactiveDuringTranscription, "Audio session and tap must be torn down before remote transcription")
        XCTAssertEqual(drafts, ["Note: ship it"])
        XCTAssertEqual(harness.controller.liveTranscript, "ship it")
        XCTAssertNil(harness.controller.errorMessage)
        XCTAssertFalse(harness.isCapturing)
        XCTAssertTrue(harness.controller.reducer.resources.isClean)
    }

    func testPairedMacEmptyRecordingFailsCleanlyAndLeavesIdle() async {
        let harness = Harness(mode: .pairedMac)
        harness.engine.simulatedMacPCMBuffer = nil

        await harness.controller.toggle(
            currentDraft: "",
            updateDraft: { _ in XCTFail("Empty recording must not update draft") },
            macTranscriber: { _ in XCTFail("Empty recording must not call macTranscriber"); return "" }
        )
        XCTAssertEqual(harness.controller.state, .listening)

        harness.controller.stopKeepingTranscript()

        XCTAssertEqual(harness.controller.state, .idle)
        XCTAssertEqual(harness.controller.errorMessage, "No speech was recorded.")
        XCTAssertFalse(harness.audioSession.isActive)
        XCTAssertFalse(harness.engine.isTapInstalled)
        XCTAssertFalse(harness.isCapturing)
        XCTAssertTrue(harness.controller.reducer.resources.isClean)
    }

    func testCancelDiscardingRecordingDuringMacTranscriptionDropsLateResultAndCleansUp() async throws {
        let harness = Harness(mode: .pairedMac)
        harness.engine.simulatedMacPCMBuffer = try makeNonEmptyPCMBuffer()

        var drafts: [String] = []
        var transcriptionStarted = false
        var releaseTranscription = false

        await harness.controller.toggle(
            currentDraft: "Keep",
            updateDraft: { drafts.append($0) },
            macTranscriber: { _ in
                transcriptionStarted = true
                while !releaseTranscription, !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(5))
                }
                return "discarded transcript"
            }
        )
        XCTAssertEqual(harness.controller.state, .listening)

        harness.controller.stopKeepingTranscript()
        let deadline = ContinuousClock.now + .seconds(2)
        while !transcriptionStarted, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(harness.controller.state, .transcribing)

        harness.controller.cancelDiscardingRecording()
        releaseTranscription = true

        XCTAssertEqual(harness.controller.state, .idle)
        XCTAssertFalse(harness.controller.isBusy)
        XCTAssertTrue(harness.controller.reducer.resources.isClean)

        // Allow any cancelled task unwinding to settle.
        try await Task.sleep(for: .milliseconds(25))
        XCTAssertTrue(drafts.isEmpty, "Cancelled transcription must not write to the draft")
        XCTAssertNil(harness.controller.errorMessage)
    }

    func testCancelDuringPermissionPromptPreventsStartingAudioCapture() async throws {
        var releasePermission = false
        var permissionEntered = false
        let harness = Harness(
            mode: .pairedMac,
            requestMic: {
                permissionEntered = true
                while !releasePermission, !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(5))
                }
                return true
            }
        )

        let startTask = Task {
            await harness.controller.toggle(
                currentDraft: "",
                updateDraft: { _ in XCTFail("Cancelled permission flow must not update draft") },
                macTranscriber: { _ in "" }
            )
        }

        let deadline = ContinuousClock.now + .seconds(2)
        while !permissionEntered, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(harness.controller.state, .requestingPermission)

        harness.controller.cancelDiscardingRecording()
        releasePermission = true
        await startTask.value

        XCTAssertEqual(harness.controller.state, .idle)
        XCTAssertEqual(harness.audioSession.activateCount, 0)
        XCTAssertEqual(harness.engine.tapInstallCount, 0)
        XCTAssertTrue(harness.controller.reducer.resources.isClean)
    }
}
