import Observation
import Photos
import SwiftUI
import UIKit

enum AidenAttachmentPickerMode: Equatable {
    case closed
    case menu
    case camera
    case photos
}

enum AidenAttachmentPickerPolicy {
    static let maximumAttachments = 10
    static let maximumVisiblePhotos = 180

    static func availableCapacity(pendingCount: Int) -> Int {
        max(0, maximumAttachments - pendingCount)
    }

    static func toggledSelection(
        _ selected: [String],
        id: String,
        capacity: Int
    ) -> [String] {
        if selected.contains(id) {
            return selected.filter { $0 != id }
        }
        guard selected.count < max(0, capacity) else { return selected }
        return selected + [id]
    }

    static func confirmationLabel(count: Int) -> String {
        count == 1 ? "Add 1 Photo" : "Add \(count) Photos"
    }

    static func canPresent(
        isReadOnly: Bool,
        isStreaming: Bool,
        isUploading: Bool,
        isPreparing: Bool,
        capacity: Int
    ) -> Bool {
        !isReadOnly && !isStreaming && !isUploading && !isPreparing && capacity > 0
    }
}

struct AidenChatReadableLayout {
    static let landscapeWidthFraction: CGFloat = 0.5

    static func usesCenteredLandscapeColumn(
        containerSize: CGSize,
        windowSize: CGSize? = nil,
        isPad: Bool = UIDevice.current.userInterfaceIdiom == .pad
    ) -> Bool {
        let referenceSize = if let windowSize,
                               windowSize.width > 0,
                               windowSize.height > 0 {
            windowSize
        } else {
            containerSize
        }
        return isPad && referenceSize.width >= 760 && referenceSize.width > referenceSize.height
    }

    static func contentWidth(
        containerSize: CGSize,
        windowSize: CGSize? = nil,
        isPad: Bool = UIDevice.current.userInterfaceIdiom == .pad
    ) -> CGFloat {
        let width = max(1, containerSize.width)
        guard usesCenteredLandscapeColumn(
            containerSize: containerSize,
            windowSize: windowSize,
            isPad: isPad
        ) else {
            return width
        }
        return floor(width * landscapeWidthFraction)
    }

    static func horizontalInset(
        containerSize: CGSize,
        windowSize: CGSize? = nil,
        isPad: Bool = UIDevice.current.userInterfaceIdiom == .pad
    ) -> CGFloat {
        (
            max(1, containerSize.width) - contentWidth(
                containerSize: containerSize,
                windowSize: windowSize,
                isPad: isPad
            )
        ) / 2
    }
}

/// Reports the bounds of the actual SwiftUI window rather than the current
/// detail column. That keeps iPad landscape decisions stable across split view,
/// Stage Manager, keyboard presentation, and rotation.
struct AidenWindowSizeReader: UIViewRepresentable {
    let onChange: @MainActor (CGSize) -> Void

    func makeUIView(context: Context) -> AidenWindowSizeObservationView {
        AidenWindowSizeObservationView(onChange: onChange)
    }

    func updateUIView(_ uiView: AidenWindowSizeObservationView, context: Context) {
        uiView.onChange = onChange
        uiView.publishIfNeeded()
    }
}

final class AidenWindowSizeObservationView: UIView {
    var onChange: @MainActor (CGSize) -> Void
    private var lastPublishedSize = CGSize.zero

    init(onChange: @escaping @MainActor (CGSize) -> Void) {
        self.onChange = onChange
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        publishIfNeeded()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        publishIfNeeded()
    }

    func publishIfNeeded() {
        guard let window else { return }
        let size = window.bounds.size
        guard size != lastPublishedSize else { return }
        lastPublishedSize = size
        Task { @MainActor [onChange] in onChange(size) }
    }
}

struct AidenAttachmentPickerLayout {
    static let photoColumnCount = 3
    static let photoGridSpacing: CGFloat = 1.5
    static let expandedMaximumWidth: CGFloat = 620
    static let expandedMaximumHeight: CGFloat = 700

    let panelSize: CGSize
    let leadingPadding: CGFloat
    let bottomPadding: CGFloat
    let scaleAnchor: UnitPoint

