import Accessibility
import CryptoKit
import ImageIO
import MarkdownUI
import Observation
import Photos
import SwiftUI
import UIKit
import UniformTypeIdentifiers

enum AidenStreamFeedbackPolicy: Equatable, Sendable {
    case localTurn
    case restoredStream

    var allowsFeedback: Bool { self == .localTurn }
}

enum AidenImageSendRecovery: Equatable {
    case proceed
    case configureBotVision
    case chooseImageCapableModel
}

func aidenImageSendRecovery(
    isBotChat: Bool,
    acceptsImages: Bool,
    hasPendingImage: Bool
) -> AidenImageSendRecovery {
    guard hasPendingImage, !acceptsImages else { return .proceed }
    return isBotChat ? .configureBotVision : .chooseImageCapableModel
}

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
        try Task.checkCancellation()
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
        if data.count <= maximumImageBytes {
            if AidenAttachmentImageValidation.validatedData(
                data,
                mimeType: "image/png",
                declaredSize: data.count
            ) != nil {
                return .image(name: safeImageName(name, extension: "png"), mimeType: "image/png", data: data)
            }
            if AidenAttachmentImageValidation.validatedData(
                data,
                mimeType: "image/jpeg",
                declaredSize: data.count
            ) != nil {
                return .image(name: safeImageName(name, extension: "jpg"), mimeType: "image/jpeg", data: data)
            }
        }
        let preserveAlpha = hasAlpha(image)
        for edge in [3_072.0, 2_048.0, 1_536.0, 1_024.0] {
            try Task.checkCancellation()
            let rendered = scaled(image, maximumEdge: edge, preserveAlpha: preserveAlpha)
            if preserveAlpha,
               let encoded = rendered.pngData(),
               encoded.count <= maximumImageBytes {
                return .image(name: safeImageName(name, extension: "png"), mimeType: "image/png", data: encoded)
            }
            guard !preserveAlpha else { continue }
            for quality in [0.86, 0.72, 0.58] {
                try Task.checkCancellation()
                if let encoded = rendered.jpegData(compressionQuality: quality), encoded.count <= maximumImageBytes {
                    return .image(name: safeImageName(name, extension: "jpg"), mimeType: "image/jpeg", data: encoded)
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

    static func fileUpload(
        url: URL,
        preferredName: String? = nil,
        forceImage: Bool = false
    ) throws -> AidenAttachmentUpload {
        try Task.checkCancellation()
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
        let isImage = forceImage || values.contentType?.conforms(to: .image) == true
        let displayName = preferredName ?? url.lastPathComponent
        let readLimit = isImage ? maximumSourceImageBytes : maximumTextBytes
        if isImage, let fileSize = values.fileSize, fileSize > readLimit {
            throw AidenAttachmentPreparationError.fileTooLarge
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: readLimit + 1) ?? Data()
        try Task.checkCancellation()
        if isImage {
            guard data.count <= readLimit else { throw AidenAttachmentPreparationError.fileTooLarge }
            return try imageUpload(data: data, name: displayName)
        }
        let mimeType = try allowedTextMimeType(
            values.contentType?.preferredMIMEType ?? "text/plain",
            name: displayName
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
            name: safeDisplayName(displayName),
            mimeType: mimeType,
            text: shouldTruncate ? bounded + suffix : bounded
        )
    }

    static func fileUploadAsync(
        url: URL,
        preferredName: String? = nil,
        forceImage: Bool = false
    ) async throws -> AidenAttachmentUpload {
        let worker = Task.detached(priority: .userInitiated) {
            try fileUpload(url: url, preferredName: preferredName, forceImage: forceImage)
        }
        return try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: {
            worker.cancel()
        }
    }

    static func imageUploadAsync(data: Data, name: String) async throws -> AidenAttachmentUpload {
        let worker = Task.detached(priority: .userInitiated) {
            try imageUpload(data: data, name: name)
        }
        return try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: {
            worker.cancel()
        }
    }

    private static func decodedUTF8Prefix(_ data: Data, allowTrailingPartialScalar: Bool) -> String? {
        if let exact = String(data: data, encoding: .utf8) { return exact }
        guard allowTrailingPartialScalar else { return nil }
        for count in 1...3 where data.count >= count {
            if let value = String(data: data.dropLast(count), encoding: .utf8) { return value }
        }
        return nil
    }

    private static func scaled(_ image: UIImage, maximumEdge: CGFloat, preserveAlpha: Bool) -> UIImage {
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
        format.opaque = !preserveAlpha
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    static func hasAlpha(_ image: UIImage) -> Bool {
        guard let alphaInfo = image.cgImage?.alphaInfo else { return true }
        return [.first, .last, .premultipliedFirst, .premultipliedLast].contains(alphaInfo)
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

    private static func safeImageName(_ value: String, extension pathExtension: String) -> String {
        let base = URL(fileURLWithPath: safeDisplayName(value)).deletingPathExtension().lastPathComponent
        return safeDisplayName("\(base.isEmpty ? "Photo" : base).\(pathExtension)")
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

struct AidenChatModelSelection: Equatable {
    let providerId: String?
    let modelId: String?
    let thinkingLevel: String?
}

enum AidenChatModelAuthority {
    static func resolvedSelection(
        chat: AidenChat,
        catalog: AidenModelCatalog?,
        selectedProviderId: String?,
        selectedModelId: String?,
        selectedThinkingLevel: String?
    ) -> AidenChatModelSelection {
        if chat.isBotChat {
            let provider = catalog?.providers.first { $0.id == chat.providerId }
            let model = provider?.models.first { $0.id == chat.modelId }
            return AidenChatModelSelection(
                providerId: chat.providerId,
                modelId: chat.modelId,
                thinkingLevel: model?.effectiveThinkingLevel
            )
        }

        guard let catalog else {
            return AidenChatModelSelection(
                providerId: selectedProviderId,
                modelId: selectedModelId,
                thinkingLevel: selectedThinkingLevel
            )
        }
        var providerId = selectedProviderId
        if providerId == nil || !catalog.providers.contains(where: { $0.id == providerId }) {
            providerId = catalog.defaults["providerId"] ?? catalog.visibleProviders.first?.id
        }
        let provider = catalog.providers.first { $0.id == providerId }
        var modelId = selectedModelId
        if modelId == nil || provider?.models.contains(where: { $0.id == modelId }) != true {
            modelId = catalog.defaults["modelId"] ?? provider?.visibleModels.first?.id
        }
        let model = provider?.models.first { $0.id == modelId }
        return AidenChatModelSelection(
            providerId: providerId,
            modelId: modelId,
            thinkingLevel: selectedThinkingLevel ?? model?.effectiveThinkingLevel
        )
    }

    static func turnSelection(
        chat: AidenChat,
        selectedProviderId: String?,
        selectedModelId: String?,
        selectedThinkingLevel: String?
    ) -> AidenChatModelSelection {
        AidenChatModelSelection(
            providerId: chat.isBotChat ? chat.providerId : selectedProviderId,
            modelId: chat.isBotChat ? chat.modelId : selectedModelId,
            thinkingLevel: selectedThinkingLevel
        )
    }
}

enum AidenChatTitleReconciliation {
    // Apple Foundation Models titles are deliberately generated off the critical
    // chat path. Keep reconciliation bounded to the server's 15-second title window.
    static let retryMilliseconds = [400, 800, 1_200, 2_000, 3_000, 3_500, 3_500]
}

struct AidenTerminalReplayGate {
    private(set) var hasReplayedTerminalCursor = false

    mutating func shouldReplay(_ state: AidenStreamState) -> Bool {
        guard state.isTerminal, !hasReplayedTerminalCursor else { return false }
        hasReplayedTerminalCursor = true
        return true
    }
}

enum AidenTerminalReconciliation {
    static func retryDelayMilliseconds(attempt: Int) -> Int {
        let safeAttempt = max(0, min(attempt, 5))
        return min(30_000, 1_000 * (1 << safeAttempt))
    }

    static func isDefinitiveMissingStream(_ error: Error) -> Bool {
        guard let clientError = error as? AidenRemoteClientError else { return false }
        guard case .server(let statusCode, let body) = clientError, statusCode == 404 else {
            return false
        }
        return body.code.rawValue == "stream_gone" || body.code.rawValue == "not_found"
    }
}

enum AidenAttachmentGalleryWindow {
    static func contains(index: Int, selectedIndex: Int, count: Int) -> Bool {
        guard count > 0,
              (0..<count).contains(index),
              (0..<count).contains(selectedIndex)
        else { return false }
        return abs(index - selectedIndex) <= 1
    }
}

enum AidenInlineCardDeckLayout {
    static let viewportAspectRatio: CGFloat = 1
    static let singleImageCornerRadius: CGFloat = 16
    static let cardCornerRadius: CGFloat = 18
    static let edgeResistance: CGFloat = 0.22
    static let selectedCardDragMultiplier: CGFloat = 0.88

    static func resistedTranslation(
        current: Int,
        count: Int,
        translation: CGFloat
    ) -> CGFloat {
        guard count > 1 else { return 0 }
        let isPastLeadingEdge = current <= 0 && translation > 0
        let isPastTrailingEdge = current >= count - 1 && translation < 0
        return isPastLeadingEdge || isPastTrailingEdge
            ? translation * edgeResistance
            : translation
    }

    static func dragProgress(translation: CGFloat, width: CGFloat) -> CGFloat {
        guard width > 0 else { return 0 }
        return min(max(-translation / width, -1), 1)
    }

    static func selectedCardOffset(translation: CGFloat) -> CGFloat {
        translation * selectedCardDragMultiplier
    }

    static func preferredBackgroundIndex(
        selection: Int,
        count: Int,
        translation: CGFloat
    ) -> Int? {
        guard count > 1, (0..<count).contains(selection) else { return nil }
        let preferred = translation > 0 ? selection - 1 : selection + 1
        if (0..<count).contains(preferred) { return preferred }
        let fallback = translation > 0 ? selection + 1 : selection - 1
        return (0..<count).contains(fallback) ? fallback : nil
    }

    static func isVisible(index: Int, selection: Int, count: Int) -> Bool {
        guard count > 1,
              (0..<count).contains(index),
              (0..<count).contains(selection)
        else { return false }
        return abs(index - selection) <= 1
    }

    static func resolvedSelection(
        current: Int,
        count: Int,
        translation: CGFloat,
        predictedTranslation: CGFloat
    ) -> Int {
        guard count > 1 else { return 0 }
        let effectiveTranslation = abs(predictedTranslation) > abs(translation)
            ? predictedTranslation
            : translation
        guard abs(translation) >= 44 || abs(effectiveTranslation) >= 80 else {
            return min(max(current, 0), count - 1)
        }
        let direction = effectiveTranslation < 0 ? 1 : -1
        return min(max(current + direction, 0), count - 1)
    }
}

enum AidenMessageMediaEdge: Equatable {
    case leading
    case trailing

    static func forRole(_ role: AidenChatRole) -> Self {
        role == .user ? .trailing : .leading
    }

    var alignment: Alignment {
        self == .trailing ? .trailing : .leading
    }

    var scaleAnchor: UnitPoint {
        self == .trailing ? .trailing : .leading
    }

    var rotationAnchor: UnitPoint {
        self == .trailing ? .bottomTrailing : .bottomLeading
    }

    var backgroundRotationDegrees: Double {
        self == .trailing ? -1.8 : 1.8
    }
}

enum AidenMessageContentSurface {
    case text
    case imageAttachment
    case fallbackAttachment

    static func usesRaisedBubble(role: AidenChatRole, content: Self) -> Bool {
        guard role == .user else { return false }
        return content != .imageAttachment
    }
}

enum AidenChatPresentationStyle: Equatable {
    case workspace
    case botMessages

    init(chat: AidenChat) {
        self = chat.isBotChat ? .botMessages : .workspace
    }
}

struct AidenBotReplyProjection: Equatable {
    let finalText: String
    let progressText: String

    static func resolve(
        text: String,
        timeline: AidenGenerationTimeline?,
        isActive: Bool
    ) -> Self {
        let cleanedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedText.isEmpty else {
            return Self(finalText: "", progressText: "")
        }
        guard !isActive,
              let timeline,
              let boundary = timeline.steps
                .filter({ $0.kind == .tool })
                .compactMap(\.contentOffset)
                .max(),
              let splitIndex = stringIndex(atUTF16Offset: boundary, in: text)
        else {
            return isActive
                ? Self(finalText: "", progressText: deduplicatedProgress(text))
                : Self(finalText: cleanedText, progressText: "")
        }

        let progress = String(text[..<splitIndex])
        let final = String(text[splitIndex...])
        return Self(
            finalText: final.trimmingCharacters(in: .whitespacesAndNewlines),
            progressText: deduplicatedProgress(progress)
        )
    }

    private static func stringIndex(atUTF16Offset offset: Int, in text: String) -> String.Index? {
        guard offset >= 0, offset <= text.utf16.count else { return nil }
        var candidate = text.utf16.index(text.utf16.startIndex, offsetBy: offset)
        while candidate > text.utf16.startIndex {
            if let index = String.Index(candidate, within: text) { return index }
            candidate = text.utf16.index(before: candidate)
        }
        return text.startIndex
    }

    private static func deduplicatedProgress(_ text: String) -> String {
        var seen = Set<String>()
        let paragraphs = text.components(separatedBy: "\n\n")
        return paragraphs.compactMap { paragraph in
            let cleaned = paragraph.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleaned.isEmpty else { return nil }
            let identity = cleaned
                .split(whereSeparator: \.isWhitespace)
                .joined(separator: " ")
            guard seen.insert(identity).inserted else { return nil }
            return cleaned
        }
        .joined(separator: "\n\n")
    }
}

func aidenMessagesJoin(
    _ previous: AidenChatMessage?,
    _ message: AidenChatMessage,
    maximumGap: TimeInterval = 60
) -> Bool {
    guard let previous,
          previous.role == message.role,
          previous.attachments?.isEmpty != false,
          message.attachments?.isEmpty != false,
          previous.outcome == nil,
          message.outcome == nil else { return false }
    let gap = message.createdAt.timeIntervalSince(previous.createdAt)
    return gap >= 0 && gap <= maximumGap
}

struct AidenBotMessageBubbleShape: Shape {
    func path(in rect: CGRect) -> Path {
        Path(roundedRect: rect, cornerRadius: 18, style: .continuous)
    }
}

private struct AidenBotHeaderNameGlassModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *), !reduceTransparency {
            content.glassEffect(.regular.interactive(), in: Capsule())
        } else if reduceTransparency {
            content
                .background(palette.raised, in: Capsule())
                .overlay(Capsule().stroke(palette.foreground.opacity(0.16), lineWidth: 0.5))
        } else {
            content
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().stroke(palette.foreground.opacity(0.10), lineWidth: 0.5))
        }
    }
}

private extension View {
    func aidenBotHeaderNameGlass() -> some View {
        modifier(AidenBotHeaderNameGlassModifier())
    }
}

enum AidenMissingStreamResolution: Equatable {
    case complete
    case failed
    case cancelled
    case interrupted

    static func resolve(messages: [AidenChatMessage]) -> Self {
        guard let userIndex = messages.lastIndex(where: { $0.role == .user }),
              userIndex < messages.index(before: messages.endIndex),
              let assistant = messages[messages.index(after: userIndex)...]
                .first(where: { $0.role == .assistant })
        else { return .interrupted }
        switch assistant.outcome?.status {
        case .cancelled: return .cancelled
        case .failed: return .failed
        case nil: return .complete
        }
    }
}

enum AidenStreamFeedbackDecision {
    static func announcesApproval(_ policy: AidenStreamFeedbackPolicy) -> Bool {
        policy.allowsFeedback
    }

    static func terminalEvent(
        for resolution: AidenMissingStreamResolution,
        policy: AidenStreamFeedbackPolicy
    ) -> AidenHapticEvent? {
        guard policy.allowsFeedback else { return nil }
        switch resolution {
        case .failed, .interrupted: return .error
        case .complete, .cancelled: return nil
        }
    }
}

@MainActor
@Observable
final class AidenWorkspaceChatsModel {
    private let coordinator: AidenRemoteCoordinator
    private let workspaceId: String
    private let cache: AidenChatCache
    private let hapticScope: UUID
    private let onChatUpdated: @MainActor (AidenChat) -> Void
    private let onChatRemoved: @MainActor (String) -> Void
    private(set) var chats: [AidenChat] = []
    private(set) var isLoading = false
    private(set) var isMutating = false
    var presentedError: String?

    init(
        coordinator: AidenRemoteCoordinator,
        workspaceId: String,
        hapticScope: UUID = UUID(),
        cache: AidenChatCache = .shared,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatRemoved: @escaping @MainActor (String) -> Void = { _ in }
    ) {
        self.coordinator = coordinator
        self.workspaceId = workspaceId
        self.hapticScope = hapticScope
        self.cache = cache
        self.onChatUpdated = onChatUpdated
        self.onChatRemoved = onChatRemoved
    }

    var isConnected: Bool { coordinator.connectionState == .connected }

    func setHapticsActive(_ active: Bool) {
        if active {
            coordinator.haptics.activate(scope: hapticScope)
        } else {
            coordinator.haptics.deactivate(scope: hapticScope)
        }
    }

    func accept(_ chat: AidenChat) {
        guard chat.workspaceId == workspaceId, !chat.isBotChat else { return }
        upsert(chat)
    }

    func load() async {
        guard let context = try? coordinator.requestContext() else { return }
        let instanceId = context.instanceId
        if chats.isEmpty, let cached = await cache.loadChats(instanceId: instanceId, workspaceId: workspaceId) {
            guard coordinator.isCurrent(context) else { return }
            chats = Self.sorted(AidenChat.regularWorkspaceChats(from: cached))
        }
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let remote = try await coordinator.remoteClient(for: context).chats(workspaceId: workspaceId)
            guard coordinator.isCurrent(context) else { return }
            chats = Self.sorted(AidenChat.regularWorkspaceChats(from: remote))
            try await cache.saveChats(chats, instanceId: instanceId, workspaceId: workspaceId)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            if chats.isEmpty { presentedError = error.localizedDescription }
        }
    }

    func create() async -> AidenChat? {
        guard !isMutating, let context = try? coordinator.requestContext() else { return nil }
        let instanceId = context.instanceId
        isMutating = true
        defer { isMutating = false }
        do {
            let chat = try await coordinator.remoteClient(for: context).createChat(workspaceId: workspaceId)
            guard coordinator.isCurrent(context) else { return nil }
            guard !chat.isBotChat else {
                presentedError = String(localized: "Aiden returned a conversation that is unavailable in Workspaces.")
                return nil
            }
            upsert(chat)
            try? await persist(chat: chat, instanceId: instanceId)
            onChatUpdated(chat)
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-create:\(chat.id):\(chat.revision)")
            return chat
        } catch let error where aidenIsCancellation(error) {
            return nil
        } catch {
            guard coordinator.isCurrent(context) else { return nil }
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            return nil
        }
    }

    func rename(_ chat: AidenChat, to title: String) async {
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, !isMutating, let context = try? coordinator.requestContext() else { return }
        let instanceId = context.instanceId
        isMutating = true
        defer { isMutating = false }
        var optimistic = chat
        optimistic.title = cleaned
        upsert(optimistic)
        do {
            let updated = try await coordinator.remoteClient(for: context).updateChat(
                id: chat.id,
                revision: chat.revision,
                title: cleaned
            )
            guard coordinator.isCurrent(context) else { return }
            upsert(updated)
            try? await persist(chat: updated, instanceId: instanceId)
            onChatUpdated(updated)
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-rename:\(updated.id):\(updated.revision)")
        } catch let error where aidenIsCancellation(error) {
            guard coordinator.isCurrent(context) else { return }
            upsert(chat)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            upsert(chat)
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            await load()
        }
    }

    func remove(_ chat: AidenChat) async {
        guard !isMutating, let context = try? coordinator.requestContext() else { return }
        let instanceId = context.instanceId
        isMutating = true
        defer { isMutating = false }
        chats.removeAll { $0.id == chat.id }
        do {
            try await coordinator.remoteClient(for: context).removeChat(id: chat.id, revision: chat.revision)
            guard coordinator.isCurrent(context) else { return }
            await cache.removeChat(instanceId: instanceId, chatId: chat.id)
            await AidenChatDraftStore.shared.remove(instanceId: instanceId, chatId: chat.id)
            try? await cache.saveChats(chats, instanceId: instanceId, workspaceId: workspaceId)
            onChatRemoved(chat.id)
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-remove:\(chat.id):\(chat.revision)")
        } catch let error where aidenIsCancellation(error) {
            guard coordinator.isCurrent(context) else { return }
            upsert(chat)
        } catch {
            guard coordinator.isCurrent(context) else { return }
            upsert(chat)
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            await load()
        }
    }

    private func upsert(_ chat: AidenChat) {
        guard !chat.isBotChat else { return }
        chats.removeAll { $0.id == chat.id }
        chats.append(chat)
        chats = Self.sorted(chats)
    }

    private func persist(chat: AidenChat, instanceId: String) async throws {
        try await cache.saveChat(chat, instanceId: instanceId)
        try await cache.saveChats(chats, instanceId: instanceId, workspaceId: workspaceId)
        try await cache.reconcileChatSummary(chat, instanceId: instanceId)
    }

    private static func sorted(_ chats: [AidenChat]) -> [AidenChat] {
        chats.sorted {
            if $0.updatedAt == $1.updatedAt { return $0.id < $1.id }
            return $0.updatedAt > $1.updatedAt
        }
    }
}

enum AidenDraftSendReconciliation {
    static func failedDraft(submitted: String, current: String) -> String {
        guard !current.isEmpty else { return submitted }
        guard current != submitted else { return current }
        return "\(submitted)\n\n\(current)"
    }

    static func failedAttachments(
        submitted: [AidenAttachmentReference],
        current: [AidenAttachmentReference]
    ) -> [AidenAttachmentReference] {
        var seen = Set<String>()
        return (submitted + current).filter { seen.insert($0.id).inserted }
    }
}

@MainActor
@Observable
final class AidenChatViewModel {
    private enum Runtime {
        case live(
            coordinator: AidenRemoteCoordinator,
            instanceId: String,
            cache: AidenChatCache,
            liveActivities: AidenRemoteLiveActivityManager
        )
#if DEBUG
        case readOnlyFixture
#endif
    }

    private let runtime: Runtime
    private var allowsMutations: Bool
    private let onChatUpdated: @MainActor (AidenChat) -> Void
    private let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void
    private let draftStore: AidenChatDraftStore
    private let hapticScope: UUID
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var progressTask: Task<Void, Never>?
    @ObservationIgnored private var progressObservationGeneration: UInt64 = 0
    @ObservationIgnored private var titleRefreshTask: Task<Void, Never>?
    @ObservationIgnored private var terminalReconciliationTask: Task<Void, Never>?
    @ObservationIgnored private var activeStreamID: String?
    @ObservationIgnored private var turnAttempts = AidenTurnAttemptTracker()
    @ObservationIgnored private var draftSession: AidenChatDraftStore.Session?
    @ObservationIgnored private var draftPersistenceTask: Task<Void, Never>?
    @ObservationIgnored private var suppressesDraftPersistence = false
    @ObservationIgnored private var draftGeneration: UInt64 = 0
    @ObservationIgnored private var composerGeneration: UInt64 = 0
    @ObservationIgnored private var attachmentPreparationTask: Task<Void, Never>?
    private var attachmentPreparationID: UUID?
    var isPreparingAttachments: Bool { attachmentPreparationID != nil }

    private(set) var chat: AidenChat
    private(set) var catalog: AidenModelCatalog?
    private(set) var isLoading = false
    private(set) var isStarting = false
    private(set) var streamState: AidenStreamState? {
        didSet {
            let wasActive = oldValue.map { !$0.isTerminal } ?? false
            let isActive = streamState.map { !$0.isTerminal } ?? false
            guard wasActive != isActive else { return }
            onChatActivityChanged(chat.id, isActive ? .active : .idle)
        }
    }
    private(set) var liveText = ""
    private(set) var reasoning = ""
    private(set) var tools: [AidenLiveTool] = []
    private(set) var activityTimeline: AidenGenerationTimeline?
    private var approvalSnapshotGeneration: UInt64 = 0
    private var approvalSnapshotInFlight: (streamID: String, context: AidenRemoteRequestContext, approval: AidenPendingApproval?, state: AidenStreamState?)?
    private(set) var pendingApproval: AidenPendingApproval?
    private(set) var isRespondingToApproval = false
    private(set) var isStopping = false
    private(set) var pendingAttachments: [AidenAttachmentReference] = [] {
        didSet {
            if pendingAttachments != oldValue { composerGeneration &+= 1 }
        }
    }
    private(set) var isUploadingAttachment = false
    private(set) var taskProgress: AidenRemoteChatTaskProgress?
    private(set) var agentRoster: AidenRemoteChatAgentRoster?
    private(set) var historicalAgentRosters: [AidenRemoteChatAgentRoster] = []
    private(set) var isTaskProgressStale = false
    private(set) var isAgentRosterStale = false
    var isProgressStale: Bool { isTaskProgressStale || isAgentRosterStale }
    var isProgressObservationRunning: Bool { progressTask != nil }
    var draft = "" {
        didSet {
            guard draft != oldValue else { return }
            draftGeneration &+= 1
            composerGeneration &+= 1
            guard !suppressesDraftPersistence else { return }
            scheduleDraftPersistence()
        }
    }
    var selectedProviderId: String?
    var selectedModelId: String?
    var selectedThinkingLevel: String?
    var presentedError: String?

    private var isReadOnlyFixture: Bool {
#if DEBUG
        if case .readOnlyFixture = runtime { return true }
#endif
        return false
    }

    var isReadOnlyPresentation: Bool { isReadOnlyFixture || !allowsMutations }

    func setAllowsMutations(_ allowed: Bool) {
        guard !isReadOnlyFixture else { return }
        allowsMutations = allowed
        if !allowed {
            draftPersistenceTask?.cancel()
            draftPersistenceTask = nil
            cancelAttachmentPreparation()
        }
    }

    private var coordinator: AidenRemoteCoordinator {
        guard case .live(let coordinator, _, _, _) = runtime else {
            preconditionFailure("Read-only fixture chats have no remote coordinator")
        }
        return coordinator
    }

    private var instanceId: String {
        guard case .live(_, let instanceId, _, _) = runtime else {
            preconditionFailure("Read-only fixture chats have no installation identity")
        }
        return instanceId
    }

    private var cache: AidenChatCache {
        guard case .live(_, _, let cache, _) = runtime else {
            preconditionFailure("Read-only fixture chats have no persistent cache")
        }
        return cache
    }

    private var liveActivities: AidenRemoteLiveActivityManager {
        guard case .live(_, _, _, let liveActivities) = runtime else {
            preconditionFailure("Read-only fixture chats have no Live Activity runtime")
        }
        return liveActivities
    }

    init(
        coordinator: AidenRemoteCoordinator,
        chat: AidenChat,
        hapticScope: UUID = UUID(),
        cache: AidenChatCache = .shared,
        draftStore: AidenChatDraftStore = .shared,
        liveActivities: AidenRemoteLiveActivityManager? = nil,
        allowsMutations: Bool = true,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in }
    ) {
        runtime = .live(
            coordinator: coordinator,
            instanceId: coordinator.activeInstanceId ?? "",
            cache: cache,
            liveActivities: liveActivities ?? .shared
        )
        self.chat = chat
        self.allowsMutations = allowsMutations
        self.draftStore = draftStore
        self.hapticScope = hapticScope
        self.onChatUpdated = onChatUpdated
        self.onChatActivityChanged = onChatActivityChanged
        selectedProviderId = chat.providerId
        selectedModelId = chat.modelId
    }

#if DEBUG
    init(readOnlyFixture chat: AidenChat) {
        runtime = .readOnlyFixture
        self.chat = chat
        allowsMutations = false
        draftStore = .shared
        hapticScope = UUID()
        onChatUpdated = { _ in }
        onChatActivityChanged = { _, _ in }
        selectedProviderId = chat.providerId
        selectedModelId = chat.modelId
    }
#endif

    deinit {
        streamTask?.cancel()
        progressTask?.cancel()
        titleRefreshTask?.cancel()
        terminalReconciliationTask?.cancel()
        draftPersistenceTask?.cancel()
        attachmentPreparationTask?.cancel()
    }

    var isConnected: Bool {
        guard !isReadOnlyFixture else { return false }
        return coordinator.connectionState == .connected
    }
    var isStreaming: Bool { streamState.map { !$0.isTerminal } ?? false }
    var canSend: Bool {
        guard !isReadOnlyPresentation else { return false }
        return (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty) &&
        isConnected && coordinator.activeInstanceId == instanceId
            && !isStarting && !isPreparingAttachments && !isUploadingAttachment && !isStreaming && hasTurnModelAuthority
    }

    var selectedProvider: AidenProvider? {
        catalog?.providers.first { $0.id == selectedProviderId }
    }

    var selectedModel: AidenModel? {
        selectedProvider?.models.first { $0.id == selectedModelId }
    }

    var visibleProviders: [AidenProvider] { catalog?.visibleProviders ?? [] }
    var usesPersistedBotModelAuthority: Bool { chat.isBotChat }
    var showsComposerModelControl: Bool { !chat.isBotChat }
    private(set) var botPrimarySupportsImages: Bool?
    private(set) var botVisionModelSelection: AidenBotModelSelection?
    var needsBotVisionSetup = false
    var acceptsImageAttachments: Bool {
        if chat.isBotChat {
            return botPrimarySupportsImages == true || botVisionModelSelection != nil
        }
        return selectedModel?.acceptsImageInput ?? true
    }
    var selectedModelDisplayLabel: String { selectedModel?.label ?? selectedModelId ?? "Model unavailable" }

    func transcribeMacSpeech(_ pcm16: Data) async throws -> String {
        guard !isReadOnlyFixture else { throw AidenRemoteClientError.invalidResponse }
        let context = try coordinator.requestContext(for: instanceId)
        let client = try coordinator.remoteClient(for: context)
        let status = try await client.speechStatus()
        guard status.engine.ready else {
            throw NSError(
                domain: "AidenVoiceInput",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: status.engine.error ?? String(localized: "The Mac speech engine is unavailable.")]
            )
        }
        guard let model = status.models.first(where: { $0.id == status.selectedModelId && $0.installed })
            ?? status.models.first(where: { $0.installed && $0.recommended })
            ?? status.models.first(where: { $0.installed }) else {
            throw NSError(
                domain: "AidenVoiceInput",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: String(localized: "Download a Mac speech model in App Settings before using this option.")]
            )
        }
        if status.selectedModelId != model.id { _ = try await client.selectSpeechModel(model.id) }
        let result = try await client.transcribeSpeech(pcm16: pcm16, modelId: model.id)
        guard coordinator.isCurrent(context) else { throw CancellationError() }
        return result.text
    }

    private var turnModelSelection: AidenChatModelSelection {
        AidenChatModelAuthority.turnSelection(
            chat: chat,
            selectedProviderId: selectedProviderId,
            selectedModelId: selectedModelId,
            selectedThinkingLevel: selectedThinkingLevel
        )
    }

    private var hasTurnModelAuthority: Bool {
        !chat.isBotChat
            || (turnModelSelection.providerId != nil && turnModelSelection.modelId != nil)
    }

    func setHapticsActive(_ active: Bool) {
        if active {
            coordinator.haptics.activate(scope: hapticScope)
        } else {
            coordinator.haptics.deactivate(scope: hapticScope)
        }
    }

    func load(observeProgress: Bool = true) async {
        guard !isReadOnlyFixture else { return }
        guard !instanceId.isEmpty, !isLoading else { return }
        guard let context = try? coordinator.requestContext(for: instanceId) else {
            clearProgressState()
            return
        }
        let observationGeneration = progressObservationGeneration
        isLoading = true
        defer { isLoading = false }
        if draftSession == nil {
            let restorationGeneration = composerGeneration
            let session = await draftStore.beginSession(instanceId: instanceId, chatId: chat.id)
            guard coordinator.isCurrent(context) else { return }
            draftSession = session
            if draft.isEmpty, pendingAttachments.isEmpty, !isPreparingAttachments, !isUploadingAttachment, !isStarting,
               let savedDraft = await draftStore.load(session: session) {
                guard coordinator.isCurrent(context), draftSession == session else { return }
                // Disk access yields the main actor while the composer remains
                // editable. Text edits, uploads, attachment removal and Send
                // must all win over restoring the previous composer's text.
                if composerGeneration == restorationGeneration, draft.isEmpty {
                    draft = savedDraft
                }
            }
        }
        if let cached = await cache.loadChat(instanceId: instanceId, chatId: chat.id) {
            guard coordinator.isCurrent(context) else { return }
            chat = cached
            resolveModelSelection()
        }
        do {
            async let chatRequest = coordinator.remoteClient(for: context).chat(id: chat.id)
            async let catalogRequest = coordinator.remoteClient(for: context).modelCatalog()
            let (remoteChat, remoteCatalog) = try await (chatRequest, catalogRequest)
            guard coordinator.isCurrent(context) else { return }
            catalog = remoteCatalog
            await acceptRemoteChat(remoteChat, context: context)
        } catch {
            clearProgressStateIfCredentialRevoked(error)
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            if chat.messages.isEmpty { presentedError = error.localizedDescription }
        }
        guard coordinator.isCurrent(context) else { return }
        await restoreStreamIfNeeded()
        guard observeProgress,
              isCurrentProgressObservation(observationGeneration, context: context) else { return }
        await loadProgressSnapshot(
            context: context,
            observationGeneration: observationGeneration
        )
        guard isCurrentProgressObservation(observationGeneration, context: context) else { return }
        startProgressObservation()
    }

    var canReadTaskProgress: Bool {
        guard let server = coordinator.server,
              server.supportsChatTasks,
              let installation = coordinator.installationStore.activeInstallation else { return false }
        return installation.hasNegotiatedAccess(to: .tasksRead)
    }

    var canReadAgentRoster: Bool {
        guard let server = coordinator.server,
              server.supportsChatAgents,
              let installation = coordinator.installationStore.activeInstallation else { return false }
        return installation.hasNegotiatedAccess(to: .agentsRead)
    }

    /// Progress projections are independently negotiated read-only data. A
    /// revoked or switched installation must never leave child state visible
    /// while the parent transcript is being purged or reloaded.
    func clearProgressState() {
        taskProgress = nil
        agentRoster = nil
        historicalAgentRosters = []
        isTaskProgressStale = false
        isAgentRosterStale = false
    }

    private func clearProgressStateIfCredentialRevoked(_ error: Error) {
        guard (error as? AidenRemoteClientError)?.isCredentialRevoked == true else { return }
        clearProgressState()
    }

    private func clearTaskProgressState() {
        taskProgress = nil
        isTaskProgressStale = false
    }

    private func clearAgentProgressState() {
        agentRoster = nil
        historicalAgentRosters = []
        isAgentRosterStale = false
    }

    private func clearProgressStateForLostAccess() {
        if !canReadTaskProgress { clearTaskProgressState() }
        if !canReadAgentRoster { clearAgentProgressState() }
    }

    private func isProgressAccessDenied(_ error: Error) -> Bool {
        guard let clientError = error as? AidenRemoteClientError,
              case .server(_, let body) = clientError else { return false }
        return body.code.rawValue == "capability_denied"
    }

    var currentAgentTurnId: String? { agentRoster?.turnId }

    var availableAgentTurnIds: [String] {
        guard canReadAgentRoster else { return [] }
        var seen = Set<String>()
        let knownRosters = ([agentRoster].compactMap { $0 } + historicalAgentRosters)
        let advertisedTurns = knownRosters.flatMap { $0.previousTurns.map(\.turnId) }
        return ([agentRoster].compactMap { $0?.turnId } + advertisedTurns + historicalAgentRosters.compactMap { $0.turnId })
            .filter { seen.insert($0).inserted }
    }

    func turnLabel(_ turnId: String) -> String {
        if let turn = ([agentRoster].compactMap { $0 } + historicalAgentRosters)
            .flatMap({ $0.previousTurns })
            .first(where: { $0.turnId == turnId }) {
            return turn.startedAt.date.formatted(date: .abbreviated, time: .shortened)
        }
        // Opaque turn IDs never surface in display text. Fall back to the
        // turn's position in the retained list so the label stays stable.
        let earlier = availableAgentTurnIds.filter { $0 != currentAgentTurnId }
        let index = earlier.firstIndex(of: turnId).map { $0 + 1 } ?? earlier.count
        return String(localized: "Earlier turn \(index)")
    }

    func agentRoster(for turnId: String?) -> AidenRemoteChatAgentRoster? {
        guard canReadAgentRoster else { return nil }
        guard let turnId else { return agentRoster }
        if agentRoster?.turnId == turnId { return agentRoster }
        return historicalAgentRosters.first { $0.turnId == turnId }
    }

    func startProgressObservation() {
        guard !isReadOnlyFixture else { return }
        clearProgressStateForLostAccess()
        guard progressTask == nil,
              canReadTaskProgress || canReadAgentRoster else { return }
        progressObservationGeneration &+= 1
        let generation = progressObservationGeneration
        progressTask = Task { [weak self] in
            await self?.observeProgress(generation: generation)
            self?.finishProgressObservation(generation: generation)
        }
    }

    func stopProgressObservation() {
        progressObservationGeneration &+= 1
        progressTask?.cancel()
        progressTask = nil
        clearProgressStateForLostAccess()
        isTaskProgressStale = taskProgress != nil
        isAgentRosterStale = agentRoster != nil
    }

    private func loadProgressSnapshot(
        context: AidenRemoteRequestContext,
        observationGeneration: UInt64? = nil
    ) async {
        guard isCurrentProgressObservation(observationGeneration, context: context),
              canReadTaskProgress || canReadAgentRoster else { return }
        var taskFetchFailed = false
        var rosterFetchFailed = false
        do {
            let client = try coordinator.remoteClient(for: context)
            if canReadTaskProgress {
                do {
                    let snapshot = try await client.taskProgress(chatId: chat.id)
                    guard isCurrentProgressObservation(observationGeneration, context: context) else { return }
                    acceptTaskProgress(snapshot)
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    taskFetchFailed = true
                    clearProgressStateIfCredentialRevoked(error)
                    if await coordinator.handleCredentialRevocation(error, context: context) { return }
                    if isProgressAccessDenied(error) { clearTaskProgressState() }
                }
            }
            if canReadAgentRoster {
                do {
                    let snapshot = try await client.agentRoster(chatId: chat.id)
                    guard isCurrentProgressObservation(observationGeneration, context: context) else { return }
                    acceptAgentRoster(snapshot)
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    rosterFetchFailed = true
                    clearProgressStateIfCredentialRevoked(error)
                    if await coordinator.handleCredentialRevocation(error, context: context) { return }
                    if isProgressAccessDenied(error) { clearAgentProgressState() }
                }
            }
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            clearProgressStateIfCredentialRevoked(error)
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            if isProgressAccessDenied(error) { clearProgressStateForLostAccess() }
        }
        // Each projection owns its freshness. A failed roster refresh must not
        // label a successfully refreshed task snapshot as last-known, or vice
        // versa.
        isTaskProgressStale = taskFetchFailed && taskProgress != nil
        isAgentRosterStale = rosterFetchFailed && agentRoster != nil
    }

    private func observeProgress(generation: UInt64) async {
        while !Task.isCancelled {
            guard let context = try? coordinator.requestContext(for: instanceId) else {
                clearProgressState()
                return
            }
            guard isCurrentProgressObservation(generation, context: context),
                  canReadTaskProgress || canReadAgentRoster else { return }
            await loadProgressSnapshot(context: context, observationGeneration: generation)
            guard isCurrentProgressObservation(generation, context: context) else { return }
            do {
                let events = try coordinator.remoteClient(for: context).progressEvents(
                    chatId: chat.id,
                    after: 0
                )
                for try await event in events {
                    try Task.checkCancellation()
                    guard isCurrentProgressObservation(generation, context: context),
                          event.streamId == chat.id else { return }
                    applyProgress(event)
                }
                if isCurrentProgressObservation(generation, context: context) {
                    isTaskProgressStale = taskProgress != nil
                    isAgentRosterStale = agentRoster != nil
                }
            } catch let error where aidenIsCancellation(error) {
                return
            } catch {
                clearProgressStateIfCredentialRevoked(error)
                if await coordinator.handleCredentialRevocation(error, context: context) { return }
                guard isCurrentProgressObservation(generation, context: context) else { return }
                if isProgressAccessDenied(error) {
                    clearProgressState()
                    return
                }
                isTaskProgressStale = taskProgress != nil
                isAgentRosterStale = agentRoster != nil
            }
            do {
                try await Task.sleep(for: .seconds(1))
            } catch {
                return
            }
        }
    }

    /// A progress stream can finish without the view disappearing (for
    /// example, after a capability denial or a cancelled request). Release the
    /// handle only if this is still the current generation so an older
    /// cancelled observer cannot clear a newly started observer.
    private func finishProgressObservation(generation: UInt64) {
        guard generation == progressObservationGeneration else { return }
        progressTask = nil
        isTaskProgressStale = taskProgress != nil
        isAgentRosterStale = agentRoster != nil
    }

    private func isCurrentProgressObservation(
        _ generation: UInt64?,
        context: AidenRemoteRequestContext
    ) -> Bool {
        guard coordinator.isCurrent(context) else {
            clearProgressState()
            return false
        }
        guard let generation else { return true }
        guard generation == progressObservationGeneration && !Task.isCancelled else { return false }
        clearProgressStateForLostAccess()
        return canReadTaskProgress || canReadAgentRoster
    }

    private func applyProgress(_ event: AidenRemoteStreamEvent) {
        guard event.shouldApply else { return }
        switch event.type {
        case .taskUpdate:
            guard canReadTaskProgress else {
                clearTaskProgressState()
                return
            }
            guard let snapshot = event.taskProgress,
                  snapshot.chatId == chat.id else { return }
            if acceptTaskProgress(snapshot) {
                isTaskProgressStale = false
            }
        case .agentsUpdate:
            guard canReadAgentRoster else {
                clearAgentProgressState()
                return
            }
            guard let snapshot = event.agentRoster,
                  snapshot.chatId == chat.id else { return }
            if acceptAgentRoster(snapshot) {
                isAgentRosterStale = false
            }
        case .heartbeat:
            break
        default:
            break
        }
    }

    @discardableResult
    private func acceptTaskProgress(_ snapshot: AidenRemoteChatTaskProgress) -> Bool {
        guard snapshot.chatId == chat.id else { return false }
        guard AidenProgressPresentation.acceptsSnapshot(
            currentEpoch: taskProgress?.epoch,
            currentRevision: taskProgress?.revision,
            incomingEpoch: snapshot.epoch,
            incomingRevision: snapshot.revision
        ) else { return false }
        taskProgress = snapshot
        return true
    }

    @discardableResult
    private func acceptAgentRoster(_ snapshot: AidenRemoteChatAgentRoster) -> Bool {
        guard snapshot.chatId == chat.id else { return false }
        guard let current = agentRoster else {
            historicalAgentRosters.removeAll { $0.epoch != snapshot.epoch }
            agentRoster = snapshot
            return true
        }
        // Roster revision is global for the chat projection, including when a
        // new turn replaces the current roster. Fence stale responses before
        // considering turn transitions so an old turn can never roll back the
        // current view.
        guard AidenProgressPresentation.acceptsSnapshot(
            currentEpoch: current.epoch,
            currentRevision: current.revision,
            incomingEpoch: snapshot.epoch,
            incomingRevision: snapshot.revision
        ) else { return false }
        if current.epoch != snapshot.epoch {
            historicalAgentRosters = []
        }
        if current.turnId != snapshot.turnId {
            if current.epoch == snapshot.epoch, current.turnId != nil {
                upsertHistoricalRoster(current)
            }
            agentRoster = snapshot
            return true
        }
        agentRoster = snapshot
        return true
    }

    private func upsertHistoricalRoster(_ roster: AidenRemoteChatAgentRoster) {
        guard roster.turnId != nil, roster.epoch == agentRoster?.epoch else { return }
        if let existing = historicalAgentRosters.first(where: { $0.turnId == roster.turnId }),
           !AidenProgressPresentation.acceptsSnapshot(
               currentEpoch: existing.epoch,
               currentRevision: existing.revision,
               incomingEpoch: roster.epoch,
               incomingRevision: roster.revision
           ) {
            return
        }
        historicalAgentRosters.removeAll { $0.turnId == roster.turnId }
        historicalAgentRosters.insert(roster, at: 0)
        if historicalAgentRosters.count > 8 {
            historicalAgentRosters.removeLast(historicalAgentRosters.count - 8)
        }
    }

    func loadAgentRoster(turnId: String) async {
        clearProgressStateForLostAccess()
        guard canReadAgentRoster,
              let context = try? coordinator.requestContext(for: instanceId),
              coordinator.isCurrent(context) else {
            clearAgentProgressState()
            return
        }
        do {
            let snapshot = try await coordinator.remoteClient(for: context).agentRoster(
                chatId: chat.id,
                turnId: turnId
            )
            guard coordinator.isCurrent(context),
                  snapshot.chatId == chat.id,
                  snapshot.turnId == turnId,
                  snapshot.epoch == agentRoster?.epoch else { return }
            upsertHistoricalRoster(snapshot)
        } catch let error where aidenIsCancellation(error) {
            return
        } catch {
            clearProgressStateIfCredentialRevoked(error)
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            if isProgressAccessDenied(error) {
                clearAgentProgressState()
            } else {
                presentedError = String(localized: "That agent session is no longer available.")
            }
        }
    }

    private func scheduleDraftPersistence() {
        guard !isReadOnlyPresentation, let session = draftSession else { return }
        let text = draft
        draftPersistenceTask?.cancel()
        draftPersistenceTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled, let self,
                  self.draftSession == session,
                  self.draft == text else { return }
            _ = try? await self.draftStore.save(text, session: session)
        }
    }

    func selectProvider(_ providerId: String) {
        guard !chat.isBotChat else { return }
        guard selectedProviderId != providerId else { return }
        selectedProviderId = providerId
        selectedModelId = visibleProviders.first { $0.id == providerId }?.models.first?.id
        selectedThinkingLevel = selectedModel?.effectiveThinkingLevel
    }

    func selectModel(_ modelId: String) {
        guard !chat.isBotChat else { return }
        guard selectedModelId != modelId else { return }
        selectedModelId = modelId
        selectedThinkingLevel = selectedModel?.effectiveThinkingLevel
    }

    func setBotVisionModelSelection(_ selection: AidenBotModelSelection?) {
        botVisionModelSelection = selection
        if selection != nil { needsBotVisionSetup = false }
    }

    func setBotPrimarySupportsImages(_ supportsImages: Bool?) {
        botPrimarySupportsImages = supportsImages
        if supportsImages == true { needsBotVisionSetup = false }
    }

    func requestBotVisionSetup() {
        guard chat.isBotChat, !acceptsImageAttachments else { return }
        needsBotVisionSetup = true
    }

    func selectModel(providerId: String, modelId: String, thinkingLevel: String?) {
        let next = [providerId, modelId, thinkingLevel ?? ""]
        let current = [selectedProviderId ?? "", selectedModelId ?? "", selectedThinkingLevel ?? ""]
        guard next != current else { return }
        selectedProviderId = providerId
        selectedModelId = modelId
        selectedThinkingLevel = thinkingLevel
    }

    func send() async {
        guard !isReadOnlyPresentation else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        switch aidenImageSendRecovery(
            isBotChat: chat.isBotChat,
            acceptsImages: acceptsImageAttachments,
            hasPendingImage: pendingAttachments.contains(where: { $0.kind == .image })
        ) {
        case .proceed:
            break
        case .configureBotVision:
                needsBotVisionSetup = true
            return
        case .chooseImageCapableModel:
            presentedError = String(localized: "The selected model can’t read images. Choose an image-capable model, then try again.")
            return
        }
        guard let context = try? coordinator.requestContext(for: instanceId) else { return }
        let submittedAttachments = pendingAttachments
        let modelSelection = turnModelSelection
        let request = AidenTurnRequestBuilder.make(
            text: text,
            providerId: modelSelection.providerId,
            modelId: modelSelection.modelId,
            thinkingLevel: modelSelection.thinkingLevel,
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

        composerGeneration &+= 1
        isStarting = true
        defer { isStarting = false }
        presentedError = nil
        draftPersistenceTask?.cancel()
        suppressesDraftPersistence = true
        draft = ""
        suppressesDraftPersistence = false
        let clearedDraftGeneration = draftGeneration
        pendingAttachments = []
        chat.messages.append(optimisticMessage)
        chat.updatedAt = now
        streamState = .queued
        let idempotencyKey = turnAttempts.key(for: request)
        do {
            let response = try await coordinator.remoteClient(for: context).startTurn(
                chatId: chat.id,
                request: request,
                idempotencyKey: idempotencyKey
            )
            let stream = AidenChatCache.ActiveStream(
                deviceId: context.deviceId,
                streamId: response.streamId,
                turnId: response.turnId,
                lastSequence: 0
            )
            var acceptedChat = chat
            acceptedChat.messages.removeAll { $0.id == optimisticID }
            if !acceptedChat.messages.contains(where: { $0.id == response.message.id }) {
                acceptedChat.messages.append(response.message)
            }
            // A normal installation switch retains an accepted turn for later
            // resume. Forgetting, revoking, or re-pairing the captured device
            // invalidates the context before any private cache/activity write.
            let retained = await coordinator.withRetainedInstallationData(for: context) {
                try? await cache.saveChat(acceptedChat, instanceId: instanceId)
                try? await cache.saveActiveStream(stream, instanceId: instanceId, chatId: chat.id)
                if let draftSession,
                   draftGeneration == clearedDraftGeneration,
                   draft.isEmpty {
                    _ = try? await draftStore.save("", session: draftSession)
                }
                await liveActivities.start(
                    instanceID: instanceId,
                    chatID: chat.id,
                    title: chat.title,
                    streamID: response.streamId
                )
            }
            guard retained else { return }
            guard coordinator.isCurrent(context) else { return }
            turnAttempts.reset()
            chat = acceptedChat
            liveText = ""
            reasoning = ""
            tools = []
            activityTimeline = nil
            pendingApproval = nil
            streamState = .queued
            coordinator.haptics.play(.actionStarted, scope: hapticScope, dedupeKey: "turn-start:\(response.streamId)")
            startStreaming(stream, context: context, feedbackPolicy: .localTurn)
        } catch let error where aidenIsCancellation(error) {
            guard coordinator.isCurrent(context) else { return }
            chat.messages.removeAll { $0.id == optimisticID }
            chat.updatedAt = previousUpdatedAt
            if draft.isEmpty { draft = text }
            if pendingAttachments.isEmpty { pendingAttachments = submittedAttachments }
            streamState = nil
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            chat.messages.removeAll { $0.id == optimisticID }
            chat.updatedAt = previousUpdatedAt
            draft = AidenDraftSendReconciliation.failedDraft(
                submitted: text,
                current: draft
            )
            pendingAttachments = AidenDraftSendReconciliation.failedAttachments(
                submitted: submittedAttachments,
                current: pendingAttachments
            )
            streamState = nil
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    /// Both picker callbacks enter here synchronously, before transferring or
    /// converting selected files. Selection already owns the composer even
    /// though no upload reference exists yet.
    @discardableResult
    func prepareAttachments<Selection>(
        _ selection: Result<[Selection], Error>,
        prepare: @escaping @MainActor (Selection) async throws -> AidenAttachmentUpload
    ) -> Task<Void, Never>? {
        guard !isReadOnlyPresentation else { return nil }
        let selections: [Selection]
        do {
            selections = try selection.get()
        } catch let error where aidenIsCancellation(error) {
            return nil
        } catch let error as CocoaError where error.code == .userCancelled {
            return nil
        } catch {
            presentedError = String(localized: "One selected attachment could not be added. Other attachments are still ready to send.")
            return nil
        }
        let capacity = max(0, 10 - pendingAttachments.count)
        guard !selections.isEmpty, capacity > 0,
              isConnected, !isPreparingAttachments, !isUploadingAttachment, !isStarting, !isStreaming,
              let context = try? coordinator.requestContext(for: instanceId) else { return nil }
        composerGeneration &+= 1
        let preparationID = UUID()
        attachmentPreparationID = preparationID
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if attachmentPreparationID == preparationID {
                    attachmentPreparationID = nil
                    attachmentPreparationTask = nil
                }
            }
            var uploads: [AidenAttachmentUpload] = []
            var failures = max(0, selections.count - capacity)
            for selection in selections.prefix(capacity) {
                guard !Task.isCancelled, coordinator.isCurrent(context) else { return }
                do {
                    uploads.append(try await prepare(selection))
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    failures += 1
                }
            }
            guard !Task.isCancelled, coordinator.isCurrent(context),
                  attachmentPreparationID == preparationID else { return }
            failures += await upload(uploads)
            guard !Task.isCancelled, coordinator.isCurrent(context),
                  attachmentPreparationID == preparationID else { return }
            if failures > 0 {
                presentedError = failures == 1
                    ? String(localized: "One selected attachment could not be added. Other attachments are still ready to send.")
                    : String(localized: "\(failures) selected attachments could not be added. Other attachments are still ready to send.")
            }
        }
        attachmentPreparationTask = task
        return task
    }

    func cancelAttachmentPreparation() {
        attachmentPreparationTask?.cancel()
        attachmentPreparationTask = nil
        attachmentPreparationID = nil
    }

    @discardableResult
    func upload(_ uploads: [AidenAttachmentUpload]) async -> Int {
        guard !uploads.isEmpty else { return 0 }
        guard !isReadOnlyPresentation else { return uploads.count }
        guard isConnected, !isUploadingAttachment, !isStreaming, pendingAttachments.count < 10 else {
            return uploads.count
        }
        guard let context = try? coordinator.requestContext(for: instanceId) else { return uploads.count }
        composerGeneration &+= 1
        isUploadingAttachment = true
        presentedError = nil
        defer { isUploadingAttachment = false }
        var failedCount = 0
        var acceptedReferences: [AidenAttachmentReference] = []
        for upload in uploads.prefix(10 - pendingAttachments.count) {
            if Task.isCancelled {
                await cleanupCancelledUpload(acceptedReferences, context: context)
                return uploads.count
            }
            do {
                let reference = try await coordinator.remoteClient(for: context).uploadAttachment(
                    chatId: chat.id,
                    upload: upload
                )
                guard coordinator.isCurrent(context) else {
                    acceptedReferences.append(reference)
                    await cleanupCancelledUpload(acceptedReferences, context: context)
                    return uploads.count
                }
                guard reference.isValid() else {
                    throw AidenRemoteClientError.invalidResponse
                }
                pendingAttachments.append(reference)
                acceptedReferences.append(reference)
                if case .image(_, let mimeType, let data) = upload {
                    let attachment = AidenMessageAttachment(
                        id: reference.id,
                        name: reference.name,
                        mimeType: mimeType,
                        kind: .image,
                        size: reference.size
                    )
                    try? await cache.saveAttachmentImage(
                        data,
                        instanceId: instanceId,
                        deviceId: context.deviceId,
                        chatId: chat.id,
                        attachment: attachment
                    )
                }
            } catch let error where aidenIsCancellation(error) {
                await cleanupCancelledUpload(acceptedReferences, context: context)
                return uploads.count
            } catch {
                if await coordinator.handleCredentialRevocation(error, context: context) {
                    return uploads.count
                }
                guard coordinator.isCurrent(context) else { return uploads.count }
                failedCount += 1
            }
        }
        if failedCount > 0 {
            presentedError = failedCount == 1
                ? String(localized: "One attachment could not be uploaded. Other attachments are still ready to send.")
                : String(localized: "\(failedCount) attachments could not be uploaded. Other attachments are still ready to send.")
            coordinator.haptics.play(acceptedReferences.isEmpty ? .error : .warning, scope: hapticScope)
        }
        return failedCount
    }

    private func cleanupCancelledUpload(
        _ references: [AidenAttachmentReference],
        context: AidenRemoteRequestContext
    ) async {
        guard !references.isEmpty else { return }
        let cleanup = Task { @MainActor [weak self] in
            guard let self else { return }
            for reference in references {
                pendingAttachments.removeAll { $0.id == reference.id }
                await cache.removeAttachmentImage(
                    instanceId: instanceId,
                    deviceId: context.deviceId,
                    chatId: chat.id,
                    attachmentId: reference.id
                )
                do {
                    try await coordinator.remoteClient(for: context).removeAttachment(
                        chatId: chat.id,
                        attachmentId: reference.id
                    )
                } catch {
                    if await coordinator.handleCredentialRevocation(error, context: context) { return }
                }
            }
        }
        await cleanup.value
    }

    @discardableResult
    func upload(_ upload: AidenAttachmentUpload) async -> Int {
        await self.upload([upload])
    }

    func removeAttachment(_ attachment: AidenAttachmentReference) async {
        guard !isReadOnlyPresentation else { return }
        pendingAttachments.removeAll { $0.id == attachment.id }
        guard let context = try? coordinator.requestContext(for: instanceId) else { return }
        await cache.removeAttachmentImage(
            instanceId: instanceId,
            deviceId: context.deviceId,
            chatId: chat.id,
            attachmentId: attachment.id
        )
        do {
            try await coordinator.remoteClient(for: context).removeAttachment(chatId: chat.id, attachmentId: attachment.id)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            // The reference is short lived and server cleanup is automatic. Local removal remains authoritative for the composer.
        }
    }

    func attachmentImageData(for attachment: AidenMessageAttachment) async -> Data? {
        guard !isReadOnlyFixture else { return nil }
        guard attachment.kind == .image,
              let context = try? coordinator.requestContext(for: instanceId)
        else { return nil }
        if let cached = await cache.attachmentImage(
            instanceId: instanceId,
            deviceId: context.deviceId,
            chatId: chat.id,
            attachment: attachment
        ) {
            return cached
        }
        do {
            let content = try await coordinator.remoteClient(for: context).attachmentContent(
                chatId: chat.id,
                attachmentId: attachment.id
            )
            guard coordinator.isCurrent(context),
                  content.mimeType == attachment.mimeType,
                  let data = await AidenAttachmentImageDecoding.validatedData(
                      content.data,
                      mimeType: content.mimeType,
                      declaredSize: attachment.size
                  )
            else { return nil }
            try? await cache.saveAttachmentImage(
                data,
                instanceId: instanceId,
                deviceId: context.deviceId,
                chatId: chat.id,
                attachment: attachment
            )
            return data
        } catch {
            _ = await coordinator.handleCredentialRevocation(error, context: context)
            return nil
        }
    }

    func pendingAttachmentImageData(for attachment: AidenAttachmentReference) async -> Data? {
        guard attachment.kind == .image else { return nil }
        return await attachmentImageData(for: AidenMessageAttachment(
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            kind: attachment.kind,
            size: attachment.size
        ))
    }

    var canControlCurrentRun: Bool {
        guard !isReadOnlyPresentation, isConnected, isStreaming,
              activeStreamID != nil,
              let installation = coordinator.installationStore.activeInstallation,
              installation.instanceId == instanceId,
              installation.deviceCapabilities.contains(.chatWrite) else { return false }
        return chat.botId == nil || (installation.hasNegotiatedAccess(to: .botRead)
            && installation.hasNegotiatedAccess(to: .botWrite))
    }

    func stop() async {
        guard canControlCurrentRun, !isStopping,
              let streamID = activeStreamID,
              let context = try? coordinator.requestContext(for: instanceId) else { return }
        isStopping = true
        defer { isStopping = false }
        do {
            let status = try await coordinator.remoteClient(for: context).cancelStream(id: streamID)
            guard coordinator.isCurrent(context), activeStreamID == streamID,
                  streamState?.isTerminal != true else { return }
            guard status.streamId == streamID, status.chatId == chat.id else {
                presentedError = String(localized: "Stop was not confirmed. Check the current run before trying again.")
                return
            }
            await apply(status, streamID: streamID, context: context, feedbackPolicy: .restoredStream)
            coordinator.haptics.play(.actionStopped, scope: hapticScope, dedupeKey: "turn-stop:\(streamID)")
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context), activeStreamID == streamID,
                  streamState?.isTerminal != true else { return }
            presentedError = String(localized: "Stop was not confirmed. Check the current run before trying again.")
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    func respondToApproval(_ decision: AidenApprovalDecision, approvalID: String) async {
        guard !isReadOnlyPresentation, isConnected, !isRespondingToApproval, !isStopping,
              let approval = pendingApproval, approval.id == approvalID else { return }
        guard approval.expiresAt > Date() else {
            pendingApproval = nil
            return
        }
        guard let streamID = activeStreamID,
              let context = try? coordinator.requestContext(for: instanceId) else { return }
        isRespondingToApproval = true
        defer { isRespondingToApproval = false }
        let capabilities = approvalCapabilities(for: context)
        let authorization = AidenApprovalResponseAuthorization.resolve(
            approval: approval, decision: decision, capabilities: capabilities
        )
        guard authorization == .allowed else {
            presentedError = String(localized: "Approval access changed. Review the current request on your Mac.")
            pendingApproval = nil
            streamState = .reconciling
            await restorePendingApproval(streamID: streamID, context: context)
            return
        }
        pendingApproval = nil
        streamState = .running
        do {
            let response = try await coordinator.remoteClient(for: context).respondToApproval(id: approval.id, decision: decision)
            guard coordinator.isCurrent(context), activeStreamID == streamID,
                  streamState?.isTerminal != true else { return }
            guard response.approvalId == approval.id, response.decision == decision else {
                presentedError = String(localized: "The approval response was not confirmed. Refreshing the current request from your Mac.")
                if pendingApproval == nil {
                    await restorePendingApproval(streamID: streamID, context: context, isFallback: true)
                }
                return
            }
            coordinator.haptics.play(.selection, scope: hapticScope, dedupeKey: "approval-response:\(approval.id):\(decision.rawValue)")
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context), activeStreamID == streamID,
                  streamState?.isTerminal != true else { return }
            presentedError = String(localized: "The approval response was not confirmed. Refreshing the current request from your Mac.")
            // Never resurrect the captured card or retry a possibly accepted decision.
            if pendingApproval == nil {
                await restorePendingApproval(streamID: streamID, context: context, isFallback: true)
            }
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    private func resolveModelSelection() {
        let selection = AidenChatModelAuthority.resolvedSelection(
            chat: chat,
            catalog: catalog,
            selectedProviderId: selectedProviderId,
            selectedModelId: selectedModelId,
            selectedThinkingLevel: selectedThinkingLevel
        )
        selectedProviderId = selection.providerId
        selectedModelId = selection.modelId
        selectedThinkingLevel = selection.thinkingLevel
    }

    private func restoreStreamIfNeeded() async {
        guard let stream = await cache.loadActiveStream(instanceId: instanceId, chatId: chat.id) else { return }
        guard let context = try? coordinator.requestContext(for: instanceId) else { return }
        guard stream.deviceId == context.deviceId else {
            await cache.removeActiveStream(instanceId: instanceId, chatId: chat.id)
            await liveActivities.endAll(forInstanceID: instanceId)
            return
        }
        do {
            let status = try await coordinator.remoteClient(for: context).streamStatus(id: stream.streamId)
            guard coordinator.isCurrent(context) else { return }
            activeStreamID = stream.streamId
            if !status.state.isTerminal {
                await liveActivities.start(
                    instanceID: instanceId,
                    chatID: chat.id,
                    title: chat.title,
                    streamID: stream.streamId
                )
            }
            guard activeStreamID == stream.streamId else { return }
            await apply(
                status,
                streamID: stream.streamId,
                context: context,
                feedbackPolicy: .restoredStream
            )
            // A terminal status can become visible before its final SSE event is
            // consumed. Keep the durable cursor and replay first so cancellation
            // and provider-failure details are never skipped on reopen.
            startStreaming(stream, context: context, feedbackPolicy: .restoredStream)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            presentedError = error.localizedDescription
            await liveActivities.markStale(instanceID: instanceId, streamID: stream.streamId)
            // Retain and resume the durable cursor even if the first status
            // probe happens while the phone is offline.
            startStreaming(stream, context: context, feedbackPolicy: .restoredStream)
        }
    }

    private func startStreaming(
        _ stream: AidenChatCache.ActiveStream,
        context: AidenRemoteRequestContext,
        feedbackPolicy: AidenStreamFeedbackPolicy
    ) {
        terminalReconciliationTask?.cancel()
        terminalReconciliationTask = nil
        streamTask?.cancel()
        activeStreamID = stream.streamId
        streamTask = Task { [weak self] in
            await self?.consume(stream, context: context, feedbackPolicy: feedbackPolicy)
        }
    }

    private func consume(
        _ original: AidenChatCache.ActiveStream,
        context: AidenRemoteRequestContext,
        feedbackPolicy: AidenStreamFeedbackPolicy
    ) async {
        var stream = original
        var terminalReplayGate = AidenTerminalReplayGate()
        var retryAttempt = 0
        while !Task.isCancelled && coordinator.isCurrent(context) && activeStreamID == stream.streamId {
            do {
                let events = try coordinator.remoteClient(for: context).streamEvents(
                    id: stream.streamId,
                    after: stream.lastSequence
                )
                for try await event in events {
                    try Task.checkCancellation()
                    guard coordinator.isCurrent(context), activeStreamID == stream.streamId else { return }
                    guard event.streamId == stream.streamId else { continue }
                    if event.sequence <= stream.lastSequence { continue }
                    if event.sequence != stream.lastSequence + 1 {
                        await reconcileChat(context: context)
                    }
                    await apply(event, context: context, feedbackPolicy: feedbackPolicy)
                    guard activeStreamID == stream.streamId else { return }
                    stream.lastSequence = event.sequence
                    if event.terminal { return }
                    try await cache.saveActiveStream(stream, instanceId: instanceId, chatId: chat.id)
                }

                let status = try await coordinator.remoteClient(for: context).streamStatus(id: stream.streamId)
                guard coordinator.isCurrent(context), activeStreamID == stream.streamId else { return }
                retryAttempt = 0
                await apply(
                    status,
                    streamID: stream.streamId,
                    context: context,
                    feedbackPolicy: feedbackPolicy
                )
                if status.state.isTerminal {
                    if terminalReplayGate.shouldReplay(status.state) { continue }
                    await finishStream(expectedStreamID: stream.streamId, context: context)
                    return
                }
                try await Task.sleep(for: .milliseconds(500))
            } catch let error where aidenIsCancellation(error) {
                return
            } catch {
                guard !Task.isCancelled else { return }
                do {
                    let status = try await coordinator.remoteClient(for: context).streamStatus(id: stream.streamId)
                    guard coordinator.isCurrent(context), activeStreamID == stream.streamId else { return }
                    await apply(
                        status,
                        streamID: stream.streamId,
                        context: context,
                        feedbackPolicy: feedbackPolicy
                    )
                    if status.state.isTerminal {
                        if terminalReplayGate.shouldReplay(status.state) { continue }
                        await finishStream(expectedStreamID: stream.streamId, context: context)
                        return
                    }
                    try await Task.sleep(for: .seconds(1))
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    if await coordinator.handleCredentialRevocation(error, context: context) { return }
                    guard coordinator.isCurrent(context) else { return }
                    if AidenTerminalReconciliation.isDefinitiveMissingStream(error),
                       await reconcileMissingStream(
                           stream,
                           context: context,
                           feedbackPolicy: feedbackPolicy
                       ) {
                        return
                    }
                    presentedError = error.localizedDescription
                    await liveActivities.markStale(instanceID: instanceId, streamID: stream.streamId)
                    let delay = AidenTerminalReconciliation.retryDelayMilliseconds(attempt: retryAttempt)
                    retryAttempt += 1
                    do {
                        try await Task.sleep(for: .milliseconds(delay))
                    } catch {
                        return
                    }
                    continue
                }
            }
        }
    }

    private func apply(
        _ event: AidenRemoteStreamEvent,
        context: AidenRemoteRequestContext,
        feedbackPolicy: AidenStreamFeedbackPolicy
    ) async {
        guard coordinator.isCurrent(context),
              activeStreamID == event.streamId,
              event.shouldApply,
              let payload = event.payload else { return }
        switch event.type {
        case .snapshot:
            streamState = .reconciling
            if chat.isBotChat {
                // A projection reset is followed by a cumulative replacement.
                // Bot progress is disclosure-only, so discard the old ephemeral
                // copy before accepting that replacement instead of appending it.
                liveText = ""
                reasoning = ""
            }
            await reconcileChat(context: context)
        case .status:
            if let value = payload.state, let state = AidenStreamState(rawValue: value) {
                if state == .waitingForApproval {
                    await restorePendingApproval(
                        streamID: event.streamId,
                        context: context,
                        announce: feedbackPolicy.allowsFeedback
                    )
                    break
                }
                streamState = state
                if state != .waitingForApproval { pendingApproval = nil }
                await liveActivities.updateStatus(instanceID: instanceId, streamID: event.streamId, state: state)
            }
        case .textDelta:
            liveText += payload.text ?? ""
            streamState = .running
            await liveActivities.appendResponse(payload.text ?? "", instanceID: instanceId, streamID: event.streamId)
        case .reasoningDelta:
            reasoning += payload.text ?? ""
            await liveActivities.reasoning(instanceID: instanceId, streamID: event.streamId)
        case .toolStarted:
            if let id = payload.toolId, let name = payload.name {
                tools.append(AidenLiveTool(id: id, name: name, status: nil))
            }
            await liveActivities.toolStarted(name: payload.name, instanceID: instanceId, streamID: event.streamId)
        case .toolFinished:
            if let id = payload.toolId, let index = tools.firstIndex(where: { $0.id == id }) {
                tools[index].status = payload.status
            }
            await liveActivities.toolFinished(instanceID: instanceId, streamID: event.streamId)
        case .timeline:
            if let timeline = payload.timeline { activityTimeline = timeline }
        case .approvalRequired:
            await restorePendingApproval(
                streamID: event.streamId,
                context: context,
                announce: feedbackPolicy.allowsFeedback
            )
        case .error:
            pendingApproval = nil
            // The terminal chat reconciliation renders the durable, fixed-copy
            // outcome inline. Avoid covering that actionable state with a
            // second generic modal alert.
            presentedError = nil
            streamState = .error
            if feedbackPolicy.allowsFeedback {
                coordinator.haptics.play(
                    .error,
                    scope: hapticScope,
                    dedupeKey: "turn-terminal:\(event.streamId):error"
                )
            }
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: event.streamId,
                status: .failed,
                message: String(localized: "Response failed"),
                errorSummary: payload.message
            )
            await finishStream(expectedStreamID: event.streamId, context: context)
        case .cancelled:
            pendingApproval = nil
            streamState = .cancelled
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: event.streamId,
                status: .cancelled,
                message: String(localized: "Response cancelled")
            )
            await finishStream(expectedStreamID: event.streamId, context: context)
        case .done:
            pendingApproval = nil
            streamState = .done
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: event.streamId,
                status: .complete,
                message: String(localized: "Response complete")
            )
            await finishStream(expectedStreamID: event.streamId, context: context)
        case .heartbeat:
            break
        default:
            break
        }
    }

    private func apply(
        _ status: AidenStreamStatus,
        streamID: String,
        context: AidenRemoteRequestContext,
        feedbackPolicy: AidenStreamFeedbackPolicy
    ) async {
        guard activeStreamID == streamID,
              status.streamId == streamID,
              status.chatId == chat.id,
              coordinator.isCurrent(context)
        else { return }
        if status.state == .waitingForApproval {
            await restorePendingApproval(
                streamID: streamID,
                context: context,
                announce: AidenStreamFeedbackDecision.announcesApproval(feedbackPolicy)
            )
            return
        }
        pendingApproval = nil
        streamState = status.state
        if feedbackPolicy.allowsFeedback,
           status.state == .error || status.state == .interrupted {
            coordinator.haptics.play(
                .error,
                scope: hapticScope,
                dedupeKey: "turn-terminal:\(streamID):error"
            )
        }
        await liveActivities.updateStatus(instanceID: instanceId, streamID: streamID, state: status.state)
    }

    func restorePendingApproval(
        streamID: String,
        context: AidenRemoteRequestContext,
        announce: Bool = false,
        isFallback: Bool = false
    ) async {
        guard coordinator.isCurrent(context), activeStreamID == streamID,
              streamState?.isTerminal != true else { return }
        if isFallback, let read = approvalSnapshotInFlight,
           read.streamID == streamID, coordinator.isCurrent(read.context),
           read.approval == pendingApproval, read.state == streamState { return }
        approvalSnapshotGeneration &+= 1
        let snapshotGeneration = approvalSnapshotGeneration
        approvalSnapshotInFlight = (streamID, context, pendingApproval, streamState)
        defer {
            if snapshotGeneration == approvalSnapshotGeneration { approvalSnapshotInFlight = nil }
        }
        let expectedApproval = pendingApproval
        let expectedState = streamState
        do {
            let snapshot = try await coordinator.remoteClient(for: context).streamApproval(id: streamID)
            guard coordinator.isCurrent(context), activeStreamID == streamID,
                  snapshotGeneration == approvalSnapshotGeneration,
                  pendingApproval == expectedApproval, streamState == expectedState else { return }
            guard let approval = AidenPendingApprovalResolution.resolve(
                snapshot.approval,
                streamId: streamID,
                chatId: chat.id,
                capabilities: approvalCapabilities(for: context)
            ) else {
                pendingApproval = nil
                streamState = .reconciling
                await liveActivities.updateStatus(
                    instanceID: instanceId,
                    streamID: streamID,
                    state: .reconciling
                )
                return
            }
            pendingApproval = approval
            streamState = .waitingForApproval
            if announce {
                coordinator.haptics.play(
                    .warning,
                    scope: hapticScope,
                    dedupeKey: "approval-required:\(approval.id)"
                )
            }
            await liveActivities.approvalRequired(instanceID: instanceId, streamID: streamID)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context), activeStreamID == streamID,
                  snapshotGeneration == approvalSnapshotGeneration,
                  pendingApproval == expectedApproval, streamState == expectedState else { return }
            pendingApproval = nil
            streamState = .reconciling
            await liveActivities.markStale(instanceID: instanceId, streamID: streamID)
        }
    }

    private func approvalCapabilities(
        for context: AidenRemoteRequestContext
    ) -> AidenApprovalCapabilities {
        guard coordinator.isCurrent(context),
              let installation = coordinator.installationStore.activeInstallation,
              installation.instanceId == context.instanceId,
              installation.deviceId == context.deviceId else {
            return AidenApprovalCapabilities(canRespond: false, canWriteSchedules: false)
        }
        return AidenApprovalCapabilities(
            canRespond: installation.hasNegotiatedAccess(to: .approvalRespond)
                && (chat.botId == nil || (installation.hasNegotiatedAccess(to: .botRead)
                    && installation.hasNegotiatedAccess(to: .botWrite))),
            canWriteSchedules: installation.hasNegotiatedAccess(to: .scheduleWrite)
        )
    }

    @discardableResult
    private func reconcileChat(context: AidenRemoteRequestContext) async -> Bool {
        do {
            let remote = try await coordinator.remoteClient(for: context).chat(id: chat.id)
            guard coordinator.isCurrent(context) else { return false }
            await acceptRemoteChat(remote, context: context)
            return true
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return false }
            guard coordinator.isCurrent(context) else { return false }
            presentedError = error.localizedDescription
            return false
        }
    }

    private func acceptRemoteChat(
        _ remote: AidenChat,
        context: AidenRemoteRequestContext,
        scheduleTitleRefresh: Bool = true
    ) async {
        guard coordinator.isCurrent(context) else { return }
        chat = remote
        resolveModelSelection()
        try? await cache.saveChat(remote, instanceId: instanceId)
        onChatUpdated(remote)
        if scheduleTitleRefresh, remote.isTitlePending {
            schedulePendingTitleRefresh(context: context)
        }
    }

    private func schedulePendingTitleRefresh(context: AidenRemoteRequestContext) {
        guard titleRefreshTask == nil else { return }
        titleRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer { titleRefreshTask = nil }
            for delay in AidenChatTitleReconciliation.retryMilliseconds {
                do {
                    try await Task.sleep(for: .milliseconds(delay))
                    let remote = try await coordinator.remoteClient(for: context).chat(id: chat.id)
                    guard coordinator.isCurrent(context) else { return }
                    await acceptRemoteChat(remote, context: context, scheduleTitleRefresh: false)
                    if !remote.isTitlePending { return }
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    if await coordinator.handleCredentialRevocation(error, context: context) { return }
                    // A transient local-network interruption should not surface after a
                    // successful reply. The next normal refresh remains authoritative.
                    continue
                }
            }
        }
    }

    private func finishStream(expectedStreamID: String, context: AidenRemoteRequestContext) async {
        guard coordinator.isCurrent(context), activeStreamID == expectedStreamID else { return }
        guard await reconcileChat(context: context) else {
            scheduleTerminalReconciliation(expectedStreamID: expectedStreamID, context: context)
            return
        }
        guard activeStreamID == expectedStreamID else { return }
        await clearFinishedStream(expectedStreamID: expectedStreamID)
    }

    private func reconcileMissingStream(
        _ stream: AidenChatCache.ActiveStream,
        context: AidenRemoteRequestContext,
        feedbackPolicy: AidenStreamFeedbackPolicy
    ) async -> Bool {
        guard activeStreamID == stream.streamId else { return false }
        guard await reconcileChat(context: context) else { return false }
        guard activeStreamID == stream.streamId else { return false }
        let resolution = AidenMissingStreamResolution.resolve(messages: chat.messages)
        if let event = AidenStreamFeedbackDecision.terminalEvent(
            for: resolution,
            policy: feedbackPolicy
        ) {
            coordinator.haptics.play(
                event,
                scope: hapticScope,
                dedupeKey: "turn-terminal:\(stream.streamId):error"
            )
        }
        switch resolution {
        case .cancelled:
            streamState = .cancelled
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: stream.streamId,
                status: .cancelled,
                message: String(localized: "Response cancelled")
            )
        case .failed:
            streamState = .error
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: stream.streamId,
                status: .failed,
                message: String(localized: "Response failed")
            )
        case .complete:
            streamState = .done
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: stream.streamId,
                status: .complete,
                message: String(localized: "Response complete")
            )
        case .interrupted:
            streamState = .interrupted
            await liveActivities.finish(
                instanceID: instanceId,
                streamID: stream.streamId,
                status: .failed,
                message: String(localized: "Response interrupted")
            )
        }
        await clearFinishedStream(expectedStreamID: stream.streamId)
        return true
    }

    private func scheduleTerminalReconciliation(
        expectedStreamID: String,
        context: AidenRemoteRequestContext
    ) {
        guard terminalReconciliationTask == nil else { return }
        terminalReconciliationTask = Task { [weak self] in
            guard let self else { return }
            defer { terminalReconciliationTask = nil }
            var attempt = 0
            while !Task.isCancelled && coordinator.isCurrent(context) && activeStreamID == expectedStreamID {
                do {
                    let delay = AidenTerminalReconciliation.retryDelayMilliseconds(attempt: attempt)
                    try await Task.sleep(for: .milliseconds(delay))
                    guard coordinator.isCurrent(context), activeStreamID == expectedStreamID else { return }
                    if await reconcileChat(context: context) {
                        guard activeStreamID == expectedStreamID else { return }
                        await clearFinishedStream(expectedStreamID: expectedStreamID)
                        return
                    }
                } catch let error where aidenIsCancellation(error) {
                    return
                } catch {
                    // Keep the durable stream cursor and continue retrying while
                    // this Mac connection remains current. Long Tailscale or
                    // local-network outages must not erase terminal evidence.
                }
                attempt += 1
            }
        }
    }

    private func clearFinishedStream(expectedStreamID: String) async {
        guard activeStreamID == expectedStreamID else { return }
        guard await cache.removeActiveStream(
            instanceId: instanceId,
            chatId: chat.id,
            ifStreamId: expectedStreamID
        ) else { return }
        liveText = ""
        reasoning = ""
        tools = []
        activityTimeline = nil
        pendingApproval = nil
        activeStreamID = nil
    }
}

