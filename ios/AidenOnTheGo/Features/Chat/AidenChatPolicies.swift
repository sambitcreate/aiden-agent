import SwiftUI
import UIKit

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

enum AidenChatReadAdmission {
    static func acceptsSelectedChatUpdate(chatID: String, selectedChatID: String?) -> Bool {
        selectedChatID == chatID
    }

    static func shouldReportRead(isChatVisible: Bool, sceneIsActive: Bool) -> Bool {
        isChatVisible && sceneIsActive
    }
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
        attachments: [AidenAttachmentReference],
        skill: AidenSkillInvocation? = nil
    ) -> AidenTurnStart {
        AidenTurnStart(
            text: text,
            providerId: providerId,
            modelId: modelId,
            thinkingLevel: thinkingLevel,
            attachmentIds: attachments.isEmpty ? nil : attachments.map(\.id),
            skill: skill
        )
    }
}

struct AidenChatModelSelection: Equatable {
    let providerId: String?
    let modelId: String?
    let thinkingLevel: String?
}

/// Slice G composer trigger parsing. The palette tracks only the trailing
/// `/query` or `@query` token: the trigger must start the draft or follow
/// whitespace, and the token ends at the next whitespace. Anything else —
/// triggers inside a token, a completed mention, punctuation — is ordinary
/// text and never opens a palette.
struct AidenComposerSuggestionQuery: Equatable {
    enum Kind: Equatable {
        case skill
        case mention
    }

    static let maximumQueryCharacters = 256

    let kind: Kind
    let query: String
    /// Draft range covering the trigger through the query; replaced on select.
    let tokenRange: Range<String.Index>

    static func parse(draft: String) -> AidenComposerSuggestionQuery? {
        let tokenStart = draft.lastIndex(where: { $0.isWhitespace })
            .map { draft.index(after: $0) } ?? draft.startIndex
        guard tokenStart < draft.endIndex else { return nil }
        let trigger = draft[tokenStart]
        let kind: Kind
        switch trigger {
        case "/": kind = .skill
        case "@": kind = .mention
        default: return nil
        }
        let query = String(draft[draft.index(after: tokenStart)...])
        guard query.unicodeScalars.count <= maximumQueryCharacters else { return nil }
        return AidenComposerSuggestionQuery(
            kind: kind,
            query: query,
            tokenRange: tokenStart..<draft.endIndex
        )
    }

    func matches(_ candidate: String) -> Bool {
        guard !query.isEmpty else { return true }
        return candidate.localizedCaseInsensitiveContains(query)
    }

    /// Prefix matches rank ahead of substring matches, mirroring the desktop
    /// palette ordering.
    func ranksBefore(_ lhs: String, _ rhs: String) -> Bool {
        let lhsPrefix = lhs.localizedCaseInsensitiveHasPrefix(query)
        let rhsPrefix = rhs.localizedCaseInsensitiveHasPrefix(query)
        if lhsPrefix != rhsPrefix { return lhsPrefix }
        return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
    }
}

private extension String {
    func localizedCaseInsensitiveHasPrefix(_ prefix: String) -> Bool {
        guard !prefix.isEmpty else { return true }
        return range(of: prefix, options: [.caseInsensitive, .anchored]) != nil
    }
}

/// One row in the composer suggestion palette. Skills carry the opaque lease
/// redeemed on turn start; agents and files insert plain display text — the
/// client never resolves or expands them.
enum AidenComposerSuggestion: Identifiable {
    case skill(AidenRemoteSkillCatalogEntry)
    case agent(AidenRemoteChatAgent)
    case file(AidenWorkspaceFileEntry)

    var id: String {
        switch self {
        case .skill(let entry): "skill-\(entry.invocationId)"
        case .agent(let agent): "agent-\(agent.agentId)"
        case .file(let entry): "file-\(entry.id)"
        }
    }

    static let maximumVisibleRows = 100
}

