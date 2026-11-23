#if DEBUG
import AppIntents
import Foundation
import UIKit
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenHomeActionsTests: XCTestCase {
    override func tearDown() {
        AidenHomeActionDispatch.resetForTesting()
        AidenHomeActionDispatch.install { action in
            AidenForegroundIntentRouter.shared.submit(homeAction: action)
        }
        AidenForegroundIntentRouter.shared.discardActions()
        super.tearDown()
    }

    func testInfoPlistQuickActionsMatchExpectedOrderAndRoundTrip() throws {
        let items = try XCTUnwrap(
            Bundle.main.object(forInfoDictionaryKey: "UIApplicationShortcutItems") as? [[String: Any]]
        )
        XCTAssertEqual(items.count, 4)

        let types = items.compactMap { $0["UIApplicationShortcutItemType"] as? String }
        XCTAssertEqual(
            types,
            [
                "aiden.quickAction.newChat",
                "aiden.quickAction.startVoice",
                "aiden.quickAction.workspaces",
                "aiden.quickAction.bots",
            ]
        )

        let expectedActions: [AidenHomeAction] = [.newChat, .newChatVoice, .workspaces, .bots]
        XCTAssertEqual(AidenHomeAction.quickActions, expectedActions)
        for (item, expected) in zip(items, expectedActions) {
            let type = try XCTUnwrap(item["UIApplicationShortcutItemType"] as? String)
            let title = try XCTUnwrap(item["UIApplicationShortcutItemTitle"] as? String)
            let symbol = try XCTUnwrap(item["UIApplicationShortcutItemIconSymbolName"] as? String)
            XCTAssertFalse(title.isEmpty)
            XCTAssertFalse(symbol.isEmpty)
            XCTAssertEqual(AidenHomeAction(shortcutItemType: type), expected)
            XCTAssertEqual(expected.shortcutItemType, type)
        }
    }

    func testQuickActionHandlerDispatchesKnownShortcutsAndRejectsUnknownOnes() {
        var received: [AidenHomeAction] = []
        for action in AidenHomeAction.quickActions {
            let type = action.shortcutItemType!
            let item = UIApplicationShortcutItem(type: type, localizedTitle: "Action")
            XCTAssertTrue(AidenQuickActionHandler.handle(item) { received.append($0) })
        }
        XCTAssertEqual(received, [.newChat, .newChatVoice, .workspaces, .bots])

        let unknown = UIApplicationShortcutItem(type: "aiden.quickAction.forged", localizedTitle: "Forged")
        XCTAssertFalse(AidenQuickActionHandler.handle(unknown) { received.append($0) })
        XCTAssertEqual(received.count, 4)
    }

    func testDispatchBuffersColdLaunchActionsUntilHandlerInstallsAndBoundsQueue() {
        AidenHomeActionDispatch.resetForTesting()
        for _ in 0..<10 {
            AidenHomeActionDispatch.dispatch(.newChat)
        }
        AidenHomeActionDispatch.dispatch(.bots)

        var delivered: [AidenHomeAction] = []
        AidenHomeActionDispatch.install { delivered.append($0) }
        XCTAssertEqual(delivered.count, 8)
        XCTAssertEqual(delivered.last, .bots)

        AidenHomeActionDispatch.dispatch(.workspaces)
        XCTAssertEqual(delivered.last, .workspaces)
    }

    func testWidgetHomeActionIntentRunsInForegroundAndDispatchesEveryAction() async throws {
        XCTAssertEqual(AidenHomeActionIntent.supportedModes, .foreground)
        XCTAssertFalse(AidenHomeActionIntent.isDiscoverable)

        var received: [AidenHomeAction] = []
        AidenHomeActionDispatch.resetForTesting()
        AidenHomeActionDispatch.install { received.append($0) }

        for action in AidenHomeAction.allCases {
            _ = try await AidenHomeActionIntent(action).perform()
        }
        XCTAssertEqual(received, AidenHomeAction.allCases)
    }

    func testRouterMapsHomeActionsToChatLaunchActionsAndTabRoots() throws {
        let suiteName = "AidenHomeActionsTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let catalog = AidenIntentCatalogStore(defaults: defaults)
        try catalog.update(
            installations: [.init(id: "mac-1", name: "Studio")],
            activeInstallationId: "mac-1",
            workspaces: [],
            for: "mac-1"
        )

        let router = AidenForegroundIntentRouter()

        router.submit(homeAction: .newChat, catalogStore: catalog)
        XCTAssertEqual(router.pending?.instanceID, "mac-1")
        XCTAssertEqual(router.pending?.launchAction, AidenChatLaunchAction.none)
        XCTAssertFalse(router.pending?.startsVoice ?? true)
        XCTAssertFalse(router.pending?.startsCamera ?? true)

        router.discardActions()
        router.submit(homeAction: .newChatCamera, catalogStore: catalog)
        XCTAssertEqual(router.pending?.launchAction, .camera)
        XCTAssertTrue(router.pending?.startsCamera ?? false)
        XCTAssertFalse(router.pending?.startsVoice ?? true)

        router.discardActions()
        router.submit(homeAction: .newChatVoice, catalogStore: catalog)
        XCTAssertEqual(router.pending?.launchAction, .voice)
        XCTAssertTrue(router.pending?.startsVoice ?? false)
        XCTAssertFalse(router.pending?.startsCamera ?? true)

        // Switching to a tab supersedes waiting chat actions and is one-shot.
        router.submit(homeAction: .bots, catalogStore: catalog)
        XCTAssertNil(router.pending)
        XCTAssertEqual(router.pendingTab, .bots)
        XCTAssertEqual(router.takePendingTab(), .bots)
        XCTAssertNil(router.takePendingTab())

        // Submitting a new chat action clears a pending tab, and discardActions clears both.
        router.submit(homeAction: .workspaces, catalogStore: catalog)
        XCTAssertEqual(router.pendingTab, .workspaces)
        router.submit(homeAction: .newChat, catalogStore: catalog)
        XCTAssertNil(router.pendingTab)
        XCTAssertNotNil(router.pending)
        router.discardActions()
        XCTAssertNil(router.pending)
        XCTAssertNil(router.pendingTab)
    }

    func testCameraRouteRequiresFreshForegroundDeliveryAndDegradesToPlainChatOtherwise() {
        let installation = AidenDemoHosts.installation(instanceId: "mac-1", name: "Studio")
        let coordinator = AidenDemoHosts.coordinator(
            installations: [installation],
            responder: AidenDemoResponder()
        )
        let chatRoute = AidenAppRoute.chat(
            AidenHostObjectID(instanceId: "mac-1", deviceId: installation.deviceId, objectId: "chat-1")
        )
        let now = Date()

        let freshRouter = AidenForegroundIntentRouter()
        freshRouter.submit(route: chatRoute, launchAction: .camera, requestedAt: now)
        let freshTaken = freshRouter.takeRoutes(openableOn: coordinator, isForeground: { true }, now: now.addingTimeInterval(5))
        XCTAssertEqual(freshTaken.count, 1)
        XCTAssertTrue(freshTaken[0].startsCamera)
        XCTAssertFalse(freshTaken[0].startsVoice)

        let backgroundRouter = AidenForegroundIntentRouter()
        backgroundRouter.submit(route: chatRoute, launchAction: .camera, requestedAt: now)
        let backgroundTaken = backgroundRouter.takeRoutes(openableOn: coordinator, isForeground: { false }, now: now.addingTimeInterval(5))
        XCTAssertEqual(backgroundTaken.count, 1)
        XCTAssertFalse(backgroundTaken[0].startsCamera)

        let expiredRouter = AidenForegroundIntentRouter()
        expiredRouter.submit(route: chatRoute, launchAction: .camera, requestedAt: now)
        let expiredTaken = expiredRouter.takeRoutes(openableOn: coordinator, isForeground: { true }, now: now.addingTimeInterval(61))
        XCTAssertEqual(expiredTaken.count, 1)
        XCTAssertFalse(expiredTaken[0].startsCamera)
    }

    func testNavigationCameraLaunchIsEphemeralAndSelectTabRootPopsStack() {
        let installation = AidenDemoHosts.installation(instanceId: "mac-1", name: "Studio")
        let navigation = AidenAppNavigation()
        let chatID = AidenHostObjectID(instanceId: "mac-1", deviceId: installation.deviceId, objectId: "chat-cam")
        let otherChatID = AidenHostObjectID(instanceId: "mac-1", deviceId: installation.deviceId, objectId: "chat-other")
        let workspaceID = AidenHostObjectID(instanceId: "mac-1", deviceId: installation.deviceId, objectId: "ws-1")
        let botID = AidenHostObjectID(instanceId: "mac-1", deviceId: installation.deviceId, objectId: "bot-1")

        navigation.open(.chat(chatID), startsCamera: true)
        XCTAssertEqual(navigation.chatStartingCamera, chatID)
        XCTAssertNil(navigation.chatStartingVoice)

        navigation.finishStartingCamera(otherChatID)
        XCTAssertEqual(navigation.chatStartingCamera, chatID)
        navigation.finishStartingCamera(chatID)
        XCTAssertNil(navigation.chatStartingCamera)

        // Relaunch restoration never carries a camera or voice auto-start.
        navigation.open(.chat(chatID), startsCamera: true)
        let restored = AidenAppNavigation(restoring: navigation.snapshot, installations: [installation])
        XCTAssertNil(restored.chatStartingCamera)
        XCTAssertNil(restored.chatStartingVoice)

        // Switching to a tab root clears pushed routes on that tab and clears pending capture flags.
        navigation.open(.workspace(workspaceID))
        XCTAssertEqual(navigation.tab, .workspaces)
        XCTAssertEqual(navigation.workspacesPath, [.workspace(workspaceID)])
        navigation.selectTabRoot(.workspaces)
        XCTAssertEqual(navigation.tab, .workspaces)
        XCTAssertEqual(navigation.workspacesPath, [])

        navigation.open(.bot(botID))
        XCTAssertEqual(navigation.botsPath, [.bot(botID)])
        navigation.selectTabRoot(.bots)
        XCTAssertEqual(navigation.tab, .bots)
        XCTAssertEqual(navigation.botsPath, [])
        XCTAssertNil(navigation.chatStartingCamera)
        XCTAssertNil(navigation.chatStartingVoice)

        // Another tab's stack is left where it was, so Back to the Inbox still finds it.
        navigation.openInboxRow(.chat(otherChatID))
        navigation.selectTabRoot(.workspaces)
        XCTAssertEqual(navigation.inboxPath.last, .chat(otherChatID))
        navigation.selectTabRoot(.inbox)
        XCTAssertEqual(navigation.inboxPath, [])
    }

    func testCameraChatOpensWithItsCameraUnlessSomethingNewerTookTheForegroundMidCreation() async throws {
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        await coordinator.start()
        await AidenHostConnectScheduler(registry: coordinator.hosts, pathChanges: AsyncStream { _ in }).foregrounded()
        for instanceId in ["studio", "laptop"] {
            responder.reply(
                instanceId: instanceId,
                method: "POST",
                path: "/chats",
                status: 201,
                json: Data("""
                {"id":"chat_new_\(instanceId)","workspaceId":"workspace_app","title":"New chat","messages":[],
                "createdAt":"2026-08-19T19:00:00.000Z","updatedAt":"2026-08-19T19:00:00.000Z","revision":"chat_revision_1"}
                """.utf8)
            )
        }

        // Undisturbed, the camera rides through to the chat's route.
        let undisturbed = AidenForegroundIntentRouter()
        undisturbed.submit(instanceID: "studio", workspaceID: nil, launchAction: .camera)
        await undisturbed.openWaitingChats(coordinator: coordinator, isForeground: { true })
        let opened = undisturbed.takeRoutes(openableOn: coordinator, isForeground: { true })
        XCTAssertEqual(opened.map(\.launchAction), [.camera])

        // A Workspaces request lands while the host is still creating the chat.
        let release = responder.hold(instanceId: "laptop", path: "/chats")
        let superseded = AidenForegroundIntentRouter()
        superseded.submit(instanceID: "laptop", workspaceID: nil, launchAction: .camera)
        let creating = Task { await superseded.openWaitingChats(coordinator: coordinator, isForeground: { true }) }
        let deadline = Date().addingTimeInterval(5)
        while !responder.requests(instanceId: "laptop").contains("POST /chats"), Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(responder.requests(instanceId: "laptop").contains("POST /chats"))
        superseded.submit(tab: .workspaces)
        release()
        await creating.value

        // The chat exists, so it still opens, but never with the camera.
        let taken = superseded.takeRoutes(openableOn: coordinator, isForeground: { true })
        XCTAssertEqual(taken.count, 1)
        XCTAssertEqual(taken.first?.launchAction, AidenChatLaunchAction.none)
        XCTAssertEqual(superseded.takePendingTab(), .workspaces)
        XCTAssertEqual(responder.requests(instanceId: "laptop").filter { $0 == "POST /chats" }.count, 1)
    }

    func testCameraLaunchGateBlocksReadOnlyFixtureAndNeverReplays() {
        let chat = AidenChat(
            id: "chat-readonly",
            workspaceId: "ws-1",
            title: "Camera Test",
            providerId: "openai",
            modelId: "gpt-5",
            messages: [],
            createdAt: Date(),
            updatedAt: Date(),
            revision: "rev-1"
        )
        let model = AidenChatViewModel(readOnlyFixture: chat)
        var openedCount = 0
        model.startCameraForLaunch(if: true) { openedCount += 1 }
        model.startCameraForLaunch(if: true) { openedCount += 1 }
        XCTAssertEqual(openedCount, 0)
    }
}
#endif