struct AidenWorkspaceChatsView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Environment(\.aidenPalette) private var palette
    let workspace: AidenWorkspace
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatRemoved: @MainActor (String) -> Void
    let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void
    @State private var model: AidenWorkspaceChatsModel
    @State private var createdChat: AidenChat?
    @State private var renameChat: AidenChat?
    @State private var renameTitle = ""
    @State private var deleteChat: AidenChat?

    init(
        coordinator: AidenRemoteCoordinator,
        workspace: AidenWorkspace,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatRemoved: @escaping @MainActor (String) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in }
    ) {
        self.coordinator = coordinator
        self.workspace = workspace
        self.onChatUpdated = onChatUpdated
        self.onChatRemoved = onChatRemoved
        self.onChatActivityChanged = onChatActivityChanged
        _model = State(initialValue: AidenWorkspaceChatsModel(
            coordinator: coordinator,
            workspaceId: workspace.id,
            onChatUpdated: onChatUpdated,
            onChatRemoved: onChatRemoved
        ))
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
                                onChatUpdated: {
                                    model.accept($0)
                                    onChatUpdated($0)
                                },
                                onChatActivityChanged: onChatActivityChanged
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
                    onChatUpdated: {
                        model.accept($0)
                        onChatUpdated($0)
                    },
                    onChatActivityChanged: onChatActivityChanged
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
        .onAppear { model.setHapticsActive(true) }
        .onDisappear { model.setHapticsActive(false) }
    }

    private func beginRename(_ chat: AidenChat) {
        renameTitle = chat.title
        renameChat = chat
    }
}

