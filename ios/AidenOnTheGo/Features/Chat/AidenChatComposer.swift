import SwiftUI

/// Shared by the message and question composers so cancellation remains reachable.
struct AidenChatStopButton: View {
    @Environment(\.aidenPalette) private var palette
    @Bindable var model: AidenChatViewModel

    var canStop: Bool { model.canControlCurrentRun && !model.isStopping }

    @discardableResult
    func stop() async -> Bool { await model.stop() }

    var body: some View {
        if model.isStreaming {
            Button { Task { await stop() } } label: {
                Image(systemName: "stop.fill")
                    .frame(width: 30, height: 30)
                    .background(palette.foreground, in: Circle())
                    .foregroundStyle(palette.canvas)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .disabled(!canStop)
            .accessibilityLabel(model.isStopping ? "Stopping response" : "Stop response")
        }
    }
}

struct AidenComposerView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var model: AidenChatViewModel
    let autoStartVoice: Bool
    let composerFocus: FocusState<Bool>.Binding
    @Bindable var attachmentPicker: AidenAttachmentPickerState
    let motionNamespace: Namespace.ID
    let canToggleAttachments: Bool
    let onToggleAttachmentPicker: () -> Void
    var placeholder = "Message Aiden"
    @State private var voiceInput = ComposerVoiceInputController()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let progress = model.uploadProgress {
                AidenUploadProgressRow(progress: progress, onCancel: model.cancelUploads)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            if !visiblePendingAttachments.isEmpty || !attachmentPicker.committingAssets.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(visiblePendingAttachments) { attachment in
                            AidenPendingAttachmentCard(
                                attachment: attachment,
                                loadImageData: {
                                    await model.pendingAttachmentImageData(for: attachment)
                                },
                                onRemove: {
                                    Task { await model.removeAttachment(attachment) }
                                }
                            )
                            .transition(.opacity.combined(with: .scale(scale: 0.96)))
                        }

                        ForEach(attachmentPicker.committingAssets, id: \.localIdentifier) { asset in
                            AidenCommittingPhotoCard(
                                asset: asset,
                                motionNamespace: motionNamespace
                            )
                        }
                    }
                    .padding(.horizontal, 1)
                }
                .accessibilityLabel("Attachments")
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let selectedSkill = model.selectedSkill {
                HStack(spacing: 6) {
                    Image(systemName: "slash.circle")
                        .font(.caption.weight(.medium))
                    Text("/\(selectedSkill.name)")
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                    Button {
                        model.clearSelectedSkill()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption2.weight(.bold))
                    }
                    .accessibilityLabel("Remove skill \(selectedSkill.name)")
                }
                .foregroundStyle(palette.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(palette.secondary.opacity(0.12), in: Capsule())
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Skill \(selectedSkill.name) selected")
            }

            if !model.composerSuggestions.isEmpty {
                AidenComposerSuggestionList(
                    suggestions: model.composerSuggestions,
                    onSelect: { suggestion in
                        switch suggestion {
                        case .skill(let entry):
                            model.selectSkillSuggestion(entry)
                        case .agent, .file:
                            model.selectMentionSuggestion(suggestion)
                        }
                    }
                )
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            TextField(placeholder, text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 4)
                    .padding(.top, 5)
                    .focused(composerFocus)
                    .disabled(voiceInput.isBusy)
                    .submitLabel(.send)
                    .onSubmit {
                        guard !model.isStreaming else { return }
                        voiceInput.stopBeforeSubmittingDraft()
                        Task { await model.send() }
                    }

                HStack(alignment: .center, spacing: 10) {
                Button(action: onToggleAttachmentPicker) {
                    Image(systemName: "plus")
                        .font(.title3.weight(.medium))
                        .frame(width: 44, height: 44)
                        .rotationEffect(.degrees(attachmentPicker.isPresented ? 45 : 0))
                        .opacity(model.isUploadingAttachment || model.isPreparingAttachments ? 0.48 : 1)
                        .overlay(alignment: .bottomTrailing) {
                            // While the upload bar shows progress, it is the only spinner.
                            if model.uploadProgress == nil, model.isUploadingAttachment || model.isPreparingAttachments {
                                ProgressView()
                                    .controlSize(.mini)
                                    .padding(3)
                                    .background(.regularMaterial, in: Circle())
                            }
                        }
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())
                .disabled(!canToggleAttachments)
                .accessibilityLabel("Add attachment")
                .accessibilityValue(attachmentPicker.isPresented ? "Open" : "Closed")
                .accessibilityHint(model.acceptsImageAttachments
                    ? "Attach an image or bounded text file"
                    : "Attach a bounded text file. This model cannot read images")
                .background {
                    GeometryReader { proxy in
                        let frame = proxy.frame(in: .named(AidenChatAttachmentCoordinateSpace.name))
                        Color.clear.preference(
                            key: AidenAttachmentButtonCenterPreferenceKey.self,
                            value: CGPoint(x: frame.midX, y: frame.midY)
                        )
                    }
                }

                if model.showsComposerModelControl, !model.visibleProviders.isEmpty {
                    Menu {
                        ForEach(model.visibleProviders) { provider in
                            Section {
                                ForEach(provider.models) { candidate in
                                    if let levels = candidate.thinkingLevels, !levels.isEmpty {
                                        Menu {
                                            ForEach(levels, id: \.self) { level in
                                                Button {
                                                    select(
                                                        candidate,
                                                        providerId: provider.id,
                                                        thinkingLevel: level
                                                    )
                                                } label: {
                                                    if isSelected(candidate, providerId: provider.id, thinkingLevel: level) {
                                                        Label(candidate.thinkingLabel(for: level), systemImage: "checkmark")
                                                    } else {
                                                        Text(candidate.thinkingLabel(for: level))
                                                    }
                                                }
                                            }
                                        } label: { Text(candidate.label) }
                                    } else {
                                        Button {
                                            select(candidate, providerId: provider.id, thinkingLevel: nil)
                                        } label: {
                                            if isSelected(candidate, providerId: provider.id, thinkingLevel: nil) {
                                                Label(candidate.label, systemImage: "checkmark")
                                            } else {
                                                Text(candidate.label)
                                            }
                                        }
                                    }
                                }
                            } header: {
                                Label {
                                    Text(provider.label)
                                } icon: {
                                    AidenProviderIcon(
                                        providerID: provider.id,
                                        providerLabel: provider.label,
                                        artwork: provider.artwork,
                                        size: 16,
                                        color: palette.secondary
                                    )
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            if let provider = model.selectedProvider {
                                AidenProviderIcon(
                                    providerID: provider.id,
                                    providerLabel: provider.label,
                                    modelID: model.selectedModel?.id,
                                    artwork: provider.artwork,
                                    size: 15,
                                    color: palette.secondary
                                )
                            }
                            Text(model.selectedModel?.label ?? "Model").lineLimit(1)
                            if let level = model.selectedThinkingLevel,
                               model.selectedModel?.thinkingLevels?.isEmpty == false {
                                Text("· \(level.capitalized)")
                                    .lineLimit(1)
                                    .foregroundStyle(palette.secondary.opacity(0.8))
                            }
                            Image(systemName: "chevron.down").font(.caption2)
                        }
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .frame(maxWidth: 180, alignment: .leading)
                        .frame(minHeight: 44)
                    }
                    .accessibilityLabel("Model")
                    .accessibilityValue(selectedModelAccessibilityValue)
                } else if model.showsComposerModelControl,
                          let selectedModel = model.selectedModel {
                    HStack(spacing: 4) {
                        Text(selectedModel.label).lineLimit(1)
                        Text("· Hidden")
                            .lineLimit(1)
                            .foregroundStyle(palette.secondary.opacity(0.8))
                    }
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
                    .frame(maxWidth: 180, alignment: .leading)
                    .frame(minHeight: 44)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Model")
                    .accessibilityValue("\(selectedModel.label), hidden from picker")
                }

                Spacer(minLength: 0)

                // Dictation is off while a response streams, so the busy
                // Steer/Queue pill takes the mic's place (as on Android); a
                // dictation already running keeps its stop control.
                if !(model.isStreaming && model.showsRunInputOptions) || voiceInput.isListening {
                    Button {
                        Task {
                            guard !model.isReadOnlyPresentation else { return }
                            model.readAloud.stop()
                            await voiceInput.toggle(
                                currentDraft: model.draft,
                                updateDraft: { model.draft = $0 },
                                macTranscriber: model.transcribeMacSpeech
                            )
                        }
                    } label: {
                        Group {
                            if voiceInput.isListening {
                                AidenListeningWaveform(isAnimated: !reduceMotion)
                            } else {
                                Image(systemName: "mic")
                                    .font(.body.weight(.medium))
                            }
                        }
                        .frame(width: 44, height: 44)
                    }
                    .disabled(
                        model.isReadOnlyPresentation || model.isStreaming
                            || (voiceInput.isBusy && !voiceInput.isListening)
                    )
                    .accessibilityLabel(voiceInput.isListening ? "Stop voice input" : "Start voice input")
                }

                if model.isStreaming {
                    if model.showsRunInputOptions {
                        runInputPill
                    }
                    AidenChatStopButton(model: model)
                } else {
                    Button {
                        voiceInput.stopBeforeSubmittingDraft()
                        Task { await model.send() }
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.headline.bold())
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(AidenSolidFillButtonStyle(shape: Circle(), hitSize: 44))
                    .disabled(!model.canSend)
                    .accessibilityLabel("Send message")
                }
            }

            if let receipt = model.runInputReceipt {
                Text(receipt)
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
                    .transition(.opacity)
            }

            if let error = voiceInput.errorMessage, !voiceInput.isListening {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .aidenComposerGlass()
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(palette.secondary.opacity(0.35), lineWidth: 0.5)
                .allowsHitTesting(false)
        }
        .shadow(color: .black.opacity(0.12), radius: 14, y: 6)
        .animation(
            reduceMotion ? nil : .smooth(duration: 0.34),
            value: visiblePendingAttachments.map(\.id) + attachmentPicker.committingAssets.map(\.localIdentifier)
        )
        .task {
            await model.startVoiceForLaunch(if: autoStartVoice) {
                model.readAloud.stop()
                await voiceInput.toggle(
                    currentDraft: model.draft,
                    updateDraft: { model.draft = $0 },
                    macTranscriber: model.transcribeMacSpeech
                )
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .aidenStopDictationForReadAloud)) { _ in
            voiceInput.cancelDiscardingRecording()
        }
        .onDisappear {
            voiceInput.cancelDiscardingRecording()
            model.cancelAttachmentPreparation()
        }
        .onChange(of: scenePhase) { _, phase in
            if AidenVoiceCaptureLifecyclePolicy.shouldDiscardRecording(for: phase) {
                voiceInput.cancelDiscardingRecording()
            }
        }
    }

    private var visiblePendingAttachments: [AidenAttachmentReference] {
        guard !attachmentPicker.committingAssets.isEmpty else { return model.pendingAttachments }
        return Array(model.pendingAttachments.prefix(attachmentPicker.committingPendingPrefixCount))
    }

    /// One pill while a run streams, matching the desktop and Android control:
    /// the mode's name sends in that mode (touch and hold for the menu), and the
    /// chevron opens the same Steer/Queue menu.
    private var runInputPill: some View {
        HStack(spacing: 0) {
            Menu {
                runInputModeMenu
            } label: {
                Text(model.runInputMode.busyLabel)
                    .font(.subheadline.weight(.semibold))
                    .contentTransition(.interpolate)
                    .padding(.leading, 14)
                    .padding(.trailing, 4)
                    .frame(minHeight: 44)
            } primaryAction: {
                voiceInput.stopBeforeSubmittingDraft()
                Task { await model.submitRunInput(model.runInputMode) }
            }
            .accessibilityLabel(model.runInputMode.busyActionLabel)
            .accessibilityHint(String(localized: "Touch and hold to choose Steer or Queue"))

            Menu {
                runInputModeMenu
            } label: {
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .padding(.leading, 4)
                    .padding(.trailing, 12)
                    .frame(minHeight: 44)
            }
            .accessibilityLabel(String(localized: "Choose message action"))
        }
        .foregroundStyle(runInputButtonForeground)
        .background(runInputButtonBackground, in: Capsule().inset(by: 7))
        .menuStyle(.button)
        .buttonStyle(.plain)
        .disabled(model.isStopping || model.isSubmittingRunInput || model.isReadOnlyPresentation)
        .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: model.runInputMode)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: model.canSubmitRunInput)
    }

    @ViewBuilder
    private var runInputModeMenu: some View {
        ForEach(AidenStreamInputMode.busyModes, id: \.self) { mode in
            Button {
                voiceInput.stopBeforeSubmittingDraft()
                Task { await model.selectRunInputMode(mode) }
            } label: {
                if model.runInputMode == mode {
                    Label {
                        Text(mode.busyLabel)
                        Text(mode.busyDetail)
                    } icon: {
                        Image(systemName: "checkmark")
                    }
                } else {
                    Text(mode.busyLabel)
                    Text(mode.busyDetail)
                }
            }
            .accessibilityAddTraits(model.runInputMode == mode ? .isSelected : [])
        }
    }

    private var runInputButtonBackground: Color {
        if model.canSubmitRunInput { return palette.fillAccent }
        return palette.foreground.opacity(colorScheme == .dark ? 0.18 : 0.12)
    }

    private var runInputButtonForeground: Color {
        model.canSubmitRunInput ? palette.onFillAccent : palette.secondary
    }

    private var selectedModelAccessibilityValue: String {
        guard let selectedModel = model.selectedModel else { return model.selectedModelDisplayLabel }
        guard let level = model.selectedThinkingLevel,
              selectedModel.thinkingLevels?.isEmpty == false
        else { return selectedModel.label }
        return "\(selectedModel.label), \(level.capitalized) thinking"
    }

    private func select(_ candidate: AidenModel, providerId: String, thinkingLevel: String?) {
        model.selectModel(
            providerId: providerId,
            modelId: candidate.id,
            thinkingLevel: thinkingLevel
        )
    }

    private func isSelected(
        _ candidate: AidenModel,
        providerId: String,
        thinkingLevel: String?
    ) -> Bool {
        guard model.selectedProviderId == providerId,
              model.selectedModelId == candidate.id
        else { return false }
        return thinkingLevel == nil || model.selectedThinkingLevel == thinkingLevel
    }
}