enum AidenChatModelAuthority {
    static func resolvedSelection(
        chat: AidenChat,
        catalog: AidenModelCatalog?,
        selectedProviderId: String?,
        selectedModelId: String?,
        selectedThinkingLevel: String?,
        remembered: AidenChatModelSelection? = nil,
        hasExplicitSelection: Bool = false
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
            if !hasExplicitSelection, !chat.messages.isEmpty,
               let providerId = chat.providerId, let modelId = chat.modelId {
                return AidenChatModelSelection(
                    providerId: providerId, modelId: modelId,
                    thinkingLevel: selectedProviderId == providerId && selectedModelId == modelId ? selectedThinkingLevel : nil
                )
            }
            return AidenChatModelSelection(
                providerId: selectedProviderId,
                modelId: selectedModelId,
                thinkingLevel: selectedThinkingLevel
            )
        }
        // Cache-seeded selections are not user choices. Until the person picks,
        // a populated chat follows its refreshed host pair, even without a
        // remembered default. Explicit unsent choices stay with this chat.
        if !hasExplicitSelection, !chat.messages.isEmpty, let own = ownSelection(
            chat: chat,
            catalog: catalog,
            selectedProviderId: selectedProviderId,
            selectedModelId: selectedModelId,
            selectedThinkingLevel: selectedThinkingLevel
        ) {
            return own
        }
        if !hasExplicitSelection, let remembered = rememberedSelection(remembered, in: catalog) {
            return remembered
        }
        var providerId = selectedProviderId
        if providerId == nil || !catalog.providers.contains(where: { $0.id == providerId }) {
            providerId = catalog.defaults["providerId"] ?? catalog.visibleProviders.first?.id
        }
        let provider = catalog.providers.first { $0.id == providerId }
        var modelId = selectedModelId
        if modelId == nil || provider?.models.contains(where: { $0.id == modelId }) != true {
            modelId = catalog.defaults["modelId"].flatMap { candidate in
                provider?.models.contains(where: { $0.id == candidate }) == true ? candidate : nil
            } ?? provider?.visibleModels.first?.id
        }
        let model = provider?.models.first { $0.id == modelId }
        return AidenChatModelSelection(
            providerId: providerId,
            modelId: modelId,
            thinkingLevel: selectedThinkingLevel ?? model?.effectiveThinkingLevel
        )
    }

    /// Agent-backed providers (mirroring the Mac's ACP harness list) run only in
    /// chats open on the Mac, so the host leaves them out of the phone's catalog.
    static let macOnlyAgentProviders: [String: String] = ["antigravity": "Google Antigravity"]

    /// For a chat the Mac last answered with a Mac-only agent model, which model
    /// replies from this phone use instead. Nil when the chat's own model is
    /// available here, or for Bot chats, whose model is fixed.
    static func macOnlyAgentNotice(
        chat: AidenChat,
        catalog: AidenModelCatalog?,
        replyModelLabel: String?
    ) -> String? {
        guard !chat.isBotChat,
              let providerId = chat.providerId,
              let agentLabel = macOnlyAgentProviders[providerId],
              catalog?.providers.contains(where: { $0.id == providerId }) != true else { return nil }
        if let replyModelLabel {
            return String(localized: "This chat used \(agentLabel), which runs only on your Mac. Replies from here use \(replyModelLabel).")
        }
        return String(localized: "This chat used \(agentLabel), which runs only on your Mac. Choose a model for replies from here.")
    }

    /// The chat's own provider/model pair, when the host still offers it.
    /// Hidden models stay usable here, as they do for existing chats on the Mac.
    static func ownSelection(
        chat: AidenChat,
        catalog: AidenModelCatalog,
        selectedProviderId: String?,
        selectedModelId: String?,
        selectedThinkingLevel: String?
    ) -> AidenChatModelSelection? {
        guard let providerId = chat.providerId,
              let modelId = chat.modelId,
              let provider = catalog.providers.first(where: { $0.id == providerId }),
              let model = provider.models.first(where: { $0.id == modelId }) else { return nil }
        let keepsLevel = selectedProviderId == providerId && selectedModelId == modelId
        let thinkingLevel = (keepsLevel ? selectedThinkingLevel : nil).flatMap { level in
            model.thinkingLevels?.contains(level) == true ? level : nil
        } ?? model.effectiveThinkingLevel
        return AidenChatModelSelection(providerId: providerId, modelId: modelId, thinkingLevel: thinkingLevel)
    }

    /// The per-host remembered choice applies only while the host's current
    /// inventory still offers it as a visible provider/model pair. A missing
    /// or hidden pair returns nil so the caller falls back to the chat's pair
    /// and then the host defaults; a stale thinking level falls back to the
    /// model's own default rather than sending an unsupported level.
    static func rememberedSelection(
        _ remembered: AidenChatModelSelection?,
        in catalog: AidenModelCatalog
    ) -> AidenChatModelSelection? {
        guard let providerId = remembered?.providerId,
              let modelId = remembered?.modelId,
              let provider = catalog.visibleProviders.first(where: { $0.id == providerId }),
              let model = provider.visibleModels.first(where: { $0.id == modelId }) else { return nil }
        let thinkingLevel = remembered?.thinkingLevel.flatMap { level in
            model.thinkingLevels?.contains(level) == true ? level : nil
        } ?? model.effectiveThinkingLevel
        return AidenChatModelSelection(providerId: providerId, modelId: modelId, thinkingLevel: thinkingLevel)
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

/// The Mac captures visual snapshots only after a reply commits (serially, up
/// to a few seconds each), so the phone's settling read usually lands first and
/// nothing pushes the later revision. A just-settled reply still missing a
/// snapshot is therefore re-read a bounded number of times, then left alone.
enum AidenVisualSnapshotReconciliation {
    /// Waits between re-reads: about 4 s, 10 s and 20 s after the reply settled.
    static let retryDelays: [Duration] = [.seconds(4), .seconds(6), .seconds(10)]
    /// Only a reply that settled this recently is still worth waiting for.
    static let recentReplyWindow: TimeInterval = 120

    /// The reply whose snapshots may still be arriving: the newest assistant message.
    static func awaitedMessage(in messages: [AidenChatMessage]) -> AidenChatMessage? {
        messages.last { $0.role == .assistant }
    }

    /// The wait before re-read number `attempt` (from 0), or nil when the
    /// reply has every snapshot, is no longer recent, or the tries are spent.
    static func nextDelay(for message: AidenChatMessage?, attempt: Int, now: Date) -> Duration? {
        guard let message, message.role == .assistant, retryDelays.indices.contains(attempt),
              let visuals = message.visuals,
              visuals.contains(where: { AidenChatVisualPresentation.snapshotAttachment(for: $0, in: message) == nil })
        else { return nil }
        // A long reply is judged by when it finished. A Mac clock ahead of the
        // phone reads as recent; the try count still bounds it.
        let settledAt = message.timeline?.finishedAt.map { Date(timeIntervalSince1970: $0 / 1_000) } ?? message.createdAt
        guard now.timeIntervalSince(settledAt) <= recentReplyWindow else { return nil }
        return retryDelays[attempt]
    }
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
    static let maximumRetryDelayMilliseconds = 30_000

    /// Capped exponential backoff with equal jitter: the delay lands in
    /// `[ceiling / 2, ceiling)`, where the ceiling doubles from 1 s to 30 s.
    /// Keeping half the ceiling preserves real back-off while the random half
    /// spreads reconnects from many devices after a Mac restart or network flap.
    static func retryDelayMilliseconds(
        attempt: Int,
        randomUnit: () -> Double = { Double.random(in: 0..<1) }
    ) -> Int {
        let safeAttempt = max(0, min(attempt, 5))
        let ceiling = min(maximumRetryDelayMilliseconds, 1_000 * (1 << safeAttempt))
        let floor = ceiling / 2
        let unit = min(max(randomUnit(), 0), 1)
        return min(ceiling, floor + Int(Double(ceiling - floor) * unit))
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

enum AidenDraftSendReconciliation {
    /// A turn the Mac refused without running it: the phone drops the saved attempt and shows the
    /// Mac's reason. A 409 is settled only for `workspace_unavailable` (a moved or deleted folder),
    /// which the Mac sends before anything runs; other conflicts may have an unknown outcome.
    static func refusalSettlesSend(status: Int, code: AidenRemoteErrorCode) -> Bool {
        [400, 401, 403, 404, 413, 422, 429].contains(status)
            || (status == 409 && code == AidenRemoteErrorCode(rawValue: "workspace_unavailable"))
    }

    static func failedDraft(submitted: String, current: String) -> String {
        guard !current.isEmpty else { return submitted }
        guard current != submitted else { return current }
        if !submitted.isEmpty, current.hasPrefix(submitted + "\n\n") { return current }
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
