import SwiftUI

/// Shared by the message and question composers so cancellation remains reachable.
struct AidenChatStopButton: View {
    @Bindable var model: AidenChatViewModel

    var canStop: Bool { model.canControlCurrentRun && !model.isStopping }

    static func label(for model: AidenChatViewModel) -> String {
        model.isStopping ? String(localized: "Stopping response") : String(localized: "Stop response")
    }

    @discardableResult
    func stop() async -> Bool { await model.stop() }

    var body: some View {
        if model.isStreaming {
            AidenComposerStopButton(label: Self.label(for: model), isEnabled: canStop) {
                Task { await stop() }
            }
        }
    }
}

/// The chat's composer: the shared surface, plus what only a chat has. The chat
/// detail view owns `session`, so this view can come and go.
struct AidenComposerView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Bindable var model: AidenChatViewModel
    let session: AidenComposerSession
    let autoStartVoice: Bool
    @Bindable var attachmentPicker: AidenAttachmentPickerState
    let motionNamespace: Namespace.ID
    let canToggleAttachments: Bool
    let onToggleAttachmentPicker: () -> Void
    var placeholder = "Message Aiden"

    var body: some View {
        AidenComposerSurface(
            session: session,
            config: config,
            controls: Self.controls(for: model),
            onSend: { Task { await model.send() } },
            onStop: model.isStreaming ? { Task { await model.stop() } } : nil,
            onToggleVoice: { Task { await toggleVoice() } },
            accessory: { accessory },
            attachButton: { attachButton },
            modelChip: { modelChip },
            busyControl: {
                if model.showsRunInputOptions { runInputPill }
            },
            footer: {
                if let receipt = model.runInputReceipt {
                    Text(receipt)
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .transition(.opacity)
                }
            }
        )
        .animation(
            reduceMotion ? nil : .smooth(duration: 0.34),
            value: visiblePendingAttachments.map(\.id) + attachmentPicker.committingAssets.map(\.localIdentifier)
        )
        .task {
            await model.startVoiceForLaunch(if: autoStartVoice) { await toggleVoice() }
        }
    }

    private var config: AidenComposerConfig {
        Self.config(for: model, placeholder: placeholder)
    }

    static func config(for model: AidenChatViewModel, placeholder: String) -> AidenComposerConfig {
        // Bot chats take their model from the Bot.
        var config = AidenComposerConfig.chat(
            model: model.showsComposerModelControl ? model.selectedModelDisplayLabel : nil
        )
        config.placeholder = placeholder
        return config
    }

    static func controls(for model: AidenChatViewModel) -> AidenComposerControls {
        AidenComposerControls(
            canSend: model.canSend,
            canStop: model.canControlCurrentRun && !model.isStopping,
            stopLabel: AidenChatStopButton.label(for: model),
            // Its words stay in view, but they can't go anywhere.
            fieldIsDisabled: model.isOwnerRevoked,
            // Dictation is off while a response streams, so the busy Steer/Queue
            // pill takes the mic's place (as on Android).
            offersMic: !(model.isStreaming && model.showsRunInputOptions),
            micIsEnabled: !model.isReadOnlyPresentation && !model.isStreaming && !model.isOwnerRevoked,
            submitsOnReturn: true
        )
    }

    private func toggleVoice() async {
        guard !model.isReadOnlyPresentation else { return }
        model.readAloud.stop()
        await session.toggleVoice()
    }

    @ViewBuilder
    private var accessory: some View {
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
    }

    private var attachButton: some View {
        AidenComposerAttachButton(
            isOpen: attachmentPicker.isPresented,
            isBusy: model.isUploadingAttachment || model.isPreparingAttachments,
            showsSpinner: model.uploadProgress == nil,
            hint: model.acceptsImageAttachments
                ? String(localized: "Attach an image or bounded text file")
                : String(localized: "Attach a bounded text file. This model cannot read images"),
            coordinateSpace: AidenChatAttachmentCoordinateSpace.name,
            action: onToggleAttachmentPicker
        )
        .disabled(!canToggleAttachments)
    }

    @ViewBuilder
    private var modelChip: some View {
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
                AidenComposerModelChipLabel(
                    provider: model.selectedProvider,
                    modelID: model.selectedModel?.id,
                    modelLabel: model.selectedModel?.label ?? "Model",
                    thinkingLevel: model.selectedModel?.thinkingLevels?.isEmpty == false
                        ? model.selectedThinkingLevel
                        : nil
                )
            }
            .accessibilityLabel("Model")
            .accessibilityValue(selectedModelAccessibilityValue)
        } else if model.showsComposerModelControl,
                  let selectedModel = model.selectedModel {
            HStack(spacing: 4) {
                Text(selectedModel.label).lineLimit(1)
                Text("· Hidden")
                    .lineLimit(1)
            }
            .font(.caption)
            .foregroundStyle(palette.secondary)
            .frame(maxWidth: 180, alignment: .leading)
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Model")
            .accessibilityValue("\(selectedModel.label), hidden from picker")
        }
    }

    private var visiblePendingAttachments: [AidenAttachmentReference] {
        guard !attachmentPicker.committingAssets.isEmpty else { return session.attachments }
        return Array(session.attachments.prefix(attachmentPicker.committingPendingPrefixCount))
    }

    /// One pill while a run streams, matching the desktop and Android control:
    /// the mode's name sends in that mode (touch and hold for the menu), and the
    /// chevron opens the same Steer/Queue menu.
    private var runInputPill: some View {
        AidenComposerRunInputPill(
            title: model.runInputMode.busyLabel,
            actionLabel: model.runInputMode.busyActionLabel,
            canSubmit: model.canSubmitRunInput,
            onSubmit: {
                session.stopVoice()
                Task { await model.submitRunInput(model.runInputMode) }
            },
            modeMenu: { runInputModeMenu }
        )
        .disabled(model.isStopping || model.isSubmittingRunInput || model.isReadOnlyPresentation)
        .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: model.runInputMode)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: model.canSubmitRunInput)
    }

    @ViewBuilder
    private var runInputModeMenu: some View {
        ForEach(AidenStreamInputMode.busyModes, id: \.self) { mode in
            Button {
                session.stopVoice()
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

/// The face of the model chip: the provider, the model and its thinking level.
struct AidenComposerModelChipLabel: View {
    /// What the chip shows on one line, in the order it tries them.
    enum Fit: CaseIterable {
        /// "Claude Sonnet 4.5 · Medium"
        case full
        /// "Claude Sonnet 4.5": the level goes first, since the menu shows it.
        case model
        /// Both, each cut short. Only when even the model alone won't fit.
        case shortened
    }

    @Environment(\.aidenPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let provider: AidenProvider?
    let modelID: String?
    let modelLabel: String
    let thinkingLevel: String?
    /// For tests: draws one face instead of the first that fits.
    var fit: Fit?

    var body: some View {
        HStack(spacing: 4) {
            if let provider {
                AidenProviderIcon(
                    providerID: provider.id,
                    providerLabel: provider.label,
                    modelID: modelID,
                    artwork: provider.artwork,
                    size: 15,
                    color: palette.secondary
                )
            }
            if dynamicTypeSize.isAccessibilitySize {
                // One text that wraps, so neither half is cut to a few letters.
                Text(thinkingLevel.map { "\(modelLabel) · \($0.capitalized)" } ?? modelLabel)
                    .multilineTextAlignment(.leading)
            } else if let fit {
                face(fit)
            } else {
                // The composer keeps one line below the accessibility sizes, so a
                // run starting doesn't change its height. Rather than cut both
                // words, the chip drops the level when the pair won't fit.
                ViewThatFits(in: .horizontal) {
                    face(.full)
                    if thinkingLevel != nil { face(.model) }
                    face(.shortened)
                }
            }
            Image(systemName: "chevron.down").font(.caption2)
        }
        .font(.caption)
        .foregroundStyle(palette.secondary)
        // At accessibility sizes the chip has its own line to use.
        .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : AidenComposerLayout.longestChip, alignment: .leading)
        .frame(minHeight: 44)
    }

    @ViewBuilder
    private func face(_ fit: Fit) -> some View {
        switch fit {
        case .full, .shortened:
            HStack(spacing: 4) {
                Text(modelLabel).lineLimit(1)
                if let thinkingLevel {
                    // Faded any further, the level would fall under 4.5:1.
                    Text("· \(thinkingLevel.capitalized)")
                        .lineLimit(1)
                }
            }
            .fixedSize(horizontal: fit == .full, vertical: false)
        case .model:
            Text(modelLabel).lineLimit(1).fixedSize(horizontal: true, vertical: false)
        }
    }
}

/// Steer or Queue while a response runs. A tap on the mode's name sends in that
/// mode (touch and hold for the menu), and the chevron opens the same menu.
struct AidenComposerRunInputPill<ModeMenu: View>: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let title: String
    let actionLabel: String
    let canSubmit: Bool
    let onSubmit: () -> Void
    @ViewBuilder let modeMenu: () -> ModeMenu

    var body: some View {
        HStack(spacing: 0) {
            Menu {
                modeMenu()
            } label: {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .contentTransition(.interpolate)
                    .padding(.leading, 14)
                    .padding(.trailing, 4)
                    .frame(minHeight: 44)
            } primaryAction: {
                onSubmit()
            }
            .accessibilityLabel(actionLabel)
            .accessibilityHint(String(localized: "Touch and hold to choose Steer or Queue"))

            Menu {
                modeMenu()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .padding(.leading, 4)
                    .padding(.trailing, 12)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel(String(localized: "Choose message action"))
        }
        .foregroundStyle(canSubmit ? palette.onFillAccent : palette.secondary)
        .background(
            canSubmit ? palette.fillAccent : palette.foreground.opacity(colorScheme == .dark ? 0.18 : 0.12),
            // Large text fills the pill's height, so its tint gives back the inset.
            in: Capsule().inset(by: dynamicTypeSize.isAccessibilitySize ? 0 : 7)
        )
        .menuStyle(.button)
        .buttonStyle(.plain)
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
