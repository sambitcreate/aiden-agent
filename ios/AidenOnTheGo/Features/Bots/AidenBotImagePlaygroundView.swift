import Foundation
import ImagePlayground
import SwiftUI

struct AidenBotImagePlaygroundIdentity: Equatable, Sendable {
    let name: String
    let purpose: String

    init(name: String, purpose: String) {
        self.name = Self.visibleText(name, maximumCharacters: 80)
        self.purpose = Self.visibleText(purpose, maximumCharacters: 240)
    }

    var conceptTexts: [String] {
        [name, purpose].filter { !$0.isEmpty }
    }

    private static func visibleText(_ value: String, maximumCharacters: Int) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return String(trimmed.prefix(maximumCharacters))
    }
}

enum AidenBotImagePlaygroundFallbackReason: Equatable, Sendable {
    // Use a specific case only when the caller directly knows that fact.
    // `supportsImagePlayground == false` always maps to `systemUnavailable`;
    // Aiden does not infer Apple's restriction, model, or usage-limit state.
    case unsupported
    case restricted
    case modelUnavailable
    case usageLimit
    case updateRequired
    case systemUnavailable
    case candidateCopyFailed

    var title: String {
        switch self {
        case .unsupported:
            "Image Playground isn't supported on this device"
        case .restricted:
            "Image creation is restricted"
        case .modelUnavailable:
            "Apple's image model isn't ready"
        case .usageLimit:
            "Image creation is temporarily limited"
        case .updateRequired:
            "Update to create a Bot image"
        case .systemUnavailable:
            "Image Playground isn't available"
        case .candidateCopyFailed:
            "That image couldn't be prepared"
        }
    }

    var message: String {
        switch self {
        case .unsupported:
            "You can keep using the semantic avatar on this device."
        case .restricted:
            "Image Playground may be restricted by device settings. You can keep using the semantic avatar."
        case .modelUnavailable:
            "Apple's image model may still be downloading or may be unavailable. Try again later, or use the semantic avatar."
        case .usageLimit:
            "Apple's image creation limit may have been reached. Try again later, or use the semantic avatar."
        case .updateRequired:
            "Aiden needs iOS or iPadOS 18.4 or later to limit Image Playground to Apple's non-personalized styles. You can keep using the semantic avatar."
        case .systemUnavailable:
            "Apple doesn't currently make Image Playground available on this device. You can keep using the semantic avatar."
        case .candidateCopyFailed:
            "The selected image couldn't be copied into Aiden safely. Choose another image, or use the semantic avatar."
        }
    }
}

struct AidenBotImagePlaygroundPresentationState: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        case ready
        case presenting
        case cancelled
        case accepted
        case fallback(AidenBotImagePlaygroundFallbackReason)
    }

    private(set) var phase: Phase = .ready

    mutating func requestPresentation(systemAvailable: Bool) {
        phase = systemAvailable ? .presenting : .fallback(.systemUnavailable)
    }

    mutating func cancel() {
        phase = .cancelled
    }

    mutating func acceptCopiedCandidate() {
        phase = .accepted
    }

    mutating func failCandidateCopy() {
        phase = .fallback(.candidateCopyFailed)
    }

    mutating func showFallback(_ reason: AidenBotImagePlaygroundFallbackReason) {
        phase = .fallback(reason)
    }
}

enum AidenBotImagePlaygroundCandidateCopyError: Error, Equatable {
    case invalidSource
    case sourceTooLarge
    case copyFailed
}

/// Copies the system-owned completion URL while it is still valid. The copied
/// file is an ephemeral candidate; normalization and paired-Mac upload own its
/// later lifecycle.
struct AidenBotImagePlaygroundCandidateStore {
    // The system result is bounded before decode, then the lifecycle
    // normalizer enforces the tighter 4 MiB canonical upload bound.
    static let maximumSourceBytes = 32 * 1_048_576
    static let maximumRetainedCandidates = 8
    static let staleCandidateAge: TimeInterval = 24 * 60 * 60

    let directory: URL

    init(directory: URL = FileManager.default.temporaryDirectory
        .appending(path: "AidenBotImageCandidates", directoryHint: .isDirectory)) {
        self.directory = directory
    }

