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

        store.setSelectedBot("bot-a", for: "mac-a", deviceID: "phone-a")
        store.setSelectedBot("bot-b", for: "mac-b", deviceID: "phone-b")
        XCTAssertEqual(store.selectedBot(for: "mac-a", deviceID: "phone-a"), "bot-a")
        XCTAssertEqual(store.selectedBot(for: "mac-b", deviceID: "phone-b"), "bot-b")
        XCTAssertNil(store.selectedBot(for: "mac-a", deviceID: "phone-b"))
    }

    @MainActor
    func testNavigationPurgeRemovesOnlyTheUnpairedInstallation() throws {
        let suiteName = "AidenProductShellTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = AidenProductNavigationStore(defaults: defaults)
        store.select(.workspaces, for: "mac-a", botsAvailable: true)
        store.setCompactBotPath(["chat-a"], for: "mac-a")
        store.setSelectedBot("bot-a", for: "mac-a", deviceID: "phone-a")
        store.select(.workspaces, for: "mac-b", botsAvailable: true)
        store.setCompactBotPath(["chat-b"], for: "mac-b")

        store.purge(instanceID: "mac-a")

        XCTAssertEqual(store.area(for: "mac-a", botsAvailable: true), .bots)
        XCTAssertEqual(store.compactBotPath(for: "mac-a"), [])
        XCTAssertNil(store.selectedBot(for: "mac-a", deviceID: "phone-a"))
        XCTAssertEqual(store.area(for: "mac-b", botsAvailable: true), .workspaces)
        XCTAssertEqual(store.compactBotPath(for: "mac-b"), ["chat-b"])
    }

    @MainActor
    func testBotSwitcherCoachmarkIsVersionedAndScopedToTheExactPairing() throws {
        let suiteName = "AidenProductShellTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = AidenProductNavigationStore(defaults: defaults)

        XCTAssertTrue(
            store.needsBotSwitcherCoachmark(for: "mac-a", deviceID: "phone-a")
        )
        store.completeBotSwitcherCoachmark(for: "mac-a", deviceID: "phone-a")

        XCTAssertFalse(
            store.needsBotSwitcherCoachmark(for: "mac-a", deviceID: "phone-a")
        )
        XCTAssertTrue(
            store.needsBotSwitcherCoachmark(for: "mac-a", deviceID: "phone-b")
        )
        XCTAssertTrue(
            store.needsBotSwitcherCoachmark(for: "mac-b", deviceID: "phone-a")
        )
        XCTAssertTrue(
            store.needsBotSwitcherCoachmark(
                for: "mac-a",
                deviceID: "phone-a",
                version: 2
            )
        )

        let restored = AidenProductNavigationStore(defaults: defaults)
        XCTAssertFalse(
            restored.needsBotSwitcherCoachmark(for: "mac-a", deviceID: "phone-a")
        )
    }

    @MainActor
    func testBotSwitcherCoachmarkRejectsInvalidScopeAndPurgesWithPairing() throws {
        let suiteName = "AidenProductShellTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = AidenProductNavigationStore(defaults: defaults)

        XCTAssertFalse(store.needsBotSwitcherCoachmark(for: nil, deviceID: "phone-a"))
        XCTAssertFalse(store.needsBotSwitcherCoachmark(for: "mac-a", deviceID: "bad id"))
        XCTAssertFalse(
            store.needsBotSwitcherCoachmark(for: "mac-a", deviceID: "phone-a", version: 0)
        )

        store.completeBotSwitcherCoachmark(for: "mac-a", deviceID: "phone-a")
        store.completeBotSwitcherCoachmark(for: "mac-b", deviceID: "phone-b")
        store.purge(instanceID: "mac-a")

        XCTAssertTrue(
            store.needsBotSwitcherCoachmark(for: "mac-a", deviceID: "phone-a")
        )
        XCTAssertFalse(
            store.needsBotSwitcherCoachmark(for: "mac-b", deviceID: "phone-b")
        )
    }

    func testBotHealthAndInboxActivityKeepNewChatAndStatusHonest() {
        XCTAssertTrue(aidenBotCanStartNewChat(health: .ready, canWrite: true))
        XCTAssertFalse(aidenBotCanStartNewChat(health: .degraded, canWrite: true))
        XCTAssertFalse(aidenBotCanStartNewChat(health: .unavailable, canWrite: true))
        XCTAssertEqual(
            aidenBotInboxActivityStatus(
                state: .waitingForApproval,
                canRespondToApproval: false
            )?.label,
            "Waiting for approval on Mac"
        )
        XCTAssertEqual(
            aidenBotInboxActivityStatus(state: .running, canRespondToApproval: false)?.label,
            "Working"
        )
        XCTAssertNil(aidenBotInboxActivityStatus(state: .idle, canRespondToApproval: false))
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
        XCTAssertEqual(
            aidenResolvedChatDestination(for: workspace, botsAvailability: .mobileDisabled),
            .workspaces
        )
        XCTAssertEqual(
            aidenResolvedChatDestination(for: bot, botsAvailability: .mobileDisabled),
            .unavailable("Bots aren’t available in this version of Aiden On The Go.")
        )
        XCTAssertEqual(
            aidenResolvedChatDestination(
                for: bot,
                botsAvailability: .available(canWrite: false)
            ),
            .bots
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
            AidenBotsAvailability.resolve(writable, mobileEnabled: false).unavailableMessage,
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
        XCTAssertFalse(
            aidenBotSurfaceIsActive(
                area: .bots,
                availability: AidenBotsAvailability.resolve(writable, mobileEnabled: false)
            )
        )
        XCTAssertFalse(
            aidenBotSurfaceIsActive(
                area: .workspaces,
                availability: .available(canWrite: true)
            )
        )
        XCTAssertTrue(
            aidenBotSurfaceIsActive(
                area: .bots,
                availability: .available(canWrite: false)
            )
        )
        for ingress in AidenBotSurfaceIngress.allCases {
            XCTAssertFalse(
                aidenBotSurfaceAllows(
                    ingress,
                    area: .bots,
                    availability: .mobileDisabled
                ),
                "rollout-off admitted \(ingress)"
            )
            XCTAssertFalse(
                aidenBotSurfaceAllows(
                    ingress,
                    area: .workspaces,
                    availability: .available(canWrite: true)
                ),
                "hidden Bot surface admitted \(ingress)"
            )
            let readOnlyExpected = ingress != .createConversation
                && ingress != .mutationResolution
            XCTAssertEqual(
                aidenBotSurfaceAllows(
                    ingress,
                    area: .bots,
                    availability: .available(canWrite: false)
                ),
                readOnlyExpected,
                "read-only Bot surface policy is wrong for \(ingress)"
            )
        }
        XCTAssertEqual(
            aidenBotSwitcherCoachmarkDetail(canWrite: true),
            "Before a Bot can act, Aiden shows a one-time Full Access notice. Choose Continue with Full Access or Customize first."
        )
        XCTAssertEqual(
            aidenBotSwitcherCoachmarkDetail(canWrite: false),
            "This Mac shared Bots as read-only. You can open their conversations here, then change Bot access on your Mac if you want to let them act."
        )
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