private enum AidenChatAttachmentCoordinateSpace {
    static let name = "aiden-chat-attachment-coordinate-space"
}

private struct AidenAttachmentButtonCenterPreferenceKey: PreferenceKey {
    static let defaultValue: CGPoint? = nil

    static func reduce(value: inout CGPoint?, nextValue: () -> CGPoint?) {
        value = nextValue() ?? value
    }
}

struct AidenChatDetailView: View {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenPalette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AidenChatViewModel
    @State private var composerHeight: CGFloat = 132
    @State private var botToolsModel: AidenBotChatToolsModel?
    @State private var botSheet: AidenBotChatSheet?
    @State private var workspaceFileReference: String?
    @State private var showsWorkspaceFile = false
    @State private var progressSheet: AidenProgressSheet?
    @State private var isScrolledAwayFromLatest = false
    @State private var attachmentPicker = AidenAttachmentPickerState()
    @State private var isFileImporterPresented = false
    @State private var attachmentButtonCenter: CGPoint?
    @FocusState private var composerIsFocused: Bool
    @Namespace private var attachmentMotionNamespace
    @State private var coordinator: AidenRemoteCoordinator?
    let autoStartVoice: Bool
    let allowsMutations: Bool

    init(
        coordinator: AidenRemoteCoordinator,
        chat: AidenChat,
        autoStartVoice: Bool = false,
        allowsMutations: Bool = true,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in }
    ) {
        _coordinator = State(initialValue: coordinator)
        _model = State(initialValue: AidenChatViewModel(
            coordinator: coordinator,
            chat: chat,
            allowsMutations: allowsMutations,
            onChatUpdated: onChatUpdated,
            onChatActivityChanged: onChatActivityChanged
        ))
        _botToolsModel = State(initialValue: chat.botId.map {
            AidenBotChatToolsModel(chatID: chat.id, botID: $0)
        })
        self.autoStartVoice = autoStartVoice
        self.allowsMutations = allowsMutations
    }

