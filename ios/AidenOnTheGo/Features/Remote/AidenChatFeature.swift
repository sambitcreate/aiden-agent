import AVFoundation
import MarkdownUI
import Observation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

enum AidenAttachmentPreparationError: LocalizedError, Equatable {
    case invalidImage
    case imageTooLarge
    case invalidText
    case unsupportedTextType
    case fileTooLarge

    var errorDescription: String? {
        switch self {
        case .invalidImage: "That image could not be read."
        case .imageTooLarge: "That image is too large to attach."
        case .invalidText: "That file is not valid UTF-8 text."
        case .unsupportedTextType: "Choose an image, plain text, Markdown, CSV, JSON, XML, YAML, JavaScript, or TypeScript file."
        case .fileTooLarge: "That file is too large to attach."
        }
    }
}

enum AidenAttachmentPreparation {
    static let maximumSourceImageBytes = 32 * 1_048_576
    static let maximumImageBytes = 8 * 1_048_576
    static let maximumImageDimension: CGFloat = 16_384
    static let maximumImagePixels: CGFloat = 40_000_000
    static let maximumTextBytes = 400_000
    static let maximumTextScalars = 100_000

    static func imageUpload(data: Data, name: String) throws -> AidenAttachmentUpload {
        guard !data.isEmpty, data.count <= maximumSourceImageBytes, let image = UIImage(data: data) else {
            throw data.count > maximumSourceImageBytes
                ? AidenAttachmentPreparationError.imageTooLarge
                : AidenAttachmentPreparationError.invalidImage
        }
        let pixelWidth = image.size.width * image.scale
        let pixelHeight = image.size.height * image.scale
        guard pixelWidth.isFinite, pixelHeight.isFinite, pixelWidth > 0, pixelHeight > 0 else {
            throw AidenAttachmentPreparationError.invalidImage
        }
        guard pixelWidth <= maximumImageDimension,
              pixelHeight <= maximumImageDimension,
              pixelWidth * pixelHeight <= maximumImagePixels
        else {
            throw AidenAttachmentPreparationError.imageTooLarge
        }
        for edge in [3_072.0, 2_048.0, 1_536.0] {
            let rendered = scaled(image, maximumEdge: edge)
            for quality in [0.86, 0.72, 0.58] {
                if let encoded = rendered.jpegData(compressionQuality: quality), encoded.count <= maximumImageBytes {
                    return .image(name: safeImageName(name), mimeType: "image/jpeg", data: encoded)
                }
            }
        }
        throw AidenAttachmentPreparationError.imageTooLarge
    }

    static func textUpload(data: Data, name: String, mimeType: String) throws -> AidenAttachmentUpload {
        guard data.count <= maximumTextBytes else { throw AidenAttachmentPreparationError.fileTooLarge }
        guard let text = String(data: data, encoding: .utf8) else {
            throw AidenAttachmentPreparationError.invalidText
        }
        guard text.unicodeScalars.count <= maximumTextScalars else {
            throw AidenAttachmentPreparationError.fileTooLarge
        }
        let canonicalMimeType = try allowedTextMimeType(mimeType, name: name)
        return .text(name: safeDisplayName(name), mimeType: canonicalMimeType, text: text)
    }

    static func fileUpload(url: URL) throws -> AidenAttachmentUpload {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
        let isImage = values.contentType?.conforms(to: .image) == true
        let readLimit = isImage ? maximumSourceImageBytes : maximumTextBytes
        if isImage, let fileSize = values.fileSize, fileSize > readLimit {
            throw AidenAttachmentPreparationError.fileTooLarge
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: readLimit + 1) ?? Data()
        if isImage {
            guard data.count <= readLimit else { throw AidenAttachmentPreparationError.fileTooLarge }
            return try imageUpload(data: data, name: url.lastPathComponent)
        }
        let mimeType = try allowedTextMimeType(
            values.contentType?.preferredMIMEType ?? "text/plain",
            name: url.lastPathComponent
        )
        let readWasTruncated = data.count > maximumTextBytes || (values.fileSize ?? 0) > maximumTextBytes
        let prefix = Data(data.prefix(maximumTextBytes))
        guard let decoded = decodedUTF8Prefix(prefix, allowTrailingPartialScalar: readWasTruncated) else {
            throw AidenAttachmentPreparationError.invalidText
        }
        let suffix = "\n… [truncated]"
        let scalars = decoded.unicodeScalars
        let scalarWasTruncated = scalars.count > maximumTextScalars
        let shouldTruncate = readWasTruncated || scalarWasTruncated
        let maximumContentScalars = shouldTruncate
            ? maximumTextScalars - suffix.unicodeScalars.count
            : maximumTextScalars
        let bounded = String(String.UnicodeScalarView(scalars.prefix(maximumContentScalars)))
        return .text(
            name: safeDisplayName(url.lastPathComponent),
            mimeType: mimeType,
            text: shouldTruncate ? bounded + suffix : bounded
        )
    }

    private static func decodedUTF8Prefix(_ data: Data, allowTrailingPartialScalar: Bool) -> String? {
        if let exact = String(data: data, encoding: .utf8) { return exact }
        guard allowTrailingPartialScalar else { return nil }
        for count in 1...3 where data.count >= count {
            if let value = String(data: data.dropLast(count), encoding: .utf8) { return value }
        }
        return nil
    }

    private static func scaled(_ image: UIImage, maximumEdge: CGFloat) -> UIImage {
        let sourceSize = image.size
        let sourceEdge = max(sourceSize.width, sourceSize.height)
        guard sourceEdge > maximumEdge, sourceSize.width > 0, sourceSize.height > 0 else { return image }
        let scale = maximumEdge / sourceEdge
        let target = CGSize(
            width: max(1, floor(sourceSize.width * scale)),
            height: max(1, floor(sourceSize.height * scale))
        )
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    private static func allowedTextMimeType(_ value: String, name: String) throws -> String {
        let normalized = value.lowercased()
        let allowed: Set<String> = [
            "text/plain", "text/markdown", "text/csv", "application/json", "application/xml",
            "application/yaml", "application/x-yaml", "application/javascript", "application/typescript",
        ]
        if allowed.contains(normalized) { return normalized }
        switch URL(fileURLWithPath: name).pathExtension.lowercased() {
        case "md", "markdown": return "text/markdown"
        case "csv": return "text/csv"
        case "json": return "application/json"
        case "xml": return "application/xml"
        case "yaml", "yml": return "application/yaml"
        case "js", "jsx": return "application/javascript"
        case "ts", "tsx": return "application/typescript"
        case "txt", "swift", "m", "mm", "h", "c", "cc", "cpp", "py", "rb", "go", "rs", "java", "kt", "sh":
            return "text/plain"
        default: throw AidenAttachmentPreparationError.unsupportedTextType
        }
    }

    private static func safeImageName(_ value: String) -> String {
        let base = URL(fileURLWithPath: safeDisplayName(value)).deletingPathExtension().lastPathComponent
        return safeDisplayName("\(base.isEmpty ? "Photo" : base).jpg")
    }

    private static func safeDisplayName(_ value: String) -> String {
        let filtered = value.unicodeScalars.filter { scalar in
            scalar.value > 0x1f && scalar.value != 0x7f && scalar != "/" && scalar != "\\"
        }
        let bounded = String(String.UnicodeScalarView(filtered.prefix(255))).trimmingCharacters(in: .whitespacesAndNewlines)
        return bounded.isEmpty ? "Attachment" : bounded
    }
}

struct AidenTurnAttemptTracker {
    private var pending: (request: AidenTurnStart, key: UUID)?

