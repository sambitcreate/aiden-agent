import Accessibility
import CryptoKit
import ImageIO
import Photos
import SwiftUI
import UIKit

struct AidenAttachmentGallerySelection: Identifiable {
    let id: String
}

/// An inline image (or a deck of them) that opens the full-screen viewer with
/// Save to Photos. Shared by chat messages and the images a Bot shares.
struct AidenMessageImageAttachmentsView: View {
    @Environment(AidenHapticCenter.self) private var haptics
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let attachments: [AidenMessageAttachment]
    let edge: AidenMessageMediaEdge
    let loadData: (AidenMessageAttachment) async -> Data?
    /// Only this attachment plays the arrival reveal; the others draw as usual.
    var revealAttachmentID: String? = nil
    var onArrivalRevealed: (() -> Void)? = nil
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
                    imageAlignment: edge.alignment,
                    revealsArrival: attachments[0].id == revealAttachmentID,
                    onArrivalRevealed: onArrivalRevealed
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
            imageAlignment: edge.alignment,
            revealsArrival: attachment.id == revealAttachmentID,
            onArrivalRevealed: onArrivalRevealed
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

struct AidenAttachmentThumbnailView: View {
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
    var revealsArrival = false
    var onArrivalRevealed: (() -> Void)? = nil
    var onImageLoaded: ((UIImage) -> Void)? = nil
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
                    .aidenImageArrivalReveal(revealsArrival) { onArrivalRevealed?() }
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
            onImageLoaded?(image)
        }
    }
}

struct AidenAttachmentGalleryView: View {
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
