import ImageIO
import Observation
import Photos
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Motion and geometry constants for the long-press `+` quick-photo strip.
/// Kept distinct from `AidenAttachmentPickerPresentationMotion` so the menu,
/// full photo grid, and camera retain their existing subtle presentation contract.
enum AidenQuickPhotoStripMotion {
    static let hiddenScale: CGFloat = 0.14
    static let stripHeight: CGFloat = 112
    static let stripCornerRadius: CGFloat = AidenRadius.composer
    static let composerGap: CGFloat = 12
    static let minimumBottomPadding: CGFloat = 76
    static let openDuration: TimeInterval = 0.36
    static let openBounce: CGFloat = 0.12
    static let closeDuration: TimeInterval = 0.24
    static let reducedMotionOpenDuration: TimeInterval = 0.16
    static let reducedMotionCloseDuration: TimeInterval = 0.14

    static func openAnimation(reduceMotion: Bool) -> Animation {
        reduceMotion
            ? .easeOut(duration: reducedMotionOpenDuration)
            : .spring(duration: openDuration, bounce: openBounce)
    }

    static func closeAnimation(reduceMotion: Bool) -> Animation {
        reduceMotion
            ? .easeOut(duration: reducedMotionCloseDuration)
            : .spring(duration: closeDuration, bounce: 0)
    }
}

/// Shared card sizing for staged and uploading composer attachments.
enum AidenAttachmentCardMetrics {
    static let imageSide: CGFloat = 72
    static let fileWidth: CGFloat = 114
    static let fileHeight: CGFloat = 72
    static let cornerRadius: CGFloat = 15
    static let previewMaxPixelDimension: CGFloat = 280
}

/// Isolated observable progress/preview state for one staging card so upload
/// progress ticks redraw only that card's ring and never invalidate the
/// conversation screen or composer container.
@MainActor
@Observable
final class AidenStagingAttachmentProgress {
    var phase: AidenStagingAttachment.Phase
    var previewImage: UIImage?

    init(phase: AidenStagingAttachment.Phase, previewImage: UIImage? = nil) {
        self.phase = phase
        self.previewImage = previewImage
    }
}

/// An attachment currently preparing (iCloud fetch / ImageIO downscale) or
/// uploading to the paired computer. Held on the conversation model so it
/// survives iPhone Duo folds and question-card swaps.
@MainActor
struct AidenStagingAttachment: Identifiable, Equatable {
    enum Kind: Equatable, Sendable {
        case image
        case file
    }

    enum Phase: Equatable, Sendable {
        case queued
        case preparing
        case uploading(Double)

        var percent: Int? {
            guard case .uploading(let fraction) = self else { return nil }
            return Int((min(1, max(0, fraction)) * 100).rounded(.down))
        }
    }

    let id: UUID
    let kind: Kind
    let displayName: String
    let state: AidenStagingAttachmentProgress

    var previewImage: UIImage? {
        get { state.previewImage }
        nonmutating set { state.previewImage = newValue }
    }

    var phase: Phase {
        get { state.phase }
        nonmutating set { state.phase = newValue }
    }

    init(
        id: UUID = UUID(),
        kind: Kind,
        displayName: String,
        previewImage: UIImage? = nil,
        phase: Phase = .queued
    ) {
        self.id = id
        self.kind = kind
        self.displayName = displayName
        self.state = AidenStagingAttachmentProgress(phase: phase, previewImage: previewImage)
    }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id
            && lhs.kind == rhs.kind
            && lhs.displayName == rhs.displayName
            && lhs.state === rhs.state
    }
}

/// Thread-safe lock-backed cancel handle bridging `@MainActor` per-item cancel
/// calls and `@Sendable` `withTaskCancellationHandler` closures without data races.
final class AidenStageCancelBox: @unchecked Sendable {
    private let lock = NSLock()
    private var isCancelled = false
    private var progress: Progress?
    private var cancelAction: (@Sendable () -> Void)?

    func attach(progress: Progress) {
        lock.lock()
        let alreadyCancelled = isCancelled
        if !alreadyCancelled {
            self.progress = progress
        }
        lock.unlock()
        if alreadyCancelled {
            progress.cancel()
        }
    }

    func attach(cancel: @escaping @Sendable () -> Void) {
        lock.lock()
        let alreadyCancelled = isCancelled
        if !alreadyCancelled {
            cancelAction = cancel
        }
        lock.unlock()
        if alreadyCancelled {
            cancel()
        }
    }

    func cancel() {
        lock.lock()
        guard !isCancelled else {
            lock.unlock()
            return
        }
        isCancelled = true
        let progress = self.progress
        self.progress = nil
        let action = self.cancelAction
        self.cancelAction = nil
        lock.unlock()

        progress?.cancel()
        action?()
    }
}

