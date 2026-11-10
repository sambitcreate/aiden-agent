#if DEBUG
import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

/// New work goes to the machine a person picks, and the default machine is only
/// where the picker starts. These run the real models over the demo machines, so
/// every request is one the contract has.
@MainActor
final class AidenNewWorkTargetTests: XCTestCase {
    private var responder = AidenDemoResponder()
    private var preferences: AidenMachinePreferencesStore!
    private var coordinator: AidenRemoteCoordinator!
    private var roots: [URL] = []

    override func setUp() async throws {
        responder = AidenDemoResponder()
        preferences = AidenMachinePreferencesStore(defaults: AidenDemoHosts.isolatedDefaults())
        coordinator = makeCoordinator([
            AidenDemoHosts.installation(instanceId: "studio", name: "Studio"),
            AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop"),
            AidenDemoHosts.installation(instanceId: "mini", name: "Mini"),
        ])
    }

    override func tearDown() async throws {
        for root in roots { try? FileManager.default.removeItem(at: root) }
        roots = []
    }

    private func makeCoordinator(_ installations: [AidenInstallation]) -> AidenRemoteCoordinator {
        AidenDemoHosts.coordinator(installations: installations, responder: responder, machinePreferences: preferences)
    }

    private func connection(_ instanceId: String) throws -> AidenHostConnection {
        try XCTUnwrap(coordinator.hosts.connection(for: instanceId))
    }

    private func connectAll() async {
        for connection in coordinator.hosts.ordered { await connection.connect() }
    }

    private func takeOffline(_ instanceId: String) async throws {
        responder.fail(instanceId: instanceId, path: "*", code: .notConnectedToInternet)
        try await connection(instanceId).connect(over: .probe)
        guard case .offline = try connection(instanceId).connectionState else {
            return XCTFail("\(instanceId) should be offline")
        }
    }

    private func picker(_ kind: AidenNewWorkKind = .chat) -> AidenNewWorkPicker {
        AidenNewWorkPicker(coordinator: coordinator, kind: kind, preferences: preferences)
    }

    private func flow(
        readinessWait: Duration = .seconds(30),
        onCreated: @escaping @MainActor (AidenChat, AidenHostObjectID) -> Void = { _, _ in }
    ) -> AidenNewWorkChatFlow {
        AidenNewWorkChatFlow(
            coordinator: coordinator,
            preferences: preferences,
            readinessWait: readinessWait,
            onCreated: onCreated
        )
    }

    private func replyToNewChat(on instanceId: String, workspaceId: String = "workspace_app") {
        responder.reply(
            instanceId: instanceId,
            method: "POST",
            path: "/chats",
            status: 201,
            json: Data("""
            {"id":"chat_new_\(instanceId)","workspaceId":"\(workspaceId)","title":"New chat","messages":[],
            "createdAt":"2026-08-19T19:00:00.000Z","updatedAt":"2026-08-19T19:00:00.000Z","revision":"chat_revision_1"}
            """.utf8)
        )
    }

    private func posts(_ path: String, on instanceId: String) -> Int {
        responder.requests(instanceId: instanceId).filter { $0 == "POST \(path)" }.count
    }

    // MARK: The picker

    func testThePickerStartsOnTheDefaultMachine() async throws {
        await connectAll()
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")

        let picker = picker()

        XCTAssertEqual(picker.target, AidenNewWorkTarget(instanceId: "studio"))
        XCTAssertEqual(picker.machines.filter(\.isDefault).map(\.id), ["studio"])
        XCTAssertTrue(picker.showsPicker)
        XCTAssertTrue(picker.canStart)

        coordinator.setDefaultMachine("laptop")
        XCTAssertEqual(self.picker().target, AidenNewWorkTarget(instanceId: "laptop"))
    }

    /// The picker names and draws a machine as the Inbox does, so two machines
    /// with one name read apart here too.
    func testThePickerNamesMachinesAsTheInboxDoes() async throws {
        await connectAll()
        preferences.update("laptop") { $0.nameOverride = "Studio"; $0.symbol = .laptop }

        let machines = picker().machines
        let labels = AidenMachineLabel.labels(connections: coordinator.hosts.ordered, preferences: preferences)

        XCTAssertEqual(machines.map(\.name), ["studio", "laptop", "mini"].map { labels[$0]?.name })
        XCTAssertNotEqual(machines[0].name, machines[1].name, "Two machines called Studio read apart")
        XCTAssertEqual(machines[1].symbol, .laptop)
    }

    func testThePickerStaysOnAnOfflineDefaultAndSaysItCantBeUsed() async throws {
        await connectAll()
        try await takeOffline("studio")

        let picker = picker()

        XCTAssertEqual(picker.target, AidenNewWorkTarget(instanceId: "studio"), "It never moves to another machine by itself")
        XCTAssertFalse(picker.canStart)
        XCTAssertEqual(picker.refusalMessage, "Studio is offline. Pick another machine, or try again once it’s back.")
        XCTAssertTrue(picker.pick("laptop"))
        XCTAssertTrue(picker.canStart)
        XCTAssertNil(picker.refusalMessage)
    }

    func testOfflineMachinesShowButCannotBePicked() async throws {
        await connectAll()
        try await takeOffline("laptop")

        let picker = picker()

        XCTAssertEqual(picker.machines.map(\.id), ["studio", "laptop", "mini"])
        let laptop = try XCTUnwrap(picker.machines.first { $0.id == "laptop" })
        XCTAssertFalse(laptop.canBePicked)
        XCTAssertEqual(laptop.refusal, .offline)
        XCTAssertFalse(picker.pick("laptop"))
        XCTAssertEqual(picker.target, AidenNewWorkTarget(instanceId: "studio"), "A refused pick leaves the target alone")
    }

    func testAMachineCheckingAgainAfterBeingOfflineStillCannotBePicked() async throws {
        await connectAll()
        try await takeOffline("laptop")
        let release = responder.hold(instanceId: "laptop", path: "/server")
        let probe = Task { try await self.connection("laptop").connect(over: .probe) }
        await assertSettles { (try? self.connection("laptop").connectionState) == .connecting }

        XCTAssertFalse(try XCTUnwrap(picker().machines.first { $0.id == "laptop" }).canBePicked)

        release()
        _ = try await probe.value
    }

    func testAMachineStillConnectingCanBePicked() throws {
        XCTAssertEqual(try connection("laptop").connectionState, .connecting)

        XCTAssertTrue(try XCTUnwrap(picker().machines.first { $0.id == "laptop" }).canBePicked)
    }

