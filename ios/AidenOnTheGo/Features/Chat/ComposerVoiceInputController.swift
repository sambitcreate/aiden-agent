import AVFoundation
import Foundation
import Observation
import Speech
import UIKit

/// Composer dictation using either native on-device recognition or the explicitly
/// selected, authenticated paired-Mac local speech model.
@MainActor
@Observable
final class ComposerVoiceInputController {
    enum State: Equatable {
        case idle
        case requestingPermission
        case listening
        case transcribing
    }

    private(set) var state: State = .idle
    private(set) var errorMessage: String?
    private(set) var liveTranscript = ""

    private let speechRecognizerFactory: () -> SFSpeechRecognizer?
    private let audioEngineFactory: () -> AVAudioEngine
    private var speechRecognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var draftUpdateSession = ComposerVoiceDraftUpdateSession()
    private var updateDraft: ((String) -> Void)?
    private var suppressNextRecognitionError = false
    private var activatedAudioSessionForRecording = false
    private var audioTapInstalled = false
    private var macAccumulator: ComposerMacSpeechPCMAccumulator?
    private var macTranscriber: ((Data) async throws -> String)?
    private var macTranscriptionTask: Task<Void, Never>?
    private var nativeFinalizationTask: Task<Void, Never>?
    private var sessionFence = ComposerVoiceSessionFence()

    @ObservationIgnored var locale = Locale.current

    init(
        speechRecognizerFactory: @escaping () -> SFSpeechRecognizer? = {
            SFSpeechRecognizer(locale: Locale.current)
        },
        audioEngineFactory: @escaping () -> AVAudioEngine = { AVAudioEngine() }
    ) {
        self.speechRecognizerFactory = speechRecognizerFactory
        self.audioEngineFactory = audioEngineFactory
    }