/// Monotonic whole-percent gate evaluated inside `URLSession`'s background
/// progress delegate before hopping to `@MainActor`, preventing per-chunk
/// SwiftUI invalidation storms.
final class AidenMonotonicPercentGate: @unchecked Sendable {
    private let lock = NSLock()
    private var lastPercent = -1

    func accept(_ rawFraction: Double) -> Double? {
        let clamped = min(1, max(0, rawFraction))
        let percent = Int((clamped * 100).rounded(.down))
        lock.lock()
        defer { lock.unlock() }
        guard percent > lastPercent else { return nil }
        lastPercent = percent
        return clamped
    }
}

/// Shared staging state store owned by both `AidenChatViewModel` and
/// `AidenBotSessionModel`. Keeps card identities stable across staging -> pending
/// promotion so the scrim and progress ring crossfade cleanly off the same thumbnail.
@MainActor
@Observable
final class AidenAttachmentStagingStore {
    private(set) var items: [AidenStagingAttachment] = []
    @ObservationIgnored private var cancelledIDs: Set<UUID> = []
    @ObservationIgnored private var activeItemID: UUID?
    @ObservationIgnored private var activeCancelBox: AidenStageCancelBox?
    @ObservationIgnored private var pendingPreviews: [String: UIImage] = [:]
    /// Maps a staged `AidenAttachmentReference.id` back to its staging `UUID`
    /// so `AidenComposerAttachmentStrip` preserves card identity on promotion.
    @ObservationIgnored private var promotedCardIDs: [String: UUID] = [:]

    var isEmpty: Bool { items.isEmpty }
    var count: Int { items.count }

    func beginBatch(_ batch: [AidenAttachmentStageItem]) {
        cancelledIDs = []
        activeItemID = nil
        activeCancelBox = nil
        items = batch.enumerated().map { idx, item in
            AidenStagingAttachment(
                id: item.id,
                kind: item.kind,
                displayName: item.displayName,
                previewImage: item.initialPreview,
                phase: idx == 0 ? .preparing : .queued
            )
        }
    }

    func isCancelled(_ id: UUID) -> Bool {
        cancelledIDs.contains(id)
    }

    func item(for id: UUID) -> AidenStagingAttachment? {
        items.first { $0.id == id }
    }

    func setPhase(_ phase: AidenStagingAttachment.Phase, for id: UUID) {
        guard let item = item(for: id) else { return }
        item.phase = phase
    }

    func setPreview(_ image: UIImage, for id: UUID) {
        guard let item = item(for: id) else { return }
        item.previewImage = image
    }

    func registerActiveCancel(for id: UUID, box: AidenStageCancelBox) {
        if cancelledIDs.contains(id) {
            box.cancel()
            return
        }
        activeItemID = id
        activeCancelBox = box
    }

    func clearActiveCancel(for id: UUID) {
        guard activeItemID == id else { return }
        activeItemID = nil
        activeCancelBox = nil
    }

    func removeStagingItem(id: UUID) {
        items.removeAll { $0.id == id }
    }

    func cancelItem(id: UUID) {
        cancelledIDs.insert(id)
        items.removeAll { $0.id == id }
        if activeItemID == id {
            let box = activeCancelBox
            activeCancelBox = nil
            activeItemID = nil
            box?.cancel()
        }
    }

    func cancelAll() {
        let box = activeCancelBox
        activeCancelBox = nil
        activeItemID = nil
        items = []
        box?.cancel()
    }

    func finishBatch() {
        activeCancelBox = nil
        activeItemID = nil
        cancelledIDs = []
        items = []
    }

    /// Synchronously promotes a staging item into `pendingPreviews` and records
    /// its stable card ID before the ViewModel appends the `AidenAttachmentReference`.
    func promote(stagingID: UUID, to referenceID: String, fallbackPreview: UIImage?) {
        let preview = item(for: stagingID)?.previewImage ?? fallbackPreview
        if let preview {
            pendingPreviews[referenceID] = preview
        }
        promotedCardIDs[referenceID] = stagingID
        items.removeAll { $0.id == stagingID }
    }

    func rememberPreview(_ image: UIImage, for referenceID: String) {
        pendingPreviews[referenceID] = image
    }

    func previewImage(for referenceID: String) -> UIImage? {
        pendingPreviews[referenceID]
    }

    func stableCardID(for referenceID: String) -> String {
        if let uuid = promotedCardIDs[referenceID] {
            return uuid.uuidString
        }
        return referenceID
    }

    func removePendingMetadata(for referenceID: String) {
        pendingPreviews.removeValue(forKey: referenceID)
        promotedCardIDs.removeValue(forKey: referenceID)
    }

