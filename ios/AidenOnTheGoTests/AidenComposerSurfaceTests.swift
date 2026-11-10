import Darwin
import Observation
import SwiftUI
import XCTest
@testable import AidenOnTheGo

/// The composer view comes and goes (a question card takes its place); what the
/// person is doing in it belongs to the conversation.
@MainActor
final class AidenComposerSurfaceTests: XCTestCase {
    /// Below the accessibility sizes the chip keeps one line. At the largest
    /// standard size it drops the level rather than cut the model short, and at
    /// the default size it shows both whole.
    func testTheModelChipDropsTheLevelBeforeCuttingTheModel() throws {
        func drawn(_ fit: AidenComposerModelChipLabel.Fit?, at size: DynamicTypeSize) throws -> Data {
            let chip = AidenComposerModelChipLabel(
                provider: nil, modelID: nil, modelLabel: "Claude Sonnet 4.5", thinkingLevel: "medium", fit: fit
            )
            // About what a phone's control row leaves the chip beside the attach,
            // microphone and send buttons, less the provider icon.
            .frame(width: 200, alignment: .leading)
            .dynamicTypeSize(size)
            let renderer = ImageRenderer(content: chip)
            renderer.scale = 2
            return try XCTUnwrap(renderer.uiImage?.pngData(), "The chip drew nothing")
        }

        XCTAssertEqual(try drawn(nil, at: .xxxLarge), try drawn(.model, at: .xxxLarge), "At XXXL the chip cut the model short")
        XCTAssertNotEqual(try drawn(.model, at: .xxxLarge), try drawn(.shortened, at: .xxxLarge))
        XCTAssertEqual(try drawn(nil, at: .large), try drawn(.full, at: .large), "At the default size the level went missing")
    }


    override func setUp() {
        super.setUp()
        Self.setAccessibilityAutomation(true)
    }

    override func tearDown() {
        Self.setAccessibilityAutomation(false)
        super.tearDown()
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

    // MARK: - Input state outlives the view

    func testRecordingSurvivesTheComposerLeavingTheHierarchy() async throws {
        let voice = AidenComposerFakeVoice()
        let session = AidenComposerSession(voice: voice)
        let swap = AidenComposerSwap()
        let window = try show(AidenComposerSwapHost(session: session, swap: swap))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { swap.appearances == 1 }))

        await session.toggleVoice()
        XCTAssertTrue(session.isRecording)

        swap.showsComposer = false
        XCTAssertTrue(runMainLoop(until: { swap.disappearances == 1 }))
        drainMainLoop()

        XCTAssertTrue(session.isRecording, "Swapping the composer away must leave the recording running")
        XCTAssertEqual(voice.discards, 0)

