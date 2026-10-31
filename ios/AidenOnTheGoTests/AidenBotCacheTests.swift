import Foundation
import XCTest
@testable import AidenOnTheGo

final class AidenBotCacheTests: XCTestCase {
    private func fixture() throws -> AidenRemoteContractFixture {
        let url = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "contract", withExtension: "json")
        )
        return try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: url)
        )
    }

    func testTargetedCatalogsNeverOverwriteOrFallbackToGlobalOrAnotherBot() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-bot-catalog-scopes-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let generic = try fixture().botCapabilityCatalog
        func scoped(_ id: String) throws -> AidenBotCapabilityCatalog {
            var data = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(generic)) as? [String: Any])
            data["revision"] = "catalog-\(id)"
            data["skillsEnabled"] = false
            data["skills"] = [["id": "skill-\(id)", "label": "Saved skill", "available": false]]
            return try JSONDecoder.aidenRemote().decode(AidenBotCapabilityCatalog.self, from: JSONSerialization.data(withJSONObject: data))
        }
        let first = try scoped("a")
        let second = try scoped("b")
        let activation = await cache.activate(instanceId: "instance", deviceId: "device")
        _ = try await cache.store(AidenBotCacheSnapshot(catalog: generic), activation: activation)
        let legacy = await cache.load(instanceId: "instance", deviceId: "device")
        XCTAssertEqual(legacy?.catalog(forBotID: nil), generic)
        XCTAssertNil(legacy?.catalog(forBotID: "bot:a"), "Legacy global data is not scoped authority")
        _ = try await cache.mergeAndStore(AidenBotCacheSegments(catalogsByBotID: ["bot:a": first]), activation: activation)
        _ = try await cache.mergeAndStore(AidenBotCacheSegments(catalogsByBotID: ["bot:b": second]), activation: activation)
        let restarted = AidenBotCache(root: root)
        let restored = await restarted.load(instanceId: "instance", deviceId: "device")
        XCTAssertEqual(restored?.catalog(forBotID: nil), generic)
        XCTAssertEqual(restored?.catalog(forBotID: "bot:a"), first)
        XCTAssertEqual(restored?.catalog(forBotID: "bot:b"), second)
        XCTAssertNil(restored?.catalog(forBotID: "bot:unknown"))
        let otherPairing = await restarted.load(instanceId: "instance", deviceId: "other-device")
        XCTAssertNil(otherPairing)
        for id in ["../bad", "bot:newline\n", "", String(repeating: "a", count: AidenRemoteProtocol.maxBotIdentifierLength + 1)] {
            let invalid = try await cache.mergeAndStore(AidenBotCacheSegments(catalogsByBotID: [id: first]), activation: activation)
            XCTAssertNil(invalid)
        }
        let afterInvalid = await cache.load(instanceId: "instance", deviceId: "device")
        XCTAssertEqual(afterInvalid, restored)
        let otherActivation = await cache.activate(instanceId: "other-instance", deviceId: "device")
        let stale = try await cache.mergeAndStore(AidenBotCacheSegments(catalogsByBotID: ["bot:a": second]), activation: activation)
        XCTAssertNil(stale)
        let current = await cache.isCurrent(otherActivation)
        XCTAssertTrue(current)
    }

    func testLegacyCacheDecodesWithoutScopedCatalogsAndListRefreshPrunesDeletedBotScopes() throws {
        let contract = try fixture()
        let snapshot = AidenBotCacheSnapshot(catalog: contract.botCapabilityCatalog)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        var wire = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(snapshot)) as? [String: Any])
        wire.removeValue(forKey: "catalogsByBotID")
        let legacy = try JSONDecoder.aidenRemote().decode(AidenBotCacheSnapshot.self, from: JSONSerialization.data(withJSONObject: wire))
        XCTAssertNil(legacy.catalogsByBotID)
        XCTAssertEqual(legacy.catalog, contract.botCapabilityCatalog)
        let retainedID = try XCTUnwrap(contract.botList.bots.first?.id)
        let existing = AidenBotCacheSnapshot(catalog: contract.botCapabilityCatalog, catalogsByBotID: [
            retainedID: contract.botCapabilityCatalog,
            "bot:deleted": contract.botCapabilityCatalog,
        ])
        let pruned = AidenBotCacheSegments(list: contract.botList).applying(to: existing, savedAt: Date())
        XCTAssertEqual(Set(pruned.catalogsByBotID?.keys ?? Dictionary<String, AidenBotCapabilityCatalog>().keys), [retainedID])
        XCTAssertEqual(pruned.catalog, existing.catalog)
    }

    func testBotCacheIsInstanceScopedAndRejectsAtoBtoAStalePublication() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-bot-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let contract = try fixture()

        let firstA = await cache.activate(instanceId: "instance-a", deviceId: "device-a")
        _ = await cache.activate(instanceId: "instance-b", deviceId: "device-b")
        let secondA = await cache.activate(instanceId: "instance-a", deviceId: "device-a")
        let stale = AidenBotCacheSnapshot(list: contract.botList, savedAt: Date(timeIntervalSince1970: 1))
        let current = AidenBotCacheSnapshot(
            list: contract.botList,
            conversations: contract.botConversations,
            catalog: contract.botCapabilityCatalog,
            savedAt: Date(timeIntervalSince1970: 2)
        )

        let staleStored = try await cache.store(stale, activation: firstA)
        let currentStored = try await cache.store(current, activation: secondA)
        let staleMerged = try await cache.mergeAndStore(
            AidenBotCacheSegments(list: contract.botList),
            savedAt: Date(timeIntervalSince1970: 3),
            activation: firstA
        )
        let loadedA = await cache.load(instanceId: "instance-a", deviceId: "device-a")
        let loadedB = await cache.load(instanceId: "instance-b", deviceId: "device-b")
        XCTAssertFalse(staleStored)
        XCTAssertNil(staleMerged)
        XCTAssertTrue(currentStored)
        XCTAssertEqual(loadedA, current)
        XCTAssertNil(loadedB)
    }

    func testBotCacheSegmentRefreshPreservesLastGoodEditorSegments() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-bot-cache-segments-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let contract = try fixture()
        let activation = await cache.activate(instanceId: "instance-a", deviceId: "device-a")
        let initial = AidenBotCacheSnapshot(
            list: contract.botList,
            details: [contract.botDetail],
            conversations: contract.botConversations,
            catalog: contract.botCapabilityCatalog,
            savedAt: Date(timeIntervalSince1970: 10)
        )
        let stored = try await cache.store(initial, activation: activation)
        XCTAssertTrue(stored)

        let merged = try await cache.mergeAndStore(
            AidenBotCacheSegments(
                list: contract.botList,
                conversations: contract.botConversations
            ),
            savedAt: Date(timeIntervalSince1970: 20),
            activation: activation
        )
        let reloaded = await cache.load(instanceId: "instance-a", deviceId: "device-a")

        XCTAssertEqual(merged?.details, [contract.botDetail])
        XCTAssertEqual(merged?.catalog, contract.botCapabilityCatalog)
        XCTAssertEqual(reloaded, merged)
        XCTAssertEqual(reloaded?.savedAt, Date(timeIntervalSince1970: 20))
    }

    func testAuthoritativeBotListPrunesRemovedBotDetailsAndConversation() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-bot-cache-list-prune-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let contract = try fixture()
        let emptyList = try AidenRemoteJSONDecoder.decode(
            AidenBotList.self,
            from: Data(
                #"{"bots":[],"maxBots":256}"#.utf8
            )
        )
        let activation = await cache.activate(instanceId: "instance-a", deviceId: "device-a")
        let initial = AidenBotCacheSnapshot(
            list: contract.botList,
            details: [contract.botDetail],
            conversations: contract.botConversations,
            catalog: contract.botCapabilityCatalog,
            savedAt: Date(timeIntervalSince1970: 10)
        )
        let stored = try await cache.store(initial, activation: activation)
        XCTAssertTrue(stored)

        let merged = try await cache.mergeAndStore(
            AidenBotCacheSegments(list: emptyList),
            savedAt: Date(timeIntervalSince1970: 20),
            activation: activation
        )
        let reloaded = await cache.load(instanceId: "instance-a", deviceId: "device-a")

        XCTAssertEqual(merged?.list, emptyList)
        XCTAssertEqual(merged?.details, [])
        XCTAssertEqual(merged?.conversations?.conversations, [])
        XCTAssertEqual(reloaded, merged)
    }

    func testBotCacheRejectsMoreThanOneConversationOwnedByTheSameBot() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-bot-cache-duplicate-chat-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let contract = try fixture()
        let conversations = try duplicateConversationPageForFixtureBot()
        let activation = await cache.activate(instanceId: "instance-a", deviceId: "device-a")
        let valid = AidenBotCacheSnapshot(
            list: contract.botList,
            conversations: contract.botConversations,
            savedAt: Date(timeIntervalSince1970: 5)
        )
        let invalid = AidenBotCacheSnapshot(
            list: contract.botList,
            conversations: conversations,
            savedAt: Date(timeIntervalSince1970: 10)
        )
        let validStored = try await cache.store(valid, activation: activation)
        let stored = try await cache.store(invalid, activation: activation)
        let merged = try await cache.mergeAndStore(
            AidenBotCacheSegments(conversations: conversations),
            savedAt: Date(timeIntervalSince1970: 20),
            activation: activation
        )
        let loaded = await cache.load(instanceId: "instance-a", deviceId: "device-a")

        XCTAssertTrue(validStored)
        XCTAssertFalse(stored)
        XCTAssertNil(merged)
        XCTAssertEqual(loaded, valid)
    }

    func testBotsHomeDefensivelyChoosesOneCanonicalConversationPerBot() throws {
        let conversations = try duplicateConversationPageForFixtureBot().conversations
        let canonical = aidenCanonicalBotConversations(conversations)

        XCTAssertEqual(canonical.count, 1)
        XCTAssertEqual(canonical.first?.chatId, "chat_bot_fixture_02")
        XCTAssertEqual(canonical.first?.botId, "bot_fixture_01")
    }

    func testBotChatDeepLinkOpensTheSameCanonicalChatAsBotsHome() throws {
        let conversations = try duplicateConversationPageForFixtureBot().conversations

        XCTAssertEqual(
            aidenResolvedBotDeepLink(botID: "bot_fixture_01", conversations: conversations),
            .openChat("chat_bot_fixture_02")
        )
        XCTAssertEqual(
            aidenResolvedBotDeepLink(botID: "bot_fixture_01", conversations: conversations.reversed()),
            .openChat("chat_bot_fixture_02")
        )
        // Another Bot's chat never satisfies the link, and an empty result
        // lands on the Bot instead of creating a conversation.
        XCTAssertEqual(
            aidenResolvedBotDeepLink(botID: "bot_other", conversations: conversations),
            .showBot
        )
        XCTAssertEqual(aidenResolvedBotDeepLink(botID: "bot_fixture_01", conversations: []), .showBot)
    }

    @MainActor
    func testBotChatDeepLinkOnAMacServingDurableSessionsOpensTheDurableChatWhereTheCardWaits() throws {
        let path = try XCTUnwrap(aidenBotSessionDeepLinkPath(botID: "bot_fixture_01", hostFeatures: ["bot-durable-session-v1"]))
        XCTAssertEqual(path.compactMap(AidenBotChatRoute.botID(fromPath:)), ["bot_fixture_01"], "the Bots stack opens that Bot's durable chat")
        XCTAssertNil(aidenBotSessionDeepLinkPath(botID: "bot_fixture_01", hostFeatures: []), "an older Mac keeps the conversation link")
        XCTAssertNil(aidenBotSessionDeepLinkPath(botID: "bot_fixture_01", hostFeatures: nil))

        // The Bots stack keeps the path the link set, as it restores it.
        let suiteName = "AidenBotCacheTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        AidenProductNavigationStore(defaults: defaults).setCompactBotPath(path, for: "mac-a")
        XCTAssertEqual(AidenProductNavigationStore(defaults: defaults).compactBotPath(for: "mac-a"), path)
    }

    func testBotCachePurgesOnlySelectedInstallationAndInvalidatesItsActivation() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-bot-cache-purge-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let snapshot = AidenBotCacheSnapshot(
            list: try fixture().botList,
            savedAt: Date(timeIntervalSince1970: 1_777_777_777)
        )
        let a = await cache.activate(instanceId: "instance-a", deviceId: "device-a")
        let storedA = try await cache.store(snapshot, activation: a)
        XCTAssertTrue(storedA)
        let b = await cache.activate(instanceId: "instance-b", deviceId: "device-b")
        let storedB = try await cache.store(snapshot, activation: b)
        XCTAssertTrue(storedB)

        await cache.purge(instanceId: "instance-a")

        let loadedA = await cache.load(instanceId: "instance-a", deviceId: "device-a")
        let loadedB = await cache.load(instanceId: "instance-b", deviceId: "device-b")
        let bIsCurrent = await cache.isCurrent(b)
        let aIsCurrent = await cache.isCurrent(a)
        XCTAssertNil(loadedA)
        XCTAssertEqual(loadedB, snapshot)
        XCTAssertTrue(bIsCurrent)
        XCTAssertFalse(aIsCurrent)
    }

    func testBotCacheDoesNotExposeAPreviousPairingForTheSameMac() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-bot-cache-device-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let snapshot = AidenBotCacheSnapshot(
            list: try fixture().botList,
            savedAt: Date(timeIntervalSince1970: 1_777_777_777)
        )
        let oldPairing = await cache.activate(instanceId: "instance-a", deviceId: "device-old")
        let storedOldPairing = try await cache.store(snapshot, activation: oldPairing)
        XCTAssertTrue(storedOldPairing)

        _ = await cache.activate(instanceId: "instance-a", deviceId: "device-new")

        let newPairing = await cache.load(instanceId: "instance-a", deviceId: "device-new")
        let retainedOldPairing = await cache.load(instanceId: "instance-a", deviceId: "device-old")
        XCTAssertNil(newPairing)
        XCTAssertEqual(retainedOldPairing, snapshot)
    }

    func testDeletedBotIsForgottenFromListDetailsAndConversations() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-bot-cache-delete-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let contract = try fixture()
        let botID = contract.botDetail.id
        _ = await cache.activate(instanceId: "instance-a", deviceId: "device-a")
        _ = try await cache.mergeAndStore(
            AidenBotCacheSegments(
                list: contract.botList,
                details: [contract.botDetail],
                conversations: contract.botConversations
            ),
            instanceId: "instance-a",
            deviceId: "device-a"
        )

        let afterDelete = try await cache.removeBotAndStore(
            botId: botID,
            instanceId: "instance-a",
            deviceId: "device-a"
        )
        let reloaded = await cache.load(instanceId: "instance-a", deviceId: "device-a")

        XCTAssertEqual(afterDelete, reloaded)
        XCTAssertFalse(reloaded?.list?.bots.contains { $0.id == botID } ?? true)
        XCTAssertFalse(reloaded?.details.contains { $0.id == botID } ?? true)
        XCTAssertFalse(reloaded?.conversations?.conversations.contains { $0.botId == botID } ?? false)
    }

    func testDraftAndPendingSendStorageIsExcludedFromBackupAfterRecreation() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "draft-backup-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenChatDraftStore(root: root)
        let session = await store.beginSession(instanceId: "mac", chatId: "chat")
        _ = try await store.save("Editable private draft", session: session)
        let pending = AidenChatDraftStore.PendingSend(deviceId: "phone", request: .init(text: "Unconfirmed private send"),
            key: UUID(), createdAt: Date(), attachments: [])
        try await store.savePendingSend(pending, session: session)
        try assertDraftBackupExclusion(root, expectedFiles: 2)
        await store.purge(instanceId: "mac")
        try FileManager.default.removeItem(at: root)
        let reopened = await store.beginSession(instanceId: "mac", chatId: "chat")
        // A pending-send-only write must also create protected, excluded storage.
        try await store.savePendingSend(pending, session: reopened)
        try assertDraftBackupExclusion(root, expectedFiles: 1)
        let restored = try await store.loadPendingSend(session: reopened, deviceId: "phone")
        XCTAssertEqual(restored, pending)
    }

    func testOpeningLegacyDraftStoreExcludesExistingRecordsWithoutAWrite() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "draft-backup-migrate-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let original = AidenChatDraftStore(root: root)
        let session = await original.beginSession(instanceId: "mac", chatId: "chat")
        _ = try await original.save("Keep the existing draft", session: session)
        let pending = AidenChatDraftStore.PendingSend(deviceId: "phone", request: .init(text: "Unconfirmed"),
            key: UUID(), createdAt: Date(), attachments: [])
        try await original.savePendingSend(pending, session: session)
        let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .flatMap { try FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: nil) }
        let before = try files.map { try Data(contentsOf: $0) }
        var legacyRoot = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = false
        try legacyRoot.setResourceValues(values)
        XCTAssertEqual(try URL(filePath: root.path).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, false)
        let migrated = AidenChatDraftStore(root: root)
        // Check immediately after opening, before load/save/session calls can hide a missing migration.
        try assertDraftBackupExclusion(root, expectedFiles: 2)
        XCTAssertEqual(try files.map { try Data(contentsOf: $0) }, before)
        let reopened = await migrated.beginSession(instanceId: "mac", chatId: "chat")
        let text = await migrated.load(session: reopened)
        let attempt = try await migrated.loadPendingSend(session: reopened, deviceId: "phone")
        XCTAssertEqual(text, "Keep the existing draft")
        XCTAssertEqual(attempt, pending)
    }

    func testDraftWritesFailClosedWhenBackupExclusionFailsButKeepExistingDraftReadable() async throws {
        enum ExclusionFailure: Error { case denied }
        let root = FileManager.default.temporaryDirectory.appending(path: "draft-backup-fail-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let original = AidenChatDraftStore(root: root)
        let session = await original.beginSession(instanceId: "mac", chatId: "chat")
        _ = try await original.save("Original\nPrivate remainder", session: session)
        let failed = AidenChatDraftStore(root: root, excludeFromBackup: { _ in throw ExclusionFailure.denied })
        let next = await failed.beginSession(instanceId: "mac", chatId: "chat")
        do { _ = try await failed.save("Must not persist", session: next); XCTFail("Exclusion must succeed before a text write") }
        catch ExclusionFailure.denied { }
        let pending = AidenChatDraftStore.PendingSend(deviceId: "phone", request: .init(text: "Must not persist"),
            key: UUID(), createdAt: Date(), attachments: [])
        do { try await failed.savePendingSend(pending, session: next); XCTFail("Exclusion must succeed before a pending-send write") }
        catch ExclusionFailure.denied { }
        await failed.consumeDraft(submitted: "Original", from: "Original\nPrivate remainder", session: next)
        let retained = await failed.load(session: next)
        let attempt = try await failed.loadPendingSend(session: next, deviceId: "phone")
        XCTAssertEqual(retained, "Original\nPrivate remainder")
        XCTAssertNil(attempt)
    }

    private func assertDraftBackupExclusion(_ root: URL, expectedFiles: Int,
                                               file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try URL(filePath: root.path).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true, file: file, line: line)
        let entries = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]), file: file, line: line)
        var files = 0
        for case let url as URL in entries {
            if try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true { files += 1 }
        }
        XCTAssertEqual(files, expectedFiles, file: file, line: line)
    }

    func testDraftStoragePreservesCompleteUntilFirstUnlockProtectionWhenPlatformExposesIt() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "draft-protection-\(UUID())")
        let control = root.appendingPathExtension("control")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: control) }
        // An independent system-written control distinguishes unavailable simulator metadata
        // from the store failing to apply protection on a platform that exposes it.
        try Data("control".utf8).write(to: control, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        func protection(_ url: URL) throws -> String? {
            let value = try FileManager.default.attributesOfItem(atPath: url.path)[.protectionKey]
            return (value as? FileProtectionType)?.rawValue ?? value as? String
        }
        guard try protection(control) != nil else {
#if targetEnvironment(simulator)
            throw XCTSkip("This simulator does not expose Data Protection even for an independently protected control file; verify on signed physical hardware.")
#else
            return XCTFail("Physical iOS must expose Data Protection for the independently protected control file")
#endif
        }
        let store = AidenChatDraftStore(root: root)
        let session = await store.beginSession(instanceId: "mac", chatId: "chat")
        _ = try await store.save("Private draft", session: session)
        try await store.savePendingSend(.init(deviceId: "phone", request: .init(text: "Private pending send"),
            key: UUID(), createdAt: Date(), attachments: []), session: session)
        XCTAssertEqual(try protection(control), FileProtectionType.completeUntilFirstUserAuthentication.rawValue)
        func verifyTreeProtection() throws {
            XCTAssertEqual(try protection(root), FileProtectionType.completeUntilFirstUserAuthentication.rawValue)
            let entries = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
            for case let url as URL in entries {
                XCTAssertEqual(try protection(url), FileProtectionType.completeUntilFirstUserAuthentication.rawValue)
            }
        }
        try verifyTreeProtection()
    }

    func testDraftStoreSharesTextByInstallationAndChatWhileRejectingOldSessions() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-drafts-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenChatDraftStore(root: root)
        let stale = await store.beginSession(instanceId: "instance-a", chatId: "chat-shared")
        let current = await store.beginSession(instanceId: "instance-a", chatId: "chat-shared")

        let staleStored = try await store.save("stale draft", session: stale)
        let currentStored = try await store.save("Bot and Workspace use this draft", session: current)
        let currentDraft = await store.load(session: current)
        XCTAssertFalse(staleStored)
        XCTAssertTrue(currentStored)
        XCTAssertEqual(currentDraft, "Bot and Workspace use this draft")

        let otherMac = await store.beginSession(instanceId: "instance-b", chatId: "chat-shared")
        let emptyOtherMac = await store.load(session: otherMac)
        let otherStored = try await store.save("Other Mac", session: otherMac)
        let retainedCurrent = await store.load(session: current)
        XCTAssertNil(emptyOtherMac)
        XCTAssertTrue(otherStored)
        XCTAssertEqual(retainedCurrent, "Bot and Workspace use this draft")
    }

    func testDraftStoreConsumesAdmittedRunInputFromAnOlderSession() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-drafts-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenChatDraftStore(root: root)
        let submitting = await store.beginSession(instanceId: "instance-a", chatId: "chat-1")
        _ = try await store.save("Fix the tests\nthen ship", session: submitting)
        let otherMac = await store.beginSession(instanceId: "instance-b", chatId: "chat-1")
        _ = try await store.save("Fix the tests", session: otherMac)

        // The chat was reopened before the Mac admitted the input: the older
        // session still retires the admitted text, and only that text.
        let reopened = await store.beginSession(instanceId: "instance-a", chatId: "chat-1")
        await store.consumeDraft(submitted: "Fix the tests", from: "Fix the tests\nthen ship", session: submitting)
        let remaining = await store.load(session: reopened)
        XCTAssertEqual(remaining, "then ship")
        let untouchedOtherMac = await store.load(session: otherMac)
        XCTAssertEqual(untouchedOtherMac, "Fix the tests")

        // A draft typed after the composer cleared is a different draft, even
        // when it starts with the admitted text.
        _ = try await store.save("then ship it today", session: reopened)
        await store.consumeDraft(submitted: "then ship", from: "then ship", session: submitting)
        let newerDraft = await store.load(session: reopened)
        XCTAssertEqual(newerDraft, "then ship it today")

        await store.consumeDraft(submitted: "then ship it today", from: "then ship it today", session: submitting)
        let cleared = await store.load(session: reopened)
        XCTAssertNil(cleared)
        // Nothing saved: nothing is written back.
        await store.consumeDraft(submitted: "anything", from: "anything", session: submitting)
        let stillCleared = await store.load(session: reopened)
        XCTAssertNil(stillCleared)
    }

    func testBotCacheRejectsTruncatedAvatarThatOnlyLooksLikeA512PNGHeader() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-bot-avatar-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let activation = await cache.activate(instanceId: "instance-a", deviceId: "device-a")
        var truncated = Data([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
        truncated.append(contentsOf: [0, 0, 2, 0, 0, 0, 2, 0])
        let stored = try await cache.storeAvatar(
            AidenBotAvatarContent(data: truncated, assetRevision: "asset-1"),
            botId: "bot-1",
            activation: activation
        )

        XCTAssertFalse(stored)
    }

    private func duplicateConversationPageForFixtureBot() throws -> AidenBotConversationPage {
        let url = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "contract", withExtension: "json")
        )
        let rootData = try Data(contentsOf: url)
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: rootData) as? [String: Any]
        )
        var page = try XCTUnwrap(root["botConversations"] as? [String: Any])
        let conversations = try XCTUnwrap(page["conversations"] as? [[String: Any]])
        var second = try XCTUnwrap(conversations.first)
        second["chatId"] = "chat_bot_fixture_02"
        second["title"] = "Another chat"
        second["updatedAt"] = "2026-08-18T20:00:00.000Z"
        page["conversations"] = conversations + [second]
        return try AidenRemoteJSONDecoder.decode(
            AidenBotConversationPage.self,
            from: JSONSerialization.data(withJSONObject: page)
        )
    }

    func testDraftPurgeInvalidatesSessionAndRemovesOnlyThatInstallation() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-draft-purge-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenChatDraftStore(root: root)
        let a = await store.beginSession(instanceId: "instance-a", chatId: "chat-1")
        let b = await store.beginSession(instanceId: "instance-b", chatId: "chat-1")
        let storedA = try await store.save("A", session: a)
        let storedB = try await store.save("B", session: b)
        XCTAssertTrue(storedA)
        XCTAssertTrue(storedB)

        await store.purge(instanceId: "instance-a")

        let purgedA = await store.load(session: a)
        let staleAStored = try await store.save("late A", session: a)
        let retainedB = await store.load(session: b)
        XCTAssertNil(purgedA)
        XCTAssertFalse(staleAStored)
        XCTAssertEqual(retainedB, "B")
    }
}