    func prunePendingMetadata(keeping activeReferenceIDs: Set<String>) {
        pendingPreviews = pendingPreviews.filter { activeReferenceIDs.contains($0.key) }
        promotedCardIDs = promotedCardIDs.filter { activeReferenceIDs.contains($0.key) }
    }

    func resetAll() {
        cancelAll()
        cancelledIDs = []
        pendingPreviews = [:]
        promotedCardIDs = [:]
    }
}

/// Safe Sendable box around a picked `NSItemProvider` from `PHPickerViewController`.
final class AidenQuickPhotoSelection: @unchecked Sendable {
    let itemProvider: NSItemProvider
    let suggestedName: String

    init(itemProvider: NSItemProvider, suggestedName: String? = nil) {
        self.itemProvider = itemProvider
        let raw = (suggestedName ?? itemProvider.suggestedName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        self.suggestedName = raw.isEmpty ? "Photo.jpg" : raw
    }
}

/// One attachment handed to a conversation model for optimistic staging,
/// per-card progress display, and per-item cancellation.
struct AidenAttachmentStageItem {
    let id: UUID
    let kind: AidenStagingAttachment.Kind
    let displayName: String
    let initialPreview: UIImage?
    let prepare: @MainActor (
        _ onProgressHandle: @escaping @MainActor (Progress) -> Void,
        _ onPreview: @escaping @MainActor (UIImage) -> Void
    ) async throws -> AidenAttachmentUpload

    init(
        id: UUID = UUID(),
        kind: AidenStagingAttachment.Kind,
        displayName: String,
        initialPreview: UIImage? = nil,
        prepare: @escaping @MainActor (
            _ onProgressHandle: @escaping @MainActor (Progress) -> Void,
            _ onPreview: @escaping @MainActor (UIImage) -> Void
        ) async throws -> AidenAttachmentUpload
    ) {
        self.id = id
        self.kind = kind
        self.displayName = displayName
        self.initialPreview = initialPreview
        self.prepare = prepare
    }

    static func quickPhoto(_ selection: AidenQuickPhotoSelection) -> Self {
        Self(
            kind: .image,
            displayName: selection.suggestedName,
            initialPreview: nil
        ) { onProgress, onPreview in
            let loaded = try await AidenPickedPhotoItemLoader.load(
                selection: selection,
                onProgressHandle: onProgress,
                onPreview: onPreview
            )
            return loaded.upload
        }
    }

    static func photoAsset(_ asset: PHAsset) -> Self {
        let name = PHAssetResource.assetResources(for: asset).first?.originalFilename ?? "Photo.jpg"
        return Self(kind: .image, displayName: name, initialPreview: nil) { _, onPreview in
            let picked = try await AidenPhotoLibraryImageLoader.pickedImage(for: asset)
            if let preview = await AidenPickedPhotoItemLoader.makeThumbnailAsync(from: picked.data) {
                onPreview(preview)
            }
            return try await AidenAttachmentPreparation.imageUploadAsync(
                data: picked.data,
                name: picked.name
            )
        }
    }

    static func cameraCapture(_ data: Data) -> Self {
        Self(kind: .image, displayName: "Camera Photo.jpg", initialPreview: nil) { _, onPreview in
            if let preview = await AidenPickedPhotoItemLoader.makeThumbnailAsync(from: data) {
                onPreview(preview)
            }
            return try await AidenAttachmentPreparation.imageUploadAsync(
                data: data,
                name: "Camera Photo.jpg"
            )
        }
    }

    static func fileURL(_ url: URL) -> Self {
        let accessed = url.startAccessingSecurityScopedResource()
        let contentType = try? url.resourceValues(forKeys: [.contentTypeKey]).contentType
        if accessed { url.stopAccessingSecurityScopedResource() }
        let isImage = contentType?.conforms(to: .image)
            ?? UTType(filenameExtension: url.pathExtension)?.conforms(to: .image)
            ?? false
        let name = url.lastPathComponent.isEmpty ? "File" : url.lastPathComponent
        return Self(kind: isImage ? .image : .file, displayName: name, initialPreview: nil) { _, onPreview in
            let upload = try await AidenAttachmentPreparation.fileUploadAsync(url: url)
            if case .image(_, _, let data) = upload,
               let preview = await AidenPickedPhotoItemLoader.makeThumbnailAsync(from: data) {
                onPreview(preview)
            }
            return upload
        }
    }
}

/// Memory-bounded ImageIO loader for out-of-process `PHPickerViewController`
/// results (no `PHPhotoLibrary` authorization required). Downsamples 48 MP
/// HEIC and ProRAW assets via `CGImageSourceCreateThumbnailAtIndex` without
/// decoding the full bitmap into RAM, emits the 280 px preview immediately
/// before encoding the upload payload, and checks cancellation explicitly even
/// on `NSItemProvider`'s GCD callback threads.
enum AidenPickedPhotoItemLoader {
    static let maximumUploadPixelDimension: CGFloat = AidenPhotoLibraryImageLoader.maximumRequestedPixelDimension

