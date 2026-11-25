import Foundation

/// One stop as the composer shows it: its words and whether a turn can run on
/// it from this phone. Ported from `renderer/lib/agent-slider-view.ts`.
struct AidenAgentSliderStopView: Equatable, Identifiable, Sendable {
    let stop: AidenAgentSliderStop
    /// The model's display name; nil for a "Choose a model" stop.
    let modelLabel: String?
    /// The effort in words ("High"); nil when the stop sets no level.
    let effortLabel: String?
    let isAvailable: Bool
    /// Why the stop can't run, in words ("Sign in to Anthropic").
    let reasonText: String?

    var id: String { stop.id }
    var label: String { stop.label }

    /// The model, the effort, or why the stop can't run, as one line.
    var detail: String {
        if let reasonText, !isAvailable { return reasonText }
        return [modelLabel, effortLabel].compactMap { $0 }.joined(separator: " · ")
    }

    /// What a turn on this stop sends: the stop's provider, model and level,
    /// exactly. Nil for a stop that can't run.
    var turnSelection: AidenChatModelSelection? {
        guard isAvailable, let providerId = stop.providerId, let modelId = stop.modelId else { return nil }
        return AidenChatModelSelection(providerId: providerId, modelId: modelId, thinkingLevel: stop.thinkingLevel)
    }
}

/// Where the chat sits on the slider.
struct AidenAgentSliderPosition: Equatable, Sendable {
    /// The stop the chat sits on; nil in Custom.
    let stopIndex: Int?
    /// Where the thumb rests: the stop, or the home stop in Custom.
    let thumbIndex: Int

    var isCustom: Bool { stopIndex == nil }
}

/// The phone's Agent Slider rules, matching the Mac's composer: the active stop
/// is derived from the chat's provider, model and level (first exact match),
/// no match is Custom, and a step skips stops that can't run. Nothing here
/// substitutes another model for a stop.
enum AidenAgentSliderResolver {
    /// `BOT_THINKING_LEVEL_LABELS` in `renderer/shared/bot-routine-models.ts`.
    static func effortLabel(_ level: String?) -> String? {
        switch level {
        case "off": "Off"
        case "minimal": "Minimal"
        case "low": "Low"
        case "medium": "Medium"
        case "high": "High"
        case "xhigh": "Extra high"
        case "max": "Maximum"
        default: nil
        }
    }

    /// The reason a stop can't run, as the slider says it.
    static func reasonText(
        _ availability: AidenAgentSliderAvailability,
        providerId: String?,
        providerLabel: String?
    ) -> String? {
        switch availability {
        case .ready: nil
        case .unassigned: String(localized: "Choose a model")
        case .notSignedIn: String(localized: "Sign in to \(providerLabel ?? providerId ?? String(localized: "the provider"))")
        case .providerMissing: String(localized: "\(providerLabel ?? providerId ?? String(localized: "The provider")) was removed")
        case .modelMissing: String(localized: "Model not found")
        case .hidden: String(localized: "Hidden in Settings")
        }
    }

    /// Each stop's words and whether it can run. A stop runs only when the Mac
    /// says it is ready and this phone's catalog lists its model under its
    /// provider, so a turn can name it; otherwise it reads "Model not found".
    static func views(for slider: AidenAgentSlider, catalog: AidenModelCatalog) -> [AidenAgentSliderStopView] {
        slider.stops.map { stop in
            let provider = stop.providerId.flatMap { id in catalog.providers.first { $0.id == id } }
            let model = stop.modelId.flatMap { id in provider?.models.first { $0.id == id } }
            var availability = stop.availability
            if availability == .ready, model == nil { availability = .modelMissing }
            return AidenAgentSliderStopView(
                stop: stop,
                modelLabel: stop.modelId.map { model?.label ?? $0 },
                effortLabel: effortLabel(stop.thinkingLevel),
                isAvailable: availability == .ready,
                reasonText: reasonText(availability, providerId: stop.providerId, providerLabel: provider?.label)
            )
        }
    }

    static func homeStopIndex(_ slider: AidenAgentSlider) -> Int {
        slider.stops.firstIndex { $0.id == slider.homeStopId } ?? (slider.stops.count - 1) / 2
    }

    /// The first stop naming this provider, model and level; an absent level
    /// matches only an absent level. Nil is Custom.
    static func activeStopIndex(_ slider: AidenAgentSlider, selection: AidenChatModelSelection) -> Int? {
        guard let providerId = selection.providerId, let modelId = selection.modelId else { return nil }
        return slider.stops.firstIndex { stop in
            stop.providerId == providerId && stop.modelId == modelId && stop.thinkingLevel == selection.thinkingLevel
        }
    }

    /// Where the chat sits. No matching stop is Custom, and so is a slider on
    /// which no stop can run.
    static func position(
        _ slider: AidenAgentSlider,
        views: [AidenAgentSliderStopView],
        selection: AidenChatModelSelection
    ) -> AidenAgentSliderPosition {
        let home = homeStopIndex(slider)
        guard let index = activeStopIndex(slider, selection: selection),
              views.contains(where: \.isAvailable) else {
            return AidenAgentSliderPosition(stopIndex: nil, thumbIndex: home)
        }
        return AidenAgentSliderPosition(stopIndex: index, thumbIndex: index)
    }

    /// The stop one step left (-1) or right (+1) of the chat's, skipping stops
    /// that can't run. Custom starts from the home stop; when nothing is that
    /// way, a runnable home stop is the step. Nil when the step goes nowhere.
    static func step(
        _ views: [AidenAgentSliderStopView],
        from position: AidenAgentSliderPosition,
        direction: Int
    ) -> Int? {
        precondition(direction == 1 || direction == -1)
        var index = position.thumbIndex + direction
        while views.indices.contains(index) {
            if views[index].isAvailable { return index }
            index += direction
        }
        if position.isCustom, views.indices.contains(position.thumbIndex), views[position.thumbIndex].isAvailable {
            return position.thumbIndex
        }
        return nil
    }

    /// What VoiceOver reads for the slider.
    static func valueText(
        _ views: [AidenAgentSliderStopView],
        position: AidenAgentSliderPosition,
        customModelLabel: String
    ) -> String {
        guard let index = position.stopIndex, views.indices.contains(index) else {
            return String(localized: "Custom: \(customModelLabel)")
        }
        let view = views[index]
        return [
            view.label,
            view.modelLabel ?? String(localized: "No model chosen"),
            view.effortLabel,
            view.isAvailable ? nil : view.reasonText,
        ].compactMap { $0 }.joined(separator: ", ")
    }
}

/// The slider as one chat's composer sees it.
struct AidenAgentSliderState: Equatable, Sendable {
    let slider: AidenAgentSlider
    let views: [AidenAgentSliderStopView]
    let position: AidenAgentSliderPosition

    init(slider: AidenAgentSlider, catalog: AidenModelCatalog, selection: AidenChatModelSelection) {
        self.slider = slider
        views = AidenAgentSliderResolver.views(for: slider, catalog: catalog)
        position = AidenAgentSliderResolver.position(slider, views: views, selection: selection)
    }

    var homeIndex: Int { AidenAgentSliderResolver.homeStopIndex(slider) }

    /// The stop the chat sits on, or nil in Custom.
    var currentStop: AidenAgentSliderStopView? {
        position.stopIndex.flatMap { views.indices.contains($0) ? views[$0] : nil }
    }

    /// Reset to home applies only when home can run and the chat isn't on it.
    var canResetToHome: Bool {
        views.indices.contains(homeIndex) && views[homeIndex].isAvailable && position.stopIndex != homeIndex
    }
}
