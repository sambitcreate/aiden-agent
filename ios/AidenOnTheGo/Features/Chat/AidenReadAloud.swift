import AVFoundation
import Observation

extension Notification.Name {
    static let aidenStopDictationForReadAloud = Notification.Name("AidenStopDictationForReadAloud")
}

@MainActor @Observable
final class AidenReadAloudPlayback {
    private(set) var activeMessageID: String?
    var errorMessage: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var cancelRemote: (() -> Void)?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    func stop() {
        generation += 1
        task?.cancel(); task = nil
        player?.stop(); player = nil
        let wasActive = activeMessageID != nil
        activeMessageID = nil
        cancelRemote?(); cancelRemote = nil
        for token in observers { NotificationCenter.default.removeObserver(token) }
        observers.removeAll()
        if wasActive { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }

    func start(client: AidenRemoteClient, chatID: String, messageID: String, current: @escaping @MainActor () -> Bool) {
        stop()
        let epoch = generation
        let requestID = UUID().uuidString
        activeMessageID = messageID; errorMessage = nil
        cancelRemote = { Task { try? await client.stopReadAloud(chatId: chatID, requestId: requestID) } }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.stop() }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            if (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                Task { @MainActor in self?.stop() }
            }
        })
        task = Task { [weak self] in
            guard let self else { return }
            @MainActor func check() throws {
                guard !Task.isCancelled, self.generation == epoch, current() else { throw CancellationError() }
            }
            defer { if self.generation == epoch { self.stop() } }
            do {
                try check()
                let status = try await client.readAloudStatus(chatId: chatID)
                try check()
                guard status.enabled, status.ready else {
                    self.errorMessage = AidenReadAloudStatus.setupGuidance; return
                }
                guard let source = status.source, source.chatId == chatID, source.messageId == messageID else { throw AidenReadAloudFailure.unavailable }
                var job = try await client.startReadAloud(chatId: chatID, request: .init(requestId: requestID, source: source, settingsRevision: status.settingsRevision))
                try check()
                let jobID = job.jobId
                var stalledPolls = 0
                while job.phase != "completed" {
                    guard job.isValid, job.chatId == chatID, job.jobId == jobID, job.phase != "cancelled", stalledPolls < AidenReadAloudJob.maximumStalledPolls else {
                        throw AidenReadAloudFailure.unavailable
                    }
                    if job.phase == "failed" {
                        self.errorMessage = job.error?.message ?? "Read Aloud could not generate this response. Check the desktop settings."
                        return
                    }
                    try await Task.sleep(for: .milliseconds(500)); try check()
                    let update = try await client.readAloudStatus(chatId: chatID)
                    try check()
                    guard update.ready, update.source?.sourceRevision == source.sourceRevision, let next = update.job else { throw AidenReadAloudFailure.unavailable }
                    stalledPolls = AidenReadAloudJob.nextStalledPollCount(previousReady: job.readySegments, currentReady: next.readySegments, stalled: stalledPolls)
                    job = next
                }
                guard job.isValid, job.chatId == chatID, job.jobId == jobID, job.readySegments == job.totalSegments else { throw AidenReadAloudFailure.invalidAudio }
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
                try AVAudioSession.sharedInstance().setActive(true)
                var totalBytes = 0
                for segment in 0..<job.totalSegments {
                    var data = Data(); var expectedTotal: Int?
                    while true {
                        let chunk = try await client.readAloudAudio(chatId: chatID, jobId: jobID, segment: segment, offset: data.count)
                        try check()
                        data.append(try chunk.validatedBytes(offset: data.count, expectedTotal: expectedTotal))
                        expectedTotal = chunk.segmentBytes
                        if chunk.complete { break }
                    }
                    totalBytes += data.count
                    guard totalBytes <= 32 * 1_024 * 1_024 else { throw AidenReadAloudFailure.invalidAudio }
                    let audio = try AVAudioPlayer(data: data)
                    self.player = audio
                    guard audio.play() else { throw AidenReadAloudFailure.invalidAudio }
                    var ticks = 0
                    while audio.isPlaying {
                        try await Task.sleep(for: .milliseconds(200)); try check()
                        ticks += 1
                        if ticks % 10 == 0 {
                            let update = try await client.readAloudStatus(chatId: chatID)
                            try check()
                            guard update.ready, update.source?.sourceRevision == source.sourceRevision, update.job?.jobId == jobID, update.job?.phase == "completed" else { throw AidenReadAloudFailure.unavailable }
                        }
                    }
                    self.player = nil
                }
            } catch is CancellationError {
                // Navigation, backgrounding and replacement never retry synthesis.
            } catch {
                if self.generation == epoch && current() { self.errorMessage = error.localizedDescription }
            }
        }
    }
}