#if DEBUG
    init(readOnlyFixture chat: AidenChat) {
        _coordinator = State(initialValue: nil)
        _model = State(initialValue: AidenChatViewModel(readOnlyFixture: chat))
        _botToolsModel = State(initialValue: nil)
        autoStartVoice = false
        allowsMutations = false
    }
#endif

    private var workspace: AidenWorkspace? {
        coordinator?.workspaces.first { $0.id == model.chat.workspaceId }
    }

    private var botToolsSessionIdentity: AidenBotChatToolsSessionIdentity? {
        coordinator.map(AidenBotChatToolsSessionIdentity.init)
    }

    private var botPrimarySupportsImages: Bool? {
        guard let bot = botToolsModel?.bot,
              let selection = bot.modelSelection,
              let catalog = botToolsModel?.catalog else { return nil }
        return catalog.model(
            providerId: selection.providerId,
            modelId: selection.modelId
        )?.supportsImages
    }

    private var effectiveAllowsMutations: Bool {
        guard let botToolsModel else { return allowsMutations }
        return allowsMutations && botToolsModel.bot?.health == .ready
    }

    private var presentationStyle: AidenChatPresentationStyle {
        AidenChatPresentationStyle(chat: model.chat)
    }

    var body: some View {
        chatStack
        .background(palette.canvas.ignoresSafeArea())
        .onPreferenceChange(AidenComposerHeightPreferenceKey.self) { height in
            guard height > 0 else { return }
            composerHeight = height
        }
        .onChange(of: effectiveAllowsMutations, initial: true) { _, allowed in
            model.setAllowsMutations(allowed)
        }
        .onChange(of: botToolsModel?.bot?.visionModelSelection, initial: true) { _, selection in
            model.setBotVisionModelSelection(selection)
        }
        .onChange(of: botPrimarySupportsImages, initial: true) { _, supportsImages in
            model.setBotPrimarySupportsImages(supportsImages)
        }
        .onChange(of: model.isStreaming) { _, isStreaming in
            guard isStreaming else { return }
            attachmentPicker.dismiss()
        }
        .navigationTitle(presentationStyle == .botMessages ? "" : model.chat.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { chatToolbar }
        .safeAreaInset(edge: .top, spacing: 0) { botIdentityInset }
        .task(id: scenePhase) {
            guard scenePhase == .active else {
                model.stopProgressObservation()
                return
            }
            await model.load(observeProgress: true)
        }
        .task(id: coordinator?.server?.serverTime) {
            guard scenePhase == .active else { return }
            model.startProgressObservation()
        }
        .task(id: botToolsSessionIdentity) {
            guard let coordinator, let botToolsModel else { return }
            botToolsModel.resetForSessionChange()
            await botToolsModel.load(coordinator: coordinator)
        }
        .environment(\.openURL, OpenURLAction { url in
            let raw = url.relativeString
            if AidenWorkspaceFileLink.path(raw) != nil, model.chat.botId == nil, workspace?.hasFolder == true {
                workspaceFileReference = raw
                showsWorkspaceFile = true
                return .handled
            }
            if url.isFileURL || raw.hasPrefix("/") || raw.hasPrefix("./") || raw.hasPrefix("../") || raw.hasPrefix("~/") { return .discarded }
            return .systemAction
        })
        .sheet(isPresented: $showsWorkspaceFile) {
            if let coordinator, let workspace {
                NavigationStack { AidenWorkspaceFilesView(coordinator: coordinator, workspace: workspace, initialReference: workspaceFileReference) }
            }
        }
        .sheet(item: $botSheet) { botSheetContent($0) }
        .sheet(item: $progressSheet) { progressSheet in
            AidenChatProgressSheet(kind: progressSheet, model: model)
        }
        .alert("Aiden On The Go", isPresented: Binding(
            get: { model.presentedError != nil },
            set: { if !$0 { model.presentedError = nil } }
        )) {
            Button("OK", role: .cancel) { model.presentedError = nil }
        } message: {
            Text(model.presentedError ?? "The operation could not be completed.")
        }
        .alert("Set Up Image Understanding", isPresented: $model.needsBotVisionSetup) {
            if let botID = model.chat.botId {
                Button("Edit Bot") { botSheet = .edit(botID) }
            }
            Button("Not Now", role: .cancel) { }
        } message: {
            Text("This Bot’s primary model reads text only. Choose a vision model for photos and screenshots; attached images and a focused question will go to that model, while replies keep using the current primary model.")
        }
        .onAppear {
            model.setHapticsActive(true)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                model.startProgressObservation()
            } else {
                model.stopProgressObservation()
            }
        }
        .onDisappear {
            model.setHapticsActive(false)
            model.stopProgressObservation()
            attachmentPicker.reset()
        }
    }

    private var chatStack: some View {
        ZStack(alignment: .bottom) {
            transcript
            composer
            AidenAttachmentPickerOverlay(
                picker: attachmentPicker,
                motionNamespace: attachmentMotionNamespace,
                attachmentCapacity: attachmentCapacity,
                canChoosePhotos: model.acceptsImageAttachments,
                isBotChat: model.chat.isBotChat,
                isBusy: attachmentControlsAreBusy,
                attachmentButtonCenter: attachmentButtonCenter,
                onUnavailableBotPhotos: { model.requestBotVisionSetup() },
                onChooseFiles: { isFileImporterPresented = true },
                onCaptureCameraPhoto: commitCapturedPhoto,
                onCommitPhotos: commitSelectedPhotos
            )
            .allowsHitTesting(attachmentPicker.isPresented)
            .accessibilityHidden(!attachmentPicker.isPresented)
            .zIndex(20)
        }
        .coordinateSpace(name: AidenChatAttachmentCoordinateSpace.name)
        .onPreferenceChange(AidenAttachmentButtonCenterPreferenceKey.self) { center in
            attachmentButtonCenter = center
        }
        .animation(
            AidenAttachmentPickerPresentationMotion.transition(
                isPresented: attachmentPicker.isPresented,
                reduceMotion: reduceMotion
            ),
            value: attachmentPicker.isPresented
        )
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: allowedAttachmentContentTypes,
            allowsMultipleSelection: true
        ) { result in
            model.prepareAttachments(result) { url in
                try await AidenAttachmentPreparation.fileUploadAsync(url: url)
            }
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                messageList
            }
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                aidenChatIsScrolledAwayFromLatest(
                    contentOffsetY: geometry.contentOffset.y,
                    containerHeight: geometry.containerSize.height,
                    contentHeight: geometry.contentSize.height,
                    bottomInset: geometry.contentInsets.bottom
                )
            } action: { _, isAwayFromLatest in
                isScrolledAwayFromLatest = isAwayFromLatest
            }
            .simultaneousGesture(
                TapGesture().onEnded { composerIsFocused = false }
            )
            .overlay(alignment: .bottom) {
                if isScrolledAwayFromLatest {
                    AidenChatJumpToLatestButton {
                        isScrolledAwayFromLatest = false
                        scrollToBottom(proxy)
                    }
                    .padding(.bottom, composerHeight + 10)
                    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: isScrolledAwayFromLatest)
            .onChange(of: model.chat.messages.count) { _, _ in
                guard !isScrolledAwayFromLatest else { return }
                scrollToBottom(proxy)
            }
            .onChange(of: model.liveText) { _, _ in
                guard !isScrolledAwayFromLatest else { return }
                scrollToBottom(proxy)
            }
            .onChange(of: model.pendingApproval?.id) { _, approvalID in
                guard approvalID != nil else { return }
                composerIsFocused = false
                if !isScrolledAwayFromLatest {
                    scrollToBottom(proxy)
                }
            }
        }
    }

    private var messageList: some View {
        LazyVStack(
            alignment: .leading,
            spacing: presentationStyle == .botMessages ? 3 : 18
        ) {
            ForEach(Array(model.chat.messages.enumerated()), id: \.element.id) { index, message in
                messageRow(message, at: index)
            }
            if model.isStreaming || !model.liveText.isEmpty {
                AidenLiveResponseView(model: model, presentationStyle: presentationStyle)
            }
            Color.clear
                .frame(height: max(96, composerHeight + 12))
                .accessibilityHidden(true)
            Color.clear.frame(height: 1).id("chat-bottom")
        }
        .padding(.horizontal)
        .padding(.top, 20)
    }

    private func messageRow(_ message: AidenChatMessage, at index: Int) -> some View {
        let previous = index > 0 ? model.chat.messages[index - 1] : nil
        let isBotMessage = presentationStyle == .botMessages
        let topPadding: CGFloat = isBotMessage && !aidenMessagesJoin(previous, message) ? 9 : 0

        return AidenMessageView(
            message: message,
            presentationStyle: presentationStyle,
            loadAttachmentImage: { attachment in
                await model.attachmentImageData(for: attachment)
            }
        )
        .padding(.top, topPadding)
    }

    private var composer: some View {
        VStack(spacing: 0) {
            AidenChatProgressControls(
                taskProgress: model.taskProgress,
                agentRoster: model.agentRoster,
                canReadTasks: model.canReadTaskProgress,
                canReadAgents: model.canReadAgentRoster,
                taskIsStale: model.isTaskProgressStale,
                agentIsStale: model.isAgentRosterStale,
                openTasks: { progressSheet = .tasks },
                openAgents: { progressSheet = .agents }
            )
            AidenComposerView(
                model: model,
                autoStartVoice: autoStartVoice,
                composerFocus: $composerIsFocused,
                attachmentPicker: attachmentPicker,
                motionNamespace: attachmentMotionNamespace,
                canToggleAttachments: canToggleAttachmentPicker,
                onToggleAttachmentPicker: toggleAttachmentPicker
            )
        }
        .disabled(model.isReadOnlyPresentation)
        .padding(.horizontal, 16)
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

    private var attachmentCapacity: Int {
        AidenAttachmentPickerPolicy.availableCapacity(pendingCount: model.pendingAttachments.count)
    }

    private var attachmentControlsAreBusy: Bool {
        !model.isConnected || !canToggleAttachmentPicker
    }

    private var canToggleAttachmentPicker: Bool {
        AidenAttachmentPickerPolicy.canPresent(
            isReadOnly: model.isReadOnlyPresentation,
            isStreaming: model.isStreaming,
            isUploading: model.isUploadingAttachment,
            isPreparing: model.isPreparingAttachments,
            capacity: attachmentCapacity
        )
    }

    private var allowedAttachmentContentTypes: [UTType] {
        let textTypes: [UTType] = [.plainText, .sourceCode, .json, .xml, .commaSeparatedText]
        return model.acceptsImageAttachments ? [.image] + textTypes : textTypes
    }

    private func toggleAttachmentPicker() {
        guard canToggleAttachmentPicker else { return }
        composerIsFocused = false
        if attachmentPicker.isPresented {
            attachmentPicker.dismiss()
        } else {
            attachmentPicker.openMenu()
        }
    }

    private func commitSelectedPhotos() {
        guard !attachmentControlsAreBusy else { return }
        let commit = attachmentPicker.beginCommit(pendingCount: model.pendingAttachments.count)
        guard let commit else { return }

        let preparation = model.prepareAttachments(Result<[PHAsset], Error>.success(commit.assets)) { asset in
            let picked = try await AidenPhotoLibraryImageLoader.pickedImage(for: asset)
            return try await AidenAttachmentPreparation.imageUploadAsync(
                data: picked.data,
                name: picked.name
            )
        }
        guard let preparation else {
            attachmentPicker.finishCommit(commit.id)
            return
        }
        Task { @MainActor in
            await preparation.value
            attachmentPicker.finishCommit(commit.id)
        }
    }

    private func commitCapturedPhoto(_ data: Data) {
        guard !attachmentControlsAreBusy, attachmentCapacity > 0,
              model.acceptsImageAttachments else { return }
        attachmentPicker.dismiss()
        model.prepareAttachments(.success([data])) { capturedData in
            try await AidenAttachmentPreparation.imageUploadAsync(
                data: capturedData,
                name: "Camera Photo.jpg"
            )
        }
    }

    @ToolbarContentBuilder
    private var chatToolbar: some ToolbarContent {
        if let coordinator, let botToolsModel {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        openBotProfile(coordinator: coordinator, model: botToolsModel)
                    } label: {
                        Label("Bot Details", systemImage: "person.crop.circle")
                    }

                    Button {
                        botSheet = .edit(botToolsModel.botID)
                    } label: {
                        Label("Edit Bot", systemImage: "pencil")
                    }
                    .disabled(!canEditBotFromChat)

                    Button {
                        openBotAccess(coordinator: coordinator, model: botToolsModel)
                    } label: {
                        Label("Access", systemImage: "switch.2")
                    }

                    if botToolsModel.fileGrant(
                        coordinator: coordinator,
                        hostAllowsMutations: effectiveAllowsMutations
                    ) != nil {
                        Button {
                            openBotFiles(coordinator: coordinator, model: botToolsModel)
                        } label: {
                            Label("Files", systemImage: "folder")
                        }
                    }
                } label: {
                    Image(systemName: AidenChromeSymbols.overflowMenu)
                        .font(.body.weight(.semibold))
                        .contentShape(Circle())
                }
                .buttonBorderShape(.circle)
                .accessibilityLabel("Bot actions")
            }
        } else if model.chat.botId == nil,
                  let coordinator, let workspace, workspace.hasFolder {
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

    @ViewBuilder
    private var botIdentityInset: some View {
        if let coordinator, let botToolsModel {
            ZStack(alignment: .top) {
                Button {
                    openBotProfile(coordinator: coordinator, model: botToolsModel)
                } label: {
                    VStack(spacing: -8) {
                        if let bot = botToolsModel.bot {
                            AidenBotCanonicalAvatarView(
                                coordinator: coordinator,
                                botID: bot.id,
                                avatar: bot.avatar,
                                name: bot.name,
                                size: 60
                            )
                        } else {
                            Image(systemName: "person.crop.circle.fill")
                                .font(.system(size: 54))
                                .foregroundStyle(palette.secondary)
                                .frame(width: 60, height: 60)
                        }

                        HStack(spacing: 5) {
                            Text(botToolsModel.bot?.name ?? model.chat.title)
                                .font(.headline.weight(.semibold))
                                .lineLimit(1)
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(palette.secondary)
                        }
                        .foregroundStyle(palette.foreground)
                        .padding(.horizontal, 14)
                        .frame(minWidth: 92, maxWidth: 210, minHeight: 34)
                        .aidenBotHeaderNameGlass()
                    }
                    .fixedSize(horizontal: true, vertical: true)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Bot details for \(botToolsModel.bot?.name ?? model.chat.title)")
                .accessibilityHint("Opens this Bot’s settings and profile")
                .offset(y: -17)
            }
            .frame(height: 13)
            .zIndex(2)
        }
    }

    private var canEditBotFromChat: Bool {
        guard coordinator?.connectionState == .connected,
              coordinator?.installationStore.activeInstallation?.canWriteBots == true,
              let bot = botToolsModel?.bot else { return false }
        return bot.health != .archived
    }

    @ViewBuilder
    private func botSheetContent(_ destination: AidenBotChatSheet) -> some View {
        if let coordinator, let botToolsModel {
            switch destination {
            case .access:
                AidenBotChatAccessSheetView(
                    coordinator: coordinator,
                    model: botToolsModel,
                    hostAllowsMutations: effectiveAllowsMutations
                )
            case .profile(let bot):
                AidenBotProfileView(
                    coordinator: coordinator,
                    initialSummary: bot,
                    onOpenConversation: { _ in },
                    onCreateConversation: { _ in },
                    onChanged: {
                        Task { await botToolsModel.load(coordinator: coordinator) }
                    },
                    showsDismissButton: true,
                    showsConversationAction: false,
                    showsFavoriteControls: false
                )
            case .edit(let botID):
                AidenBotEditorView(coordinator: coordinator, mode: .edit(botID: botID)) { _ in
                    Task { await botToolsModel.load(coordinator: coordinator) }
                }
            case .files(let grant):
                NavigationStack {
                    AidenBotConversationFilesView(coordinator: coordinator, grant: grant)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { botSheet = nil }
                            }
                        }
                }
            }
        }
    }

    private func openBotProfile(
        coordinator: AidenRemoteCoordinator,
        model: AidenBotChatToolsModel
    ) {
        Task {
            guard await model.refresh(coordinator: coordinator),
                  let bot = model.bot else { return }
            botSheet = .profile(AidenBotSummary(detail: bot))
        }
    }

    private func openBotAccess(
        coordinator: AidenRemoteCoordinator,
        model: AidenBotChatToolsModel
    ) {
        Task {
            guard await model.refresh(coordinator: coordinator) else { return }
            botSheet = .access
        }
    }

    private func openBotFiles(
        coordinator: AidenRemoteCoordinator,
        model: AidenBotChatToolsModel
    ) {
        Task {
            guard await model.refresh(coordinator: coordinator),
                  let grant = model.fileGrant(
                      coordinator: coordinator,
                      hostAllowsMutations: effectiveAllowsMutations
                  ) else { return }
            botSheet = .files(grant)
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
            proxy.scrollTo("chat-bottom", anchor: .bottom)
        }
    }
}