    var isListening: Bool { state == .listening }
    var isRequestingPermission: Bool { state == .requestingPermission }
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
            if AidenVoiceInputMode.selected == .pairedMac {
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
        if macAccumulator != nil {
            finishMacRecording()
            return
        }
        suppressNextRecognitionError = true
        let session = sessionFence.current
        state = .transcribing
        finishNativeAudioCapture()
        nativeFinalizationTask?.cancel()
        nativeFinalizationTask = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, isCurrent(session), state == .transcribing else { return }
            stopAcceptingDraftUpdates()
            stopAudio(cancelTask: true)
            state = .idle
        }
    }

    func stopBeforeSubmittingDraft() {
        invalidateSession()
        suppressNextRecognitionError = true
        stopAcceptingDraftUpdates()
        stopAudio(cancelTask: true)
        macAccumulator = nil
        macTranscriber = nil
        state = .idle
    }

    func cancelDiscardingRecording() {
        stopBeforeSubmittingDraft()
    }

    private func startMac(
        currentDraft: String,
        updateDraft: @escaping (String) -> Void,
        transcriber: @escaping (Data) async throws -> String
    ) async {
        let session = beginSession()
        errorMessage = nil
        liveTranscript = ""
        draftUpdateSession.begin(baseDraft: currentDraft)
        self.updateDraft = updateDraft
        macTranscriber = transcriber
        state = .requestingPermission

        let microphoneGranted = await ComposerVoiceMicrophonePermissionRequester.request()
        guard isCurrent(session), state == .requestingPermission else { return }
        guard microphoneGranted else {
            fail(
                String(localized: "Microphone access is disabled. Enable it in Settings to use voice input."),
                logCategory: .microphonePermission
            )
            return
        }
        guard isCurrent(session), ComposerVoiceInputStartPolicy.canStart(appIsActive: UIApplication.shared.applicationState == .active) else {
            fail(ComposerVoiceInputError.appNotActive.localizedDescription, logCategory: .appNotActive)
            return
        }
        do {
            try startMacAudioCapture()
            state = .listening
        } catch {
            fail(error.localizedDescription, logCategory: Self.logCategory(for: error))
        }
    }

    private func startMacAudioCapture() throws {
        stopAudio(cancelTask: true)
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            ComposerVoiceAudioSessionConfiguration.category,
            mode: ComposerVoiceAudioSessionConfiguration.mode,
            options: ComposerVoiceAudioSessionConfiguration.options
        )
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        activatedAudioSessionForRecording = true
        try ComposerVoiceInputStartPolicy.validateAudioSessionInput(
            isInputAvailable: audioSession.isInputAvailable,
            sampleRate: audioSession.sampleRate,
            inputNumberOfChannels: audioSession.inputNumberOfChannels
        )

        let engine = audioEngineFactory()
        audioEngine = engine
        let inputNode = engine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        try ComposerVoiceInputPreflight.validate(recordingFormat: recordingFormat)
        let accumulator = ComposerMacSpeechPCMAccumulator()
        macAccumulator = accumulator
        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: recordingFormat) { buffer, _ in
            accumulator.append(buffer)
        }
        audioTapInstalled = true
        engine.prepare()
        try engine.start()
        AidenComposerAudioCaptureState.shared.setCapturing(true)
    }

    private func finishMacRecording() {
        let session = sessionFence.current
        let pcm = macAccumulator?.data ?? Data()
        let transcriber = macTranscriber
        macAccumulator = nil
        macTranscriber = nil
        stopAudio(cancelTask: true)
        guard !pcm.isEmpty, let transcriber else {
            fail(String(localized: "No speech was recorded."), logCategory: .audioStartup)
            return
        }
        state = .transcribing
        macTranscriptionTask?.cancel()
        macTranscriptionTask = Task {
            do {
                let transcript = try await transcriber(pcm)
                try Task.checkCancellation()
                guard isCurrent(session), state == .transcribing else { return }
                liveTranscript = transcript
                if let draft = draftUpdateSession.composedDraft(for: transcript) {
                    updateDraft?(draft)
                }
                stopAcceptingDraftUpdates()
                state = .idle
            } catch {
                guard !Task.isCancelled, isCurrent(session), state == .transcribing else { return }
                fail(error.localizedDescription, logCategory: .audioStartup)
            }
        }
    }

    private func start(currentDraft: String, updateDraft: @escaping (String) -> Void) async {
        guard state == .idle else { return }
        let session = beginSession()

        errorMessage = nil
        liveTranscript = ""
        suppressNextRecognitionError = false
        draftUpdateSession.begin(baseDraft: currentDraft)
        self.updateDraft = updateDraft
        state = .requestingPermission

        guard let speechRecognizer = onDeviceSpeechRecognizerForRecording() else {
            fail(
                String(localized: "On-device speech recognition is not available for the current locale."),
                logCategory: .speechUnavailable
            )
            return
        }

        let speechStatus = await requestSpeechAuthorization()
        guard isCurrent(session), state == .requestingPermission else { return }
        guard speechStatus == .authorized else {
            fail(Self.speechAuthorizationMessage(for: speechStatus), logCategory: .speechAuthorization)
            return
        }

        let microphoneGranted = await ComposerVoiceMicrophonePermissionRequester.request()
        guard isCurrent(session), state == .requestingPermission else { return }
        guard microphoneGranted else {
            fail(
                String(localized: "Microphone access is disabled. Enable it in Settings to use voice input."),
                logCategory: .microphonePermission
            )
            return
        }

        guard isCurrent(session), ComposerVoiceInputStartPolicy.canStart(
            appIsActive: UIApplication.shared.applicationState == .active
        ) else {
            fail(ComposerVoiceInputError.appNotActive.localizedDescription, logCategory: .appNotActive)
            return
        }

        do {
            try startRecognition(speechRecognizer: speechRecognizer, session: session)
            state = .listening
        } catch {
            fail(error.localizedDescription, logCategory: Self.logCategory(for: error))
        }
    }

    private func startRecognition(speechRecognizer: SFSpeechRecognizer, session: Int) throws {
        stopAudio(cancelTask: true)

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            ComposerVoiceAudioSessionConfiguration.category,
            mode: ComposerVoiceAudioSessionConfiguration.mode,
            options: ComposerVoiceAudioSessionConfiguration.options
        )
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        activatedAudioSessionForRecording = true
        try ComposerVoiceInputStartPolicy.validateAudioSessionInput(
            isInputAvailable: audioSession.isInputAvailable,
            sampleRate: audioSession.sampleRate,
            inputNumberOfChannels: audioSession.inputNumberOfChannels
        )

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        recognitionRequest = request

        let engine = audioEngineFactory()
        audioEngine = engine
        try ComposerVoiceInputStartPolicy.validateAudioEngine(isRunning: engine.isRunning)

        let inputNode = engine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        try ComposerVoiceInputPreflight.validate(recordingFormat: recordingFormat)
        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: recordingFormat) { [weak request] buffer, _ in
            request?.append(buffer)
        }
        audioTapInstalled = true

        engine.prepare()
        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in self?.handleRecognition(result: result, error: error, session: session) }
        }
        try engine.start()
        AidenComposerAudioCaptureState.shared.setCapturing(true)
    }

    private func handleRecognition(result: SFSpeechRecognitionResult?, error: Error?, session: Int) {
        guard isCurrent(session), state != .idle else { return }
        if let result {
            liveTranscript = result.bestTranscription.formattedString
            if let draft = draftUpdateSession.composedDraft(for: liveTranscript) {
                updateDraft?(draft)
            }
        }

        if let error {
            nativeFinalizationTask?.cancel()
            nativeFinalizationTask = nil
            stopAcceptingDraftUpdates()
            stopAudio(cancelTask: false)
            state = .idle
            if suppressNextRecognitionError {
                suppressNextRecognitionError = false
            } else {
                errorMessage = error.localizedDescription
            }
        } else if result?.isFinal == true {
            nativeFinalizationTask?.cancel()
            nativeFinalizationTask = nil
            stopAcceptingDraftUpdates()
            stopAudio(cancelTask: false)
            state = .idle
            suppressNextRecognitionError = false
        }
    }

    private func stopAcceptingDraftUpdates() {
        draftUpdateSession.stopAcceptingUpdates()
        updateDraft = nil
    }

    private func stopAudio(cancelTask: Bool) {
        AidenComposerAudioCaptureState.shared.setCapturing(false)
        if let audioEngine {
            if audioEngine.isRunning { audioEngine.stop() }
            if audioTapInstalled {
                audioEngine.inputNode.removeTap(onBus: 0)
                audioTapInstalled = false
            }
            audioEngine.reset()
        }
        audioEngine = nil
        recognitionRequest?.endAudio()
        if cancelTask { recognitionTask?.cancel() }
        recognitionTask = nil
        recognitionRequest = nil
        if activatedAudioSessionForRecording {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            activatedAudioSessionForRecording = false
        }
    }

    private func finishNativeAudioCapture() {
        AidenComposerAudioCaptureState.shared.setCapturing(false)
        if let audioEngine {
            if audioEngine.isRunning { audioEngine.stop() }
            if audioTapInstalled {
                audioEngine.inputNode.removeTap(onBus: 0)
                audioTapInstalled = false
            }
            audioEngine.reset()
        }
        audioEngine = nil
        recognitionRequest?.endAudio()
        if activatedAudioSessionForRecording {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            activatedAudioSessionForRecording = false
        }
    }

    private func onDeviceSpeechRecognizerForRecording() -> SFSpeechRecognizer? {
        if let speechRecognizer {
            return speechRecognizer.supportsOnDeviceRecognition ? speechRecognizer : nil
        }

        let target = Self.normalizedLocaleIdentifier(locale.identifier)
        guard SFSpeechRecognizer.supportedLocales().contains(where: {
            Self.normalizedLocaleIdentifier($0.identifier) == target
        }) else { return nil }

        let recognizer = speechRecognizerFactory()
        guard recognizer?.supportsOnDeviceRecognition == true else { return nil }
        speechRecognizer = recognizer
        return recognizer
    }

    private static func normalizedLocaleIdentifier(_ identifier: String) -> String {
        identifier.replacingOccurrences(of: "_", with: "-").lowercased()
    }

    private func fail(_ message: String, logCategory: VoiceInputFailureLogCategory) {
        AidenDiagnostics.record(
            .speech,
            event: .speechFailed,
            outcome: .failed,
            code: logCategory.diagnosticCode
        )
        suppressNextRecognitionError = false
        stopAcceptingDraftUpdates()
        stopAudio(cancelTask: true)
        macAccumulator = nil
        macTranscriber = nil
        state = .idle
        errorMessage = message
    }

    private func beginSession() -> Int {
        let session = sessionFence.advance()
        macTranscriptionTask?.cancel()
        macTranscriptionTask = nil
        nativeFinalizationTask?.cancel()
        nativeFinalizationTask = nil
        return session
    }

    private func invalidateSession() {
        sessionFence.advance()
        macTranscriptionTask?.cancel()
        macTranscriptionTask = nil
        nativeFinalizationTask?.cancel()
        nativeFinalizationTask = nil
    }

    private func isCurrent(_ session: Int) -> Bool { sessionFence.accepts(session) }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
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

struct ComposerVoiceSessionFence {
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

enum VoiceInputFailureLogCategory: String {
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
