import CryptoKit
import Foundation
import SwiftUI

// MARK: - Contract (revision 35, `chat-visual-viewer-v1`)

/// The light or dark page the Mac draws for the viewer.
enum AidenVisualViewerScheme: String, Hashable, Sendable {
    case light
    case dark

    init(_ colorScheme: ColorScheme) {
        self = colorScheme == .dark ? .dark : .light
    }
}

/// The phone's scheme and theme preset, sent as the document's query.
struct AidenVisualViewerAppearance: Hashable, Sendable {
    let scheme: AidenVisualViewerScheme
    let theme: AidenThemePresetID
}

/// The closed set of messages a viewer page may post on the `aidenVisual`
/// channel. Anything else, including a known type with a malformed field, is
/// ignored.
enum AidenVisualViewerMessage: Equatable, Sendable {
    /// The visual has drawn; the loading indicator can go.
    case ready
    /// A follow-up the visual suggests. It is only ever added to the composer
    /// after the person confirms; it is never sent by itself.
    case prompt(String)
    /// An https link the person is asked about before it opens.
    case openURL(URL)

    static let handlerName = "aidenVisual"
    static let maximumPromptCharacters = 2_000
    static let maximumURLLength = 2_048

    static func parse(_ body: Any) -> AidenVisualViewerMessage? {
        guard let object = body as? [String: Any],
              let type = object["type"] as? String else { return nil }
        switch type {
        case "ready":
            return .ready
        case "prompt":
            guard let raw = object["text"] as? String,
                  raw.utf16.count <= maximumPromptCharacters * 4 else { return nil }
            let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, text.count <= maximumPromptCharacters else { return nil }
            return .prompt(text)
        case "openUrl":
            guard let raw = object["url"] as? String,
                  let url = externalURL(raw) else { return nil }
            return .openURL(url)
        default:
            return nil
        }
    }

    /// An absolute https URL with a host and no user info, or nil.
    static func externalURL(_ raw: String) -> URL? {
        guard !raw.isEmpty, raw.utf8.count <= maximumURLLength,
              !raw.unicodeScalars.contains(where: { scalar in
                  scalar.properties.isWhitespace
                      || scalar.properties.generalCategory == .control
                      || scalar.properties.generalCategory == .format
              }),
              let components = URLComponents(string: raw),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil,
              components.password == nil,
              let url = components.url else { return nil }
        return url
    }

    /// The composer draft after "Add to message": the prompt goes after any
    /// text already there, separated by a blank line.
    static func draft(appending prompt: String, to draft: String) -> String {
        var existing = draft
        while let last = existing.last, last.isWhitespace { existing.removeLast() }
        return existing.isEmpty ? prompt : existing + "\n\n" + prompt
    }
}

/// Allows only the document the viewer loads itself (`about:blank` from
/// `loadHTMLString(_:baseURL: nil)`) and the visual's own `about:srcdoc` or
/// `about:blank` frames. Every other navigation, and every new window, is
/// cancelled.
struct AidenVisualNavigationPolicy: Equatable, Sendable {
    private(set) var hasLoadedDocument = false

    /// `targetIsMainFrame` is nil when the navigation would open a new window.
    mutating func allows(url: URL?, targetIsMainFrame: Bool?) -> Bool {
        guard let targetIsMainFrame, let url else { return false }
        let address = url.absoluteString
        if targetIsMainFrame {
            guard !hasLoadedDocument, address == "about:blank" else { return false }
            hasLoadedDocument = true
            return true
        }
        return address == "about:blank" || address == "about:srcdoc"
    }
}

/// How the viewer got its page.
enum AidenVisualDocumentLoad: Sendable {
    /// Fresh from the Mac.
    case live(String)
    /// The Mac could not answer; this is the last copy the phone saw.
    case cached(String)
    /// Nothing to show; the message says why.
    case failed(String)

    /// A cached copy stands in only when the Mac could not be reached or
    /// failed. An answer that the visual is gone, the request is invalid, or
    /// the device is no longer allowed is shown as it is.
    static func fallsBackToCache(after error: Error) -> Bool {
        if error is URLError { return true }
        switch error as? AidenRemoteClientError {
        case .server(let statusCode, _)?:
            return statusCode >= 500
        case .unexpectedStatus(let statusCode)?:
            return statusCode >= 500
        default:
            return false
        }
    }

    static func failureMessage(for error: Error) -> String {
        if error is URLError {
            return String(localized: "Can't reach your Mac. Check the connection and try again.")
        }
        switch error as? AidenRemoteClientError {
        case .server(404, _)?:
            return String(localized: "This visual is no longer available on your Mac.")
        case .missingCredential?, .installationChanged?:
            return String(localized: "This visual can't be opened right now.")
        default:
            return String(localized: "Aiden Agent couldn't open this visual.")
        }
    }
}

/// What tapping a visual's row does.
enum AidenVisualRowAction: Equatable, Sendable {
    /// The Mac announces `chat-visual-viewer-v1`: open the visual full screen.
    case openInteractive
    /// Older Macs: the snapshot opens in the image viewer.
    case viewImage
    /// No snapshot and no viewer: the row only shows text.
    case textOnly