        session.stopVoice()
        XCTAssertFalse(session.isRecording)
        XCTAssertEqual(voice.discards, 1)
    }

    func testAttachmentPrepKeepsRunningThroughAQuestionCard() throws {
        let owner = AidenComposerFakeAttachments()
        owner.isPreparingAttachments = true
        let session = AidenComposerSession(attachmentOwner: owner)
        let swap = AidenComposerSwap()
        let window = try show(AidenComposerSwapHost(session: session, swap: swap))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { swap.appearances == 1 }))

        swap.showsComposer = false
        XCTAssertTrue(runMainLoop(until: { swap.disappearances == 1 }))
        drainMainLoop()
        XCTAssertTrue(session.isPreparingAttachments, "A question card must not cancel preparation")
        XCTAssertEqual(owner.cancellations, 0)

        swap.showsComposer = true
        XCTAssertTrue(runMainLoop(until: { swap.appearances == 2 }))
        XCTAssertTrue(session.isPreparingAttachments)
    }

    func testDiscardingDropsPreparationAndKeepsWhatIsAlreadyStaged() {
        let owner = AidenComposerFakeAttachments()
        owner.isPreparingAttachments = true
        owner.pendingAttachments = [Self.attachment]
        let session = AidenComposerSession(attachmentOwner: owner)

        session.discardAttachments()

        XCTAssertFalse(session.isPreparingAttachments)
        XCTAssertEqual(owner.cancellations, 1)
        XCTAssertEqual(session.attachments, [Self.attachment])
    }

    func testLeavingLosesAttachmentsThatAreStagedOrStillBeingPrepared() {
        let owner = AidenComposerFakeAttachments()
        let session = AidenComposerSession(text: "Words stay", attachmentOwner: owner)
        XCTAssertFalse(session.holdsAttachments)

        owner.isPreparingAttachments = true
        XCTAssertTrue(session.holdsAttachments)

        owner.isPreparingAttachments = false
        owner.pendingAttachments = [Self.attachment]
        XCTAssertTrue(session.holdsAttachments)
    }

    // MARK: - Words go to whoever saves them

    func testASessionWithoutAnOwnerKeepsItsOwnWords() {
        let session = AidenComposerSession(text: "Hello", attachments: [Self.attachment])

        session.text += " there"

        XCTAssertEqual(session.text, "Hello there")
        XCTAssertEqual(session.attachments, [Self.attachment])
        XCTAssertTrue(session.hasContent)
    }

    func testTheOwnersDraftIsTheOnlyCopyOfTheText() {
        let owner = AidenComposerFakeDraft()
        owner.draft = "Saved earlier"
        let session = AidenComposerSession(draftOwner: owner)
        XCTAssertEqual(session.text, "Saved earlier")

        session.text = "Typed here"
        XCTAssertEqual(owner.draft, "Typed here")

        owner.draft = ""
        XCTAssertEqual(session.text, "", "A send clears the model's draft; the composer must show that")
    }

    func testADictatedTranscriptReachesTheOwnersDraft() async {
        let owner = AidenComposerFakeDraft()
        owner.draft = "Please"
        let voice = AidenComposerFakeVoice()
        let session = AidenComposerSession(draftOwner: owner, voice: voice)

        await session.toggleVoice()
        XCTAssertEqual(voice.startedWithDraft, "Please")
        voice.speak("Please summarize")

        XCTAssertEqual(owner.draft, "Please summarize")
        XCTAssertEqual(session.text, "Please summarize")
    }

    func testTogglingWhileRecordingEndsTheRecordingAndKeepsTheTranscript() async {
        let voice = AidenComposerFakeVoice()
        let session = AidenComposerSession(voice: voice)

        await session.toggleVoice()
        await session.toggleVoice()

        XCTAssertFalse(session.isRecording)
        XCTAssertEqual(voice.discards, 0, "The mic's own stop keeps what was said")
    }

    // MARK: - Leaving the conversation

    func testLeavingTheChatStopsVoiceAndDropsPreparation() async throws {
        let voice = AidenComposerFakeVoice()
        let owner = AidenComposerFakeAttachments()
        owner.isPreparingAttachments = true
        let session = AidenComposerSession(attachmentOwner: owner, voice: voice)
        let host = AidenChatDetailHost(session: session)
        let window = try show(AidenChatDetailHostView(host: host))
        defer { close(window) }
        drainMainLoop()
        await session.toggleVoice()
        XCTAssertTrue(session.isRecording)

        host.showsChat = false

        XCTAssertTrue(runMainLoop(until: { !session.isRecording }), "A hot mic must not outlive the chat")
        XCTAssertEqual(owner.cancellations, 1)
    }

    func testBackgroundingStopsVoiceEvenWithTheComposerAway() async throws {
        let voice = AidenComposerFakeVoice()
        let session = AidenComposerSession(voice: voice)
        let host = AidenChatDetailHost(session: session)
        let window = try show(AidenChatDetailHostView(host: host))
        defer { close(window) }
        drainMainLoop()
        await session.toggleVoice()

        host.scenePhase = .inactive
        drainMainLoop()
        XCTAssertTrue(session.isRecording, "A passing inactive state keeps the recording")

        host.scenePhase = .background
        XCTAssertTrue(runMainLoop(until: { !session.isRecording }))
    }

    func testReadAloudStillTakesTheMicFromTheChat() async throws {
        let voice = AidenComposerFakeVoice()
        let session = AidenComposerSession(voice: voice)
        let window = try show(AidenChatDetailHostView(host: AidenChatDetailHost(session: session)))
        defer { close(window) }
        drainMainLoop()
        await session.toggleVoice()

        NotificationCenter.default.post(name: .aidenStopDictationForReadAloud, object: nil)

        XCTAssertTrue(runMainLoop(until: { !session.isRecording }))
    }

    // MARK: - Config

    func testBotConfigNeverShowsAModelChip() throws {
        XCTAssertFalse(AidenComposerConfig.bot().showsModelChip)

        let offered = AidenComposerChipProbe()
        let chat = try show(AidenComposerChipHost(config: .chat(model: "Sonnet"), probe: offered))
        defer { close(chat) }
        XCTAssertTrue(runMainLoop(until: { offered.appearances > 0 }), "The probe must be able to see a chip")

        let refused = AidenComposerChipProbe()
        let bot = try show(AidenComposerChipHost(config: .bot(), probe: refused))
        defer { close(bot) }
        drainMainLoop()
        XCTAssertEqual(refused.appearances, 0)
    }

    func testAChatWithoutAModelToNameHasNoChip() {
        XCTAssertTrue(AidenComposerConfig.chat(model: "Sonnet").showsModelChip)
        XCTAssertFalse(AidenComposerConfig.chat(model: nil).showsModelChip)
    }

    // MARK: - Height

    func testTheComposerHeightStopsAtMaxLines() {
        func height(_ lines: Int) -> CGFloat {
            AidenComposerLayout.fieldHeight(lineCount: lines, lineHeight: 22, verticalInset: 12, maxLines: 6)
        }

        XCTAssertEqual(height(1), 46)
        XCTAssertEqual(height(6), 156)
        XCTAssertEqual(height(7), height(6))
        XCTAssertEqual(height(400), height(6))
        XCTAssertEqual(height(0), height(1), "An empty field still shows one line")
    }

    func testTheRenderedComposerStopsGrowingAtMaxLines() {
        func height(_ lines: Int) -> CGFloat {
            let text = (1...lines).map { "Line \($0)" }.joined(separator: "\n")
            let surface = AidenComposerSurface(
                session: AidenComposerSession(text: text),
                config: .bot(),
                onSend: {},
                onStop: nil
            )
            return UIHostingController(rootView: surface)
                .sizeThatFits(in: CGSize(width: 320, height: 2_000)).height
        }

        XCTAssertGreaterThan(height(3), height(1))
        XCTAssertGreaterThan(height(6), height(3))
        XCTAssertEqual(height(30), height(6), accuracy: 0.5)
    }

    // MARK: - Harness

    private static let attachment = AidenAttachmentReference(
        id: "att_\(String(repeating: "a", count: 43))",
        name: "notes.txt",
        mimeType: "text/plain",
        kind: .text,
        size: 12,
        expiresAt: Date(timeIntervalSince1970: 4_000_000_000)
    )

    // MARK: - The largest text size

    func testEveryControlFitsAtTheLargestTextSize() async throws {
        try await assertEveryChatControlFits(at: .accessibility5)
    }

    /// Default text: the size most people read, with the narrowest row room to spare.
    func testEveryControlFitsAtTheDefaultTextSize() async throws {
        try await assertEveryChatControlFits(at: .large)
    }

    /// The largest size that keeps one row of controls, and so the tightest row.
    func testEveryControlFitsAtTheLargestStandardTextSize() async throws {
        try await assertEveryChatControlFits(at: .xxxLarge)
    }

    func testABotsControlsFitAndARunLeavesItsHeightAlone() throws {
        for textSize: DynamicTypeSize in [.accessibility5, .xxxLarge] {
            for width: CGFloat in [390, 375] {
                let context = "Bot at \(textSize), \(width)"
                func surface(isBusy: Bool) throws -> CGRect {
                    let host = AidenComposerBotFitHost(isBusy: isBusy, probe: AidenComposerFitProbe(), textSize: textSize)
                    let window = try show(host, width: width)
                    defer { close(window) }
                    XCTAssertTrue(runMainLoop(until: { host.probe.surface != .zero }), context)
                    drainMainLoop()
                    try assertControlsFit(
                        isBusy ? ["Add attachment", "Queue message", "Stop"] : ["Add attachment", "Start voice input", "Send message"],
                        in: window,
                        surface: host.probe.surface,
                        width: width,
                        context: context
                    )
                    return host.probe.surface
                }

                let idle = try surface(isBusy: false)
                let busy = try surface(isBusy: true)
                XCTAssertEqual(busy.height, idle.height, accuracy: 1, "A run made the composer jump: \(context)")
            }
        }
    }

    /// A dictation begun before the run keeps its stop beside the busy controls.
    func testABotRecordingThroughARunKeepsEveryControlInReach() async throws {
        for textSize: DynamicTypeSize in [.large, .xxxLarge, .accessibility5] {
            for width: CGFloat in [390, 375] {
                let context = "Bot recording at \(textSize), \(width)"
                let session = AidenComposerSession(text: "Hello", voice: AidenComposerFakeVoice())
                await session.toggleVoice()
                let host = AidenComposerBotFitHost(
                    isBusy: true,
                    probe: AidenComposerFitProbe(),
                    textSize: textSize,
                    session: session
                )
                let window = try show(host, width: width)
                defer { close(window) }
                XCTAssertTrue(runMainLoop(until: { host.probe.surface != .zero }), context)
                drainMainLoop()
                try assertControlsFit(
                    ["Add attachment", "Stop voice input", "Queue message", "Stop"],
                    in: window,
                    surface: host.probe.surface,
                    width: width,
                    context: context
                )
            }
        }
    }

    private func assertEveryChatControlFits(at textSize: DynamicTypeSize) async throws {
        for width: CGFloat in [390, 375] {
            for state in AidenComposerFitHost.State.allCases {
                let context = "\(state) at \(textSize), \(width)"
                let session = AidenComposerSession(text: "Hello", voice: AidenComposerFakeVoice())
                if state == .busyWhileRecording { await session.toggleVoice() }
                let host = AidenComposerFitHost(
                    session: session,
                    state: state,
                    probe: AidenComposerFitProbe(),
                    textSize: textSize
                )
                let window = try show(host, width: width)
                defer { close(window) }
                XCTAssertTrue(runMainLoop(until: { host.probe.surface != .zero }), context)
                drainMainLoop()
                try assertControlsFit(
                    state.controls,
                    in: window,
                    surface: host.probe.surface,
                    width: width,
                    context: context
                )
            }
        }
    }

    private func assertControlsFit(
        _ labels: [String],
        in window: UIWindow,
        surface: CGRect,
        width: CGFloat,
        context: String
    ) throws {
        let elements = accessibleElements(in: window)
        XCTAssertLessThanOrEqual(surface.width, width - 32 + 0.5, "The surface outgrew its place: \(context)")
        var frames: [CGRect] = []
        for label in labels {
            let element = try XCTUnwrap(elements.first { $0.accessibilityLabel == label }, "No \(label): \(context)")
            let frame = element.accessibilityFrame
            XCTAssertTrue(surface.insetBy(dx: -0.5, dy: -0.5).contains(frame), "\(label) \(frame) leaves \(surface): \(context)")
            XCTAssertGreaterThanOrEqual(frame.height, 44, "\(label) is too short to tap: \(context)")
            XCTAssertGreaterThanOrEqual(frame.width, 44, "\(label) is too narrow to tap: \(context)")
            for other in frames {
                XCTAssertFalse(other.insetBy(dx: 1, dy: 1).intersects(frame), "\(label) overlaps a control: \(context)")
            }
            frames.append(frame)
        }
    }

    func testAtTheLargestTextSizeOnlyTheChipLeavesTheRow() async throws {
        let host = AidenComposerFitHost(
            session: AidenComposerSession(text: "Hello", voice: AidenComposerFakeVoice()),
            state: .idle,
            probe: AidenComposerFitProbe()
        )
        let window = try show(host, width: 375)
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { host.probe.surface != .zero }))
        drainMainLoop()

        let elements = accessibleElements(in: window)
        let attach = try XCTUnwrap(elements.first { $0.accessibilityLabel == "Add attachment" }).accessibilityFrame
        let send = try XCTUnwrap(elements.first { $0.accessibilityLabel == "Send message" }).accessibilityFrame
        XCTAssertEqual(attach.midY, send.midY, accuracy: 1, "The controls took more lines than they need")
    }

    func testAtDefaultTextARunLeavesTheChipOnItsRow() async throws {
        let host = AidenComposerFitHost(
            session: AidenComposerSession(text: "Hello", voice: AidenComposerFakeVoice()),
            state: .busy,
            probe: AidenComposerFitProbe(),
            textSize: .large
        )
        let window = try show(host, width: 390)
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { host.probe.surface != .zero }))
        drainMainLoop()

        let elements = accessibleElements(in: window)
        let chip = try XCTUnwrap(elements.first { $0.accessibilityLabel == "Model" }).accessibilityFrame
        let stop = try XCTUnwrap(elements.first { $0.accessibilityLabel == "Stop response" }).accessibilityFrame
        XCTAssertEqual(chip.midY, stop.midY, accuracy: 1, "A run starting must not make the composer taller")
        XCTAssertLessThanOrEqual(chip.maxX, stop.minX)
    }

    // MARK: - The listening bar

    func testTheListeningBarAppearsOnlyWhileRecording() async throws {
        let voice = AidenComposerFakeVoice()
        let session = AidenComposerSession(voice: voice)
        let window = try show(AidenComposerListeningBar(session: session))
        defer { close(window) }
        drainMainLoop()
        XCTAssertNil(listeningBarStop(in: window))

        await session.toggleVoice()
        XCTAssertTrue(runMainLoop(until: { listeningBarStop(in: window) != nil }), "The bar never came up")

        await session.toggleVoice()
        XCTAssertTrue(runMainLoop(until: { listeningBarStop(in: window) == nil }), "The bar stayed up")
    }

    func testTheListeningBarsStopIsAFullTarget() async throws {
        let voice = AidenComposerFakeVoice()
        let session = AidenComposerSession(voice: voice)
        await session.toggleVoice()
        let window = try show(AidenComposerListeningBar(session: session))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { listeningBarStop(in: window) != nil }))

        let stop = try XCTUnwrap(listeningBarStop(in: window))
        XCTAssertGreaterThanOrEqual(stop.accessibilityFrame.height, 44)
    }

    func testTappingTheListeningBarEndsTheRecordingAndKeepsTheTranscript() async throws {
        let voice = AidenComposerFakeVoice()
        let draft = AidenComposerFakeDraft()
        let session = AidenComposerSession(draftOwner: draft, voice: voice)
        await session.toggleVoice()
        voice.speak("buy milk")
        let window = try show(AidenComposerListeningBar(session: session))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { listeningBarStop(in: window) != nil }))

        let stop = try XCTUnwrap(listeningBarStop(in: window))
        XCTAssertTrue(stop.accessibilityActivate())

        // The button's work runs on the main actor, so this test has to give way to it.
        for _ in 0..<300 where session.isRecording {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertFalse(session.isRecording, "The tap left the recording running")
        XCTAssertEqual(draft.draft, "buy milk")
        XCTAssertEqual(voice.discards, 0, "The tap threw away what was said")
    }

    private func listeningBarStop(in window: UIWindow) -> NSObject? {
        accessibleElements(in: window).first { $0.accessibilityLabel == "Stop voice input" }
    }

    /// What VoiceOver would see, read the way an assistive client does. The tree
    /// is only built while accessibility automation is on (see `setUp`).
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

    // MARK: - The composer inset and the transcript

    func testAComposerGrowingBesideAShortChatLeavesItWhereItIs() throws {
        let probe = try growComposer(contentHeight: 300)
        XCTAssertEqual(probe.follows, 0, "Following the bottom pulls a short chat down from the top")
    }

    func testAComposerGrowingOverTheLastWordsFollowsThem() throws {
        let probe = try growComposer(contentHeight: 500)
        XCTAssertGreaterThan(probe.follows, 0, "The composer grew over words the person could read")
    }

    func testAComposerGrowingOverALongChatFollows() throws {
        let probe = try growComposer(contentHeight: 1_500)
        XCTAssertGreaterThan(probe.follows, 0)
    }

    // MARK: - A real follow controller beside the composer

    /// Fits at first. The composer then grows over its last words, which moves
    /// only the inset: no offset or content size changes to report it.
    func testAComposerGrowingOverAFittingChatReachesItsLastWords() throws {
        let probe = AidenFollowProbe()
        let window = try show(AidenFollowingTranscriptHost(probe: probe, contentHeight: 500))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { probe.bottomInset > 0 }))
        drainMainLoop()
        XCTAssertLessThan(probe.distanceFromBottom, 0, "The chat should start out fitting")

        probe.composerHeight = 300

        XCTAssertTrue(
            runMainLoop(until: { abs(probe.distanceFromBottom) <= 1 }, timeout: 2),
            "The last words are under the composer, \(probe.distanceFromBottom) pt away"
        )
    }

    /// The same, with the size anchor out of the way so that only the follow
    /// can reach the bottom. The anchor would hide a follow that gave up.
    func testAFollowSeesAnInsetMoveThatChangedNothingElse() throws {
        let probe = AidenFollowProbe()
        let window = try show(AidenFollowingTranscriptHost(probe: probe, contentHeight: 500, usesSizeAnchor: false))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { probe.bottomInset > 0 }))
        drainMainLoop()
        XCTAssertLessThan(probe.distanceFromBottom, 0, "The chat should start out fitting")

        probe.composerHeight = 300

        XCTAssertTrue(
            runMainLoop(until: { abs(probe.distanceFromBottom) <= 1 }, timeout: 2),
            "The follow gave up on a stale fit, \(probe.distanceFromBottom) pt from the bottom"
        )
    }

    func testAComposerGrowingBesideAShortChatWithAFollowLeavesItAtTheTop() throws {
        let probe = AidenFollowProbe()
        let window = try show(AidenFollowingTranscriptHost(probe: probe, contentHeight: 300))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { probe.bottomInset > 0 }))
        drainMainLoop()

        let inset = probe.bottomInset
        probe.composerHeight = 300
        XCTAssertTrue(runMainLoop(until: { probe.bottomInset > inset }))
        drainMainLoop()

        XCTAssertEqual(probe.scrolledFromTop, 0, accuracy: 1)
    }

    /// The gate reads fit from the scroll geometry: held while the chat fits
    /// between the insets, released the moment a taller dock makes it overflow.
    func testAFollowWaitsUntilTheChatNoLongerFits() throws {
        let probe = AidenFollowProbe()
        let window = try show(AidenFollowingTranscriptHost(probe: probe, contentHeight: 300, startsAtTop: true))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { probe.bottomInset > 0 }, timeout: 2))
        _ = runMainLoop(until: { false }, timeout: 0.2)

        probe.followRequests += 1
        _ = runMainLoop(until: { false }, timeout: 0.2)
        XCTAssertEqual(probe.followRuns, 0, "A follow scrolled a chat that fits")

        probe.composerHeight = 640
        XCTAssertTrue(runMainLoop(until: { probe.followRuns > 0 }, timeout: 2), "The follow never saw the chat stop fitting")
    }

    func testAFollowOnAChatThatNeverMovedLeavesAShortOneAtTheTop() throws {
        let probe = AidenFollowProbe()
        let window = try show(AidenFollowingTranscriptHost(probe: probe, contentHeight: 300))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { probe.bottomInset > 0 }))
        drainMainLoop()

        probe.followRequests += 1
        drainMainLoop()

        XCTAssertEqual(probe.scrolledFromTop, 0, accuracy: 1, "The short chat dropped away from the top")
    }

    /// Nothing has moved since the chat first laid out, so nothing has changed
    /// to report: the first measurement has to count.
    func testALongChatReachesItsEndOnItsFirstFollow() throws {
        let probe = AidenFollowProbe()
        let window = try show(AidenFollowingTranscriptHost(probe: probe, contentHeight: 1_500, startsAtTop: true, usesSizeAnchor: false))
        defer { close(window) }

        XCTAssertTrue(
            runMainLoop(until: { probe.bottomInset > 0 && abs(probe.distanceFromBottom) <= 1 }, timeout: 2),
            "A long chat didn't follow, \(probe.distanceFromBottom) pt away"
        )
    }

    /// Grows a composer from one line's height to a tall one beside a transcript.
    private func growComposer(contentHeight: CGFloat) throws -> AidenComposerInsetProbe {
        let probe = AidenComposerInsetProbe()
        let window = try show(AidenComposerInsetHost(probe: probe, contentHeight: contentHeight))
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { probe.bottomInset > 0 }))
        drainMainLoop()
        probe.follows = 0

        let inset = probe.bottomInset
        probe.composerHeight = 300
        XCTAssertTrue(runMainLoop(until: { probe.bottomInset > inset }))
        drainMainLoop()
        return probe
    }

    private func show(_ view: some View, width: CGFloat = 390) throws -> UIWindow {
        // The test host can reach its first test before its scene has connected.
        func connectedScene() -> UIWindowScene? {
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        }
        _ = runMainLoop(until: { connectedScene() != nil }, timeout: 10)
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

    private func runMainLoop(until condition: () -> Bool, timeout: TimeInterval = 3) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }

    /// Lets every queued update pass land, so "nothing happened" means something.
    private func drainMainLoop() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    }
}

