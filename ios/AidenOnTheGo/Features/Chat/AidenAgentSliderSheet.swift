import SwiftUI

/// The composer's chip while the Agent Slider is on: the stop's name, or
/// Custom. It opens the slider sheet.
struct AidenAgentSliderChip: View {
    @Bindable var model: AidenChatViewModel
    let state: AidenAgentSliderState

    var body: some View {
        Button {
            model.isAgentSliderPresented = true
        } label: {
            AidenComposerModelChipLabel(
                provider: model.selectedProvider,
                modelID: model.selectedModel?.id,
                modelLabel: state.currentStop?.label ?? String(localized: "Custom"),
                thinkingLevel: nil
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Agent Slider")
        .accessibilityValue(AidenAgentSliderSheet.valueText(state, model: model))
        .accessibilityHint("Opens the Agent Slider")
        .accessibilityIdentifier("aiden.composer.agentSlider")
    }
}

/// The Agent Slider in a sheet: the stop's name and model, the track, Reset
/// to home, Other models, and every stop with why one can't run.
struct AidenAgentSliderSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @Bindable var model: AidenChatViewModel

    static func valueText(_ state: AidenAgentSliderState, model: AidenChatViewModel) -> String {
        AidenAgentSliderResolver.valueText(
            state.views,
            position: state.position,
            customModelLabel: model.selectedModelDisplayLabel
        )
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if let state = model.agentSliderState {
                    content(state)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 20)
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle("Agent Slider")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Label("Done", systemImage: "checkmark")
                    }
                    .accessibilityIdentifier("aiden.agentSlider.done")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func content(_ state: AidenAgentSliderState) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text(state.currentStop?.label ?? String(localized: "Custom"))
                    .font(.title.weight(.bold))
                    .foregroundStyle(palette.foreground)
                    .accessibilityAddTraits(.isHeader)
                Text(subtitle(state))
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
            }
            .accessibilityElement(children: .combine)

            AidenAgentSliderTrack(
                state: state,
                valueText: Self.valueText(state, model: model),
                onSelect: { model.selectAgentSliderStop(id: $0) },
                onStep: { model.stepAgentSlider($0) }
            )
            // A tick each time the chat lands on another stop, by drag, tap or step.
            .sensoryFeedback(.selection, trigger: state.currentStop?.id)

            HStack(spacing: 10) {
                Menu {
                    AidenComposerModelMenuContent(model: model)
                } label: {
                    actionLabel("Other models", systemImage: "list.bullet")
                }
                .accessibilityIdentifier("aiden.agentSlider.otherModels")
                Button {
                    model.resetAgentSliderToHome()
                } label: {
                    actionLabel("Reset to home", systemImage: "arrow.counterclockwise")
                }
                .buttonStyle(.plain)
                .disabled(!state.canResetToHome)
                .opacity(state.canResetToHome ? 1 : 0.5)
                .accessibilityIdentifier("aiden.agentSlider.reset")
            }

            VStack(spacing: 0) {
                ForEach(Array(state.views.enumerated()), id: \.element.id) { index, view in
                    if index > 0 {
                        Divider().padding(.leading, 64)
                    }
                    Button {
                        model.selectAgentSliderStop(id: view.id)
                    } label: {
                        AidenAgentSliderStopRow(
                            view: view,
                            index: index,
                            count: state.views.count,
                            isCurrent: state.position.stopIndex == index,
                            isHome: state.homeIndex == index
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(!view.isAvailable)
                    .accessibilityIdentifier("aiden.agentSlider.stop.\(view.id)")
                }
            }
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .padding(.top, 8)
    }

    private func subtitle(_ state: AidenAgentSliderState) -> String {
        if let stop = state.currentStop { return stop.detail }
        let effort = AidenAgentSliderResolver.effortLabel(model.selectedThinkingLevel)
        return [model.selectedModelDisplayLabel, effort].compactMap { $0 }.joined(separator: " · ")
    }

    private func actionLabel(_ title: LocalizedStringKey, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(palette.foreground)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// The track: a glyph per stop, filled where a turn can run and faint where
/// it can't, and the thumb, hollow in Custom. A tap or a drag lands on the
/// nearest stop that can run; VoiceOver and a keyboard step it.
struct AidenAgentSliderTrack: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @FocusState private var isFocused: Bool
    let state: AidenAgentSliderState
    let valueText: String
    let onSelect: (String) -> Void
    let onStep: (Int) -> Void

    private static let inset: CGFloat = 14
    private static let thumbSize: CGFloat = 26

    var body: some View {
        GeometryReader { geometry in
            let midY = geometry.size.height / 2
            let thumbX = x(state.position.thumbIndex, width: geometry.size.width)
            ZStack(alignment: .topLeading) {
                Capsule()
                    .fill(palette.foreground.opacity(0.14))
                    .frame(width: max(geometry.size.width - Self.inset * 2, 0), height: 4)
                    .position(x: geometry.size.width / 2, y: midY)
                if !state.position.isCustom {
                    Capsule()
                        .fill(palette.accent)
                        .frame(width: max(thumbX - Self.inset, 0), height: 4)
                        .position(x: (Self.inset + thumbX) / 2, y: midY)
                }
                ForEach(Array(state.views.enumerated()), id: \.element.id) { index, view in
                    Circle()
                        .fill(view.isAvailable ? palette.foreground.opacity(0.6) : palette.foreground.opacity(0.18))
                        .frame(width: view.isAvailable ? 7 : 5, height: view.isAvailable ? 7 : 5)
                        .position(x: x(index, width: geometry.size.width), y: midY)
                }
                thumb
                    .position(x: thumbX, y: midY)
                    .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: state.position)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0).onChanged { value in
                    if let id = nearestAvailableStop(to: value.location.x, width: geometry.size.width) {
                        onSelect(id)
                    }
                }
            )
        }
        .frame(height: 44)
        .padding(4)
        .overlay {
            // The neutral keyboard focus ring, only while the track has focus.
            if isFocused {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(palette.foreground.opacity(0.55), lineWidth: 2)
            }
        }
        .focusable()
        .focused($isFocused)
        .onKeyPress(.leftArrow) { onStep(-1); return .handled }
        .onKeyPress(.rightArrow) { onStep(1); return .handled }
        .accessibilityElement()
        .accessibilityLabel("Agent Slider")
        .accessibilityValue(valueText)
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: onStep(1)
            case .decrement: onStep(-1)
            @unknown default: break
            }
        }
        .accessibilityIdentifier("aiden.agentSlider.track")
    }

    @ViewBuilder
    private var thumb: some View {
        if state.position.isCustom {
            Circle()
                .fill(palette.raised)
                .overlay { Circle().stroke(palette.foreground.opacity(0.55), lineWidth: 2) }
                .frame(width: Self.thumbSize, height: Self.thumbSize)
        } else {
            Circle()
                .fill(palette.raised)
                .shadow(color: .black.opacity(0.18), radius: 3, y: 1)
                .frame(width: Self.thumbSize, height: Self.thumbSize)
        }
    }

    private func x(_ index: Int, width: CGFloat) -> CGFloat {
        let span = max(width - Self.inset * 2, 0)
        let count = max(state.views.count - 1, 1)
        return Self.inset + span * CGFloat(index) / CGFloat(count)
    }

    private func nearestAvailableStop(to location: CGFloat, width: CGFloat) -> String? {
        state.views.indices
            .filter { state.views[$0].isAvailable }
            .min { abs(x($0, width: width) - location) < abs(x($1, width: width) - location) }
            .map { state.views[$0].id }
    }
}

