import Foundation
import Observation

/// The microphone side of a composer. `ComposerVoiceInputController` is the real
/// one; tests supply a stand-in, since a test host cannot open the mic.
@MainActor
protocol AidenComposerVoiceCapture: AnyObject {
    var isListening: Bool { get }
    var isBusy: Bool { get }
    var errorMessage: String? { get }
    func toggle(
        currentDraft: String,
        updateDraft: @escaping (String) -> Void,
        macTranscriber: @escaping (Data) async throws -> String
    ) async
    func cancelDiscardingRecording()
}

extension ComposerVoiceInputController: AidenComposerVoiceCapture {}

/// The paired machine's side of voice input. `AidenRemoteClient` is the real one.
protocol AidenMacSpeechTransport: Sendable {
    func speechStatus() async throws -> AidenSpeechStatus
    func selectSpeechModel(_ modelId: String) async throws -> AidenSpeechStatus
    func transcribeSpeech(pcm16: Data, modelId: String) async throws -> AidenSpeechTranscription
}

extension AidenRemoteClient: AidenMacSpeechTransport {}

/// Turns a recording into text on the paired machine, with the machine's chosen
/// model or the best one installed. `isWanted` is asked after every wait: words
/// nobody is waiting for any more are dropped, not delivered.
@MainActor
func aidenTranscribeSpeech(
    _ pcm16: Data,
    on speech: any AidenMacSpeechTransport,
    isWanted: () -> Bool
) async throws -> String {
    func ensureWanted() throws {
        guard !Task.isCancelled, isWanted() else { throw CancellationError() }
    }
    let status = try await speech.speechStatus()
    try ensureWanted()
    guard status.engine.ready else {
        throw NSError(
            domain: "AidenVoiceInput",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: status.engine.error ?? String(localized: "The computer’s speech engine is unavailable.")]
        )
    }
    guard let model = status.models.first(where: { $0.id == status.selectedModelId && $0.installed })
        ?? status.models.first(where: { $0.installed && $0.recommended })
        ?? status.models.first(where: { $0.installed }) else {
        throw NSError(
            domain: "AidenVoiceInput",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: String(localized: "Download a computer speech model in App settings before using this option.")]
        )
    }
    if status.selectedModelId != model.id { _ = try await speech.selectSpeechModel(model.id) }
    try ensureWanted()
    let result = try await speech.transcribeSpeech(pcm16: pcm16, modelId: model.id)
    try ensureWanted()
    return result.text
}

/// Holds the words that get saved. A chat's model and a Bot's are each one, so
/// its `draft` stays the only copy: restoring, persisting and clearing after
/// Send all happen there.
@MainActor
protocol AidenComposerDraftOwner: AnyObject {
    var draft: String { get set }
    func transcribeMacSpeech(_ pcm16: Data) async throws -> String
}

/// Holds the attachments staged for the next message, and the work preparing more.
@MainActor
protocol AidenComposerAttachmentOwner: AnyObject {
    var pendingAttachments: [AidenAttachmentReference] { get }
    var isPreparingAttachments: Bool { get }
    func cancelAttachmentPreparation()
}

/// An ask for a composer's keyboard. Each ask has its own `id`, so asking twice
/// in a row still reaches the field.
struct AidenComposerKeyboardRequest: Equatable {
    let id: Int
    let raises: Bool
}

/// What the person is doing in a composer, kept apart from the view that shows
/// it. The conversation's detail view owns this, so a question card replacing
/// the composer leaves dictation and attachment preparation running.
///
/// Words and attachments live with their owners when the conversation has them,
/// and in the session when it doesn't. A session never holds a second copy.
@MainActor
@Observable
final class AidenComposerSession {
    var attachmentOwner: (any AidenComposerAttachmentOwner)?
    /// A Bot's screen is there before its model is, so this can arrive late.
    var draftOwner: (any AidenComposerDraftOwner)?
    @ObservationIgnored private let voice: any AidenComposerVoiceCapture
    private var localText: String
    private let localAttachments: [AidenAttachmentReference]

    init(
        text: String = "",
        attachments: [AidenAttachmentReference] = [],
        draftOwner: (any AidenComposerDraftOwner)? = nil,
        attachmentOwner: (any AidenComposerAttachmentOwner)? = nil,
        voice: (any AidenComposerVoiceCapture)? = nil
    ) {
        localText = text
        localAttachments = attachments
        self.draftOwner = draftOwner
        self.attachmentOwner = attachmentOwner
        self.voice = voice ?? ComposerVoiceInputController()
    }

    var text: String {
        get { draftOwner?.draft ?? localText }
        set {
            if let draftOwner {
                draftOwner.draft = newValue
            } else {
                localText = newValue
            }
        }
    }

    var attachments: [AidenAttachmentReference] {
        attachmentOwner?.pendingAttachments ?? localAttachments
    }

    /// The latest ask to raise or put away this composer's keyboard. The
    /// composer's own field carries it out (`AidenComposerFieldReach`), so an
    /// ask from a chat that isn't showing touches only that chat's field, never
    /// a keyboard somewhere else.
    private(set) var keyboardRequest: AidenComposerKeyboardRequest?

    func raiseKeyboard() { askForKeyboard(raised: true) }

    func putAwayKeyboard() { askForKeyboard(raised: false) }

    private func askForKeyboard(raised: Bool) {
        keyboardRequest = AidenComposerKeyboardRequest(id: (keyboardRequest?.id ?? 0) + 1, raises: raised)
    }

    /// Words or attachments: either is a message.
    var hasContent: Bool {
        !attachments.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// True while leaving would lose attachments: only the words are saved with a chat.
    var holdsAttachments: Bool { !attachments.isEmpty || isPreparingAttachments }

    var isRecording: Bool { voice.isListening }
    /// Also true while asking for the mic and while finishing a transcript.
    var isVoiceBusy: Bool { voice.isBusy }
    var voiceErrorMessage: String? { voice.errorMessage }
    var isPreparingAttachments: Bool { attachmentOwner?.isPreparingAttachments ?? false }

    /// The mic control: starts dictating into `text`, or ends the recording and
    /// keeps what was said.
    func toggleVoice() async {
        let transcribe = draftOwner?.transcribeMacSpeech
        await voice.toggle(
            currentDraft: text,
            updateDraft: { [weak self] in self?.text = $0 },
            macTranscriber: { pcm16 in
                guard let transcribe else { throw CancellationError() }
                return try await transcribe(pcm16)
            }
        )
    }

    /// Ends the recording now and ignores anything still on its way, so a late
    /// transcript can't land in a draft that was sent or left.
    func stopVoice() {
        voice.cancelDiscardingRecording()
    }

    /// Drops attachments still being prepared. Those already staged stay, ready
    /// for when the person comes back.
    func discardAttachments() {
        attachmentOwner?.cancelAttachmentPreparation()
    }
}

extension AidenChatViewModel: AidenComposerDraftOwner, AidenComposerAttachmentOwner {}
extension AidenBotSessionModel: AidenComposerDraftOwner, AidenComposerAttachmentOwner {}