    static func resolve(viewerAvailable: Bool, hasSnapshot: Bool) -> AidenVisualRowAction {
        if viewerAvailable { return .openInteractive }
        return hasSnapshot ? .viewImage : .textOnly
    }
}

// MARK: - Offline cache

/// The last viewer document per host, device, chat, visual, scheme and theme,
/// in the app's caches directory. File names are SHA-256 digests, so no id
/// reaches the file system. At most `maximumFiles` documents and
/// `maximumBytes` in all; the least recently used go first.
actor AidenVisualDocumentCache {
    struct Key: Hashable, Sendable {
        let instanceId: String
        let deviceId: String
        let chatId: String
        let visualId: String
        let appearance: AidenVisualViewerAppearance

        var fileName: String {
            let parts = [
                instanceId,
                deviceId,
                chatId,
                visualId,
                appearance.scheme.rawValue,
                appearance.theme.rawValue,
            ]
            return AidenVisualDocumentCache.digest(parts.joined(separator: "\u{1f}")) + ".html"
        }
    }

    static let shared = AidenVisualDocumentCache()
    static let defaultMaximumFiles = 20
    static let defaultMaximumBytes = 40 * 1_048_576

    private let root: URL
    private let maximumFiles: Int
    private let maximumBytes: Int
    private let fileManager: FileManager
    private let now: @Sendable () -> Date

    init(
        root: URL? = nil,
        maximumFiles: Int = AidenVisualDocumentCache.defaultMaximumFiles,
        maximumBytes: Int = AidenVisualDocumentCache.defaultMaximumBytes,
        fileManager: FileManager = .default,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.maximumFiles = max(1, maximumFiles)
        self.maximumBytes = max(1, maximumBytes)
        self.fileManager = fileManager
        self.now = now
        if let root {
            self.root = root
        } else {
            let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
                ?? fileManager.temporaryDirectory
            self.root = caches
                .appending(path: "AidenOnTheGo", directoryHint: .isDirectory)
                .appending(path: "VisualDocuments-v1", directoryHint: .isDirectory)
        }
    }

    @discardableResult
    func store(_ html: String, for key: Key) -> Bool {
        let data = Data(html.utf8)
        guard !data.isEmpty,
              data.count <= AidenRemoteProtocol.maxVisualDocumentBytes,
              data.count <= maximumBytes else { return false }
        let directory = instanceDirectory(key.instanceId)
        let url = directory.appending(path: key.fileName)
        do {
            try fileManager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
            )
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            return false
        }
        try? fileManager.setAttributes([.modificationDate: now()], ofItemAtPath: url.path)
        evict(keeping: url)
        return true
    }

    /// The cached document, which then counts as the most recently used.
    func load(_ key: Key) -> String? {
        let url = instanceDirectory(key.instanceId).appending(path: key.fileName)
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
              let size = (attributes[.size] as? NSNumber)?.intValue,
              size > 0, size <= AidenRemoteProtocol.maxVisualDocumentBytes,
              let data = try? Data(contentsOf: url),
              let html = String(data: data, encoding: .utf8) else { return nil }
        try? fileManager.setAttributes([.modificationDate: now()], ofItemAtPath: url.path)
        return html
    }

    /// Whether any document from this paired Mac is saved.
    func hasDocuments(instanceId: String) -> Bool {
        let files = (try? fileManager.contentsOfDirectory(
            at: instanceDirectory(instanceId),
            includingPropertiesForKeys: nil
        )) ?? []
        return files.contains { $0.pathExtension == "html" }
    }

    /// Forgets every document from one paired Mac.
    func purge(instanceId: String) {
        try? fileManager.removeItem(at: instanceDirectory(instanceId))
    }

    static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func instanceDirectory(_ instanceId: String) -> URL {
        root.appending(path: Self.digest(instanceId), directoryHint: .isDirectory)
    }

    private struct Entry {
        let directoryName: String
        let fileName: String
        let url: URL
        let usedAt: Date
        let size: Int
    }

    private func evict(keeping kept: URL) {
        let keptDirectory = kept.deletingLastPathComponent().lastPathComponent
        let keptFile = kept.lastPathComponent
        var entries: [Entry] = []
        let directories = (try? fileManager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for directory in directories {
            let files = (try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
            for file in files {
                guard let attributes = try? fileManager.attributesOfItem(atPath: file.path) else { continue }
                entries.append(Entry(
                    directoryName: directory.lastPathComponent,
                    fileName: file.lastPathComponent,
                    url: file,
                    usedAt: attributes[.modificationDate] as? Date ?? .distantPast,
                    size: (attributes[.size] as? NSNumber)?.intValue ?? 0
                ))
            }
        }
        entries.sort { lhs, rhs in
            lhs.usedAt == rhs.usedAt ? lhs.fileName < rhs.fileName : lhs.usedAt < rhs.usedAt
        }
        var count = entries.count
        var bytes = entries.reduce(0) { $0 + $1.size }
        for entry in entries where count > maximumFiles || bytes > maximumBytes {
            if entry.directoryName == keptDirectory, entry.fileName == keptFile { continue }
            try? fileManager.removeItem(at: entry.url)
            count -= 1
            bytes -= entry.size
        }
    }
}
