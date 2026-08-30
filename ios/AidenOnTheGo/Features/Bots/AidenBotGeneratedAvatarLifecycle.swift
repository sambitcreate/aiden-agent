import CryptoKit
import Foundation
import ImageIO
import Observation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

enum AidenBotGeneratedAvatarError: Error, LocalizedError, Equatable {
    case sourceTooLarge
    case unsupportedImage
    case invalidImage
    case unavailable

    var errorDescription: String? {
        switch self {
        case .sourceTooLarge:
            "That image is too large. Choose another image."
        case .unsupportedImage:
            "That image format can’t be used for a Bot photo."
        case .invalidImage:
            "Aiden couldn’t prepare that image. Choose another image."
        case .unavailable:
            "Reconnect to your paired desktop before saving this Bot photo."
        }
    }
}

enum AidenBotGeneratedAvatarPhase: Equatable {
    case idle
    case loading
    case normalizing
    case ready
    case uploading
    case reverting
    case failed
}

struct AidenBotGeneratedAvatarSessionIdentity: Equatable {
    let instanceID: String?
    let deviceID: String?
    let connection: String
    let capabilityRevision: String

    @MainActor
    init(coordinator: AidenRemoteCoordinator) {
        let installation = coordinator.installationStore.activeInstallation
        instanceID = installation?.id
        deviceID = installation?.deviceId
        switch coordinator.connectionState {
        case .needsPairing: connection = "needs-pairing"
        case .connecting: connection = "connecting"
        case .connected: connection = "connected"
        case .offline: connection = "offline"
        }
        capabilityRevision = [
            installation?.deviceCapabilities.map(\.rawValue).sorted().joined(separator: ",") ?? "",
            installation?.serverCapabilities?.map(\.rawValue).sorted().joined(separator: ",") ?? "legacy",
        ].joined(separator: "|")
    }
}

func aidenBotAvatarExpectedRevision(_ detail: AidenBotDetail) -> String {
    detail.avatar.asset?.assetRevision ?? detail.revision
}

func aidenBotAvatarMutationFailureIsAmbiguous(_ error: Error) -> Bool {
    if error is CancellationError || error is URLError { return true }
    guard let remoteError = error as? AidenRemoteClientError else { return true }
    switch remoteError {
    case .invalidResponse:
        return true
    case let .server(statusCode, _), let .unexpectedStatus(statusCode):
        return (200..<300).contains(statusCode)
            || statusCode == 408
            || statusCode == 429
            || statusCode >= 500
    case .invalidEndpoint, .missingCredential, .missingTrustConfiguration, .installationChanged:
        return false
    }
}

/// Bounded, metadata-free normalization shared by candidate admission and
/// ambiguous-upload reconciliation. Image Playground's accepted temporary
/// file is untrusted input at this boundary even though the system created it.
enum AidenBotGeneratedAvatarNormalizer {
    static let edge = 512
    static let maximumSourceBytes = 32 * 1_048_576
    static let maximumOutputBytes = 4 * 1_048_576
    static let maximumSourceDimension = 16_384
    static let maximumSourcePixels = 40_000_000
    private static let decodeEdge = 2_048

    static func normalize(_ data: Data) throws -> Data {
        guard !data.isEmpty, data.count <= maximumSourceBytes else {
            throw AidenBotGeneratedAvatarError.sourceTooLarge
        }
        guard let source = CGImageSourceCreateWithData(
            data as CFData,
            [kCGImageSourceShouldCache: false] as CFDictionary
        ), CGImageSourceGetCount(source) == 1,
           CGImageSourceGetStatus(source) == .statusComplete,
           CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
           let typeIdentifier = CGImageSourceGetType(source) as String?,
           let type = UTType(typeIdentifier), type.conforms(to: .image) else {
            throw AidenBotGeneratedAvatarError.unsupportedImage
        }
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
            as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0,
              width <= maximumSourceDimension, height <= maximumSourceDimension,
              width <= maximumSourcePixels / height else {
            throw AidenBotGeneratedAvatarError.invalidImage
        }
        if let png = properties[kCGImagePropertyPNGDictionary] as? [CFString: Any],
           png[kCGImagePropertyAPNGLoopCount] != nil
            || png[kCGImagePropertyAPNGDelayTime] != nil
            || png[kCGImagePropertyAPNGUnclampedDelayTime] != nil {
            throw AidenBotGeneratedAvatarError.invalidImage
        }
        guard let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: decodeEdge,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary) else {
            throw AidenBotGeneratedAvatarError.invalidImage
        }

        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
        guard let context = CGContext(
            data: nil,
            width: edge,
            height: edge,
            bitsPerComponent: 8,
            bytesPerRow: edge * 4,
            space: colorSpace ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw AidenBotGeneratedAvatarError.invalidImage
        }
        context.interpolationQuality = .high
        context.setFillColor(UIColor.clear.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: edge, height: edge))
        let scale = max(
            CGFloat(edge) / CGFloat(decoded.width),
            CGFloat(edge) / CGFloat(decoded.height)
        )
        let drawWidth = CGFloat(decoded.width) * scale
        let drawHeight = CGFloat(decoded.height) * scale
        let drawRect = CGRect(
            x: (CGFloat(edge) - drawWidth) / 2,
            y: (CGFloat(edge) - drawHeight) / 2,
            width: drawWidth,
            height: drawHeight
        )
        context.draw(decoded, in: drawRect)
        guard let rendered = context.makeImage() else {
            throw AidenBotGeneratedAvatarError.invalidImage
        }

        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            throw AidenBotGeneratedAvatarError.invalidImage
        }
        CGImageDestinationAddImage(destination, rendered, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw AidenBotGeneratedAvatarError.invalidImage
        }
        let normalized = output as Data
        guard !normalized.isEmpty, normalized.count <= maximumOutputBytes else {
            throw AidenBotGeneratedAvatarError.invalidImage
        }
        return normalized
    }

    static func representsSameImage(_ lhs: Data, _ rhs: Data) -> Bool {
        guard let normalizedLHS = try? normalize(lhs),
              let normalizedRHS = try? normalize(rhs) else { return false }
        return SHA256.hash(data: normalizedLHS) == SHA256.hash(data: normalizedRHS)
    }
}