    struct LoadedImage: @unchecked Sendable {
        let preview: UIImage?
        let upload: AidenAttachmentUpload
    }

    static func load(
        selection: AidenQuickPhotoSelection,
        onProgressHandle: @escaping @MainActor (Progress) -> Void = { _ in },
        onPreview: @escaping @MainActor (UIImage) -> Void = { _ in }
    ) async throws -> LoadedImage {
        let provider = selection.itemProvider
        let suggestedName = selection.suggestedName
        let typeIdentifier = preferredImageTypeIdentifier(for: provider)
        let request = AidenItemProviderFileRequest()

        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let progress = request.start(
                    provider: provider,
                    typeIdentifier: typeIdentifier,
                    suggestedName: suggestedName,
                    onPreview: onPreview,
                    continuation: continuation
                )
                if let progress {
                    Task { @MainActor in onProgressHandle(progress) }
                }
            }
        } onCancel: {
            request.cancel()
        }
    }

    static func preferredImageTypeIdentifier(for provider: NSItemProvider) -> String {
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            return UTType.image.identifier
        }
        return provider.registeredTypeIdentifiers.first ?? UTType.image.identifier
    }

    /// Reads a fast 280 px preview (delivered immediately via `onPreview`) and
    /// a validated, bounded upload payload synchronously from `fileURL` using
    /// ImageIO (safe for 48 MP HEIC / ProRAW).
    static func loadPreviewAndUpload(
        from fileURL: URL,
        suggestedName: String,
        isCancelled: () -> Bool = { Task.isCancelled },
        onPreview: ((UIImage) -> Void)? = nil
    ) throws -> LoadedImage {
        if isCancelled() { throw CancellationError() }
        guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
              CGImageSourceGetCount(source) > 0 else {
            throw AidenAttachmentPreparationError.invalidImage
        }

        let preview = makeThumbnail(
            from: source,
            maxPixelSize: AidenAttachmentCardMetrics.previewMaxPixelDimension
        )
        if isCancelled() { throw CancellationError() }
        if let preview {
            onPreview?(preview)
        }

        if isCancelled() { throw CancellationError() }
        if let directUpload = try directPassthroughUploadIfValid(
            fileURL: fileURL,
            source: source,
            suggestedName: suggestedName
        ) {
            return LoadedImage(preview: preview, upload: directUpload)
        }

        if isCancelled() { throw CancellationError() }
        guard let boundedImage = makeThumbnail(
            from: source,
            maxPixelSize: maximumUploadPixelDimension
        ) else {
            throw AidenAttachmentPreparationError.invalidImage
        }
        let upload = try encodedBoundedUpload(
            from: boundedImage,
            source: source,
            suggestedName: suggestedName,
            isCancelled: isCancelled
        )
        return LoadedImage(preview: preview, upload: upload)
    }

    static func makeThumbnailAsync(
        from data: Data,
        maxPixelSize: CGFloat = AidenAttachmentCardMetrics.previewMaxPixelDimension
    ) async -> UIImage? {
        guard !data.isEmpty else { return nil }
        let worker = Task.detached(priority: .userInitiated) {
            makeThumbnail(from: data, maxPixelSize: maxPixelSize)
        }
        return await withTaskCancellationHandler {
            await worker.value
        } onCancel: {
            worker.cancel()
        }
    }

    static func makeThumbnail(
        from data: Data,
        maxPixelSize: CGFloat = AidenAttachmentCardMetrics.previewMaxPixelDimension
    ) -> UIImage? {
        guard !data.isEmpty,
              let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return makeThumbnail(from: source, maxPixelSize: maxPixelSize)
    }

    static func makeThumbnail(from source: CGImageSource, maxPixelSize: CGFloat) -> UIImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, Int(ceil(maxPixelSize))),
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: cgImage)
    }

    private static func encodedBoundedUpload(
        from boundedImage: UIImage,
        source: CGImageSource,
        suggestedName: String,
        isCancelled: () -> Bool
    ) throws -> AidenAttachmentUpload {
        let preserveAlpha = AidenAttachmentPreparation.hasAlpha(boundedImage)
        if preserveAlpha {
            if let encoded = try pngUploadData(from: boundedImage, isCancelled: isCancelled) {
                return .image(
                    name: AidenAttachmentPreparation.safeImageName(suggestedName, extension: "png"),
                    mimeType: "image/png",
                    data: encoded
                )
            }
            for edge in [1_536.0, 1_024.0] {
                if isCancelled() { throw CancellationError() }
                guard let smaller = makeThumbnail(from: source, maxPixelSize: edge) else { continue }
                if let encoded = try pngUploadData(from: smaller, isCancelled: isCancelled) {
                    return .image(
                        name: AidenAttachmentPreparation.safeImageName(suggestedName, extension: "png"),
                        mimeType: "image/png",
                        data: encoded
                    )
                }
            }
            throw AidenAttachmentPreparationError.imageTooLarge
        }

        let candidates: [UIImage] = [boundedImage] + [1_536.0, 1_024.0].compactMap {
            isCancelled() ? nil : makeThumbnail(from: source, maxPixelSize: $0)
        }
        for candidate in candidates {
            for quality in [0.86, 0.72, 0.58] {
                if isCancelled() { throw CancellationError() }
                if let encoded = candidate.jpegData(compressionQuality: quality),
                   !encoded.isEmpty,
                   encoded.count <= AidenAttachmentPreparation.maximumImageBytes {
                    return .image(
                        name: AidenAttachmentPreparation.safeImageName(suggestedName, extension: "jpg"),
                        mimeType: "image/jpeg",
                        data: encoded
                    )
                }
            }
        }
        throw AidenAttachmentPreparationError.imageTooLarge
    }

    /// Encodes a PNG within `maximumImageBytes`, normalizing 16-bit RGBA images
    /// to 8-bit when the direct PNG exceeds the 8 MB upload cap.
    private static func pngUploadData(from image: UIImage, isCancelled: () -> Bool) throws -> Data? {
        if isCancelled() { throw CancellationError() }
        if let direct = image.pngData(), !direct.isEmpty, direct.count <= AidenAttachmentPreparation.maximumImageBytes {
            return direct
        }
        guard let cgImage = image.cgImage, cgImage.bitsPerComponent > 8 else { return nil }
        if isCancelled() { throw CancellationError() }
        let target = CGSize(width: cgImage.width, height: cgImage.height)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = false
        let normalized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        guard let data = normalized.pngData(), !data.isEmpty, data.count <= AidenAttachmentPreparation.maximumImageBytes else {
            return nil
        }
        return data
    }

    private static func directPassthroughUploadIfValid(
        fileURL: URL,
        source: CGImageSource,
        suggestedName: String
    ) throws -> AidenAttachmentUpload? {
        guard CGImageSourceGetCount(source) == 1,
              let sourceType = CGImageSourceGetType(source) as String? else { return nil }
        let mimeType: String
        let ext: String
        if sourceType == UTType.png.identifier {
            mimeType = "image/png"
            ext = "png"
        } else if sourceType == UTType.jpeg.identifier {
            mimeType = "image/jpeg"
            ext = "jpg"
        } else {
            return nil
        }

        // Only pass through when orientation is standard (.up = 1 or absent) and
        // pixel dimensions and file size are already within Aiden's upload bounds.
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pixelWidth = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let pixelHeight = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
              pixelWidth > 0, pixelHeight > 0,
              pixelWidth <= Double(AidenAttachmentPreparation.maximumImageDimension),
              pixelHeight <= Double(AidenAttachmentPreparation.maximumImageDimension),
              pixelWidth * pixelHeight <= Double(AidenAttachmentPreparation.maximumImagePixels) else {
            return nil
        }
        if let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue,
           orientation != 1 {
            return nil
        }

        let values = try? fileURL.resourceValues(forKeys: [.fileSizeKey])
        if let fileSize = values?.fileSize, fileSize > AidenAttachmentPreparation.maximumImageBytes {
            return nil
        }
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: AidenAttachmentPreparation.maximumImageBytes + 1) ?? Data()
        guard !data.isEmpty,
              data.count <= AidenAttachmentPreparation.maximumImageBytes,
              AidenAttachmentImageValidation.validatedData(
                  data,
                  mimeType: mimeType,
                  declaredSize: data.count
              ) != nil else {
            return nil
        }
        return .image(
            name: AidenAttachmentPreparation.safeImageName(suggestedName, extension: ext),
            mimeType: mimeType,
            data: data
        )
    }
}

