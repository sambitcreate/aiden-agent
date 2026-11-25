import Photos
import SwiftUI
import UniformTypeIdentifiers

enum AidenChatAttachmentCoordinateSpace {
    static let name = "aiden-chat-attachment-coordinate-space"
}

struct AidenAttachmentButtonCenterPreferenceKey: PreferenceKey {
    static let defaultValue: CGPoint? = nil

    static func reduce(value: inout CGPoint?, nextValue: () -> CGPoint?) {
        value = nextValue() ?? value
    }
}

/// True while a chat's composer holds attachments, for whatever would close it.
struct AidenChatHoldsAttachmentsKey: PreferenceKey {
    static let defaultValue = false

    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

/// The reader's place in a transcript, kept across a rebuild of its views:
/// the row they're reading and how far into it, and where the rows built
/// now are, so a rebuilt screen can scroll back there.
@MainActor
class AidenTranscriptPlace {
    /// Where the reader is while scrolled away from the latest; nil while
    /// following the latest.
    var readingPlace: AidenReadingPlace?
    /// Where the rows built now are in the transcript's content
    /// (`AidenTranscriptRowSpace`), and how tall the part the transcript
    /// shows clear of the bars and the composer is: the reading place when a
    /// scroll settles. A layout change alone never moves the reading place.
    private(set) var rowFrames: [String: CGRect] = [:]
    var visibleHeight: CGFloat = 0
    /// Which screen's rows each frame came from (`setRowFrame`).
    private var rowFrameScreens: [String: UUID] = [:]
    /// The screen that appeared most recently, and the ones it replaced.
    private var shownScreen: UUID?
    private var replacedScreens: Set<UUID> = []

    /// A row's frame as the screen `screen` built it, or nil as that row
    /// leaves. A fold builds the new screen's rows before the old screen's
    /// leave, so a leaving row only takes back a frame its own screen gave:
    /// the frames are in the content's space and don't move with scrolling,
    /// so a row the new screen already measured wouldn't report again.
    /// Returns true when the row the reading place is in took a new height:
    /// the anchor that brought the reader back was worked out from the old
    /// one, so it has to be worked out again.
    @discardableResult
    func setRowFrame(_ frame: CGRect?, for id: String, from screen: UUID) -> Bool {
        // A screen a newer one replaced is on its way out: whatever its rows
        // report, late, is at the width it had.
        guard !replacedScreens.contains(screen) else { return false }
        let heldRowHeight = readingPlace?.rowID == id ? rowFrames[id]?.height : nil
        if let frame {
            rowFrames[id] = frame
            rowFrameScreens[id] = screen
        } else if rowFrameScreens[id] == screen {
            rowFrames[id] = nil
            rowFrameScreens[id] = nil
        }
        guard readingPlace?.rowID == id, let height = rowFrames[id]?.height else { return false }
        return heldRowHeight.map { abs($0 - height) > 0.5 } ?? true
    }

    /// `screen` appeared, so only its rows' frames count from now on. Its rows
    /// may have reported before it appeared, so those stay; frames from the
    /// screen it replaces go.
    func screenAppeared(_ screen: UUID) {
        guard screen != shownScreen else { return }
        if let shownScreen { replacedScreens.insert(shownScreen) }
        shownScreen = screen
        replacedScreens.remove(screen)
        for (id, owner) in rowFrameScreens where replacedScreens.contains(owner) {
            rowFrames[id] = nil
            rowFrameScreens[id] = nil
        }
    }
}

/// What a chat screen keeps across a rebuild of its views: the transcript and
/// its model, the composer with its draft, attachments and voice, the
/// attachment picker, and the reader's place.
@MainActor
final class AidenChatScreenParts: AidenTranscriptPlace {
    let model: AidenChatViewModel
    let composerSession: AidenComposerSession
    let follow: AidenTranscriptFollowController
    let attachmentPicker: AidenAttachmentPickerState
    let botToolsModel: AidenBotChatToolsModel?

    init(
        model: AidenChatViewModel,
        composerSession: AidenComposerSession? = nil,
        botToolsModel: AidenBotChatToolsModel?
    ) {
        self.model = model
        self.composerSession = composerSession ?? AidenComposerSession(draftOwner: model, attachmentOwner: model)
        follow = AidenTranscriptFollowController()
        attachmentPicker = AidenAttachmentPickerState()
        self.botToolsModel = botToolsModel
        super.init()
    }
}

/// One chat's screen state, held by the shell rather than by its views
/// (`AidenChatScreens`). Opening or closing an iPhone Duo swaps the shell's
/// containers, which builds the screen's views again: SwiftUI reports the old
/// ones gone and new ones there. The new views take the same parts, so the
/// reader stays in the same chat at the same place with the same draft,
/// attachments and voice. For the moment of the swap both views can hold the
/// same parts, the composer's session included; only the one on screen takes
/// input.
///
/// Nothing here waits to find out what happened. The shell says when it's
/// about to swap (`rebuilding()`), so a view that leaves then is coming back
/// and the screen stays live. Any other leave hides it at once: it stops
/// listening and saves the draft. Once its chat is also on no tab, which the
/// paths say, it lets its attachments go and the shell forgets it.
@MainActor
final class AidenChatScreen {
    private(set) var parts: AidenChatScreenParts?
    private var appearances = 0
    /// Set from the shell's swap until a view of this screen comes back.
    private(set) var isRebuilding = false
    /// What a hidden screen lets go of once its chat has left every tab,
    /// from the view that hid it.
    private var letGo: (@MainActor () -> Void)?
    /// What a view that left during a swap would have done had it not been
    /// a swap, for the backstop.
    private var heldHide: (@MainActor () -> Void)?
    private var backstop: Task<Void, Never>?
    /// Home's Send, for the chat's model once a view makes it.
    private var launchSend: String?
    private let isOpen: @MainActor () -> Bool
    private let onLeft: @MainActor () -> Void
    private let pause: @MainActor (Duration) async -> Void

    /// How long a swap may take before a view that left during it counts as
    /// gone. Only a backstop: the next view's appearance is what normally
    /// ends a swap.
    static let rebuildBackstop = Duration.seconds(2)

    init(
        isOpen: @escaping @MainActor () -> Bool,
        onLeft: @escaping @MainActor () -> Void = {},
        pause: @escaping @MainActor (Duration) async -> Void = { try? await Task.sleep(for: $0) }
    ) {
        self.isOpen = isOpen
        self.onLeft = onLeft
        self.pause = pause
    }

    var isShowing: Bool { appearances > 0 }

    /// The parts the first view made, or `make`'s.
    func parts(_ make: () -> AidenChatScreenParts) -> AidenChatScreenParts {
        if let parts { return parts }
        let made = make()
        parts = made
        return made
    }

    /// Holds `prompt` for this chat to send as soon as it opens.
    func queueLaunchSend(_ prompt: String) {
        if let parts { parts.model.queueLaunchSend(prompt) } else { launchSend = prompt }
    }

    /// The held prompt, once.
    func takeLaunchSend() -> String? {
        defer { launchSend = nil }
        return launchSend
    }

    /// The shell is about to swap its containers. A screen on screen now gets
    /// a new view, so the old one leaving isn't the reader leaving.
    func rebuilding() {
        guard isShowing else { return }
        isRebuilding = true
    }

    func appeared() {
        appearances += 1
        isRebuilding = false
        heldHide = nil
        backstop?.cancel()
        backstop = nil
    }

