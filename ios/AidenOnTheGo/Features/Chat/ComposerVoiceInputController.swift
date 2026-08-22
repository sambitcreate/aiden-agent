import AVFoundation
import Foundation
import Observation
import OSLog
import Speech
import UIKit

/// On-device-only speech input for the composer. Audio never leaves the device.
@MainActor
@Observable
final class ComposerVoiceInputController {
    enum State: Equatable {
        case idle
        case requestingPermission
        case listening
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
    private let logger = Logger.aidenVoiceInput

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

    func toggle(currentDraft: String, updateDraft: @escaping (String) -> Void) async {
        if isListening {
            stopKeepingTranscript()
        } else {
            await start(currentDraft: currentDraft, updateDraft: updateDraft)
        }
    }

    func stopKeepingTranscript() {
        suppressNextRecognitionError = true
        stopAcceptingDraftUpdates()
        stopAudio(cancelTask: false)
        state = .idle
    }

    func stopBeforeSubmittingDraft() {
        suppressNextRecognitionError = true
        stopAcceptingDraftUpdates()
        stopAudio(cancelTask: true)
        state = .idle
    }

    private func start(currentDraft: String, updateDraft: @escaping (String) -> Void) async {
        guard state == .idle else { return }

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
        guard state == .requestingPermission else { return }
        guard speechStatus == .authorized else {
            fail(Self.speechAuthorizationMessage(for: speechStatus), logCategory: .speechAuthorization)
            return
        }

        let microphoneGranted = await ComposerVoiceMicrophonePermissionRequester.request()
        guard state == .requestingPermission else { return }
        guard microphoneGranted else {
            fail(
                String(localized: "Microphone access is disabled. Enable it in Settings to use voice input."),
                logCategory: .microphonePermission
            )
            return
        }

        guard ComposerVoiceInputStartPolicy.canStart(
            appIsActive: UIApplication.shared.applicationState == .active
        ) else {
            fail(ComposerVoiceInputError.appNotActive.localizedDescription, logCategory: .appNotActive)
            return
        }

        do {
            try startRecognition(speechRecognizer: speechRecognizer)
            state = .listening
        } catch {
            fail(error.localizedDescription, logCategory: Self.logCategory(for: error))
        }
    }

    private func startRecognition(speechRecognizer: SFSpeechRecognizer) throws {
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
            Task { @MainActor in self?.handleRecognition(result: result, error: error) }
        }
        try engine.start()
        AidenComposerAudioCaptureState.shared.setCapturing(true)
    }

    private func handleRecognition(result: SFSpeechRecognitionResult?, error: Error?) {
        if let result {
            liveTranscript = result.bestTranscription.formattedString
            if let draft = draftUpdateSession.composedDraft(for: liveTranscript) {
                updateDraft?(draft)
            }
        }

        if let error {
            stopAcceptingDraftUpdates()
            stopAudio(cancelTask: false)
            state = .idle
            if suppressNextRecognitionError {
                suppressNextRecognitionError = false
            } else {
                errorMessage = error.localizedDescription
            }
        } else if result?.isFinal == true {
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
        logger.error("Voice input failed category=\(logCategory.rawValue, privacy: .public)")
        suppressNextRecognitionError = false
        stopAcceptingDraftUpdates()
        stopAudio(cancelTask: true)
        state = .idle
        errorMessage = message
    }

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

private extension Logger {
    static let aidenVoiceInput = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "AidenOnTheGo",
        category: "VoiceInput"
    )
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