    mutating func key(for request: AidenTurnStart) -> UUID {
        if let pending, pending.request == request { return pending.key }
        let key = UUID()
        pending = (request, key)
        return key
    }

    mutating func reset() {
        pending = nil
    }
}

enum AidenTurnRequestBuilder {
    static func make(
        text: String,
        providerId: String?,
        modelId: String?,
        thinkingLevel: String?,
        attachments: [AidenAttachmentReference]
    ) -> AidenTurnStart {
        AidenTurnStart(
            text: text,
            providerId: providerId,
            modelId: modelId,
            thinkingLevel: thinkingLevel,
            attachmentIds: attachments.isEmpty ? nil : attachments.map(\.id)
        )
    }
}

enum AidenChatTitleReconciliation {
    // Apple Foundation Models titles are deliberately generated off the critical
    // chat path. Keep reconciliation bounded to the server's 15-second title window.
    static let retryMilliseconds = [400, 800, 1_200, 2_000, 3_000, 3_500, 3_500]
}

@MainActor
@Observable
final class AidenWorkspaceChatsModel {
    private let coordinator: AidenRemoteCoordinator
    private let workspaceId: String
    private let cache: AidenChatCache
    private(set) var chats: [AidenChat] = []
    private(set) var isLoading = false
    private(set) var isMutating = false
    var presentedError: String?

    init(
        coordinator: AidenRemoteCoordinator,
        workspaceId: String,
        cache: AidenChatCache = .shared
    ) {
        self.coordinator = coordinator
        self.workspaceId = workspaceId
        self.cache = cache
    }

    var isConnected: Bool { coordinator.connectionState == .connected }

    func accept(_ chat: AidenChat) {
        guard chat.workspaceId == workspaceId else { return }
        upsert(chat)
    }

    func load() async {
        guard let instanceId = coordinator.activeInstanceId else { return }
        if chats.isEmpty, let cached = await cache.loadChats(instanceId: instanceId, workspaceId: workspaceId) {
            chats = cached
        }
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let remote = try await coordinator.remoteClient().chats(workspaceId: workspaceId)
            chats = Self.sorted(remote)
            try await cache.saveChats(chats, instanceId: instanceId, workspaceId: workspaceId)
        } catch {
            if chats.isEmpty { presentedError = error.localizedDescription }
        }
    }

    func create() async -> AidenChat? {
        guard !isMutating, let instanceId = coordinator.activeInstanceId else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let chat = try await coordinator.remoteClient().createChat(workspaceId: workspaceId)
            upsert(chat)
            try await persist(chat: chat, instanceId: instanceId)
            return chat
        } catch {
            presentedError = error.localizedDescription
            return nil
        }
    }

    func rename(_ chat: AidenChat, to title: String) async {
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, !isMutating, let instanceId = coordinator.activeInstanceId else { return }
        isMutating = true
        defer { isMutating = false }
        var optimistic = chat
        optimistic.title = cleaned
        upsert(optimistic)
        do {
            let updated = try await coordinator.remoteClient().updateChat(
                id: chat.id,
                revision: chat.revision,
                title: cleaned
            )
            upsert(updated)
            try await persist(chat: updated, instanceId: instanceId)
        } catch {
            upsert(chat)
            presentedError = error.localizedDescription
            await load()
        }
    }

    func remove(_ chat: AidenChat) async {
        guard !isMutating, let instanceId = coordinator.activeInstanceId else { return }
        isMutating = true
        defer { isMutating = false }
        chats.removeAll { $0.id == chat.id }
        do {
            try await coordinator.remoteClient().removeChat(id: chat.id, revision: chat.revision)
            await cache.removeChat(instanceId: instanceId, chatId: chat.id)
            try await cache.saveChats(chats, instanceId: instanceId, workspaceId: workspaceId)
        } catch {
            upsert(chat)
            presentedError = error.localizedDescription
            await load()
        }
    }

    private func upsert(_ chat: AidenChat) {
        chats.removeAll { $0.id == chat.id }
        chats.append(chat)
        chats = Self.sorted(chats)
    }

    private func persist(chat: AidenChat, instanceId: String) async throws {
        try await cache.saveChat(chat, instanceId: instanceId)
        try await cache.saveChats(chats, instanceId: instanceId, workspaceId: workspaceId)
    }

    private static func sorted(_ chats: [AidenChat]) -> [AidenChat] {
        chats.sorted {
            if $0.updatedAt == $1.updatedAt { return $0.id < $1.id }
            return $0.updatedAt > $1.updatedAt
        }
    }
}

@MainActor
@Observable
final class AidenChatViewModel {
    private let coordinator: AidenRemoteCoordinator
    private let instanceId: String
    private let cache: AidenChatCache
    private let liveActivities: AidenRemoteLiveActivityManager
    private let onChatUpdated: @MainActor (AidenChat) -> Void
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var titleRefreshTask: Task<Void, Never>?
    @ObservationIgnored private var turnAttempts = AidenTurnAttemptTracker()

    private(set) var chat: AidenChat
    private(set) var catalog: AidenModelCatalog?
    private(set) var isLoading = false
    private(set) var isStarting = false
    private(set) var streamState: AidenStreamState?
    private(set) var liveText = ""
    private(set) var reasoning = ""
    private(set) var tools: [AidenLiveTool] = []
    private(set) var timeline: [String] = []
    private(set) var pendingApproval: AidenPendingApproval?
    private(set) var pendingAttachments: [AidenAttachmentReference] = []
    private(set) var isUploadingAttachment = false
    var draft = ""
    var selectedProviderId: String?
    var selectedModelId: String?
    var selectedThinkingLevel: String?
    var presentedError: String?

