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

/// Reads whether Apple's Image Playground can run here with Aiden's
/// non-personalized styles (iOS 18.4 or later on a supported device).
struct AidenBotImagePlaygroundSupportReader<Content: View>: View {
    @ViewBuilder let content: (Bool) -> Content

    var body: some View {
        if #available(iOS 18.4, *) {
            AidenBotImagePlaygroundSupportProbe(content: content)
        } else {
            content(false)
        }
    }
}

@available(iOS 18.4, *)
private struct AidenBotImagePlaygroundSupportProbe<Content: View>: View {
    @Environment(\.supportsImagePlayground) private var supportsImagePlayground
    let content: (Bool) -> Content

    var body: some View { content(supportsImagePlayground) }
}

extension View {
    /// Presents Apple's Image Playground for a Bot photo. The accepted image is
    /// copied into an app-owned file before the system URL expires; the
    /// receiver owns that copy and must remove it with the candidate store.
    func aidenBotImagePlaygroundSheet(
        isPresented: Binding<Bool>,
        identity: AidenBotImagePlaygroundIdentity,
        candidateStore: AidenBotImagePlaygroundCandidateStore = .init(),
        onCandidateCopied: @escaping (URL) -> Void,
        onCopyFailed: @escaping () -> Void
    ) -> some View {
        modifier(AidenBotImagePlaygroundSheetModifier(
            isPresented: isPresented,
            identity: identity,
            candidateStore: candidateStore,
            onCandidateCopied: onCandidateCopied,
            onCopyFailed: onCopyFailed
        ))
    }
}

private struct AidenBotImagePlaygroundSheetModifier: ViewModifier {
    @Binding var isPresented: Bool
    let identity: AidenBotImagePlaygroundIdentity
    let candidateStore: AidenBotImagePlaygroundCandidateStore
    let onCandidateCopied: (URL) -> Void
    let onCopyFailed: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.4, *) {
            content
                .imagePlaygroundSheet(
                    isPresented: $isPresented,
                    concepts: identity.conceptTexts.map(ImagePlaygroundConcept.text),
                    onCompletion: { temporaryURL in
                        do {
                            onCandidateCopied(
                                try candidateStore.copyImmediately(fromSystemCompletionURL: temporaryURL)
                            )
                        } catch {
                            onCopyFailed()
                        }
                    },
                    onCancellation: { }
                )
                .imagePlaygroundGenerationStyle(
                    .illustration,
                    in: [.animation, .illustration, .sketch]
                )
                .imagePlaygroundPersonalizationPolicy(.disabled)
                .task {
                    // Retry launch cleanup once visible, in case protected
                    // temporary files were inaccessible while locked.
                    candidateStore.removeAllOwnedCandidates()
                }
        } else {
            content
        }
    }
}