    func copyImmediately(fromSystemCompletionURL sourceURL: URL) throws -> URL {
        guard sourceURL.isFileURL else {
            throw AidenBotImagePlaygroundCandidateCopyError.invalidSource
        }
        defer { try? FileManager.default.removeItem(at: sourceURL) }

        let values: URLResourceValues
        do {
            values = try sourceURL.resourceValues(
                forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
            )
        } catch {
            throw AidenBotImagePlaygroundCandidateCopyError.invalidSource
        }
        guard values.isRegularFile == true,
              values.isSymbolicLink != true,
              let byteCount = values.fileSize,
              byteCount > 0 else {
            throw AidenBotImagePlaygroundCandidateCopyError.invalidSource
        }
        guard byteCount <= Self.maximumSourceBytes else {
            throw AidenBotImagePlaygroundCandidateCopyError.sourceTooLarge
        }

        let fileManager = FileManager.default
        let destination = directory.appending(path: "candidate-\(UUID().uuidString).image")
        do {
            try fileManager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [
                    .posixPermissions: 0o700,
                    .protectionKey: FileProtectionType.complete,
                ]
            )
            try pruneOwnedCandidates(now: Date(), retainingAtMost: Self.maximumRetainedCandidates - 1)
            try fileManager.copyItem(at: sourceURL, to: destination)
            let copiedValues = try destination.resourceValues(
                forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
            )
            guard copiedValues.isRegularFile == true,
                  copiedValues.isSymbolicLink != true,
                  let copiedByteCount = copiedValues.fileSize,
                  (1...Self.maximumSourceBytes).contains(copiedByteCount) else {
                throw AidenBotImagePlaygroundCandidateCopyError.invalidSource
            }
            try fileManager.setAttributes(
                [
                    .posixPermissions: 0o600,
                    .protectionKey: FileProtectionType.complete,
                ],
                ofItemAtPath: destination.path
            )
            var resourceValues = URLResourceValues()
            resourceValues.isExcludedFromBackup = true
            var mutableDestination = destination
            try mutableDestination.setResourceValues(resourceValues)
            return destination
        } catch {
            try? fileManager.removeItem(at: destination)
            throw AidenBotImagePlaygroundCandidateCopyError.copyFailed
        }
    }

    func removeOwnedCandidate(at candidateURL: URL) {
        guard Self.isOwnedCandidate(candidateURL, in: directory) else { return }
        try? FileManager.default.removeItem(at: candidateURL)
    }

    func removeAllOwnedCandidates() {
        guard let candidates = try? ownedCandidates() else { return }
        for candidate in candidates {
            try? FileManager.default.removeItem(at: candidate.url)
        }
    }

    func pruneOwnedCandidates(now: Date = Date()) {
        try? pruneOwnedCandidates(now: now, retainingAtMost: Self.maximumRetainedCandidates)
    }

    private func pruneOwnedCandidates(now: Date, retainingAtMost maximumCount: Int) throws {
        let candidates = try ownedCandidates().sorted { $0.modifiedAt > $1.modifiedAt }
        for (index, candidate) in candidates.enumerated()
        where index >= maximumCount || now.timeIntervalSince(candidate.modifiedAt) > Self.staleCandidateAge {
            try? FileManager.default.removeItem(at: candidate.url)
        }
    }

    private func ownedCandidates() throws -> [(url: URL, modifiedAt: Date)] {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: directory.path) else { return [] }
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .contentModificationDateKey]
        return try fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ).compactMap { url in
            guard Self.isOwnedCandidate(url, in: directory) else { return nil }
            let values = try url.resourceValues(forKeys: keys)
            guard values.isRegularFile == true else { return nil }
            return (url, values.contentModificationDate ?? .distantPast)
        }
    }

    private static func isOwnedCandidate(_ url: URL, in directory: URL) -> Bool {
        let name = url.lastPathComponent
        return isDescendant(url, of: directory)
            && name.hasPrefix("candidate-")
            && name.hasSuffix(".image")
    }

    private static func isDescendant(_ url: URL, of directory: URL) -> Bool {
        let candidateComponents = url.standardizedFileURL.pathComponents
        let directoryComponents = directory.standardizedFileURL.pathComponents
        guard candidateComponents.count > directoryComponents.count else { return false }
        return Array(candidateComponents.prefix(directoryComponents.count)) == directoryComponents
    }
}

func aidenBotImagePlaygroundCleanupAfterProcessLaunch(
    candidateStore: AidenBotImagePlaygroundCandidateStore = .init()
) {
    // No accepted candidate survives in memory across a process launch, so
    // every app-owned temporary candidate is crash residue at this boundary.
    candidateStore.removeAllOwnedCandidates()
}

struct AidenBotImagePlaygroundView: View {
    let identity: AidenBotImagePlaygroundIdentity
    let fallbackOverride: AidenBotImagePlaygroundFallbackReason?
    let candidateStore: AidenBotImagePlaygroundCandidateStore
    let onCandidateCopied: (URL) -> Void

