#if DEBUG
import Darwin
import Observation
import SwiftUI
import XCTest
@testable import AidenOnTheGo

/// One dock under both conversations: which state it is in, what each state
/// keeps, and what it reads to decide. The models run over the demo machines, so
/// every request is one the contract has.
@MainActor
final class AidenChatDockTests: XCTestCase {
    private let responder = AidenDemoResponder()
    private var root: URL!
    private var coordinator: AidenRemoteCoordinator!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory
            .appending(path: "AidenChatDockTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        Self.setAccessibilityAutomation(true)
    }

    override func tearDown() async throws {
        Self.setAccessibilityAutomation(false)
        try? FileManager.default.removeItem(at: root)
    }

    private static func setAccessibilityAutomation(_ isEnabled: Bool) {
        typealias Setter = @convention(c) (Int32) -> Void
        guard let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
              let symbol = dlsym(library, "_AXSSetAutomationEnabled") else {
            XCTFail("_AXSSetAutomationEnabled is missing, so the accessibility tree can't be read")
            return
        }
        unsafeBitCast(symbol, to: Setter.self)(isEnabled ? 1 : 0)
    }

    private func input(
        isOnline: Bool = true,
        isBot: Bool = false,
        isBusy: Bool = false,
        hasOpenQuestion: Bool = false,
        isScheduledTask: Bool = false,
        cannotRespondReason: String? = nil,
        botFooter: AidenBotFooterKind? = nil
    ) -> AidenDockInput {
        AidenDockInput(
            isOnline: isOnline,
            isBot: isBot,
            isBusy: isBusy,
            hasOpenQuestion: hasOpenQuestion,
            isScheduledTask: isScheduledTask,
            cannotRespondReason: cannotRespondReason,
            botFooter: botFooter
        )
    }

    // MARK: - Decisions

