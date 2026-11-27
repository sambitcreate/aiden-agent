import AVFoundation
import Foundation
import Observation
import Speech
import UIKit

/// Pure state/resource reducer for `ComposerVoiceInputController`.
///
/// Consolidates every state transition across `(state, backend, resources,
/// suppressNextRecognitionError, sessionFence)` and guarantees that every exit
/// to `.idle` emits teardown effects for any owned audio tap, `AVAudioSession`,
/// recognition request/task, Mac accumulator/transcriber, and async tasks.
struct ComposerVoiceInputReducer: Equatable, Sendable {
    enum Backend: Equatable, Sendable {
        case none
        case nativeOnDevice
        case pairedMac
    }

    struct ResourceOwnership: Equatable, Sendable {
        var audioSessionActivated = false
        var audioTapInstalled = false
        var audioEngineActive = false
        var capturingPublished = false
        var recognitionRequestActive = false
        var recognitionTaskActive = false
        var macAccumulatorActive = false
        var macTranscriberActive = false
        var macTranscriptionTaskActive = false
        var nativeFinalizationTaskActive = false

        static let none = ResourceOwnership()

        var isClean: Bool { self == .none }
    }

    enum Effect: Equatable, Sendable {
        case stopAcceptingDraftUpdates
        case setCapturing(Bool)
        case teardownAudioCapture(removeTap: Bool, deactivateAudioSession: Bool)
        case endRecognitionAudio
        case releaseRecognition(cancelTask: Bool)
        case releaseMacCaptureResources
        case cancelMacTranscriptionTask
        case cancelNativeFinalizationTask
        case scheduleNativeFinalizationTimeout(session: Int)
        case recordFailureDiagnostic(VoiceInputFailureLogCategory)
        case setErrorMessage(String?)
        case clearLiveTranscript
    }

    struct BeginResult: Equatable, Sendable {
        let session: Int
        let effects: [Effect]
    }

    enum StopKeepingTranscriptAction: Equatable, Sendable {
        case ignore
        case finishPairedMac(session: Int, effects: [Effect])
        case finalizeNative(session: Int, effects: [Effect])
    }

    private(set) var state: ComposerVoiceInputController.State = .idle
    private(set) var backend: Backend = .none
    private(set) var resources: ResourceOwnership = .none
    private(set) var suppressNextRecognitionError = false
    private(set) var sessionFence = ComposerVoiceSessionFence()

    func isCurrent(_ session: Int) -> Bool {
        sessionFence.accepts(session)
    }

    mutating func beginSession(backend: Backend) -> BeginResult? {
        guard state == .idle, backend != .none else { return nil }
        let session = sessionFence.advance()
        var effects: [Effect] = []
        if resources.macTranscriptionTaskActive {
            resources.macTranscriptionTaskActive = false
            effects.append(.cancelMacTranscriptionTask)
        }
        if resources.nativeFinalizationTaskActive {
            resources.nativeFinalizationTaskActive = false
            effects.append(.cancelNativeFinalizationTask)
        }
        suppressNextRecognitionError = false
        self.backend = backend
        state = .requestingPermission
        if backend == .pairedMac {
            resources.macTranscriberActive = true
        }
        effects.append(.setErrorMessage(nil))
        effects.append(.clearLiveTranscript)
        return BeginResult(session: session, effects: effects)
    }

    /// Cleans up any stale capture resources before starting a new engine.
    mutating func prepareAudioCapture() -> [Effect] {
        var effects: [Effect] = []
        if resources.capturingPublished {
            resources.capturingPublished = false
            effects.append(.setCapturing(false))
        }
        if resources.audioEngineActive || resources.audioTapInstalled || resources.audioSessionActivated {
            let removeTap = resources.audioTapInstalled
            let deactivateSession = resources.audioSessionActivated
            resources.audioEngineActive = false
            resources.audioTapInstalled = false
            resources.audioSessionActivated = false
            effects.append(.teardownAudioCapture(removeTap: removeTap, deactivateAudioSession: deactivateSession))
        }
        if resources.recognitionRequestActive || resources.recognitionTaskActive {
            resources.recognitionRequestActive = false
            resources.recognitionTaskActive = false
            effects.append(.releaseRecognition(cancelTask: true))
        }
        return effects
    }

    mutating func didActivateAudioSession() {
        resources.audioSessionActivated = true
    }

    mutating func didAttachAudioEngine() {
        resources.audioEngineActive = true
    }

    mutating func didInstallAudioTap() {
        resources.audioTapInstalled = true
    }

    mutating func didCreateRecognitionRequest() {
        resources.recognitionRequestActive = true
    }

    mutating func didStartRecognitionTask() {
        resources.recognitionTaskActive = true
    }

    mutating func didCreateMacAccumulator() {
        resources.macAccumulatorActive = true
    }

    mutating func didStartListening(session: Int) -> [Effect]? {
        guard isCurrent(session), state == .requestingPermission else { return nil }
        state = .listening
        resources.capturingPublished = true
        return [.setCapturing(true)]
    }