    /// A view of this screen left. With no view left it's hidden at once,
    /// unless the shell is swapping its containers, and let go if its chat
    /// is on no tab. Returns the backstop while a swap holds the hide, for
    /// tests.
    @discardableResult
    func disappeared(
        hidden: @escaping @MainActor () -> Void,
        left: @escaping @MainActor () -> Void
    ) -> Task<Void, Never>? {
        appearances = max(0, appearances - 1)
        letGo = left
        guard appearances == 0 else { return nil }
        guard isRebuilding else {
            hidden()
            leaveIfClosed()
            return nil
        }
        heldHide = hidden
        let backstop = Task { @MainActor [pause] in
            await pause(Self.rebuildBackstop)
            guard !Task.isCancelled else { return }
            self.endRebuild()
        }
        self.backstop = backstop
        return backstop
    }

    /// The swap never brought a view back: what it held runs now.
    private func endRebuild() {
        guard isRebuilding, appearances == 0 else { return }
        isRebuilding = false
        heldHide?()
        heldHide = nil
        leaveIfClosed()
    }

    /// The paths changed. A hidden screen whose chat is on no tab lets go
    /// and the shell forgets it.
    func leaveIfClosed() {
        guard !isShowing, !isRebuilding, !isOpen() else { return }
        letGo?()
        letGo = nil
        onLeft()
    }
}

struct AidenChatDetailView: View {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenPalette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AidenChatViewModel
    /// Lives here, not in the composer, so a question card taking the composer's
    /// place leaves dictation and attachment preparation running.
    @State private var composerSession: AidenComposerSession
    @State private var sceneRefreshGate = AidenSceneRefreshGate(refreshOnFirstActivation: false)
    @State private var chatLoadEpoch = 0
    /// The message to scroll back to once a page of earlier messages is laid out.
    @State private var keptPlaceID: String?
    /// This screen's rows, as against those of the screen a fold replaces.
    @State private var rowFrameScreen = UUID()
    @State private var botToolsModel: AidenBotChatToolsModel?
    @State private var botSheet: AidenBotChatSheet?
    @State private var isConfirmingBotDelete = false
    @Environment(\.dismiss) private var dismissChat
    @Environment(\.aidenConversationMachine) private var conversationMachine
    @State private var workspaceFileReference: String?
    @State private var showsWorkspaceFile = false
    @State private var progressSheet: AidenProgressSheet?
    @State private var follow: AidenTranscriptFollowController
    /// The one settled message whose footer a tap has shown.
    @State private var footerReveal = AidenMessageFooterReveal()
    @State private var attachmentPicker: AidenAttachmentPickerState
    /// Everything above that outlives these views, and the reader's place.
    @State private var parts: AidenChatScreenParts
    @State private var isFileImporterPresented = false
    @State private var attachmentButtonCenter: CGPoint?
    @Namespace private var attachmentMotionNamespace
    @State private var coordinator: AidenRemoteCoordinator?
    @State private var forkSummaryRequest: AidenForkSummaryRequest?
    @State private var simulators = AidenChatSimulatorsModel()
    @State private var simulatorViewer: AidenSimulatorViewerModel?
    @State private var simulatorRefreshEpoch = 0
    @State private var spending = AidenSpendingNoticeModel()
    @State private var backgroundJobs = AidenBackgroundJobsModel()
    @State private var showsBackgroundJobs = false
    @State private var isChoosingContinueWorkspace = false
    @State private var showsSessionSheet = false
    /// Runs once the sheet has closed, so what it opens has the screen to itself.
    @State private var pendingSessionAction: AidenSessionAction?
    @State private var isRenaming = false
    @State private var renameTitle = ""
    let autoStartVoice: Bool
    let autoStartCamera: Bool
    let allowsMutations: Bool
    /// Opens a chat this one was forked into. Nil hides the fork actions,
    /// for surfaces that cannot navigate to a new Workspace chat.
    private let onOpenChat: (@MainActor (AidenChat) -> Void)?
    /// The machine this chat stays on when the default moves.
    private let pinnedOwner: String?
    /// The shell's hold on this chat's screen, when it keeps one.
    private let screen: AidenChatScreen?

    init(
        coordinator: AidenRemoteCoordinator,
        chat: AidenChat,
        owner: AidenRemoteRequestContext,
        autoStartVoice: Bool = false,
        autoStartCamera: Bool = false,
        allowsMutations: Bool = true,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in },
        onOpenChat: (@MainActor (AidenChat) -> Void)? = nil,
        composerSession: AidenComposerSession? = nil,
        screen: AidenChatScreen? = nil
    ) {
        _coordinator = State(initialValue: coordinator)
        self.onOpenChat = onOpenChat
        pinnedOwner = owner.instanceId
        self.screen = screen
        let make = {
            AidenChatScreenParts(
                model: AidenChatViewModel(
                    coordinator: coordinator,
                    chat: chat,
                    owner: owner,
                    allowsMutations: allowsMutations,
                    onChatUpdated: onChatUpdated,
                    onChatActivityChanged: onChatActivityChanged
                ),
                composerSession: composerSession,
                botToolsModel: chat.botId.map {
                    AidenBotChatToolsModel(chatID: chat.id, botID: $0, machine: owner.instanceId)
                }
            )
        }
        let parts = screen?.parts(make) ?? make()
        if let prompt = screen?.takeLaunchSend() { parts.model.queueLaunchSend(prompt) }
        _parts = State(initialValue: parts)
        _model = State(initialValue: parts.model)
        _composerSession = State(initialValue: parts.composerSession)
        _follow = State(initialValue: parts.follow)
        _attachmentPicker = State(initialValue: parts.attachmentPicker)
        _botToolsModel = State(initialValue: parts.botToolsModel)
        self.autoStartVoice = autoStartVoice
        self.autoStartCamera = autoStartCamera
        self.allowsMutations = allowsMutations
    }

#if DEBUG
    init(readOnlyFixture chat: AidenChat) {
        _coordinator = State(initialValue: nil)
        let parts = AidenChatScreenParts(model: AidenChatViewModel(readOnlyFixture: chat), botToolsModel: nil)
        _parts = State(initialValue: parts)
        _model = State(initialValue: parts.model)
        _composerSession = State(initialValue: parts.composerSession)
        _follow = State(initialValue: parts.follow)
        _attachmentPicker = State(initialValue: parts.attachmentPicker)
        _botToolsModel = State(initialValue: nil)
        autoStartVoice = false
        autoStartCamera = false
        allowsMutations = false
        onOpenChat = nil
        pinnedOwner = nil
        screen = nil
    }
#endif

    private var workspace: AidenWorkspace? {
        model.ownerWorkspace
    }

    /// `./relative` links open the chat's workspace file only in a workspace
    /// chat with a folder. The agent's `relativePath` is relative to that same
    /// folder (also for a managed worktree, which is its own workspace).
    private var opensWorkspaceFileLinks: Bool {
        model.chat.botId == nil && workspace?.hasFolder == true
    }

    private var botToolsSessionIdentity: AidenBotChatToolsSessionIdentity? {
        guard let coordinator, let pinnedOwner else { return nil }
        return AidenBotChatToolsSessionIdentity(coordinator: coordinator, owner: pinnedOwner)
    }

    private var botPrimarySupportsImages: Bool? {
        guard let bot = botToolsModel?.bot,
              let selection = bot.modelSelection,
              let catalog = botToolsModel?.catalog else { return nil }
        return catalog.model(
            providerId: selection.providerId,
            modelId: selection.modelId
        )?.supportsImages
    }

    private var effectiveAllowsMutations: Bool {
        guard let botToolsModel else { return allowsMutations }
        return allowsMutations && botToolsModel.bot?.health == .ready
    }