private struct AidenBotGeneratedAvatarUploadAttempt: Equatable {
    let context: AidenRemoteRequestContext
    let botID: String
    let expectedRevision: String
    let candidateDigest: SHA256Digest
    let idempotencyKey: UUID
}

private struct AidenBotGeneratedAvatarDeleteAttempt: Equatable {
    let context: AidenRemoteRequestContext
    let botID: String
    let expectedRevision: String
}

private struct AidenBotGeneratedAvatarLoadAttempt: Equatable {
    let context: AidenRemoteRequestContext
    let operationGeneration: UInt
    let token: UUID
}

@MainActor
@Observable
final class AidenBotGeneratedAvatarModel {
    let coordinator: AidenRemoteCoordinator
    let botID: String
    private let cache: AidenBotCache
    private let onChanged: (AidenBotDetail) -> Void

    private(set) var phase: AidenBotGeneratedAvatarPhase = .idle
    private(set) var authoritativeBot: AidenBotDetail?
    private(set) var currentImage: UIImage?
    private(set) var candidateImage: UIImage?
    private(set) var errorMessage: String?

    private var currentBytes: Data?
    private var candidateBytes: Data?
    private var capturedContext: AidenRemoteRequestContext?
    private var uploadAttempt: AidenBotGeneratedAvatarUploadAttempt?
    private var deleteAttempt: AidenBotGeneratedAvatarDeleteAttempt?
    private var operationGeneration: UInt = 0
    private var lastSessionIdentity: AidenBotGeneratedAvatarSessionIdentity?
    private var activeLoadAttempt: AidenBotGeneratedAvatarLoadAttempt?
    private var activeMutationToken: UUID?

    init(
        coordinator: AidenRemoteCoordinator,
        botID: String,
        cache: AidenBotCache = .shared,
        onChanged: @escaping (AidenBotDetail) -> Void = { _ in }
    ) {
        self.coordinator = coordinator
        self.botID = botID
        self.cache = cache
        self.onChanged = onChanged
    }

    var sessionIdentity: AidenBotGeneratedAvatarSessionIdentity {
        AidenBotGeneratedAvatarSessionIdentity(coordinator: coordinator)
    }

    var displayedImage: UIImage? { candidateImage ?? currentImage }
    var hasCandidate: Bool { candidateBytes != nil }
    var hasGeneratedAvatar: Bool { authoritativeBot?.avatar.asset != nil }
    var isBusy: Bool {
        activeMutationToken != nil
            || [.loading, .normalizing, .uploading, .reverting].contains(phase)
    }

    var canUseCandidate: Bool {
        candidateBytes != nil && canMutate && !isBusy
    }

    var canRevert: Bool {
        authoritativeBot?.avatar.asset != nil && canMutate && !isBusy
    }

    private var canMutate: Bool {
        guard coordinator.connectionState == .connected,
              coordinator.installationStore.activeInstallation?.canWriteBots == true,
              let context = capturedContext, coordinator.isCurrent(context),
              authoritativeBot?.health == .ready else { return false }
        return true
    }