    mutating func stopKeepingTranscript() -> StopKeepingTranscriptAction {
        guard state == .listening else { return .ignore }
        let session = sessionFence.current
        switch backend {
        case .pairedMac:
            var effects: [Effect] = []
            if resources.capturingPublished {
                resources.capturingPublished = false
                effects.append(.setCapturing(false))
            }
            if resources.audioEngineActive || resources.audioTapInstalled || resources.audioSessionActivated {
                let removeTap = resources.audioTapInstalled
                let deactivateSession = resources.audioSessionActivated
                resources.audioEngineActive = false
                resources.audioTapInstalled = false
                resources.audioSessionActivated = false
                effects.append(.teardownAudioCapture(removeTap: removeTap, deactivateAudioSession: deactivateSession))
            }
            if resources.recognitionRequestActive || resources.recognitionTaskActive {
                resources.recognitionRequestActive = false
                resources.recognitionTaskActive = false
                effects.append(.releaseRecognition(cancelTask: true))
            }
            if resources.macAccumulatorActive || resources.macTranscriberActive {
                resources.macAccumulatorActive = false
                resources.macTranscriberActive = false
                effects.append(.releaseMacCaptureResources)
            }
            return .finishPairedMac(session: session, effects: effects)

        case .nativeOnDevice:
            suppressNextRecognitionError = true
            state = .transcribing
            var effects: [Effect] = []
            if resources.capturingPublished {
                resources.capturingPublished = false
                effects.append(.setCapturing(false))
            }
            if resources.audioEngineActive || resources.audioTapInstalled || resources.audioSessionActivated {
                let removeTap = resources.audioTapInstalled
                let deactivateSession = resources.audioSessionActivated
                resources.audioEngineActive = false
                resources.audioTapInstalled = false
                resources.audioSessionActivated = false
                effects.append(.teardownAudioCapture(removeTap: removeTap, deactivateAudioSession: deactivateSession))
            }
            if resources.recognitionRequestActive {
                effects.append(.endRecognitionAudio)
            }
            if resources.nativeFinalizationTaskActive {
                effects.append(.cancelNativeFinalizationTask)
            }
            resources.nativeFinalizationTaskActive = true
            effects.append(.scheduleNativeFinalizationTimeout(session: session))
            return .finalizeNative(session: session, effects: effects)

        case .none:
            return .ignore
        }
    }

    mutating func beginMacTranscription(session: Int) -> [Effect]? {
        guard isCurrent(session), backend == .pairedMac else { return nil }
        state = .transcribing
        var effects: [Effect] = []
        if resources.macTranscriptionTaskActive {
            effects.append(.cancelMacTranscriptionTask)
        }
        resources.macTranscriptionTaskActive = true
        return effects
    }

    mutating func macTranscriptionCompleted(session: Int) -> [Effect]? {
        guard isCurrent(session), state == .transcribing, backend == .pairedMac else { return nil }
        // The completing task is already exiting, so do not emit self-cancellation.
        resources.macTranscriptionTaskActive = false
        return transitionToIdle(cancelRecognitionTask: true)
    }

    mutating func nativeFinalizationTimedOut(session: Int) -> [Effect]? {
        guard isCurrent(session), state == .transcribing, backend == .nativeOnDevice else { return nil }
        // The timeout task itself is exiting now.
        resources.nativeFinalizationTaskActive = false
        suppressNextRecognitionError = false
        return transitionToIdle(cancelRecognitionTask: true)
    }

    mutating func nativeRecognitionTerminated(
        session: Int,
        errorDescription: String?
    ) -> [Effect]? {
        guard isCurrent(session), state != .idle, backend == .nativeOnDevice else { return nil }
        var effects = transitionToIdle(cancelRecognitionTask: false)
        if let errorDescription {
            if suppressNextRecognitionError {
                suppressNextRecognitionError = false
            } else {
                effects.append(.setErrorMessage(errorDescription))
            }
        } else {
            suppressNextRecognitionError = false
        }
        return effects
    }

    mutating func stopForSubmitOrCancel() -> [Effect] {
        _ = sessionFence.advance()
        suppressNextRecognitionError = true
        return transitionToIdle(cancelRecognitionTask: true)
    }

    mutating func fail(
        session: Int?,
        message: String,
        logCategory: VoiceInputFailureLogCategory
    ) -> [Effect]? {
        if let session, !isCurrent(session) { return nil }
        suppressNextRecognitionError = false
        var effects: [Effect] = [.recordFailureDiagnostic(logCategory)]
        effects.append(contentsOf: transitionToIdle(cancelRecognitionTask: true))
        effects.append(.setErrorMessage(message))
        return effects
    }