// MARK: - Fakes

/// Stands in for the microphone, which a test host cannot open.
@MainActor
@Observable
final class AidenComposerFakeVoice: AidenComposerVoiceCapture {
    private(set) var isListening = false
    var isBusy: Bool { isListening }
    var errorMessage: String?
    private(set) var discards = 0
    private(set) var startedWithDraft: String?
    @ObservationIgnored private var updateDraft: ((String) -> Void)?

    func toggle(
        currentDraft: String,
        updateDraft: @escaping (String) -> Void,
        macTranscriber: @escaping (Data) async throws -> String
    ) async {
        if isListening {
            isListening = false
            return
        }
        startedWithDraft = currentDraft
        self.updateDraft = updateDraft
        isListening = true
    }

    func cancelDiscardingRecording() {
        if isListening { discards += 1 }
        isListening = false
    }

    func speak(_ draft: String) { updateDraft?(draft) }
}

@MainActor
@Observable
final class AidenComposerFakeDraft: AidenComposerDraftOwner {
    var draft = ""
    func transcribeMacSpeech(_ pcm16: Data) async throws -> String { "" }
}

@MainActor
@Observable
final class AidenComposerFakeAttachments: AidenComposerAttachmentOwner {
    var pendingAttachments: [AidenAttachmentReference] = []
    var isPreparingAttachments = false
    private(set) var cancellations = 0