    /// Clears every in-memory raster before changing installation/pairing
    /// authority, then reloads only authenticated canonical bytes.
    func sessionDidChangeAndRefresh() async {
        let nextIdentity = sessionIdentity
        let authorityChanged = lastSessionIdentity.map {
            $0.instanceID != nextIdentity.instanceID
                || $0.deviceID != nextIdentity.deviceID
                || $0.capabilityRevision != nextIdentity.capabilityRevision
        } ?? true
        lastSessionIdentity = nextIdentity
        if authorityChanged {
            clearAllRasterState()
        }
        guard activeMutationToken == nil, phase != .uploading, phase != .reverting else { return }
        guard nextIdentity.connection == "connected" else {
            if phase == .loading { phase = candidateBytes == nil ? .idle : .ready }
            return
        }
        if let attempt = uploadAttempt, let candidateBytes {
            await reconcileUpload(
                attempt: attempt,
                candidate: candidateBytes,
                generation: operationGeneration
            )
            return
        }
        phase = .loading
        let generation = operationGeneration
        var requestContext: AidenRemoteRequestContext?
        var loadAttempt: AidenBotGeneratedAvatarLoadAttempt?
        do {
            let context = try coordinator.requestContext()
            requestContext = context
            guard operationGeneration == generation, coordinator.isCurrent(context) else { return }
            let attempt = AidenBotGeneratedAvatarLoadAttempt(
                context: context,
                operationGeneration: generation,
                token: UUID()
            )
            loadAttempt = attempt
            activeLoadAttempt = attempt
            capturedContext = context
            let client = try coordinator.remoteClient(for: context)
            let detail = try await client.bot(id: botID)
            guard isCurrent(attempt) else { return }
            authoritativeBot = detail
            try await loadCanonicalPhoto(
                detail: detail,
                client: client,
                context: context,
                generation: generation,
                loadAttempt: attempt
            )
            guard isCurrent(attempt) else { return }
            activeLoadAttempt = nil
            phase = .idle
        } catch is CancellationError {
            if let loadAttempt, activeLoadAttempt == loadAttempt {
                activeLoadAttempt = nil
                phase = candidateBytes == nil ? .idle : .ready
            }
            return
        } catch {
            if let context = requestContext, coordinator.isCurrent(context),
               await coordinator.handleCredentialRevocation(error, context: context) {
                clearAllRasterState()
                return
            }
            guard let loadAttempt, activeLoadAttempt == loadAttempt else { return }
            activeLoadAttempt = nil
            capturedContext = nil
            phase = .failed
            errorMessage = "Aiden couldn’t load this Bot photo. Reconnect and try again."
        }
    }

    /// The URL must be an app-owned copy of Image Playground's temporary
    /// result. It is removed on every exit path before the system session ends.
    func ingestCopiedCandidate(
        at url: URL,
        candidateStore: AidenBotImagePlaygroundCandidateStore = .init()
    ) async {
        let generation = beginCandidateOperation()
        defer { candidateStore.removeOwnedCandidate(at: url) }
        do {
            let resourceKeys: Set<URLResourceKey> = [
                .fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey,
            ]
            let values = try url.resourceValues(forKeys: resourceKeys)
            guard values.isRegularFile == true,
                  values.isSymbolicLink != true,
                  let size = values.fileSize,
                  size > 0,
                  size <= AidenBotGeneratedAvatarNormalizer.maximumSourceBytes else {
                throw AidenBotGeneratedAvatarError.sourceTooLarge
            }
            let data = try Data(contentsOf: url, options: [.mappedIfSafe])
            let revalidated = try url.resourceValues(forKeys: resourceKeys)
            guard revalidated.isRegularFile == true,
                  revalidated.isSymbolicLink != true,
                  revalidated.fileSize == size,
                  data.count == size else {
                throw AidenBotGeneratedAvatarError.invalidImage
            }
            try await finishCandidateIngestion(data, generation: generation)
        } catch is CancellationError {
            if operationGeneration == generation { phase = .idle }
            return
        } catch let error as AidenBotGeneratedAvatarError {
            failCandidateIngestion(error, generation: generation)
        } catch {
            failCandidateIngestion(.invalidImage, generation: generation)
        }
    }

    func ingestCopiedCandidate(data: Data) async {
        let generation = beginCandidateOperation()
        do {
            try await finishCandidateIngestion(data, generation: generation)
        } catch is CancellationError {
            if operationGeneration == generation { phase = .idle }
            return
        } catch let error as AidenBotGeneratedAvatarError {
            failCandidateIngestion(error, generation: generation)
        } catch {
            failCandidateIngestion(.invalidImage, generation: generation)
        }
    }

    func cancelCandidate() {
        operationGeneration &+= 1
        candidateBytes = nil
        candidateImage = nil
        uploadAttempt = nil
        errorMessage = nil
        phase = .idle
    }