    init(
        coordinator: AidenRemoteCoordinator,
        chat: AidenChat,
        cache: AidenChatCache = .shared,
        liveActivities: AidenRemoteLiveActivityManager? = nil,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in }
    ) {
        self.coordinator = coordinator
        self.chat = chat
        instanceId = coordinator.activeInstanceId ?? ""
        self.cache = cache
        self.liveActivities = liveActivities ?? .shared
        self.onChatUpdated = onChatUpdated
        selectedProviderId = chat.providerId
        selectedModelId = chat.modelId
    }

    var isConnected: Bool { coordinator.connectionState == .connected }
    var isStreaming: Bool { streamState.map { !$0.isTerminal } ?? false }
    var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty) &&
        isConnected && !isStarting && !isUploadingAttachment && !isStreaming
    }

    var selectedProvider: AidenProvider? {
        catalog?.providers.first { $0.id == selectedProviderId }
    }

    var selectedModel: AidenModel? {
        selectedProvider?.models.first { $0.id == selectedModelId }
    }

    var visibleProviders: [AidenProvider] { catalog?.visibleProviders ?? [] }

    func load() async {
        guard !instanceId.isEmpty, !isLoading else { return }
        isLoading = true
        if let cached = await cache.loadChat(instanceId: instanceId, chatId: chat.id) {
            chat = cached
        }
        defer { isLoading = false }
        do {
            async let chatRequest = coordinator.remoteClient().chat(id: chat.id)
            async let catalogRequest = coordinator.remoteClient().modelCatalog()
            let (remoteChat, remoteCatalog) = try await (chatRequest, catalogRequest)
            catalog = remoteCatalog
            await acceptRemoteChat(remoteChat)
            resolveModelSelection()
        } catch {
            if chat.messages.isEmpty { presentedError = error.localizedDescription }
        }
        await restoreStreamIfNeeded()
    }

    func selectProvider(_ providerId: String) {
        selectedProviderId = providerId
        selectedModelId = visibleProviders.first { $0.id == providerId }?.models.first?.id
        selectedThinkingLevel = selectedModel?.thinkingLevels?.first
    }

    func selectModel(_ modelId: String) {
        selectedModelId = modelId
        selectedThinkingLevel = selectedModel?.thinkingLevels?.first
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        let submittedAttachments = pendingAttachments
        let request = AidenTurnRequestBuilder.make(
            text: text,
            providerId: selectedProviderId,
            modelId: selectedModelId,
            thinkingLevel: selectedThinkingLevel,
            attachments: submittedAttachments
        )
        let previousUpdatedAt = chat.updatedAt
        let optimisticID = "local-\(UUID().uuidString.lowercased())"
        let now = Date()
        let optimisticMessage = AidenChatMessage(
            id: optimisticID,
            role: .user,
            text: text,
            attachments: submittedAttachments.map {
                AidenMessageAttachment(
                    id: $0.id,
                    name: $0.name,
                    mimeType: $0.mimeType,
                    kind: $0.kind,
                    size: $0.size
                )
            },
            createdAt: now
        )

        isStarting = true
        defer { isStarting = false }
        presentedError = nil
        draft = ""
        pendingAttachments = []
        chat.messages.append(optimisticMessage)
        chat.updatedAt = now
        streamState = .queued
        let idempotencyKey = turnAttempts.key(for: request)
        do {
            let response = try await coordinator.remoteClient().startTurn(
                chatId: chat.id,
                request: request,
                idempotencyKey: idempotencyKey
            )
            turnAttempts.reset()
            chat.messages.removeAll { $0.id == optimisticID }
            if !chat.messages.contains(where: { $0.id == response.message.id }) {
                chat.messages.append(response.message)
            }
            liveText = ""
            reasoning = ""
            tools = []
            timeline = []
            pendingApproval = nil
            streamState = .queued
            let stream = AidenChatCache.ActiveStream(
                streamId: response.streamId,
                turnId: response.turnId,
                lastSequence: 0
            )
            try? await cache.saveChat(chat, instanceId: instanceId)
            try? await cache.saveActiveStream(stream, instanceId: instanceId, chatId: chat.id)
            await liveActivities.start(
                instanceID: instanceId,
                chatID: chat.id,
                title: chat.title,
                streamID: response.streamId
            )
            startStreaming(stream)
        } catch {
            chat.messages.removeAll { $0.id == optimisticID }
            chat.updatedAt = previousUpdatedAt
            if draft.isEmpty { draft = text }
            if pendingAttachments.isEmpty { pendingAttachments = submittedAttachments }
            streamState = nil
            presentedError = error.localizedDescription
        }
    }

    func upload(_ upload: AidenAttachmentUpload) async {
        guard isConnected, !isUploadingAttachment, !isStreaming, pendingAttachments.count < 10 else { return }
        isUploadingAttachment = true
        presentedError = nil
        defer { isUploadingAttachment = false }
        do {
            let reference = try await coordinator.remoteClient().uploadAttachment(chatId: chat.id, upload: upload)
            guard reference.isValid() else {
                throw AidenRemoteClientError.invalidResponse
            }
            pendingAttachments.append(reference)
        } catch {
            presentedError = error.localizedDescription
        }
    }

    func removeAttachment(_ attachment: AidenAttachmentReference) async {
        pendingAttachments.removeAll { $0.id == attachment.id }
        do {
            try await coordinator.remoteClient().removeAttachment(chatId: chat.id, attachmentId: attachment.id)
        } catch {
            // The reference is short lived and server cleanup is automatic. Local removal remains authoritative for the composer.
        }
    }

    func stop() async {
        guard let stream = await cache.loadActiveStream(instanceId: instanceId, chatId: chat.id) else { return }
        let previousState = streamState
        streamState = .cancelled
        do {
            streamState = try await coordinator.remoteClient().cancelStream(id: stream.streamId).state
        } catch {
            streamState = previousState
            presentedError = error.localizedDescription
        }
    }

    func respondToApproval(_ decision: AidenApprovalDecision) async {
        guard let approval = pendingApproval, approval.expiresAt > Date() else {
            pendingApproval = nil
            return
        }
        let previousState = streamState
        pendingApproval = nil
        streamState = .running
        do {
            _ = try await coordinator.remoteClient().respondToApproval(id: approval.id, decision: decision)
        } catch {
            pendingApproval = approval
            streamState = previousState
            presentedError = error.localizedDescription
        }
    }

    private func resolveModelSelection() {
        guard let catalog else { return }
        if selectedProviderId == nil || !catalog.providers.contains(where: { $0.id == selectedProviderId }) {
            selectedProviderId = catalog.defaults["providerId"] ?? catalog.visibleProviders.first?.id
        }
        if selectedModelId == nil || selectedProvider?.models.contains(where: { $0.id == selectedModelId }) != true {
            selectedModelId = catalog.defaults["modelId"] ?? selectedProvider?.visibleModels.first?.id
        }
        if selectedThinkingLevel == nil { selectedThinkingLevel = selectedModel?.thinkingLevels?.first }
    }

    private func restoreStreamIfNeeded() async {
        guard let stream = await cache.loadActiveStream(instanceId: instanceId, chatId: chat.id) else { return }
        do {
            let status = try await coordinator.remoteClient().streamStatus(id: stream.streamId)
            streamState = status.state
            if status.state.isTerminal {
                await liveActivities.updateStatus(streamID: stream.streamId, state: status.state)
                await reconcileChat()
                await cache.removeActiveStream(instanceId: instanceId, chatId: chat.id)
            } else {
                await liveActivities.start(
                    instanceID: instanceId,
                    chatID: chat.id,
                    title: chat.title,
                    streamID: stream.streamId
                )
                await liveActivities.updateStatus(streamID: stream.streamId, state: status.state)
                startStreaming(stream)
            }
        } catch {
            presentedError = error.localizedDescription
            await liveActivities.markStale(streamID: stream.streamId)
        }
    }

    private func startStreaming(_ stream: AidenChatCache.ActiveStream) {
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            await self?.consume(stream)
        }
    }

    private func consume(_ original: AidenChatCache.ActiveStream) async {
        var stream = original
        while !Task.isCancelled {
            do {
                let events = try coordinator.remoteClient().streamEvents(
                    id: stream.streamId,
                    after: stream.lastSequence
                )
                for try await event in events {
                    try Task.checkCancellation()
                    guard event.streamId == stream.streamId else { continue }
                    if event.sequence <= stream.lastSequence { continue }
                    if event.sequence != stream.lastSequence + 1 {
                        await reconcileChat()
                    }
                    stream.lastSequence = event.sequence
                    try await cache.saveActiveStream(stream, instanceId: instanceId, chatId: chat.id)
                    await apply(event)
                    if event.terminal { return }
                }

                let status = try await coordinator.remoteClient().streamStatus(id: stream.streamId)
                streamState = status.state
                await liveActivities.updateStatus(streamID: stream.streamId, state: status.state)
                if status.state.isTerminal {
                    await finishStream()
                    return
                }
                try await Task.sleep(for: .milliseconds(500))
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                do {
                    let status = try await coordinator.remoteClient().streamStatus(id: stream.streamId)
                    streamState = status.state
                    await liveActivities.updateStatus(streamID: stream.streamId, state: status.state)
                    if status.state.isTerminal {
                        await finishStream()
                        return
                    }
                    try await Task.sleep(for: .seconds(1))
                } catch is CancellationError {
                    return
                } catch {
                    presentedError = error.localizedDescription
                    await liveActivities.markStale(streamID: stream.streamId)
                    return
                }
            }
        }
    }

    private func apply(_ event: AidenRemoteStreamEvent) async {
        guard event.shouldApply, let payload = event.payload else { return }
        switch event.type {
        case .snapshot:
            streamState = .reconciling
            await reconcileChat()
        case .status:
            if let value = payload.state, let state = AidenStreamState(rawValue: value) {
                streamState = state
                await liveActivities.updateStatus(streamID: event.streamId, state: state)
            }
        case .textDelta:
            liveText += payload.text ?? ""
            streamState = .running
            await liveActivities.appendResponse(payload.text ?? "", streamID: event.streamId)
        case .reasoningDelta:
            reasoning += payload.text ?? ""
            await liveActivities.reasoning(streamID: event.streamId)
        case .toolStarted:
            if let id = payload.toolId, let name = payload.name {
                tools.append(AidenLiveTool(id: id, name: name, status: nil))
            }
            await liveActivities.toolStarted(name: payload.name, streamID: event.streamId)
        case .toolFinished:
            if let id = payload.toolId, let index = tools.firstIndex(where: { $0.id == id }) {
                tools[index].status = payload.status
            }
            await liveActivities.toolFinished(streamID: event.streamId)
        case .timeline:
            if let label = payload.label, timeline.last != label { timeline.append(label) }
        case .approvalRequired:
            if let id = payload.approvalId, let summary = payload.summary, let expiresAt = payload.expiresAt {
                pendingApproval = AidenPendingApproval(id: id, summary: summary, expiresAt: expiresAt)
                streamState = .waitingForApproval
                await liveActivities.approvalRequired(streamID: event.streamId)
            }
        case .error:
            presentedError = payload.message ?? "Aiden could not finish this response."
            streamState = .error
            await liveActivities.finish(
                streamID: event.streamId,
                status: .failed,
                message: String(localized: "Response failed"),
                errorSummary: payload.message
            )
            await finishStream()
        case .cancelled:
            streamState = .cancelled
            await liveActivities.finish(
                streamID: event.streamId,
                status: .cancelled,
                message: String(localized: "Response cancelled")
            )
            await finishStream()
        case .done:
            streamState = .done
            await liveActivities.finish(
                streamID: event.streamId,
                status: .complete,
                message: String(localized: "Response complete")
            )
            await finishStream()
        case .heartbeat:
            break
        default:
            break
        }
    }

    private func reconcileChat() async {
        do {
            let remote = try await coordinator.remoteClient().chat(id: chat.id)
            await acceptRemoteChat(remote)
        } catch {
            presentedError = error.localizedDescription
        }
    }

    private func acceptRemoteChat(_ remote: AidenChat, scheduleTitleRefresh: Bool = true) async {
        chat = remote
        try? await cache.saveChat(remote, instanceId: instanceId)
        onChatUpdated(remote)
        if scheduleTitleRefresh, remote.isTitlePending {
            schedulePendingTitleRefresh()
        }
    }

    private func schedulePendingTitleRefresh() {
        guard titleRefreshTask == nil else { return }
        titleRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer { titleRefreshTask = nil }
            for delay in AidenChatTitleReconciliation.retryMilliseconds {
                do {
                    try await Task.sleep(for: .milliseconds(delay))
                    let remote = try await coordinator.remoteClient().chat(id: chat.id)
                    await acceptRemoteChat(remote, scheduleTitleRefresh: false)
                    if !remote.isTitlePending { return }
                } catch is CancellationError {
                    return
                } catch {
                    // A transient local-network interruption should not surface after a
                    // successful reply. The next normal refresh remains authoritative.
                    continue
                }
            }
        }
    }

    private func finishStream() async {
        await reconcileChat()
        liveText = ""
        reasoning = ""
        tools = []
        timeline = []
        pendingApproval = nil
        await cache.removeActiveStream(instanceId: instanceId, chatId: chat.id)
    }
}

