import Foundation

/// Device-local memory of the last provider, model and thinking level the user
/// explicitly chose in a Workspace chat composer, kept separately for each
/// paired Mac. Only opaque catalog identifiers are stored — never prompts,
/// credentials or chat content — and the entry is purged with the pairing.
///
/// The stored choice is a preference, not an authority: callers validate it
/// against the host's current model inventory before using it.
final class AidenModelPreferenceStore: @unchecked Sendable {
    static let shared = AidenModelPreferenceStore()

    private struct Entry: Codable, Equatable {
        let providerId: String
        let modelId: String
        let thinkingLevel: String?
    }

    private struct Snapshot: Codable {
        var version = 1
        var selections: [String: Entry] = [:]
    }

    private static let snapshotKey = "aiden.model-preference.v1"
    private static let maximumSnapshotBytes = 262_144
    private static let maximumIDLength = 256
    private let defaults: UserDefaults
    private let lock = NSLock()
    private var snapshot: Snapshot

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.snapshotKey),
           data.count <= Self.maximumSnapshotBytes,
           let decoded = try? JSONDecoder().decode(Snapshot.self, from: data),
           decoded.version == 1 {
            snapshot = Snapshot(selections: decoded.selections.filter { instanceID, entry in
                Self.isSafeID(instanceID) && Self.isSafeID(entry.providerId) && Self.isSafeID(entry.modelId)
                    && (entry.thinkingLevel.map(Self.isSafeID) ?? true)
            })
        } else {
            snapshot = Snapshot()
        }
    }

    func selection(for instanceID: String) -> AidenChatModelSelection? {
        lock.lock()
        defer { lock.unlock() }
        guard Self.isSafeID(instanceID), let entry = snapshot.selections[instanceID] else { return nil }
        return AidenChatModelSelection(
            providerId: entry.providerId,
            modelId: entry.modelId,
            thinkingLevel: entry.thinkingLevel
        )
    }

    func remember(_ selection: AidenChatModelSelection, for instanceID: String) {
        guard Self.isSafeID(instanceID),
              let providerId = selection.providerId, Self.isSafeID(providerId),
              let modelId = selection.modelId, Self.isSafeID(modelId) else { return }
        let entry = Entry(
            providerId: providerId,
            modelId: modelId,
            thinkingLevel: selection.thinkingLevel.flatMap { Self.isSafeID($0) ? $0 : nil }
        )
        lock.lock()
        defer { lock.unlock() }
        guard snapshot.selections[instanceID] != entry else { return }
        snapshot.selections[instanceID] = entry
        persistLocked()
    }

    func purge(instanceID: String) {
        lock.lock()
        defer { lock.unlock() }
        guard snapshot.selections.removeValue(forKey: instanceID) != nil else { return }
        persistLocked()
    }

    private func persistLocked() {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: Self.snapshotKey)
    }

    private static func isSafeID(_ value: String) -> Bool {
        !value.isEmpty && value.count <= maximumIDLength
            && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }
}
