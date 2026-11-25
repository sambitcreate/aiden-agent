import Foundation

extension AidenChatViewModel {
    // MARK: - Agent Slider (contract revision 66)

    /// The Mac's Agent Slider, when this chat's composer shows it: a chat the
    /// person picks the model for, on a Mac that offers `chat:agent-slider`
    /// and granted it to this phone. Otherwise the composer keeps the model
    /// menu, as it does with an older Mac.
    var agentSlider: AidenAgentSlider? {
        guard !chat.isBotChat, let slider = catalog?.agentSlider,
              let server = ownerServer,
              server.serverCapabilities?.contains(.chatAgentSlider) == true,
              server.capabilities.contains(.chatAgentSlider) else { return nil }
        return slider
    }

    /// The slider as this chat sees it: each stop, and where the chat sits.
    var agentSliderState: AidenAgentSliderState? {
        guard let slider = agentSlider, let catalog else { return nil }
        return AidenAgentSliderState(slider: slider, catalog: catalog, selection: turnModelSelection)
    }

    /// The home stop's selection when it can run, for a chat that has no
    /// model yet.
    var agentSliderHomeSelection: AidenChatModelSelection? {
        guard let slider = agentSlider, let catalog else { return nil }
        let views = AidenAgentSliderResolver.views(for: slider, catalog: catalog)
        let home = AidenAgentSliderResolver.homeStopIndex(slider)
        return views.indices.contains(home) ? views[home].turnSelection : nil
    }

    /// Puts the chat on a stop: its provider, model and level exactly. A stop
    /// that can't run does nothing.
    func selectAgentSliderStop(id: String) {
        guard let state = agentSliderState,
              let selection = state.views.first(where: { $0.id == id })?.turnSelection,
              let providerId = selection.providerId,
              let modelId = selection.modelId else { return }
        selectModel(providerId: providerId, modelId: modelId, thinkingLevel: selection.thinkingLevel)
    }

    /// One step left (-1) or right (+1), skipping stops that can't run.
    func stepAgentSlider(_ direction: Int) {
        guard direction == 1 || direction == -1,
              let state = agentSliderState,
              let index = AidenAgentSliderResolver.step(state.views, from: state.position, direction: direction)
        else { return }
        selectAgentSliderStop(id: state.views[index].id)
    }

    /// Back to the home stop, when it can run.
    func resetAgentSliderToHome() {
        guard let state = agentSliderState, state.canResetToHome else { return }
        selectAgentSliderStop(id: state.views[state.homeIndex].id)
    }
}