private final class AidenItemProviderFileRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var progress: Progress?
    private var continuation: CheckedContinuation<AidenPickedPhotoItemLoader.LoadedImage, Error>?
    private var isFinished = false

    private var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isFinished
    }

    func start(
        provider: NSItemProvider,
        typeIdentifier: String,
        suggestedName: String,
        onPreview: @escaping @MainActor (UIImage) -> Void,
        continuation: CheckedContinuation<AidenPickedPhotoItemLoader.LoadedImage, Error>
    ) -> Progress? {
        lock.lock()
        guard !isFinished else {
            lock.unlock()
            continuation.resume(throwing: CancellationError())
            return nil
        }
        self.continuation = continuation
        lock.unlock()

        let progress = provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, error in
            guard let self else { return }
            if self.isCancelled {
                self.finish(.failure(CancellationError()))
                return
            }
            if let error {
                self.finish(.failure(error))
                return
            }
            guard let url else {
                self.finish(.failure(AidenAttachmentPreparationError.invalidImage))
                return
            }
            let result = Result {
                try AidenPickedPhotoItemLoader.loadPreviewAndUpload(
                    from: url,
                    suggestedName: suggestedName,
                    isCancelled: { [weak self] in self?.isCancelled ?? true },
                    onPreview: { [weak self] preview in
                        guard self?.isCancelled == false else { return }
                        Task { @MainActor in onPreview(preview) }
                    }
                )
            }
            self.finish(result)
        }

        lock.lock()
        if isFinished {
            lock.unlock()
            progress.cancel()
            return nil
        }
        self.progress = progress
        lock.unlock()
        return progress
    }

    func cancel() {
        finish(.failure(CancellationError()), cancellingProgress: true)
    }

    private func finish(
        _ result: Result<AidenPickedPhotoItemLoader.LoadedImage, Error>,
        cancellingProgress: Bool = false
    ) {
        lock.lock()
        guard !isFinished else {
            lock.unlock()
            return
        }
        isFinished = true
        let progress = self.progress
        self.progress = nil
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()

        if cancellingProgress {
            progress?.cancel()
        }
        continuation?.resume(with: result)
    }
}

