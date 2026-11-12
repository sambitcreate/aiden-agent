import SwiftUI
import UIKit

struct AidenLiveResponseView: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Bindable var model: AidenChatViewModel
    let presentationStyle: AidenChatPresentationStyle

    /// Plays a browser recording while the Mac serves them (revision 46).
    private var liveRecordingLoader: ((AidenBrowserRecordingRecap) async -> AidenBrowserRecordingLoad)? {
        guard model.supportsBrowserRecordings else { return nil }
        let model = model
        return { recording in await model.browserRecording(recording) }
    }

    private var botReply: AidenBotReplyProjection? {
        guard presentationStyle == .botMessages else { return nil }
        return AidenBotReplyProjection.resolve(
            text: model.liveText,
            timeline: model.activityTimeline,
            isActive: model.isStreaming
        )
    }

    private var reasoningActive: Bool {
        guard model.isStreaming else { return false }
        if AidenAgentActivityPresentation.hasActiveThinkingStep(model.activityTimeline) {
            return true
        }
        return model.activityTimeline == nil && model.liveText.isEmpty
    }

    private var visibleActivitySteps: [AidenAgentStep] {
        guard let timeline = model.activityTimeline else { return [] }
        return AidenAgentActivityPresentation.activitySteps(
            timeline,
            reasoningVisible: !model.reasoning.isEmpty
        )
    }

    private var visualizingLabel: String? {
        guard model.isLiveReplyUnsettled else { return nil }
        return AidenAgentActivityPresentation.visualizingLabel(model.activityTimeline)
    }

    private var chronologicalRows: [AidenChronologicalRow]? {
        guard presentationStyle != .botMessages else { return nil }
        return AidenChronologicalProjection.rows(
            text: model.liveText,
            reasoning: model.reasoning,
            timeline: model.activityTimeline,
            imageSlots: imageGenerationItems.map(\.id)
        )
    }

    /// The live reply's image placeholders; each sits beneath its step when the
    /// transcript is chronological, like the image it becomes.
    private var imageGenerationItems: [AidenImageGenerationPlaceholderItem] {
        guard model.isLiveReplyUnsettled else { return [] }
        return AidenImageGenerationPlaceholderState.items(model.activityTimeline)
    }

    private var activity: (label: String, mark: AidenActivityMarkKind) {
        AidenActivityMarkKind.liveResponse(
            streamState: model.streamState,
            runningToolName: model.tools.last(where: { $0.status == nil })?.name,
            hasLiveText: !model.liveText.isEmpty
        )
    }

    var body: some View {
        // Each projection walks the whole live transcript, so evaluate them
        // once per render rather than once per reference.
        let botReply = botReply
        let chronologicalRows = chronologicalRows
        let visibleText = botReply?.finalText ?? model.liveText
        let visibleActivitySteps = chronologicalRows == nil ? visibleActivitySteps : []
        // Laid out like a settled message: content, then, while the run goes
        // on, a "Working for" row at the footer's height. A settled message
        // hides its footer until tapped, so the row folds away when the run
        // ends and the hand-off to the settled reply doesn't move it.
        VStack(alignment: .leading, spacing: 2) {
            content(
                botReply: botReply,
                chronologicalRows: chronologicalRows,
                visibleText: visibleText,
                visibleActivitySteps: visibleActivitySteps
            )
            if model.isStreaming {
                liveFooter
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // A short fold the bottom scroll anchor follows, so a reader at the
        // latest message stays there and nobody sees a blank row go.
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: model.isStreaming)
    }

    /// "Working for" sits where the settled footer would, at the footer's height.
    private var liveFooter: some View {
        HStack(spacing: 0) {
            if let start = AidenTurnElapsed.liveStart(
                   timeline: model.activityTimeline,
                   messages: model.chat.messages
               ) {
                AidenLiveElapsedLabel(start: start)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: AidenMessageFooter.minimumHeight)
    }

    @ViewBuilder
    private func content(
        botReply: AidenBotReplyProjection?,
        chronologicalRows: [AidenChronologicalRow]?,
        visibleText: String,
        visibleActivitySteps: [AidenAgentStep]
    ) -> some View {
        // The settled message's spacing, so rows don't shift when it settles.
        VStack(alignment: .leading, spacing: 10) {
            if model.isStreaming && model.isWaitingForNetwork {
                HStack(spacing: 8) {
                    Image(systemName: "wifi.slash")
                        .accessibilityHidden(true)
                    Text("Waiting for network")
                }
                .font(.callout)
                .foregroundStyle(palette.secondary)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Aiden is waiting for the network to return")
                .transition(.opacity)
            } else if chronologicalRows == nil && model.isStreaming && model.reasoning.isEmpty && model.activityTimeline?.steps.isEmpty != false {
                let activity = activity
                HStack(spacing: 8) {
                    AidenActivityMark(mark: activity.mark, size: 20, color: palette.foreground)
                    Text(activity.label)
                        .foregroundStyle(palette.secondary)
                }
                .font(.callout)
                .accessibilityElement(children: .combine)
                .transition(.opacity)
            }

            if chronologicalRows == nil && !model.reasoning.isEmpty {
                AidenReasoningCard(
                    text: model.reasoning,
                    label: AidenAgentActivityPresentation.reasoningLabel(
                        model.activityTimeline,
                        active: reasoningActive
                    ),
                    active: reasoningActive
                )
                    .transition(.opacity)
            }

            if chronologicalRows == nil, let timeline = model.activityTimeline, !visibleActivitySteps.isEmpty {
                AidenActivityFeed(
                    timeline: timeline,
                    active: model.isStreaming,
                    progressText: botReply?.progressText,
                    showsRunningRowsWhenCollapsed: presentationStyle != .botMessages,
                    steps: visibleActivitySteps
                )
                    .transition(.opacity)
            } else if chronologicalRows == nil && AidenAgentActivityPresentation.showsLiveToolRows(
                model.tools,
                timeline: model.activityTimeline,
                reasoningVisible: !model.reasoning.isEmpty
            ) {
                AidenToolActivityCard(tools: model.tools)
            }

            if chronologicalRows == nil {
                ForEach(AidenAgentActivityPresentation.questionnaireSteps(model.activityTimeline)) { step in
                    if let recap = step.questionnaire {
                        AidenQuestionnaireRecapView(recap: recap)
                    }
                }
                ForEach(AidenAgentActivityPresentation.extractionSteps(model.activityTimeline)) { step in
                    if let recap = step.extraction {
                        AidenWebExtractRecapView(recap: recap)
                    }
                }
                ForEach(AidenAgentActivityPresentation.recordingSteps(model.activityTimeline)) { step in
                    if let recording = step.recording {
                        AidenBrowserRecordingCardView(recording: recording, load: liveRecordingLoader)
                    }
                }
            }

            if let chronologicalRows {
                AidenChronologicalTranscript(
                    rows: chronologicalRows,
                    active: model.isLiveReplyUnsettled,
                    stoppedStepIDs: model.activityTimeline?.userStoppedStepIDs ?? [],
                    loadRecording: liveRecordingLoader,
                    imageSlotContent: { call in
                        AnyView(ForEach(imageGenerationItems.filter { $0.id == call }) { item in
                            AidenImageGenerationPlaceholderView(item: item)
                                .transition(.opacity)
                        })
                    },
                    groupScope: model.activityTimeline?.generationId ?? ""
                )
                    .contextMenu {
                        if !visibleText.isEmpty {
                            Button {
                                UIPasteboard.general.string = visibleText
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                        }
                    }
                    .accessibilityActions {
                        if !visibleText.isEmpty {
                            Button("Copy response") {
                                UIPasteboard.general.string = visibleText
                            }
                        }
                    }
            }

            let placedSlots = chronologicalRows.map(AidenChronologicalProjection.placedImageSlots) ?? []
            ForEach(imageGenerationItems.filter { !placedSlots.contains($0.id) }) { item in
                AidenImageGenerationPlaceholderView(item: item)
                    .transition(.opacity)
            }

            if let visualizingLabel,
               !(chronologicalRows?.contains(where: { row in
                   row.kind == .tool && row.steps.contains(where: { $0.toolName == "render_artifact" && $0.isActive })
               }) ?? false) {
                AidenActivityPhaseCard(label: visualizingLabel)
                    .transition(.opacity)
            }

            if let approval = model.pendingApproval {
                AidenApprovalCard(
                    summary: approval.summary,
                    toolName: approval.toolName,
                    kind: approval.kind,
                    canRespond: approval.canRespond,
                    hasRequiredWriteCapability: approval.hasRequiredWriteCapability,
                    canAllow: approval.canAllow,
                    scopes: approval.scopes,
                    schedule: approval.schedule,
                    onDeny: { Task { await model.respondToApproval(.deny, approvalID: approval.id) } },
                    onAllow: { scope in
                        Task { await model.respondToApproval(.allow, approvalID: approval.id, scope: scope) }
                    }
                )
                .disabled(!model.isConnected || model.isReadOnlyPresentation || model.isRespondingToApproval || model.isStopping)
                .id(approval.id)
            }

            if chronologicalRows == nil && !visibleText.isEmpty {
                AidenMarkdownView(content: visibleText, isStreaming: model.isLiveReplyUnsettled)
                    .padding(presentationStyle == .botMessages ? 12 : 0)
                    .background {
                        if presentationStyle == .botMessages {
                            AidenBotMessageBubbleShape()
                            .fill(Color(uiColor: .secondarySystemFill))
                        }
                    }
                    .frame(
                        maxWidth: presentationStyle == .botMessages ? 620 : .infinity,
                        alignment: .leading
                    )
                    .contextMenu {
                        Button {
                            UIPasteboard.general.string = visibleText
                        } label: {
                            Label("Copy", systemImage: "doc.on.doc")
                        }
                    }
                    .accessibilityActions {
                        Button("Copy response") {
                            UIPasteboard.general.string = visibleText
                        }
                    }
            }
        }
    }
}