    func useCandidate() async {
        guard canUseCandidate, let context = capturedContext,
              let candidateBytes else {
            errorMessage = AidenBotGeneratedAvatarError.unavailable.localizedDescription
            return
        }
        let observedAssetRevision = authoritativeBot?.avatar.asset?.assetRevision
        let mutationToken = UUID()
        activeMutationToken = mutationToken
        phase = .uploading
        defer {
            if activeMutationToken == mutationToken {
                activeMutationToken = nil
                if phase == .uploading { phase = self.candidateBytes == nil ? .idle : .ready }
            }
        }
        let generation = operationGeneration
        let digest = SHA256.hash(data: candidateBytes)
        var sentAttempt: AidenBotGeneratedAvatarUploadAttempt?
        do {
            let client = try coordinator.remoteClient(for: context)
            let attempt: AidenBotGeneratedAvatarUploadAttempt
            if let retained = uploadAttempt,
               retained.context == context,
               retained.botID == botID,
               retained.candidateDigest == digest {
                // Reconcile before replaying an ambiguous request. If no
                // authoritative change is visible, the same exact key and
                // revision are safe to retry; a fresh key is never substituted.
                await reconcileUpload(
                    attempt: retained,
                    candidate: candidateBytes,
                    generation: generation
                )
                guard uploadAttempt == retained,
                      isCurrent(context, generation: generation),
                      authoritativeBot.map(aidenBotAvatarExpectedRevision)
                        == retained.expectedRevision else { return }
                attempt = retained
            } else {
                let fresh = try await refreshAuthoritativeBeforeMutation(
                    client: client,
                    context: context,
                    generation: generation
                )
                guard activeMutationToken == mutationToken,
                      fresh.health == .ready,
                      isCurrent(context, generation: generation) else {
                    throw AidenBotGeneratedAvatarError.unavailable
                }
                guard fresh.avatar.asset?.assetRevision == observedAssetRevision else {
                    self.candidateBytes = nil
                    candidateImage = nil
                    phase = .idle
                    errorMessage = "The Bot photo changed on your paired desktop. Review it before choosing a new image."
                    return
                }
                attempt = .init(
                    context: context,
                    botID: botID,
                    expectedRevision: aidenBotAvatarExpectedRevision(fresh),
                    candidateDigest: digest,
                    idempotencyKey: UUID()
                )
            }
            uploadAttempt = attempt
            sentAttempt = attempt
            phase = .uploading
            errorMessage = nil
            let upload = try AidenBotAvatarUpload(
                mimeType: .png,
                data: candidateBytes.base64EncodedString()
            )
            let asset = try await client.putBotAvatar(
                botId: botID,
                revision: attempt.expectedRevision,
                upload: upload,
                idempotencyKey: attempt.idempotencyKey
            )
            try await finishUpload(
                attempt: attempt,
                expectedAsset: asset,
                candidate: candidateBytes,
                client: client,
                generation: generation
            )
        } catch is CancellationError {
            if let sentAttempt {
                await reconcileUpload(
                    attempt: sentAttempt,
                    candidate: candidateBytes,
                    generation: generation
                )
            } else if isCurrent(context, generation: generation) {
                phase = .ready
            }
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) {
                clearAllRasterState()
                return
            }
            if let sentAttempt {
                await reconcileUpload(
                    attempt: sentAttempt,
                    candidate: candidateBytes,
                    generation: generation
                )
                if !aidenBotAvatarMutationFailureIsAmbiguous(error),
                   uploadAttempt == sentAttempt {
                    uploadAttempt = nil
                }
            } else if isCurrent(context, generation: generation) {
                phase = .ready
                errorMessage = "Aiden refreshed this Bot before saving. Review the current photo, then try again."
            }
        }
    }

    func revertToSemanticAvatar() async {
        guard canRevert, let context = capturedContext else {
            errorMessage = AidenBotGeneratedAvatarError.unavailable.localizedDescription
            return
        }
        let observedAssetRevision = authoritativeBot?.avatar.asset?.assetRevision
        let mutationToken = UUID()
        activeMutationToken = mutationToken
        phase = .reverting
        defer {
            if activeMutationToken == mutationToken {
                activeMutationToken = nil
                if phase == .reverting { phase = .idle }
            }
        }
        let generation = operationGeneration
        var sentAttempt: AidenBotGeneratedAvatarDeleteAttempt?
        do {
            let client = try coordinator.remoteClient(for: context)
            let attempt: AidenBotGeneratedAvatarDeleteAttempt
            if let retained = deleteAttempt, retained.context == context {
                await reconcileRevert(attempt: retained, generation: generation)
                guard deleteAttempt == retained,
                      isCurrent(context, generation: generation),
                      authoritativeBot.map(aidenBotAvatarExpectedRevision)
                        == retained.expectedRevision else { return }
                attempt = retained
            } else {
                let fresh = try await refreshAuthoritativeBeforeMutation(
                    client: client,
                    context: context,
                    generation: generation
                )
                guard activeMutationToken == mutationToken,
                      fresh.health == .ready, fresh.avatar.asset != nil,
                      isCurrent(context, generation: generation) else {
                    throw AidenBotGeneratedAvatarError.unavailable
                }
                guard fresh.avatar.asset?.assetRevision == observedAssetRevision else {
                    phase = .idle
                    errorMessage = "The Bot photo changed on your paired desktop. Review it before removing it."
                    return
                }
                attempt = .init(
                    context: context,
                    botID: botID,
                    expectedRevision: aidenBotAvatarExpectedRevision(fresh)
                )
            }
            deleteAttempt = attempt
            sentAttempt = attempt
            phase = .reverting
            errorMessage = nil
            let canonical = try await client.deleteBotAvatar(
                botId: botID,
                revision: attempt.expectedRevision
            )
            guard canonical.avatar.asset == nil else {
                throw AidenRemoteClientError.invalidResponse
            }
            try await finishRevert(canonical, attempt: attempt, generation: generation)
        } catch is CancellationError {
            if let sentAttempt {
                await reconcileRevert(attempt: sentAttempt, generation: generation)
            } else if isCurrent(context, generation: generation) {
                phase = .idle
            }
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) {
                clearAllRasterState()
                return
            }
            if let sentAttempt {
                await reconcileRevert(attempt: sentAttempt, generation: generation)
                if !aidenBotAvatarMutationFailureIsAmbiguous(error),
                   deleteAttempt == sentAttempt {
                    deleteAttempt = nil
                }
            } else if isCurrent(context, generation: generation) {
                phase = .idle
                errorMessage = "Aiden refreshed this Bot before changing its photo. Review it, then try again."
            }
        }
    }

    func clearForDismissal() {
        clearAllRasterState()
    }

    private func beginCandidateOperation() -> UInt {
        operationGeneration &+= 1
        let generation = operationGeneration
        candidateBytes = nil
        candidateImage = nil
        uploadAttempt = nil
        phase = .normalizing
        errorMessage = nil
        return generation
    }

    private func finishCandidateIngestion(_ data: Data, generation: UInt) async throws {
        let normalized = try await Task.detached(priority: .userInitiated) {
            try AidenBotGeneratedAvatarNormalizer.normalize(data)
        }.value
        try Task.checkCancellation()
        guard operationGeneration == generation,
              let image = UIImage(data: normalized) else { return }
        candidateBytes = normalized
        candidateImage = image
        uploadAttempt = nil
        phase = .ready
    }

    private func failCandidateIngestion(
        _ error: AidenBotGeneratedAvatarError,
        generation: UInt
    ) {
        guard operationGeneration == generation else { return }
        candidateBytes = nil
        candidateImage = nil
        uploadAttempt = nil
        phase = .failed
        errorMessage = error.localizedDescription
    }

    private func finishUpload(
        attempt: AidenBotGeneratedAvatarUploadAttempt,
        expectedAsset: AidenBotAvatarAsset,
        candidate: Data,
        client: AidenRemoteClient,
        generation: UInt
    ) async throws {
        let detail = try await client.bot(id: botID)
        guard detail.avatar.asset == expectedAsset else {
            throw AidenRemoteClientError.invalidResponse
        }
        let content = try await client.botAvatar(
            botId: botID,
            assetRevision: expectedAsset.assetRevision
        )
        guard expectedAsset.byteSize == content.data.count,
              AidenBotGeneratedAvatarNormalizer.representsSameImage(candidate, content.data),
              isCurrent(attempt.context, generation: generation),
              uploadAttempt == attempt else {
            throw AidenRemoteClientError.invalidResponse
        }
        await publishCanonical(detail: detail, content: content, context: attempt.context)
        guard isCurrent(attempt.context, generation: generation), uploadAttempt == attempt else { return }
        candidateBytes = nil
        candidateImage = nil
        uploadAttempt = nil
        deleteAttempt = nil
        phase = .idle
        errorMessage = nil
        onChanged(detail)
    }

    private func reconcileUpload(
        attempt: AidenBotGeneratedAvatarUploadAttempt,
        candidate: Data,
        generation: UInt
    ) async {
        guard isCurrent(attempt.context, generation: generation), uploadAttempt == attempt else { return }
        do {
            let client = try coordinator.remoteClient(for: attempt.context)
            let detail = try await client.bot(id: botID)
            guard isCurrent(attempt.context, generation: generation), uploadAttempt == attempt else { return }
            if let asset = detail.avatar.asset {
                let content = try await client.botAvatar(
                    botId: botID,
                    assetRevision: asset.assetRevision
                )
                guard isCurrent(attempt.context, generation: generation), uploadAttempt == attempt else { return }
                if AidenBotGeneratedAvatarNormalizer.representsSameImage(candidate, content.data) {
                    await publishCanonical(detail: detail, content: content, context: attempt.context)
                    guard isCurrent(attempt.context, generation: generation), uploadAttempt == attempt else { return }
                    candidateBytes = nil
                    candidateImage = nil
                    uploadAttempt = nil
                    phase = .idle
                    errorMessage = nil
                    onChanged(detail)
                    return
                }
                await publishCanonical(detail: detail, content: content, context: attempt.context)
            } else {
                authoritativeBot = detail
                currentBytes = nil
                currentImage = nil
            }
            if aidenBotAvatarExpectedRevision(detail) == attempt.expectedRevision {
                // No authoritative change is visible. Keep the exact request
                // identity so a deliberate retry reuses the same key.
                phase = .ready
                errorMessage = "Aiden couldn’t confirm whether the photo was saved. Try again to safely check the same upload."
            } else {
                uploadAttempt = nil
                candidateBytes = nil
                candidateImage = nil
                phase = .idle
                errorMessage = "The Bot photo changed on your paired desktop. Review the current photo before replacing it."
            }
        } catch is CancellationError {
            if isCurrent(attempt.context, generation: generation), uploadAttempt == attempt {
                phase = .ready
                errorMessage = "Aiden couldn’t finish checking the Bot photo. Try again safely."
            }
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: attempt.context) {
                clearAllRasterState()
                return
            }
            guard isCurrent(attempt.context, generation: generation), uploadAttempt == attempt else { return }
            phase = .ready
            errorMessage = "Aiden couldn’t verify which photo reached your paired desktop. Reconnect, then retry this same upload."
        }
    }

    private func finishRevert(
        _ detail: AidenBotDetail,
        attempt: AidenBotGeneratedAvatarDeleteAttempt,
        generation: UInt
    ) async throws {
        guard isCurrent(attempt.context, generation: generation), deleteAttempt == attempt else {
            return
        }
        await removeCachedPhoto(context: attempt.context)
        guard isCurrent(attempt.context, generation: generation), deleteAttempt == attempt else { return }
        authoritativeBot = detail
        currentBytes = nil
        currentImage = nil
        candidateBytes = nil
        candidateImage = nil
        uploadAttempt = nil
        deleteAttempt = nil
        phase = .idle
        errorMessage = nil
        onChanged(detail)
    }

    private func reconcileRevert(
        attempt: AidenBotGeneratedAvatarDeleteAttempt,
        generation: UInt
    ) async {
        guard isCurrent(attempt.context, generation: generation), deleteAttempt == attempt else { return }
        do {
            let client = try coordinator.remoteClient(for: attempt.context)
            let detail = try await client.bot(id: botID)
            guard isCurrent(attempt.context, generation: generation), deleteAttempt == attempt else { return }
            if detail.avatar.asset == nil {
                try await finishRevert(detail, attempt: attempt, generation: generation)
                return
            }
            authoritativeBot = detail
            if let asset = detail.avatar.asset {
                let content = try await client.botAvatar(
                    botId: botID,
                    assetRevision: asset.assetRevision
                )
                guard isCurrent(attempt.context, generation: generation), deleteAttempt == attempt else { return }
                await publishCanonical(detail: detail, content: content, context: attempt.context)
            }
            if aidenBotAvatarExpectedRevision(detail) == attempt.expectedRevision {
                phase = .idle
                errorMessage = "Aiden couldn’t confirm the change. Try again to safely return to the semantic avatar."
            } else {
                deleteAttempt = nil
                phase = .idle
                errorMessage = "The Bot photo changed on your paired desktop. Review it before trying again."
            }
        } catch is CancellationError {
            if isCurrent(attempt.context, generation: generation), deleteAttempt == attempt {
                phase = .idle
                errorMessage = "Aiden couldn’t finish checking the Bot photo. Try again safely."
            }
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: attempt.context) {
                clearAllRasterState()
                return
            }
            guard isCurrent(attempt.context, generation: generation), deleteAttempt == attempt else { return }
            phase = .idle
            errorMessage = "Aiden couldn’t verify the Bot photo. Reconnect before trying again."
        }
    }

    private func loadCanonicalPhoto(
        detail: AidenBotDetail,
        client: AidenRemoteClient,
        context: AidenRemoteRequestContext,
        generation: UInt,
        loadAttempt: AidenBotGeneratedAvatarLoadAttempt? = nil
    ) async throws {
        guard let asset = detail.avatar.asset else {
            currentBytes = nil
            currentImage = nil
            return
        }
        if let cached = await cache.avatar(
            instanceId: context.instanceId,
            deviceId: context.deviceId,
            botId: botID,
            assetRevision: asset.assetRevision
        ), isCurrent(context, generation: generation),
           loadAttempt.map(isCurrent) ?? true,
           let image = UIImage(data: cached) {
            currentBytes = cached
            currentImage = image
            return
        }
        let content = try await client.botAvatar(botId: botID, assetRevision: asset.assetRevision)
        guard content.assetRevision == asset.assetRevision,
              isCurrent(context, generation: generation),
              loadAttempt.map(isCurrent) ?? true else {
            throw AidenRemoteClientError.invalidResponse
        }
        await publishCanonical(
            detail: detail,
            content: content,
            context: context,
            loadAttempt: loadAttempt
        )
    }

    private func refreshAuthoritativeBeforeMutation(
        client: AidenRemoteClient,
        context: AidenRemoteRequestContext,
        generation: UInt
    ) async throws -> AidenBotDetail {
        let detail = try await client.bot(id: botID)
        guard isCurrent(context, generation: generation) else {
            throw AidenRemoteClientError.installationChanged
        }
        let previousAssetRevision = authoritativeBot?.avatar.asset?.assetRevision
        authoritativeBot = detail
        if detail.avatar.asset?.assetRevision != previousAssetRevision {
            if detail.avatar.asset == nil {
                await removeCachedPhoto(context: context)
                guard isCurrent(context, generation: generation) else {
                    throw AidenRemoteClientError.installationChanged
                }
                currentBytes = nil
                currentImage = nil
            } else {
                try await loadCanonicalPhoto(
                    detail: detail,
                    client: client,
                    context: context,
                    generation: generation
                )
            }
        }
        guard isCurrent(context, generation: generation) else {
            throw AidenRemoteClientError.installationChanged
        }
        return detail
    }

    private func publishCanonical(
        detail: AidenBotDetail,
        content: AidenBotAvatarContent,
        context: AidenRemoteRequestContext,
        loadAttempt: AidenBotGeneratedAvatarLoadAttempt? = nil
    ) async {
        guard coordinator.isCurrent(context), detail.id == botID,
              detail.avatar.asset?.assetRevision == content.assetRevision,
              detail.avatar.asset?.byteSize == content.data.count,
              loadAttempt.map(isCurrent) ?? true,
              let image = UIImage(data: content.data) else { return }
        authoritativeBot = detail
        currentBytes = content.data
        currentImage = image
        _ = await coordinator.withRetainedInstallationData(for: context) {
            _ = try? await cache.storeAvatar(
                content,
                botId: botID,
                instanceId: context.instanceId,
                deviceId: context.deviceId
            )
        }
        guard loadAttempt.map(isCurrent) ?? true else { return }
    }

    private func removeCachedPhoto(context: AidenRemoteRequestContext) async {
        _ = await coordinator.withRetainedInstallationData(for: context) {
            await cache.removeAvatars(
                instanceId: context.instanceId,
                deviceId: context.deviceId,
                botId: botID
            )
        }
    }

    private func isCurrent(_ context: AidenRemoteRequestContext, generation: UInt) -> Bool {
        operationGeneration == generation
            && capturedContext == context
            && coordinator.isCurrent(context)
    }

    private func isCurrent(_ attempt: AidenBotGeneratedAvatarLoadAttempt) -> Bool {
        activeLoadAttempt == attempt
            && isCurrent(attempt.context, generation: attempt.operationGeneration)
    }

    private func clearAllRasterState() {
        operationGeneration &+= 1
        authoritativeBot = nil
        currentBytes = nil
        currentImage = nil
        candidateBytes = nil
        candidateImage = nil
        capturedContext = nil
        uploadAttempt = nil
        deleteAttempt = nil
        activeLoadAttempt = nil
        activeMutationToken = nil
        errorMessage = nil
        phase = .idle
    }
}