/// Out-of-process, zero-permission compact `PHPickerViewController` hosted inside
/// a container VC with explicit edge constraints so iOS 26 `.compact` mode never
/// collapses to zero height.
struct AidenQuickPhotoStripView: UIViewControllerRepresentable {
    let onPick: @MainActor (AidenQuickPhotoSelection) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick)
    }

    func makeUIViewController(context: Context) -> UIViewController {
        let host = UIViewController()
        host.view.backgroundColor = .clear

        var config = PHPickerConfiguration()
        config.mode = .compact
        config.filter = .images
        config.selectionLimit = 1
        config.selection = .continuous
        config.preferredAssetRepresentationMode = .current
        config.edgesWithoutContentMargins = .all
        config.disabledCapabilities = [
            .search,
            .collectionNavigation,
            .stagingArea,
            .sensitivityAnalysisIntervention,
        ]

        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        picker.view.backgroundColor = .clear
        picker.view.translatesAutoresizingMaskIntoConstraints = false

        host.addChild(picker)
        host.view.addSubview(picker.view)
        NSLayoutConstraint.activate([
            picker.view.leadingAnchor.constraint(equalTo: host.view.leadingAnchor),
            picker.view.trailingAnchor.constraint(equalTo: host.view.trailingAnchor),
            picker.view.topAnchor.constraint(equalTo: host.view.topAnchor),
            picker.view.bottomAnchor.constraint(equalTo: host.view.bottomAnchor),
        ])
        picker.didMove(toParent: host)
        return host
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {
        context.coordinator.onPick = onPick
    }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        var onPick: @MainActor (AidenQuickPhotoSelection) -> Void
        private var didEmitSelection = false

        init(onPick: @escaping @MainActor (AidenQuickPhotoSelection) -> Void) {
            self.onPick = onPick
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !didEmitSelection, let first = results.first else { return }
            didEmitSelection = true
            let selection = AidenQuickPhotoSelection(itemProvider: first.itemProvider)
            if Thread.isMainThread {
                MainActor.assumeIsolated { onPick(selection) }
            } else {
                Task { @MainActor [onPick] in onPick(selection) }
            }
        }
    }
}

