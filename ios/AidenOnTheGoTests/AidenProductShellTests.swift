import Foundation
import XCTest
@testable import AidenOnTheGo

final class AidenProductShellTests: XCTestCase {
    func testArchivedBotChatsRemainReadOnlyForFullAndCustomAccess() {
        XCTAssertFalse(
            aidenBotChatAllowsMutations(
                canWrite: true,
                fullAccessActionsAllowed: true,
                botHealth: .archived,
                botAccessMode: .full,
                chatAccessMode: .inherit
            )
        )
        XCTAssertFalse(
            aidenBotChatAllowsMutations(
                canWrite: true,
                fullAccessActionsAllowed: false,
                botHealth: .archived,
                botAccessMode: .custom,
                chatAccessMode: .custom
            )
        )
        XCTAssertTrue(
            aidenBotChatAllowsMutations(
                canWrite: true,
                fullAccessActionsAllowed: false,
                botHealth: .ready,
                botAccessMode: .custom,
                chatAccessMode: .custom
            )
        )
    }

    func testBotsHomeShowsArchivedOnlyReadableHistoryInsteadOfFirstBotEmptyState() {
        XCTAssertEqual(
            aidenBotsHomeContentState(
                hasSnapshot: true,
                isLoading: false,
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
                activeBotCount: 0,
                conversationCount: 0,
                hasQuery: false,
                filteredBotCount: 0,
                filteredConversationCount: 0
            ),
            .empty
        )
    }
    @MainActor
    func testProductAreaDefaultsToBotsOnlyWhenNegotiatedAndPersistsPerInstallation() throws {
        let suiteName = "AidenProductShellTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = AidenProductNavigationStore(defaults: defaults)
        XCTAssertEqual(store.area(for: "mac-a", botsAvailable: true), .bots)
        XCTAssertEqual(store.area(for: "mac-b", botsAvailable: false), .workspaces)

        store.select(.workspaces, for: "mac-a", botsAvailable: true)
        store.select(.bots, for: "mac-b", botsAvailable: false)

        let restored = AidenProductNavigationStore(defaults: defaults)
        XCTAssertEqual(restored.area(for: "mac-a", botsAvailable: true), .workspaces)
        XCTAssertEqual(restored.area(for: "mac-b", botsAvailable: true), .bots)
    }

    @MainActor
    func testEachInstallationAndAreaKeepsIndependentNavigation() throws {
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
        store.select(.workspaces, for: "mac-a", botsAvailable: true)
        store.setCompactBotPath(["chat-a"], for: "mac-a")
        store.select(.workspaces, for: "mac-b", botsAvailable: true)
        store.setCompactBotPath(["chat-b"], for: "mac-b")

        store.purge(instanceID: "mac-a")

        XCTAssertEqual(store.area(for: "mac-a", botsAvailable: true), .bots)
        XCTAssertEqual(store.compactBotPath(for: "mac-a"), [])
        XCTAssertEqual(store.area(for: "mac-b", botsAvailable: true), .workspaces)
        XCTAssertEqual(store.compactBotPath(for: "mac-b"), ["chat-b"])
    }

    func testResolvedChatAreaUsesMacAuthoredBotIdentity() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let workspace = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-workspace","workspaceId":"workspace-1","title":"Workspace","messages":[],"createdAt":"2026-08-23T12:00:00Z","updatedAt":"2026-08-23T12:00:01Z","revision":"rev-1"}"#.utf8
            )
        )
        let bot = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-bot","workspaceId":"managed-home","botId":"bot-1","title":"Bot","messages":[],"createdAt":"2026-08-23T12:00:00Z","updatedAt":"2026-08-23T12:00:01Z","revision":"rev-2"}"#.utf8
            )
        )

        XCTAssertEqual(AidenProductRouting.area(for: workspace), .workspaces)
        XCTAssertEqual(AidenProductRouting.area(for: bot), .bots)
    }

    func testBotsAvailabilityDistinguishesUnsupportedFromNotGranted() throws {
        let unsupported = try installation(device: [.serverRead], server: [.serverRead])
        let notGranted = try installation(
            device: [.serverRead],
            server: [.serverRead, .botRead, .botWrite]
        )
        let readOnly = try installation(
            device: [.serverRead, .botRead],
            server: [.serverRead, .botRead, .botWrite]
        )

        XCTAssertEqual(AidenBotsAvailability.resolve(unsupported), .unsupported)
        XCTAssertEqual(AidenBotsAvailability.resolve(notGranted), .notGranted)
        XCTAssertEqual(AidenBotsAvailability.resolve(readOnly), .available(canWrite: false))
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
