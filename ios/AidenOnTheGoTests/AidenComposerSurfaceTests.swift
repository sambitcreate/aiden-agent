import Observation
import SwiftUI
import XCTest
@testable import AidenOnTheGo

/// The composer view comes and goes (a question card takes its place); what the
/// person is doing in it belongs to the conversation.
@MainActor
final class AidenComposerSurfaceTests: XCTestCase {

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

    private func show(_ view: some View) throws -> UIWindow {
        // The test host can reach its first test before its scene has connected.
        func connectedScene() -> UIWindowScene? {
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        }
        _ = runMainLoop(until: { connectedScene() != nil }, timeout: 10)
        let scene = try XCTUnwrap(connectedScene())
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
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

    var body: some View {
        ScrollView {
            Color.clear.frame(height: contentHeight)
        }
        .aidenOnComposerInsetChange { probe.follows += 1 }
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentInsets.bottom } action: { _, inset in
            probe.bottomInset = inset
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Color.clear.frame(height: probe.composerHeight)
        }
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