func aidenChatIsScrolledAwayFromLatest(
    contentOffsetY: CGFloat,
    containerHeight: CGFloat,
    contentHeight: CGFloat,
    bottomInset: CGFloat,
    threshold: CGFloat = 72
) -> Bool {
    guard containerHeight > 0, contentHeight > containerHeight else { return false }
    let viewportBottom = contentOffsetY + containerHeight
    let contentBottom = contentHeight + max(0, bottomInset)
    return contentBottom - viewportBottom > threshold
}

private struct AidenChatJumpToLatestButton: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(palette.foreground)
                .frame(width: 34, height: 34)
                .contentShape(Circle())
                .modifier(AidenChatJumpToLatestGlassModifier(reduceTransparency: reduceTransparency))
        }
        .buttonStyle(.plain)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .accessibilityLabel("Jump to latest")
        .accessibilityHint("Scrolls to the newest message")
    }
}

private struct AidenChatJumpToLatestGlassModifier: ViewModifier {
    @Environment(\.aidenPalette) private var palette
    let reduceTransparency: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *), !reduceTransparency {
            content.glassEffect(.regular.interactive(), in: Circle())
        } else if reduceTransparency {
            content.background(palette.raised, in: Circle())
        } else {
            content.background(.ultraThinMaterial, in: Circle())
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
    let presentationStyle: AidenChatPresentationStyle
    let loadAttachmentImage: (AidenMessageAttachment) async -> Data?

    private var botReply: AidenBotReplyProjection? {
        guard presentationStyle == .botMessages, message.role == .assistant else { return nil }
        return AidenBotReplyProjection.resolve(
            text: message.text,
            timeline: message.timeline,
            isActive: false
        )
    }

    private var visibleText: String {
        botReply?.finalText ?? message.text
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if message.role == .user {
                Spacer(minLength: presentationStyle == .botMessages ? 72 : 48)
                messageContent
            } else {
                messageContent
                    .frame(
                        maxWidth: presentationStyle == .botMessages ? 620 : .infinity,
                        alignment: .leading
                    )
                    .layoutPriority(1)
                if presentationStyle == .botMessages {
                    Spacer(minLength: 72)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .contextMenu {
            if let copyText = AidenMessageActionContent.copyText(
                for: message,
                presentationStyle: presentationStyle
            ) {
                Button {
                    UIPasteboard.general.string = copyText
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
            }
        }
        .accessibilityActions {
            if let copyText = AidenMessageActionContent.copyText(
                for: message,
                presentationStyle: presentationStyle
            ) {
                Button("Copy response") {
                    UIPasteboard.general.string = copyText
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(message.role == .user ? "You" : "Aiden")
    }

    private var messageContent: some View {
        VStack(
            alignment: message.role == .user ? .trailing : .leading,
            spacing: 10
        ) {
            if message.role == .assistant,
               presentationStyle != .botMessages,
               let rows = AidenChronologicalProjection.rows(
                   text: message.text,
                   reasoning: message.reasoning ?? "",
                   timeline: message.timeline
               ) {
                AidenChronologicalTranscript(rows: rows, active: false)
            } else {
            if message.role == .assistant, let reasoning = message.reasoning, !reasoning.isEmpty {
                AidenReasoningCard(text: reasoning, label: "Thought", active: false)
            }
            if message.role == .assistant, let timeline = message.timeline, !timeline.steps.isEmpty {
                AidenActivityFeed(
                    timeline: timeline,
                    active: false,
                    progressText: botReply?.progressText,
                    showsRunningRowsWhenCollapsed: presentationStyle != .botMessages
                )
            }
            if !visibleText.isEmpty {
                messageText
            }
            }
            if let attachments = message.attachments, !attachments.isEmpty {
                let identifierCounts = Dictionary(grouping: attachments, by: \.id).mapValues(\.count)
                let imageAttachments = attachments.filter { attachment in
                    attachment.kind == .image
                        && (attachment.mimeType == "image/jpeg" || attachment.mimeType == "image/png")
                        && attachment.size > 0
                        && attachment.size <= AidenAttachmentImageValidation.maximumBytes
                        && identifierCounts[attachment.id] == 1
                }
                if !imageAttachments.isEmpty {
                    AidenMessageImageAttachmentsView(
                        attachments: imageAttachments,
                        edge: AidenMessageMediaEdge.forRole(message.role),
                        loadData: loadAttachmentImage
                    )
                }
                let fallbackAttachments = attachments.filter { attachment in
                    !imageAttachments.contains(where: { $0.id == attachment.id })
                }
                ForEach(fallbackAttachments.indices, id: \.self) { index in
                    let attachment = fallbackAttachments[index]
                    Label {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(attachment.name).lineLimit(1)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                                .foregroundStyle(palette.secondary)
                        }
                    } icon: {
                        Image(systemName: attachment.kind == .image ? "photo.badge.exclamationmark" : "doc.text")
                    }
                    .font(.caption)
                    .padding(AidenMessageContentSurface.usesRaisedBubble(
                        role: message.role,
                        content: .fallbackAttachment
                    ) ? 10 : 0)
                    .background(
                        AidenMessageContentSurface.usesRaisedBubble(
                            role: message.role,
                            content: .fallbackAttachment
                        ) ? palette.raised : Color.clear,
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                    )
                    .accessibilityElement(children: .combine)
                }
            }
            if message.role == .assistant, let artifacts = message.htmlArtifacts, !artifacts.isEmpty {
                ForEach(artifacts, id: \.id) { artifact in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(artifact.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        Text("Can't view on this device. View in Aiden Agent.")
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(artifact.title). Can't view on this device. View in Aiden Agent.")
                }
            }
            if message.role == .assistant, let outcome = message.outcome {
                AidenMessageOutcomeView(outcome: outcome)
            }
        }
    }

    private var messageText: some View {
        let usesWorkspaceBubble = AidenMessageContentSurface.usesRaisedBubble(
            role: message.role,
            content: .text
        )
        let usesBotBubble = presentationStyle == .botMessages
        return AidenMessageTextView(role: message.role, content: visibleText)
            .foregroundStyle(
                usesBotBubble && message.role == .user
                    ? Color.white
                    : palette.foreground
            )
            .padding(usesWorkspaceBubble || usesBotBubble ? 12 : 0)
            .background {
                if usesBotBubble {
                    AidenBotMessageBubbleShape()
                    .fill(
                        message.role == .user
                            ? palette.accent
                            : Color(uiColor: .secondarySystemFill)
                    )
                } else if usesWorkspaceBubble {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(palette.raised)
                }
            }
    }
}

private struct AidenActivityFeed: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let timeline: AidenGenerationTimeline
    let active: Bool
    let progressText: String?
    let showsRunningRowsWhenCollapsed: Bool
    var steps: [AidenAgentStep]? = nil
    @State private var isExpanded = false

    private var visibleSteps: [AidenAgentStep] { steps ?? timeline.steps }
    private var rows: [AidenAgentStep] { Array(visibleSteps.suffix(3)) }
    private var isRunning: Bool { active && timeline.status == .running }

    var body: some View {
        VStack(alignment: .leading, spacing: isExpanded ? 4 : 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(
                    alignment: isRunning && !isExpanded && showsRunningRowsWhenCollapsed ? .bottom : .center,
                    spacing: 8
                ) {
                    Group {
                        if isRunning && !isExpanded && showsRunningRowsWhenCollapsed {
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(rows) { step in
                                    AidenActivityStepLine(step: step, shimmer: step.id == rows.last?.id && step.isActive)
                                        .frame(height: 24)
                                        .id(step.id)
                                        .transition(.opacity)
                                }
                            }
                            .frame(height: CGFloat(rows.count) * 24, alignment: .bottom)
                            .clipped()
                        } else {
                            Text(AidenAgentActivityPresentation.summary(timeline))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.secondary)
                                .lineLimit(1)
                                .aidenActivityShimmer(isRunning)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    if timeline.issueCount > 0 {
                        Text(timeline.issueCount == 1 ? "1 issue" : "\(timeline.issueCount) issues")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.warning)
                    }

                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(AidenAgentActivityPresentation.summary(timeline))
            .accessibilityHint(isExpanded ? "Collapses activity" : "Expands activity")

            if isExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(visibleSteps) { step in
                        AidenActivityStepLine(step: step, shimmer: isRunning && step.isActive)
                    }
                    if let progressText, !progressText.isEmpty {
                        Divider()
                            .padding(.vertical, 4)
                        Text("Updates")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.secondary)
                        Text(verbatim: progressText)
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                            .lineSpacing(3)
                            .textSelection(.enabled)
                            .padding(.top, 1)
                    }
                }
                .padding(.top, 2)
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: timeline.steps.last?.id)
        .onAppear {
            if timeline.issueCount > 0 { isExpanded = true }
        }
    }
}

private struct AidenActivityStepLine: View {
    @Environment(\.aidenPalette) private var palette
    let step: AidenAgentStep
    let shimmer: Bool

    private var tone: Color {
        switch step.status {
        case .failed: palette.danger
        case .blocked, .cancelled, .awaitingApproval: palette.warning
        default: palette.secondary
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(AidenAgentActivityPresentation.line(for: step))
                .lineLimit(1)
                .truncationMode(.tail)
            if let file = step.producedFile {
                Text("File \(file.operation) · \(file.relativePath.components(separatedBy: "/").last ?? file.relativePath)")
                    .font(.caption2)
                    .lineLimit(1)
                    .accessibilityLabel("File \(file.operation): \(file.relativePath)")
            }
            if let changes = step.lineChanges, changes.additions > 0 || changes.deletions > 0 {
                Text("+\(changes.additions) −\(changes.deletions)")
                    .font(.caption2.monospaced().weight(.medium))
            }
        }
        .font(.caption)
        .foregroundStyle(tone)
        .aidenActivityShimmer(shimmer)
        .accessibilityElement(children: .combine)
    }
}

private struct AidenActivityShimmerModifier: ViewModifier {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let active: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if active && !reduceMotion {
            content.overlay {
                GeometryReader { proxy in
                    TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                        let cycle = context.date.timeIntervalSinceReferenceDate
                            .truncatingRemainder(dividingBy: 1.8) / 1.8
                        LinearGradient(
                            colors: [.clear, .white.opacity(0.42), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: max(proxy.size.width * 0.55, 36))
                        .offset(x: (proxy.size.width * 1.55 * cycle) - proxy.size.width * 0.55)
                    }
                }
                .mask(content)
                .allowsHitTesting(false)
            }
        } else {
            content
        }
    }
}

private extension View {
    func aidenActivityShimmer(_ active: Bool) -> some View {
        modifier(AidenActivityShimmerModifier(active: active))
    }
}

struct AidenMessageOutcomePresentation: Equatable {
    let title: String
    let detail: String?
    let symbol: String
    let isFailure: Bool

    static func make(_ outcome: AidenMessageOutcome) -> Self {
        guard outcome.status == .failed else {
            return Self(title: "Response cancelled", detail: nil, symbol: "stop.circle", isFailure: false)
        }
        let detail: String
        switch outcome.category {
        case "network":
            detail = "Aiden could not reach the model provider."
        case "timeout":
            detail = "The model provider took too long to respond."
        case "service_unavailable":
            detail = "The model provider is temporarily unavailable."
        case "rate_limit":
            detail = "The model provider is receiving too many requests. Try again shortly."
        case "authentication":
            detail = "The model provider rejected its credentials. Check Provider Settings on your Mac."
        case "quota":
            detail = "The model provider account has no available quota."
        case "invalid_request":
            detail = "The model provider could not accept this request. For a Bot, change its model in Edit Bot; for a Workspace chat, use the composer."
        case "context_window":
            detail = "This conversation is too large for the selected model."
        case "output_limit":
            detail = "The model reached its response limit before it could finish."
        case "interrupted":
            detail = "The response was interrupted before it could finish."
        case "context_management":
            detail = "Aiden could not prepare this conversation for the selected model."
        default:
            detail = "The model provider could not complete this response."
        }
        return Self(title: "Generation failed", detail: detail, symbol: "exclamationmark.triangle", isFailure: true)
    }
}

private struct AidenMessageOutcomeView: View {
    @Environment(\.aidenPalette) private var palette
    let outcome: AidenMessageOutcome

    var body: some View {
        let presentation = AidenMessageOutcomePresentation.make(outcome)
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: presentation.symbol)
                .foregroundStyle(presentation.isFailure ? Color.red : palette.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(presentation.title).fontWeight(.semibold)
                if let detail = presentation.detail {
                    Text(detail).foregroundStyle(palette.secondary)
                }
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(
            presentation.isFailure ? Color.red.opacity(0.08) : palette.raised,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }
}

private struct AidenAttachmentGallerySelection: Identifiable {
    let id: String
}

private struct AidenMessageImageAttachmentsView: View {
    @Environment(AidenHapticCenter.self) private var haptics
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let attachments: [AidenMessageAttachment]
    let edge: AidenMessageMediaEdge
    let loadData: (AidenMessageAttachment) async -> Data?
    @State private var gallerySelection: AidenAttachmentGallerySelection?
    @State private var deckSelection = 0
    @State private var deckDragTranslation: CGFloat = 0
    @State private var deckDragAxis: Axis?

    var body: some View {
        Group {
            if attachments.count == 1 {
                AidenAttachmentThumbnailView(
                    attachment: attachments[0],
                    loadData: loadData,
                    contentMode: .fit,
                    showsBackground: false,
                    imageCornerRadius: AidenInlineCardDeckLayout.singleImageCornerRadius,
                    imageAlignment: edge.alignment
                )
                .aspectRatio(AidenInlineCardDeckLayout.viewportAspectRatio, contentMode: .fit)
                .onTapGesture { openGallery(at: 0) }
            } else {
                cardDeck
            }
        }
        .frame(maxWidth: 360, alignment: edge.alignment)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(attachments.count == 1
            ? "Double-tap to open the image viewer"
            : "Swipe up or down to choose a photo. Double-tap to open the image viewer")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { openGallery(at: deckSelection) }
        .accessibilityAdjustableAction { direction in
            guard attachments.count > 1 else { return }
            switch direction {
            case .increment: setDeckSelection(min(deckSelection + 1, attachments.count - 1))
            case .decrement: setDeckSelection(max(deckSelection - 1, 0))
            @unknown default: break
            }
        }
        .onChange(of: attachments.map(\.id)) {
            deckSelection = min(deckSelection, max(attachments.count - 1, 0))
        }
        .fullScreenCover(item: $gallerySelection) { selection in
            AidenAttachmentGalleryView(
                attachments: attachments,
                initialAttachmentID: selection.id,
                loadData: loadData
            )
        }
    }

    private var cardDeck: some View {
        GeometryReader { proxy in
            let width = max(proxy.size.width - 54, 1)
            let dragProgress = AidenInlineCardDeckLayout.dragProgress(
                translation: deckDragTranslation,
                width: width
            )
            ZStack {
                ForEach(Array(attachments.enumerated()), id: \.element.id) { index, attachment in
                    if AidenInlineCardDeckLayout.isVisible(
                        index: index,
                        selection: deckSelection,
                        count: attachments.count
                    ) {
                        deckCard(
                            attachment: attachment,
                            index: index,
                            dragProgress: dragProgress,
                            width: width
                        )
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: edge.alignment)
            .padding(.horizontal, 27)
            .padding(.vertical, 18)
            .contentShape(Rectangle())
            .onTapGesture { openGallery(at: deckSelection) }
            .simultaneousGesture(deckDragGesture(width: width))
        }
        .aspectRatio(AidenInlineCardDeckLayout.viewportAspectRatio, contentMode: .fit)
    }

    private func deckCard(
        attachment: AidenMessageAttachment,
        index: Int,
        dragProgress: CGFloat,
        width: CGFloat
    ) -> some View {
        let isSelected = index == deckSelection
        let isPreferredBackground = index == AidenInlineCardDeckLayout.preferredBackgroundIndex(
            selection: deckSelection,
            count: attachments.count,
            translation: deckDragTranslation
        )
        return AidenAttachmentThumbnailView(
            attachment: attachment,
            loadData: loadData,
            contentMode: .fit,
            showsBackground: false,
            imageCornerRadius: AidenInlineCardDeckLayout.cardCornerRadius,
            imageAlignment: edge.alignment
        )
        .frame(width: width)
        .aspectRatio(AidenInlineCardDeckLayout.viewportAspectRatio, contentMode: .fit)
        .scaleEffect(isSelected ? 1 : 0.94, anchor: edge.scaleAnchor)
        .rotationEffect(
            .degrees(isSelected
                ? Double(dragProgress * 2.4)
                : edge.backgroundRotationDegrees),
            anchor: edge.rotationAnchor
        )
        .offset(
            x: isSelected
                ? AidenInlineCardDeckLayout.selectedCardOffset(translation: deckDragTranslation)
                : 0,
            y: isSelected ? 0 : 7
        )
        .shadow(
            color: .black.opacity(isSelected ? 0.14 : 0),
            radius: isSelected ? 8 : 0,
            y: isSelected ? 5 : 0
        )
        .zIndex(isSelected ? 2 : (isPreferredBackground ? 1 : 0))
        .accessibilityHidden(true)
    }

    private func deckDragGesture(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { value in
                if deckDragAxis == nil {
                    deckDragAxis = abs(value.translation.width) > abs(value.translation.height)
                        ? .horizontal
                        : .vertical
                }
                guard deckDragAxis == .horizontal else { return }
                deckDragTranslation = reduceMotion ? 0 : AidenInlineCardDeckLayout.resistedTranslation(
                    current: deckSelection,
                    count: attachments.count,
                    translation: value.translation.width
                )
            }
            .onEnded { value in
                defer { deckDragAxis = nil }
                guard deckDragAxis == .horizontal else {
                    deckDragTranslation = 0
                    return
                }
                let selection = AidenInlineCardDeckLayout.resolvedSelection(
                    current: deckSelection,
                    count: attachments.count,
                    translation: value.translation.width,
                    predictedTranslation: value.predictedEndTranslation.width
                )
                setDeckSelection(selection)
            }
    }

    private var accessibilityLabel: String {
        if attachments.count == 1 {
            return "Image attachment, \(attachments[0].name)"
        }
        return "\(attachments.count) image attachments, photo \(deckSelection + 1) of \(attachments.count)"
    }

    private func setDeckSelection(_ selection: Int) {
        guard selection != deckSelection else {
            deckDragTranslation = 0
            return
        }
        let update = {
            deckSelection = selection
            deckDragTranslation = 0
        }
        if reduceMotion {
            update()
        } else {
            withAnimation(.spring(duration: 0.22, bounce: 0.08), update)
        }
        haptics.play(.selection)
    }

    private func openGallery(at index: Int) {
        guard attachments.indices.contains(index) else { return }
        gallerySelection = AidenAttachmentGallerySelection(id: attachments[index].id)
    }
}

private struct AidenAttachmentThumbnailView: View {
    enum LoadState {
        case loading
        case image(UIImage)
        case failed
    }

    @Environment(\.aidenPalette) private var palette
    let attachment: AidenMessageAttachment
    let loadData: (AidenMessageAttachment) async -> Data?
    let contentMode: ContentMode
    var showsBackground = true
    var imageCornerRadius: CGFloat = 0
    var imageAlignment: Alignment = .center
    @State private var state: LoadState = .loading

    var body: some View {
        ZStack {
            if showsBackground {
                palette.raised
            }
            switch state {
            case .loading:
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Loading \(attachment.name)")
            case .image(let image):
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
                    .clipShape(RoundedRectangle(
                        cornerRadius: imageCornerRadius,
                        style: .continuous
                    ))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: imageAlignment)
            case .failed:
                VStack(spacing: 6) {
                    Image(systemName: "photo.badge.exclamationmark")
                    Text("Open to retry")
                }
                .font(.caption)
                .foregroundStyle(palette.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Open \(attachment.name) to retry")
            }
        }
        .clipped()
        .task {
            state = .loading
            guard let data = await loadData(attachment), !Task.isCancelled,
                  let image = await AidenAttachmentImageDecoding.thumbnail(
                      data: data,
                      maximumPixelSize: 960
                  ),
                  !Task.isCancelled
            else {
                if !Task.isCancelled { state = .failed }
                return
            }
            state = .image(image)
        }
    }
}

private struct AidenAttachmentGalleryView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(AidenHapticCenter.self) private var haptics
    let attachments: [AidenMessageAttachment]
    let loadData: (AidenMessageAttachment) async -> Data?
    @State private var selectedID: String
    @State private var isSaving = false
    @State private var toastMessage: String?
    @State private var showsPhotoSettingsRecovery = false
    @State private var hapticScope = UUID()

    init(
        attachments: [AidenMessageAttachment],
        initialAttachmentID: String,
        loadData: @escaping (AidenMessageAttachment) async -> Data?
    ) {
        self.attachments = Array(attachments.prefix(20))
        self.loadData = loadData
        _selectedID = State(initialValue: initialAttachmentID)
    }

    var body: some View {
        NavigationStack {
            TabView(selection: $selectedID) {
                ForEach(attachments) { attachment in
                    AidenFullSizeAttachmentView(
                        attachment: attachment,
                        loadData: loadData,
                        isActive: isNearSelection(attachment)
                    )
                        .tag(attachment.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: attachments.count > 1 ? .always : .never))
            .background(Color.black.ignoresSafeArea())
            .navigationTitle(positionLabel)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(.black.opacity(0.72), for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(.white)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            save(selectedAttachments)
                        } label: {
                            Label("Save Image", systemImage: "square.and.arrow.down")
                        }
                        if attachments.count > 1 {
                            Button {
                                save(attachments)
                            } label: {
                                Label("Save All Images", systemImage: "square.stack.3d.down.right")
                            }
                        }
                    } label: {
                        if isSaving {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "square.and.arrow.down")
                        }
                    }
                    .disabled(isSaving)
                    .accessibilityLabel("Save images")
                }
            }
            .overlay(alignment: .bottom) {
                if let toastMessage {
                    Text(toastMessage)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding(.bottom, 44)
                        .transition(.opacity)
                        .accessibilityAddTraits(.isStaticText)
                }
            }
        }
        .alert("Photos Access Needed", isPresented: $showsPhotoSettingsRecovery) {
            Button("Not Now", role: .cancel) {}
            Button("Open Settings") {
                guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else { return }
                openURL(settingsURL)
            }
        } message: {
            Text("Allow Aiden On The Go to add images in Settings, then try again.")
        }
        .onAppear { haptics.activate(scope: hapticScope) }
        .onDisappear { haptics.deactivate(scope: hapticScope) }
    }

    private var selectedAttachments: [AidenMessageAttachment] {
        attachments.first { $0.id == selectedID }.map { [$0] } ?? []
    }

    private var positionLabel: String {
        guard attachments.count > 1,
              let index = attachments.firstIndex(where: { $0.id == selectedID })
        else { return attachments.first?.name ?? "Image" }
        return "\(index + 1) of \(attachments.count)"
    }

    private func isNearSelection(_ attachment: AidenMessageAttachment) -> Bool {
        guard let selectedIndex = attachments.firstIndex(where: { $0.id == selectedID }),
              let attachmentIndex = attachments.firstIndex(where: { $0.id == attachment.id })
        else { return false }
        return AidenAttachmentGalleryWindow.contains(
            index: attachmentIndex,
            selectedIndex: selectedIndex,
            count: attachments.count
        )
    }

    private func save(_ requested: [AidenMessageAttachment]) {
        guard !requested.isEmpty, !isSaving else { return }
        let operationID = UUID()
        isSaving = true
        toastMessage = nil
        Task {
            defer { isSaving = false }
            do {
                let savedCount = try await AidenPhotoLibrarySaving.save(
                    attachments: Array(requested.prefix(20)),
                    loadData: loadData
                )
                announce(savedCount == 1
                    ? String(localized: "Saved to Photos")
                    : String(localized: "Saved \(savedCount) images to Photos"))
                haptics.play(
                    .success,
                    scope: hapticScope,
                    dedupeKey: "photo-save:\(operationID.uuidString)"
                )
            } catch AidenPhotoLibrarySavingError.denied {
                announce(AidenPhotoLibrarySavingError.denied.localizedDescription)
                showsPhotoSettingsRecovery = true
                haptics.play(
                    .warning,
                    scope: hapticScope,
                    dedupeKey: "photo-save:\(operationID.uuidString)"
                )
            } catch let error where aidenIsCancellation(error) {
                return
            } catch {
                announce(error.localizedDescription)
                haptics.play(
                    .error,
                    scope: hapticScope,
                    dedupeKey: "photo-save:\(operationID.uuidString)"
                )
            }
            try? await Task.sleep(for: .seconds(2.5))
            if !Task.isCancelled { toastMessage = nil }
        }
    }

    private func announce(_ message: String) {
        toastMessage = message
        AccessibilityNotification.Announcement(message).post()
    }
}

private struct AidenFullSizeAttachmentView: View {
    let attachment: AidenMessageAttachment
    let loadData: (AidenMessageAttachment) async -> Data?
    let isActive: Bool
    @State private var image: UIImage?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        ZStack {
            Color.black
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .accessibilityLabel(attachment.name)
            } else if failed {
                Button {
                    attempt += 1
                } label: {
                    Label("Retry Image", systemImage: "arrow.clockwise")
                        .foregroundStyle(.white)
                        .padding()
                }
            } else {
                ProgressView().tint(.white)
                    .accessibilityLabel("Loading \(attachment.name)")
            }
        }
        .task(id: "\(attempt)-\(isActive)") {
            image = nil
            failed = false
            guard isActive else { return }
            guard let data = await loadData(attachment), !Task.isCancelled,
                  let decoded = await AidenAttachmentImageDecoding.thumbnail(
                      data: data,
                      maximumPixelSize: 2_560
                  ),
                  !Task.isCancelled
            else {
                if !Task.isCancelled { failed = true }
                return
            }
            image = decoded
        }
    }
}