    static func resolve(
        containerSize: CGSize,
        mode: AidenAttachmentPickerMode,
        attachmentButtonCenter: CGPoint?,
        isPad: Bool = UIDevice.current.userInterfaceIdiom == .pad
    ) -> Self {
        let containerWidth = max(1, containerSize.width)
        let containerHeight = max(1, containerSize.height)
        let expanded = mode == .photos || mode == .camera
        let centersLandscapeColumn = AidenChatReadableLayout.usesCenteredLandscapeColumn(
            containerSize: containerSize,
            isPad: isPad
        )
        let readableWidth = AidenChatReadableLayout.contentWidth(
            containerSize: containerSize,
            isPad: isPad
        )
        let readableInset = AidenChatReadableLayout.horizontalInset(
            containerSize: containerSize,
            isPad: isPad
        )
        let usesWidePresentation = expanded && containerWidth >= 700
        let edgePadding: CGFloat = usesWidePresentation ? 28 : 12
        let panelWidth: CGFloat
        let leadingPadding: CGFloat
        if expanded && centersLandscapeColumn {
            panelWidth = min(expandedMaximumWidth, max(1, readableWidth - 24))
            leadingPadding = readableInset + ((readableWidth - panelWidth) / 2)
        } else if expanded {
            panelWidth = min(expandedMaximumWidth, max(1, containerWidth - (edgePadding * 2)))
            leadingPadding = edgePadding
        } else {
            panelWidth = min(320, max(1, readableWidth - 52))
            leadingPadding = readableInset + 40
        }
        let bottomPadding: CGFloat = expanded ? (usesWidePresentation ? 18 : 8) : 74
        let availableHeight = max(1, containerHeight - bottomPadding - 12)
        let preferredExpandedHeight = max(460, containerHeight * 0.66)
        let panelHeight = expanded
            ? min(expandedMaximumHeight, min(preferredExpandedHeight, availableHeight))
            : min(222, availableHeight)
        let panelOriginY = containerHeight - bottomPadding - panelHeight
        let fallbackButtonCenter = CGPoint(x: 50, y: containerHeight - 36)
        let buttonCenter = attachmentButtonCenter ?? fallbackButtonCenter

        return Self(
            panelSize: CGSize(width: panelWidth, height: panelHeight),
            leadingPadding: leadingPadding,
            bottomPadding: bottomPadding,
            scaleAnchor: UnitPoint(
                x: boundedAnchor((buttonCenter.x - leadingPadding) / panelWidth),
                y: boundedAnchor((buttonCenter.y - panelOriginY) / panelHeight)
            )
        )
    }

    static func photoCellSide(panelWidth: CGFloat) -> CGFloat {
        let totalSpacing = photoGridSpacing * CGFloat(photoColumnCount - 1)
        return max(1, floor((panelWidth - totalSpacing) / CGFloat(photoColumnCount)))
    }

    private static func boundedAnchor(_ value: CGFloat) -> CGFloat {
        min(1.35, max(-0.25, value))
    }
}

enum AidenPhotoLibraryStatus: Equatable {
    case idle
    case loading
    case denied
    case empty
    case ready(limited: Bool)
}

@MainActor
@Observable
final class AidenAttachmentPickerState {
    private(set) var mode: AidenAttachmentPickerMode = .closed
    private(set) var libraryStatus: AidenPhotoLibraryStatus = .idle
    private(set) var assets: [PHAsset] = []
    private(set) var selectedAssetIDs: [String] = []
    private(set) var committingAssets: [PHAsset] = []
    private(set) var committingPendingPrefixCount = 0
    private(set) var selectionFeedbackSequence = 0

    var isPresented: Bool { mode != .closed }

    func openMenu() {
        selectedAssetIDs = []
        mode = .menu
    }

    func dismiss() {
        selectedAssetIDs = []
        mode = .closed
    }

    func beginShowingPhotos() {
        mode = .photos
    }

    func beginShowingCamera() {
        selectedAssetIDs = []
        mode = .camera
    }

    func showPhotos() async {
        beginShowingPhotos()
        await loadLibrary()
    }

    func backToMenu() {
        selectedAssetIDs = []
        mode = .menu
    }