/// Full-screen backdrop blur rendered behind the quick-photo strip without
/// rasterizing `AidenTranscriptScaffold` offscreen every frame. Keeps itself
/// mounted so the initial `nil -> UIBlurEffect` transition always animates after
/// entering a window instead of snapping on frame 0.
struct AidenQuickPhotoBackdropBlur: UIViewRepresentable {
    let isActive: Bool
    let colorScheme: ColorScheme
    let reduceMotion: Bool

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIVisualEffectView {
        let view = UIVisualEffectView(effect: nil)
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: UIVisualEffectView, context: Context) {
        let coordinator = context.coordinator
        guard coordinator.lastActive != isActive || coordinator.lastScheme != colorScheme else { return }
        let schemeOnlyChange = coordinator.lastActive == isActive && coordinator.lastScheme != colorScheme
        coordinator.lastActive = isActive
        coordinator.lastScheme = colorScheme

        let target: UIVisualEffect? = isActive
            ? UIBlurEffect(style: colorScheme == .dark ? .systemThinMaterialDark : .systemThinMaterialLight)
            : nil
        if schemeOnlyChange {
            uiView.effect = target
            return
        }
        let duration: TimeInterval = if reduceMotion {
            isActive ? AidenQuickPhotoStripMotion.reducedMotionOpenDuration : AidenQuickPhotoStripMotion.reducedMotionCloseDuration
        } else {
            isActive ? 0.28 : 0.2
        }
        let apply = {
            UIView.animate(withDuration: duration, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
                uiView.effect = target
            }
        }
        if uiView.window == nil {
            DispatchQueue.main.async {
                guard coordinator.lastActive == isActive else { return }
                apply()
            }
        } else {
            apply()
        }
    }

    final class Coordinator {
        var lastActive: Bool?
        var lastScheme: ColorScheme?
    }
}

/// Inline circular progress ring centered over an uploading attachment card.
/// Drives the `.preparing` spin with `TimelineView` so transitioning to
/// `.uploading(fraction)` never whips backwards or leaks repeating animations.
struct AidenAttachmentProgressRing: View {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let phase: AidenStagingAttachment.Phase

    private let diameter: CGFloat = 26
    private let lineWidth: CGFloat = 2.5

    private var isPreparing: Bool {
        if case .preparing = phase { return true }
        return false
    }

    private var trimEnd: CGFloat {
        switch phase {
        case .queued: 0.22
        case .preparing: 0.30
        case .uploading(let fraction): max(0.10, min(1, fraction))
        }
    }

    private var strokeOpacity: Double {
        if case .queued = phase { return 0.62 }
        return 1
    }

    var body: some View {
        TimelineView(.animation(paused: !isPreparing || reduceMotion)) { context in
            let spinOffset: Double = if isPreparing, !reduceMotion {
                (context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9) * 360
            } else {
                0
            }
            ZStack {
                Circle()
                    .stroke(.white.opacity(0.28), lineWidth: lineWidth)

                Circle()
                    .trim(from: 0, to: trimEnd)
                    .stroke(.white.opacity(strokeOpacity), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .animation(reduceMotion ? nil : .linear(duration: 0.14), value: trimEnd)
                    .rotationEffect(.degrees(-90 + spinOffset))
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityHidden(true)
    }
}

/// Unified horizontal composer attachment strip shared by Workspace and Bot
/// chats. Promoted items keep a single structural card view and stable UUID
/// identity so the dark scrim and progress ring crossfade cleanly off the thumbnail.
struct AidenComposerAttachmentStrip: View {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let pendingAttachments: [AidenAttachmentReference]
    let stagingStore: AidenAttachmentStagingStore
    let loadImageData: (AidenAttachmentReference) async -> Data?
    let onRemovePending: (AidenAttachmentReference) -> Void
    let onCancelStaging: (UUID) -> Void

    private struct CardSlot: Identifiable {
        let id: String
        let kind: AidenStagingAttachment.Kind
        let displayName: String
        let pendingAttachmentID: String?
        let initialImage: UIImage?
        let stagingState: AidenStagingAttachmentProgress?
        let removeAccessibilityLabel: String
        let loadImageData: (() async -> Data?)?
        let onDismiss: () -> Void
    }

    private var slots: [CardSlot] {
        let pending = pendingAttachments.map { attachment in
            CardSlot(
                id: stagingStore.stableCardID(for: attachment.id),
                kind: attachment.kind == .image ? .image : .file,
                displayName: attachment.name,
                pendingAttachmentID: attachment.id,
                initialImage: stagingStore.previewImage(for: attachment.id),
                stagingState: nil,
                removeAccessibilityLabel: String(localized: "Remove \(attachment.name)"),
                loadImageData: { await loadImageData(attachment) },
                onDismiss: { onRemovePending(attachment) }
            )
        }
        let staging = stagingStore.items.map { item in
            CardSlot(
                id: item.id.uuidString,
                kind: item.kind,
                displayName: item.displayName,
                pendingAttachmentID: nil,
                initialImage: nil,
                stagingState: item.state,
                removeAccessibilityLabel: String(localized: "Cancel uploading \(item.displayName)"),
                loadImageData: nil,
                onDismiss: { onCancelStaging(item.id) }
            )
        }
        return pending + staging
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(slots) { slot in
                    AidenUnifiedAttachmentCard(
                        kind: slot.kind,
                        displayName: slot.displayName,
                        pendingAttachmentID: slot.pendingAttachmentID,
                        initialImage: slot.initialImage,
                        stagingState: slot.stagingState,
                        loadImageData: slot.loadImageData,
                        removeAccessibilityLabel: slot.removeAccessibilityLabel,
                        onDismiss: slot.onDismiss
                    )
                    .transition(.opacity.combined(with: .scale(scale: 0.94)))
                }
            }
            .padding(.horizontal, 4)
            .padding(.top, 4)
        }
        .accessibilityLabel("Attachments")
        .animation(reduceMotion ? nil : .smooth(duration: 0.28), value: slots.map(\.id))
    }
}

/// One attachment card in `AidenComposerAttachmentStrip`. Because its structural
/// identity stays constant when a staging card promotes to a pending attachment,
/// only the dark scrim and circular ring crossfade off when upload completes.
private struct AidenUnifiedAttachmentCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let kind: AidenStagingAttachment.Kind
    let displayName: String
    let pendingAttachmentID: String?
    let initialImage: UIImage?
    let stagingState: AidenStagingAttachmentProgress?
    let loadImageData: (() async -> Data?)?
    let removeAccessibilityLabel: String
    let onDismiss: () -> Void