struct AidenWorkspaceChatsView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Environment(\.aidenPalette) private var palette
    let workspace: AidenWorkspace
    @State private var model: AidenWorkspaceChatsModel
    @State private var createdChat: AidenChat?
    @State private var renameChat: AidenChat?
    @State private var renameTitle = ""
    @State private var deleteChat: AidenChat?

    init(coordinator: AidenRemoteCoordinator, workspace: AidenWorkspace) {
        self.coordinator = coordinator
        self.workspace = workspace
        _model = State(initialValue: AidenWorkspaceChatsModel(coordinator: coordinator, workspaceId: workspace.id))
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(workspace.name).font(.title2.bold())
                    Label(workspace.permission.detail, systemImage: "checkmark.shield")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }

            Section("Chats") {
                if model.chats.isEmpty, !model.isLoading {
                    ContentUnavailableView(
                        "No Chats",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Start a chat in this workspace to control Aiden Agent.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(model.chats) { chat in
                        NavigationLink {
                            AidenChatDetailView(
                                coordinator: coordinator,
                                chat: chat,
                                onChatUpdated: { model.accept($0) }
                            )
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(chat.title).lineLimit(1)
                                AidenRelativeTimestampView(date: chat.updatedAt)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { deleteChat = chat } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button { beginRename(chat) } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            .tint(.accentColor)
                        }
                        .contextMenu {
                            Button { beginRename(chat) } label: { Label("Rename", systemImage: "pencil") }
                            Button(role: .destructive) { deleteChat = chat } label: { Label("Delete", systemImage: "trash") }
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .overlay { if model.isLoading && model.chats.isEmpty { ProgressView() } }
        .refreshable { await model.load() }
        .task(id: coordinator.activeInstanceId) { await model.load() }
        .navigationDestination(isPresented: Binding(
            get: { createdChat != nil },
            set: { if !$0 { createdChat = nil } }
        )) {
            if let createdChat {
                AidenChatDetailView(
                    coordinator: coordinator,
                    chat: createdChat,
                    onChatUpdated: { model.accept($0) }
                )
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { createdChat = await model.create() }
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .disabled(!model.isConnected || model.isMutating)
                .accessibilityLabel("New chat")
            }
        }
        .alert("Rename Chat", isPresented: Binding(
            get: { renameChat != nil },
            set: { if !$0 { renameChat = nil } }
        )) {
            TextField("Chat title", text: $renameTitle)
            Button("Cancel", role: .cancel) { renameChat = nil }
            Button("Save") {
                guard let chat = renameChat else { return }
                renameChat = nil
                Task { await model.rename(chat, to: renameTitle) }
            }
        }
        .confirmationDialog("Delete this chat?", isPresented: Binding(
            get: { deleteChat != nil },
            set: { if !$0 { deleteChat = nil } }
        ), titleVisibility: .visible) {
            Button("Delete Chat", role: .destructive) {
                guard let chat = deleteChat else { return }
                deleteChat = nil
                Task { await model.remove(chat) }
            }
            Button("Cancel", role: .cancel) { deleteChat = nil }
        } message: {
            Text("This permanently removes the chat from Aiden Agent.")
        }
        .alert("Aiden On The Go", isPresented: Binding(
            get: { model.presentedError != nil },
            set: { if !$0 { model.presentedError = nil } }
        )) {
            Button("OK", role: .cancel) { model.presentedError = nil }
        } message: {
            Text(model.presentedError ?? "The operation could not be completed.")
        }
    }

    private func beginRename(_ chat: AidenChat) {
        renameTitle = chat.title
        renameChat = chat
    }
}

struct AidenChatDetailView: View {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenPalette) private var palette
    @State private var model: AidenChatViewModel
    @State private var speechPlayback = AidenSpeechPlaybackController()
    @State private var composerHeight: CGFloat = 132
    @FocusState private var composerIsFocused: Bool
    @Bindable private var coordinator: AidenRemoteCoordinator
    let autoStartVoice: Bool

    init(
        coordinator: AidenRemoteCoordinator,
        chat: AidenChat,
        autoStartVoice: Bool = false,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in }
    ) {
        self.coordinator = coordinator
        _model = State(initialValue: AidenChatViewModel(
            coordinator: coordinator,
            chat: chat,
            onChatUpdated: onChatUpdated
        ))
        self.autoStartVoice = autoStartVoice
    }

    private var workspace: AidenWorkspace? {
        coordinator.workspaces.first { $0.id == model.chat.workspaceId }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(model.chat.messages) { message in
                            AidenMessageView(message: message, speechPlayback: speechPlayback)
                        }
                        if model.isStreaming || !model.liveText.isEmpty {
                            AidenLiveResponseView(model: model)
                        }
                        Color.clear
                            .frame(height: max(96, composerHeight + 12))
                            .accessibilityHidden(true)
                        Color.clear.frame(height: 1).id("chat-bottom")
                    }
                    .padding(.horizontal)
                    .padding(.top, 20)
                }
                .scrollDismissesKeyboard(.interactively)
                .simultaneousGesture(
                    TapGesture().onEnded {
                        composerIsFocused = false
                    }
                )
                .onChange(of: model.chat.messages.count) { _, _ in scrollToBottom(proxy) }
                .onChange(of: model.liveText) { _, _ in scrollToBottom(proxy) }
            }

            AidenComposerView(
                model: model,
                autoStartVoice: autoStartVoice,
                composerFocus: $composerIsFocused
            )
                .padding(.horizontal)
                .padding(.bottom, 10)
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: AidenComposerHeightPreferenceKey.self,
                            value: proxy.size.height
                        )
                    }
                }
        }
        .background(palette.canvas.ignoresSafeArea())
        .onPreferenceChange(AidenComposerHeightPreferenceKey.self) { height in
            guard height > 0 else { return }
            composerHeight = height
        }
        .navigationTitle(model.chat.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let workspace, workspace.hasFolder {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        AidenWorkspaceFilesView(coordinator: coordinator, workspace: workspace)
                    } label: {
                        Label("Files", systemImage: "folder")
                    }
                    .accessibilityLabel("Workspace files")
                }
            }
        }
        .task { await model.load() }
        .alert("Aiden On The Go", isPresented: Binding(
            get: { model.presentedError != nil },
            set: { if !$0 { model.presentedError = nil } }
        )) {
            Button("OK", role: .cancel) { model.presentedError = nil }
        } message: {
            Text(model.presentedError ?? "The operation could not be completed.")
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
            proxy.scrollTo("chat-bottom", anchor: .bottom)
        }
    }
}

