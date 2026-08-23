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
            notice: contract.botNotice,
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
            notice: contract.botNotice,
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
        XCTAssertEqual(merged?.notice, contract.botNotice)
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
                #"{"bots":[],"maxBots":256,"favorites":{"botIds":[],"revision":"favorites_empty"}}"#.utf8
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

    func testBotCacheAcceptsReadableConversationOwnedByArchivedBot() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-bot-cache-archived-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let list = try AidenRemoteJSONDecoder.decode(AidenBotList.self, from: Data(#"""
        {
          "bots": [
            {
              "id": "bot_active", "name": "Active", "purpose": "Current Bot",
              "avatar": {"semantic": {"version": 1, "shape": "orb", "color": "sky", "eyes": "wide", "detail": "orbit"}},
              "health": "ready", "createdAt": "2026-08-18T17:00:00.000Z",
              "updatedAt": "2026-08-18T18:00:00.000Z", "revision": "active_revision"
            },
            {
              "id": "bot_archived", "name": "Archived", "purpose": "Saved history",
              "avatar": {"semantic": {"version": 1, "shape": "orb", "color": "sky", "eyes": "wide", "detail": "orbit"}},
              "health": "archived", "createdAt": "2026-08-18T17:00:00.000Z",
              "updatedAt": "2026-08-18T19:00:00.000Z", "revision": "archived_revision",
              "archivedAt": "2026-08-18T19:00:00.000Z"
            }
          ],
          "maxBots": 256,
          "favorites": {"botIds": ["bot_active"], "revision": "favorites_revision"}
        }
        """#.utf8))
        let conversations = try AidenRemoteJSONDecoder.decode(
            AidenBotConversationPage.self,
            from: Data(#"""
            {
              "conversations": [{
                "chatId": "chat_archived", "botId": "bot_archived", "title": "Saved chat",
                "preview": "Still readable", "activityState": "idle", "canRespondToApproval": false,
                "createdAt": "2026-08-18T17:00:00.000Z", "updatedAt": "2026-08-18T19:00:00.000Z",
                "revision": "chat_revision"
              }]
            }
            """#.utf8)
        )
        let snapshot = AidenBotCacheSnapshot(
            list: list,
            conversations: conversations,
            savedAt: Date(timeIntervalSince1970: 1_777_777_777)
        )
        let activation = await cache.activate(instanceId: "instance-a", deviceId: "device-a")

        let stored = try await cache.store(snapshot, activation: activation)
        let loaded = await cache.load(instanceId: "instance-a", deviceId: "device-a")

        XCTAssertTrue(stored)
        XCTAssertEqual(loaded, snapshot)
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
