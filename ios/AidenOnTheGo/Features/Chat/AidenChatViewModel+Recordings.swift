import Foundation

extension AidenChatViewModel {
    // MARK: - Browser recordings (contract revision 46)

    /// The paired Mac announces `chat-browser-recordings-v1`, so an MP4
    /// browser recording can be read and played on the phone.
    var supportsBrowserRecordings: Bool {
        guard !isReadOnlyFixture, !isRemoved,
              coordinator.activeInstanceId == instanceId,
              let server = coordinator.server else { return false }
        return server.supportsChatBrowserRecordings
    }

    /// Reads one recording this chat's timeline names from the Mac and saves
    /// it to a temporary file for the player. Only an MP4 whose served type
    /// matches its recap is played.
    func browserRecording(_ recording: AidenBrowserRecordingRecap) async -> AidenBrowserRecordingLoad {
        guard supportsBrowserRecordings, recording.playsOnPhone,
              let context = try? coordinator.requestContext(for: instanceId) else { return .failed }
        do {
            let video = try await coordinator.remoteClient(for: context).browserRecording(
                chatId: chat.id,
                recordingId: recording.id
            )
            guard !isRemoved, coordinator.isCurrent(context), video.mimeType == recording.mimeType else {
                return .failed
            }
            let data = video.data
            let file = try await Task.detached(priority: .userInitiated) {
                try AidenBrowserRecordingFile.write(data, for: recording)
            }.value
            guard !isRemoved, coordinator.isCurrent(context) else {
                AidenBrowserRecordingFile.remove(file)
                return .failed
            }
            return .ready(file)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return .failed }
            return AidenBrowserRecordingLoad.failure(after: error)
        }
    }
}