/// Small integration surface for the existing Bot editor/profile. Image
/// Playground presentation stays in its availability-isolated wrapper; this
/// view owns only accepted-image preview and authenticated lifecycle actions.
struct AidenBotGeneratedAvatarLifecycleView: View {
    @Bindable var model: AidenBotGeneratedAvatarModel
    let semanticAvatar: AidenBotSemanticAvatar
    let botName: String
    @State private var isConfirmingRevert = false
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 16) {
                avatarPreview
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.hasCandidate ? "Preview" : "Bot photo")
                        .font(.headline)
                    Text(statusCopy)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if model.isBusy {
                ProgressView(progressCopy)
            }

            if model.hasCandidate {
                HStack {
                    Button("Cancel") { model.cancelCandidate() }
                    Spacer()
                    Button("Use this image") {
                        Task { await model.useCandidate() }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(palette.accent)
                    .foregroundStyle(palette.onAccent)
                    .disabled(!model.canUseCandidate)
                }
            } else if model.hasGeneratedAvatar {
                Button("Use semantic avatar", role: .destructive) {
                    isConfirmingRevert = true
                }
                .disabled(!model.canRevert)
            }

            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(palette.danger)
                    .accessibilityLabel("Bot photo error: \(errorMessage)")
            }
        }
        .task(id: model.sessionIdentity) {
            await model.sessionDidChangeAndRefresh()
        }
        .onDisappear { model.clearForDismissal() }
        .confirmationDialog(
            "Return to the semantic avatar?",
            isPresented: $isConfirmingRevert,
            titleVisibility: .visible
        ) {
            Button("Use semantic avatar", role: .destructive) {
                Task { await model.revertToSemanticAvatar() }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This removes the generated Bot photo from your paired desktop.")
        }
    }

    @ViewBuilder
    private var avatarPreview: some View {
        if let image = model.displayedImage {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 96, height: 96)
                .clipShape(Circle())
                .accessibilityLabel("\(botName) Bot photo")
        } else {
            AidenBotSemanticAvatarView(
                avatar: semanticAvatar,
                name: botName,
                size: 96
            )
        }
    }

    private var statusCopy: String {
        if model.hasCandidate { return "Only this accepted image will be sent to your paired desktop." }
        if model.hasGeneratedAvatar { return "Saved on your paired desktop." }
        return "Your semantic avatar is always available."
    }

    private var progressCopy: String {
        switch model.phase {
        case .loading: "Loading photo…"
        case .normalizing: "Preparing photo…"
        case .uploading: "Saving photo…"
        case .reverting: "Restoring avatar…"
        case .idle, .ready, .failed: "Working…"
        }
    }
}