    /// Single canonical exit to `.idle`. Guarantees every owned resource flag
    /// is drained and emitted as an explicit teardown effect so no exit to
    /// `.idle` can leak a tap, `AVAudioSession`, recognition handle, or task.
    private mutating func transitionToIdle(cancelRecognitionTask: Bool) -> [Effect] {
        var effects: [Effect] = []
        if resources.macTranscriptionTaskActive {
            resources.macTranscriptionTaskActive = false
            effects.append(.cancelMacTranscriptionTask)
        }
        if resources.nativeFinalizationTaskActive {
            resources.nativeFinalizationTaskActive = false
            effects.append(.cancelNativeFinalizationTask)
        }
        effects.append(.stopAcceptingDraftUpdates)
        if resources.capturingPublished {
            resources.capturingPublished = false
            effects.append(.setCapturing(false))
        }
        if resources.audioEngineActive || resources.audioTapInstalled || resources.audioSessionActivated {
            let removeTap = resources.audioTapInstalled
            let deactivateSession = resources.audioSessionActivated
            resources.audioEngineActive = false
            resources.audioTapInstalled = false
            resources.audioSessionActivated = false
            effects.append(.teardownAudioCapture(removeTap: removeTap, deactivateAudioSession: deactivateSession))
        }
        if resources.recognitionRequestActive || resources.recognitionTaskActive {
            resources.recognitionRequestActive = false
            resources.recognitionTaskActive = false
            effects.append(.releaseRecognition(cancelTask: cancelRecognitionTask))
        }
        if resources.macAccumulatorActive || resources.macTranscriberActive {
            resources.macAccumulatorActive = false
            resources.macTranscriberActive = false
            effects.append(.releaseMacCaptureResources)
        }
        resources = .none
        backend = .none
        state = .idle
        return effects
    }
}

// MARK: - Injectable Platform Seams

struct ComposerVoiceAudioSessionInputMetrics: Equatable, Sendable {
    let isInputAvailable: Bool
    let sampleRate: Double
    let inputNumberOfChannels: Int
}

@MainActor
protocol ComposerVoiceAudioSessionDriver: AnyObject {
    func activateForRecording() throws -> ComposerVoiceAudioSessionInputMetrics
    func deactivateAfterRecording()
}

protocol ComposerVoiceNativeRecognitionRequest: AnyObject, Sendable {
    func append(_ buffer: AVAudioPCMBuffer)
    func endAudio()
}

@MainActor
protocol ComposerVoiceNativeRecognitionTask: AnyObject {
    func cancel()
}

struct ComposerVoiceRecognitionUpdate: Equatable, Sendable {
    let transcript: String?
    let isFinal: Bool
    let errorDescription: String?
}

@MainActor
protocol ComposerVoiceAudioEngineHandle: AnyObject {
    var isRunning: Bool { get }
    var inputSampleRate: Double { get }
    var inputChannelCount: UInt32 { get }
    func installMacTap(into accumulator: ComposerMacSpeechPCMAccumulator)
    func installNativeTap(forwardingTo request: any ComposerVoiceNativeRecognitionRequest)
    func prepareAndStart() throws
    func stopAndReset(removeTap: Bool)
}

@MainActor
protocol ComposerVoiceNativeSpeechDriver: AnyObject {
    func prepareOnDeviceRecognizer(for locale: Locale) -> Bool
    func makeRequest() -> any ComposerVoiceNativeRecognitionRequest
    func startRecognition(
        request: any ComposerVoiceNativeRecognitionRequest,
        onUpdate: @escaping @MainActor (ComposerVoiceRecognitionUpdate) -> Void
    ) -> (any ComposerVoiceNativeRecognitionTask)?
}

// MARK: - Live Platform Implementations

@MainActor
private final class LiveComposerVoiceAudioSessionDriver: ComposerVoiceAudioSessionDriver {
    func activateForRecording() throws -> ComposerVoiceAudioSessionInputMetrics {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            ComposerVoiceAudioSessionConfiguration.category,
            mode: ComposerVoiceAudioSessionConfiguration.mode,
            options: ComposerVoiceAudioSessionConfiguration.options
        )
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        return ComposerVoiceAudioSessionInputMetrics(
            isInputAvailable: audioSession.isInputAvailable,
            sampleRate: audioSession.sampleRate,
            inputNumberOfChannels: audioSession.inputNumberOfChannels
        )
    }

    func deactivateAfterRecording() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

private final class LiveComposerVoiceNativeRecognitionRequest: ComposerVoiceNativeRecognitionRequest, @unchecked Sendable {
    let underlying: SFSpeechAudioBufferRecognitionRequest

    init() {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        self.underlying = request
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        underlying.append(buffer)
    }

    func endAudio() {
        underlying.endAudio()
    }
}

@MainActor
private final class LiveComposerVoiceNativeRecognitionTask: ComposerVoiceNativeRecognitionTask {
    private let underlying: SFSpeechRecognitionTask

    init(_ underlying: SFSpeechRecognitionTask) {
        self.underlying = underlying
    }

    func cancel() {
        underlying.cancel()
    }
}