    func testNoPickerWithOneMachine() async throws {
        coordinator = makeCoordinator([AidenDemoHosts.installation(instanceId: "solo", name: "Solo")])
        await connectAll()

        let picker = picker()

        XCTAssertFalse(picker.showsPicker)
        XCTAssertEqual(picker.target, AidenNewWorkTarget(instanceId: "solo"))
        XCTAssertTrue(picker.canStart)
    }

    func testNoPickerWhenTheOtherMachinesAreHidden() async throws {
        await connectAll()
        preferences.update("laptop") { $0.isHidden = true }
        preferences.update("mini") { $0.isHidden = true }

        let picker = picker()

        XCTAssertEqual(picker.machines.map(\.id), ["studio"])
        XCTAssertFalse(picker.showsPicker)
        XCTAssertEqual(picker.target, AidenNewWorkTarget(instanceId: "studio"))
    }

    func testHiddenMachinesStayOutOfThePickerEvenAsTheDefault() async throws {
        await connectAll()
        preferences.update("studio") { $0.isHidden = true }

        let picker = picker()

        XCTAssertEqual(picker.machines.map(\.id), ["laptop", "mini"])
        XCTAssertEqual(picker.target, AidenNewWorkTarget(instanceId: "laptop"))
        XCTAssertFalse(picker.pick("studio"))
    }

    func testRevokedAndUnpairedMachinesStayOutOfThePicker() async throws {
        await connectAll()
        try connection("laptop").markRevoked()
        try connection("mini").adopt(connectionState: .needsPairing)

        let picker = picker()

        XCTAssertEqual(picker.machines.map(\.id), ["studio"])
        XCTAssertFalse(picker.pick("laptop"))
        XCTAssertFalse(picker.pick("mini"))
    }

    func testReadingAMachineWritesNoAppearance() throws {
        _ = picker().machines

        XCTAssertNil(preferences.saved(for: "laptop"), "A view reads machines, so the read must not assign a colour")
    }

    // MARK: What the picked machine can do

    func testAMachineThatCantWriteChatsCantBePickedForANewChat() async throws {
        var laptop = AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop")
        laptop.deviceCapabilities.removeAll { $0 == .chatWrite }
        coordinator = makeCoordinator([AidenDemoHosts.installation(instanceId: "studio", name: "Studio"), laptop])
        await connectAll()

        let picker = picker(.chat)

        XCTAssertEqual(picker.machines.first { $0.id == "laptop" }?.refusal, .cannotStartChats)
        XCTAssertFalse(picker.pick("laptop"))
        XCTAssertTrue(self.picker(.reading).pick("laptop"), "Reading a machine asks nothing of chat access")
    }