    func toggle(_ asset: PHAsset, capacity: Int) {
        let next = AidenAttachmentPickerPolicy.toggledSelection(
            selectedAssetIDs,
            id: asset.localIdentifier,
            capacity: capacity
        )
        guard next != selectedAssetIDs else { return }
        selectedAssetIDs = next
        selectionFeedbackSequence &+= 1
    }

    func selectionOrder(for asset: PHAsset) -> Int? {
        selectedAssetIDs.firstIndex(of: asset.localIdentifier).map { $0 + 1 }
    }

    func beginCommit(pendingCount: Int) -> [PHAsset] {
        let byID = Dictionary(uniqueKeysWithValues: assets.map { ($0.localIdentifier, $0) })
        let selected = selectedAssetIDs.compactMap { byID[$0] }
        guard !selected.isEmpty else { return [] }
        committingPendingPrefixCount = pendingCount
        committingAssets = selected
        selectedAssetIDs = []
        mode = .closed
        return selected
    }

    func finishCommit() {
        committingAssets = []
        committingPendingPrefixCount = 0
    }

    func reset() {
        mode = .closed
        selectedAssetIDs = []
        committingAssets = []
        committingPendingPrefixCount = 0
    }

    func loadLibrary() async {
        libraryStatus = .loading
        var authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if authorization == .notDetermined {
            authorization = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        guard authorization == .authorized || authorization == .limited else {
            assets = []
            libraryStatus = .denied
            return
        }

        let options = PHFetchOptions()
        options.fetchLimit = AidenAttachmentPickerPolicy.maximumVisiblePhotos
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let result = PHAsset.fetchAssets(with: .image, options: options)
        var loaded: [PHAsset] = []
        loaded.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in loaded.append(asset) }
        assets = loaded
        libraryStatus = loaded.isEmpty ? .empty : .ready(limited: authorization == .limited)
    }
}

enum AidenPhotoLibraryImageLoader {
    struct PickedImage: Sendable {
        let data: Data
        let name: String
    }

    static func pickedImage(for asset: PHAsset) async throws -> PickedImage {
        let name = PHAssetResource.assetResources(for: asset).first?.originalFilename ?? "Photo.jpg"
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.version = .current

        return try await withCheckedThrowingContinuation { continuation in
            PHImageManager.default().requestImageDataAndOrientation(
                for: asset,
                options: options
            ) { data, _, _, info in
                if let error = info?[PHImageErrorKey] as? Error {
                    continuation.resume(throwing: error)
                } else if (info?[PHImageCancelledKey] as? Bool) == true {
                    continuation.resume(throwing: CancellationError())
                } else if let data, !data.isEmpty {
                    continuation.resume(returning: PickedImage(data: data, name: name))
                } else {
                    continuation.resume(throwing: AidenAttachmentPreparationError.invalidImage)
                }
            }
        }
    }
}