@MainActor
private final class LiveComposerVoiceAudioEngineHandle: ComposerVoiceAudioEngineHandle {
    private let engine: AVAudioEngine

    init(engine: AVAudioEngine) {
        self.engine = engine
    }

    var isRunning: Bool { engine.isRunning }

    var inputSampleRate: Double {
        engine.inputNode.outputFormat(forBus: 0).sampleRate
    }

    var inputChannelCount: UInt32 {
        engine.inputNode.outputFormat(forBus: 0).channelCount
    }

    func installMacTap(into accumulator: ComposerMacSpeechPCMAccumulator) {
        let inputNode = engine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: recordingFormat) { buffer, _ in
            accumulator.append(buffer)
        }
    }

    func installNativeTap(forwardingTo request: any ComposerVoiceNativeRecognitionRequest) {
        let inputNode = engine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: recordingFormat) { [weak request] buffer, _ in
            request?.append(buffer)
        }
    }

    func prepareAndStart() throws {
        engine.prepare()
        try engine.start()
    }

    func stopAndReset(removeTap: Bool) {
        if engine.isRunning { engine.stop() }
        if removeTap {
            engine.inputNode.removeTap(onBus: 0)
        }
        engine.reset()
    }
}

@MainActor
private final class LiveComposerVoiceNativeSpeechDriver: ComposerVoiceNativeSpeechDriver {
    private let speechRecognizerFactory: () -> SFSpeechRecognizer?
    private var speechRecognizer: SFSpeechRecognizer?

    init(speechRecognizerFactory: @escaping () -> SFSpeechRecognizer?) {
        self.speechRecognizerFactory = speechRecognizerFactory
    }

    func prepareOnDeviceRecognizer(for locale: Locale) -> Bool {
        if let speechRecognizer {
            return speechRecognizer.supportsOnDeviceRecognition
        }
        let target = Self.normalizedLocaleIdentifier(locale.identifier)
        guard SFSpeechRecognizer.supportedLocales().contains(where: {
            Self.normalizedLocaleIdentifier($0.identifier) == target
        }) else { return false }

        let recognizer = speechRecognizerFactory()
        guard recognizer?.supportsOnDeviceRecognition == true else { return false }
        speechRecognizer = recognizer
        return true
    }

    func makeRequest() -> any ComposerVoiceNativeRecognitionRequest {
        LiveComposerVoiceNativeRecognitionRequest()
    }

    func startRecognition(
        request: any ComposerVoiceNativeRecognitionRequest,
        onUpdate: @escaping @MainActor (ComposerVoiceRecognitionUpdate) -> Void
    ) -> (any ComposerVoiceNativeRecognitionTask)? {
        guard let speechRecognizer,
              let liveRequest = request as? LiveComposerVoiceNativeRecognitionRequest else {
            return nil
        }
        let task = speechRecognizer.recognitionTask(with: liveRequest.underlying) { result, error in
            let update = ComposerVoiceRecognitionUpdate(
                transcript: result?.bestTranscription.formattedString,
                isFinal: result?.isFinal == true,
                errorDescription: error?.localizedDescription
            )
            Task { @MainActor in onUpdate(update) }
        }
        return LiveComposerVoiceNativeRecognitionTask(task)
    }

    private static func normalizedLocaleIdentifier(_ identifier: String) -> String {
        identifier.replacingOccurrences(of: "_", with: "-").lowercased()
    }
}

// MARK: - Controller

/// Composer dictation using either native on-device recognition or the explicitly
/// selected, authenticated paired-Mac local speech model.
@MainActor
@Observable
final class ComposerVoiceInputController {
    enum State: Equatable, Sendable {
        case idle
        case requestingPermission
        case listening
        case transcribing
    }

    struct Dependencies {
        var selectedMode: @MainActor () -> AidenVoiceInputMode
        var isAppActive: @MainActor () -> Bool
        var requestMicrophonePermission: @MainActor () async -> Bool
        var requestSpeechAuthorization: @MainActor () async -> SFSpeechRecognizerAuthorizationStatus
        var audioSession: any ComposerVoiceAudioSessionDriver
        var audioEngineFactory: @MainActor () -> any ComposerVoiceAudioEngineHandle
        var nativeSpeech: any ComposerVoiceNativeSpeechDriver
        var makeMacAccumulator: @MainActor () -> ComposerMacSpeechPCMAccumulator
        var finalizationSleep: @Sendable (Duration) async throws -> Void
        var setCapturing: @MainActor (Bool) -> Void
    }

    private(set) var reducer = ComposerVoiceInputReducer()
    var state: State { reducer.state }
    private(set) var errorMessage: String?
    private(set) var liveTranscript = ""

