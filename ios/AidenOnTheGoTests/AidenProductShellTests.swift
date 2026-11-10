import Foundation
import XCTest
@testable import AidenOnTheGo

final class AidenProductShellTests: XCTestCase {
    func testTheOverflowSymbolIsPlain() {
        XCTAssertEqual(AidenChromeSymbols.overflowMenu, "ellipsis")
        XCTAssertFalse(AidenChromeSymbols.overflowMenu.contains("circle"))
    }

    func testBotsHomeUsesSkeletonOnlyForTrueColdLoad() {
        XCTAssertEqual(
            aidenBotsHomeContentState(
                hasSnapshot: false,
                isLoading: true,
                totalBotCount: 0,
                activeBotCount: 0,
                conversationCount: 0,
                hasQuery: false,
                filteredBotCount: 0,
                filteredConversationCount: 0
            ),
            .loading
        )
        XCTAssertEqual(
            aidenBotsHomeContentState(
                hasSnapshot: true,
                isLoading: true,
                totalBotCount: 2,
                activeBotCount: 2,
                conversationCount: 2,
                hasQuery: false,
                filteredBotCount: 2,
                filteredConversationCount: 2
            ),
            .content
        )
        XCTAssertEqual(
            aidenBotsHomeContentState(
                hasSnapshot: true,
                isLoading: true,
                totalBotCount: 0,
                activeBotCount: 0,
                conversationCount: 0,
                hasQuery: false,
                filteredBotCount: 0,
                filteredConversationCount: 0
            ),
            .empty
        )
    }

    func testHomeLoadsOnlyIndependentlyNegotiatedCapabilitySegments() throws {
        let botOnly = try installation(
            device: [.serverRead, .botRead],
            server: [.serverRead, .botRead]
        )
        let botOnlyPlan = AidenBotsHomeLoadPlan(installation: botOnly)
        XCTAssertTrue(botOnlyPlan.loadsList)
        XCTAssertFalse(botOnlyPlan.loadsConversations)

        let botWithHistory = try installation(
            device: [.serverRead, .chatRead, .botRead],
            server: [.serverRead, .chatRead, .botRead]
        )
        let botHistoryPlan = AidenBotsHomeLoadPlan(installation: botWithHistory)
        XCTAssertTrue(botHistoryPlan.loadsList)
        XCTAssertTrue(botHistoryPlan.loadsConversations)

        let workspaceWithoutSchedules = try installation(
            device: [.serverRead, .chatRead],
            server: [.serverRead, .chatRead]
        )
        let workspacePlan = AidenHomeLoadPlan(installation: workspaceWithoutSchedules)
        XCTAssertTrue(workspacePlan.loadsChats)
        XCTAssertFalse(workspacePlan.loadsScheduledTasks)
        XCTAssertTrue(workspacePlan.loadsModelCatalog)
        XCTAssertTrue(workspacePlan.loadsUsage)
    }

    func testBotEditorsKeepWarmCachedContentVisibleDuringRefresh() {
        XCTAssertTrue(
            aidenBotUsesColdLoadingPlaceholder(isLoading: true, hasUsableContent: false)
        )
        XCTAssertFalse(
            aidenBotUsesColdLoadingPlaceholder(isLoading: true, hasUsableContent: true)
        )
        XCTAssertFalse(
            aidenBotUsesColdLoadingPlaceholder(isLoading: false, hasUsableContent: false)
        )
    }

    func testBotChatMutationsFollowTheWritePermission() {
        XCTAssertFalse(aidenBotChatAllowsMutations(canWrite: false, botHealth: .ready))
        XCTAssertTrue(aidenBotChatAllowsMutations(canWrite: true, botHealth: .ready))
    }

    func testBotsHomeShowsArchivedOnlyReadableHistoryInsteadOfFirstBotEmptyState() {
        XCTAssertEqual(
            aidenBotsHomeContentState(
                hasSnapshot: true,
                isLoading: false,
                totalBotCount: 1,
                activeBotCount: 0,
                conversationCount: 1,
                hasQuery: false,
                filteredBotCount: 0,
                filteredConversationCount: 1
            ),
            .content
        )
        XCTAssertEqual(
            aidenBotsHomeContentState(
                hasSnapshot: true,
                isLoading: false,
                totalBotCount: 1,
                activeBotCount: 0,
                conversationCount: 0,
                hasQuery: false,
                filteredBotCount: 0,
                filteredConversationCount: 0
            ),
            .content
        )
        XCTAssertEqual(
            aidenBotsHomeContentState(
                hasSnapshot: true,
                isLoading: false,
                totalBotCount: 0,
                activeBotCount: 0,
                conversationCount: 0,
                hasQuery: false,
                filteredBotCount: 0,
                filteredConversationCount: 0
            ),
            .empty
        )
    }
    /// What an older build left in v1, read per machine.
    @MainActor
    func testEachInstallationKeepsItsOwnSavedNavigation() throws {
        let suiteName = "AidenProductShellTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = AidenProductNavigationStore(defaults: defaults)

        store.setSelectedWorkspace("workspace-a", for: "mac-a")
        store.setCompactWorkspacePath(["workspace-a"], for: "mac-a")
        store.setCompactBotPath(["bot-chat-a"], for: "mac-a")
        store.setSelectedWorkspace("workspace-b", for: "mac-b")
        store.setCompactWorkspacePath(["workspace-b"], for: "mac-b")
        store.setCompactBotPath(["bot-chat-b"], for: "mac-b")

        XCTAssertEqual(store.selectedWorkspace(for: "mac-a"), "workspace-a")
        XCTAssertEqual(store.compactWorkspacePath(for: "mac-a"), ["workspace-a"])
        XCTAssertEqual(store.compactBotPath(for: "mac-a"), ["bot-chat-a"])
        XCTAssertEqual(store.selectedWorkspace(for: "mac-b"), "workspace-b")
        XCTAssertEqual(store.compactWorkspacePath(for: "mac-b"), ["workspace-b"])
        XCTAssertEqual(store.compactBotPath(for: "mac-b"), ["bot-chat-b"])
    }