struct AidenAttachmentPickerOverlay: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Bindable var picker: AidenAttachmentPickerState
    @StateObject private var cameraController = AidenAttachmentCameraController()

    let motionNamespace: Namespace.ID
    let attachmentCapacity: Int
    let canChoosePhotos: Bool
    let isBotChat: Bool
    let isBusy: Bool
    let attachmentButtonCenter: CGPoint?
    let onUnavailableBotPhotos: () -> Void
    let onChooseFiles: () -> Void
    let onCaptureCameraPhoto: (Data) -> Void
    let onCommitPhotos: () -> Void

    var body: some View {
        GeometryReader { proxy in
            let layout = AidenAttachmentPickerLayout.resolve(
                containerSize: proxy.size,
                mode: picker.mode,
                attachmentButtonCenter: attachmentButtonCenter
            )

            ZStack(alignment: .bottomLeading) {
                Color.black.opacity(
                    picker.isPresented ? (picker.mode == .menu ? 0.08 : 0.2) : 0
                )
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { dismiss() }
                    .accessibilityHidden(true)

                panel(size: layout.panelSize)
                    .padding(.leading, layout.leadingPadding)
                    .padding(.bottom, layout.bottomPadding)
                    .scaleEffect(
                        picker.isPresented ? 1 : 0.06,
                        anchor: layout.scaleAnchor
                    )
                    .opacity(picker.isPresented ? 1 : 0)
            }
        }
        .sensoryFeedback(.selection, trigger: picker.selectionFeedbackSequence)
        .accessibilityAddTraits(.isModal)
    }

    private func panel(size: CGSize) -> some View {
        let cornerRadius: CGFloat = 46

        return ZStack {
            if picker.mode == .menu {
                menuPanel.transition(panelContentTransition)
            }
            if picker.mode == .photos {
                photoPanel.transition(panelContentTransition)
            }
            if picker.mode == .camera {
                AidenAttachmentCameraPanel(
                    controller: cameraController,
                    onBack: { animate { picker.backToMenu() } },
                    onCaptured: onCaptureCameraPhoto
                )
                .transition(panelContentTransition)
            }
        }
        .frame(width: size.width, height: size.height)
        .modifier(AidenAttachmentPanelSurface(
            cornerRadius: cornerRadius,
            reduceTransparency: reduceTransparency
        ))
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }

    private var panelContentTransition: AnyTransition {
        .opacity
    }

    private var menuPanel: some View {
        VStack(spacing: 0) {
            attachmentMenuRow(
                title: "Files",
                systemImage: "paperclip",
                enabled: !isBusy
            ) {
                dismiss()
                onChooseFiles()
            }

            attachmentMenuRow(
                title: "Camera",
                systemImage: "camera",
                enabled: imageMenuIsEnabled
            ) {
                openImageChoice { picker.beginShowingCamera() }
            }

            attachmentMenuRow(
                title: "Photos",
                systemImage: "photo.on.rectangle.angled",
                enabled: imageMenuIsEnabled
            ) {
                openImageChoice { picker.beginShowingPhotos() }
                if canChoosePhotos {
                    Task { await picker.loadLibrary() }
                }
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attachment choices")
    }

    private func attachmentMenuRow(
        title: LocalizedStringKey,
        systemImage: String,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: systemImage)
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(enabled ? palette.foreground : palette.secondary)
                    .frame(width: 42, height: 42)
                    .background(palette.foreground.opacity(0.08), in: Circle())

                Text(title)
                    .font(.title3.weight(.regular))
                    .foregroundStyle(enabled ? palette.foreground : palette.secondary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 66, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityHint(enabled ? "" : "Reconnect to your Mac to use this attachment option")
    }

    private var photoPanel: some View {
        ZStack(alignment: .bottom) {
            photoGrid

            LinearGradient(
                colors: [.clear, .black.opacity(0.42)],
                startPoint: .center,
                endPoint: .bottom
            )
            .allowsHitTesting(false)

            HStack(spacing: 12) {
                Button { animate { picker.backToMenu() } } label: {
                    Image(systemName: "chevron.left")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(width: 46, height: 46)
                        .background(controlBackground, in: Circle())
                        .overlay { Circle().stroke(.white.opacity(0.16), lineWidth: 1) }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to attachment choices")

                Spacer()

                Button(action: onCommitPhotos) {
                    Text(confirmLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(
                            picker.selectedAssetIDs.isEmpty ? .white.opacity(0.58) : palette.onAccent
                        )
                        .padding(.horizontal, 18)
                        .frame(minHeight: 46)
                        .background(
                            picker.selectedAssetIDs.isEmpty ? controlBackground : palette.accent,
                            in: Capsule()
                        )
                        .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: confirmLabel)
                }
                .buttonStyle(.plain)
                .disabled(picker.selectedAssetIDs.isEmpty || isBusy)
            }
            .padding(.horizontal, 25)
            .padding(.bottom, 25)

            if case .ready(limited: true) = picker.libraryStatus {
                Button("Manage Access") { openSettings() }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .background(.black.opacity(0.54), in: Capsule())
                    .padding(14)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            }
        }
    }

    @ViewBuilder
    private var photoGrid: some View {
        switch picker.libraryStatus {
        case .ready:
            GeometryReader { proxy in
                let spacing = AidenAttachmentPickerLayout.photoGridSpacing
                let cellSide = AidenAttachmentPickerLayout.photoCellSide(panelWidth: proxy.size.width)
                ScrollView {
                    LazyVGrid(
                        columns: Array(
                            repeating: GridItem(.fixed(cellSide), spacing: spacing),
                            count: AidenAttachmentPickerLayout.photoColumnCount
                        ),
                        spacing: spacing
                    ) {
                        ForEach(picker.assets, id: \.localIdentifier) { asset in
                            photoCell(asset, side: cellSide)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 104)
                }
                .scrollIndicators(.hidden)
                .accessibilityLabel("Recent photos")
            }
        case .loading, .idle:
            GeometryReader { proxy in
                let spacing = AidenAttachmentPickerLayout.photoGridSpacing
                let cellSide = AidenAttachmentPickerLayout.photoCellSide(panelWidth: proxy.size.width)
                LazyVGrid(
                    columns: Array(
                        repeating: GridItem(.fixed(cellSide), spacing: spacing),
                        count: AidenAttachmentPickerLayout.photoColumnCount
                    ),
                    spacing: spacing
                ) {
                    ForEach(0..<15, id: \.self) { _ in
                        AidenAttachmentSkeletonBlock(
                            width: cellSide,
                            height: cellSide,
                            radius: 2,
                            reduceMotion: reduceMotion
                        )
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Loading recent photos")
            }
        case .empty:
            placeholder {
                Image(systemName: "photo.on.rectangle")
                    .font(.title2)
                Text("No photos are available.")
            }
        case .denied:
            placeholder {
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.title2)
                Text("Photo access is off")
                    .font(.headline)
                Text("Allow access in Settings to browse recent photos here.")
                    .font(.caption)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(palette.secondary)
                Button("Open Settings") { openSettings() }
                    .buttonStyle(.borderedProminent)
                    .tint(palette.accent)
            }
        }
    }

    private func photoCell(_ asset: PHAsset, side: CGFloat) -> some View {
        let order = picker.selectionOrder(for: asset)
        return Button {
            animate { picker.toggle(asset, capacity: attachmentCapacity) }
        } label: {
            AidenPhotoAssetThumbnail(asset: asset, targetDimension: side)
                .frame(width: side, height: side)
                .clipped()
                .overlay(alignment: .bottomTrailing) {
                    if let order {
                        Text("\(order)")
                            .font(.caption.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(.white)
                            .frame(width: 24, height: 24)
                            .background(palette.accent, in: Circle())
                            .overlay { Circle().stroke(.white, lineWidth: 2) }
                            .padding(5)
                            .transition(.scale(scale: 0.45).combined(with: .opacity))
                    }
                }
                .contentShape(Rectangle())
                .matchedGeometryEffect(
                    id: "photo-\(asset.localIdentifier)",
                    in: motionNamespace,
                    isSource: true
                )
        }
        .buttonStyle(.plain)
        .frame(width: side, height: side)
        .accessibilityLabel("Photo")
        .accessibilityValue(order.map { "Selected, number \($0)" } ?? "Not selected")
        .accessibilityAddTraits(order == nil ? [] : .isSelected)
    }

    private func placeholder<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 10, content: content)
            .foregroundStyle(palette.foreground)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(32)
    }

    private var imageMenuIsEnabled: Bool {
        !isBusy && attachmentCapacity > 0 && (canChoosePhotos || isBotChat)
    }

    private var confirmLabel: String {
        picker.selectedAssetIDs.isEmpty
            ? "Select Photos"
            : AidenAttachmentPickerPolicy.confirmationLabel(count: picker.selectedAssetIDs.count)
    }

    private var controlBackground: Color {
        .black.opacity(0.54)
    }

    private func openImageChoice(_ action: () -> Void) {
        if isBotChat && !canChoosePhotos {
            dismiss()
            onUnavailableBotPhotos()
        } else {
            animate(action)
        }
    }

    private func dismiss() {
        animate { picker.dismiss() }
    }

    private func animate(_ changes: () -> Void) {
        withAnimation(reduceMotion ? nil : .spring(duration: 0.4, bounce: 0.12), changes)
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

private struct AidenAttachmentSkeletonBlock: View {
    @Environment(\.aidenPalette) private var palette

    let width: CGFloat?
    let height: CGFloat
    let radius: CGFloat
    let reduceMotion: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(palette.raised)
            .frame(width: width, height: height)
            .opacity(reduceMotion ? 0.78 : 1)
            .accessibilityHidden(true)
    }
}

struct AidenCommittingPhotoCard: View {
    let asset: PHAsset
    let motionNamespace: Namespace.ID

    var body: some View {
        AidenPhotoAssetThumbnail(asset: asset, targetDimension: 94)
            .frame(width: 94, height: 94)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(alignment: .center) {
                ProgressView()
                    .tint(.white)
                    .padding(7)
                    .background(.black.opacity(0.38), in: Circle())
            }
            .matchedGeometryEffect(
                id: "photo-\(asset.localIdentifier)",
                in: motionNamespace,
                isSource: false
            )
            .accessibilityLabel("Adding photo")
    }
}

struct AidenPendingAttachmentCard: View {
    @Environment(\.aidenPalette) private var palette
    let attachment: AidenAttachmentReference
    let loadImageData: () async -> Data?
    let onRemove: () -> Void
    @State private var image: UIImage?

    var body: some View {
        Group {
            if attachment.kind == .image {
                ZStack {
                    palette.raised
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else {
                        Image(systemName: "photo")
                            .font(.title2)
                            .foregroundStyle(palette.secondary)
                    }
                }
                .frame(width: 94, height: 94)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    Image(systemName: "doc.text.fill")
                        .font(.title2)
                    Spacer(minLength: 0)
                    Text(attachment.name)
                        .font(.caption.weight(.medium))
                        .lineLimit(2)
                }
                .foregroundStyle(palette.foreground)
                .padding(11)
                .frame(width: 118, height: 94, alignment: .leading)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
        .overlay(alignment: .topTrailing) {
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 22, height: 22)
                    .background(.black.opacity(0.58), in: Circle())
            }
            .buttonStyle(.plain)
            .padding(6)
            .accessibilityLabel("Remove \(attachment.name)")
        }
        .accessibilityElement(children: .contain)
        .task(id: attachment.id) {
            guard attachment.kind == .image, image == nil else { return }
            guard let data = await loadImageData(), !Task.isCancelled else { return }
            image = UIImage(data: data)
        }
    }
}

private struct AidenPhotoAssetThumbnail: View {
    @Environment(\.displayScale) private var displayScale
    private static let imageManager = PHCachingImageManager()

    let asset: PHAsset
    let targetDimension: CGFloat
    @State private var image: UIImage?
    @State private var requestID: PHImageRequestID = PHInvalidImageRequestID
    @State private var requestToken: UUID?

    var body: some View {
        ZStack {
            Color.black.opacity(0.12)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            }
        }
        .onAppear(perform: requestImage)
        .onDisappear(perform: cancelRequest)
        .onChange(of: asset.localIdentifier) {
            cancelRequest()
            image = nil
            requestImage()
        }
    }

    private func requestImage() {
        guard requestID == PHInvalidImageRequestID else { return }
        let token = UUID()
        requestToken = token
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        options.isNetworkAccessAllowed = true
        let pixelDimension = max(1, ceil(targetDimension * displayScale))
        requestID = Self.imageManager.requestImage(
            for: asset,
            targetSize: CGSize(width: pixelDimension, height: pixelDimension),
            contentMode: .aspectFill,
            options: options
        ) { result, info in
            let wasCancelled = (info?[PHImageCancelledKey] as? Bool) == true
            let error = info?[PHImageErrorKey] as? Error
            guard !wasCancelled, error == nil, let result else { return }
            Task { @MainActor in
                guard requestToken == token else { return }
                image = result
            }
        }
    }

    private func cancelRequest() {
        guard requestID != PHInvalidImageRequestID else { return }
        Self.imageManager.cancelImageRequest(requestID)
        requestID = PHInvalidImageRequestID
        requestToken = nil
    }
}

private struct AidenAttachmentPanelSurface: ViewModifier {
    @Environment(\.aidenPalette) private var palette
    let cornerRadius: CGFloat
    let reduceTransparency: Bool

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    }

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *), !reduceTransparency {
            content.glassEffect(.regular, in: shape)
        } else if reduceTransparency {
            content.background(palette.raised, in: shape)
        } else {
            content.background(.ultraThinMaterial, in: shape)
        }
    }
}