private struct AidenBotCanonicalAvatarLoadIdentity: Equatable {
    let instanceID: String?
    let deviceID: String?
    let botID: String
    let assetRevision: String?
    let connection: String

    @MainActor
    init(coordinator: AidenRemoteCoordinator, botID: String, assetRevision: String?) {
        let session = AidenBotGeneratedAvatarSessionIdentity(coordinator: coordinator)
        instanceID = session.instanceID
        deviceID = session.deviceID
        self.botID = botID
        self.assetRevision = assetRevision
        connection = session.connection
    }
}

struct AidenBotCanonicalAvatarCacheKey: Hashable {
    let instanceID: String
    let deviceID: String
    let botID: String
    let assetRevision: String
}

/// Keeps already-decoded canonical photos stable across SwiftUI view
/// reconstruction. The immutable asset revision is part of the key, so an
/// avatar changes only when the Mac publishes a new canonical revision.
@MainActor
private final class AidenBotCanonicalAvatarMemoryCache {
    static let shared = AidenBotCanonicalAvatarMemoryCache()

    private let maximumCount = 64
    private var images: [AidenBotCanonicalAvatarCacheKey: UIImage] = [:]
    private var recency: [AidenBotCanonicalAvatarCacheKey] = []

    func image(for key: AidenBotCanonicalAvatarCacheKey) -> UIImage? {
        guard let image = images[key] else { return nil }
        touch(key)
        return image
    }