    @ObservationIgnored private let dependencies: Dependencies
    @ObservationIgnored private var audioEngine: (any ComposerVoiceAudioEngineHandle)?
    @ObservationIgnored private var recognitionRequest: (any ComposerVoiceNativeRecognitionRequest)?
    @ObservationIgnored private var recognitionTask: (any ComposerVoiceNativeRecognitionTask)?
    @ObservationIgnored private var draftUpdateSession = ComposerVoiceDraftUpdateSession()
    @ObservationIgnored private var updateDraft: ((String) -> Void)?
    @ObservationIgnored private var macAccumulator: ComposerMacSpeechPCMAccumulator?
    @ObservationIgnored private var macTranscriber: ((Data) async throws -> String)?
    @ObservationIgnored private var macTranscriptionTask: Task<Void, Never>?
    @ObservationIgnored private var nativeFinalizationTask: Task<Void, Never>?

    @ObservationIgnored var locale = Locale.current

    init(
        speechRecognizerFactory: @escaping () -> SFSpeechRecognizer? = {
            SFSpeechRecognizer(locale: Locale.current)
        },
        audioEngineFactory: @escaping () -> AVAudioEngine = { AVAudioEngine() }
    ) {
        self.dependencies = Dependencies(
            selectedMode: { AidenVoiceInputMode.selected },
            isAppActive: { UIApplication.shared.applicationState == .active },
            requestMicrophonePermission: { await ComposerVoiceMicrophonePermissionRequester.request() },
            requestSpeechAuthorization: {
                await withCheckedContinuation { continuation in
                    SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
                }
            },
            audioSession: LiveComposerVoiceAudioSessionDriver(),
            audioEngineFactory: { LiveComposerVoiceAudioEngineHandle(engine: audioEngineFactory()) },
            nativeSpeech: LiveComposerVoiceNativeSpeechDriver(speechRecognizerFactory: speechRecognizerFactory),
            makeMacAccumulator: { ComposerMacSpeechPCMAccumulator() },
            finalizationSleep: { try await Task.sleep(for: $0) },
            setCapturing: { AidenComposerAudioCaptureState.shared.setCapturing($0) }
        )
    }

    init(dependencies: Dependencies) {
        self.dependencies = dependencies
    }

    deinit {
        macTranscriptionTask?.cancel()
        nativeFinalizationTask?.cancel()
    }

    var isListening: Bool { state == .listening }
    var isBusy: Bool { state != .idle }

    func toggle(
        currentDraft: String,
        updateDraft: @escaping (String) -> Void,
        macTranscriber: @escaping (Data) async throws -> String
    ) async {
        if isListening {
            stopKeepingTranscript()
        } else {
            guard state == .idle else { return }
            if dependencies.selectedMode() == .pairedMac {
                await startMac(
                    currentDraft: currentDraft,
                    updateDraft: updateDraft,
                    transcriber: macTranscriber
                )
            } else {
                await start(currentDraft: currentDraft, updateDraft: updateDraft)
            }
        }
    }

    func stopKeepingTranscript() {
        switch reducer.stopKeepingTranscript() {
        case .ignore:
            return
        case let .finishPairedMac(session, effects):
            let pcm = macAccumulator?.data ?? Data()
            let transcriber = macTranscriber
            apply(effects)
            finishMacRecording(session: session, pcm: pcm, transcriber: transcriber)
        case let .finalizeNative(_, effects):
            apply(effects)
        }
    }

    func stopBeforeSubmittingDraft() {
        apply(reducer.stopForSubmitOrCancel())
    }

    func cancelDiscardingRecording() {
        stopBeforeSubmittingDraft()
    }

    private func startMac(
        currentDraft: String,
        updateDraft: @escaping (String) -> Void,
        transcriber: @escaping (Data) async throws -> String
    ) async {
        guard let begun = reducer.beginSession(backend: .pairedMac) else { return }
        let session = begun.session
        apply(begun.effects)
        draftUpdateSession.begin(baseDraft: currentDraft)
        self.updateDraft = updateDraft
        macTranscriber = transcriber

        let microphoneGranted = await dependencies.requestMicrophonePermission()
        guard reducer.isCurrent(session), state == .requestingPermission else { return }
        guard microphoneGranted else {
            fail(
                session: session,
                String(localized: "Microphone access is disabled. Enable it in Settings to use voice input."),
                logCategory: .microphonePermission
            )
            return
        }
        guard reducer.isCurrent(session), ComposerVoiceInputStartPolicy.canStart(appIsActive: dependencies.isAppActive()) else {
            fail(session: session, ComposerVoiceInputError.appNotActive.localizedDescription, logCategory: .appNotActive)
            return
        }
        do {
            try startMacAudioCapture()
            if let effects = reducer.didStartListening(session: session) {
                apply(effects)
            }
        } catch {
            fail(session: session, error.localizedDescription, logCategory: Self.logCategory(for: error))
        }
    }