    func cancelAttachmentPreparation() {
        cancellations += 1
        isPreparingAttachments = false
    }
}

// MARK: - Hosts

/// What the chat's footer does when a question arrives: the composer goes, a
/// card takes its place.
@MainActor
@Observable
private final class AidenComposerSwap {
    var showsComposer = true
    var appearances = 0
    var disappearances = 0
}

private struct AidenComposerSwapHost: View {
    let session: AidenComposerSession
    let swap: AidenComposerSwap

    var body: some View {
        if swap.showsComposer {
            AidenComposerSurface(session: session, config: .chat(model: "Sonnet"), onSend: {}, onStop: nil)
                .onAppear { swap.appearances += 1 }
                .onDisappear { swap.disappearances += 1 }
        } else {
            Text("Which one?")
        }
    }
}

@MainActor
@Observable
private final class AidenComposerInsetProbe {
    var composerHeight: CGFloat = 60
    var bottomInset: CGFloat = 0
    var follows = 0
}

private struct AidenComposerInsetHost: View {
    let probe: AidenComposerInsetProbe
    let contentHeight: CGFloat
    @State private var session = AidenComposerSession(voice: AidenComposerFakeVoice())

    var body: some View {
        AidenTranscriptScaffold(dock: AidenChatDock(
            content: .composer(busy: false),
            session: session,
            config: .chat(model: nil),
            actions: AidenDockActions(),
            slots: AidenDockSlots(composer: { _ in
                Color.clear.frame(height: probe.composerHeight)
            })
        )) {
            ScrollView {
                Color.clear.frame(height: contentHeight)
            }
            .aidenOnComposerInsetChange { probe.follows += 1 }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentInsets.bottom } action: { _, inset in
                probe.bottomInset = inset
            }
        }
    }
}