/// One stop as a row: its place on the slider, its name, and its model and
/// effort or why it can't run. Shared by the sheet and Settings.
struct AidenAgentSliderStopRow: View {
    @Environment(\.aidenPalette) private var palette
    let view: AidenAgentSliderStopView
    let index: Int
    let count: Int
    let isCurrent: Bool
    let isHome: Bool

    var body: some View {
        HStack(spacing: 12) {
            AidenAgentSliderPlaceGlyph(index: index, count: count)
                .frame(width: 40)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(view.label)
                        .font(.body.weight(isCurrent ? .semibold : .regular))
                        .foregroundStyle(view.isAvailable ? palette.foreground : palette.secondary)
                    if isHome {
                        Image(systemName: "house")
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                            .accessibilityHidden(true)
                    }
                }
                Text(view.detail)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
            Spacer(minLength: 8)
            if isCurrent {
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.accent)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isHome ? String(localized: "\(view.label), home stop") : view.label)
        .accessibilityValue(view.detail)
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }
}

/// Where a stop sits on the slider, as dots: its own dot larger.
struct AidenAgentSliderPlaceGlyph: View {
    @Environment(\.aidenPalette) private var palette
    let index: Int
    let count: Int

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<count, id: \.self) { dot in
                Circle()
                    .fill(palette.foreground.opacity(dot == index ? 0.85 : 0.35))
                    .frame(width: dot == index ? 6 : 3, height: dot == index ? 6 : 3)
            }
        }
        .accessibilityHidden(true)
    }
}

/// Every model the Mac offers, by provider, with each model's levels: the
/// composer's model menu, and Other models in the slider sheet.
struct AidenComposerModelMenuContent: View {
    @Environment(\.aidenPalette) private var palette
    @Bindable var model: AidenChatViewModel

    var body: some View {
        ForEach(model.visibleProviders) { provider in
            Section {
                ForEach(provider.models) { candidate in
                    if let levels = candidate.thinkingLevels, !levels.isEmpty {
                        Menu {
                            ForEach(levels, id: \.self) { level in
                                Button {
                                    select(candidate, providerId: provider.id, thinkingLevel: level)
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
    }

    private func select(_ candidate: AidenModel, providerId: String, thinkingLevel: String?) {
        model.selectModel(providerId: providerId, modelId: candidate.id, thinkingLevel: thinkingLevel)
    }

    private func isSelected(_ candidate: AidenModel, providerId: String, thinkingLevel: String?) -> Bool {
        guard model.selectedProviderId == providerId, model.selectedModelId == candidate.id else { return false }
        return thinkingLevel == nil || model.selectedThinkingLevel == thinkingLevel
    }
}

extension View {
    /// Presents the chat's Agent Slider sheet from `isAgentSliderPresented`
    /// on its model. The model outlives an iPhone Duo fold, so the sheet
    /// opens again on the rebuilt view; the old view's sheet closing during
    /// the fold isn't the person closing it.
    func aidenAgentSliderSheet(model: AidenChatViewModel, screen: AidenChatScreen?) -> some View {
        modifier(AidenAgentSliderPresentation(model: model, screen: screen))
    }
}

private struct AidenAgentSliderPresentation: ViewModifier {
    @Bindable var model: AidenChatViewModel
    let screen: AidenChatScreen?
    @State private var isOnScreen = false

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: Binding(
                get: { isOnScreen && model.isAgentSliderPresented && model.agentSliderState != nil },
                set: { shown in
                    if shown {
                        model.isAgentSliderPresented = true
                    } else if isOnScreen, screen?.isRebuilding != true {
                        model.isAgentSliderPresented = false
                    }
                }
            )) {
                AidenAgentSliderSheet(model: model)
            }
            .onAppear { isOnScreen = true }
            .onDisappear { isOnScreen = false }
    }
}