enum AidenVoiceCaptureLifecyclePolicy {
    static func shouldDiscardRecording(for phase: ScenePhase) -> Bool {
        phase == .background
    }
}

private struct AidenListeningWaveform: View {
    let isAnimated: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 12, paused: !isAnimated)) { context in
            let phase = isAnimated ? context.date.timeIntervalSinceReferenceDate * 7 : 0
            HStack(alignment: .center, spacing: 2) {
                ForEach(0..<5, id: \.self) { index in
                    let offset = Double(index) * 0.85
                    let amplitude = isAnimated ? abs(sin(phase + offset)) : 0.45
                    Capsule(style: .continuous)
                        .frame(width: 2.5, height: 19)
                        .scaleEffect(
                            x: 1,
                            y: (7 + (amplitude * 12)) / 19,
                            anchor: .center
                        )
                }
            }
            .frame(width: 24, height: 22)
        }
        .accessibilityHidden(true)
    }
}

private struct AidenComposerGlassModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    let enabled: Bool
    private let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)

    @ViewBuilder
    func body(content: Content) -> some View {
        if !enabled {
            content
        } else if !reduceTransparency {
            // The whole composer is a stable surface containing its own
            // interactive controls. Marking the container interactive causes
            // Liquid Glass to recompute multiple times during streamed updates.
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(palette.raised, in: shape)
        }
    }
}

