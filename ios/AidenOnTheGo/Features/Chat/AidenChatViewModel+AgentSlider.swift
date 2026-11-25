import Foundation

extension AidenChatViewModel {
    // MARK: - Agent Slider (contract revision 69)

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
        return AidenAgentSliderState(
            slider: slider,
            catalog: catalog,
            selection: turnModelSelection,
            chosenStopId: agentSliderChosenStopId
        )
    }

    /// Puts the chat on a stop: its provider, model and level exactly. A stop
    /// that can't run does nothing.
    func selectAgentSliderStop(id: String) {
        guard let state = agentSliderState,
              let selection = state.views.first(where: { $0.id == id })?.turnSelection,
              let providerId = selection.providerId,
              let modelId = selection.modelId else { return }
        agentSliderChosenStopId = id
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

    /// Whether the slider sheet is open, wherever the chat's views are.
    var isAgentSliderPresented: Bool {
        get { agentSliderPresentation.isPresented }
        set { agentSliderPresentation.isPresented = newValue }
    }
}

/// Who shows the Agent Slider sheet. An iPhone Duo fold builds the chat's
/// views again, so for a moment an old view and a new one both present it,
/// in no set order. The newest view to appear owns the sheet; only its own
/// close, outside the shell's swap, is the person closing it.
struct AidenAgentSliderPresentationState: Equatable, Sendable {
    var isPresented = false
    private(set) var presenter: UUID?

    /// A view that can present the sheet appeared; it shows it from now on.
    mutating func appeared(_ id: UUID) {
        presenter = id
    }

    /// A view left. A sheet it was showing stays open for the next view.
    mutating func disappeared(_ id: UUID) {
        if presenter == id { presenter = nil }
    }

    func isShown(by id: UUID) -> Bool {
        isPresented && presenter == id
    }

    /// A view's sheet closed. It was the person closing it only from the
    /// view that owns it, and not while the shell swaps its containers.
    mutating func closed(by id: UUID, whileRebuilding: Bool) {
        guard presenter == id, !whileRebuilding else { return }
        isPresented = false
    }
}