@MainActor
@Observable
private final class AidenFollowProbe {
    var composerHeight: CGFloat = 60
    var followRequests = 0
    /// Follows that passed the gate and scrolled.
    @ObservationIgnored var followRuns = 0
    var bottomInset: CGFloat = 0
    var scrolledFromTop: CGFloat = 0
    /// Negative while the content ends above the composer.
    var distanceFromBottom: CGFloat = 0
}

/// A transcript wired as the two conversation screens wire theirs: the real
/// observer and controller, the size anchor, and the inset follow.
private struct AidenFollowingTranscriptHost: View {
    let probe: AidenFollowProbe
    let contentHeight: CGFloat
    var startsAtTop = false
    var usesSizeAnchor = true
    @State private var follow = AidenTranscriptFollowController()
    @State private var session = AidenComposerSession(voice: AidenComposerFakeVoice())

    var body: some View {
        AidenTranscriptScaffold(dock: AidenChatDock(
            content: .composer(busy: false),
            session: session,
            config: .chat(model: nil),
            actions: AidenDockActions(),
            slots: AidenDockSlots(composer: { _ in
                Color.clear.frame(height: probe.composerHeight)
            })
        )) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        Color.clear.frame(height: contentHeight)
                        Color.clear.frame(height: 1).id(AidenChatScrollPolicy.transcriptBottomAnchorID)
                    }
                    .background {
                        AidenChatScrollObserver(
                            onFollowEvent: { follow.handle($0) },
                            onMetrics: { follow.updateMetrics($0) }
                        )
                    }
                }
                .defaultScrollAnchor(
                    startsAtTop ? .top : AidenChatScrollPolicy.initialTranscriptAnchor,
                    for: .initialOffset
                )
                .defaultScrollAnchor(
                    AidenChatScrollPolicy.sizeChangeAnchor(shouldFollowLatest: usesSizeAnchor && follow.isFollowing),
                    for: .sizeChanges
                )
                .aidenReportsTranscriptFit(to: follow)
                .aidenOnComposerInsetChange { followLatest(proxy) }
                .onChange(of: probe.followRequests) { followLatest(proxy) }
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentInsets.bottom } action: { _, inset in
                    probe.bottomInset = inset
                }
                .onScrollGeometryChange(for: CGFloat.self) {
                    $0.contentOffset.y + $0.contentInsets.top
                } action: { _, offset in
                    probe.scrolledFromTop = offset
                }
                .onScrollGeometryChange(for: CGFloat.self) {
                    $0.contentSize.height - ($0.contentOffset.y + $0.contentInsets.top) - $0.containerSize.height
                } action: { _, distance in
                    probe.distanceFromBottom = distance
                }
            }
        }
    }

    private func followLatest(_ proxy: ScrollViewProxy) {
        follow.scheduleFollowScroll(isUserInitiated: false, animated: false) { _ in
            probe.followRuns += 1
            proxy.scrollTo(AidenChatScrollPolicy.transcriptBottomAnchorID, anchor: .bottom)
        }
    }
}