    private func startMacAudioCapture() throws {
        apply(reducer.prepareAudioCapture())
        let metrics = try dependencies.audioSession.activateForRecording()
        reducer.didActivateAudioSession()
        try ComposerVoiceInputStartPolicy.validateAudioSessionInput(
            isInputAvailable: metrics.isInputAvailable,
            sampleRate: metrics.sampleRate,
            inputNumberOfChannels: metrics.inputNumberOfChannels
        )

        let engine = dependencies.audioEngineFactory()
        audioEngine = engine
        reducer.didAttachAudioEngine()
        try ComposerVoiceInputPreflight.validate(
            sampleRate: engine.inputSampleRate,
            channelCount: engine.inputChannelCount
        )
        let accumulator = dependencies.makeMacAccumulator()
        macAccumulator = accumulator
        reducer.didCreateMacAccumulator()
        engine.installMacTap(into: accumulator)
        reducer.didInstallAudioTap()
        try engine.prepareAndStart()
    }

    private func finishMacRecording(
        session: Int,
        pcm: Data,
        transcriber: ((Data) async throws -> String)?
    ) {
        guard !pcm.isEmpty, let transcriber else {
            fail(session: session, String(localized: "No speech was recorded."), logCategory: .audioStartup)
            return
        }
        guard let effects = reducer.beginMacTranscription(session: session) else { return }
        apply(effects)
        macTranscriptionTask = Task { [weak self] in
            do {
                let transcript = try await transcriber(pcm)
                try Task.checkCancellation()
                guard let self, self.reducer.isCurrent(session), self.state == .transcribing else { return }
                self.liveTranscript = transcript
                if let draft = self.draftUpdateSession.composedDraft(for: transcript) {
                    self.updateDraft?(draft)
                }
                self.macTranscriptionTask = nil
                if let completionEffects = self.reducer.macTranscriptionCompleted(session: session) {
                    self.apply(completionEffects)
                }
            } catch {
                guard let self, !Task.isCancelled, self.reducer.isCurrent(session), self.state == .transcribing else { return }
                self.macTranscriptionTask = nil
                self.fail(session: session, error.localizedDescription, logCategory: .audioStartup)
            }
        }
    }

    private func start(currentDraft: String, updateDraft: @escaping (String) -> Void) async {
        guard let begun = reducer.beginSession(backend: .nativeOnDevice) else { return }
        let session = begun.session
        apply(begun.effects)
        draftUpdateSession.begin(baseDraft: currentDraft)
        self.updateDraft = updateDraft

        guard dependencies.nativeSpeech.prepareOnDeviceRecognizer(for: locale) else {
            fail(
                session: session,
                String(localized: "On-device speech recognition is not available for the current locale."),
                logCategory: .speechUnavailable
            )
            return
        }

        let speechStatus = await dependencies.requestSpeechAuthorization()
        guard reducer.isCurrent(session), state == .requestingPermission else { return }
        guard speechStatus == .authorized else {
            fail(session: session, Self.speechAuthorizationMessage(for: speechStatus), logCategory: .speechAuthorization)
            return
        }

        let microphoneGranted = await dependencies.requestMicrophonePermission()
        guard reducer.isCurrent(session), state == .requestingPermission else { return }
        guard microphoneGranted else {
            fail(
                session: session,
                String(localized: "Microphone access is disabled. Enable it in Settings to use voice input."),
                logCategory: .microphonePermission
            )
            return
        }

        guard reducer.isCurrent(session), ComposerVoiceInputStartPolicy.canStart(
            appIsActive: dependencies.isAppActive()
        ) else {
            fail(session: session, ComposerVoiceInputError.appNotActive.localizedDescription, logCategory: .appNotActive)
            return
        }

        do {
            try startRecognition(session: session)
            if let effects = reducer.didStartListening(session: session) {
                apply(effects)
            }
        } catch {
            fail(session: session, error.localizedDescription, logCategory: Self.logCategory(for: error))
        }
    }

    private func startRecognition(session: Int) throws {
        apply(reducer.prepareAudioCapture())

        let metrics = try dependencies.audioSession.activateForRecording()
        reducer.didActivateAudioSession()
        try ComposerVoiceInputStartPolicy.validateAudioSessionInput(
            isInputAvailable: metrics.isInputAvailable,
            sampleRate: metrics.sampleRate,
            inputNumberOfChannels: metrics.inputNumberOfChannels
        )

        let request = dependencies.nativeSpeech.makeRequest()
        recognitionRequest = request
        reducer.didCreateRecognitionRequest()

        let engine = dependencies.audioEngineFactory()
        audioEngine = engine
        reducer.didAttachAudioEngine()
        try ComposerVoiceInputStartPolicy.validateAudioEngine(isRunning: engine.isRunning)
        try ComposerVoiceInputPreflight.validate(
            sampleRate: engine.inputSampleRate,
            channelCount: engine.inputChannelCount
        )
        engine.installNativeTap(forwardingTo: request)
        reducer.didInstallAudioTap()

        recognitionTask = dependencies.nativeSpeech.startRecognition(request: request) { [weak self] update in
            self?.handleRecognition(update: update, session: session)
        }
        if recognitionTask != nil {
            reducer.didStartRecognitionTask()
        }
        try engine.prepareAndStart()
    }

