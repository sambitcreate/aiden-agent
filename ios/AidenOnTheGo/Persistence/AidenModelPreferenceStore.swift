import Foundation

/// Device-local memory of the last provider, model and thinking level the user
/// explicitly chose in a new Workspace chat's composer (the choice new chats
/// start with), plus an unsent pick in an existing chat until that chat's next
/// send, kept separately for each paired Mac. Only opaque catalog identifiers
/// are stored — never prompts, credentials or chat content — and the entries
/// are purged with the pairing.
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

    private struct ChatEntry: Codable, Equatable {
        let chatId: String
        let entry: Entry
    }

    private struct Snapshot: Codable {
        var version = 1
        var selections: [String: Entry] = [:]
        /// Unsent picks in existing chats, newest first, per paired Mac.
        var chatSelections: [String: [ChatEntry]]? = nil
    }

    private static let snapshotKey = "aiden.model-preference.v1"
    private static let maximumSnapshotBytes = 262_144
    private static let maximumIDLength = 256
    private static let maximumChatSelections = 50
    private let defaults: UserDefaults
    private let lock = NSLock()
    private var snapshot: Snapshot

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.snapshotKey),
           data.count <= Self.maximumSnapshotBytes,
           let decoded = try? JSONDecoder().decode(Snapshot.self, from: data),
           decoded.version == 1 {
            snapshot = Snapshot(
                selections: decoded.selections.filter { instanceID, entry in
                    Self.isSafeID(instanceID) && Self.isSafe(entry)
                },
                chatSelections: decoded.chatSelections?
                    .filter { instanceID, _ in Self.isSafeID(instanceID) }
                    .mapValues { entries in
                        Array(entries.filter { Self.isSafeID($0.chatId) && Self.isSafe($0.entry) }
                            .prefix(Self.maximumChatSelections))
                    }
                    .filter { !$0.value.isEmpty }
            )
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
        guard Self.isSafeID(instanceID), let entry = Self.entry(selection) else { return }
        lock.lock()
        defer { lock.unlock() }
        guard snapshot.selections[instanceID] != entry else { return }
        var next = snapshot
        next.selections[instanceID] = entry
        persistLocked(next)
    }

    /// The unsent pick in an existing chat, kept so reopening the chat shows it.
    func chatSelection(for instanceID: String, chatID: String) -> AidenChatModelSelection? {
        lock.lock()
        defer { lock.unlock() }
        guard let entry = snapshot.chatSelections?[instanceID]?.first(where: { $0.chatId == chatID })?.entry else {
            return nil
        }
        return AidenChatModelSelection(
            providerId: entry.providerId,
            modelId: entry.modelId,
            thinkingLevel: entry.thinkingLevel
        )
    }

    /// Keeps a pick in an existing chat until that chat's next send. It never
    /// changes the choice new chats start with.
    func rememberChat(_ selection: AidenChatModelSelection, for instanceID: String, chatID: String) {
        guard Self.isSafeID(instanceID), Self.isSafeID(chatID), let entry = Self.entry(selection) else { return }
        lock.lock()
        defer { lock.unlock() }
        let existing = snapshot.chatSelections?[instanceID] ?? []
        let updated = Array(
            ([ChatEntry(chatId: chatID, entry: entry)] + existing.filter { $0.chatId != chatID })
                .prefix(Self.maximumChatSelections)
        )
        guard updated != existing else { return }
        var next = snapshot
        next.chatSelections = (next.chatSelections ?? [:]).merging([instanceID: updated]) { $1 }
        persistLocked(next)
    }

    /// Drops a chat's unsent pick once the Mac accepts a send with it: the Mac
    /// then holds it as the chat's own model.
    func forgetChat(for instanceID: String, chatID: String, matching selection: AidenChatModelSelection? = nil) {
        lock.lock()
        defer { lock.unlock() }
        guard let existing = snapshot.chatSelections?[instanceID],
              let stored = existing.first(where: { $0.chatId == chatID }) else { return }
        // A newer pick made while a send was pending stays.
        if let selection, stored.entry != Self.entry(selection) { return }
        var next = snapshot
        let remaining = existing.filter { $0.chatId != chatID }
        next.chatSelections?[instanceID] = remaining.isEmpty ? nil : remaining
        persistLocked(next)
    }

    func purge(instanceID: String) {
        lock.lock()
        defer { lock.unlock() }
        var next = snapshot
        let removedDefault = next.selections.removeValue(forKey: instanceID) != nil
        let removedChats = next.chatSelections?.removeValue(forKey: instanceID) != nil
        guard removedDefault || removedChats else { return }
        persistLocked(next)
    }

    private static func entry(_ selection: AidenChatModelSelection) -> Entry? {
        guard let providerId = selection.providerId, isSafeID(providerId),
              let modelId = selection.modelId, isSafeID(modelId) else { return nil }
        return Entry(
            providerId: providerId,
            modelId: modelId,
            thinkingLevel: selection.thinkingLevel.flatMap { isSafeID($0) ? $0 : nil }
        )
    }

    private static func isSafe(_ entry: Entry) -> Bool {
        isSafeID(entry.providerId) && isSafeID(entry.modelId) && (entry.thinkingLevel.map(isSafeID) ?? true)
    }

    private func persistLocked(_ next: Snapshot) {
        guard let data = try? JSONEncoder().encode(next),
              data.count <= Self.maximumSnapshotBytes else { return }
        snapshot = next
        defaults.set(data, forKey: Self.snapshotKey)
    }

    private static func isSafeID(_ value: String) -> Bool {
        !value.isEmpty && value.count <= maximumIDLength
            && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }
}