@MainActor
private final class AidenComposerFitProbe {
    var surface = CGRect.zero
}

/// A real chat's composer: the same chip and busy pill, at the largest text size,
/// with the 16 pt gutters the conversation gives it.
private struct AidenComposerFitHost: View {
    enum State: CaseIterable {
        case idle, busy, busyWhileRecording

        var controls: [String] {
            switch self {
            case .idle: ["Add attachment", "Model", "Start voice input", "Send message"]
            case .busy: ["Add attachment", "Model", "Queue message", "Choose message action", "Stop response"]
            case .busyWhileRecording:
                ["Add attachment", "Model", "Stop voice input", "Queue message", "Choose message action", "Stop response"]
            }
        }
    }

    let session: AidenComposerSession
    let state: State
    let probe: AidenComposerFitProbe
    var textSize = DynamicTypeSize.accessibility5

    var body: some View {
        AidenComposerSurface(
            session: session,
            config: .chat(model: "Claude Sonnet 4.5"),
            controls: AidenComposerControls(offersMic: state == .idle),
            onSend: {},
            onStop: state == .idle ? nil : {},
            attachButton: {
                AidenComposerAttachButton(
                    isOpen: false,
                    isBusy: false,
                    showsSpinner: true,
                    hint: "",
                    coordinateSpace: "fit",
                    action: {}
                )
            },
            modelChip: {
                Menu {
                    Button("Another model") {}
                } label: {
                    AidenComposerModelChipLabel(
                        provider: nil,
                        modelID: nil,
                        modelLabel: "Claude Sonnet 4.5",
                        thinkingLevel: "high"
                    )
                }
                .accessibilityLabel("Model")
            },
            busyControl: {
                AidenComposerRunInputPill(
                    title: "Queue",
                    actionLabel: "Queue message",
                    canSubmit: true,
                    onSubmit: {},
                    modeMenu: { Button("Steer") {} }
                )
            }
        )
        .background {
            GeometryReader { proxy in
                Color.clear.onChange(of: proxy.frame(in: .global), initial: true) { _, frame in
                    probe.surface = frame
                }
            }
        }
        .padding(.horizontal, 16)
        .coordinateSpace(name: "fit")
        .dynamicTypeSize(textSize)
    }
}