    private var presentationStyle: AidenChatPresentationStyle {
        AidenChatPresentationStyle(chat: model.chat)
    }

    var body: some View {
        chatStack
        .background(palette.canvas.ignoresSafeArea())
        .onChange(of: effectiveAllowsMutations, initial: true) { _, allowed in
            model.setAllowsMutations(allowed)
        }
        .onChange(of: reduceMotion, initial: true) { _, reduce in
            model.setPacesStreamingReveal(!reduce)
        }
        .onChange(of: botToolsModel?.bot?.visionModelSelection, initial: true) { _, selection in
            model.setBotVisionModelSelection(selection)
        }
        .onChange(of: botPrimarySupportsImages, initial: true) { _, supportsImages in
            model.setBotPrimarySupportsImages(supportsImages)
        }
        .onChange(of: model.pendingQuestion?.id) { _, id in
            guard id != nil else { return }
            composerSession.putAwayKeyboard()
            attachmentPicker.dismiss()
        }
        .onChange(of: model.isStreaming) { _, isStreaming in
            guard isStreaming else { return }
            attachmentPicker.dismiss()
        }
        .onChange(of: dockContent.keepsComposer) { _, keepsComposer in
            guard !keepsComposer else { return }
            composerSession.putAwayKeyboard()
            attachmentPicker.dismiss()
        }
        .navigationTitle(screenTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { chatToolbar }
        .aidenPrefersToolbarItems()
        .task(id: backgroundJobsRefreshKey) {
            // Not pushed: read after each reply settles, and every few seconds
            // while something runs or the list is open. Only while the app
            // is in front: a backgrounded app never polls the Mac.
            guard scenePhase == .active else { return }
            await backgroundJobs.refresh(chatId: model.chat.id, transport: backgroundJobsTransport)
            while !Task.isCancelled, backgroundJobsTransport != nil,
                  backgroundJobs.runningCount > 0 || showsBackgroundJobs {
                try? await Task.sleep(for: .seconds(showsBackgroundJobs ? 3 : 10))
                guard !Task.isCancelled else { return }
                await backgroundJobs.refresh(chatId: model.chat.id, transport: backgroundJobsTransport)
            }
        }
        .task(id: newWorktreeRefreshKey) {
            await model.refreshNewWorktreeRepository()
        }
        .task(id: spendingRefreshKey) {
            await spending.refresh(owner: spendingOwner, transport: spendingTransport)
        }
        .task(id: chatLoadEpoch) {
            // Loads on appear and after each return from the background. A
            // newer epoch cancels an older load still in flight.
            guard scenePhase != .background else { return }
            await model.reload(observeProgress: true)
        }
        .onChange(of: model.ownerConnectionState) { old, new in
            // A chat opened from its saved copy while connecting reloads once
            // the Mac answers, so the transcript and read state reconcile.
            if new == .connected, old != .connected { chatLoadEpoch &+= 1 }
        }
        .task(id: model.ownerServer?.serverTime) {
            guard scenePhase == .active else { return }
            model.startProgressObservation()
        }
        .task(id: botToolsSessionIdentity) {
            model.readAloud.stop()
            guard let coordinator, let botToolsModel else { return }
            botToolsModel.resetForSessionChange()
            await botToolsModel.load(coordinator: coordinator)
        }
        .environment(\.aidenOpensWorkspaceFileLinks, opensWorkspaceFileLinks)
        .environment(\.openURL, OpenURLAction { url in
            let raw = url.relativeString
            if AidenWorkspaceFileLink.path(raw) != nil, opensWorkspaceFileLinks {
                workspaceFileReference = raw
                showsWorkspaceFile = true
                return .handled
            }
            if url.isFileURL || raw.hasPrefix("/") || raw.hasPrefix("./") || raw.hasPrefix("../") || raw.hasPrefix("~/") { return .discarded }
            return .systemAction
        })
        .sheet(isPresented: $showsWorkspaceFile) {
            if let coordinator, let workspace {
                NavigationStack { AidenWorkspaceFilesView(coordinator: coordinator, workspace: workspace, owner: model.owner, initialReference: workspaceFileReference) }
            }
        }
        .sheet(item: $botSheet) { botSheetContent($0) }
        .sheet(item: $progressSheet) { progressSheet in
            AidenChatProgressSheet(kind: progressSheet, model: model)
        }
        .sheet(isPresented: $showsBackgroundJobs) {
            AidenBackgroundJobsSheet(
                model: backgroundJobs,
                canStop: allowsMutations && model.ownerServer?.capabilities.contains(.chatWrite) == true,
                onStop: { jobId in Task { await backgroundJobs.stop(jobId, transport: backgroundJobsTransport) } }
            )
        }
        .sheet(item: $forkSummaryRequest) { request in
            AidenForkSummarySheet { focus in
                performFork(messageID: request.id, action: .forkWithSummary, focus: focus)
            }
        }
        .sheet(isPresented: $showsSessionSheet, onDismiss: runPendingSessionAction) {
            AidenSessionSheet(
                config: sessionSheetConfig,
                actions: AidenSessionActions { pendingSessionAction = $0 }
            )
        }
        .alert("Rename chat", isPresented: $isRenaming) {
            TextField("Chat title", text: $renameTitle)
            Button("Cancel", role: .cancel) {}
            Button("Save") { Task { await model.rename(to: renameTitle) } }
        }
        .task(id: simulatorRefreshKey) {
            // Once when the chat opens, again after each return to the
            // foreground (chatLoadEpoch) and when the viewer closes. No polling.
            guard scenePhase != .background else { return }
            await simulators.refresh(client: model.simulatorsClient, chatId: model.chat.id)
        }
        .fullScreenCover(item: $simulatorViewer, onDismiss: {
            simulatorRefreshEpoch &+= 1
        }) { viewer in
            AidenSimulatorViewer(model: viewer)
        }
        .task(id: model.chat.forkedFrom?.chatId) {
            await model.resolveForkSource()
        }
        .task(id: model.chat.forkedFrom?.summary?.state) {
            await model.observePendingForkSummary()
        }
        .alert("Aiden On The Go", isPresented: Binding(
            get: { model.presentedError != nil || model.readAloud.errorMessage != nil },
            set: { if !$0 { model.presentedError = nil; model.readAloud.errorMessage = nil } }
        )) {
            if onOpenChat != nil, model.offersContinueInNewChat {
                Button("Continue in a New Chat") {
                    model.presentedError = nil
                    model.continueInNewChatError = nil
                    isChoosingContinueWorkspace = true
                }
            }
            Button("OK", role: .cancel) { model.presentedError = nil; model.readAloud.errorMessage = nil }
        } message: {
            Text(model.presentedError ?? model.readAloud.errorMessage ?? "The operation could not be completed.")
        }
        .sheet(isPresented: $isChoosingContinueWorkspace, onDismiss: {
            model.continueInNewChatError = nil
        }) {
            AidenContinueInNewChatSheet(
                workspaces: model.continueInNewChatWorkspaces,
                isContinuing: model.isContinuingInNewChat,
                errorMessage: model.continueInNewChatError,
                onCancel: { isChoosingContinueWorkspace = false },
                onChoose: performContinueInNewChat(workspaceID:)
            )
        }
        .aidenBotDeleteConfirmation(
            isPresented: $isConfirmingBotDelete,
            botName: botToolsModel?.bot?.name ?? model.chat.title
        ) {
            deleteBotFromChat()
        }
        .onAppear {
            screen?.appeared()
            parts.screenAppeared(rowFrameScreen)
            model.setViewPresent(true)
            model.setHapticsActive(true)
            model.setChatForegrounded(true)
            model.setSceneActive(scenePhase == .active)
            if scenePhase == .background { _ = sceneRefreshGate.transition(to: .background) }
        }
        .task {
            // Consumed even when it can't open now, so a later remount never
            // surprises the person with the camera.
            model.startCameraForLaunch(if: autoStartCamera) {
                guard scenePhase == .active else { return }
                openCameraForLaunch()
            }
        }
        .onChange(of: model.readAloudCandidateID) { _, candidate in
            if let active = model.readAloud.activeMessageID, active != candidate { model.readAloud.stop() }
        }
        .onChange(of: scenePhase) { _, phase in
            model.setSceneActive(phase == .active)
            if phase != .active {
                model.readAloud.stop()
            }
            if AidenVoiceCaptureLifecyclePolicy.shouldDiscardRecording(for: phase) {
                composerSession.stopVoice()
            }
            switch sceneRefreshGate.transition(to: phase) {
            case .refresh:
                chatLoadEpoch &+= 1
            case .resume:
                model.startProgressObservation()
            case .suspend:
                model.stopProgressObservation()
                // The return to the foreground reloads and re-arms it.
                model.stopVisualSnapshotRefresh()
            case .none:
                // `.inactive` is transient; progress keeps streaming.
                break
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .aidenStopDictationForReadAloud)) { _ in
            composerSession.stopVoice()
        }
#if DEBUG
        .onAppear {
            if AidenDemoStagedAttachment.isRequested { model.pendingAttachments = [AidenDemoStagedAttachment.reference] }
        }
#endif
        .preference(key: AidenChatHoldsAttachmentsKey.self, value: composerSession.holdsAttachments)
        .onDisappear {
            let hidden = { [model, composerSession] in
                Task { await model.saveDraftNow() }
                model.setViewPresent(false)
                model.readAloud.stop()
                model.setHapticsActive(false)
                model.setChatForegrounded(false)
                model.stopProgressObservation()
                composerSession.stopVoice()
            }
            let left = { [attachmentPicker, composerSession] in
                attachmentPicker.reset()
                composerSession.discardAttachments()
            }
            // A screen the shell keeps knows whether this is its containers
            // being swapped or the reader leaving (`AidenChatScreen`).
            if let screen {
                screen.disappeared(hidden: hidden, left: left)
            } else {
                hidden()
                left()
            }
        }
    }

    private var chatStack: some View {
        ZStack(alignment: .bottom) {
            AidenTranscriptScaffold(dock: dock, showsMachineSubtitle: !showsTitleCapsule) { transcript }
                // A Bot's name hangs under its avatar in the bar. Always applied,
                // empty elsewhere, so the transcript isn't rebuilt when it loads.
                .safeAreaBar(edge: .top, spacing: 0) { stackedBotTitle }
            AidenAttachmentPickerOverlay(
                picker: attachmentPicker,
                motionNamespace: attachmentMotionNamespace,
                attachmentCapacity: attachmentCapacity,
                canChoosePhotos: model.acceptsImageAttachments,
                isBotChat: model.chat.isBotChat,
                isBusy: attachmentControlsAreBusy,
                attachmentButtonCenter: attachmentButtonCenter,
                onUnavailableBotPhotos: { model.requestBotVisionSetup() },
                onChooseFiles: { isFileImporterPresented = true },
                onCaptureCameraPhoto: commitCapturedPhoto,
                onCommitPhotos: commitSelectedPhotos
            )
            .allowsHitTesting(attachmentPicker.isPresented)
            .accessibilityHidden(!attachmentPicker.isPresented)
            .zIndex(20)
        }
        .coordinateSpace(name: AidenChatAttachmentCoordinateSpace.name)
        .onPreferenceChange(AidenAttachmentButtonCenterPreferenceKey.self) { center in
            attachmentButtonCenter = center
        }
        .animation(
            AidenAttachmentPickerPresentationMotion.transition(
                isPresented: attachmentPicker.isPresented,
                reduceMotion: reduceMotion
            ),
            value: attachmentPicker.isPresented
        )
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: allowedAttachmentContentTypes,
            allowsMultipleSelection: true
        ) { result in
            model.prepareAttachments(result) { url in
                try await AidenAttachmentPreparation.fileUploadAsync(url: url)
            }
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                messageList(proxy)
                    .coordinateSpace(.named(AidenTranscriptRowSpace.name))
                    .background {
                        AidenChatScrollObserver(
                            onFollowEvent: { follow.handle($0) },
                            onMetrics: { follow.updateMetrics($0) }
                        )
                    }
            }
            .defaultScrollAnchor(
                AidenChatScrollPolicy.initialTranscriptAnchor,
                for: .initialOffset
            )
            .defaultScrollAnchor(
                AidenChatScrollPolicy.sizeChangeAnchor(shouldFollowLatest: follow.isFollowing),
                for: .sizeChanges
            )
            .scrollDismissesKeyboard(.interactively)
            .onScrollPhaseChange { _, phase, context in
                // Only the reader moves the reading place, not a layout pass
                // on the way back to it.
                guard phase == .idle, !follow.holdsPlace else { return }
                parts.readingPlace = follow.isFollowing ? nil : place(in: context.geometry) ?? parts.readingPlace
            }
            .onChange(of: follow.isFollowing) { _, following in
                if following { parts.readingPlace = nil }
            }
            // A rebuilt screen (an iPhone Duo opening or closing) starts at
            // the latest, and a resized one keeps its offset over reflowed
            // rows. Either way the reader goes back to their place, and again
            // each time the rows' height changes as they measure, until they
            // scroll or ask for the latest (`AidenTranscriptFollowController.holdsPlace`).
            // Whatever size the rows settle at, they settle at the place.
            .onAppear { startReturningToReadingPlace(proxy) }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { _ in
                startReturningToReadingPlace(proxy)
            }
            .onScrollGeometryChange(for: CGSize.self) { $0.contentSize } action: { _, _ in
                guard follow.holdsPlace else { return }
                returnToReadingPlace(proxy)
            }
            // The part the transcript shows, clear of the bars and the
            // composer over it. The container is already that part: its
            // height leaves out the content insets (iOS 27.1, iPhone Duo
            // closed: 318 points of a 678-point screen with 82 and 277 of
            // insets), so taking them off again would leave it negative.
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.containerSize.height
            } action: { _, height in
                parts.visibleHeight = height
                // The anchor depends on this height too.
                if follow.holdsPlace { returnToReadingPlace(proxy) }
            }
            .aidenReportsTranscriptFit(to: follow)
            .aidenKeepsPlaceOnPrepend(anchorID: $keptPlaceID, proxy: proxy)
            .aidenOnComposerInsetChange { followLatest(proxy, animated: false) }
            .gesture(AidenTranscriptTap {
                composerSession.putAwayKeyboard()
                // A beat later, so a message or footer that took the same tap
                // has had its say, in whichever order UIKit asked them.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    revealFooter { $0.tapTranscript() }
                }
            })
            .background {
                // A leaf reads the per-tick trigger, so a reveal tick re-snaps
                // a following reader without re-running this screen.
                AidenStreamingFollowTrigger(trigger: { model.streamingScrollTrigger }) {
                    followLatest(proxy, animated: false)
                }
            }
            .overlay(alignment: .bottom) {
                if follow.showsJumpButton {
                    AidenChatJumpToLatestButton {
                        jumpToLatest(proxy)
                    }
                    .padding(.bottom, 10)
                    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: follow.showsJumpButton)
            .onAppear { follow.setStreaming(model.isStreaming) }
            .onChange(of: model.isStreaming) { _, streaming in
                follow.setStreaming(streaming)
            }
            .onChange(of: model.explicitSendCount) { _, _ in
                jumpToLatest(proxy)
            }
            .onChange(of: model.chat.messages.count) { _, _ in
                followLatest(proxy, animated: false)
            }
            .onChange(of: model.pendingApproval?.id) { _, approvalID in
                guard approvalID != nil else { return }
                composerSession.putAwayKeyboard()
                followLatest(proxy, animated: true)
            }
        }
    }

    private func messageList(_ proxy: ScrollViewProxy) -> some View {
        AidenTranscriptRowStack(
            spacing: presentationStyle == .botMessages ? 3 : 18,
            bottomAnchorID: AidenChatScrollPolicy.transcriptBottomAnchorID,
            // A group that opens or closes changes height under a reader who is
            // following the end, and that would push the line they tapped away.
            onGroupToggle: { [follow] in follow.handle(.userScrollBegin) }
        ) {
            if let forkLabel = model.forkSource.label {
                AidenChatForkLineageRow(label: forkLabel)
            }
            if model.hasOlderMessages {
                AidenLoadEarlierMessagesButton(isLoading: model.isLoadingEarlierMessages) {
                    loadEarlierMessages()
                }
            }
            // Settled rows live in a child view that tracks only `chat`, so
            // per-token liveText updates never re-evaluate finished messages.
            // `chat` is a value snapshot: comparing model.chat would read the
            // same live property on both sides of == and never differ.
            AidenSettledMessageRows(
                model: model,
                chat: model.chat,
                presentationStyle: presentationStyle,
                readAloudCandidateID: model.readAloudCandidateID,
                readAloudActiveID: model.readAloud.activeMessageID,
                revealedFooterID: footerReveal.shownID,
                onTapMessage: { messageID in revealFooter { $0.tapMessage(messageID) } },
                onTouchFooter: { revealFooter { $0.touchFooter() } },
                renderIDs: model.messageRenderIDs,
                imageArrivalRevealIDs: model.imageArrivalRevealGenerationIDs,
                appControlsAvailable: model.canReadAppControls,
                onAskAbout: model.isReadOnlyPresentation ? nil : { selection in
                    if model.askAbout(selection) { composerSession.raiseKeyboard() }
                },
                forkAvailability: onOpenChat == nil ? nil : model.forkAvailability,
                onFork: onOpenChat == nil ? nil : { messageID, action in
                    if action == .forkWithSummary {
                        forkSummaryRequest = AidenForkSummaryRequest(id: messageID)
                    } else {
                        performFork(messageID: messageID, action: action)
                    }
                },
                canSettleForkSummary: model.canSettleForkSummary,
                isSettlingForkSummary: model.isSettlingForkSummary,
                visualViewerAvailable: model.supportsVisualViewer,
                onVisualPrompt: model.isReadOnlyPresentation ? nil : { (prompt: String) -> Void in
                    _ = model.appendVisualPrompt(prompt)
                },
                browserRecordingsAvailable: model.supportsBrowserRecordings,
                onRowFrame: { [parts, rowFrameScreen] id, frame in
                    // The place's row measured at a new height after the
                    // reader was brought back: bring them back again, or an
                    // anchor worked out for the old height lands elsewhere.
                    if parts.setRowFrame(frame, for: id, from: rowFrameScreen), follow.holdsPlace {
                        returnToReadingPlace(proxy)
                    }
                }
            )
            .equatable()
            if model.showsLiveResponse {
                AidenLiveResponseView(model: model, presentationStyle: presentationStyle)
            }
        }
        .padding(.horizontal)
        .padding(.top, 20)
    }

    /// Shows or hides a message footer with a short fade, or at once under Reduce Motion.
    private func revealFooter(_ change: (inout AidenMessageFooterReveal) -> Void) {
        var next = footerReveal
        change(&next)
        guard next.shownID != footerReveal.shownID else {
            footerReveal = next
            return
        }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { footerReveal = next }
    }

    private func performFork(messageID: String, action: AidenChatForkMenuAction, focus: String = "") {
        guard let onOpenChat else { return }
        Task { @MainActor in
            guard let forked = await model.fork(
                messageId: messageID,
                action: action,
                summaryFocus: focus
            ) else { return }
            // The fork lives on this chat's machine, and goes on opening there.
            onOpenChat(forked)
        }
    }

    private func performContinueInNewChat(workspaceID: String) {
        guard let onOpenChat else { return }
        Task { @MainActor in
            guard let continued = await model.continueInNewChat(workspaceId: workspaceID) else { return }
            isChoosingContinueWorkspace = false
            // The new chat lives on this chat's machine, and opens there.
            onOpenChat(continued)
        }
    }

    private var simulatorRefreshKey: String {
        "\(model.chat.id)|\(chatLoadEpoch)|\(simulatorRefreshEpoch)|\(model.offersSimulators)"
    }

    /// Revision 47: a Workspace chat's total, or a Bot chat's month.
    private var spendingOwner: AidenSpendingOwner {
        model.chat.botId.map(AidenSpendingOwner.bot) ?? .chat(model.chat.id)
    }

    private var spendingTransport: AidenSpendingTransport? { model.spendingTransport }

    private var backgroundJobsTransport: AidenBackgroundJobTransport? { model.backgroundJobsTransport }

    private var backgroundJobsRefreshKey: String {
        [
            model.chat.id,
            model.owner.instanceId,
            String(model.ownerServer?.capabilities.contains(.chatJobs) == true),
            String(model.isStreaming),
            String(model.chat.messages.count),
            String(chatLoadEpoch),
            String(showsBackgroundJobs),
            String(scenePhase == .active),
        ].joined(separator: "|")
    }

    /// Revision 53: New worktree sits beside the composer's chips until the
    /// chat's first message, and stays hidden while that message is on its way.
    private var showsNewWorktreeChip: Bool {
        allowsMutations && model.offersNewWorktree && !model.isSettingUpWorktree
    }

    private var newWorktreeRefreshKey: String {
        [
            model.chat.id,
            model.chat.workspaceId,
            model.owner.instanceId,
            String(model.ownerServer?.capabilities.contains(.chatNewWorktree) == true),
        ].joined(separator: "|")
    }

    /// Re-read after each reply settles and after a send the Mac refused.
    private var spendingRefreshKey: String {
        [
            model.chat.id,
            model.owner.instanceId,
            String(model.ownerServer?.supportsSpendingLimits == true),
            String(model.isStreaming),
            String(model.chat.messages.count),
            model.sendRecoveryMessage ?? "",
        ].joined(separator: "|")
    }

    private var dockContent: AidenDockContent { .resolve(model.dockInput) }

    /// The chat's composer and question card each hold their own Stop.
    private var dock: AidenChatDock {
        AidenChatDock(
            content: dockContent,
            session: composerSession,
            config: AidenComposerView.config(
                for: model,
                placeholder: botToolsModel?.bot.map { "Ask \($0.name)" } ?? "Message Aiden"
            ),
            actions: AidenDockActions(),
            slots: AidenDockSlots(
                above: {
                    dockNotices.disabled(model.isReadOnlyPresentation)
                },
                footer: {
                    if let notice = model.revokedMachineNotice {
                        AidenRevokedMachineNoticeRow(notice: notice) { dismissChat() }
                    }
                },
                question: { _ in
                    if let question = model.pendingQuestion {
                        AidenQuestionCard(
                            model: model,
                            prompt: question,
                            onSubmit: { request in
                                Task {
                                    await model.respondToQuestion(
                                        request,
                                        promptID: question.id,
                                        idempotencyKey: UUID()
                                    )
                                }
                            }
                        )
                        .disabled(!model.isConnected || model.isReadOnlyPresentation || model.isRespondingToQuestion || model.isStopping)
                        .id(question.id)
                    }
                },
                composer: { config in
                    AidenComposerView(
                        model: model,
                        session: composerSession,
                        autoStartVoice: autoStartVoice,
                        attachmentPicker: attachmentPicker,
                        motionNamespace: attachmentMotionNamespace,
                        canToggleAttachments: canToggleAttachmentPicker,
                        onToggleAttachmentPicker: toggleAttachmentPicker,
                        placeholder: config.placeholder
                    )
                    .disabled(model.isReadOnlyPresentation)
                }
            )
        )
    }

    /// What the chat keeps above the composer, whatever is in its place.
    @ViewBuilder
    private var dockNotices: some View {
        if let current = spending.spending, allowsMutations {
            AidenSpendingNotice(
                spending: current,
                botName: nil,
                isAllowing: spending.isAllowing,
                canAllow: model.ownerServer?.capabilities.contains(model.chat.isBotChat ? .botWrite : .chatWrite) == true,
                errorMessage: spending.errorMessage,
                onAllowMore: { Task { await spending.allowMore(transport: spendingTransport) } }
            )
        }
        if let message = model.sendRecoveryMessage {
            VStack(alignment: .leading, spacing: 8) {
                Text(message).font(.footnote).accessibilityAddTraits(.updatesFrequently)
                HStack {
                    Button("Retry message") { Task { await model.send(retry: true) } }.disabled(!model.canRetrySend)
                    Button("I checked — dismiss") { Task { await model.discardPendingSend() } }
                }.font(.footnote)
            }.padding(12).background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
        if model.isSettingUpWorktree {
            AidenNewWorktreeSetupRow { model.cancelWorktreeSetup() }
        }
        if simulators.deviceCount > 0 || backgroundJobs.runningCount > 0 || showsNewWorktreeChip {
            HStack(spacing: 8) {
                if simulators.deviceCount > 0 {
                    AidenSimulatorDeviceButton(count: simulators.deviceCount) {
                        simulatorViewer = simulators.makeViewer(client: model.simulatorsClient)
                    }
                }
                AidenBackgroundJobsChip(running: backgroundJobs.runningCount) {
                    showsBackgroundJobs = true
                }
                if showsNewWorktreeChip {
                    AidenNewWorktreeChip(isOn: $model.startsInNewWorktree)
                        .disabled(model.isStarting)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, simulators.deviceCount > 0 ? 0 : 4)
        }
        AidenChatProgressControls(
            taskProgress: model.taskProgress,
            agentRoster: model.agentRoster,
            canReadTasks: model.canReadTaskProgress,
            canReadAgents: model.canReadAgentRoster,
            taskIsStale: model.isTaskProgressStale,
            agentIsStale: model.isAgentRosterStale,
            openTasks: { progressSheet = .tasks },
            openAgents: { progressSheet = .agents }
        )
        if let notice = model.macOnlyAgentNotice {
            Text(notice)
                .font(.footnote)
                .foregroundStyle(palette.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
        }
    }

    private var attachmentCapacity: Int {
        AidenAttachmentPickerPolicy.availableCapacity(pendingCount: model.pendingAttachments.count)
    }

    private var attachmentControlsAreBusy: Bool {
        !model.isConnected || !canToggleAttachmentPicker
    }

    private var canToggleAttachmentPicker: Bool {
        AidenAttachmentPickerPolicy.canPresent(
            isReadOnly: model.isReadOnlyPresentation,
            isStreaming: model.isStreaming,
            isUploading: model.isUploadingAttachment,
            isPreparing: model.isPreparingAttachments,
            capacity: attachmentCapacity
        )
    }

    private var allowedAttachmentContentTypes: [UTType] {
        let textTypes: [UTType] = [.plainText, .sourceCode, .json, .xml, .commaSeparatedText]
        return model.acceptsImageAttachments ? [.image] + textTypes : textTypes
    }

    private func toggleAttachmentPicker() {
        guard canToggleAttachmentPicker else { return }
        composerSession.putAwayKeyboard()
        if attachmentPicker.isPresented {
            attachmentPicker.dismiss()
        } else {
            attachmentPicker.openMenu()
        }
    }

    private func openCameraForLaunch() {
        guard canToggleAttachmentPicker, model.acceptsImageAttachments else { return }
        composerSession.putAwayKeyboard()
        attachmentPicker.beginShowingCamera()
    }

    private func commitSelectedPhotos() {
        guard !attachmentControlsAreBusy else { return }
        let commit = attachmentPicker.beginCommit(pendingCount: model.pendingAttachments.count)
        guard let commit else { return }

        let preparation = model.prepareAttachments(Result<[PHAsset], Error>.success(commit.assets)) { asset in
            let picked = try await AidenPhotoLibraryImageLoader.pickedImage(for: asset)
            return try await AidenAttachmentPreparation.imageUploadAsync(
                data: picked.data,
                name: picked.name
            )
        }
        guard let preparation else {
            attachmentPicker.finishCommit(commit.id)
            return
        }
        Task { @MainActor in
            await preparation.value
            attachmentPicker.finishCommit(commit.id)
        }
    }

    private func commitCapturedPhoto(_ data: Data) {
        guard !attachmentControlsAreBusy, attachmentCapacity > 0,
              model.acceptsImageAttachments else { return }
        attachmentPicker.dismiss()
        model.prepareAttachments(.success([data])) { capturedData in
            try await AidenAttachmentPreparation.imageUploadAsync(
                data: capturedData,
                name: "Camera Photo.jpg"
            )
        }
    }

    /// A Bot's header pill takes the title's place in a bar along the top. A
    /// side rail can't hold it, so there the title names the Bot.
    private var screenTitle: String {
        guard presentationStyle == .botMessages else { return model.chat.displayTitle }
        return botToolsModel?.bot?.name ?? model.chat.title
    }

    /// Whether the bar holds the title capsule, which names the machine itself.
    private var showsTitleCapsule: Bool {
        coordinator != nil && (botToolsModel != nil || model.chat.botId == nil)
    }

    /// Telegram's chat header: the title over a status line in the middle, and
    /// the other side's avatar on the right.
    @ToolbarContentBuilder
    private var chatToolbar: some ToolbarContent {
        if let coordinator, let botToolsModel {
            ToolbarItem(placement: .principal) {
                botAvatarHeader(coordinator: coordinator, model: botToolsModel)
            }
            ToolbarItem(placement: .topBarTrailing) { sessionSheetButton }
        } else if model.chat.botId == nil, coordinator != nil {
            ToolbarItem(placement: .principal) {
                AidenChatTitleCapsule(
                    title: model.chat.displayTitle,
                    status: workspaceTitleStatus,
                    accessibilityHint: "Shows this chat’s actions"
                ) {
                    showsSessionSheet = true
                }
            }
            ToolbarItem(placement: .topBarTrailing) { workspaceAvatarButton }
        }
    }

    /// What the agent is doing, or where the chat lives.
    private var workspaceTitleStatus: AidenChatTitleStatus? {
        AidenChatTitleStatus.workspace(
            isStreaming: model.isStreaming,
            streamState: model.streamState,
            runningToolName: model.tools.last(where: { $0.status == nil })?.name,
            hasLiveText: !model.liveText.isEmpty,
            workspaceName: workspace.flatMap { $0.noWorkspace ? nil : $0.name },
            branch: workspace?.branchName,
            machine: conversationMachine
        )
    }

    /// The workspace as the chat's avatar. Like the title, it opens this chat's
    /// actions, and keeps "More" as its name. A chat with no workspace has no
    /// avatar and no More button: its title opens the same actions. A bar draws
    /// a Label's title unless its icon is an Image, so the avatar is the label.
    @ViewBuilder
    private var workspaceAvatarButton: some View {
        if let workspace, !workspace.noWorkspace {
            Button {
                showsSessionSheet = true
            } label: {
                AidenWorkspaceInitialsAvatar(name: workspace.name, size: 34)
                    .contentShape(Circle())
            }
            .buttonBorderShape(.circle)
            .accessibilityLabel("More")
            .accessibilityHint("\(workspace.name). Shows this chat’s actions")
            .accessibilityIdentifier("chat-avatar")
        }
    }

    private var sessionSheetButton: some View {
        Button {
            showsSessionSheet = true
        } label: {
            // A title as well as the symbol, for the side rail's overflow.
            Label("More", systemImage: AidenChromeSymbols.overflowMenu)
                .font(.body.weight(.semibold))
                .contentShape(Circle())
        }
        .buttonBorderShape(.circle)
    }

    private var sessionSheetConfig: AidenSessionSheetConfig {
        let canReadAloud = model.readAloudCandidateID != nil
        let isReadingAloud = model.readAloud.activeMessageID != nil
        if let coordinator, let botToolsModel {
            return .botChat(
                title: botToolsModel.bot?.name ?? model.chat.title,
                hasFiles: botToolsModel.fileGrant(coordinator: coordinator, hostAllowsMutations: effectiveAllowsMutations) != nil,
                canDelete: AidenBotDeletion.isAvailable(coordinator: coordinator, machine: pinnedOwner)
                    && botToolsModel.bot != nil,
                canReadAloud: canReadAloud,
                isReadingAloud: isReadingAloud
            )
        }
        return .chat(
            title: model.chat.displayTitle,
            canRename: model.canRename,
            canFork: onOpenChat != nil && model.forkAvailability != nil && model.latestForkableMessageID != nil,
            canReadAloud: canReadAloud,
            isReadingAloud: isReadingAloud,
            hasFiles: workspace?.hasFolder == true
        )
    }

    private func runPendingSessionAction() {
        guard let action = pendingSessionAction else { return }
        pendingSessionAction = nil
        switch action {
        case .rename:
            renameTitle = model.chat.displayTitle
            isRenaming = true
        case .fork:
            if let messageID = model.latestForkableMessageID {
                performFork(messageID: messageID, action: .forkHere)
            }
        case .readAloud:
            if let messageID = model.readAloud.activeMessageID ?? model.readAloudCandidateID {
                model.toggleReadAloud(messageID)
            }
        case .files:
            if let coordinator, let botToolsModel {
                openBotFiles(coordinator: coordinator, model: botToolsModel)
            } else {
                workspaceFileReference = nil
                showsWorkspaceFile = true
            }
        case .profile:
            if let coordinator, let botToolsModel {
                openBotProfile(coordinator: coordinator, model: botToolsModel)
            }
        case .delete:
            isConfirmingBotDelete = true
        case .memory, .advanced:
            // A durable Bot's own sheet has these; this screen never lists them.
            break
        }
    }

    /// The Bot's name capsule under its avatar, once the Bot's tools are known.
    @ViewBuilder
    private var stackedBotTitle: some View {
        if let coordinator, let botToolsModel {
            AidenChatStackedTitle(capsule: botHeaderPill(coordinator: coordinator, model: botToolsModel))
        }
    }

    /// The Bot's name over what it is doing. Tapping it opens the Profile.
    private func botHeaderPill(
        coordinator: AidenRemoteCoordinator,
        model botModel: AidenBotChatToolsModel
    ) -> AidenChatTitleCapsule {
        AidenChatTitleCapsule(
            title: botModel.bot?.name ?? model.chat.title,
            status: legacyBotTitleStatus(botModel.bot),
            accessibilityHint: "Opens the Bot’s profile"
        ) {
            openBotProfile(coordinator: coordinator, model: botModel)
        }
    }

    /// A Bot chat opened as a chat runs like a Workspace chat: its live reply
    /// says what it is doing, and otherwise the line says what the Bot is for.
    private func legacyBotTitleStatus(_ bot: AidenBotDetail?) -> AidenChatTitleStatus {
        if model.isStreaming || model.streamState == .waitingForApproval,
           let live = AidenChatTitleStatus.workspace(
               isStreaming: model.isStreaming,
               streamState: model.streamState,
               runningToolName: model.tools.last(where: { $0.status == nil })?.name,
               hasLiveText: !model.liveText.isEmpty,
               workspaceName: nil
           ) {
            return live
        }
        return .bot(
            state: nil, statusWord: nil, waitsForYou: false, purpose: bot?.purpose, machine: conversationMachine
        )
    }

    /// The Bot's face in the middle of the bar, over its name; like the name,
    /// it opens the Profile.
    private func botAvatarHeader(
        coordinator: AidenRemoteCoordinator,
        model botModel: AidenBotChatToolsModel
    ) -> some View {
        AidenChatHeaderAvatar {
            openBotProfile(coordinator: coordinator, model: botModel)
        } avatar: {
            if let bot = botModel.bot {
                AidenBotCanonicalAvatarView(
                    coordinator: coordinator,
                    machine: pinnedOwner,
                    botID: bot.id,
                    avatar: bot.avatar,
                    name: bot.name,
                    size: AidenChatHeaderAvatar<EmptyView>.size
                )
            } else {
                Circle().fill(palette.raised)
            }
        }
        .accessibilityIdentifier("chat-avatar")
    }

    @ViewBuilder
    private func botSheetContent(_ destination: AidenBotChatSheet) -> some View {
        if let coordinator, let botToolsModel {
            switch destination {
            case .profile(let bot):
                AidenBotProfileView(
                    coordinator: coordinator,
                    machine: pinnedOwner,
                    initialSummary: bot,
                    onChanged: {
                        Task { await botToolsModel.load(coordinator: coordinator) }
                    },
                    onDeleted: {
                        botSheet = nil
                        dismissChat()
                    }
                )
            case .files(let grant):
                NavigationStack {
                    AidenBotConversationFilesView(coordinator: coordinator, grant: grant)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { botSheet = nil }
                            }
                        }
                }
            }
        }
    }

    private func openBotProfile(
        coordinator: AidenRemoteCoordinator,
        model: AidenBotChatToolsModel
    ) {
        if let bot = model.bot {
            botSheet = .profile(AidenBotSummary(detail: bot))
            return
        }
        Task {
            guard await model.refresh(coordinator: coordinator),
                  let bot = model.bot else { return }
            botSheet = .profile(AidenBotSummary(detail: bot))
        }
    }

    private func deleteBotFromChat() {
        guard let coordinator, let bot = botToolsModel?.bot else { return }
        Task {
            do {
                try await AidenBotDeletion.delete(
                    botID: bot.id,
                    revision: bot.revision,
                    coordinator: coordinator,
                    machine: pinnedOwner
                )
                dismissChat()
            } catch is CancellationError {
                return
            } catch {
                model.presentedError = "\(bot.name) wasn’t deleted. Please try again."
            }
        }
    }

    private func openBotFiles(
        coordinator: AidenRemoteCoordinator,
        model: AidenBotChatToolsModel
    ) {
        Task {
            guard await model.refresh(coordinator: coordinator),
                  let grant = model.fileGrant(
                      coordinator: coordinator,
                      hostAllowsMutations: effectiveAllowsMutations
                  ) else { return }
            botSheet = .files(grant)
        }
    }

    /// Prepending would otherwise leave the viewport at the same offset over
    /// new content. Once the page is in, name the message that was first, and
    /// the transcript scrolls back to it after the rows above it are laid out
    /// (`aidenKeepsPlaceOnPrepend`). Scrolling in this same turn does nothing:
    /// the stack has not laid out the new rows yet, so the old position still
    /// answers.
    private func loadEarlierMessages() {
        let anchorID = model.chat.messages.first?.id
        let ticket = follow.placeTicket()
        Task {
            await model.loadEarlierMessages()
            guard let anchorID, model.chat.messages.first?.id != anchorID,
                  model.chat.messages.contains(where: { $0.id == anchorID }),
                  // The reader may have jumped to latest, sent, or scrolled while the page loaded.
                  follow.keepsPlace(ticket) else { return }
            keptPlaceID = model.renderID(forMessageID: anchorID)
        }
    }

    /// Where the reader is now, from the rows built: the first row across
    /// the visible top, below the bars, in the content's space.
    private func place(in geometry: ScrollGeometry) -> AidenReadingPlace? {
        let rows = AidenTranscriptRowIdentity.rows(for: model.chat.messages, renderIDs: model.messageRenderIDs)
            .compactMap { row in parts.rowFrames[row.id].map { (id: row.id, frame: $0) } }
        return AidenReadingPlace.at(top: geometry.contentOffset.y + geometry.contentInsets.top, rows: rows)
    }

    /// Scrolls back to where the reader was, once the rows are laid out at
    /// this size. Nothing to do while following the latest.
    private func startReturningToReadingPlace(_ proxy: ScrollViewProxy) {
        // The place is cleared whenever the reader follows the latest, so a
        // place here means they were away from it, whatever a rebuilt scroll
        // view starting at the bottom has told the latch since.
        guard parts.readingPlace != nil else { return }
        follow.handle(.holdPlace)
        returnToReadingPlace(proxy)
    }

    private func returnToReadingPlace(_ proxy: ScrollViewProxy) {
        guard let place = parts.readingPlace, !follow.isFollowing else { return }
        Task { @MainActor in
            await Task.yield()
            guard parts.readingPlace == place, !follow.isFollowing else { return }
            // The place's message was deleted or isn't loaded: nothing to go
            // back to, so follow may turn on at the bottom again.
            guard AidenTranscriptRowIdentity.rows(for: model.chat.messages, renderIDs: model.messageRenderIDs)
                .contains(where: { $0.id == place.rowID }) else {
                parts.readingPlace = nil
                follow.handle(.releasePlace)
                return
            }
            let anchor = place.anchor(rowHeight: parts.rowFrames[place.rowID]?.height, viewHeight: parts.visibleHeight)
            proxy.scrollTo(place.rowID, anchor: anchor)
        }
    }

    /// Jump to latest or a send: re-arms follow, then snaps (while
    /// streaming) or animates (when idle) to the bottom sentinel.
    private func jumpToLatest(_ proxy: ScrollViewProxy) {
        follow.scheduleFollowScroll(isUserInitiated: true, animated: true) { animated in
            scrollToBottom(proxy, animated: animated)
        }
    }

    /// An automatic follow; it does nothing unless follow is latched on.
    private func followLatest(_ proxy: ScrollViewProxy, animated: Bool) {
        follow.scheduleFollowScroll(isUserInitiated: false, animated: animated) { animated in
            scrollToBottom(proxy, animated: animated)
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        let scroll = {
            proxy.scrollTo(AidenChatScrollPolicy.transcriptBottomAnchorID, anchor: .bottom)
        }
        if animated, !reduceMotion {
            withAnimation(.easeOut(duration: 0.2), scroll)
        } else {
            scroll()
        }
    }
}

func aidenChatIsScrolledAwayFromLatest(
    contentOffsetY: CGFloat,
    containerHeight: CGFloat,
    contentHeight: CGFloat,
    bottomInset: CGFloat,
    threshold: CGFloat = 72
) -> Bool {
    guard containerHeight > 0, contentHeight > containerHeight else { return false }
    let viewportBottom = contentOffsetY + containerHeight
    let contentBottom = contentHeight + max(0, bottomInset)
    return contentBottom - viewportBottom > threshold
}

struct AidenChatJumpToLatestButton: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette
    @ScaledMetric(relativeTo: .body) private var arrowSize: CGFloat = 13

    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                // Grows with the text size, but stays inside the 34 pt circle.
                .font(.system(size: min(arrowSize, 20), weight: .semibold))
                .foregroundStyle(palette.foreground)
                .frame(width: 34, height: 34)
                .contentShape(Circle())
                .modifier(AidenChatJumpToLatestGlassModifier(reduceTransparency: reduceTransparency))
        }
        .buttonStyle(.plain)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .accessibilityLabel("Jump to latest")
        .accessibilityHint("Scrolls to the newest message")
    }
}