    init(
        identity: AidenBotImagePlaygroundIdentity,
        fallbackOverride: AidenBotImagePlaygroundFallbackReason? = nil,
        candidateStore: AidenBotImagePlaygroundCandidateStore = .init(),
        onCandidateCopied: @escaping (URL) -> Void
    ) {
        self.identity = identity
        self.fallbackOverride = fallbackOverride
        self.candidateStore = candidateStore
        self.onCandidateCopied = onCandidateCopied
    }

    // `onCandidateCopied` transfers ownership of the copied URL. Its receiver
    // must remove it after replacement, upload completion, cancellation, or
    // teardown by calling `candidateStore.removeOwnedCandidate(at:)`.

    @ViewBuilder
    var body: some View {
        Group {
            if #available(iOS 18.1, *) {
                AidenBotSystemImagePlaygroundView(
                    identity: identity,
                    fallbackOverride: fallbackOverride,
                    candidateStore: candidateStore,
                    onCandidateCopied: onCandidateCopied
                )
            } else {
                AidenBotImagePlaygroundFallbackView(reason: fallbackOverride ?? .updateRequired)
            }
        }
        .task {
            // Retry launch cleanup when the editor becomes visible in case
            // protected temporary files were inaccessible while locked.
            candidateStore.removeAllOwnedCandidates()
        }
    }
}

@available(iOS 18.1, *)
private struct AidenBotSystemImagePlaygroundView: View {
    let identity: AidenBotImagePlaygroundIdentity
    let fallbackOverride: AidenBotImagePlaygroundFallbackReason?
    let candidateStore: AidenBotImagePlaygroundCandidateStore
    let onCandidateCopied: (URL) -> Void

    @Environment(\.supportsImagePlayground) private var supportsImagePlayground
    @State private var presentation = AidenBotImagePlaygroundPresentationState()

    private var isPresenting: Binding<Bool> {
        Binding(
            get: { presentation.phase == .presenting },
            set: { newValue in
                if !newValue, presentation.phase == .presenting {
                    presentation.cancel()
                }
            }
        )
    }

    private var concepts: [ImagePlaygroundConcept] {
        identity.conceptTexts.map(ImagePlaygroundConcept.text)
    }

    @ViewBuilder
    var body: some View {
        if let fallbackOverride {
            AidenBotImagePlaygroundFallbackView(reason: fallbackOverride)
        } else if #unavailable(iOS 18.4) {
            AidenBotImagePlaygroundFallbackView(reason: .updateRequired)
        } else if !supportsImagePlayground {
            AidenBotImagePlaygroundFallbackView(reason: .systemUnavailable)
        } else {
            configuredSheet
        }
    }

    @available(iOS 18.4, *)
    private var configuredSheet: some View {
        launcherContent
            .imagePlaygroundSheet(
                isPresented: isPresenting,
                concepts: concepts,
                onCompletion: captureCandidate,
                onCancellation: { presentation.cancel() }
            )
            .imagePlaygroundGenerationStyle(
                .illustration,
                in: [.animation, .illustration, .sketch]
            )
            .imagePlaygroundPersonalizationPolicy(.disabled)
    }

    private var launcherContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Create with Apple Intelligence", systemImage: "apple.intelligence")
                .font(.headline)

            Text(Self.processingDisclosure)
                .font(.caption)
                .foregroundStyle(.secondary)

            if case .cancelled = presentation.phase {
                Label("No image was selected. Your semantic avatar is unchanged.", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if case .accepted = presentation.phase {
                Label("The selected image is ready to preview.", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if case let .fallback(reason) = presentation.phase {
                AidenBotImagePlaygroundFallbackView(reason: reason)
            }

            Button {
                presentation.requestPresentation(systemAvailable: supportsImagePlayground)
            } label: {
                Label("Open Image Playground", systemImage: "photo.badge.plus")
            }
            .buttonStyle(.bordered)
            .disabled(presentation.phase == .presenting)
            .accessibilityHint("Opens Apple's system image creation sheet.")
        }
    }

    private func captureCandidate(_ temporaryURL: URL) {
        do {
            let copiedURL = try candidateStore.copyImmediately(fromSystemCompletionURL: temporaryURL)
            presentation.acceptCopiedCandidate()
            onCandidateCopied(copiedURL)
        } catch {
            presentation.failCandidateCopy()
        }
    }

    static let processingDisclosure = "Apple creates images in its system Image Playground. Processing is controlled by Apple and may use Private Cloud Compute. Aiden receives only the image you choose."
}

private struct AidenBotImagePlaygroundFallbackView: View {
    let reason: AidenBotImagePlaygroundFallbackReason

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(reason.title, systemImage: "photo.badge.exclamationmark")
                .font(.headline)
            Text(reason.message)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