/// A Bot's composer: no chip, with its own busy pill beside Stop in the mic's place.
private struct AidenComposerBotFitHost: View {
    let isBusy: Bool
    let probe: AidenComposerFitProbe
    let textSize: DynamicTypeSize
    var session = AidenComposerSession(text: "Hello", voice: AidenComposerFakeVoice())

    var body: some View {
        AidenComposerSurface(
            session: session,
            config: .bot(),
            controls: AidenComposerControls(stopLabel: "Stop", offersMic: !isBusy),
            onSend: {},
            onStop: isBusy ? {} : nil,
            attachButton: {
                AidenComposerAttachButton(
                    isOpen: false,
                    isBusy: false,
                    showsSpinner: true,
                    hint: "",
                    coordinateSpace: "fit",
                    action: {}
                )
            },
            busyControl: {
                AidenBotBusyPill(
                    title: "Queue",
                    actionLabel: "Queue message",
                    isAvailable: true,
                    canSubmit: true,
                    onSubmit: {},
                    modeMenu: { Button("Steer") {} }
                )
            }
        )
        .background {
            GeometryReader { proxy in
                Color.clear.onChange(of: proxy.frame(in: .global), initial: true) { _, frame in
                    probe.surface = frame
                }
            }
        }
        .padding(.horizontal, 16)
        .coordinateSpace(name: "fit")
        .dynamicTypeSize(textSize)
    }
}