private struct AidenComposerHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 132

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct AidenMessageView: View {
    @Environment(\.aidenPalette) private var palette
    let message: AidenChatMessage
    let speechPlayback: AidenSpeechPlaybackController

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if message.role == .user {
                Spacer(minLength: 48)
                messageContent
            } else {
                messageContent
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .layoutPriority(1)
            }
        }
        .frame(maxWidth: .infinity)
        .contextMenu {
            if let copyText = AidenMessageActionContent.copyText(for: message) {
                Button {
                    UIPasteboard.general.string = copyText
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
            }
        }
        .accessibilityActions {
            if let copyText = AidenMessageActionContent.copyText(for: message) {
                Button("Copy response") {
                    UIPasteboard.general.string = copyText
                }
            }
        }
        .accessibilityElement(children: message.role == .assistant ? .contain : .combine)
        .accessibilityLabel(message.role == .user ? "You" : "Aiden")
    }

    private var messageContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !message.text.isEmpty {
                AidenMessageTextView(role: message.role, content: message.text)
            }
            if let attachments = message.attachments, !attachments.isEmpty {
                ForEach(attachments) { attachment in
                    Label {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(attachment.name).lineLimit(1)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                                .foregroundStyle(palette.secondary)
                        }
                    } icon: {
                        Image(systemName: attachment.kind == .image ? "photo" : "doc.text")
                    }
                    .font(.caption)
                    .accessibilityElement(children: .combine)
                }
            }
            if message.role == .assistant, !message.text.isEmpty {
                Button {
                    speechPlayback.speak(message.text)
                } label: {
                    Label("Read aloud", systemImage: "speaker.wave.2")
                }
                .font(.caption)
                .buttonStyle(.plain)
                .foregroundStyle(palette.secondary)
            }
        }
        .padding(message.role == .user ? 12 : 0)
        .background(message.role == .user ? palette.raised : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

enum AidenMessageActionContent {
    static func copyText(for message: AidenChatMessage) -> String? {
        guard message.role == .assistant, !message.text.isEmpty else { return nil }
        return message.text
    }
}

struct AidenMessageTextView: View {
    let role: AidenChatRole
    let content: String

    @ViewBuilder
    var body: some View {
        if role == .assistant {
            AidenMarkdownView(content: content)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(verbatim: content)
                .font(.body)
                .textSelection(.enabled)
        }
    }
}

enum AidenMarkdownFallbackReason: Equatable {
    case tooManyCharacters
    case tooManyLines
}

enum AidenMarkdownRenderingPolicy {
    static let maximumCharacterCount = 80_000
    static let maximumLineCount = 2_000

    static func fallbackReason(for content: String) -> AidenMarkdownFallbackReason? {
        if content.count > maximumCharacterCount { return .tooManyCharacters }

        var lineCount = 1
        var previousWasCarriageReturn = false
        for scalar in content.unicodeScalars {
            switch scalar.value {
            case 0x0A:
                if !previousWasCarriageReturn { lineCount += 1 }
                previousWasCarriageReturn = false
            case 0x0D:
                lineCount += 1
                previousWasCarriageReturn = true
            case 0x2028, 0x2029:
                lineCount += 1
                previousWasCarriageReturn = false
            default:
                previousWasCarriageReturn = false
            }
            if lineCount > maximumLineCount { return .tooManyLines }
        }
        return nil
    }
}

enum AidenMarkdownDocument {
    static func plainText(from content: String) -> String {
        MarkdownContent(content).renderPlainText()
    }
}

struct AidenMarkdownView: View {
    @Environment(\.colorScheme) private var colorScheme
    let content: String

    var body: some View {
        Group {
            if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(verbatim: " ")
            } else if AidenMarkdownRenderingPolicy.fallbackReason(for: content) != nil {
                Text(verbatim: content)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                MarkdownUI.Markdown(content)
                    .markdownTheme(.aidenChat(colorScheme: colorScheme))
                    .markdownImageProvider(AidenMarkdownNoNetworkImageProvider())
                    .markdownCodeSyntaxHighlighter(.plainText)
                    .markdownTextStyle {
                        ForegroundColor(.primary)
                        BackgroundColor(nil)
                    }
                    .markdownTextStyle(\.code) {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.88))
                        BackgroundColor(Color(.tertiarySystemGroupedBackground))
                    }
                    .markdownBlockStyle(\.paragraph) { configuration in
                        configuration.label
                            .fixedSize(horizontal: false, vertical: true)
                            .relativeLineSpacing(.em(0.18))
                            .markdownMargin(top: 0, bottom: 8)
                    }
            }
        }
        .textSelection(.enabled)
    }
}

