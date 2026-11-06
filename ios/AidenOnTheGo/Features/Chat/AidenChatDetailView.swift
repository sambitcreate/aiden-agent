import Photos
import SwiftUI
import UniformTypeIdentifiers

private struct AidenBotHeaderNameGlassModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(palette.raised, in: Capsule())
        } else {
            content.glassEffect(.regular.interactive(), in: Capsule())
        }
    }
}

private extension View {
    func aidenBotHeaderNameGlass() -> some View {
        modifier(AidenBotHeaderNameGlassModifier())
    }
}

enum AidenChatAttachmentCoordinateSpace {
    static let name = "aiden-chat-attachment-coordinate-space"
}

struct AidenAttachmentButtonCenterPreferenceKey: PreferenceKey {
    static let defaultValue: CGPoint? = nil

    static func reduce(value: inout CGPoint?, nextValue: () -> CGPoint?) {
        value = nextValue() ?? value
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
    @State private var botToolsModel: AidenBotChatToolsModel?
    @State private var botSheet: AidenBotChatSheet?
    @State private var isConfirmingBotDelete = false
    @Environment(\.dismiss) private var dismissChat
    @State private var workspaceFileReference: String?
    @State private var showsWorkspaceFile = false
    @State private var progressSheet: AidenProgressSheet?
    @State private var follow = AidenTranscriptFollowController()
    @State private var attachmentPicker = AidenAttachmentPickerState()
    @State private var isFileImporterPresented = false
    @State private var attachmentButtonCenter: CGPoint?
    @FocusState private var composerIsFocused: Bool
    @Namespace private var attachmentMotionNamespace
    @State private var coordinator: AidenRemoteCoordinator?
    @State private var forkSummaryRequest: AidenForkSummaryRequest?
    @State private var simulators = AidenChatSimulatorsModel()
    @State private var simulatorViewer: AidenSimulatorViewerModel?
    @State private var simulatorRefreshEpoch = 0
    @State private var spending = AidenSpendingNoticeModel()
    @State private var backgroundJobs = AidenBackgroundJobsModel()
    @State private var showsBackgroundJobs = false
    @State private var showsSessionSheet = false
    /// Runs once the sheet has closed, so what it opens has the screen to itself.
    @State private var pendingSessionAction: AidenSessionAction?
    @State private var isRenaming = false
    @State private var renameTitle = ""
    let autoStartVoice: Bool
    let allowsMutations: Bool
    /// Opens a chat this one was forked into. Nil hides the fork actions,
    /// for surfaces that cannot navigate to a new Workspace chat.
    private let onOpenChat: (@MainActor (AidenChat) -> Void)?

    init(
        coordinator: AidenRemoteCoordinator,
        chat: AidenChat,
        autoStartVoice: Bool = false,
        allowsMutations: Bool = true,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in },
        onOpenChat: (@MainActor (AidenChat) -> Void)? = nil,
        composerSession: AidenComposerSession? = nil
    ) {
        _coordinator = State(initialValue: coordinator)
        self.onOpenChat = onOpenChat
        let model = AidenChatViewModel(
            coordinator: coordinator,
            chat: chat,
            owner: (try? coordinator.ownerContext(for: coordinator.activeInstanceId ?? "")) ?? .noMachine,
            allowsMutations: allowsMutations,
            onChatUpdated: onChatUpdated,
            onChatActivityChanged: onChatActivityChanged
        )
        _model = State(initialValue: model)
        _composerSession = State(
            initialValue: composerSession ?? AidenComposerSession(draftOwner: model, attachmentOwner: model)
        )
        _botToolsModel = State(initialValue: chat.botId.map {
            AidenBotChatToolsModel(chatID: chat.id, botID: $0)
        })
        self.autoStartVoice = autoStartVoice
        self.allowsMutations = allowsMutations
    }

#if DEBUG
    init(readOnlyFixture chat: AidenChat) {
        _coordinator = State(initialValue: nil)
        let model = AidenChatViewModel(readOnlyFixture: chat)
        _model = State(initialValue: model)
        _composerSession = State(initialValue: AidenComposerSession(draftOwner: model, attachmentOwner: model))
        _botToolsModel = State(initialValue: nil)
        autoStartVoice = false
        allowsMutations = false
        onOpenChat = nil
    }
#endif

    private var workspace: AidenWorkspace? {
        coordinator?.workspaces.first { $0.id == model.chat.workspaceId }
    }