    @MainActor
    func testNavigationPurgeRemovesOnlyTheUnpairedInstallation() throws {
        let suiteName = "AidenProductShellTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = AidenProductNavigationStore(defaults: defaults)
        store.setSelectedWorkspace("workspace-a", for: "mac-a")
        store.setCompactBotPath(["chat-a"], for: "mac-a")
        store.setSelectedWorkspace("workspace-b", for: "mac-b")
        store.setCompactBotPath(["chat-b"], for: "mac-b")

        store.purge(instanceID: "mac-a")

        let restored = AidenProductNavigationStore(defaults: defaults)
        XCTAssertNil(restored.selectedWorkspace(for: "mac-a"))
        XCTAssertEqual(restored.compactBotPath(for: "mac-a"), [])
        XCTAssertEqual(restored.selectedWorkspace(for: "mac-b"), "workspace-b")
        XCTAssertEqual(restored.compactBotPath(for: "mac-b"), ["chat-b"])
    }

    func testBotFastPathAdmitsOnlyTheExactCachedBotConversation() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let bot = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-bot","workspaceId":"managed-home","botId":"bot-1","title":"Bot","messages":[],"createdAt":"2026-08-23T12:00:00Z","updatedAt":"2026-08-23T12:00:01Z","revision":"rev-2"}"#.utf8
            )
        )
        let workspace = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-workspace","workspaceId":"workspace-1","title":"Workspace","messages":[],"createdAt":"2026-08-23T12:00:00Z","updatedAt":"2026-08-23T12:00:01Z","revision":"rev-1"}"#.utf8
            )
        )

        XCTAssertEqual(
            aidenAdmittedCachedBotChat(bot, chatID: "chat-bot", botID: "bot-1"),
            bot
        )
        XCTAssertEqual(
            aidenAdmittedCachedBotChat(bot, chatID: "chat-bot"),
            bot
        )
        XCTAssertNil(
            aidenAdmittedCachedBotChat(bot, chatID: "another-chat", botID: "bot-1")
        )
        XCTAssertNil(
            aidenAdmittedCachedBotChat(bot, chatID: "chat-bot", botID: "bot-2")
        )
        XCTAssertNil(
            aidenAdmittedCachedBotChat(workspace, chatID: "chat-workspace")
        )
        XCTAssertNil(
            aidenAdmittedCachedBotChat(nil, chatID: "chat-bot", botID: "bot-1")
        )
    }

    func testBotsAvailabilityHonorsRolloutAndNegotiatedAccess() throws {
        let unsupported = try installation(device: [.serverRead], server: [.serverRead])
        let notGranted = try installation(
            device: [.serverRead],
            server: [.serverRead, .botRead, .botWrite]
        )
        let readOnly = try installation(
            device: [.serverRead, .botRead],
            server: [.serverRead, .botRead, .botWrite]
        )
        let writable = try installation(
            device: [.serverRead, .botRead, .botWrite],
            server: [.serverRead, .botRead, .botWrite]
        )

        XCTAssertEqual(
            AidenBotsAvailability.resolve(writable, mobileEnabled: false),
            .mobileDisabled
        )
        XCTAssertEqual(
            AidenBotsAvailability.resolve(writable, mobileEnabled: false).tabExplanation,
            "Bots aren’t available in this version of Aiden On The Go."
        )
        XCTAssertEqual(
            AidenBotsAvailability.resolve(unsupported, mobileEnabled: true),
            .unsupported
        )
        XCTAssertEqual(
            AidenBotsAvailability.resolve(notGranted, mobileEnabled: true),
            .notGranted
        )
        XCTAssertEqual(
            AidenBotsAvailability.resolve(readOnly, mobileEnabled: true),
            .available(canWrite: false)
        )
        XCTAssertEqual(
            AidenBotsAvailability.resolve(writable, mobileEnabled: true),
            .available(canWrite: true)
        )
        XCTAssertFalse(AidenBotsAvailability.resolve(writable, mobileEnabled: false).canOpen)
        XCTAssertTrue(AidenBotsAvailability.available(canWrite: false).canOpen)
        XCTAssertFalse(AidenBotsAvailability.available(canWrite: false).canWrite)
    }

    private func installation(
        device: [AidenRemoteCapability],
        server: [AidenRemoteCapability]
    ) throws -> AidenInstallation {
        let capabilities = device.map(\.rawValue).map { "\"\($0)\"" }.joined(separator: ",")
        let serverCapabilities = server.map(\.rawValue).map { "\"\($0)\"" }.joined(separator: ",")
        let data = Data(
            """
            {"instanceId":"mac-a","deviceId":"device-a","name":"Mac",
            "endpoint":"https://aiden.test/api/aiden/v1",
            "serverSpkiSha256":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "pairingTrust":null,"credentialScope":"mac-a:device-a",
            "deviceCapabilities":[\(capabilities)],
            "serverCapabilities":[\(serverCapabilities)],
            "createdAt":"2026-08-23T12:00:00Z","lastConnectedAt":null}
            """.utf8
        )
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(AidenInstallation.self, from: data)
    }
}