enum AidenAttachmentImageDecoding {
    static func validatedData(
        _ data: Data,
        mimeType: String,
        declaredSize: Int
    ) async -> Data? {
        await AidenAttachmentImageDecoder.shared.validatedData(
            data,
            mimeType: mimeType,
            declaredSize: declaredSize
        )
    }

    static func thumbnail(data: Data, maximumPixelSize: Int) async -> UIImage? {
        await AidenAttachmentImageDecoder.shared.thumbnail(
            data: data,
            maximumPixelSize: maximumPixelSize
        )
    }
}

enum AidenAttachmentThumbnailCacheKey {
    static func make(data: Data, maximumPixelSize: Int) -> String {
        let digest = Data(SHA256.hash(data: data)).base64EncodedString()
        return "\(maximumPixelSize):\(digest)"
    }
}

private actor AidenAttachmentImageDecoder {
    static let shared = AidenAttachmentImageDecoder()
    private let thumbnailCache: NSCache<NSString, UIImage>

    init() {
        thumbnailCache = NSCache<NSString, UIImage>()
        thumbnailCache.countLimit = 24
        thumbnailCache.totalCostLimit = 32 * 1_024 * 1_024
    }

    func validatedData(_ data: Data, mimeType: String, declaredSize: Int) -> Data? {
        guard !Task.isCancelled else { return nil }
        return AidenAttachmentImageValidation.validatedData(
            data,
            mimeType: mimeType,
            declaredSize: declaredSize
        )
    }

    func thumbnail(data: Data, maximumPixelSize: Int) -> UIImage? {
        guard !Task.isCancelled else { return nil }
        guard maximumPixelSize > 0 else { return nil }
        let cacheKey = AidenAttachmentThumbnailCacheKey.make(
            data: data,
            maximumPixelSize: maximumPixelSize
        ) as NSString
        if let cached = thumbnailCache.object(forKey: cacheKey) {
            return cached
        }
        guard !Task.isCancelled,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
                  kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary)
        else { return nil }
        guard !Task.isCancelled else { return nil }
        let decoded = UIImage(cgImage: image)
        thumbnailCache.setObject(
            decoded,
            forKey: cacheKey,
            cost: image.bytesPerRow * image.height
        )
        return decoded
    }
}

