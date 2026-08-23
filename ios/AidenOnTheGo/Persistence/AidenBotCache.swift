import CryptoKit
import Foundation
import ImageIO

/// The bounded offline projection for one paired Mac. Credentials, private
/// paths, capability secrets, image bytes, and conversation history are never
/// members of this envelope.
struct AidenBotCacheSnapshot: Codable, Equatable, Sendable {
    var list: AidenBotList?
    var details: [AidenBotDetail]
    var conversations: AidenBotConversationPage?
    var catalog: AidenBotCapabilityCatalog?
    var notice: AidenBotNoticeStatus?
    var savedAt: Date

    init(
        list: AidenBotList? = nil,
        details: [AidenBotDetail] = [],
        conversations: AidenBotConversationPage? = nil,
        catalog: AidenBotCapabilityCatalog? = nil,
        notice: AidenBotNoticeStatus? = nil,
        savedAt: Date = Date()
    ) {
        self.list = list
        self.details = details
        self.conversations = conversations
        self.catalog = catalog
        self.notice = notice
        self.savedAt = savedAt
    }
}

/// Device-local Bot cache isolated by public installation identity.
///
/// Every async refresh captures an Activation. Selecting A, then B, then A
/// creates three different generations, so completion from the first A cannot
/// publish into the later A activation merely because the instance ID matches.
actor AidenBotCache {
    struct Activation: Equatable, Hashable, Sendable {
        fileprivate let instanceId: String
        fileprivate let deviceId: String
        fileprivate let generation: UInt64
    }

    static let shared = AidenBotCache()

    private struct Envelope: Codable {
        let version: Int
        let instanceId: String
        let deviceId: String
        let snapshot: AidenBotCacheSnapshot
    }

    private let root: URL
    private let fileManager: FileManager
    private let maximumEnvelopeBytes = 4 * 1_024 * 1_024
    private let maximumAvatarBytes = 4 * 1_048_576
    private var selectedInstanceId: String?
    private var selectedDeviceId: String?
    private var generation: UInt64 = 0

    init(root: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        if let root {
            self.root = root
        } else {
            let applicationSupport = fileManager.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first ?? fileManager.temporaryDirectory
            self.root = applicationSupport
                .appending(path: "AidenOnTheGo", directoryHint: .isDirectory)
                .appending(path: "RemoteBotCache-v1", directoryHint: .isDirectory)
        }
    }

    @discardableResult
    func activate(instanceId: String, deviceId: String) -> Activation {
        generation &+= 1
        selectedInstanceId = instanceId
        selectedDeviceId = deviceId
        return Activation(instanceId: instanceId, deviceId: deviceId, generation: generation)
    }

    func deactivate() {
        generation &+= 1
        selectedInstanceId = nil
        selectedDeviceId = nil
    }

    func isCurrent(_ activation: Activation) -> Bool {
        selectedInstanceId == activation.instanceId
            && selectedDeviceId == activation.deviceId
            && generation == activation.generation
    }

    func load(instanceId: String, deviceId: String) -> AidenBotCacheSnapshot? {
        let url = snapshotURL(instanceId: instanceId, deviceId: deviceId)
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber,
              size.intValue <= maximumEnvelopeBytes,
              let data = try? Data(contentsOf: url, options: [.mappedIfSafe]),
              data.count <= maximumEnvelopeBytes,
              let envelope = try? JSONDecoder.aidenRemote().decode(Envelope.self, from: data),
              envelope.version == 1,
              envelope.instanceId == instanceId,
              envelope.deviceId == deviceId,
              Self.isValid(envelope.snapshot) else {
            return nil
        }
        return envelope.snapshot
    }

    /// Returns false without touching disk when the captured activation is
    /// stale. Callers should silently discard that network completion.
    @discardableResult
    func store(_ snapshot: AidenBotCacheSnapshot, activation: Activation) throws -> Bool {
        guard isCurrent(activation), Self.isValid(snapshot) else { return false }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(Envelope(
            version: 1,
            instanceId: activation.instanceId,
            deviceId: activation.deviceId,
            snapshot: snapshot
        ))
        guard data.count <= maximumEnvelopeBytes else {
            throw CocoaError(.fileWriteOutOfSpace)
        }
        let url = snapshotURL(instanceId: activation.instanceId, deviceId: activation.deviceId)
        try createProtectedDirectory(url.deletingLastPathComponent())
        guard isCurrent(activation) else { return false }
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return true
    }

    func avatar(
        instanceId: String,
        deviceId: String,
        botId: String,
        assetRevision: String
    ) -> Data? {
        let url = avatarURL(
            instanceId: instanceId,
            deviceId: deviceId,
            botId: botId,
            assetRevision: assetRevision
        )
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber,
              size.intValue <= maximumAvatarBytes,
              let data = try? Data(contentsOf: url, options: [.mappedIfSafe]),
              Self.isCanonicalAvatar(data) else {
            try? fileManager.removeItem(at: url)
            return nil
        }
        return data
    }

    @discardableResult
    func storeAvatar(
        _ content: AidenBotAvatarContent,
        botId: String,
        activation: Activation
    ) throws -> Bool {
        guard isCurrent(activation), Self.isCanonicalAvatar(content.data) else { return false }
        let url = avatarURL(
            instanceId: activation.instanceId,
            deviceId: activation.deviceId,
            botId: botId,
            assetRevision: content.assetRevision
        )
        try createProtectedDirectory(url.deletingLastPathComponent())
        guard isCurrent(activation) else { return false }
        try content.data.write(
            to: url,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        pruneAvatars(preserving: url)
        return true
    }

    /// Stores immutable canonical avatar bytes under an exact pairing scope
    /// without changing the shared cache activation generation. Callers must
    /// hold `AidenRemoteCoordinator.withRetainedInstallationData` while using
    /// this entry point so revocation/pairing removal cannot race the write.
    @discardableResult
    func storeAvatar(
        _ content: AidenBotAvatarContent,
        botId: String,
        instanceId: String,
        deviceId: String
    ) throws -> Bool {
        guard Self.isCanonicalAvatar(content.data) else { return false }
        let url = avatarURL(
            instanceId: instanceId,
            deviceId: deviceId,
            botId: botId,
            assetRevision: content.assetRevision
        )
        try createProtectedDirectory(url.deletingLastPathComponent())
        try content.data.write(
            to: url,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        pruneAvatars(preserving: url)
        return true
    }

    /// Removes every cached generated photo for one Bot in one exact pairing.
    /// The semantic avatar remains available through the ordinary Bot DTO.
    func removeAvatars(instanceId: String, deviceId: String, botId: String) {
        let directory = deviceDirectory(instanceId: instanceId, deviceId: deviceId)
            .appending(path: "avatars", directoryHint: .isDirectory)
            .appending(path: digest(botId), directoryHint: .isDirectory)
        try? fileManager.removeItem(at: directory)
    }

    func purge(instanceId: String) {
        if selectedInstanceId == instanceId {
            generation &+= 1
            selectedInstanceId = nil
            selectedDeviceId = nil
        }
        try? fileManager.removeItem(at: instanceDirectory(instanceId: instanceId))
    }

    private static func isValid(_ snapshot: AidenBotCacheSnapshot) -> Bool {
        let details = snapshot.details
        guard details.count <= 256,
              Set(details.map(\.id)).count == details.count,
              snapshot.savedAt.timeIntervalSince1970.isFinite else {
            return false
        }
        if let list = snapshot.list {
            let listed = Set(list.bots.map(\.id))
            guard details.allSatisfy({ listed.contains($0.id) }) else { return false }
        }
        if let conversations = snapshot.conversations, let list = snapshot.list {
            let listed = Set(list.bots.map(\.id))
            guard conversations.conversations.allSatisfy({ listed.contains($0.botId) }) else {
                return false
            }
        }
        return true
    }

    private static func isCanonicalAvatar(_ data: Data) -> Bool {
        guard !data.isEmpty, data.count <= 4 * 1_048_576, data.count >= 24,
              data.prefix(8).elementsEqual([137, 80, 78, 71, 13, 10, 26, 10]),
              data[12..<16].elementsEqual([73, 72, 68, 82]),
              [UInt8](data.suffix(12)) == [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130],
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetType(source) as String? == "public.png",
              CGImageSourceGetCount(source) == 1,
              CGImageSourceGetStatus(source) == .statusComplete,
              CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              properties[kCGImagePropertyPixelWidth] as? Int == 512,
              properties[kCGImagePropertyPixelHeight] as? Int == 512,
              let pngProperties = properties[kCGImagePropertyPNGDictionary] as? [CFString: Any],
              pngProperties[kCGImagePropertyAPNGLoopCount] == nil,
              pngProperties[kCGImagePropertyAPNGDelayTime] == nil,
              pngProperties[kCGImagePropertyAPNGUnclampedDelayTime] == nil,
              CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: 2,
                  kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) != nil else {
            return false
        }
        return true
    }

    private func createProtectedDirectory(_ url: URL) throws {
        try fileManager.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        var protectedURL = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try protectedURL.setResourceValues(values)
    }

    private func snapshotURL(instanceId: String, deviceId: String) -> URL {
        deviceDirectory(instanceId: instanceId, deviceId: deviceId).appending(path: "snapshot.json")
    }

    private func avatarURL(
        instanceId: String,
        deviceId: String,
        botId: String,
        assetRevision: String
    ) -> URL {
        deviceDirectory(instanceId: instanceId, deviceId: deviceId)
            .appending(path: "avatars", directoryHint: .isDirectory)
            .appending(path: digest(botId), directoryHint: .isDirectory)
            .appending(path: "\(digest(assetRevision)).png")
    }

    private func instanceDirectory(instanceId: String) -> URL {
        root.appending(path: digest(instanceId), directoryHint: .isDirectory)
    }

    private func deviceDirectory(instanceId: String, deviceId: String) -> URL {
        instanceDirectory(instanceId: instanceId)
            .appending(path: digest(deviceId), directoryHint: .isDirectory)
    }

    private func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func pruneAvatars(preserving: URL) {
        let directory = preserving.deletingLastPathComponent()
        let files = (try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )) ?? []
        for file in files where file.standardizedFileURL != preserving.standardizedFileURL {
            try? fileManager.removeItem(at: file)
        }
    }
}
