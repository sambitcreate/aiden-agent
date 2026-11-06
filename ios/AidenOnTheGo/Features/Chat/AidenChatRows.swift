import SwiftUI
import UIKit

/// One settled transcript row: the ID its view is keyed by, and where its
/// message sits in the chat.
struct AidenTranscriptRowIdentity: Identifiable, Equatable {
    let id: String
    let index: Int

    /// Rows keyed by `renderIDs[message.id] ?? message.id`. A render ID that
    /// another message already uses is ignored, so row IDs stay unique.
    static func rows(for messages: [AidenChatMessage], renderIDs: [String: String]) -> [Self] {
        guard !renderIDs.isEmpty else {
            return messages.indices.map { Self(id: messages[$0].id, index: $0) }
        }
        var used = Set(messages.map(\.id))
        return messages.indices.map { index in
            let messageID = messages[index].id
            guard let alias = renderIDs[messageID], alias != messageID, !used.contains(alias) else {
                return Self(id: messageID, index: index)
            }
            used.insert(alias)
            return Self(id: alias, index: index)
        }
    }
}

struct AidenSettledMessageRows: View, Equatable {
    let model: AidenChatViewModel
    let chat: AidenChat
    let presentationStyle: AidenChatPresentationStyle
    /// Value snapshots of the Read Aloud state the rows render, so a playback
    /// change re-evaluates the rows even though `model` compares equal.
    let readAloudCandidateID: String?
    let readAloudActiveID: String?
    /// `AidenChatViewModel.messageRenderIDs`: rows keep the identity they
    /// were first drawn with when the Mac assigns a message its ID.
    var renderIDs: [String: String] = [:]
    /// Generations whose settled image plays the arrival reveal.
    var imageArrivalRevealIDs: Set<String> = []
    var appControlsAvailable = false
    /// Quotes a selection into the composer; nil while the chat is read-only.
    /// Closure identity is excluded from equality like the stable `model`.
    var onAskAbout: ((String) -> Void)? = nil
    /// Nil hides every fork action (no `chat-fork-v1`, read-only, or busy).
    var forkAvailability: AidenChatForkAvailability? = nil
    var onFork: ((String, AidenChatForkMenuAction) -> Void)? = nil
    /// Value snapshots for the fork summary card's actions.
    var canSettleForkSummary = false
    var isSettlingForkSummary = false
    /// The Mac announces `chat-visual-viewer-v1` (revision 35).
    var visualViewerAvailable = false
    /// Adds a follow-up confirmed in the visual viewer to the composer.
    var onVisualPrompt: ((String) -> Void)? = nil
    /// The Mac announces `chat-browser-recordings-v1` (revision 46).
    var browserRecordingsAvailable = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        (lhs.onAskAbout == nil) == (rhs.onAskAbout == nil) &&
        lhs.visualViewerAvailable == rhs.visualViewerAvailable &&
        lhs.browserRecordingsAvailable == rhs.browserRecordingsAvailable &&
        (lhs.onVisualPrompt == nil) == (rhs.onVisualPrompt == nil) &&
        (lhs.onFork == nil) == (rhs.onFork == nil) &&
        lhs.forkAvailability == rhs.forkAvailability &&
        lhs.canSettleForkSummary == rhs.canSettleForkSummary &&
        lhs.isSettlingForkSummary == rhs.isSettlingForkSummary &&
        // `model` is a shared reference (same pointer on both sides of every
        // comparison), so equality must cover the value-typed snapshots the
        // body renders — `chat`, the Read Aloud state — and the presentation style.
        lhs.chat == rhs.chat && lhs.presentationStyle == rhs.presentationStyle &&
            lhs.readAloudCandidateID == rhs.readAloudCandidateID &&
            lhs.readAloudActiveID == rhs.readAloudActiveID &&
            lhs.renderIDs == rhs.renderIDs &&
            lhs.imageArrivalRevealIDs == rhs.imageArrivalRevealIDs &&
            lhs.appControlsAvailable == rhs.appControlsAvailable
    }

    var body: some View {
        let forkActions = forkAvailability.map {
            AidenChatForkEligibility.actions(for: chat.messages, supportsSummary: $0.supportsSummary)
        } ?? [:]
        let forkSummary = chat.forkedFrom?.summary
        ForEach(AidenTranscriptRowIdentity.rows(for: chat.messages, renderIDs: renderIDs)) { row in
            let index = row.index
            let message = chat.messages[index]
            messageRow(message, at: index, forkActions: forkActions[message.id] ?? [])
            // The summary sits in model context right after the last copied message.
            if let forkSummary, forkSummary.afterMessageId == message.id {
                forkSummaryCard(forkSummary)
            }
        }
    }

    private func forkSummaryCard(_ summary: AidenChatForkSummary) -> some View {
        AidenForkSummaryCard(
            summary: summary,
            isBusy: isSettlingForkSummary,
            onCancel: canSettleForkSummary ? { Task { await model.cancelForkSummary() } } : nil,
            onRetry: canSettleForkSummary ? { Task { await model.retryForkSummary() } } : nil,
            onSkip: canSettleForkSummary ? { Task { await model.skipForkSummary() } } : nil
        )
    }

    private func messageRow(
        _ message: AidenChatMessage,
        at index: Int,
        forkActions: [AidenChatForkMenuAction]
    ) -> some View {
        let previous = index > 0 ? chat.messages[index - 1] : nil
        let isBotMessage = presentationStyle == .botMessages
        let topPadding: CGFloat = isBotMessage && !aidenMessagesJoin(previous, message) ? 9 : 0
        let next = index + 1 < chat.messages.count ? chat.messages[index + 1] : nil
        // Bot bubbles join into clusters; only the cluster's last bubble
        // carries the footer so the Messages rhythm stays compact.
        let showsFooter = !isBotMessage || next.map { !aidenMessagesJoin(message, $0) } ?? true
        let revealGenerationID = message.timeline.map(\.generationId).flatMap {
            imageArrivalRevealIDs.contains($0) ? $0 : nil
        }
        let revealAttachmentID = revealGenerationID.flatMap { _ in
            AidenImageGenerationPlaceholderState.arrivalRevealAttachmentID(in: message)
        }

        return AidenMessageView(
            message: message,
            presentationStyle: presentationStyle,
            loadAttachmentImage: { attachment in
                await model.attachmentImageData(for: attachment)
            },
            readAloudAction: readAloudCandidateID == message.id ? { model.toggleReadAloud(message.id) } : nil,
            readAloudActive: readAloudActiveID == message.id,
            showsFooter: showsFooter,
            onAskAbout: onAskAbout,
            forkActions: onFork == nil ? [] : forkActions,
            onFork: onFork.map { handler in { (action: AidenChatForkMenuAction) in handler(message.id, action) } },
            imageArrivalRevealAttachmentID: revealAttachmentID,
            onImageArrivalRevealed: revealGenerationID.map { generationID in
                { model.finishImageArrivalReveal(generationID: generationID) }
            },
            appControlsAvailable: appControlsAvailable,
            appControlsCache: model.appControlsCache,
            loadAppControls: { try await model.loadAppControls($0) },
            applyAppControl: { try await model.applyAppControl($0, operation: $1) },
            loadVisualDocument: visualViewerAvailable
                ? { (visualID: String, appearance: AidenVisualViewerAppearance) async -> AidenVisualDocumentLoad in
                    await model.visualDocument(visualId: visualID, appearance: appearance)
                }
                : nil,
            onVisualPrompt: onVisualPrompt,
            loadBrowserRecording: browserRecordingsAvailable
                ? { (recording: AidenBrowserRecordingRecap) async -> AidenBrowserRecordingLoad in
                    await model.browserRecording(recording)
                }
                : nil
        )
        .equatable()
        .padding(.top, topPadding)
    }
}