    @State private var loadedImage: UIImage?

    private var displayedImage: UIImage? {
        stagingState?.previewImage ?? initialImage ?? loadedImage
    }

    private var isStaging: Bool { stagingState != nil }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: AidenAttachmentCardMetrics.cornerRadius, style: .continuous)
        cardBody
            .overlay {
                if let stagingState {
                    ZStack {
                        Color.black.opacity(0.45)
                        AidenAttachmentProgressRing(phase: stagingState.phase)
                    }
                    .transition(.opacity)
                }
            }
            .clipShape(shape)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: isStaging)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(displayName)
            .accessibilityValue(accessibilityStatus)
            .accessibilityAddTraits(isStaging ? .updatesFrequently : [])
            .overlay(alignment: .topTrailing) {
                AidenAttachmentCardRemoveButton(
                    accessibilityLabel: removeAccessibilityLabel,
                    action: onDismiss
                )
            }
            .accessibilityElement(children: .contain)
            .task(id: pendingAttachmentID) {
                guard let pendingAttachmentID, kind == .image else {
                    loadedImage = nil
                    return
                }
                guard initialImage == nil, let loadImageData else { return }
                loadedImage = nil
                guard let data = await loadImageData(), !Task.isCancelled else { return }
                _ = pendingAttachmentID
                loadedImage = await AidenPickedPhotoItemLoader.makeThumbnailAsync(from: data) ?? UIImage(data: data)
            }
    }

    @ViewBuilder
    private var cardBody: some View {
        if kind == .image {
            ZStack {
                palette.raised
                if let displayedImage {
                    Image(uiImage: displayedImage)
                        .resizable()
                        .scaledToFill()
                } else if !isStaging {
                    Image(systemName: "photo")
                        .font(.title3)
                        .foregroundStyle(palette.secondary)
                }
            }
            .frame(
                width: AidenAttachmentCardMetrics.imageSide,
                height: AidenAttachmentCardMetrics.imageSide
            )
        } else {
            VStack(alignment: .leading, spacing: 5) {
                Image(systemName: "doc.text.fill")
                    .font(.callout)
                Spacer(minLength: 0)
                Text(displayName)
                    .font(.caption2.weight(.medium))
                    .lineLimit(2)
            }
            .dynamicTypeSize(...AidenComposerLayout.largestGlyphSize)
            .foregroundStyle(palette.foreground)
            .padding(9)
            .frame(
                width: AidenAttachmentCardMetrics.fileWidth,
                height: AidenAttachmentCardMetrics.fileHeight,
                alignment: .leading
            )
            .background(palette.raised)
        }
    }

    private var accessibilityStatus: String {
        guard let phase = stagingState?.phase else {
            return String(localized: "Ready to send")
        }
        switch phase {
        case .queued:
            return String(localized: "Waiting to upload")
        case .preparing:
            return String(localized: "Preparing")
        case .uploading(let fraction):
            return String(localized: "\(Int((min(1, max(0, fraction)) * 100).rounded(.down))) percent uploaded")
        }
    }
}

/// High-contrast circular dismiss button shared by staging and staged cards,
/// with a full 44×44 pt hit target anchored to the card's top-trailing corner.
struct AidenAttachmentCardRemoveButton: View {
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Color.clear
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 22, height: 22)
                    .background(.black.opacity(0.66), in: Circle())
                    .overlay {
                        Circle().stroke(.white.opacity(0.26), lineWidth: 0.75)
                    }
                    .padding(5)
            }
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}
