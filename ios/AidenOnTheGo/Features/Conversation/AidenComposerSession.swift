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

/// Holds the words that get saved. A chat's model is one, so its `draft` stays
/// the only copy: restoring, persisting and clearing after Send all happen there.
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
    private let draftOwner: (any AidenComposerDraftOwner)?
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

    /// Words or attachments: either is a message.
    var hasContent: Bool {
        !attachments.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

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
extension AidenBotSessionModel: AidenComposerAttachmentOwner {}