    func insert(_ image: UIImage, for key: AidenBotCanonicalAvatarCacheKey) {
        images[key] = image
        touch(key)
        while recency.count > maximumCount, let oldest = recency.first {
            recency.removeFirst()
            images.removeValue(forKey: oldest)
        }
    }

    private func touch(_ key: AidenBotCanonicalAvatarCacheKey) {
        recency.removeAll { $0 == key }
        recency.append(key)
    }
}

/// Drop-in avatar renderer for Bot home/profile/chat rows. It paints the
/// semantic identity immediately, then overlays only canonical bytes scoped to
/// the exact installation, pairing device, Bot, and immutable asset revision.
struct AidenBotCanonicalAvatarView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let botID: String
    let avatar: AidenBotAvatarView
    let name: String
    let size: CGFloat
    var isDecorative = true

    @State private var canonicalImage: UIImage?
    @State private var loadedCacheKey: AidenBotCanonicalAvatarCacheKey?

    private var loadIdentity: AidenBotCanonicalAvatarLoadIdentity {
        AidenBotCanonicalAvatarLoadIdentity(
            coordinator: coordinator,
            botID: botID,
            assetRevision: avatar.asset?.assetRevision
        )
    }

    var body: some View {
        ZStack {
            AidenBotSemanticAvatarView(
                avatar: avatar.semantic,
                name: name,
                size: size,
                isDecorative: isDecorative
            )
            if let canonicalImage {
                Image(uiImage: canonicalImage)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(Circle())
                    .accessibilityHidden(isDecorative)
                    .accessibilityLabel(isDecorative ? "" : "\(name) Bot photo")
            }
        }
        .frame(width: size, height: size)
        .task(id: loadIdentity) {
            await loadCanonicalImage(expected: loadIdentity)
        }
    }

    @MainActor
    private func loadCanonicalImage(expected: AidenBotCanonicalAvatarLoadIdentity) async {
        guard let asset = avatar.asset,
              let instanceID = expected.instanceID,
              let deviceID = expected.deviceID else {
            canonicalImage = nil
            loadedCacheKey = nil
            return
        }
        let cacheKey = AidenBotCanonicalAvatarCacheKey(
            instanceID: instanceID,
            deviceID: deviceID,
            botID: botID,
            assetRevision: asset.assetRevision
        )
        if loadedCacheKey == cacheKey, canonicalImage != nil { return }
        if let cachedImage = AidenBotCanonicalAvatarMemoryCache.shared.image(for: cacheKey) {
            canonicalImage = cachedImage
            loadedCacheKey = cacheKey
            return
        }
        if loadedCacheKey != cacheKey {
            canonicalImage = nil
            loadedCacheKey = nil
        }
        if let cached = await AidenBotCache.shared.avatar(
            instanceId: instanceID,
            deviceId: deviceID,
            botId: botID,
            assetRevision: asset.assetRevision
        ), loadIdentity == expected, !Task.isCancelled,
           let image = UIImage(data: cached) {
            AidenBotCanonicalAvatarMemoryCache.shared.insert(image, for: cacheKey)
            canonicalImage = image
            loadedCacheKey = cacheKey
            return
        }
        guard expected.connection == "connected" else { return }
        var context: AidenRemoteRequestContext?
        do {
            let captured = try coordinator.requestContext(for: instanceID)
            context = captured
            guard captured.deviceId == deviceID, coordinator.isCurrent(captured) else { return }
            let content = try await coordinator.remoteClient(for: captured).botAvatar(
                botId: botID,
                assetRevision: asset.assetRevision
            )
            guard content.assetRevision == asset.assetRevision,
                  content.data.count == asset.byteSize,
                  coordinator.isCurrent(captured), loadIdentity == expected,
                  !Task.isCancelled, let image = UIImage(data: content.data) else { return }
            AidenBotCanonicalAvatarMemoryCache.shared.insert(image, for: cacheKey)
            canonicalImage = image
            loadedCacheKey = cacheKey
            _ = await coordinator.withRetainedInstallationData(for: captured) {
                _ = try? await AidenBotCache.shared.storeAvatar(
                    content,
                    botId: botID,
                    instanceId: instanceID,
                    deviceId: deviceID
                )
            }
            guard coordinator.isCurrent(captured), loadIdentity == expected else {
                canonicalImage = nil
                loadedCacheKey = nil
                return
            }
        } catch is CancellationError {
            return
        } catch {
            if let context, coordinator.isCurrent(context) {
                _ = await coordinator.handleCredentialRevocation(error, context: context)
            }
            guard loadIdentity == expected else { return }
            canonicalImage = nil
            loadedCacheKey = nil
        }
    }
}