    func testCapabilitiesAreReadOffThePickedMachineNotTheDefault() async throws {
        var studio = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
        studio.deviceCapabilities.removeAll { $0 == .chatWrite }
        coordinator = makeCoordinator([studio, AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop")])
        await connectAll()

        let picker = picker(.chat)

        XCTAssertFalse(picker.canStart, "The default can't write chats")
        XCTAssertEqual(picker.target, AidenNewWorkTarget(instanceId: "studio"))
        XCTAssertTrue(picker.pick("laptop"))
        XCTAssertTrue(picker.canStart)
    }

    func testAMachineThatCantWriteBotsCantBePickedForANewBot() async throws {
        var laptop = AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop")
        laptop.deviceCapabilities.removeAll { $0 == .botWrite }
        coordinator = makeCoordinator([AidenDemoHosts.installation(instanceId: "studio", name: "Studio"), laptop])
        await connectAll()

        let picker = picker(.bot)

        XCTAssertEqual(picker.machines.first { $0.id == "laptop" }?.refusal, .cannotCreateBots)
        XCTAssertFalse(picker.pick("laptop"))
    }

    // MARK: A new chat

    func testANewChatIsCreatedOnThePickedMachine() async throws {
        await connectAll()
        replyToNewChat(on: "laptop")
        var created: [(AidenChat, AidenHostObjectID)] = []
        let flow = flow { created.append(($0, $1)) }

        XCTAssertTrue(flow.picker.pick("laptop"))
        let workspace = try XCTUnwrap(flow.existingWorkspaces.first)
        await flow.create(in: workspace)

        XCTAssertEqual(posts("/chats", on: "laptop"), 1)
        XCTAssertEqual(posts("/chats", on: "studio"), 0)
        XCTAssertEqual(created.map(\.1), [AidenHostObjectID(
            instanceId: "laptop",
            deviceId: try connection("laptop").installation.deviceId,
            objectId: "chat_new_laptop"
        )])
        XCTAssertEqual(coordinator.defaultInstanceId, "studio", "Picking a machine isn't choosing a new default")
        XCTAssertNil(coordinator.presentedError)
        XCTAssertFalse(flow.isCreating)
    }

    func testPickingAMachineMidwayDoesNotReaimAChatBeingCreated() async throws {
        await connectAll()
        replyToNewChat(on: "laptop")
        let release = responder.hold(instanceId: "laptop", path: "/chats")
        var created: [AidenHostObjectID] = []
        let flow = flow { created.append($1) }
        flow.picker.pick("laptop")
        let workspace = try XCTUnwrap(flow.existingWorkspaces.first)

        let work = Task { await flow.create(in: workspace) }
        await assertSettles { self.responder.requests(instanceId: "laptop").contains("POST /chats") }
        flow.picker.pick("mini")
        release()
        await work.value

        XCTAssertEqual(created.map(\.instanceId), ["laptop"])
        XCTAssertEqual(posts("/chats", on: "mini"), 0)
    }

    func testChoicesComeFromThePickedMachine() async throws {
        await connectAll()
        responder.reply(instanceId: "laptop", path: "/workspaces", status: 200, json: Data("""
        {"workspaces":[{"id":"workspace_laptop","name":"Laptop work","permission":"ask","memoryEnabled":true,
        "hasFolder":true,"isManagedWorktree":false,"createdAt":"2026-08-19T19:00:00.000Z",
        "updatedAt":"2026-08-19T19:00:00.000Z","revision":"workspace_revision_1"}]}
        """.utf8))
        await coordinator.hosts.connection(for: "laptop")?.connect()
        let flow = flow()
        XCTAssertTrue(flow.choices.contains(.noWorkspace))

        flow.picker.pick("laptop")

        XCTAssertFalse(flow.choices.contains(.noWorkspace), "The laptop has no Chats home")
        XCTAssertEqual(flow.existingWorkspaces.map(\.id), ["workspace_laptop"])
    }

    func testANewWorkspaceIsMadeOnThePickedMachine() async throws {
        await connectAll()
        responder.reply(instanceId: "laptop", method: "POST", path: "/workspaces", status: 201, json: Data("""
        {"id":"workspace_made","name":"Made here","permission":"ask","memoryEnabled":true,"hasFolder":false,
        "isManagedWorktree":false,"createdAt":"2026-08-19T19:00:00.000Z",
        "updatedAt":"2026-08-19T19:00:00.000Z","revision":"workspace_revision_1"}
        """.utf8))
        replyToNewChat(on: "laptop", workspaceId: "workspace_made")
        var created: [AidenHostObjectID] = []
        let flow = flow { created.append($1) }
        flow.picker.pick("laptop")

        await flow.create(inNewWorkspaceNamed: "Made here")

        XCTAssertEqual(posts("/workspaces", on: "laptop"), 1)
        XCTAssertEqual(posts("/workspaces", on: "studio"), 0)
        XCTAssertEqual(posts("/chats", on: "laptop"), 1)
        XCTAssertEqual(created.map(\.objectId), ["chat_new_laptop"])
    }

    func testAChatTappedWhileItsMachineConnectsWaitsForIt() async throws {
        await coordinator.hosts.connection(for: "studio")?.connect()
        XCTAssertEqual(try connection("laptop").connectionState, .connecting)
        replyToNewChat(on: "laptop")
        var created: [AidenHostObjectID] = []
        let flow = flow { created.append($1) }
        flow.picker.pick("laptop")
        let workspace = try workspaceFixture()

        let work = Task { await flow.create(in: workspace) }
        await assertSettles { flow.status == "Waiting for your machine…" }
        XCTAssertEqual(posts("/chats", on: "laptop"), 0)
        await coordinator.hosts.connection(for: "laptop")?.connect()
        await work.value

        XCTAssertEqual(created.map(\.instanceId), ["laptop"])
    }

    func testAMachineThatNeverConnectsEndsTheWaitWithAReason() async throws {
        XCTAssertEqual(try connection("laptop").connectionState, .connecting)
        let flow = flow(readinessWait: .milliseconds(300))
        flow.picker.pick("laptop")

        await flow.create(in: try workspaceFixture())

        XCTAssertEqual(posts("/chats", on: "laptop"), 0)
        XCTAssertEqual(coordinator.presentedError, "Laptop isn’t reachable right now. Try again once it’s connected.")
        XCTAssertFalse(flow.isCreating)
    }

    func testComposeIsAvailableWhileAnyMachineCanTakeTheChat() async throws {
        await connectAll()
        try await takeOffline("studio")
        let flow = flow()

        XCTAssertFalse(flow.isUnavailable, "An offline default leaves the other machines to pick")
        XCTAssertFalse(flow.canStart)

        try await takeOffline("laptop")
        try await takeOffline("mini")
        XCTAssertFalse(flow.isUnavailable, "It opens and says why (R15)")
        XCTAssertFalse(flow.canStart)
        XCTAssertEqual(flow.picker.refusalMessage, "Studio is offline. Try again once it’s back.")
    }

    func testOneOfflineMachineSaysWhyItCantTakeTheChat() async throws {
        coordinator = makeCoordinator([AidenDemoHosts.installation(instanceId: "studio", name: "Studio")])
        await connectAll()
        try await takeOffline("studio")
        let flow = flow()
        XCTAssertFalse(flow.picker.showsPicker)
        XCTAssertFalse(flow.isUnavailable)
        XCTAssertFalse(flow.canStart)

        let labels = try labels(of: AidenNewWorkMachinePicker(picker: flow.picker), showing: "offline")

        XCTAssertTrue(labels.contains("Studio is offline. Try again once it’s back."), "\(labels)")
    }

    func testOneMachineThatCantMakeBotsSaysSoInNewBot() async throws {
        var studio = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
        studio.deviceCapabilities.removeAll { $0 == .botWrite }
        coordinator = makeCoordinator([studio])
        await connectAll()

        let labels = try labels(of: AidenBotCreateView(coordinator: coordinator), showing: "can’t create Bots")

        XCTAssertTrue(labels.contains("Studio can’t create Bots from this phone."), "\(labels)")
    }

    func testALostChatWriteSaysSoInsteadOfDoingNothing() async throws {
        var laptop = AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop")
        laptop.deviceCapabilities.removeAll { $0 == .chatWrite }
        coordinator = makeCoordinator([AidenDemoHosts.installation(instanceId: "studio", name: "Studio"), laptop])
        await connectAll()

        let created = try await coordinator.createChat(on: AidenNewWorkTarget(instanceId: "laptop"), in: workspaceFixture())

        XCTAssertNil(created)
        XCTAssertEqual(coordinator.presentedError, "Laptop can’t start chats from this phone. Pick another machine.")
        XCTAssertEqual(posts("/chats", on: "laptop"), 0)
    }

    func testAChatForAMachineThatLeftSaysSo() async throws {
        await connectAll()

        let created = try await coordinator.createChat(on: AidenNewWorkTarget(instanceId: "gone"), in: workspaceFixture())

        XCTAssertNil(created)
        XCTAssertEqual(coordinator.presentedError, "This machine is no longer paired. Pair it again to continue.")
    }

    func testTheDefaultPermissionIsAskedForOnceAndKeepsTheWorkspaceWhenRefused() async throws {
        let workspace = try workspaceFixture()
        var updates = 0

        let same = await AidenWorkspaceDefaultApplication.applying(workspace.permission, to: workspace) { _ in
            updates += 1
            return nil
        }
        XCTAssertEqual(updates, 0)
        XCTAssertEqual(same.feedback, .success)

        let other: AidenWorkspacePermission = workspace.permission == .ask ? .full : .ask
        let refused = await AidenWorkspaceDefaultApplication.applying(other, to: workspace) { _ in
            updates += 1
            return nil
        }
        XCTAssertEqual(updates, 1)
        XCTAssertEqual(refused.feedback, .warning)
        XCTAssertEqual(refused.workspace.id, workspace.id)
    }

    func testOpeningComposeAgainStartsOnTheDefaultMachine() async throws {
        await connectAll()
        let flow = flow()
        flow.picker.pick("laptop")

        flow.picker.startOver()

        XCTAssertEqual(flow.picker.target, AidenNewWorkTarget(instanceId: "studio"))
    }

    /// The Workspaces tab's compose is the Inbox's: with several machines it
    /// starts on the picker, on the default machine, or on the machine the strip
    /// is filtered to.
    func testWorkspacesComposeStartsOnTheFilteredMachineOrTheDefault() async throws {
        await connectAll()
        let flow = flow()
        var filter = AidenMachineFilter.all
        func chrome(grouped: Bool = true) -> AidenWorkspacesTabChrome {
            AidenWorkspacesTabChrome(
                route: { _ in .machines },
                newWork: flow,
                machines: grouped ? AidenWorkspacesTabMachines(
                    roster: AidenMachineRoster(),
                    filter: Binding(get: { filter }, set: { filter = $0 }),
                    sections: [],
                    refresh: {}
                ) : nil
            )
        }
        XCTAssertTrue(flow.picker.showsPicker)

        flow.picker.startOver(preferring: chrome().composeMachine)
        XCTAssertEqual(flow.picker.target, AidenNewWorkTarget(instanceId: "studio"), "All starts on the default")

        filter = .machine("laptop")
        flow.picker.startOver(preferring: chrome().composeMachine)
        XCTAssertEqual(flow.picker.target, AidenNewWorkTarget(instanceId: "laptop"), "A filter starts on its machine")

        try await takeOffline("mini")
        filter = .machine("mini")
        flow.picker.startOver(preferring: chrome().composeMachine)
        XCTAssertEqual(flow.picker.target, AidenNewWorkTarget(instanceId: "mini"), "It stays on the filtered machine")
        XCTAssertFalse(flow.canStart)
        XCTAssertEqual(flow.picker.refusalMessage, "Mini is offline. Pick another machine, or try again once it’s back.")

        flow.picker.startOver(preferring: chrome(grouped: false).composeMachine)
        XCTAssertEqual(flow.picker.target, AidenNewWorkTarget(instanceId: "studio"), "One machine listed starts on the default")

        flow.picker.startOver(preferring: "gone")
        XCTAssertEqual(flow.picker.target, AidenNewWorkTarget(instanceId: "studio"), "A machine that left falls back to the default")
    }

    // MARK: A new Bot

    func testANewBotIsCreatedOnThePickedMachine() async throws {
        await connectAll()
        let context = try coordinator.ownerContext(for: "laptop")
        let operations = AidenBotCreateOperations.make(coordinator: coordinator, context: context)

        XCTAssertEqual(operations.instanceId, "laptop")
        // The demo machine has no answer for this, and the request is what counts.
        _ = try? await operations.create(try AidenBotCreateRequest(
            name: "Planner",
            purpose: "Plans my week",
            instructions: "Plan my week.",
            avatar: .recipe(AidenBotEditorDraft.defaultAvatar),
            access: nil
        ), UUID())

        XCTAssertEqual(posts("/bots", on: "laptop"), 1)
        XCTAssertEqual(posts("/bots", on: "studio"), 0)
        coordinator.setDefaultMachine("mini")
        XCTAssertTrue(operations.isCurrent(), "A Bot on its way stays with its machine when the default moves")
    }

    func testANewBotWaitsOnThePickedMachine() async throws {
        await coordinator.hosts.connection(for: "studio")?.connect()
        let context = try coordinator.ownerContext(for: "laptop")
        let operations = AidenBotCreateOperations.make(coordinator: coordinator, context: context)

        let answered = await operations.waitForConnection(.milliseconds(300))

        XCTAssertFalse(answered, "The default being connected says nothing about the laptop")
    }

    private func botStoreRoot() -> URL {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "AidenNewWorkTargetTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        roots.append(root)
        return root
    }

    private func botAsk(_ name: String) -> AidenBotCreateInput {
        AidenBotCreateInput(name: name, purpose: "Plans my week", draft: nil)
    }

    /// A New Bot an earlier launch left waiting on `instanceId`.
    private func parkAsk(_ name: String, on instanceId: String, in root: URL) async throws {
        let context = try coordinator.ownerContext(for: instanceId)
        let saved = await AidenBotOutboxStore(root: root).savePendingCreate(
            AidenBotPendingCreate(input: botAsk(name), frozen: nil, createdAt: Date()),
            instanceId: context.instanceId,
            deviceId: context.deviceId
        )
        XCTAssertTrue(saved)
    }

    func testAParkedAskSurvivesANewPickOfItsMachine() async throws {
        await connectAll()
        let root = botStoreRoot()
        try await parkAsk("Planner", on: "laptop", in: root)
        let context = try coordinator.ownerContext(for: "laptop")
        let flow = AidenBotCreateFlow(store: AidenBotOutboxStore(root: root))

        await flow.submit(
            botAsk("Reader"),
            operations: .make(coordinator: coordinator, context: context)
        ) { _ in XCTFail("Nothing should be made over a parked ask") }

        let onDisk = await AidenBotOutboxStore(root: root).pendingCreate(instanceId: context.instanceId, deviceId: context.deviceId)
        XCTAssertEqual(onDisk?.input.name, "Planner", "The words the person left are still there")
        XCTAssertEqual(flow.failure(instanceId: context.instanceId, deviceId: context.deviceId)?.input.name, "Planner")
        XCTAssertEqual(posts("/bots", on: "laptop"), 0)
    }

    func testAnAskParkedOnAnyMachineComesBackWithTheMachinesName() async throws {
        await connectAll()
        let root = botStoreRoot()
        try await parkAsk("Planner", on: "laptop", in: root)
        let flow = AidenBotCreateFlow(store: AidenBotOutboxStore(root: root))
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")

        await flow.restoreEveryMachine(coordinator: coordinator)

        let failure = try XCTUnwrap(flow.failureToShow(coordinator: coordinator), "A relaunch shows it, whichever machine is the default")
        XCTAssertEqual(failure.input.name, "Planner")
        XCTAssertEqual(failure.instanceId, "laptop")
        XCTAssertEqual(failure.shownMessage(coordinator: coordinator), "Laptop: \(AidenBotCreateFlow.interrupted)")
    }

    func testAnAskOnTheDefaultNeedsNoMachineName() async throws {
        await connectAll()
        let root = botStoreRoot()
        try await parkAsk("Planner", on: "studio", in: root)
        let flow = AidenBotCreateFlow(store: AidenBotOutboxStore(root: root))

        await flow.restoreEveryMachine(coordinator: coordinator)

        let failure = try XCTUnwrap(flow.failureToShow(coordinator: coordinator))
        XCTAssertEqual(failure.shownMessage(coordinator: coordinator), AidenBotCreateFlow.interrupted)
    }

    func testNewBotWaitsUntilEveryMachineHasBeenLookedAt() async throws {
        await connectAll()
        let flow = AidenBotCreateFlow(store: AidenBotOutboxStore(root: botStoreRoot()))

        XCTAssertFalse(flow.canOpenNewBot(coordinator: coordinator))
        await flow.restoreEveryMachine(coordinator: coordinator)

        XCTAssertTrue(flow.canOpenNewBot(coordinator: coordinator))
    }

    /// A default machine that can't make Bots doesn't close New Bot for another
    /// that can: with both listed it opens, and its picker starts on that one.
    func testNewBotOpensWhenAnotherMachineThanTheDefaultCanMakeBots() async throws {
        var studio = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
        studio.deviceCapabilities.removeAll { $0 == .botRead || $0 == .botWrite }
        coordinator = makeCoordinator([studio, AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop")])
        await connectAll()
        let flow = AidenBotCreateFlow(store: AidenBotOutboxStore(root: botStoreRoot()))
        await flow.restoreEveryMachine(coordinator: coordinator)
        let defaultCanCreate = AidenBotsAvailability.resolve(try connection("studio").installation).canWrite
        XCTAssertFalse(defaultCanCreate)
        func canTap(grouped: Bool) -> Bool {
            AidenBotCreateFlow.canTapNewBot(
                groupsMachines: grouped,
                defaultCanCreate: defaultCanCreate,
                canOpen: flow.canOpenNewBot(coordinator: coordinator),
                coordinator: coordinator
            )
        }

        XCTAssertTrue(canTap(grouped: true), "Laptop can make Bots")
        XCTAssertFalse(canTap(grouped: false), "Listing only the default, it follows the default")
        let picker = picker(.bot)
        XCTAssertEqual(picker.target, AidenNewWorkTarget(instanceId: "laptop"), "It starts on a machine that can")
        XCTAssertTrue(picker.canStart)
        XCTAssertEqual(picker.machines.first { $0.id == "studio" }?.refusal, .cannotCreateBots)
        XCTAssertFalse(picker.pick("studio"))

        try await takeOffline("laptop")
        XCTAssertTrue(canTap(grouped: true), "Offline, it still opens and says why inside")

        var laptop = try connection("laptop").installation
        laptop.deviceCapabilities.removeAll { $0 == .botWrite }
        coordinator = makeCoordinator([studio, laptop])
        await connectAll()
        let none = AidenBotCreateFlow(store: AidenBotOutboxStore(root: botStoreRoot()))
        await none.restoreEveryMachine(coordinator: coordinator)
        XCTAssertFalse(
            AidenBotCreateFlow.canTapNewBot(
                groupsMachines: true,
                defaultCanCreate: false,
                canOpen: none.canOpenNewBot(coordinator: coordinator),
                coordinator: coordinator
            ),
            "No machine can make Bots"
        )
    }

    func testNewBotOpensWithEveryMachineOfflineAndSaysWhyInside() async throws {
        await connectAll()
        for id in ["studio", "laptop", "mini"] { try await takeOffline(id) }
        let flow = AidenBotCreateFlow(store: AidenBotOutboxStore(root: botStoreRoot()))
        await flow.restoreEveryMachine(coordinator: coordinator)

        XCTAssertTrue(flow.canOpenNewBot(coordinator: coordinator), "R15: it opens, connected or not")
        let picker = picker(.bot)
        XCTAssertFalse(picker.canStart)
        XCTAssertEqual(picker.refusalMessage, "Studio is offline. Try again once it’s back.")
    }

    func testANewBotForAMachineThatLeftNeverFallsToTheDefault() async throws {
        await connectAll()

        XCTAssertThrowsError(try AidenBotCreateOperations.context(
            for: AidenNewWorkTarget(instanceId: "gone"),
            coordinator: coordinator
        ))
        XCTAssertEqual(try AidenBotCreateOperations.context(for: nil, coordinator: coordinator).instanceId, "studio")
    }

    func testABotOnItsWayToAnotherMachineShowsARow() async throws {
        await connectAll()
        let context = try coordinator.ownerContext(for: "laptop")
        let release = responder.hold(instanceId: "laptop", path: "/bot-capabilities")
        let flow = AidenBotCreateFlow(store: nil)
        let operations = AidenBotCreateOperations.make(coordinator: coordinator, context: context)
        let making = Task { await flow.submit(self.botAsk("Planner"), operations: operations) { _ in } }
        await assertSettles { flow.pending != nil }
        defer { release() }

        let shown = try XCTUnwrap(flow.shownPending(coordinator: coordinator))
        XCTAssertEqual(shown.pending.name, "Planner")
        XCTAssertEqual(shown.machine, "Laptop")
        XCTAssertEqual(AidenBotCreateCopy.creating(on: "Laptop"), "Creating on Laptop…")

        release()
        await making.value
    }

    func testTryAgainGoesToTheFailuresOwnMachineOnly() async throws {
        await connectAll()
        let root = botStoreRoot()
        try await parkAsk("Planner", on: "laptop", in: root)
        let flow = AidenBotCreateFlow(store: AidenBotOutboxStore(root: root))
        await flow.restoreEveryMachine(coordinator: coordinator)
        let failure = try XCTUnwrap(flow.failureToShow(coordinator: coordinator))

        let pairing = try XCTUnwrap(failure.retryPairing(coordinator: coordinator))
        XCTAssertEqual(pairing.instanceId, "laptop")
        XCTAssertEqual(pairing.deviceId, failure.deviceId)

        var repaired = failure
        repaired.deviceId = "another-device"
        XCTAssertNil(repaired.retryPairing(coordinator: coordinator), "A new pairing isn't the phone that asked")

        XCTAssertEqual(
            flow.retry(failure, instanceId: "studio", deviceId: failure.deviceId), .none,
            "Another machine can't answer for this failure"
        )
        XCTAssertNotNil(flow.failure(instanceId: failure.instanceId, deviceId: failure.deviceId))
    }

    // MARK: Scheduled tasks and Usage

    private static let taskJSON = #"{"id":"task-laptop","revision":"rev_task_1","name":"Laptop task","enabled":true,"schedule":"0 8 * * *","timezone":"UTC","mode":"llm","permission":"read-only","providerId":"provider-1","modelId":"model-1","prompt":"Summarize","notify":true,"running":false,"createdAt":"2026-08-19T12:00:00.000Z","updatedAt":"2026-08-19T12:00:00.000Z"}"#
    private static let settingsJSON = #"{"revision":"rev-settings","enabled":true,"defaultMode":"llm","defaultPermission":"read-only","defaultMcpEnabled":false,"defaultNotify":true,"defaultTimezone":"UTC"}"#

    private func replyToSchedules(on instanceId: String) {
        responder.reply(instanceId: instanceId, path: "/scheduled-tasks", status: 200, json: Data(#"{"tasks":[\#(Self.taskJSON)]}"#.utf8))
        responder.reply(instanceId: instanceId, path: "/scheduled-tasks/settings", status: 200, json: Data(Self.settingsJSON.utf8))
    }

    private func scheduledCache() -> AidenScheduledTaskCache {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "AidenNewWorkTargetTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        roots.append(root)
        return AidenScheduledTaskCache(root: root)
    }

    func testScheduledTasksReadThePickedMachine() async throws {
        await connectAll()
        replyToSchedules(on: "laptop")
        let model = AidenScheduledTasksModel(
            coordinator: coordinator,
            cache: scheduledCache(),
            machine: AidenNewWorkTarget(instanceId: "laptop")
        )

        await model.load()

        XCTAssertEqual(model.tasks.map(\.id), ["task-laptop"])
        XCTAssertTrue(responder.requests(instanceId: "laptop").contains("GET /scheduled-tasks"))
        XCTAssertFalse(responder.requests(instanceId: "studio").contains("GET /scheduled-tasks"))
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
    }

    func testAScheduledPageStaysOnItsMachineWhenTheDefaultMoves() async throws {
        await connectAll()
        replyToSchedules(on: "laptop")
        let model = AidenScheduledTasksModel(
            coordinator: coordinator,
            cache: scheduledCache(),
            machine: AidenNewWorkTarget(instanceId: "laptop")
        )
        await model.load()

        coordinator.setDefaultMachine("mini")

        XCTAssertTrue(model.isConnected)
        XCTAssertTrue(model.canManageSchedules)
        XCTAssertEqual(model.tasks.map(\.id), ["task-laptop"])
    }

    func testScheduledTasksAskThePickedMachineForAccess() async throws {
        var laptop = AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop")
        laptop.deviceCapabilities.removeAll { $0 == .scheduleRead }
        coordinator = makeCoordinator([AidenDemoHosts.installation(instanceId: "studio", name: "Studio"), laptop])
        await connectAll()

        let model = AidenScheduledTasksModel(
            coordinator: coordinator,
            cache: scheduledCache(),
            machine: AidenNewWorkTarget(instanceId: "laptop")
        )

        XCTAssertFalse(model.canReadSchedules, "The default can read schedules, and that isn't the question")
    }

    func testScheduledTasksWithNoMachineKeepToTheSelectedOne() async throws {
        await connectAll()
        replyToSchedules(on: "studio")
        let model = AidenScheduledTasksModel(coordinator: coordinator, cache: scheduledCache())
        await model.load()
        XCTAssertEqual(model.tasks.map(\.id), ["task-laptop"])

        coordinator.setDefaultMachine("mini")

        XCTAssertFalse(model.isConnected, "The old shell's page ends with the selection")
    }

    private func replyToUsage(on instanceId: String, requests: Int) {
        responder.reply(instanceId: instanceId, path: "/usage", status: 200, json: Data("""
        {"range":"30d","startDate":"2026-07-21","endDate":"2026-08-19",
        "totals":{"requests":\(requests),"completedRequests":\(requests),"failedRequests":0,"cancelledRequests":0,
        "reportedTokenRequests":0,"unmeteredRequests":0,"localRequests":0,"costedRequests":0,
        "unpricedHostedRequests":0,"hostedCostUsd":0,"activeDays":1,"currentStreak":1,"longestStreak":1,
        "tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cacheWrite1h":0,"reasoning":0,"total":0}},
        "days":[],"models":[]}
        """.utf8))
    }

    func testAnOfflineMachineStaysPickableForReading() async throws {
        await connectAll()
        try await takeOffline("laptop")
        let picker = picker(.reading)

        let laptop = try XCTUnwrap(picker.machines.first { $0.id == "laptop" })
        XCTAssertTrue(laptop.canBePicked)
        XCTAssertEqual(laptop.detail, "Offline", "It still says so")

        XCTAssertTrue(picker.pick("laptop"))
        XCTAssertTrue(picker.canStart)
        XCTAssertNil(picker.refusalMessage, "Scheduled and Usage say what they show themselves")
    }

    func testAnOfflineDefaultStaysUsableForReading() async throws {
        await connectAll()
        try await takeOffline("studio")

        let picker = picker(.reading)

        XCTAssertTrue(picker.canStart)
        XCTAssertEqual(picker.pickedMachine?.detail, "Default · Offline")
    }

    func testAnOfflineMachineStillShowsItsCachedScheduledTasks() async throws {
        await connectAll()
        replyToSchedules(on: "laptop")
        let cache = scheduledCache()
        let target = AidenNewWorkTarget(instanceId: "laptop")
        let online = AidenScheduledTasksModel(coordinator: coordinator, cache: cache, machine: target)
        await online.load()
        try await cache.store(instanceId: "laptop", tasks: online.tasks, settings: online.settings)
        try await takeOffline("laptop")
        let picker = picker(.reading)

        XCTAssertTrue(picker.pick("laptop"))
        let model = AidenScheduledTasksModel(coordinator: coordinator, cache: cache, machine: picker.target)
        await model.load()

        XCTAssertEqual(model.tasks.map(\.id), ["task-laptop"])
    }

    func testAPickShowsNoOldUsageBeforeTheNewMachineAnswers() async throws {
        await connectAll()
        replyToUsage(on: "studio", requests: 1)
        let model = AidenMachineUsageModel(coordinator: coordinator, preferences: preferences)
        await model.load()
        XCTAssertEqual(model.usage?.totals.requests, 1)

        model.picker.pick("laptop")

        XCTAssertNil(model.usage, "Another machine's numbers never show under this one's name")
        XCTAssertTrue(model.providers.isEmpty)
        XCTAssertFalse(model.loadFailed)
    }

    func testUsageStartsOnTheDefaultAndReadsThePickedMachine() async throws {
        await connectAll()
        replyToUsage(on: "studio", requests: 1)
        replyToUsage(on: "laptop", requests: 9)
        let model = AidenMachineUsageModel(coordinator: coordinator, preferences: preferences)

        await model.load()
        XCTAssertEqual(model.usage?.totals.requests, 1)

        model.picker.pick("laptop")
        await model.load()

        XCTAssertEqual(model.usage?.totals.requests, 9)
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
    }

    func testAPickedMachineThatFailsShowsNoOtherMachinesUsage() async throws {
        await connectAll()
        replyToUsage(on: "studio", requests: 1)
        responder.reply(instanceId: "laptop", path: "/usage", status: 500, json: Data(#"{"error":{"code":"internal_error","message":"No.","requestId":"request_1","retryable":false}}"#.utf8))
        let model = AidenMachineUsageModel(coordinator: coordinator, preferences: preferences)
        await model.load()

        model.picker.pick("laptop")
        await model.load()

        XCTAssertNil(model.usage)
        XCTAssertTrue(model.loadFailed)
    }

    // MARK: The default machine

    func testTheOldNameForwardsToTheDefaultMachine() async throws {
        await connectAll()

        coordinator.setDefaultMachine("laptop")

        XCTAssertEqual(coordinator.defaultInstanceId, "laptop")
        XCTAssertEqual(coordinator.defaultInstanceId, "laptop")
        XCTAssertEqual(coordinator.installationStore.activeInstallationId, "laptop", "The saved field keeps its name, so nothing migrates")
    }

    func testChangingTheDefaultDisconnectsAndReloadsNothing() async throws {
        await connectAll()
        let owners = try ["studio", "laptop", "mini"].map { try coordinator.ownerContext(for: $0) }
        let requests = ["studio", "laptop", "mini"].map { responder.requests(instanceId: $0) }
        let generations = try ["studio", "laptop", "mini"].map { try connection($0).hostGeneration }
        let workspaces = coordinator.hosts.ordered.map(\.workspaces)

        let outcome = coordinator.setDefaultMachine("laptop")
        await settle()

        guard case .success = outcome else { return XCTFail("Got \(outcome)") }
        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertEqual(coordinator.hosts.ordered.map(\.connectionState), [.connected, .connected, .connected])
        XCTAssertEqual(["studio", "laptop", "mini"].map { responder.requests(instanceId: $0) }, requests, "Nothing is asked of any machine")
        XCTAssertEqual(try ["studio", "laptop", "mini"].map { try connection($0).hostGeneration }, generations)
        XCTAssertEqual(coordinator.hosts.ordered.map(\.workspaces), workspaces)
        XCTAssertTrue(owners.allSatisfy(coordinator.isLive), "Open chats hold owner contexts, and those carry on")
    }

    func testChangingTheDefaultEndsWhatWasBoundToTheSelection() async throws {
        await connectAll()
        let selected = try coordinator.requestContext()

        coordinator.setDefaultMachine("laptop")

        XCTAssertFalse(coordinator.isCurrent(selected), "`isCurrent` still means the selected machine")
        XCTAssertEqual(try coordinator.requestContext().instanceId, "laptop")
    }

    func testChangingTheDefaultWaitsForARunningChange() async throws {
        await connectAll()
        let release = responder.hold(instanceId: "studio", path: "/workspaces")
        let work = Task { await self.coordinator.createWorkspaceOutcome(.folderless(name: "Held")) }
        await assertSettles { self.coordinator.isMutating }

        let outcome = coordinator.setDefaultMachine("laptop")

        guard case .busy = outcome else { return XCTFail("Got \(outcome)") }
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
        release()
        _ = await work.value
    }

    func testAMachineThatLeftCantBecomeTheDefault() async throws {
        await connectAll()
        try connection("laptop").markRevoked()

        let outcome = coordinator.setDefaultMachine("laptop")

        guard case .stale = outcome else { return XCTFail("Got \(outcome)") }
        XCTAssertEqual(coordinator.defaultInstanceId, "studio")
    }

    func testChangingTheDefaultLeavesAConnectRunning() async throws {
        let release = responder.hold(instanceId: "studio", path: "/server")
        defer { release() }
        let studio = try connection("studio")
        let connecting = Task { await studio.connect() }
        await assertSettles { studio.isConnectInFlight }

        coordinator.setDefaultMachine("laptop")
        await settle()

        XCTAssertTrue(studio.isConnectInFlight, "Studio is still a machine the person may be using")
        release()
        await connecting.value
        XCTAssertEqual(studio.connectionState, .connected)
    }

    func testAnOpenBotChatStaysOnItsMachineWhenTheDefaultMoves() async throws {
        let responder = AidenDemoResponder()
        self.responder = responder
        coordinator = AidenDemoHosts.coordinator(.four, responder: responder, machinePreferences: preferences)
        await connectAll()
        let session = AidenComposerSession()
        let botID = "bot_scout"
        let window = try await show(AidenBotSessionChatView(
            coordinator: coordinator,
            botID: botID,
            composerSession: session,
            machine: try XCTUnwrap(coordinator.defaultInstanceId)
        ))
        defer { close(window) }
        await assertSettles({ (session.draftOwner as? AidenBotSessionModel)?.hasLoaded == true }, timeout: 15)
        let opened = try XCTUnwrap(session.draftOwner as? AidenBotSessionModel)
        let next = try XCTUnwrap(coordinator.hosts.ordered.first { $0.instanceId != opened.owner.instanceId })

        coordinator.setDefaultMachine(next.instanceId)
        await settle()

        XCTAssertTrue(session.draftOwner === opened, "The chat keeps its model")
        XCTAssertFalse(
            responder.requests(instanceId: next.instanceId).contains("GET /bots/\(botID)/session"),
            "The chat doesn't start over on the new default"
        )
    }

    func testMovingTheDefaultLeavesAnOpenChatsToolsAlone() async throws {
        await connectAll()
        let before = AidenBotChatToolsSessionIdentity(coordinator: coordinator, owner: "studio")
        let selected = AidenBotChatToolsSessionIdentity(coordinator: coordinator, owner: nil)

        coordinator.setDefaultMachine("laptop")

        XCTAssertEqual(AidenBotChatToolsSessionIdentity(coordinator: coordinator, owner: "studio"), before, "Read aloud keeps going")
        XCTAssertNotEqual(AidenBotChatToolsSessionIdentity(coordinator: coordinator, owner: nil), selected, "The old shell's chat follows the selection")
    }

    func testAnOpenChatsToolsStopWhenItsOwnMachineChanges() async throws {
        await connectAll()
        let before = AidenBotChatToolsSessionIdentity(coordinator: coordinator, owner: "laptop")

        try await takeOffline("laptop")

        XCTAssertNotEqual(AidenBotChatToolsSessionIdentity(coordinator: coordinator, owner: "laptop"), before)
    }

    private func replyToBotCapabilities(on instanceId: String) throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let contract = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let catalog = try XCTUnwrap(contract["botCapabilityCatalog"])
        responder.reply(
            instanceId: instanceId,
            path: "/bot-capabilities",
            status: 200,
            json: try JSONSerialization.data(withJSONObject: catalog)
        )
    }

    /// Bot tools opened with no `machine` follow the default, so moving it takes
    /// Files away. A Bot's chat passes its machine instead
    /// (`testABotsFilesStayWithItsMachineWhenTheDefaultMoves`).
    func testBotToolsWithNoMachineFollowTheDefault() async throws {
        let responder = AidenDemoResponder()
        self.responder = responder
        coordinator = AidenDemoHosts.coordinator(.four, responder: responder, machinePreferences: preferences)
        await connectAll()
        let home = try XCTUnwrap(coordinator.defaultInstanceId)
        try replyToBotCapabilities(on: home)
        let next = try XCTUnwrap(coordinator.hosts.ordered.first { $0.instanceId != home }).instanceId
        let tools = AidenBotChatToolsModel(chatID: "chat_bot_scout", botID: "bot_scout", machine: nil, cache: AidenBotCache(root: botStoreRoot()))
        await tools.load(coordinator: coordinator)
        XCTAssertNotNil(tools.reachableFileGrant(coordinator: coordinator, hostAllowsMutations: true))

        coordinator.setDefaultMachine(next)

        XCTAssertNil(tools.reachableFileGrant(coordinator: coordinator, hostAllowsMutations: true), "A sheet opened now would stay blank")
    }

    /// A Bot's chat keeps its tools on the Bot's own machine, so Files stay
    /// while the default moves away and back, with nothing read again.
    func testABotsFilesStayWithItsMachineWhenTheDefaultMoves() async throws {
        let responder = AidenDemoResponder()
        self.responder = responder
        coordinator = AidenDemoHosts.coordinator(.four, responder: responder, machinePreferences: preferences)
        await connectAll()
        let home = try XCTUnwrap(coordinator.defaultInstanceId)
        try replyToBotCapabilities(on: home)
        let next = try XCTUnwrap(coordinator.hosts.ordered.first { $0.instanceId != home }).instanceId
        let tools = AidenBotChatToolsModel(
            chatID: "chat_bot_scout",
            botID: "bot_scout",
            machine: home,
            cache: AidenBotCache(root: botStoreRoot())
        )
        await tools.load(coordinator: coordinator)
        XCTAssertNotNil(tools.reachableFileGrant(coordinator: coordinator, hostAllowsMutations: true))

        coordinator.setDefaultMachine(next)

        let grant = try XCTUnwrap(tools.reachableFileGrant(coordinator: coordinator, hostAllowsMutations: true))
        XCTAssertEqual(grant.context.instanceId, home)
        XCTAssertTrue(grant.allowsWrites)
        XCTAssertFalse(responder.requests(instanceId: next).contains("GET /bot-capabilities"))
    }

    // MARK: The Settings row

    private func settingsLabels() throws -> [String] {
        Self.setAccessibilityAutomation(true)
        defer { Self.setAccessibilityAutomation(false) }
        let window = try showSynchronously(NavigationStack {
            AidenAppSettingsView(coordinator: coordinator, appearance: AidenAppearanceStore())
        })
        defer { close(window) }
        _ = runMainLoop(until: { accessibleElements(in: window).contains { $0.accessibilityLabel?.contains("Appearance") == true } })
        return accessibleElements(in: window).compactMap(\.accessibilityLabel)
    }

    func testSettingsHasADefaultMachineRow() throws {
        XCTAssertTrue(try settingsLabels().contains { $0.hasPrefix("Default machine") })
    }

    func testTheDefaultRowOffersOfflineMachinesAndKeepsAHiddenDefault() async throws {
        await connectAll()
        try await takeOffline("laptop")
        preferences.update("studio") { $0.isHidden = true }
        preferences.update("mini") { $0.isHidden = true }

        let machines = AidenNewWorkPicker.defaultMachineChoices(coordinator: coordinator, preferences: preferences)

        XCTAssertEqual(machines.map(\.id), ["studio", "laptop"], "The default always shows, and offline is a state, not a reason to refuse")
    }

    // MARK: Helpers

    private func workspaceFixture() throws -> AidenWorkspace {
        try AidenRemoteJSONDecoder.decode(AidenWorkspace.self, from: Data("""
        {"id":"workspace_app","name":"Aiden Agent","permission":"ask","memoryEnabled":true,"hasFolder":true,
        "isManagedWorktree":false,"createdAt":"2026-08-19T19:00:00.000Z",
        "updatedAt":"2026-08-19T19:00:00.000Z","revision":"workspace_revision_7"}
        """.utf8))
    }

    private static func setAccessibilityAutomation(_ enabled: Bool) {
        typealias SetFunction = @convention(c) (Bool) -> Void
        guard let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
              let symbol = dlsym(library, "_AXSSetAutomationEnabled") else { return }
        unsafeBitCast(symbol, to: SetFunction.self)(enabled)
    }

    private func assertSettles(
        _ condition: @escaping @MainActor () -> Bool,
        timeout: TimeInterval = 5,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition(), "Never settled", file: file, line: line)
    }

    /// Long enough for a request or a view's `.task` to have gone out if one was going to.
    private func settle() async {
        try? await Task.sleep(for: .milliseconds(300))
    }

    private func window(showing view: some View) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        window.rootViewController = UIHostingController(rootView: view.environment(AidenHapticCenter()))
        window.makeKeyAndVisible()
        return window
    }

    private func show(_ view: some View) async throws -> UIWindow {
        await assertSettles({ !UIApplication.shared.connectedScenes.isEmpty }, timeout: 30)
        return try window(showing: view)
    }

    private func showSynchronously(_ view: some View) throws -> UIWindow {
        _ = runMainLoop(until: { !UIApplication.shared.connectedScenes.isEmpty }, timeout: 10)
        let window = try window(showing: view)
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        return window
    }

    private func close(_ window: UIWindow) {
        window.isHidden = true
        window.rootViewController = nil
    }

    private func accessibleElements(in root: NSObject) -> [NSObject] {
        var found: [NSObject] = []
        func walk(_ object: NSObject) {
            if object.isAccessibilityElement {
                found.append(object)
                return
            }
            if let elements = object.accessibilityElements {
                elements.compactMap { $0 as? NSObject }.forEach(walk)
            }
            (object as? UIView)?.subviews.forEach(walk)
        }
        walk(root)
        return found
    }

    /// The labels a view gives VoiceOver, once one holding `text` shows.
    private func labels(of view: some View, showing text: String) throws -> [String] {
        Self.setAccessibilityAutomation(true)
        defer { Self.setAccessibilityAutomation(false) }
        let window = try showSynchronously(view)
        defer { close(window) }
        _ = runMainLoop(until: { accessibleElements(in: window).contains { $0.accessibilityLabel?.contains(text) == true } }, timeout: 2)
        return accessibleElements(in: window).compactMap(\.accessibilityLabel)
    }

    private func runMainLoop(until condition: () -> Bool, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }
}

#endif