struct AidenMessageView: View, Equatable {
    @Environment(\.aidenPalette) private var palette
    let message: AidenChatMessage
    let presentationStyle: AidenChatPresentationStyle
    let loadAttachmentImage: (AidenMessageAttachment) async -> Data?
    var readAloudAction: (() -> Void)? = nil
    var readAloudActive = false
    var showsFooter = true
    var onAskAbout: ((String) -> Void)? = nil
    var forkActions: [AidenChatForkMenuAction] = []
    var onFork: ((AidenChatForkMenuAction) -> Void)? = nil
    /// The generated image that plays the one-shot arrival reveal, if any.
    var imageArrivalRevealAttachmentID: String? = nil
    var onImageArrivalRevealed: (() -> Void)? = nil
    var appControlsAvailable = false
    var appControlsCache: AidenAppControlCache? = nil
    var loadAppControls: ((AidenAppControlPanel) async throws -> AidenAppControlSnapshot)? = nil
    var applyAppControl: ((AidenAppControlPanel, AidenAppControlOperation) async throws -> AidenAppControlReceipt)? = nil
    /// Present while the Mac announces `chat-visual-viewer-v1` (revision 35).
    var loadVisualDocument: ((String, AidenVisualViewerAppearance) async -> AidenVisualDocumentLoad)? = nil
    var onVisualPrompt: ((String) -> Void)? = nil
    /// Present while the Mac announces `chat-browser-recordings-v1` (revision 46).
    var loadBrowserRecording: ((AidenBrowserRecordingRecap) async -> AidenBrowserRecordingLoad)? = nil
    @State private var selectTextRequest: AidenSelectTextRequest?

