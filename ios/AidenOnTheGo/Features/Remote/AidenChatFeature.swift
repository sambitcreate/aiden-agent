import AVFoundation
import Accessibility
import CoreTransferable
import CryptoKit
import ImageIO
import MarkdownUI
import Observation
import Photos
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

    private static func hasAlpha(_ image: UIImage) -> Bool {
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

private struct AidenPickedImageFile: Transferable, Sendable {
    let url: URL
    let name: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            let source = received.file
            let values = try source.resourceValues(forKeys: [.fileSizeKey])
            guard let size = values.fileSize,
                  size > 0,
                  size <= AidenAttachmentPreparation.maximumSourceImageBytes
            else { throw AidenAttachmentPreparationError.imageTooLarge }
            let originalName = source.lastPathComponent
            let destinationBase = FileManager.default.temporaryDirectory
                .appending(path: "AidenPickedImage-\(UUID().uuidString)")
            let destination = source.pathExtension.isEmpty
                ? destinationBase
                : destinationBase.appendingPathExtension(source.pathExtension)
            try FileManager.default.copyItem(at: source, to: destination)
            return Self(url: destination, name: originalName)
        }
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

enum AidenBotComposerTrailingControl: Equatable {
    case stopResponse
    case stopVoiceInput
    case send(isEnabled: Bool)
    case startVoiceInput
}

func aidenBotComposerTrailingControl(
    isStreaming: Bool,
    isListening: Bool,
    draft: String,
    attachmentCount: Int,
    canSend: Bool
) -> AidenBotComposerTrailingControl {
    if isStreaming { return .stopResponse }
    if isListening { return .stopVoiceInput }
    let hasContent = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || attachmentCount > 0
    return hasContent ? .send(isEnabled: canSend) : .startVoiceInput
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
    let isOutgoing: Bool
    let showsTail: Bool

    func path(in rect: CGRect) -> Path {
        let tailWidth: CGFloat = showsTail ? 7 : 0
        let body = CGRect(
            x: isOutgoing ? rect.minX : rect.minX + tailWidth,
            y: rect.minY,
            width: rect.width - tailWidth,
            height: rect.height
        )
        var path = Path(
            roundedRect: body,
            cornerRadius: 18,
            style: .continuous
        )
        guard showsTail else { return path }

        var tail = Path()
        if isOutgoing {
            tail.move(to: CGPoint(x: body.maxX - 10, y: body.maxY - 4))
            tail.addCurve(
                to: CGPoint(x: rect.maxX, y: rect.maxY),
                control1: CGPoint(x: body.maxX - 2, y: body.maxY - 2),
                control2: CGPoint(x: rect.maxX - 2, y: rect.maxY - 1)
            )
            tail.addCurve(
                to: CGPoint(x: body.maxX - 1, y: body.maxY - 13),
                control1: CGPoint(x: rect.maxX - 5, y: rect.maxY - 5),
                control2: CGPoint(x: body.maxX, y: body.maxY - 9)
            )
        } else {
            tail.move(to: CGPoint(x: body.minX + 10, y: body.maxY - 4))
            tail.addCurve(
                to: CGPoint(x: rect.minX, y: rect.maxY),
                control1: CGPoint(x: body.minX + 2, y: body.maxY - 2),
                control2: CGPoint(x: rect.minX + 2, y: rect.maxY - 1)
            )
            tail.addCurve(
                to: CGPoint(x: body.minX + 1, y: body.maxY - 13),
                control1: CGPoint(x: rect.minX + 5, y: rect.maxY - 5),
                control2: CGPoint(x: body.minX, y: body.maxY - 9)
            )
        }
        path.addPath(tail)
        return path
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
            try await persist(chat: chat, instanceId: instanceId)
            return chat
        } catch {
            guard coordinator.isCurrent(context) else { return nil }
            presentedError = error.localizedDescription
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
            try await persist(chat: updated, instanceId: instanceId)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            upsert(chat)
            presentedError = error.localizedDescription
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
            try await cache.saveChats(chats, instanceId: instanceId, workspaceId: workspaceId)
        } catch {
            guard coordinator.isCurrent(context) else { return }
            upsert(chat)
            presentedError = error.localizedDescription
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
    private let draftStore: AidenChatDraftStore
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var titleRefreshTask: Task<Void, Never>?
    @ObservationIgnored private var terminalReconciliationTask: Task<Void, Never>?
    @ObservationIgnored private var activeStreamID: String?
    @ObservationIgnored private var turnAttempts = AidenTurnAttemptTracker()
    @ObservationIgnored private var draftSession: AidenChatDraftStore.Session?
    @ObservationIgnored private var draftPersistenceTask: Task<Void, Never>?
    @ObservationIgnored private var suppressesDraftPersistence = false
    @ObservationIgnored private var draftGeneration: UInt64 = 0

    private(set) var chat: AidenChat
    private(set) var catalog: AidenModelCatalog?
    private(set) var isLoading = false
    private(set) var isStarting = false
    private(set) var streamState: AidenStreamState?
    private(set) var liveText = ""
    private(set) var reasoning = ""
    private(set) var tools: [AidenLiveTool] = []
    private(set) var activityTimeline: AidenGenerationTimeline?
    private(set) var pendingApproval: AidenPendingApproval?
    private(set) var pendingAttachments: [AidenAttachmentReference] = []
    private(set) var isUploadingAttachment = false
    var draft = "" {
        didSet {
            guard draft != oldValue else { return }
            draftGeneration &+= 1
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
        cache: AidenChatCache = .shared,
        draftStore: AidenChatDraftStore = .shared,
        liveActivities: AidenRemoteLiveActivityManager? = nil,
        allowsMutations: Bool = true,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in }
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
        self.onChatUpdated = onChatUpdated
        selectedProviderId = chat.providerId
        selectedModelId = chat.modelId
    }

#if DEBUG
    init(readOnlyFixture chat: AidenChat) {
        runtime = .readOnlyFixture
        self.chat = chat
        allowsMutations = false
        draftStore = .shared
        onChatUpdated = { _ in }
        selectedProviderId = chat.providerId
        selectedModelId = chat.modelId
    }
#endif

    var isConnected: Bool {
        guard !isReadOnlyFixture else { return false }
        return coordinator.connectionState == .connected
    }
    var isStreaming: Bool { streamState.map { !$0.isTerminal } ?? false }
    var canSend: Bool {
        guard !isReadOnlyPresentation else { return false }
        return (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty) &&
        isConnected && coordinator.activeInstanceId == instanceId
            && !isStarting && !isUploadingAttachment && !isStreaming && hasTurnModelAuthority
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
    var selectedModelDisplayLabel: String { selectedModel?.label ?? selectedModelId ?? "Model unavailable" }

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

    func load() async {
        guard !isReadOnlyFixture else { return }
        guard !instanceId.isEmpty, !isLoading else { return }
        guard let context = try? coordinator.requestContext(for: instanceId) else { return }
        isLoading = true
        defer { isLoading = false }
        if draftSession == nil {
            let session = await draftStore.beginSession(instanceId: instanceId, chatId: chat.id)
            guard coordinator.isCurrent(context) else { return }
            draftSession = session
            if draft.isEmpty, let savedDraft = await draftStore.load(session: session) {
                guard coordinator.isCurrent(context), draftSession == session else { return }
                draft = savedDraft
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
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            if chat.messages.isEmpty { presentedError = error.localizedDescription }
        }
        guard coordinator.isCurrent(context) else { return }
        await restoreStreamIfNeeded()
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
        selectedProviderId = providerId
        selectedModelId = visibleProviders.first { $0.id == providerId }?.models.first?.id
        selectedThinkingLevel = selectedModel?.effectiveThinkingLevel
    }

    func selectModel(_ modelId: String) {
        guard !chat.isBotChat else { return }
        selectedModelId = modelId
        selectedThinkingLevel = selectedModel?.effectiveThinkingLevel
    }

    func send() async {
        guard !isReadOnlyPresentation else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
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
            startStreaming(stream, context: context)
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
        }
    }

    @discardableResult
    func upload(_ uploads: [AidenAttachmentUpload]) async -> Int {
        guard !isReadOnlyPresentation else { return uploads.count }
        guard isConnected, !isUploadingAttachment, !isStreaming, pendingAttachments.count < 10 else {
            return uploads.count
        }
        guard let context = try? coordinator.requestContext(for: instanceId) else { return uploads.count }
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
            } catch is CancellationError {
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

    func stop() async {
        guard !isReadOnlyPresentation else { return }
        guard let stream = await cache.loadActiveStream(instanceId: instanceId, chatId: chat.id) else { return }
        guard let context = try? coordinator.requestContext(for: instanceId) else { return }
        let previousState = streamState
        pendingApproval = nil
        streamState = .cancelled
        do {
            let status = try await coordinator.remoteClient(for: context).cancelStream(id: stream.streamId)
            guard coordinator.isCurrent(context), activeStreamID == stream.streamId else { return }
            await apply(status, streamID: stream.streamId, context: context)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context), activeStreamID == stream.streamId else { return }
            streamState = previousState
            presentedError = error.localizedDescription
        }
    }

    func respondToApproval(_ decision: AidenApprovalDecision) async {
        guard !isReadOnlyPresentation else { return }
        guard let approval = pendingApproval, approval.expiresAt > Date() else {
            pendingApproval = nil
            return
        }
        let previousState = streamState
        guard let streamID = activeStreamID else { return }
        guard let context = try? coordinator.requestContext(for: instanceId) else { return }
        pendingApproval = nil
        streamState = .running
        do {
            _ = try await coordinator.remoteClient(for: context).respondToApproval(id: approval.id, decision: decision)
            guard coordinator.isCurrent(context), activeStreamID == streamID else { return }
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context), activeStreamID == streamID else { return }
            pendingApproval = approval
            streamState = previousState
            presentedError = error.localizedDescription
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
            await apply(status, streamID: stream.streamId, context: context)
            // A terminal status can become visible before its final SSE event is
            // consumed. Keep the durable cursor and replay first so cancellation
            // and provider-failure details are never skipped on reopen.
            startStreaming(stream, context: context)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            presentedError = error.localizedDescription
            await liveActivities.markStale(instanceID: instanceId, streamID: stream.streamId)
            // Retain and resume the durable cursor even if the first status
            // probe happens while the phone is offline.
            startStreaming(stream, context: context)
        }
    }

    private func startStreaming(_ stream: AidenChatCache.ActiveStream, context: AidenRemoteRequestContext) {
        terminalReconciliationTask?.cancel()
        terminalReconciliationTask = nil
        streamTask?.cancel()
        activeStreamID = stream.streamId
        streamTask = Task { [weak self] in
            await self?.consume(stream, context: context)
        }
    }

    private func consume(_ original: AidenChatCache.ActiveStream, context: AidenRemoteRequestContext) async {
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
                    await apply(event, context: context)
                    guard activeStreamID == stream.streamId else { return }
                    stream.lastSequence = event.sequence
                    if event.terminal { return }
                    try await cache.saveActiveStream(stream, instanceId: instanceId, chatId: chat.id)
                }

                let status = try await coordinator.remoteClient(for: context).streamStatus(id: stream.streamId)
                guard coordinator.isCurrent(context), activeStreamID == stream.streamId else { return }
                retryAttempt = 0
                await apply(status, streamID: stream.streamId, context: context)
                if status.state.isTerminal {
                    if terminalReplayGate.shouldReplay(status.state) { continue }
                    await finishStream(expectedStreamID: stream.streamId, context: context)
                    return
                }
                try await Task.sleep(for: .milliseconds(500))
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                do {
                    let status = try await coordinator.remoteClient(for: context).streamStatus(id: stream.streamId)
                    guard coordinator.isCurrent(context), activeStreamID == stream.streamId else { return }
                    await apply(status, streamID: stream.streamId, context: context)
                    if status.state.isTerminal {
                        if terminalReplayGate.shouldReplay(status.state) { continue }
                        await finishStream(expectedStreamID: stream.streamId, context: context)
                        return
                    }
                    try await Task.sleep(for: .seconds(1))
                } catch is CancellationError {
                    return
                } catch {
                    if await coordinator.handleCredentialRevocation(error, context: context) { return }
                    guard coordinator.isCurrent(context) else { return }
                    if AidenTerminalReconciliation.isDefinitiveMissingStream(error),
                       await reconcileMissingStream(stream, context: context) {
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

    private func apply(_ event: AidenRemoteStreamEvent, context: AidenRemoteRequestContext) async {
        guard coordinator.isCurrent(context),
              activeStreamID == event.streamId,
              event.shouldApply,
              let payload = event.payload else { return }
        switch event.type {
        case .snapshot:
            streamState = .reconciling
            await reconcileChat(context: context)
        case .status:
            if let value = payload.state, let state = AidenStreamState(rawValue: value) {
                if state == .waitingForApproval {
                    await restorePendingApproval(streamID: event.streamId, context: context)
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
            await restorePendingApproval(streamID: event.streamId, context: context)
        case .error:
            pendingApproval = nil
            // The terminal chat reconciliation renders the durable, fixed-copy
            // outcome inline. Avoid covering that actionable state with a
            // second generic modal alert.
            presentedError = nil
            streamState = .error
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
        context: AidenRemoteRequestContext
    ) async {
        guard activeStreamID == streamID,
              status.streamId == streamID,
              status.chatId == chat.id,
              coordinator.isCurrent(context)
        else { return }
        if status.state == .waitingForApproval {
            await restorePendingApproval(streamID: streamID, context: context)
            return
        }
        pendingApproval = nil
        streamState = status.state
        await liveActivities.updateStatus(instanceID: instanceId, streamID: streamID, state: status.state)
    }

    private func restorePendingApproval(
        streamID: String,
        context: AidenRemoteRequestContext
    ) async {
        do {
            let snapshot = try await coordinator.remoteClient(for: context).streamApproval(id: streamID)
            guard coordinator.isCurrent(context), activeStreamID == streamID else { return }
            guard let approval = AidenPendingApprovalResolution.resolve(
                snapshot.approval,
                streamId: streamID,
                chatId: chat.id
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
            await liveActivities.approvalRequired(instanceID: instanceId, streamID: streamID)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context), activeStreamID == streamID else { return }
            pendingApproval = nil
            streamState = .reconciling
            await liveActivities.markStale(instanceID: instanceId, streamID: streamID)
        }
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
                } catch is CancellationError {
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
        context: AidenRemoteRequestContext
    ) async -> Bool {
        guard activeStreamID == stream.streamId else { return false }
        guard await reconcileChat(context: context) else { return false }
        guard activeStreamID == stream.streamId else { return false }
        switch AidenMissingStreamResolution.resolve(messages: chat.messages) {
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
                } catch is CancellationError {
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
    @State private var botToolsModel: AidenBotChatToolsModel?
    @State private var botSheet: AidenBotChatSheet?
    @FocusState private var composerIsFocused: Bool
    @State private var coordinator: AidenRemoteCoordinator?
    let autoStartVoice: Bool
    let allowsMutations: Bool

    init(
        coordinator: AidenRemoteCoordinator,
        chat: AidenChat,
        autoStartVoice: Bool = false,
        allowsMutations: Bool = true,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in }
    ) {
        _coordinator = State(initialValue: coordinator)
        _model = State(initialValue: AidenChatViewModel(
            coordinator: coordinator,
            chat: chat,
            allowsMutations: allowsMutations,
            onChatUpdated: onChatUpdated
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
        .navigationTitle(presentationStyle == .botMessages ? "" : model.chat.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { chatToolbar }
        .safeAreaInset(edge: .top, spacing: 0) { botIdentityInset }
        .task { await model.load() }
        .task(id: botToolsSessionIdentity) {
            guard let coordinator, let botToolsModel else { return }
            botToolsModel.resetForSessionChange()
            await botToolsModel.load(coordinator: coordinator)
        }
        .sheet(item: $botSheet) { botSheetContent($0) }
        .alert("Aiden On The Go", isPresented: Binding(
            get: { model.presentedError != nil },
            set: { if !$0 { model.presentedError = nil } }
        )) {
            Button("OK", role: .cancel) { model.presentedError = nil }
        } message: {
            Text(model.presentedError ?? "The operation could not be completed.")
        }
    }

    private var chatStack: some View {
        ZStack(alignment: .bottom) {
            transcript
            composer
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                messageList
            }
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(
                TapGesture().onEnded { composerIsFocused = false }
            )
            .onChange(of: model.chat.messages.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: model.liveText) { _, _ in scrollToBottom(proxy) }
            .onChange(of: model.pendingApproval?.id) { _, approvalID in
                guard approvalID != nil else { return }
                composerIsFocused = false
                scrollToBottom(proxy)
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
        let next = index + 1 < model.chat.messages.count ? model.chat.messages[index + 1] : nil
        let isBotMessage = presentationStyle == .botMessages
        let joinsNext = next.map { aidenMessagesJoin(message, $0) } ?? false
        let showsTail = isBotMessage && !joinsNext
        let topPadding: CGFloat = isBotMessage && !aidenMessagesJoin(previous, message) ? 9 : 0

        return AidenMessageView(
            message: message,
            presentationStyle: presentationStyle,
            showsTail: showsTail,
            speechPlayback: speechPlayback,
            loadAttachmentImage: { attachment in
                await model.attachmentImageData(for: attachment)
            }
        )
        .padding(.top, topPadding)
    }

    private var composer: some View {
        AidenComposerView(
            model: model,
            autoStartVoice: autoStartVoice,
            composerFocus: $composerIsFocused
        )
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
    let showsTail: Bool
    let speechPlayback: AidenSpeechPlaybackController
    let loadAttachmentImage: (AidenMessageAttachment) async -> Data?

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
        .accessibilityElement(children: .contain)
        .accessibilityLabel(message.role == .user ? "You" : "Aiden")
    }

    private var messageContent: some View {
        VStack(
            alignment: message.role == .user ? .trailing : .leading,
            spacing: 10
        ) {
            if message.role == .assistant, let timeline = message.timeline, !timeline.steps.isEmpty {
                AidenActivityFeed(timeline: timeline, active: false)
            }
            if !message.text.isEmpty {
                messageText
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
            if message.role == .assistant, let outcome = message.outcome {
                AidenMessageOutcomeView(outcome: outcome)
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
    }

    private var messageText: some View {
        let usesWorkspaceBubble = AidenMessageContentSurface.usesRaisedBubble(
            role: message.role,
            content: .text
        )
        let usesBotBubble = presentationStyle == .botMessages
        let bubbleShowsTail = showsTail
            && message.attachments?.isEmpty != false
            && message.outcome == nil
            && message.timeline?.steps.isEmpty != false
        return AidenMessageTextView(role: message.role, content: message.text)
            .foregroundStyle(
                usesBotBubble && message.role == .user
                    ? Color.white
                    : palette.foreground
            )
            .padding(usesWorkspaceBubble || usesBotBubble ? 12 : 0)
            .background {
                if usesBotBubble {
                    AidenBotMessageBubbleShape(
                        isOutgoing: message.role == .user,
                        showsTail: bubbleShowsTail
                    )
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
    @State private var isExpanded = false

    private var rows: [AidenAgentStep] { Array(timeline.steps.suffix(3)) }
    private var isRunning: Bool { active && timeline.status == .running }

    var body: some View {
        VStack(alignment: .leading, spacing: isExpanded ? 4 : 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(alignment: isRunning && !isExpanded ? .bottom : .center, spacing: 8) {
                    Group {
                        if isRunning && !isExpanded {
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
                    ForEach(timeline.steps) { step in
                        AidenActivityStepLine(step: step, shimmer: isRunning && step.isActive)
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
        let update = {
            deckSelection = selection
            deckDragTranslation = 0
        }
        if reduceMotion {
            update()
        } else {
            withAnimation(.spring(duration: 0.22, bounce: 0.08), update)
        }
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
    let attachments: [AidenMessageAttachment]
    let loadData: (AidenMessageAttachment) async -> Data?
    @State private var selectedID: String
    @State private var isSaving = false
    @State private var toastMessage: String?
    @State private var showsPhotoSettingsRecovery = false

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
            } catch AidenPhotoLibrarySavingError.denied {
                announce(AidenPhotoLibrarySavingError.denied.localizedDescription)
                showsPhotoSettingsRecovery = true
            } catch {
                announce(error.localizedDescription)
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
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Bindable var model: AidenChatViewModel
    let presentationStyle: AidenChatPresentationStyle

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
            if model.isStreaming && model.reasoning.isEmpty && model.activityTimeline?.steps.isEmpty != false {
                HStack(spacing: 8) {
                    ThinkingOrb(state: activity.orb, size: .px20)
                    Text(activity.label)
                        .foregroundStyle(palette.secondary)
                }
                .font(.callout)
                .accessibilityElement(children: .combine)
                .transition(.opacity)
            }

            if !model.reasoning.isEmpty {
                AidenReasoningCard(text: model.reasoning, active: model.isStreaming)
                    .transition(.opacity)
            }

            if let timeline = model.activityTimeline, !timeline.steps.isEmpty {
                AidenActivityFeed(timeline: timeline, active: model.isStreaming)
                    .transition(.opacity)
            } else if !model.tools.isEmpty {
                AidenToolActivityCard(tools: model.tools)
            }

            if let approval = model.pendingApproval {
                AidenApprovalCard(
                    summary: approval.summary,
                    canAllow: approval.canAllow,
                    onDeny: { Task { await model.respondToApproval(.deny) } },
                    onAllow: { Task { await model.respondToApproval(.allow) } }
                )
                .disabled(model.isReadOnlyPresentation)
                .id(approval.id)
            }

            if !model.liveText.isEmpty {
                AidenMarkdownView(content: model.liveText)
                    .padding(presentationStyle == .botMessages ? 12 : 0)
                    .background {
                        if presentationStyle == .botMessages {
                            AidenBotMessageBubbleShape(
                                isOutgoing: false,
                                showsTail: false
                            )
                            .fill(Color(uiColor: .secondarySystemFill))
                        }
                    }
                    .frame(
                        maxWidth: presentationStyle == .botMessages ? 620 : .infinity,
                        alignment: .leading
                    )
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
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.activityTimeline?.steps.last?.id)
    }
}

private struct AidenApprovalCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @State private var isExpanded = false

    let summary: String
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
                    Text("Approval needed")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.foreground)

                    Text("Review this one action before Aiden continues.")
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

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

                if canAllow {
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
                    Text(active ? "Thinking…" : "Thinking")
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
    @Bindable var model: AidenChatViewModel
    let autoStartVoice: Bool
    let composerFocus: FocusState<Bool>.Binding
    @State private var voiceInput = ComposerVoiceInputController()
    @State private var didAutoStartVoice = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var isPhotoPickerPresented = false
    @State private var isFileImporterPresented = false
    @State private var isPreparingAttachments = false
    @State private var attachmentPreparationTask: Task<Void, Never>?

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

            if model.chat.isBotChat {
                botMessageControls
            } else {
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
                    if model.isUploadingAttachment || isPreparingAttachments {
                        ProgressView().controlSize(.small).frame(width: 44, height: 44)
                    } else {
                        Image(systemName: "plus")
                            .font(.title3.weight(.medium))
                            .frame(width: 44, height: 44)
                    }
                } menu: {
                    attachmentMenu()
                }
                .disabled(
                    !model.isConnected || model.isStreaming || model.isUploadingAttachment
                        || isPreparingAttachments || model.pendingAttachments.count >= 10
                )
                .accessibilityLabel("Add attachment")
                .accessibilityHint("Attach an image or bounded text file")
                .photosPicker(
                    isPresented: $isPhotoPickerPresented,
                    selection: $selectedPhotos,
                    maxSelectionCount: max(1, attachmentCapacity),
                    matching: .images
                )

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
                .disabled(model.isReadOnlyPresentation || model.isStreaming || voiceInput.isRequestingPermission)
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
                    .disabled(model.isReadOnlyPresentation)
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
            }

            if let error = voiceInput.errorMessage, !voiceInput.isListening {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, model.chat.isBotChat ? 0 : 12)
        .padding(.top, model.chat.isBotChat ? 2 : 8)
        .padding(.bottom, model.chat.isBotChat ? 0 : 4)
        .aidenComposerGlass(enabled: !model.chat.isBotChat)
        .overlay {
            if !model.chat.isBotChat {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(palette.secondary.opacity(0.35), lineWidth: 0.5)
            }
        }
        .shadow(
            color: model.chat.isBotChat ? .clear : .black.opacity(0.12),
            radius: model.chat.isBotChat ? 0 : 14,
            y: model.chat.isBotChat ? 0 : 6
        )
        .task {
            guard !model.isReadOnlyPresentation, autoStartVoice, !didAutoStartVoice else { return }
            didAutoStartVoice = true
            await voiceInput.toggle(currentDraft: model.draft) { model.draft = $0 }
        }
        .onChange(of: selectedPhotos) { _, items in
            guard !model.isReadOnlyPresentation, !items.isEmpty, !isPreparingAttachments else { return }
            let selected = Array(items.prefix(attachmentCapacity))
            selectedPhotos = []
            isPreparingAttachments = true
            attachmentPreparationTask = Task {
                defer {
                    isPreparingAttachments = false
                    attachmentPreparationTask = nil
                }
                var uploads: [AidenAttachmentUpload] = []
                var preparationFailures = 0
                for item in selected {
                    guard !Task.isCancelled else { return }
                    do {
                        guard let picked = try await item.loadTransferable(type: AidenPickedImageFile.self) else {
                            throw AidenAttachmentPreparationError.invalidImage
                        }
                        defer { try? FileManager.default.removeItem(at: picked.url) }
                        let upload = try await AidenAttachmentPreparation.fileUploadAsync(
                            url: picked.url,
                            preferredName: picked.name,
                            forceImage: true
                        )
                        uploads.append(upload)
                    } catch is CancellationError {
                        return
                    } catch {
                        preparationFailures += 1
                    }
                }
                guard !Task.isCancelled else { return }
                let uploadFailures = await model.upload(uploads)
                guard !Task.isCancelled else { return }
                presentAttachmentFailures(preparationFailures + uploadFailures)
            }
        }
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.image, .plainText, .sourceCode, .json, .xml, .commaSeparatedText],
            allowsMultipleSelection: true
        ) { result in
            guard !model.isReadOnlyPresentation else { return }
            let capacity = attachmentCapacity
            guard capacity > 0, !isPreparingAttachments else { return }
            isPreparingAttachments = true
            attachmentPreparationTask = Task {
                defer {
                    isPreparingAttachments = false
                    attachmentPreparationTask = nil
                }
                var uploads: [AidenAttachmentUpload] = []
                var preparationFailures = 0
                do {
                    let urls = try result.get()
                    preparationFailures += max(0, urls.count - capacity)
                    for url in urls.prefix(capacity) {
                        guard !Task.isCancelled else { return }
                        do {
                            let upload = try await AidenAttachmentPreparation.fileUploadAsync(url: url)
                            uploads.append(upload)
                        } catch is CancellationError {
                            return
                        } catch {
                            preparationFailures += 1
                        }
                    }
                } catch {
                    preparationFailures += 1
                }
                guard !Task.isCancelled else { return }
                let uploadFailures = await model.upload(uploads)
                guard !Task.isCancelled else { return }
                presentAttachmentFailures(preparationFailures + uploadFailures)
            }
        }
        .onDisappear {
            voiceInput.stopKeepingTranscript()
            attachmentPreparationTask?.cancel()
            attachmentPreparationTask = nil
            isPreparingAttachments = false
        }
    }

    private var botMessageControls: some View {
        HStack(alignment: .bottom, spacing: 7) {
            AidenUIKitMenuButton {
                if model.isUploadingAttachment || isPreparingAttachments {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 44, height: 44)
                } else {
                    Image(systemName: "plus")
                        .font(.title3.weight(.medium))
                        .frame(width: 44, height: 44)
                }
            } menu: {
                attachmentMenu()
            }
            .disabled(
                !model.isConnected || model.isStreaming || model.isUploadingAttachment
                    || isPreparingAttachments || model.pendingAttachments.count >= 10
            )
            .aidenBotComposerCircle()
            .accessibilityLabel("Add attachment")
            .accessibilityHint("Attach an image or bounded text file")
            .photosPicker(
                isPresented: $isPhotoPickerPresented,
                selection: $selectedPhotos,
                maxSelectionCount: max(1, attachmentCapacity),
                matching: .images
            )

            HStack(alignment: .bottom, spacing: 4) {
                TextField("Message \(model.chat.title)", text: $model.draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused(composerFocus)
                    .submitLabel(.send)
                    .padding(.leading, 6)
                    .padding(.vertical, 7)
                    .onSubmit {
                        guard !model.isStreaming else { return }
                        voiceInput.stopBeforeSubmittingDraft()
                        Task { await model.send() }
                    }

                switch aidenBotComposerTrailingControl(
                    isStreaming: model.isStreaming,
                    isListening: voiceInput.isListening,
                    draft: model.draft,
                    attachmentCount: model.pendingAttachments.count,
                    canSend: model.canSend
                ) {
                case .stopResponse:
                    Button { Task { await model.stop() } } label: {
                        Image(systemName: "stop.fill")
                            .frame(width: 30, height: 30)
                            .background(palette.foreground, in: Circle())
                            .foregroundStyle(palette.canvas)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isReadOnlyPresentation)
                    .accessibilityLabel("Stop response")
                case .stopVoiceInput:
                    Button {
                        Task {
                            await voiceInput.toggle(currentDraft: model.draft) { model.draft = $0 }
                        }
                    } label: {
                        AidenListeningWaveform(isAnimated: !reduceMotion)
                            .frame(width: 44, height: 44)
                    }
                    .disabled(model.isReadOnlyPresentation || voiceInput.isRequestingPermission)
                    .accessibilityLabel("Stop voice input")
                case let .send(isEnabled):
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
                    .disabled(!isEnabled)
                    .accessibilityLabel("Send message")
                case .startVoiceInput:
                    Button {
                        Task {
                            guard !model.isReadOnlyPresentation else { return }
                            await voiceInput.toggle(currentDraft: model.draft) { model.draft = $0 }
                        }
                    } label: {
                        Image(systemName: "mic")
                            .font(.body.weight(.medium))
                        .frame(width: 44, height: 44)
                    }
                    .disabled(
                        model.isReadOnlyPresentation
                            || voiceInput.isRequestingPermission
                    )
                    .accessibilityLabel("Start voice input")
                }
            }
            .padding(.leading, 6)
            .padding(.trailing, 2)
            .frame(minHeight: 44)
            .aidenBotComposerCapsule()
        }
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

    private var attachmentCapacity: Int {
        max(0, 10 - model.pendingAttachments.count)
    }

    private func presentAttachmentFailures(_ count: Int) {
        guard count > 0 else { return }
        model.presentedError = count == 1
            ? String(localized: "One selected attachment could not be added. Other attachments are still ready to send.")
            : String(localized: "\(count) selected attachments could not be added. Other attachments are still ready to send.")
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

    func aidenBotComposerCircle() -> some View {
        modifier(AidenBotComposerCircleModifier())
    }

    func aidenBotComposerCapsule() -> some View {
        modifier(AidenBotComposerCapsuleModifier())
    }
}

private struct AidenBotComposerCircleModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(palette.raised, in: Circle())
        } else {
            content
                .background(.regularMaterial, in: Circle())
                .overlay(Circle().stroke(palette.foreground.opacity(0.12), lineWidth: 0.5))
        }
    }
}

private struct AidenBotComposerCapsuleModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(palette.raised, in: Capsule())
        } else {
            content
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().stroke(palette.foreground.opacity(0.12), lineWidth: 0.5))
        }
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