private struct AidenMarkdownNoNetworkImageProvider: ImageProvider {
    func makeImage(url: URL?) -> some View {
        EmptyView()
    }
}

private extension MarkdownUI.Theme {
    static func aidenChat(colorScheme: ColorScheme) -> MarkdownUI.Theme {
        MarkdownUI.Theme.gitHub
            .text {
                ForegroundColor(.primary)
                BackgroundColor(nil)
                FontSize(16)
            }
            .code {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.85))
                BackgroundColor(
                    colorScheme == .dark
                        ? Color(red: 0.08, green: 0.09, blue: 0.12)
                        : Color(.tertiarySystemGroupedBackground)
                )
            }
    }
}

private struct AidenLiveResponseView: View {
    @Environment(\.aidenPalette) private var palette
    @Bindable var model: AidenChatViewModel

    private var activity: (label: String, orb: OrbState) {
        if model.streamState == .waitingForApproval {
            return ("Waiting for approval", .listening)
        }
        if let tool = model.tools.last(where: { $0.status == nil }) {
            let name = tool.name.lowercased()
            let isSearch = ["search", "find", "read", "list", "glob", "grep"]
                .contains { name.contains($0) }
            return (isSearch ? "Searching…" : "Working…", isSearch ? .searching : .working)
        }
        if !model.liveText.isEmpty {
            return ("Responding…", .composing)
        }
        if model.streamState == .queued {
            return ("Preparing…", .shaping)
        }
        return ("Thinking…", .solving)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.isStreaming {
                HStack(spacing: 8) {
                    ThinkingOrb(state: activity.orb, size: .px20)
                    Text(model.timeline.last ?? activity.label)
                        .foregroundStyle(palette.secondary)
                }
                .font(.callout)
                .accessibilityElement(children: .combine)
            }

            if !model.reasoning.isEmpty {
                AidenReasoningCard(text: model.reasoning)
            }

            if !model.tools.isEmpty {
                AidenToolActivityCard(tools: model.tools)
            }

            if let approval = model.pendingApproval {
                AidenApprovalCard(
                    summary: approval.summary,
                    onDeny: { Task { await model.respondToApproval(.deny) } },
                    onAllow: { Task { await model.respondToApproval(.allow) } }
                )
            }

            if !model.liveText.isEmpty {
                AidenMarkdownView(content: model.liveText)
                    .contextMenu {
                        Button {
                            UIPasteboard.general.string = model.liveText
                        } label: {
                            Label("Copy", systemImage: "doc.on.doc")
                        }
                    }
                    .accessibilityActions {
                        Button("Copy response") {
                            UIPasteboard.general.string = model.liveText
                        }
                    }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct AidenApprovalCard: View {
    @Environment(\.aidenPalette) private var palette

    let summary: String
    let onDeny: () -> Void
    let onAllow: () -> Void

    private let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "shield")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(palette.warning)
                    .frame(width: 32, height: 32)
                    .background(palette.warning.opacity(0.12), in: Circle())
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Approval needed")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.foreground)

                    Text("Review this one action before Aiden continues.")
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Text(summary)
                .font(.caption.monospaced())
                .foregroundStyle(palette.foreground)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(palette.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            HStack(spacing: 8) {
                Spacer(minLength: 0)

                Button(action: onDeny) {
                    Text("Deny")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                        .padding(.horizontal, 13)
                        .frame(height: 34)
                        .aidenApprovalActionGlass()
                }
                .buttonStyle(.plain)
                .padding(.vertical, 5)

                Button(action: onAllow) {
                    Text("Allow once")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.canvas)
                        .padding(.horizontal, 13)
                        .frame(height: 34)
                        .aidenApprovalActionGlass(tint: palette.accent)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 5)
            }
        }
        .padding(12)
        .background(palette.raised, in: shape)
        .overlay(shape.stroke(palette.foreground.opacity(0.08), lineWidth: 0.5))
        .shadow(color: palette.foreground.opacity(0.08), radius: 8, y: 3)
        .accessibilityElement(children: .contain)
    }
}

private struct AidenApprovalActionGlassModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    let tint: Color?

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *), !reduceTransparency {
            if let tint {
                content.glassEffect(.regular.tint(tint).interactive(), in: Capsule())
            } else {
                content.glassEffect(.regular.interactive(), in: Capsule())
            }
        } else if let tint {
            content.background(tint, in: Capsule())
        } else if reduceTransparency {
            content
                .background(palette.canvas, in: Capsule())
                .overlay(Capsule().stroke(palette.foreground.opacity(0.14), lineWidth: 0.5))
        } else {
            content
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().stroke(palette.foreground.opacity(0.10), lineWidth: 0.5))
        }
    }
}

private extension View {
    func aidenApprovalActionGlass(tint: Color? = nil) -> some View {
        modifier(AidenApprovalActionGlassModifier(tint: tint))
    }
}

private struct AidenReasoningCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let text: String
    @State private var isExpanded = false

    private var summary: String {
        let oneLine = text.replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return oneLine.count > 80 ? "\(oneLine.prefix(80))…" : oneLine
    }

    var body: some View {
        VStack(alignment: .leading, spacing: isExpanded ? 8 : 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    AidenSidebarLogo(size: 18, color: palette.secondary)
                    Text("Thinking").font(.caption.weight(.semibold))
                    Text(summary).font(.caption).foregroundStyle(palette.secondary).lineLimit(1)
                    Spacer(minLength: 6)
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Text(text)
                    .font(.caption)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

private struct AidenToolActivityCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let tools: [AidenLiveTool]
    @State private var isExpanded = false

    private var isComplete: Bool { tools.allSatisfy { $0.status != nil } }
    private var summary: String {
        let names = Array(Set(tools.map(\.name))).sorted()
        let visible = names.prefix(3).joined(separator: ", ")
        return names.count > 3 ? "\(visible), +\(names.count - 3)" : visible
    }

    var body: some View {
        VStack(alignment: .leading, spacing: isExpanded ? 8 : 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isComplete ? "checkmark.circle.fill" : "wrench.and.screwdriver.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(palette.secondary)
                        .frame(width: 18, height: 18)
                    Text(isComplete ? "Tools used" : "Using tools")
                        .font(.caption.weight(.semibold))
                    Text(summary).font(.caption).foregroundStyle(palette.secondary).lineLimit(1)
                    Spacer(minLength: 6)
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(tools) { tool in
                        HStack(spacing: 8) {
                            Image(systemName: tool.status == nil ? "circle.dotted" : "checkmark.circle")
                            Text(tool.name).lineLimit(1)
                            Spacer()
                            Text(tool.status ?? "Running").foregroundStyle(palette.secondary)
                        }
                        .font(.caption)
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

private struct AidenComposerView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Bindable var model: AidenChatViewModel
    let autoStartVoice: Bool
    let composerFocus: FocusState<Bool>.Binding
    @State private var voiceInput = ComposerVoiceInputController()
    @State private var didAutoStartVoice = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var isPhotoPickerPresented = false
    @State private var isFileImporterPresented = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !model.pendingAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.pendingAttachments) { attachment in
                            HStack(spacing: 6) {
                                Label(attachment.name, systemImage: attachment.kind == .image ? "photo" : "doc.text")
                                    .lineLimit(1)
                                Button {
                                    Task { await model.removeAttachment(attachment) }
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Remove \(attachment.name)")
                            }
                            .font(.caption)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(palette.raised, in: Capsule())
                        }
                    }
                }
                .accessibilityLabel("Attachments")
            }

            TextField("Message Aiden", text: $model.draft, axis: .vertical)
                .lineLimit(1...6)
                .padding(.horizontal, 4)
                .padding(.top, 5)
                .focused(composerFocus)
                .submitLabel(.send)
                .onSubmit {
                    guard !model.isStreaming else { return }
                    voiceInput.stopBeforeSubmittingDraft()
                    Task { await model.send() }
                }

            HStack(alignment: .center, spacing: 10) {
                AidenUIKitMenuButton {
                    if model.isUploadingAttachment {
                        ProgressView().controlSize(.small).frame(width: 44, height: 44)
                    } else {
                        Image(systemName: "plus")
                            .font(.title3.weight(.medium))
                            .frame(width: 44, height: 44)
                    }
                } menu: {
                    attachmentMenu()
                }
                .disabled(!model.isConnected || model.isStreaming || model.isUploadingAttachment || model.pendingAttachments.count >= 10)
                .accessibilityLabel("Add attachment")
                .accessibilityHint("Attach an image or bounded text file")
                .photosPicker(
                    isPresented: $isPhotoPickerPresented,
                    selection: $selectedPhoto,
                    matching: .images
                )

                if !model.visibleProviders.isEmpty {
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
                                                        Label(level.capitalized, systemImage: "checkmark")
                                                    } else {
                                                        Text(level.capitalized)
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
                } else if let selectedModel = model.selectedModel {
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

                Button {
                    Task {
                        await voiceInput.toggle(currentDraft: model.draft) { model.draft = $0 }
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
                .disabled(model.isStreaming || voiceInput.isRequestingPermission)
                .accessibilityLabel(voiceInput.isListening ? "Stop voice input" : "Start voice input")

                if model.isStreaming {
                    Button { Task { await model.stop() } } label: {
                        Image(systemName: "stop.fill")
                            .frame(width: 30, height: 30)
                            .background(palette.foreground, in: Circle())
                            .foregroundStyle(palette.canvas)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Stop response")
                } else {
                    Button {
                        voiceInput.stopBeforeSubmittingDraft()
                        Task { await model.send() }
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.headline.bold())
                            .frame(width: 30, height: 30)
                            .background(sendButtonBackground, in: Circle())
                            .foregroundStyle(sendButtonForeground)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .disabled(!model.canSend)
                    .accessibilityLabel("Send message")
                }
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
        }
        .shadow(color: .black.opacity(0.12), radius: 14, y: 6)
        .task {
            guard autoStartVoice, !didAutoStartVoice else { return }
            didAutoStartVoice = true
            await voiceInput.toggle(currentDraft: model.draft) { model.draft = $0 }
        }
        .onChange(of: selectedPhoto) { _, item in
            guard let item else { return }
            Task {
                defer { selectedPhoto = nil }
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else {
                        throw AidenAttachmentPreparationError.invalidImage
                    }
                    let upload = try await Task.detached(priority: .userInitiated) {
                        try AidenAttachmentPreparation.imageUpload(data: data, name: "Photo.jpg")
                    }.value
                    await model.upload(upload)
                } catch {
                    model.presentedError = error.localizedDescription
                }
            }
        }
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.image, .plainText, .sourceCode, .json, .xml, .commaSeparatedText],
            allowsMultipleSelection: false
        ) { result in
            Task {
                do {
                    let urls = try result.get()
                    guard let url = urls.first else {
                        throw AidenAttachmentPreparationError.unsupportedTextType
                    }
                    let upload = try await Task.detached(priority: .userInitiated) {
                        try AidenAttachmentPreparation.fileUpload(url: url)
                    }.value
                    await model.upload(upload)
                } catch {
                    model.presentedError = error.localizedDescription
                }
            }
        }
        .onDisappear { voiceInput.stopKeepingTranscript() }
    }

    private func attachmentMenu() -> UIMenu {
        UIMenu(children: [
            UIAction(
                title: String(localized: "Photo Library"),
                image: UIImage(systemName: "photo.on.rectangle")
            ) { _ in
                Task { @MainActor in
                    composerFocus.wrappedValue = false
                    isPhotoPickerPresented = true
                }
            },
            UIAction(
                title: String(localized: "Choose File"),
                image: UIImage(systemName: "doc")
            ) { _ in
                Task { @MainActor in
                    composerFocus.wrappedValue = false
                    isFileImporterPresented = true
                }
            },
        ])
    }

    private var sendButtonBackground: Color {
        if model.canSend { return palette.accent }
        return palette.foreground.opacity(colorScheme == .dark ? 0.18 : 0.12)
    }

    private var sendButtonForeground: Color {
        model.canSend ? palette.canvas : palette.secondary
    }

    private var selectedModelAccessibilityValue: String {
        guard let selectedModel = model.selectedModel else { return "Not selected" }
        guard let level = model.selectedThinkingLevel,
              selectedModel.thinkingLevels?.isEmpty == false
        else { return selectedModel.label }
        return "\(selectedModel.label), \(level.capitalized) thinking"
    }

    private func select(_ candidate: AidenModel, providerId: String, thinkingLevel: String?) {
        model.selectProvider(providerId)
        model.selectModel(candidate.id)
        model.selectedThinkingLevel = thinkingLevel
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

private struct AidenUIKitMenuButton<Label: View>: View {
    @Environment(\.isEnabled) private var isEnabled

    private let menu: () -> UIMenu
    private let label: Label

    init(
        @ViewBuilder label: () -> Label,
        menu: @escaping () -> UIMenu
    ) {
        self.label = label()
        self.menu = menu
    }

    var body: some View {
        label
            .opacity(isEnabled ? 1 : 0.62)
            .overlay {
                AidenUIKitMenuButtonBacker(menu: menu)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
    }
}

private struct AidenUIKitMenuButtonBacker: UIViewControllerRepresentable {
    @Environment(\.isEnabled) private var isEnabled
    let menu: () -> UIMenu

    func makeCoordinator() -> Coordinator {
        Coordinator(menu: menu)
    }

    func makeUIViewController(context: Context) -> AidenMenuButtonHostController {
        let controller = AidenMenuButtonHostController()
        let button = controller.button
        button.menu = UIMenu(children: [
            UIDeferredMenuElement.uncached { completion in
                completion(context.coordinator.menu().children)
            },
        ])
        button.isEnabled = isEnabled
        button.isAccessibilityElement = false
        return controller
    }

    func updateUIViewController(_ controller: AidenMenuButtonHostController, context: Context) {
        context.coordinator.menu = menu
        controller.button.isEnabled = isEnabled
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiViewController: AidenMenuButtonHostController,
        context: Context
    ) -> CGSize? {
        CGSize(
            width: proposal.width ?? UIView.noIntrinsicMetric,
            height: proposal.height ?? UIView.noIntrinsicMetric
        )
    }

    final class Coordinator {
        var menu: () -> UIMenu

        init(menu: @escaping () -> UIMenu) {
            self.menu = menu
        }
    }
}

private final class AidenMenuButtonHostController: UIViewController {
    let button = UIButton(type: .custom)

    override func loadView() {
        let container = UIView()
        container.backgroundColor = .clear
        container.isOpaque = false
        view = container

        button.showsMenuAsPrimaryAction = true
        button.backgroundColor = .clear
        button.setTitle(nil, for: .normal)
        button.setImage(nil, for: .normal)
        button.translatesAutoresizingMaskIntoConstraints = false

        container.addSubview(button)
        NSLayoutConstraint.activate([
            button.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            button.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            button.topAnchor.constraint(equalTo: container.topAnchor),
            button.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }
}

private struct AidenComposerGlassModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    private let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *), !reduceTransparency {
            content.glassEffect(.regular.interactive(), in: shape)
        } else if reduceTransparency {
            content.background(palette.raised, in: shape)
        } else {
            content.background(.regularMaterial, in: shape)
        }
    }
}

private extension View {
    func aidenComposerGlass() -> some View {
        modifier(AidenComposerGlassModifier())
    }
}

@MainActor
final class AidenSpeechPlaybackController {
    private let synthesizer = AVSpeechSynthesizer()

    func speak(_ text: String) {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        let utterance = AVSpeechUtterance(string: String(cleaned.prefix(8_000)))
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.language.languageCode?.identifier)
        synthesizer.speak(utterance)
    }
}