    static func == (lhs: Self, rhs: Self) -> Bool {
        // The loader closure captures the stable view-model; identity churn on
        // it must not force settled rows to re-render on every streamed token.
        // The Read Aloud and Ask actions are compared by presence for the same reason.
        lhs.message == rhs.message && lhs.presentationStyle == rhs.presentationStyle &&
            (lhs.readAloudAction == nil) == (rhs.readAloudAction == nil) &&
            lhs.readAloudActive == rhs.readAloudActive &&
            lhs.showsFooter == rhs.showsFooter &&
            (lhs.onAskAbout == nil) == (rhs.onAskAbout == nil) &&
            lhs.forkActions == rhs.forkActions &&
            (lhs.onFork == nil) == (rhs.onFork == nil) &&
            lhs.imageArrivalRevealAttachmentID == rhs.imageArrivalRevealAttachmentID &&
            lhs.appControlsAvailable == rhs.appControlsAvailable &&
            (lhs.loadVisualDocument == nil) == (rhs.loadVisualDocument == nil) &&
            (lhs.onVisualPrompt == nil) == (rhs.onVisualPrompt == nil) &&
            (lhs.loadBrowserRecording == nil) == (rhs.loadBrowserRecording == nil)
    }

    private var selectableText: String {
        AidenSelectionQuote.selectableText(for: message, visibleText: visibleText)
    }

    private var botReply: AidenBotReplyProjection? {
        guard presentationStyle == .botMessages, message.role == .assistant else { return nil }
        return AidenBotReplyProjection.resolve(
            text: message.text,
            timeline: message.timeline,
            isActive: false
        )
    }

    private var visibleText: String {
        botReply?.finalText ?? message.text
    }