/// Pages the transcript back one window. A soft raised capsule with no
/// border, matching the transcript's other quiet secondary controls.
private struct AidenLoadEarlierMessagesButton: View {
    @Environment(\.aidenPalette) private var palette

    let isLoading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isLoading {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.caption2.weight(.semibold))
                }
                Text(isLoading ? "Loading earlier messages" : "Load earlier messages")
                    .font(.footnote.weight(.medium))
            }
            .foregroundStyle(palette.secondary)
            .padding(.horizontal, 14)
            .frame(minHeight: 32)
            .background(palette.raised, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 44)
        .accessibilityHint("Shows older messages in this conversation")
    }
}

private struct AidenChatJumpToLatestGlassModifier: ViewModifier {
    @Environment(\.aidenPalette) private var palette
    let reduceTransparency: Bool

    /// It floats over the transcript, white user bubbles included, so it
    /// carries the raised fill under its glass and a soft lift: clear glass
    /// over a white bubble left a bare arrow on top of the bubble's text.
    @ViewBuilder
    func body(content: Content) -> some View {
        Group {
            if reduceTransparency {
                content
                    .background(palette.raised, in: Circle())
                    .overlay(Circle().stroke(palette.foreground.opacity(0.14), lineWidth: 0.5))
            } else {
                content.glassEffect(.regular.tint(palette.raised.opacity(0.85)).interactive(), in: Circle())
            }
        }
        .shadow(color: palette.foreground.opacity(0.16), radius: 8, y: 3)
    }
}

/// Revision 64: choose another workspace to continue a chat whose folder is
/// gone. Rows name the workspace, its permission and branch, never a path.
struct AidenContinueInNewChatSheet: View {
    let workspaces: [AidenWorkspace]
    let isContinuing: Bool
    let errorMessage: String?
    let onCancel: () -> Void
    let onChoose: (String) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(workspaces) { workspace in
                        Button {
                            onChoose(workspace.id)
                        } label: {
                            AidenWorkspaceRow(workspace: workspace)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isContinuing)
                    }
                } header: {
                    Text("Workspaces")
                } footer: {
                    Text("Aiden copies this whole chat into a new chat in the workspace you choose. This chat stays as it is.")
                }
                if let errorMessage {
                    Section {
                        Label {
                            Text(errorMessage)
                                .foregroundStyle(.primary)
                        } icon: {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .navigationTitle("Continue in a New Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                if isContinuing {
                    ToolbarItem(placement: .confirmationAction) {
                        ProgressView()
                            .accessibilityLabel("Continuing in a new chat")
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isContinuing)
    }
}