enum AidenPhotoLibrarySavingError: LocalizedError {
    case denied
    case invalidImage

    var errorDescription: String? {
        switch self {
        case .denied: String(localized: "Allow Aiden On The Go to add images in Photos Settings, then try again.")
        case .invalidImage: String(localized: "One or more images could not be saved.")
        }
    }
}

enum AidenPhotoLibrarySaving {
    @MainActor
    static func save(
        attachments: [AidenMessageAttachment],
        loadData: (AidenMessageAttachment) async -> Data?
    ) async throws -> Int {
        guard !attachments.isEmpty, attachments.count <= 20 else {
            throw AidenPhotoLibrarySavingError.invalidImage
        }
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw AidenPhotoLibrarySavingError.denied
        }

        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appending(path: "AidenPhotoSave-\(UUID().uuidString)", directoryHint: .isDirectory)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: directory) }
        var urls: [URL] = []
        urls.reserveCapacity(attachments.count)
        for (index, attachment) in attachments.enumerated() {
            try Task.checkCancellation()
            guard let data = await loadData(attachment) else {
                throw AidenPhotoLibrarySavingError.invalidImage
            }
            let url = try await stage(
                data: data,
                attachment: attachment,
                index: index,
                directory: directory
            )
            urls.append(url)
        }
        try await PHPhotoLibrary.shared().performChanges {
            for url in urls {
                PHAssetCreationRequest.forAsset().addResource(
                    with: .photo,
                    fileURL: url,
                    options: nil
                )
            }
        }
        return urls.count
    }

    private static func stage(
        data: Data,
        attachment: AidenMessageAttachment,
        index: Int,
        directory: URL
    ) async throws -> URL {
        let worker = Task.detached(priority: .utility) {
            try Task.checkCancellation()
            guard AidenAttachmentImageValidation.validatedData(
                data,
                mimeType: attachment.mimeType,
                declaredSize: attachment.size
            ) != nil else { throw AidenPhotoLibrarySavingError.invalidImage }
            let ext = attachment.mimeType == "image/png" ? "png" : "jpg"
            let url = directory.appending(path: "\(index)-\(UUID().uuidString).\(ext)")
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            try Task.checkCancellation()
            return url
        }
        return try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: {
            worker.cancel()
        }
    }
}