    private func handleRecognition(update: ComposerVoiceRecognitionUpdate, session: Int) {
        guard reducer.isCurrent(session), state != .idle else { return }
        if let transcript = update.transcript {
            liveTranscript = transcript
            if let draft = draftUpdateSession.composedDraft(for: liveTranscript) {
                updateDraft?(draft)
            }
        }

        if let errorDescription = update.errorDescription {
            if let effects = reducer.nativeRecognitionTerminated(session: session, errorDescription: errorDescription) {
                apply(effects)
            }
        } else if update.isFinal {
            if let effects = reducer.nativeRecognitionTerminated(session: session, errorDescription: nil) {
                apply(effects)
            }
        }
    }

    private func fail(session: Int?, _ message: String, logCategory: VoiceInputFailureLogCategory) {
        guard let effects = reducer.fail(session: session, message: message, logCategory: logCategory) else { return }
        apply(effects)
    }

    private func apply(_ effects: [ComposerVoiceInputReducer.Effect]) {
        for effect in effects {
            switch effect {
            case .stopAcceptingDraftUpdates:
                draftUpdateSession.stopAcceptingUpdates()
                updateDraft = nil
            case let .setCapturing(capturing):
                dependencies.setCapturing(capturing)
            case let .teardownAudioCapture(removeTap, deactivateAudioSession):
                if let audioEngine {
                    audioEngine.stopAndReset(removeTap: removeTap)
                }
                audioEngine = nil
                if deactivateAudioSession {
                    dependencies.audioSession.deactivateAfterRecording()
                }
            case .endRecognitionAudio:
                recognitionRequest?.endAudio()
            case let .releaseRecognition(cancelTask):
                recognitionRequest?.endAudio()
                if cancelTask { recognitionTask?.cancel() }
                recognitionTask = nil
                recognitionRequest = nil
            case .releaseMacCaptureResources:
                macAccumulator = nil
                macTranscriber = nil
            case .cancelMacTranscriptionTask:
                macTranscriptionTask?.cancel()
                macTranscriptionTask = nil
            case .cancelNativeFinalizationTask:
                nativeFinalizationTask?.cancel()
                nativeFinalizationTask = nil
            case let .scheduleNativeFinalizationTimeout(session):
                let sleep = dependencies.finalizationSleep
                nativeFinalizationTask = Task { [weak self] in
                    try? await sleep(.seconds(2))
                    guard !Task.isCancelled, let self else { return }
                    self.nativeFinalizationTask = nil
                    if let timeoutEffects = self.reducer.nativeFinalizationTimedOut(session: session) {
                        self.apply(timeoutEffects)
                    }
                }
            case let .recordFailureDiagnostic(logCategory):
                AidenDiagnostics.record(
                    .speech,
                    event: .speechFailed,
                    outcome: .failed,
                    code: logCategory.diagnosticCode
                )
            case let .setErrorMessage(message):
                errorMessage = message
            case .clearLiveTranscript:
                liveTranscript = ""
            }
        }
    }

    private static func speechAuthorizationMessage(for status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .denied:
            return String(localized: "Speech recognition is disabled. Enable it in Settings to use voice input.")
        case .restricted:
            return String(localized: "Speech recognition is restricted on this device.")
        case .notDetermined:
            return String(localized: "Speech recognition permission was not granted.")
        case .authorized:
            return ""
        @unknown default:
            return String(localized: "Speech recognition is not available right now.")
        }
    }

    private static func logCategory(for error: Error) -> VoiceInputFailureLogCategory {
        guard let voiceError = error as? ComposerVoiceInputError else { return .audioStartup }
        switch voiceError {
        case .noAudioInput: return .noAudioInput
        case .invalidInputFormat: return .invalidInputFormat
        case .appNotActive: return .appNotActive
        case .audioEngineAlreadyRunning: return .audioEngineAlreadyRunning
        }
    }
}

struct ComposerVoiceSessionFence: Equatable, Sendable {
    private(set) var current = 0

    mutating func advance() -> Int {
        current += 1
        return current
    }

    func accepts(_ session: Int) -> Bool { current == session }
}

final class ComposerMacSpeechPCMAccumulator: @unchecked Sendable {
    private static let sampleRate = 16_000.0
    private static let maximumSamples = 16_000 * 60
    private let lock = NSLock()
    private var storage = Data()

