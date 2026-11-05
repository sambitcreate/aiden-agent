import Foundation

extension AidenChatViewModel {
    // MARK: - Visual viewer (contract revision 35)

    /// The paired Mac announces `chat-visual-viewer-v1`, so a visual opens
    /// full screen and interactive instead of in the image viewer. Before any
    /// live `/server` answer (a cold start without the Mac), a pairing with
    /// saved documents keeps them openable; a live answer always decides.
    var supportsVisualViewer: Bool {
        guard !isReadOnlyFixture, !isRemoved,
              coordinator.activeInstanceId == instanceId else { return false }
        if let server = coordinator.server { return server.supportsChatVisualViewer }
        return hasSavedVisualDocuments
    }

    /// Reads whether this pairing has saved viewer documents.
    func refreshSavedVisualDocuments() async {
        guard !isReadOnlyFixture, !instanceId.isEmpty else { return }
        let instanceId = instanceId
        let saved = await visualDocumentCache.hasDocuments(instanceId: instanceId)
        guard !isRemoved, self.instanceId == instanceId else { return }
        hasSavedVisualDocuments = saved
    }

    /// The viewer page for one visual in the phone's scheme and theme. A
    /// fresh page refreshes the offline copy; when the Mac can't be reached,
    /// the last copy stands in.
    func visualDocument(
        visualId: String,
        appearance: AidenVisualViewerAppearance
    ) async -> AidenVisualDocumentLoad {
        let unavailable = AidenVisualDocumentLoad.failed(
            String(localized: "This visual can't be opened right now.")
        )
        guard supportsVisualViewer,
              let context = try? coordinator.requestContext(for: instanceId) else { return unavailable }
        let key = AidenVisualDocumentCache.Key(
            instanceId: instanceId,
            deviceId: context.deviceId,
            chatId: chat.id,
            visualId: visualId,
            appearance: appearance
        )
        do {
            let html = try await coordinator.remoteClient(for: context).visualDocument(
                chatId: chat.id,
                visualId: visualId,
                scheme: appearance.scheme.rawValue,
                theme: appearance.theme.rawValue
            )
            guard !isRemoved, coordinator.isCurrent(context) else { return unavailable }
            if await visualDocumentCache.store(html, for: key) { hasSavedVisualDocuments = true }
            return .live(html)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return unavailable }
            guard !isRemoved, coordinator.isCurrent(context) else { return unavailable }
            if AidenVisualDocumentLoad.fallsBackToCache(after: error),
               let cached = await visualDocumentCache.load(key) {
                return .cached(cached)
            }
            return .failed(AidenVisualDocumentLoad.failureMessage(for: error))
        }
    }

    /// Adds a follow-up the person confirmed in the viewer to the composer.
    /// It is never sent by itself.
    @discardableResult
    func appendVisualPrompt(_ prompt: String) -> Bool {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isReadOnlyPresentation, !text.isEmpty else { return false }
        draft = AidenVisualViewerMessage.draft(appending: text, to: draft)
        return true
    }
}
