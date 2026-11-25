import SwiftUI

/// The composer's chip while the Agent Slider is on: the stop's name, or
/// Custom. It opens the slider, which sits with the chip.
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
        .modifier(AidenAgentSliderPresenter(model: model))
        .accessibilityLabel("Agent Slider")
        .accessibilityValue(AidenAgentSliderSheet.valueText(state, model: model))
        .accessibilityHint("Opens the Agent Slider")
        .accessibilityIdentifier("aiden.composer.agentSlider")
    }
}

extension EnvironmentValues {
    /// The chat screen the composer belongs to, so the Agent Slider can tell
    /// an iPhone Duo fold's rebuild from the person closing it.
    @Entry var aidenChatScreen: AidenChatScreen?
}

/// The Agent Slider: the stop's name and model, the track, Reset to home,
/// Other models, and every stop with why one can't run. A popover beside the
/// chip at regular width, and a sheet sized to its stops on a phone.
struct AidenAgentSliderSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Bindable var model: AidenChatViewModel
    @State private var contentHeight: CGFloat = 0

    /// The navigation bar and grabber above the content in a sheet.
    private static let chromeHeight: CGFloat = 72

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
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
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
        .frame(idealWidth: 400, idealHeight: fittedHeight ?? 560)
        .presentationDetents(detents)
        .presentationDragIndicator(.visible)
    }

    /// Every stop and its reason, with the track and actions, in one detent.
    private var fittedHeight: CGFloat? {
        contentHeight > 0 ? contentHeight + Self.chromeHeight : nil
    }

    private var detents: Set<PresentationDetent> {
        guard let fittedHeight else { return [.medium, .large] }
        return [.height(fittedHeight), .large]
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

            let actions = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
                : AnyLayout(HStackLayout(spacing: 10))
            actions {
                Menu {
                    AidenComposerModelMenuContent(model: model)
                } label: {
                    actionLabel("Other models", systemImage: "list.bullet", isEnabled: true)
                }
                .accessibilityIdentifier("aiden.agentSlider.otherModels")
                Button {
                    model.resetAgentSliderToHome()
                } label: {
                    actionLabel("Reset to home", systemImage: "arrow.counterclockwise", isEnabled: state.canResetToHome)
                }
                .buttonStyle(.plain)
                .disabled(!state.canResetToHome)
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

    /// A plain-style label keeps its own colour when disabled, so a disabled
    /// action reads in the secondary text token instead.
    private func actionLabel(_ title: LocalizedStringKey, systemImage: String, isEnabled: Bool) -> some View {
        Label(title, systemImage: systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(isEnabled ? palette.foreground : palette.secondary)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// The track: a glyph per stop, filled where a turn can run and faint where
/// it can't, and the thumb, dashed in Custom. A tap lands on the nearest stop
/// that can run. A sideways drag moves the thumb and lands once, where it's
/// let go; a drag that starts upright is left to the scroll. VoiceOver and a
/// keyboard step it.
struct AidenAgentSliderTrack: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @FocusState private var isFocused: Bool
    /// The drag in progress, if any: the stop under it, or that it's the
    /// scroll's.
    @State private var drag = AidenAgentSliderDrag()
    let state: AidenAgentSliderState
    let valueText: String
    let onSelect: (String) -> Void
    let onStep: (Int) -> Void

    private static let inset: CGFloat = 14
    private static let thumbSize: CGFloat = 26

    private var thumbIndex: Int { drag.previewIndex ?? state.position.thumbIndex }
    private var showsCustom: Bool { drag.previewIndex == nil && state.position.isCustom }

    var body: some View {
        GeometryReader { geometry in
            let midY = geometry.size.height / 2
            let thumbX = x(thumbIndex, width: geometry.size.width)
            ZStack(alignment: .topLeading) {
                Capsule()
                    .fill(palette.foreground.opacity(0.14))
                    .frame(width: max(geometry.size.width - Self.inset * 2, 0), height: 4)
                    .position(x: geometry.size.width / 2, y: midY)
                if !showsCustom {
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
                    .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: thumbIndex)
            }
            .contentShape(Rectangle())
            .onTapGesture { location in
                if let index = nearestAvailableStop(to: location.x, width: geometry.size.width) {
                    onSelect(state.views[index].id)
                }
            }
            // Alongside the sheet's scroll, so an upright drag still scrolls.
            .simultaneousGesture(
                DragGesture(minimumDistance: 8)
                    .onChanged { value in
                        drag.moved(
                            translation: value.translation,
                            to: nearestAvailableStop(to: value.location.x, width: geometry.size.width)
                        )
                    }
                    .onEnded { _ in
                        if let index = drag.ended(), state.views.indices.contains(index) {
                            onSelect(state.views[index].id)
                        }
                    }
            )
        }
        .frame(height: 44)
        .padding(4)
        // A tick each time the thumb reaches another stop, by drag, tap or step.
        .sensoryFeedback(.selection, trigger: showsCustom ? nil : thumbIndex)
        .overlay {
            // The neutral keyboard focus ring, only while the track has focus.
            if isFocused {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(palette.focusRing, lineWidth: 2)
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
        if showsCustom {
            // Custom: off every stop, so hollow with a dashed edge.
            Circle()
                .fill(palette.canvas)
                .overlay {
                    Circle().stroke(palette.secondary, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                }
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

    private func nearestAvailableStop(to location: CGFloat, width: CGFloat) -> Int? {
        AidenAgentSliderDrag.nearestAvailableStop(
            state.views.map(\.isAvailable),
            to: location,
            width: width,
            inset: Self.inset
        )
    }
}

/// One drag on the slider's track. Sideways from its first movement, it
/// previews the nearest stop that can run and lands once, where it's let go;
/// upright from its first movement, it's the scroll's and lands nowhere.
struct AidenAgentSliderDrag: Equatable, Sendable {
    /// The stop under a drag that hasn't landed yet.
    private(set) var previewIndex: Int?
    /// The drag started upright.
    private(set) var isIgnored = false

    /// The drag moved by `translation`, over the stop `stop` (nil: none can run).
    mutating func moved(translation: CGSize, to stop: Int?) {
        guard !isIgnored else { return }
        if previewIndex == nil, abs(translation.height) >= abs(translation.width) {
            isIgnored = true
            return
        }
        previewIndex = stop ?? previewIndex
    }

    /// The drag ended: the stop it lands on, if any. The next drag starts fresh.
    mutating func ended() -> Int? {
        defer { self = Self() }
        return isIgnored ? nil : previewIndex
    }

    /// The runnable stop nearest `location` on a track `width` wide whose
    /// stops are spread evenly between `inset` from each end.
    static func nearestAvailableStop(_ isAvailable: [Bool], to location: CGFloat, width: CGFloat, inset: CGFloat) -> Int? {
        let span = max(width - inset * 2, 0)
        let gaps = CGFloat(max(isAvailable.count - 1, 1))
        func x(_ index: Int) -> CGFloat { inset + span * CGFloat(index) / gaps }
        return isAvailable.indices
            .filter { isAvailable[$0] }
            .min { abs(x($0) - location) < abs(x($1) - location) }
    }
}

/// One stop as a row: its place on the slider, its name, and its model and
/// effort or why it can't run. Shared by the sheet and Settings, where no
/// row is current.
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
                .frame(width: AidenAgentSliderPlaceGlyph.width)
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

/// Where a stop sits on the slider, as dots: its own dot larger. Seven stops,
/// the most a slider has, fit its width.
struct AidenAgentSliderPlaceGlyph: View {
    @Environment(\.aidenPalette) private var palette
    let index: Int
    let count: Int

    static let width: CGFloat = 40
    private static let spacing: CGFloat = 2

    var body: some View {
        // 6 pt for this stop, 3 pt for each other, 2 pt apart: 36 pt at seven.
        HStack(spacing: Self.spacing) {
            ForEach(0..<count, id: \.self) { dot in
                Circle()
                    .fill(palette.foreground.opacity(dot == index ? 0.85 : 0.35))
                    .frame(width: dot == index ? 6 : 3, height: dot == index ? 6 : 3)
            }
        }
        .fixedSize()
        .accessibilityHidden(true)
    }
}

/// Presents the chat's Agent Slider from the model's presentation state, on
/// the composer's chip: a popover pointing at it at regular width, a sheet on
/// a phone. The model outlives an iPhone Duo fold, so the slider opens again
/// on the rebuilt chip; the old chip's close during the fold isn't the person
/// closing it.
private struct AidenAgentSliderPresenter: ViewModifier {
    @Bindable var model: AidenChatViewModel
    @Environment(\.aidenChatScreen) private var screen
    @State private var id = UUID()

    func body(content: Content) -> some View {
        content
            .popover(isPresented: isPresented, arrowEdge: .bottom) {
                AidenAgentSliderSheet(model: model)
                    .presentationCompactAdaptation(.sheet)
            }
            .onAppear { model.agentSliderPresentation.appeared(id) }
            .onDisappear { model.agentSliderPresentation.disappeared(id) }
    }

    private var isPresented: Binding<Bool> {
        Binding(
            get: { model.agentSliderPresentation.isShown(by: id) && model.agentSliderState != nil },
            set: { shown in
                if shown {
                    model.agentSliderPresentation.isPresented = true
                } else {
                    model.agentSliderPresentation.closed(by: id, whileRebuilding: screen?.isRebuilding == true)
                }
            }
        )
    }
}