    var data: Data {
        lock.withLock { storage }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0, buffer.format.sampleRate > 0 else { return }
        let ratio = Self.sampleRate / buffer.format.sampleRate
        let outputCount = max(1, Int(Double(frameCount) * ratio))
        var samples = [Int16]()
        samples.reserveCapacity(outputCount)

        if let channels = buffer.floatChannelData {
            let source = channels[0]
            for index in 0..<outputCount {
                let sourceIndex = min(frameCount - 1, Int(Double(index) / ratio))
                let value = max(-1, min(1, source[sourceIndex]))
                samples.append(Int16(value * Float(Int16.max)).littleEndian)
            }
        } else if let channels = buffer.int16ChannelData {
            let source = channels[0]
            for index in 0..<outputCount {
                let sourceIndex = min(frameCount - 1, Int(Double(index) / ratio))
                samples.append(source[sourceIndex].littleEndian)
            }
        } else {
            return
        }

        lock.withLock {
            let retainedSamples = min(samples.count, Self.maximumSamples - storage.count / 2)
            guard retainedSamples > 0 else { return }
            samples.withUnsafeBytes { bytes in
                storage.append(contentsOf: bytes.bindMemory(to: UInt8.self).prefix(retainedSamples * 2))
            }
        }
    }
}

enum ComposerVoiceMicrophonePermissionRequester {
    static func request() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
    }
}

enum ComposerVoiceAudioSessionConfiguration {
    static let category = AVAudioSession.Category.playAndRecord
    static let mode = AVAudioSession.Mode.measurement
    static let options: AVAudioSession.CategoryOptions = [.mixWithOthers, .allowBluetoothHFP]
}

enum ComposerVoiceInputError: LocalizedError {
    case noAudioInput
    case invalidInputFormat
    case appNotActive
    case audioEngineAlreadyRunning

    var errorDescription: String? {
        switch self {
        case .noAudioInput:
            return String(localized: "No microphone input is available. Check the device microphone settings.")
        case .invalidInputFormat:
            return String(localized: "Voice input is not available because the microphone input format is invalid.")
        case .appNotActive:
            return String(localized: "Voice input can start only while Aiden On The Go is active.")
        case .audioEngineAlreadyRunning:
            return String(localized: "Voice input is already preparing the microphone. Try again in a moment.")
        }
    }
}

enum VoiceInputFailureLogCategory: String, Equatable, Sendable {
    case speechUnavailable, speechAuthorization, microphonePermission, appNotActive
    case noAudioInput, invalidInputFormat, audioEngineAlreadyRunning, audioStartup
}

private extension VoiceInputFailureLogCategory {
    var diagnosticCode: AidenDiagnosticCode {
        switch self {
        case .microphonePermission: .microphonePermission
        case .speechAuthorization: .speechAuthorization
        case .speechUnavailable: .unavailable
        case .audioStartup, .noAudioInput, .invalidInputFormat, .audioEngineAlreadyRunning: .audioStartup
        case .appNotActive: .unavailable
        }
    }
}

enum ComposerVoiceInputStartPolicy {
    static func canStart(appIsActive: Bool) -> Bool { appIsActive }

    static func validateAudioSessionInput(
        isInputAvailable: Bool,
        sampleRate: Double,
        inputNumberOfChannels: Int
    ) throws {
        guard isInputAvailable else { throw ComposerVoiceInputError.noAudioInput }
        try ComposerVoiceInputPreflight.validate(
            sampleRate: sampleRate,
            channelCount: UInt32(max(inputNumberOfChannels, 0))
        )
    }

    static func validateAudioEngine(isRunning: Bool) throws {
        guard !isRunning else { throw ComposerVoiceInputError.audioEngineAlreadyRunning }
    }
}

enum ComposerVoiceInputPreflight {
    static let validSampleRateRange: ClosedRange<Double> = 8_000...192_000
    static let validChannelCountRange: ClosedRange<UInt32> = 1...16

    static func validate(sampleRate: Double, channelCount: UInt32) throws {
        guard sampleRate.isFinite,
              validSampleRateRange.contains(sampleRate),
              validChannelCountRange.contains(channelCount)
        else { throw ComposerVoiceInputError.invalidInputFormat }
    }

    static func validate(recordingFormat: AVAudioFormat) throws {
        try validate(sampleRate: recordingFormat.sampleRate, channelCount: recordingFormat.channelCount)
    }
}

enum ComposerVoiceDraftComposer {
    static func composedDraft(baseDraft: String, transcript: String) -> String {
        let transcript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return baseDraft }
        let draft = baseDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        return draft.isEmpty ? transcript : "\(draft) \(transcript)"
    }
}

struct ComposerVoiceDraftUpdateSession {
    private var baseDraft = ""
    private var acceptsUpdates = false

    mutating func begin(baseDraft: String) {
        self.baseDraft = baseDraft
        acceptsUpdates = true
    }

    mutating func stopAcceptingUpdates() { acceptsUpdates = false }

    func composedDraft(for transcript: String) -> String? {
        guard acceptsUpdates else { return nil }
        return ComposerVoiceDraftComposer.composedDraft(baseDraft: baseDraft, transcript: transcript)
    }
}

@MainActor
final class AidenComposerAudioCaptureState {
    static let shared = AidenComposerAudioCaptureState()
    private(set) var isCapturing = false

    private init() {}

    func setCapturing(_ capturing: Bool) {
        isCapturing = capturing
    }
}