    func testAQuestionReplacesTheComposer() throws {
        XCTAssertEqual(AidenDockContent.resolve(input(isBusy: true, hasOpenQuestion: true)), .question)
        XCTAssertEqual(AidenDockContent.resolve(input(isBot: true, hasOpenQuestion: true)), .question)

        let window = try show(dockHost(content: .question))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { self.element("Pick one", in: window) != nil }), "No question card")
        XCTAssertNil(element("Send message", in: window), "A question takes the composer's place")
    }

    func testAnApprovalKeepsTheComposer() throws {
        try makeCoordinator(.one)
        let model = try chatModel()
        model.streamState = .running
        model.pendingApproval = approval(kind: .action)

        let content = AidenDockContent.resolve(model.dockInput)

        XCTAssertEqual(content, .composer(busy: true))
        XCTAssertTrue(content.keepsComposer)
    }

    func testAScheduledTaskApprovalKeepsTheComposerAndSaysWhatIsWaiting() throws {
        try makeCoordinator(.one)
        let model = try chatModel()
        model.streamState = .running
        model.pendingApproval = approval(kind: .scheduledTask)

        let content = AidenDockContent.resolve(model.dockInput)

        XCTAssertEqual(content, .scheduledTask)
        XCTAssertTrue(content.keepsComposer)
        XCTAssertFalse(try XCTUnwrap(content.notice).text.isEmpty)
    }

    func testStopStaysReachableWhileAQuestionIsOpen() throws {
        var stops = 0
        let window = try show(dockHost(
            content: .question,
            stop: AidenDockStop(label: "Stop", isEnabled: true) { stops += 1 }
        ))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { self.element("Stop", in: window) != nil }), "No Stop beside the question")

        _ = try XCTUnwrap(element("Stop", in: window)).accessibilityActivate()

        XCTAssertTrue(runMainLoop(until: { stops == 1 }))
    }

    /// A card greyed out because its answer is on its way must not take Stop with it.
    func testADisabledQuestionCardLeavesStopWorking() throws {
        var stops = 0
        let window = try show(dockHost(
            content: .question,
            stop: AidenDockStop(label: "Stop", isEnabled: true) { stops += 1 },
            cardIsDisabled: true
        ))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { self.element("Stop", in: window) != nil }))

        _ = try XCTUnwrap(element("Stop", in: window)).accessibilityActivate()

        XCTAssertTrue(runMainLoop(until: { stops == 1 }))
    }

    func testARecordingUnderAQuestionCanBeStopped() async throws {
        let voice = AidenComposerFakeVoice()
        let session = AidenComposerSession(voice: voice)
        await session.toggleVoice()
        let window = try show(dockHost(content: .question, session: session))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { self.element("Stop voice input", in: window) != nil }))

        _ = try XCTUnwrap(element("Stop voice input", in: window)).accessibilityActivate()

        for _ in 0..<300 where session.isRecording { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(session.isRecording, "The recording kept running under the question card")
    }

    func testARecordingLivesThroughEveryStateThatTakesTheComposerAway() async throws {
        let voice = AidenComposerFakeVoice()
        let session = AidenComposerSession(voice: voice)
        await session.toggleVoice()
        let swap = AidenDockSwap()
        let window = try show(AidenDockSwapHost(session: session, swap: swap))
        defer { close(window) }

        for content: AidenDockContent in [.question, .offlineReadOnly, .botFooter(.needsModel), .composer(busy: false)] {
            swap.content = content
            drainMainLoop()
            XCTAssertTrue(session.isRecording, "\(content) ended the recording")
            XCTAssertEqual(voice.discards, 0, "\(content) threw the recording away")
            if !content.keepsComposer {
                XCTAssertNotNil(element("Stop voice input", in: window), "\(content) has no way to end the recording")
            }
        }
    }

    /// A composer that keeps its place keeps its keyboard: moving between the
    /// states that show it must not rebuild it.
    func testTheComposerKeepsItsPlaceAcrossTheStatesThatShowIt() throws {
        let swap = AidenDockSwap()
        let window = try show(AidenDockSwapHost(session: AidenComposerSession(voice: AidenComposerFakeVoice()), swap: swap))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { swap.composerAppearances == 1 }))

        for content: AidenDockContent in [
            .composer(busy: true), .scheduledTask, .cannotRespond("No"), .botFooter(.handoff), .composer(busy: false),
        ] {
            swap.content = content
            drainMainLoop()
        }

        XCTAssertEqual(swap.composerAppearances, 1)
        XCTAssertEqual(swap.composerDisappearances, 0)
    }

    // MARK: - Offline

    func testOfflineChatIsReadOnlyButOfflineBotStillComposes() throws {
        XCTAssertEqual(AidenDockContent.resolve(input(isOnline: false)), .offlineReadOnly)
        XCTAssertEqual(AidenDockContent.resolve(input(isOnline: false, isBot: true)), .composer(busy: false))
        XCTAssertFalse(AidenDockContent.offlineReadOnly.keepsComposer)

        try makeCoordinator(.offlineMix)
        let connection = try XCTUnwrap(coordinator.hosts.connection(for: "laptop"))
        connection.adopt(connectionState: .offline(message: "Not reachable"))
        let model = try chatModel(owner: "laptop")
        XCTAssertEqual(AidenDockContent.resolve(model.dockInput), .offlineReadOnly)
    }

    /// Nothing typed offline is lost, and a Bot's question can't take away its outbox.
    func testAnOfflineBotKeepsComposingWithAQuestionOpen() {
        XCTAssertEqual(
            AidenDockContent.resolve(input(isOnline: false, isBot: true, hasOpenQuestion: true)),
            .composer(busy: false)
        )
    }

    func testAnOfflineChatStillShowsItsQuestion() {
        XCTAssertEqual(AidenDockContent.resolve(input(isOnline: false, hasOpenQuestion: true)), .question)
    }

    func testAProbeOfAnOfflineMachineDoesNotBringTheComposerBack() async throws {
        try makeCoordinator(.offlineMix)
        await coordinator.start()
        let connection = try XCTUnwrap(coordinator.hosts.connection(for: "laptop"))
        connection.adopt(connectionState: .offline(message: "Not reachable"))
        let model = try chatModel(owner: "laptop")
        let held = responder.hold(instanceId: "laptop", path: "/server")

        let probe = Task { await connection.connect(over: .probe) }
        for _ in 0..<300 where connection.connectionState != .connecting { try await Task.sleep(for: .milliseconds(10)) }

        XCTAssertEqual(connection.connectionState, .connecting)
        XCTAssertEqual(AidenDockContent.resolve(model.dockInput), .offlineReadOnly, "The dock flickered on a probe")
        held()
        await probe.value
    }

    func testAMachineStillConnectingKeepsTheComposer() throws {
        try makeCoordinator(.one)
        let model = try chatModel()

        XCTAssertEqual(coordinator.hosts.connection(for: "studio")?.connectionState, .connecting)
        XCTAssertEqual(AidenDockContent.resolve(model.dockInput), .composer(busy: false))
    }

    func testTheDockReadsTheOwnersConnectionNotTheSelection() async throws {
        try makeCoordinator(.four)
        await coordinator.start()
        let model = try chatModel(owner: "laptop")
        await coordinator.switchInstallation(to: "studio")
        XCTAssertEqual(coordinator.connectionState, .connected)

        try XCTUnwrap(coordinator.hosts.connection(for: "laptop"))
            .adopt(connectionState: .offline(message: "Not reachable"))

        XCTAssertEqual(coordinator.connectionState, .connected, "The selected machine stayed up")
        XCTAssertEqual(AidenDockContent.resolve(model.dockInput), .offlineReadOnly)
    }

    // MARK: - Bots

    func testEachBotFooterKindSurvives() {
        for kind in AidenBotFooterKind.allCases {
            let content = AidenDockContent.resolve(input(isBot: true, botFooter: kind))
            XCTAssertEqual(content, .botFooter(kind))
            XCTAssertEqual(content.keepsComposer, kind != .needsModel, "\(kind)")
            XCTAssertNotNil(content.announcement(from: .composer(busy: false)), "\(kind)")
        }
        XCTAssertEqual(AidenBotFooterKind.allCases.count, 5)
    }

    func testABotThatNeedsAModelHasNothingToAnswer() {
        XCTAssertEqual(
            AidenDockContent.resolve(input(isBot: true, hasOpenQuestion: true, botFooter: .needsModel)),
            .botFooter(.needsModel)
        )
    }

    func testTheFooterSpeaksForTheMostBlockingCard() {
        XCTAssertNil(AidenBotFooterKind.leading())
        XCTAssertEqual(AidenBotFooterKind.leading(hasSpendingNotice: true), .spending)
        XCTAssertEqual(AidenBotFooterKind.leading(hasHandoff: true, hasSpendingNotice: true), .handoff)
        XCTAssertEqual(AidenBotFooterKind.leading(isInterrupted: true, hasHandoff: true), .interrupted)
        XCTAssertEqual(AidenBotFooterKind.leading(isPaused: true, isInterrupted: true), .paused)
        XCTAssertEqual(AidenBotFooterKind.leading(needsModel: true, isPaused: true), .needsModel)
    }

    func testABotInputReadsItsOwnersConnection() throws {
        try makeCoordinator(.offlineMix)
        let connection = try XCTUnwrap(coordinator.hosts.connection(for: "laptop"))
        connection.adopt(connectionState: .offline(message: "Not reachable"))
        let model = try botModel(owner: "laptop")

        let offline = model.dockInput(connection: connection, hasSpendingNotice: false)

        XCTAssertTrue(offline.isBot)
        XCTAssertFalse(offline.isOnline)
        XCTAssertEqual(AidenDockContent.resolve(offline), .composer(busy: false))
    }

    func testAPhoneThatCannotWriteToBotsSaysSo() throws {
        var installation = AidenDemoHosts.installation(instanceId: "studio", name: "Studio")
        installation.deviceCapabilities.removeAll { $0 == .botWrite }
        coordinator = AidenDemoHosts.coordinator(installations: [installation], responder: responder)
        let connection = try XCTUnwrap(coordinator.hosts.connection(for: "studio"))
        let model = try botModel(owner: "studio")

        let content = AidenDockContent.resolve(model.dockInput(connection: connection, hasSpendingNotice: false))

        XCTAssertEqual(content, .cannotRespond(AidenDockCopy.cannotMessageBot))
    }

    // MARK: - Machines that can't answer

    func testAnOldHostWithoutRunInputShowsCannotRespondCopy() async throws {
        try makeCoordinator(.oldHost)
        await coordinator.start()
        XCTAssertEqual(coordinator.connectionState, .connected)
        let connection = try XCTUnwrap(coordinator.hosts.connection(for: "studio"))
        XCTAssertFalse(try XCTUnwrap(connection.server).supportsChatRunInput)
        let model = try chatModel()

        XCTAssertEqual(AidenDockContent.resolve(model.dockInput), .composer(busy: false), "Idle, it takes a message")

        model.streamState = .running
        let content = AidenDockContent.resolve(model.dockInput)
        XCTAssertEqual(content, .cannotRespond(AidenDockCopy.noRunInput))
        XCTAssertTrue(content.keepsComposer, "The composer holds the draft and Stop")
    }

    func testAHostWithRunInputKeepsTheBusyComposer() async throws {
        try makeCoordinator(.one)
        await coordinator.start()
        let model = try chatModel()

        model.streamState = .running

        XCTAssertEqual(AidenDockContent.resolve(model.dockInput), .composer(busy: true))
    }

    func testAnOldHostStillShowsAQuestionItCanTakeAnAnswerTo() async throws {
        try makeCoordinator(.oldHost)
        await coordinator.start()
        let model = try chatModel()
        model.streamState = .running
        model.pendingQuestion = Self.question

        XCTAssertEqual(AidenDockContent.resolve(model.dockInput), .question)
    }

    func testARevokedMachineStillOutranksAQuestion() async throws {
        try makeCoordinator(.four)
        await coordinator.start()
        let model = try chatModel(owner: "laptop")
        model.setViewPresent(true)
        await coordinator.switchInstallation(to: "studio")
        try XCTUnwrap(coordinator.hosts.connection(for: "laptop")).markRevokedWithPurgePending()
        model.pendingQuestion = Self.question

        XCTAssertEqual(AidenDockContent.resolve(model.dockInput), .cannotRespond(AidenDockCopy.machineRevoked))
        model.setViewPresent(false)
    }

    func testARevokedMachineCannotRespond() async throws {
        try makeCoordinator(.four)
        await coordinator.start()
        let model = try chatModel(owner: "laptop")
        model.setViewPresent(true)
        await coordinator.switchInstallation(to: "studio")
        for path in ["/chats/c1", "/chats/c1/messages"] {
            responder.reply(instanceId: "laptop", path: path, status: 401, json: Self.revokedJSON)
        }

        await model.load(observeProgress: false)

        XCTAssertEqual(AidenDockContent.resolve(model.dockInput), .cannotRespond(AidenDockCopy.machineRevoked))
        let controls = AidenComposerView.controls(for: model)
        XCTAssertTrue(controls.fieldIsDisabled)
        XCTAssertFalse(controls.micIsEnabled, "Dictating into a field that can't send")
        model.setViewPresent(false)
    }

    func testASendOnARevokedMachineBringsTheDraftBack() async throws {
        try makeCoordinator(.four)
        await coordinator.start()
        transcript(on: "laptop")
        let model = try chatModel(owner: "laptop")
        model.setViewPresent(true)
        await model.load(observeProgress: false)
        await coordinator.switchInstallation(to: "studio")
        try XCTUnwrap(coordinator.hosts.connection(for: "laptop")).adopt(connectionState: .connected)
        responder.reply(
            instanceId: "laptop",
            method: "POST",
            path: "/chats/c1/turns",
            status: 401,
            json: Self.revokedJSON
        )
        let before = model.chat.messages.count
        model.draft = "Keep these words"

        await model.send()

        XCTAssertEqual(try XCTUnwrap(coordinator.hosts.connection(for: "laptop")).isPurgePending, true)
        XCTAssertEqual(model.draft, "Keep these words")
        XCTAssertEqual(model.chat.messages.count, before, "The bubble of a send that failed stayed")
        XCTAssertNil(model.streamState, "The chat still reads as sending")
        XCTAssertNil(model.pendingSend, "A revoked machine can't take a retry")
        XCTAssertEqual(model.presentedError, AidenDockCopy.machineRevoked)
        XCTAssertEqual(AidenDockContent.resolve(model.dockInput), .cannotRespond(AidenDockCopy.machineRevoked))
        model.setViewPresent(false)
    }

    func testARunInputOnARevokedMachineBringsTheDraftBack() async throws {
        try makeCoordinator(.four)
        await coordinator.start()
        transcript(on: "laptop")
        let store = AidenChatDraftStore(root: root.appending(path: "drafts", directoryHint: .isDirectory))
        let model = try chatModel(owner: "laptop", draftStore: store)
        model.setViewPresent(true)
        await model.load(observeProgress: false)
        await coordinator.switchInstallation(to: "studio")
        await reachOwner("laptop")
        responder.reply(
            instanceId: "laptop",
            method: "POST",
            path: "/streams/stream_1/inputs",
            status: 401,
            json: Self.revokedJSON
        )
        model.streamState = .running
        model.activeStreamID = "stream_1"
        model.draft = "Keep these words"
        XCTAssertTrue(model.canSubmitRunInput)

        await model.submitRunInput(.steer)

        XCTAssertEqual(try XCTUnwrap(coordinator.hosts.connection(for: "laptop")).isPurgePending, true)
        XCTAssertEqual(model.draft, "Keep these words")
        XCTAssertNil(model.pendingSend, "A revoked machine can't take a retry")
        XCTAssertEqual(model.presentedError, AidenDockCopy.machineRevoked)
        let session = await store.beginSession(instanceId: "laptop", chatId: "c1")
        let saved = try await store.loadPendingSend(session: session, deviceId: model.owner.deviceId)
        XCTAssertNil(saved, "The refused input would be offered again")
        model.setViewPresent(false)
    }

    /// A retry's words are in the pending send and nowhere else.
    func testARetriedRunInputOnARevokedMachineKeepsItsWords() async throws {
        try makeCoordinator(.four)
        await coordinator.start()
        transcript(on: "laptop")
        let model = try chatModel(owner: "laptop")
        model.setViewPresent(true)
        await model.load(observeProgress: false)
        await coordinator.switchInstallation(to: "studio")
        await reachOwner("laptop")
        responder.reply(instanceId: "laptop", method: "POST", path: "/streams/stream_1/inputs", status: 503, json: Data("{}".utf8))
        model.streamState = .running
        model.activeStreamID = "stream_1"
        model.draft = "Keep these words"
        await model.submitRunInput(.steer)
        XCTAssertNotNil(model.pendingSend)
        model.draft = ""
        XCTAssertTrue(model.canRetrySend)
        responder.reply(instanceId: "laptop", method: "POST", path: "/streams/stream_1/inputs", status: 401, json: Self.revokedJSON)

        await model.send(retry: true)

        XCTAssertNil(model.pendingSend)
        XCTAssertEqual(model.draft, "Keep these words", "The only copy of the words was settled away")
        model.setViewPresent(false)
    }

    func testASendOnARevokedSelectedMachineStillEndsWithTheMachine() async throws {
        try makeCoordinator(.four)
        await coordinator.start()
        transcript(on: "studio")
        let model = try chatModel(owner: "studio")
        await model.load(observeProgress: false)
        responder.reply(
            instanceId: "studio",
            method: "POST",
            path: "/chats/c1/turns",
            status: 401,
            json: Self.revokedJSON
        )
        model.draft = "Gone with the machine"

        await model.send()

        XCTAssertNil(coordinator.hosts.connection(for: "studio"), "The selected machine's data leaves at once")
        XCTAssertNotEqual(coordinator.activeInstanceId, "studio")
    }

    // MARK: - VoiceOver

    func testANewDecisionAnnouncesToVoiceOver() {
        let announcement = AidenDockContent.question.announcement(from: .composer(busy: true))
        XCTAssertFalse(try XCTUnwrap(announcement).isEmpty)
        XCTAssertNil(AidenDockContent.question.announcement(from: .question), "Nothing new to say")
    }

    func testARunStartingOrEndingIsNotADecision() {
        XCTAssertNil(AidenDockContent.composer(busy: true).announcement(from: .composer(busy: false)))
        XCTAssertNil(AidenDockContent.composer(busy: false).announcement(from: .composer(busy: true)))
        XCTAssertNil(AidenDockContent.composer(busy: false).announcement(from: .question))
    }

    func testEveryStateThatChangesWhatTheComposerCanDoSpeaks() {
        let states: [AidenDockContent] = [.scheduledTask, .cannotRespond("Why"), .offlineReadOnly]
        for state in states {
            XCTAssertFalse(state.announcement(from: .composer(busy: false))?.isEmpty ?? true, "\(state)")
        }
    }

    // MARK: - The transcript stays out of it

    /// Reading the input registers what it depends on, the way a view body does.
    /// A token that touched any of it would re-run the screen around the transcript.
    func testAChatsTokensNeverTouchTheDockInput() throws {
        try makeCoordinator(.one)
        let model = try chatModel()
        model.streamState = .running
        var changed = false
        let before = withObservationTracking {
            model.dockInput
        } onChange: {
            changed = true
        }

        model.replaceLiveText("A token")
        model.replaceLiveText("A token, then another")

        XCTAssertFalse(changed, "A token changed something the dock reads")
        XCTAssertEqual(model.dockInput, before)
    }

    func testABotsTokensNeverTouchTheDockInput() async throws {
        try makeCoordinator(.one)
        await coordinator.start()
        let session = #"{"botId":"bot_demo","epoch":"epoch_a","seq":4,"state":"running","interrupted":false,"entries":[],"hasOlder":false,"question":null,"approval":null}"#
        responder.reply(instanceId: "studio", path: "/bots/bot_demo/session", status: 200, json: Data(session.utf8))
        let model = try botModel(owner: "studio")
        await model.load()
        XCTAssertTrue(model.isRunning)
        let connection = coordinator.hosts.connection(for: "studio")
        var changed = false
        let before = withObservationTracking {
            model.dockInput(connection: connection, hasSpendingNotice: false)
        } onChange: {
            changed = true
        }

        _ = await model.apply(AidenBotSessionEvent(botId: "bot_demo", epoch: "epoch_a", seq: 5, kind: .partial("A token")))
        _ = await model.apply(AidenBotSessionEvent(botId: "bot_demo", epoch: "epoch_a", seq: 6, kind: .partial("A token, then another")))

        XCTAssertEqual(model.partial, "A token, then another")
        XCTAssertFalse(changed, "A token changed something the dock reads")
        XCTAssertEqual(model.dockInput(connection: connection, hasSpendingNotice: false), before)
    }

    // MARK: - The session sheet

    func testTheSessionSheetKeepsEveryExistingAction() throws {
        let chat = AidenSessionSheetConfig.chat(
            title: "Plans",
            canRename: true,
            canFork: true,
            canReadAloud: true,
            isReadingAloud: false,
            hasFiles: true
        )
        XCTAssertEqual(chat.actions, [.rename, .fork, .readAloud, .files])

        let window = try show(AidenSessionSheet(config: chat, actions: AidenSessionActions { _ in }))
        defer { close(window) }
        for label in ["Rename", "Fork", "Read response aloud", "Files"] {
            XCTAssertTrue(runMainLoop(until: { self.element(label, in: window) != nil }), "No \(label)")
        }
        let labels = accessibleElements(in: window).compactMap(\.accessibilityLabel)
        XCTAssertFalse(labels.contains { $0.localizedCaseInsensitiveContains("mute") }, "No data behind Mute")
        XCTAssertFalse(labels.contains { $0.localizedCaseInsensitiveContains("context") }, "No host supplies context %")
    }

    func testTheBotSheetKeepsEveryActionOfItsMenu() {
        XCTAssertEqual(
            AidenSessionSheetConfig.bot(title: "Bot", hasFiles: true, hasMemory: true, canDelete: true, isDeleting: false).actions,
            [.profile, .files, .memory, .advanced, .delete]
        )
        XCTAssertEqual(
            AidenSessionSheetConfig.bot(title: "Bot", hasFiles: false, hasMemory: false, canDelete: false, isDeleting: false).actions,
            [.profile, .advanced]
        )
    }

    func testABotChatKeepsItsMenuAndGainsReadAloud() {
        XCTAssertEqual(
            AidenSessionSheetConfig.botChat(
                title: "Bot",
                hasFiles: true,
                canDelete: true,
                canReadAloud: true,
                isReadingAloud: false
            ).actions,
            [.readAloud, .profile, .files, .delete]
        )
    }

    func testEachSheetRowSaysWhichActionItRuns() throws {
        var ran: [AidenSessionAction] = []
        let config = AidenSessionSheetConfig.bot(title: "Bot", hasFiles: true, hasMemory: true, canDelete: true, isDeleting: false)
        let window = try show(AidenSessionSheet(config: config, actions: AidenSessionActions { ran.append($0) }))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { self.element("Memory", in: window) != nil }))

        _ = try XCTUnwrap(element("Memory", in: window)).accessibilityActivate()

        XCTAssertTrue(runMainLoop(until: { ran == [.memory] }))
    }

    func testReadAloudReadsAsStopWhilePlaying() {
        let config = AidenSessionSheetConfig.chat(
            title: "Plans",
            canRename: false,
            canFork: false,
            canReadAloud: true,
            isReadingAloud: true,
            hasFiles: false
        )
        XCTAssertEqual(config.title(for: .readAloud), "Stop reading aloud")
    }

    func testAnOpenChatRenamesOnItsOwnMachine() async throws {
        try makeCoordinator(.four)
        await coordinator.start()
        transcript(on: "laptop")
        let model = try chatModel(owner: "laptop")
        await model.load(observeProgress: false)
        await coordinator.switchInstallation(to: "studio")
        try XCTUnwrap(coordinator.hosts.connection(for: "laptop")).adopt(connectionState: .connected)
        responder.reply(
            instanceId: "laptop",
            method: "PATCH",
            path: "/chats/c1",
            status: 200,
            json: Self.chatJSON(title: "New name", revision: "r9")
        )

        await model.rename(to: "  New name  ")

        XCTAssertEqual(model.chat.displayTitle, "New name")
        XCTAssertEqual(model.chat.revision, "r9")
        XCTAssertNil(model.presentedError)
        XCTAssertFalse(responder.requests(instanceId: "studio").contains { $0.hasPrefix("PATCH") }, "Renamed on the wrong machine")
    }

    func testARefusedRenamePutsTheTitleBack() async throws {
        try makeCoordinator(.one)
        await coordinator.start()
        transcript(on: "studio")
        let model = try chatModel()
        await model.load(observeProgress: false)
        let title = model.chat.displayTitle
        responder.reply(
            instanceId: "studio",
            method: "PATCH",
            path: "/chats/c1",
            status: 412,
            json: Data(#"{"error":{"code":"revision_conflict","message":"Refresh and try again.","requestId":"r","retryable":false}}"#.utf8)
        )

        await model.rename(to: "New name")

        XCTAssertEqual(model.chat.displayTitle, title)
        XCTAssertNotNil(model.presentedError)
    }

    /// The cache refuses a receipt only once the chat is removed, so a refusal
    /// reaches neither the chat's revision nor the list.
    func testARenameOfAChatRemovedMeanwhileReachesNoList() async throws {
        try makeCoordinator(.one)
        await coordinator.start()
        transcript(on: "studio")
        let cache = AidenChatCache(root: root.appending(path: "chats", directoryHint: .isDirectory))
        var published: [AidenChat] = []
        let model = try chatModel(cache: cache) { published.append($0) }
        await model.load(observeProgress: false)
        published = []
        let revision = model.chat.revision
        responder.reply(
            instanceId: "studio",
            method: "PATCH",
            path: "/chats/c1",
            status: 200,
            json: Self.chatJSON(title: "New name", revision: "r9")
        )
        let release = responder.hold(instanceId: "studio", path: "/chats/c1")

        let renaming = Task { await model.rename(to: "New name") }
        for _ in 0..<300 where !responder.requests(instanceId: "studio").contains("PATCH /chats/c1") {
            try await Task.sleep(for: .milliseconds(10))
        }
        await cache.removeChat(instanceId: "studio", chatId: "c1")
        release()
        await renaming.value

        XCTAssertEqual(model.chat.revision, revision)
        XCTAssertTrue(published.isEmpty, "A receipt the cache refused reached the list")
    }

    func testARenameRefusedByRevocationPutsTheTitleBack() async throws {
        try makeCoordinator(.four)
        await coordinator.start()
        transcript(on: "laptop")
        let model = try chatModel(owner: "laptop")
        model.setViewPresent(true)
        await model.load(observeProgress: false)
        await coordinator.switchInstallation(to: "studio")
        try XCTUnwrap(coordinator.hosts.connection(for: "laptop")).adopt(connectionState: .connected)
        let title = model.chat.displayTitle
        responder.reply(instanceId: "laptop", method: "PATCH", path: "/chats/c1", status: 401, json: Self.revokedJSON)

        await model.rename(to: "New name")

        XCTAssertEqual(try XCTUnwrap(coordinator.hosts.connection(for: "laptop")).isPurgePending, true)
        XCTAssertEqual(model.chat.displayTitle, title)
        model.setViewPresent(false)
    }

    // MARK: - Spending

    func testAllowMoreGoesToTheMachineThatOwnsTheChat() async throws {
        try makeCoordinator(.four)
        await coordinator.start()
        transcript(on: "laptop")
        let model = try chatModel(owner: "laptop")
        await model.load(observeProgress: false)
        await coordinator.switchInstallation(to: "studio")
        await reachOwner("laptop")
        for id in ["laptop", "studio"] {
            let connection = try XCTUnwrap(coordinator.hosts.connection(for: id))
            connection.adopt(server: try Self.withSpendingLimits(XCTUnwrap(connection.server)))
            connection.adopt(connectionState: .connected)
            responder.reply(instanceId: id, path: "/chats/c1/spending", status: 200, json: Data(#"{"spending":null}"#.utf8))
        }

        let transport = try XCTUnwrap(model.spendingTransport)
        _ = try await transport.spending(owner: .chat("c1"))

        XCTAssertTrue(responder.requests(instanceId: "laptop").contains("GET /chats/c1/spending"))
        XCTAssertFalse(responder.requests(instanceId: "studio").contains("GET /chats/c1/spending"), "Asked the selected machine")
    }

    func testNoSpendingTransportWhenTheOwnerHasNoLimitsButTheSelectionDoes() async throws {
        try makeCoordinator(.four)
        await coordinator.start()
        let model = try chatModel(owner: "laptop")
        await coordinator.switchInstallation(to: "studio")
        await reachOwner("laptop")
        let studio = try XCTUnwrap(coordinator.hosts.connection(for: "studio"))
        studio.adopt(server: try Self.withSpendingLimits(XCTUnwrap(studio.server)))

        XCTAssertNil(model.spendingTransport)
    }

    func testTheSheetForksFromTheLatestReply() throws {
        try makeCoordinator(.one)
        let model = try chatModel()
        XCTAssertNil(model.latestForkableMessageID, "Nothing to fork from yet")

        let date = Date(timeIntervalSince1970: 1_793_000_000)
        let talked = try chatModel(messages: [
            AidenChatMessage(id: "m1", role: .user, text: "Hi", createdAt: date),
            AidenChatMessage(id: "m2", role: .assistant, text: "Hello", createdAt: date),
            AidenChatMessage(id: "m3", role: .user, text: "Again", createdAt: date),
        ])

        XCTAssertEqual(talked.latestForkableMessageID, "m2")
    }

    // MARK: - Harness

    private static let revokedJSON = Data(
        #"{"error":{"code":"credential_revoked","message":"Pair this device again.","requestId":"revoked","retryable":false}}"#.utf8
    )

    /// A machine that isn't selected only knows its server once it's been reached.
    private func reachOwner(_ instanceId: String) async {
        await coordinator.hosts.connection(for: instanceId)?.connect(over: .probe)
    }

    /// The same server, advertising spending limits.
    private static func withSpendingLimits(_ server: AidenServer) throws -> AidenServer {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(server)) as? [String: Any])
        object["features"] = ((object["features"] as? [String]) ?? []) + [AidenServer.spendingLimitsFeature]
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(AidenServer.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// Answers both transcript routes, for machines with and without windows.
    private func transcript(on instanceId: String) {
        for path in ["/chats/c1", "/chats/c1/messages"] {
            responder.reply(instanceId: instanceId, path: path, status: 200, json: Self.chatJSON(title: "Same chat", revision: "r1"))
        }
    }

    private static func chatJSON(title: String, revision: String) -> Data {
        let object: [String: Any] = [
            "id": "c1",
            "workspaceId": "workspace_app",
            "title": title,
            "createdAt": "2026-11-05T09:00:00.000Z",
            "updatedAt": "2026-11-05T09:00:01.000Z",
            "revision": revision,
            "messages": [],
        ]
        // Built from the literals above.
        return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func makeCoordinator(_ scenario: AidenDemoScenario) throws {
        coordinator = AidenDemoHosts.coordinator(scenario, responder: responder)
    }

    private func chatModel(
        owner instanceId: String = "studio",
        messages: [AidenChatMessage] = [],
        cache: AidenChatCache? = nil,
        draftStore: AidenChatDraftStore? = nil,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in }
    ) throws -> AidenChatViewModel {
        let date = Date(timeIntervalSince1970: 1_793_000_000)
        return AidenChatViewModel(
            coordinator: coordinator,
            chat: AidenChat(
                id: "c1", workspaceId: "workspace_app", title: "Same chat", providerId: nil, modelId: nil,
                messages: messages, createdAt: date, updatedAt: date, revision: "r0"
            ),
            owner: try coordinator.ownerContext(for: instanceId),
            cache: cache ?? AidenChatCache(root: root.appending(path: "chats", directoryHint: .isDirectory)),
            draftStore: draftStore ?? AidenChatDraftStore(root: root.appending(path: "drafts", directoryHint: .isDirectory)),
            modelPreferenceStore: AidenModelPreferenceStore(defaults: AidenDemoHosts.isolatedDefaults()),
            visualDocumentCache: AidenVisualDocumentCache(root: root.appending(path: "visuals", directoryHint: .isDirectory)),
            onChatUpdated: onChatUpdated
        )
    }

    private func botModel(owner instanceId: String) throws -> AidenBotSessionModel {
        let context = try coordinator.ownerContext(for: instanceId)
        return AidenBotSessionModel(
            botID: "bot_demo",
            transport: try coordinator.remoteClient(for: context),
            owner: context,
            outboxStore: nil
        )
    }

    private func approval(kind: AidenApprovalKind) -> AidenPendingApproval {
        AidenPendingApproval(
            id: "approval",
            summary: "Run it",
            expiresAt: .distantFuture,
            kind: kind,
            canRespond: true,
            hasRequiredWriteCapability: true,
            hostCanAllow: true,
            canAllow: true
        )
    }

    private func dockHost(
        content: AidenDockContent,
        session: AidenComposerSession? = nil,
        stop: AidenDockStop? = nil,
        cardIsDisabled: Bool = false
    ) -> some View {
        let session = session ?? AidenComposerSession(voice: AidenComposerFakeVoice())
        return AidenChatDock(
            content: content,
            session: session,
            config: .chat(model: nil),
            actions: AidenDockActions(stop: stop),
            slots: AidenDockSlots(question: { stop in
                AidenQuestionCard(prompt: Self.question, stop: stop, onSubmit: { _ in })
                    .disabled(cardIsDisabled)
            })
        )
    }

    private static let question = AidenPendingQuestion(
        id: "question",
        questions: [AidenRemoteQuestion(
            question: "Pick one",
            header: "Choice",
            multiSelect: false,
            options: [AidenRemoteQuestionOption(label: "First", description: "The first one")]
        )],
        expiresAt: .distantFuture,
        canRespond: true
    )

    private func element(_ label: String, in window: UIWindow) -> NSObject? {
        accessibleElements(in: window).first { $0.accessibilityLabel == label }
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

    private func show(_ view: some View, width: CGFloat = 390) throws -> UIWindow {
        func connectedScene() -> UIWindowScene? {
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        }
        _ = runMainLoop(until: { connectedScene() != nil }, timeout: 30)
        let scene = try XCTUnwrap(connectedScene())
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 800)
        window.rootViewController = UIHostingController(rootView: view.environment(AidenHapticCenter()))
        window.makeKeyAndVisible()
        return window
    }

    private func close(_ window: UIWindow) {
        window.isHidden = true
        window.rootViewController = nil
    }

    private func runMainLoop(until condition: () -> Bool, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }

    private func drainMainLoop() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    }
}

@MainActor
@Observable
private final class AidenDockSwap {
    var content = AidenDockContent.composer(busy: false)
    var composerAppearances = 0
    var composerDisappearances = 0
}

private struct AidenDockSwapHost: View {
    let session: AidenComposerSession
    let swap: AidenDockSwap

    var body: some View {
        AidenChatDock(
            content: swap.content,
            session: session,
            config: .chat(model: nil),
            actions: AidenDockActions(),
            slots: AidenDockSlots(composer: { config in
                AidenComposerSurface(session: session, config: config, onSend: {}, onStop: nil)
                    .onAppear { swap.composerAppearances += 1 }
                    .onDisappear { swap.composerDisappearances += 1 }
            })
        )
    }
}
#endif