    var body: some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 2) {
            messageBody
            if showsFooter {
                AidenMessageFooter(
                    message: message,
                    copyText: AidenMessageActionContent.copyText(for: message, presentationStyle: presentationStyle),
                    readAloudAction: readAloudAction,
                    readAloudActive: readAloudActive
                )
            }
        }
        .sheet(item: $selectTextRequest) { request in
            AidenSelectTextSheet(text: request.text, onAskAbout: onAskAbout)
        }
    }

    private var messageBody: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if message.role == .user {
                Spacer(minLength: presentationStyle == .botMessages ? 72 : 48)
                messageContent
            } else {
                messageContent
                    .frame(
                        maxWidth: presentationStyle == .botMessages ? 620 : .infinity,
                        alignment: .leading
                    )
                    .layoutPriority(1)
                if presentationStyle == .botMessages {
                    Spacer(minLength: 72)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .contextMenu {
            if let copyText = AidenMessageActionContent.copyText(
                for: message,
                presentationStyle: presentationStyle
            ) {
                Button {
                    UIPasteboard.general.string = copyText
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                Button {
                    selectTextRequest = AidenSelectTextRequest(text: selectableText)
                } label: {
                    Label("Select Text", systemImage: "selection.pin.in.out")
                }
                if let onAskAbout {
                    Button {
                        onAskAbout(selectableText)
                    } label: {
                        Label("Ask About This", systemImage: "text.bubble")
                    }
                }
            }
            if let onFork, !forkActions.isEmpty {
                Divider()
                ForEach(forkActions, id: \.self) { action in
                    Button {
                        onFork(action)
                    } label: {
                        Label(action.menuTitle, systemImage: action.systemImage)
                    }
                }
            }
        }
        .accessibilityActions {
            if let copyText = AidenMessageActionContent.copyText(
                for: message,
                presentationStyle: presentationStyle
            ) {
                Button(message.role == .user ? "Copy message" : "Copy response") {
                    UIPasteboard.general.string = copyText
                }
                Button("Select text") {
                    selectTextRequest = AidenSelectTextRequest(text: selectableText)
                }
                if let onAskAbout {
                    Button("Ask about this") {
                        onAskAbout(selectableText)
                    }
                }
            }
            if let onFork {
                ForEach(forkActions, id: \.self) { action in
                    Button(action.accessibilityTitle) { onFork(action) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(message.role == .user ? "You" : "Aiden")

    }

    /// A committed assistant reply's rows in the order they happened, with each
    /// visual and image beneath the step that made it; nil without a usable timeline.
    private var messageChronologicalRows: [AidenChronologicalRow]? {
        guard message.role == .assistant, presentationStyle != .botMessages else { return nil }
        return AidenChronologicalProjection.rows(
            text: message.text,
            reasoning: message.reasoning ?? "",
            timeline: message.timeline,
            visuals: AidenChatVisualPresentation.rowVisuals(in: message),
            images: AidenImageGenerationPlaceholderState.stripImageAttachments(for: message)
        )
    }

    private var messageContent: some View {
        VStack(
            alignment: message.role == .user ? .trailing : .leading,
            spacing: 10
        ) {
            if let rows = messageChronologicalRows {
                AidenChronologicalTranscript(
                    rows: rows,
                    active: false,
                    visualContent: { visual in AnyView(visualRow(visual)) },
                    loadRecording: loadBrowserRecording,
                    imageContent: { images in
                        AnyView(AidenMessageImageAttachmentsView(
                            attachments: images,
                            edge: AidenMessageMediaEdge.forRole(message.role),
                            loadData: loadAttachmentImage,
                            revealAttachmentID: imageArrivalRevealAttachmentID,
                            onArrivalRevealed: onImageArrivalRevealed
                        ))
                    },
                    groupScope: message.timeline?.generationId ?? message.id
                )
            } else {
            if message.role == .assistant, let reasoning = message.reasoning, !reasoning.isEmpty {
                AidenReasoningCard(text: reasoning, label: "Thought", active: false)
            }
            if message.role == .assistant, let timeline = message.timeline {
                let activitySteps = timeline.steps.filter { !$0.isQuestionnaire }
                if !activitySteps.isEmpty {
                    AidenActivityFeed(
                        timeline: timeline,
                        active: false,
                        progressText: botReply?.progressText,
                        showsRunningRowsWhenCollapsed: presentationStyle != .botMessages,
                        steps: activitySteps
                    )
                }
                ForEach(AidenAgentActivityPresentation.questionnaireSteps(timeline)) { step in
                    if let recap = step.questionnaire {
                        AidenQuestionnaireRecapView(recap: recap)
                    }
                }
                ForEach(AidenAgentActivityPresentation.extractionSteps(timeline)) { step in
                    if let recap = step.extraction {
                        AidenWebExtractRecapView(recap: recap)
                    }
                }
                ForEach(AidenAgentActivityPresentation.recordingSteps(timeline)) { step in
                    if let recording = step.recording {
                        AidenBrowserRecordingCardView(recording: recording, load: loadBrowserRecording)
                    }
                }
            }
            if !visibleText.isEmpty {
                messageText
            }
            // Without a chronological timeline, visuals follow the reply text.
            if message.role == .assistant {
                ForEach(AidenChatVisualPresentation.rowVisuals(in: message)) { visual in
                    visualRow(visual)
                }
            }
            }
            // Snapshots appear once, inline at their visual, never in the strip,
            // and images drawn beneath their step leave it too.
            let attachments = AidenChatVisualPresentation.stripAttachments(for: message)
            if !attachments.isEmpty {
                let imageAttachments = AidenImageGenerationPlaceholderState.stripImageAttachments(for: message)
                let placedImageIDs = messageChronologicalRows.map(AidenChronologicalProjection.placedImageIDs) ?? []
                let trailingImages = imageAttachments.filter { !placedImageIDs.contains($0.id) }
                if !trailingImages.isEmpty {
                    AidenMessageImageAttachmentsView(
                        attachments: trailingImages,
                        edge: AidenMessageMediaEdge.forRole(message.role),
                        loadData: loadAttachmentImage,
                        revealAttachmentID: imageArrivalRevealAttachmentID,
                        onArrivalRevealed: onImageArrivalRevealed
                    )
                }
                let fallbackAttachments = attachments.filter { attachment in
                    !imageAttachments.contains(where: { $0.id == attachment.id })
                }
                ForEach(fallbackAttachments.indices, id: \.self) { index in
                    let attachment = fallbackAttachments[index]
                    Label {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(attachment.name).lineLimit(1)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                                .foregroundStyle(palette.secondary)
                        }
                    } icon: {
                        Image(systemName: attachment.kind == .image ? "photo.badge.exclamationmark" : "doc.text")
                    }
                    .font(.caption)
                    .padding(AidenMessageContentSurface.usesRaisedBubble(
                        role: message.role,
                        content: .fallbackAttachment
                    ) ? 10 : 0)
                    .background(
                        AidenMessageContentSurface.usesRaisedBubble(
                            role: message.role,
                            content: .fallbackAttachment
                        ) ? palette.raised : Color.clear,
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                    )
                    .accessibilityElement(children: .combine)
                }
            }
            if message.role == .assistant, let panels = message.appPanels {
                ForEach(panels) { panel in
                    AidenNativeAppControlPanel(panel: panel, available: appControlsAvailable, cache: appControlsCache, load: loadAppControls, apply: applyAppControl)
                }
            }
            if message.role == .assistant {
                // A visual's snapshot replaces the card for the artifact it shows.
                ForEach(AidenChatVisualPresentation.unviewableHtmlArtifacts(in: message), id: \.id) { artifact in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(artifact.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        Text("Can't view on this device. View in Aiden Agent.")
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(artifact.title). Can't view on this device. View in Aiden Agent.")
                }
            }
            if message.role == .assistant, let outcome = message.outcome {
                AidenMessageOutcomeView(outcome: outcome)
            }
        }
    }

    private func visualRow(_ visual: AidenChatVisual) -> some View {
        AidenVisualRowView(
            visual: visual,
            snapshot: AidenChatVisualPresentation.snapshotAttachment(for: visual, in: message),
            loadData: loadAttachmentImage,
            loadDocument: loadVisualDocument.map { load in
                { (appearance: AidenVisualViewerAppearance) async -> AidenVisualDocumentLoad in
                    await load(visual.id, appearance)
                }
            },
            onAddToMessage: onVisualPrompt
        )
    }

    private var messageText: some View {
        let usesWorkspaceBubble = AidenMessageContentSurface.usesRaisedBubble(
            role: message.role,
            content: .text
        )
        let usesBotBubble = presentationStyle == .botMessages
        return AidenMessageTextView(role: message.role, content: visibleText)
            .foregroundStyle(
                usesBotBubble && message.role == .user
                    ? palette.onFillAccent
                    : palette.foreground
            )
            .padding(usesWorkspaceBubble || usesBotBubble ? 12 : 0)
            .background {
                if usesBotBubble {
                    AidenBotMessageBubbleShape()
                    .fill(
                        message.role == .user
                            ? palette.fillAccent
                            : Color(uiColor: .secondarySystemFill)
                    )
                } else if usesWorkspaceBubble {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(palette.raised)
                }
            }
    }
}

struct AidenMessageOutcomePresentation: Equatable {
    let title: String
    let detail: String?
    let symbol: String
    let isFailure: Bool

    static func make(_ outcome: AidenMessageOutcome) -> Self {
        guard outcome.status == .failed else {
            return Self(title: "Response cancelled", detail: nil, symbol: "stop.circle", isFailure: false)
        }
        let detail: String
        switch outcome.category {
        case "network":
            detail = "Aiden could not reach the model provider."
        case "timeout":
            detail = "The model provider took too long to respond."
        case "service_unavailable":
            detail = "The model provider is temporarily unavailable."
        case "rate_limit":
            detail = "The model provider is receiving too many requests. Try again shortly."
        case "authentication":
            detail = "The model provider rejected its credentials. Check Provider Settings on your desktop."
        case "quota":
            detail = "The model provider account has no available quota."
        case "invalid_request":
            detail = "The model provider could not accept this request. For a Bot, change its model in Edit Bot; for a Workspace chat, use the composer."
        case "context_window":
            detail = "This conversation is too large for the selected model."
        case "output_limit":
            detail = "The model reached its response limit before it could finish."
        case "interrupted":
            detail = "The response was interrupted before it could finish."
        case "context_management":
            detail = "Aiden could not prepare this conversation for the selected model."
        default:
            detail = "The model provider could not complete this response."
        }
        return Self(title: "Generation failed", detail: detail, symbol: "exclamationmark.triangle", isFailure: true)
    }
}

private struct AidenMessageOutcomeView: View {
    @Environment(\.aidenPalette) private var palette
    let outcome: AidenMessageOutcome

    var body: some View {
        let presentation = AidenMessageOutcomePresentation.make(outcome)
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: presentation.symbol)
                .foregroundStyle(presentation.isFailure ? Color.red : palette.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(presentation.title).fontWeight(.semibold)
                if let detail = presentation.detail {
                    Text(detail).foregroundStyle(palette.secondary)
                }
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(
            presentation.isFailure ? Color.red.opacity(0.08) : palette.raised,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }
}