extension View {
    func aidenComposerGlass(enabled: Bool = true) -> some View {
        modifier(AidenComposerGlassModifier(enabled: enabled))
    }
}

/// Compact composer palette for `/` skills and `@` roster/file mentions. The
/// panel is presentation only: skills hand the Mac an opaque lease, mentions
/// insert display text. It inherits the composer glass surface rather than
/// introducing a second floating container.
private struct AidenComposerSuggestionList: View {
    @Environment(\.aidenPalette) private var palette
    let suggestions: [AidenComposerSuggestion]
    let onSelect: (AidenComposerSuggestion) -> Void

    private let maximumRows = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(suggestions.prefix(maximumRows))) { suggestion in
                Button {
                    onSelect(suggestion)
                } label: {
                    row(for: suggestion)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isDisabled(suggestion))
                if suggestion.id != suggestions.prefix(maximumRows).last?.id {
                    Divider().opacity(0.35)
                }
            }
        }
        .background(palette.raised.opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func isDisabled(_ suggestion: AidenComposerSuggestion) -> Bool {
        if case .skill(let entry) = suggestion { return !entry.available }
        return false
    }

    @ViewBuilder
    private func row(for suggestion: AidenComposerSuggestion) -> some View {
        switch suggestion {
        case .skill(let entry):
            HStack(spacing: 8) {
                Image(systemName: "slash.circle")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text("/\(entry.name)")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(entry.available ? palette.foreground : palette.secondary)
                        .lineLimit(1)
                    Text(entry.available ? entry.description : (entry.unavailableReason ?? ""))
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(entry.source.rawValue)
                    .font(.caption2)
                    .foregroundStyle(palette.secondary.opacity(0.85))
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
                entry.available
                    ? "Skill \(entry.name)"
                    : "Skill \(entry.name), unavailable"
            )
        case .agent(let agent):
            HStack(spacing: 8) {
                Image(systemName: "person.crop.square")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 18)
                Text(agent.label)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("agent")
                    .font(.caption2)
                    .foregroundStyle(palette.secondary.opacity(0.85))
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Mention agent \(agent.label)")
        case .file(let entry):
            HStack(spacing: 8) {
                Image(systemName: "doc")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 18)
                Text(entry.displayPath)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Text("file")
                    .font(.caption2)
                    .foregroundStyle(palette.secondary.opacity(0.85))
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Mention file \(entry.displayPath)")
        }
    }
}