@MainActor
private final class AidenComposerChipProbe {
    var appearances = 0
}

private struct AidenComposerChipHost: View {
    let config: AidenComposerConfig
    let probe: AidenComposerChipProbe

    var body: some View {
        AidenComposerSurface(
            session: AidenComposerSession(),
            config: config,
            onSend: {},
            onStop: nil,
            modelChip: { Text("Sonnet").onAppear { probe.appearances += 1 } }
        )
    }
}

@MainActor
@Observable
private final class AidenChatDetailHost {
    let session: AidenComposerSession
    var showsChat = true
    var scenePhase = ScenePhase.active

    init(session: AidenComposerSession) { self.session = session }
}

private struct AidenChatDetailHostView: View {
    let host: AidenChatDetailHost
    @State private var coordinator = AidenRemoteCoordinator(
        installationStore: AidenInstallationStore(keychain: AidenComposerEmptyKeychain())
    )
    private let chat = AidenChat(
        id: "chat-composer-owner",
        workspaceId: "workspace-composer-owner",
        title: "Owner",
        providerId: "anthropic",
        modelId: "sonnet",
        messages: [],
        createdAt: Date(timeIntervalSince1970: 1_700_000_000),
        updatedAt: Date(timeIntervalSince1970: 1_700_000_000),
        revision: "1"
    )

    var body: some View {
        NavigationStack {
            if host.showsChat {
                AidenChatDetailView(coordinator: coordinator, chat: chat, composerSession: host.session)
            } else {
                Text("Chats")
            }
        }
        .environment(\.scenePhase, host.scenePhase)
    }
}

private final class AidenComposerEmptyKeychain: KeychainStoring {
    func save(_ value: String, forKey key: KeychainStore.Key) throws {}
    func load(_ key: KeychainStore.Key) throws -> String? { nil }
    func delete(_ key: KeychainStore.Key) throws {}
    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {}
    func load(_ key: KeychainStore.Key, scope: String) throws -> String? { nil }
    func delete(_ key: KeychainStore.Key, scope: String) throws {}
}