enum AidenMessageActionContent {
    static func copyText(
        for message: AidenChatMessage,
        presentationStyle: AidenChatPresentationStyle = .workspace
    ) -> String? {
        guard message.role == .assistant, !message.text.isEmpty else { return nil }
        let text = presentationStyle == .botMessages
            ? AidenBotReplyProjection.resolve(
                text: message.text,
                timeline: message.timeline,
                isActive: false
            ).finalText
            : message.text
        return text.isEmpty ? nil : text
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
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Bindable var model: AidenChatViewModel
    let presentationStyle: AidenChatPresentationStyle

    private var botReply: AidenBotReplyProjection? {
        guard presentationStyle == .botMessages else { return nil }
        return AidenBotReplyProjection.resolve(
            text: model.liveText,
            timeline: model.activityTimeline,
            isActive: model.isStreaming
        )
    }

    private var visibleText: String {
        botReply?.finalText ?? model.liveText
    }

    private var reasoningActive: Bool {
        guard model.isStreaming else { return false }
        if AidenAgentActivityPresentation.hasActiveThinkingStep(model.activityTimeline) {
            return true
        }
        return model.activityTimeline == nil && model.liveText.isEmpty
    }

    private var visibleActivitySteps: [AidenAgentStep] {
        guard let timeline = model.activityTimeline else { return [] }
        return AidenAgentActivityPresentation.activitySteps(
            timeline,
            reasoningVisible: !model.reasoning.isEmpty
        )
    }

    private var visualizingLabel: String? {
        guard model.isStreaming else { return nil }
        return AidenAgentActivityPresentation.visualizingLabel(model.activityTimeline)
    }

    private var chronologicalRows: [AidenChronologicalRow]? {
        guard presentationStyle != .botMessages else { return nil }
        return AidenChronologicalProjection.rows(
            text: model.liveText,
            reasoning: model.reasoning,
            timeline: model.activityTimeline
        )
    }

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
        return ("Thinking", .solving)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if chronologicalRows == nil && model.isStreaming && model.reasoning.isEmpty && model.activityTimeline?.steps.isEmpty != false {
                HStack(spacing: 8) {
                    ThinkingOrb(state: activity.orb, size: .px20)
                    Text(activity.label)
                        .foregroundStyle(palette.secondary)
                }
                .font(.callout)
                .accessibilityElement(children: .combine)
                .transition(.opacity)
            }

            if chronologicalRows == nil && !model.reasoning.isEmpty {
                AidenReasoningCard(
                    text: model.reasoning,
                    label: AidenAgentActivityPresentation.reasoningLabel(
                        model.activityTimeline,
                        active: reasoningActive
                    ),
                    active: reasoningActive
                )
                    .transition(.opacity)
            }

            if chronologicalRows == nil, let timeline = model.activityTimeline, !visibleActivitySteps.isEmpty {
                AidenActivityFeed(
                    timeline: timeline,
                    active: model.isStreaming,
                    progressText: botReply?.progressText,
                    showsRunningRowsWhenCollapsed: presentationStyle != .botMessages,
                    steps: visibleActivitySteps
                )
                    .transition(.opacity)
            } else if chronologicalRows == nil && !model.tools.isEmpty {
                AidenToolActivityCard(tools: model.tools)
            }

            if let chronologicalRows {
                AidenChronologicalTranscript(rows: chronologicalRows, active: model.isStreaming)
                    .contextMenu {
                        if !visibleText.isEmpty {
                            Button {
                                UIPasteboard.general.string = visibleText
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                        }
                    }
                    .accessibilityActions {
                        if !visibleText.isEmpty {
                            Button("Copy response") {
                                UIPasteboard.general.string = visibleText
                            }
                        }
                    }
            }

            if let visualizingLabel,
               !(chronologicalRows?.contains(where: { row in
                   row.kind == .tool && row.steps.contains(where: { $0.toolName == "render_artifact" && $0.isActive })
               }) ?? false) {
                AidenActivityPhaseCard(label: visualizingLabel)
                    .transition(.opacity)
            }

            if let approval = model.pendingApproval {
                AidenApprovalCard(
                    summary: approval.summary,
                    kind: approval.kind,
                    canRespond: approval.canRespond,
                    hasRequiredWriteCapability: approval.hasRequiredWriteCapability,
                    canAllow: approval.canAllow,
                    onDeny: { Task { await model.respondToApproval(.deny, approvalID: approval.id) } },
                    onAllow: { Task { await model.respondToApproval(.allow, approvalID: approval.id) } }
                )
                .disabled(!model.isConnected || model.isReadOnlyPresentation || model.isRespondingToApproval || model.isStopping)
                .id(approval.id)
            }

            if chronologicalRows == nil && !visibleText.isEmpty {
                AidenMarkdownView(content: visibleText)
                    .padding(presentationStyle == .botMessages ? 12 : 0)
                    .background {
                        if presentationStyle == .botMessages {
                            AidenBotMessageBubbleShape()
                            .fill(Color(uiColor: .secondarySystemFill))
                        }
                    }
                    .frame(
                        maxWidth: presentationStyle == .botMessages ? 620 : .infinity,
                        alignment: .leading
                    )
                    .contextMenu {
                        Button {
                            UIPasteboard.general.string = visibleText
                        } label: {
                            Label("Copy", systemImage: "doc.on.doc")
                        }
                    }
                    .accessibilityActions {
                        Button("Copy response") {
                            UIPasteboard.general.string = visibleText
                        }
                    }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.activityTimeline?.steps.last?.id)
    }
}

private struct AidenApprovalCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @State private var isExpanded = false

    let summary: String
    let kind: AidenApprovalKind
    let canRespond: Bool
    let hasRequiredWriteCapability: Bool
    let canAllow: Bool
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
                    Text(AidenApprovalPresentation.title(for: kind))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.foreground)

                    Text(AidenApprovalPresentation.detail(for: kind))
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if kind == .scheduledTask {
                Text(summary)
                    .font(.caption.monospaced())
                    .foregroundStyle(palette.foreground)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(palette.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityLabel("Scheduled task proposal")
                    .accessibilityValue(summary)
            } else {
                Button {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 8) {
                        Text(AidenApprovalPresentation.oneLineSummary(summary))
                            .font(.caption.monospaced())
                            .foregroundStyle(palette.foreground)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(palette.secondary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(palette.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityLabel("Requested action")
                .accessibilityValue(AidenApprovalPresentation.oneLineSummary(summary))
                .accessibilityHint(isExpanded ? "Collapses action details" : "Expands action details")

                if isExpanded {
                    Text(summary)
                        .font(.caption.monospaced())
                        .foregroundStyle(palette.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(palette.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }

            if !canRespond {
                Label("This paired device can review approvals but cannot respond.", systemImage: "lock.fill")
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
            } else if kind == .scheduledTask && !hasRequiredWriteCapability {
                Label("Schedule write access is required to approve this task.", systemImage: "lock.fill")
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
            } else if kind == .scheduledTask && !canAllow {
                Label("This task must be approved on your Mac.", systemImage: "desktopcomputer")
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
            }

            if canRespond {
                HStack(spacing: 8) {
                    Spacer(minLength: 0)

                    Button(action: onDeny) {
                        Text(AidenApprovalPresentation.denyTitle(for: kind))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.foreground)
                            .padding(.horizontal, 13)
                            .frame(height: 34)
                            .aidenApprovalActionGlass()
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 5)

                    if canAllow {
                        Button(action: onAllow) {
                            Text(AidenApprovalPresentation.allowTitle(for: kind))
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

private struct AidenChronologicalTranscript: View {
    @Environment(\.aidenPalette) private var palette
    let rows: [AidenChronologicalRow]
    let active: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(rows) { row in
                switch row.kind {
                case .text:
                    AidenMessageTextView(role: .assistant, content: row.text)
                        .foregroundStyle(palette.foreground)
                case .reasoning:
                    if let step = row.steps.first {
                        let label = step.finishedAt == nil ? "Thinking" : "Thought \(AidenAgentActivityPresentation.duration(step.durationMs))"
                        if row.text.isEmpty {
                            AidenActivityPhaseCard(label: label, active: active && step.finishedAt == nil)
                        } else {
                            AidenReasoningCard(text: row.text, label: label, active: active && step.finishedAt == nil)
                        }
                    }
                case .tool:
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(row.steps) { step in
                            AidenActivityStepLine(step: step, shimmer: active && step.isActive)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        }
    }
}

private struct AidenReasoningCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let text: String
    let label: String
    let active: Bool
    @State private var isExpanded = true
    @State private var userControlled = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                userControlled = true
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Text(label)
                        .font(.caption.weight(.semibold))
                        .aidenActivityShimmer(active)
                    Spacer(minLength: 6)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .frame(height: 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                ScrollView {
                    Text(text)
                        .font(.caption)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }
                .frame(maxHeight: 144, alignment: .top)
                .padding(.bottom, 10)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
        .task {
            guard active else {
                isExpanded = false
                return
            }
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, !userControlled else { return }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                isExpanded = false
            }
        }
    }
}

private struct AidenActivityPhaseCard: View {
    @Environment(\.aidenPalette) private var palette
    let label: String
    var active: Bool = true

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.secondary)
            .aidenActivityShimmer(active)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            .padding(.horizontal, 12)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityLabel(label)
    }
}

private struct AidenToolActivityCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let tools: [AidenLiveTool]
    @State private var isExpanded = false

    private var isComplete: Bool {
        !tools.isEmpty && tools.allSatisfy { tool in
            guard let status = tool.status?.lowercased() else { return false }
            return ["completed", "complete", "succeeded", "success"].contains(status)
        }
    }
    private var hasIssue: Bool {
        tools.contains { tool in
            guard let status = tool.status?.lowercased() else { return false }
            return ["failed", "blocked", "cancelled", "canceled", "denied"].contains(status)
        }
    }
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
                    Image(systemName: hasIssue ? "exclamationmark.circle.fill" : (isComplete ? "checkmark.circle.fill" : "wrench.and.screwdriver.fill"))
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(palette.secondary)
                        .frame(width: 18, height: 18)
                    Text(hasIssue ? "Tool issue" : (isComplete ? "Tools used" : "Using tools"))
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
                            Image(systemName: legacySymbol(for: tool.status))
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

    private func legacySymbol(for status: String?) -> String {
        guard let status = status?.lowercased() else { return "circle.dotted" }
        if ["completed", "complete", "succeeded", "success"].contains(status) { return "checkmark.circle" }
        if ["failed", "blocked", "cancelled", "canceled", "denied"].contains(status) {
            return "exclamationmark.circle"
        }
        return "circle.dotted"
    }
}

private struct AidenComposerView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var model: AidenChatViewModel
    let autoStartVoice: Bool
    let composerFocus: FocusState<Bool>.Binding
    @Bindable var attachmentPicker: AidenAttachmentPickerState
    let motionNamespace: Namespace.ID
    let canToggleAttachments: Bool
    let onToggleAttachmentPicker: () -> Void
    @State private var voiceInput = ComposerVoiceInputController()
    @State private var didAutoStartVoice = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
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

            TextField("Message Aiden", text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 4)
                    .padding(.top, 5)
                    .focused(composerFocus)
                    .disabled(voiceInput.isBusy)
                    .submitLabel(.send)
                    .onSubmit {
                        guard !model.isStreaming else { return }
                        voiceInput.stopBeforeSubmittingDraft()
                        Task { await model.send() }
                    }

                HStack(alignment: .center, spacing: 10) {
                Button(action: onToggleAttachmentPicker) {
                    Image(systemName: "plus")
                        .font(.title3.weight(.medium))
                        .frame(width: 44, height: 44)
                        .rotationEffect(.degrees(attachmentPicker.isPresented ? 45 : 0))
                        .opacity(model.isUploadingAttachment || model.isPreparingAttachments ? 0.48 : 1)
                        .overlay(alignment: .bottomTrailing) {
                            if model.isUploadingAttachment || model.isPreparingAttachments {
                                ProgressView()
                                    .controlSize(.mini)
                                    .padding(3)
                                    .background(.regularMaterial, in: Circle())
                            }
                        }
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())
                .disabled(!canToggleAttachments)
                .accessibilityLabel("Add attachment")
                .accessibilityValue(attachmentPicker.isPresented ? "Open" : "Closed")
                .accessibilityHint(model.acceptsImageAttachments
                    ? "Attach an image or bounded text file"
                    : "Attach a bounded text file. This model cannot read images")
                .background {
                    GeometryReader { proxy in
                        let frame = proxy.frame(in: .named(AidenChatAttachmentCoordinateSpace.name))
                        Color.clear.preference(
                            key: AidenAttachmentButtonCenterPreferenceKey.self,
                            value: CGPoint(x: frame.midX, y: frame.midY)
                        )
                    }
                }

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
                } else if model.showsComposerModelControl,
                          let selectedModel = model.selectedModel {
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
                        guard !model.isReadOnlyPresentation else { return }
                        await voiceInput.toggle(
                            currentDraft: model.draft,
                            updateDraft: { model.draft = $0 },
                            macTranscriber: model.transcribeMacSpeech
                        )
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
                .disabled(
                    model.isReadOnlyPresentation || model.isStreaming
                        || (voiceInput.isBusy && !voiceInput.isListening)
                )
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
                    .disabled(!model.canControlCurrentRun || model.isStopping)
                    .accessibilityLabel(model.isStopping ? "Stopping response" : "Stop response")
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
                .allowsHitTesting(false)
        }
        .shadow(color: .black.opacity(0.12), radius: 14, y: 6)
        .animation(
            reduceMotion ? nil : .smooth(duration: 0.34),
            value: visiblePendingAttachments.map(\.id) + attachmentPicker.committingAssets.map(\.localIdentifier)
        )
        .task {
            guard !model.isReadOnlyPresentation, autoStartVoice, !didAutoStartVoice else { return }
            didAutoStartVoice = true
            await voiceInput.toggle(
                currentDraft: model.draft,
                updateDraft: { model.draft = $0 },
                macTranscriber: model.transcribeMacSpeech
            )
        }
        .onDisappear {
            voiceInput.cancelDiscardingRecording()
            model.cancelAttachmentPreparation()
        }
        .onChange(of: scenePhase) { _, phase in
            if AidenVoiceCaptureLifecyclePolicy.shouldDiscardRecording(for: phase) {
                voiceInput.cancelDiscardingRecording()
            }
        }
    }

    private var visiblePendingAttachments: [AidenAttachmentReference] {
        guard !attachmentPicker.committingAssets.isEmpty else { return model.pendingAttachments }
        return Array(model.pendingAttachments.prefix(attachmentPicker.committingPendingPrefixCount))
    }

    private var sendButtonBackground: Color {
        if model.canSend { return palette.accent }
        return palette.foreground.opacity(colorScheme == .dark ? 0.18 : 0.12)
    }

    private var sendButtonForeground: Color {
        model.canSend ? palette.canvas : palette.secondary
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

private struct AidenComposerGlassModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    let enabled: Bool
    private let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)

    @ViewBuilder
    func body(content: Content) -> some View {
        if !enabled {
            content
        } else if #available(iOS 26, *), !reduceTransparency {
            // The whole composer is a stable surface containing its own
            // interactive controls. Marking the container interactive causes
            // Liquid Glass to recompute multiple times during streamed updates.
            content.glassEffect(.regular, in: shape)
        } else if reduceTransparency {
            content.background(palette.raised, in: shape)
        } else {
            content.background(.regularMaterial, in: shape)
        }
    }
}

private extension View {
    func aidenComposerGlass(enabled: Bool = true) -> some View {
        modifier(AidenComposerGlassModifier(enabled: enabled))
    }
}