    private var botToolsSessionIdentity: AidenBotChatToolsSessionIdentity? {
        coordinator.map(AidenBotChatToolsSessionIdentity.init)
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
            composerIsFocused = false
            attachmentPicker.dismiss()
        }
        .onChange(of: model.isStreaming) { _, isStreaming in
            guard isStreaming else { return }
            attachmentPicker.dismiss()
        }
        .onChange(of: dockContent.keepsComposer) { _, keepsComposer in
            guard !keepsComposer else { return }
            composerIsFocused = false
            attachmentPicker.dismiss()
        }
        .navigationTitle(presentationStyle == .botMessages ? "" : model.chat.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { chatToolbar }
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
        .onChange(of: coordinator?.connectionState) { old, new in
            // A chat opened from its saved copy while connecting reloads once
            // the Mac answers, so the transcript and read state reconcile.
            if new == .connected, old != .connected { chatLoadEpoch &+= 1 }
        }
        .task(id: coordinator?.server?.serverTime) {
            guard scenePhase == .active else { return }
            model.startProgressObservation()
        }
        .task(id: botToolsSessionIdentity) {
            model.readAloud.stop()
            guard let coordinator, let botToolsModel else { return }
            botToolsModel.resetForSessionChange()
            await botToolsModel.load(coordinator: coordinator)
        }
        .environment(\.openURL, OpenURLAction { url in
            let raw = url.relativeString
            if AidenWorkspaceFileLink.path(raw) != nil, model.chat.botId == nil, workspace?.hasFolder == true {
                workspaceFileReference = raw
                showsWorkspaceFile = true
                return .handled
            }
            if url.isFileURL || raw.hasPrefix("/") || raw.hasPrefix("./") || raw.hasPrefix("../") || raw.hasPrefix("~/") { return .discarded }
            return .systemAction
        })
        .sheet(isPresented: $showsWorkspaceFile) {
            if let coordinator, let workspace {
                NavigationStack { AidenWorkspaceFilesView(coordinator: coordinator, workspace: workspace, initialReference: workspaceFileReference) }
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
            await simulators.refresh(coordinator: coordinator, chatId: model.chat.id)
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
            Button("OK", role: .cancel) { model.presentedError = nil; model.readAloud.errorMessage = nil }
        } message: {
            Text(model.presentedError ?? model.readAloud.errorMessage ?? "The operation could not be completed.")
        }
        .aidenBotDeleteConfirmation(
            isPresented: $isConfirmingBotDelete,
            botName: botToolsModel?.bot?.name ?? model.chat.title
        ) {
            deleteBotFromChat()
        }
        .onAppear {
            model.setViewPresent(true)
            model.setHapticsActive(true)
            model.setChatForegrounded(true)
            model.setSceneActive(scenePhase == .active)
            if scenePhase == .background { _ = sceneRefreshGate.transition(to: .background) }
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
        .onDisappear {
            model.setViewPresent(false)
            model.readAloud.stop()
            model.setHapticsActive(false)
            model.setChatForegrounded(false)
            model.stopProgressObservation()
            attachmentPicker.reset()
            composerSession.stopVoice()
            composerSession.discardAttachments()
        }
    }

    private var chatStack: some View {
        ZStack(alignment: .bottom) {
            AidenTranscriptScaffold(dock: dock) { transcript }
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
            .aidenReportsTranscriptFit(to: follow)
            .aidenKeepsPlaceOnPrepend(anchorID: $keptPlaceID, proxy: proxy)
            .aidenOnComposerInsetChange { followLatest(proxy, animated: false) }
            .simultaneousGesture(
                TapGesture().onEnded { composerIsFocused = false }
            )
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
                composerIsFocused = false
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
                renderIDs: model.messageRenderIDs,
                imageArrivalRevealIDs: model.imageArrivalRevealGenerationIDs,
                appControlsAvailable: model.canReadAppControls,
                onAskAbout: model.isReadOnlyPresentation ? nil : { selection in
                    if model.askAbout(selection) { composerIsFocused = true }
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
                browserRecordingsAvailable: model.supportsBrowserRecordings
            )
            .equatable()
            if model.showsLiveResponse {
                AidenLiveResponseView(model: model, presentationStyle: presentationStyle)
            }
        }
        .padding(.horizontal)
        .padding(.top, 20)
    }

    private func performFork(messageID: String, action: AidenChatForkMenuAction, focus: String = "") {
        guard let onOpenChat else { return }
        Task { @MainActor in
            guard let forked = await model.fork(
                messageId: messageID,
                action: action,
                summaryFocus: focus
            ) else { return }
            // The fork lives on this chat's machine. Opening it from another
            // machine's shell would file it under that machine.
            guard coordinator?.activeInstanceId == model.owner.instanceId else { return }
            onOpenChat(forked)
        }
    }

    private var simulatorRefreshKey: String {
        let available = coordinator.map(AidenChatSimulatorsModel.isAvailable(coordinator:)) ?? false
        return "\(model.chat.id)|\(chatLoadEpoch)|\(simulatorRefreshEpoch)|\(available)"
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
            coordinator?.activeInstanceId ?? "",
            String(coordinator?.server?.capabilities.contains(.chatNewWorktree) == true),
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
                        composerFocus: $composerIsFocused,
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
                        simulatorViewer = simulators.makeViewer(coordinator: coordinator)
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
        composerIsFocused = false
        if attachmentPicker.isPresented {
            attachmentPicker.dismiss()
        } else {
            attachmentPicker.openMenu()
        }
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

    @ToolbarContentBuilder
    private var chatToolbar: some ToolbarContent {
        if let coordinator, let botToolsModel {
            ToolbarItem(placement: .principal) {
                botHeaderPill(coordinator: coordinator, model: botToolsModel)
            }
            ToolbarItem(placement: .topBarTrailing) { sessionSheetButton }
        } else if model.chat.botId == nil, coordinator != nil {
            ToolbarItem(placement: .topBarTrailing) { sessionSheetButton }
        }
    }

    private var sessionSheetButton: some View {
        Button {
            showsSessionSheet = true
        } label: {
            Image(systemName: AidenChromeSymbols.overflowMenu)
                .font(.body.weight(.semibold))
                .contentShape(Circle())
        }
        .buttonBorderShape(.circle)
        .accessibilityLabel("More")
    }

    private var sessionSheetConfig: AidenSessionSheetConfig {
        let canReadAloud = model.readAloudCandidateID != nil
        let isReadingAloud = model.readAloud.activeMessageID != nil
        if let coordinator, let botToolsModel {
            return .botChat(
                title: botToolsModel.bot?.name ?? model.chat.title,
                hasFiles: botToolsModel.fileGrant(coordinator: coordinator, hostAllowsMutations: effectiveAllowsMutations) != nil,
                canDelete: AidenBotDeletion.isAvailable(coordinator: coordinator) && botToolsModel.bot != nil,
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

    /// A small avatar and the Bot's name. Tapping it opens the Profile.
    private func botHeaderPill(
        coordinator: AidenRemoteCoordinator,
        model botModel: AidenBotChatToolsModel
    ) -> some View {
        Button {
            openBotProfile(coordinator: coordinator, model: botModel)
        } label: {
            HStack(spacing: 8) {
                if let bot = botModel.bot {
                    AidenBotCanonicalAvatarView(
                        coordinator: coordinator,
                        botID: bot.id,
                        avatar: bot.avatar,
                        name: bot.name,
                        size: 26
                    )
                } else {
                    Circle()
                        .fill(palette.raised)
                        .frame(width: 26, height: 26)
                }
                Text(botModel.bot?.name ?? model.chat.title)
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
            }
            .padding(.leading, 4)
            .padding(.trailing, 12)
            .frame(minHeight: 34)
            .aidenBotHeaderNameGlass()
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(botModel.bot?.name ?? model.chat.title)
        .accessibilityHint("Opens the Bot’s profile")
    }

    @ViewBuilder
    private func botSheetContent(_ destination: AidenBotChatSheet) -> some View {
        if let coordinator, let botToolsModel {
            switch destination {
            case .profile(let bot):
                AidenBotProfileView(
                    coordinator: coordinator,
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
                try await AidenBotDeletion.delete(botID: bot.id, revision: bot.revision, coordinator: coordinator)
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
        Task {
            await model.loadEarlierMessages()
            guard let anchorID, model.chat.messages.first?.id != anchorID,
                  model.chat.messages.contains(where: { $0.id == anchorID }) else { return }
            keptPlaceID = model.renderID(forMessageID: anchorID)
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

    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
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

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(palette.raised, in: Circle())
        } else {
            content.glassEffect(.regular.interactive(), in: Circle())
        }
    }
}
