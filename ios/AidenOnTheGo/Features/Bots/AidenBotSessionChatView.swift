import Photos
import SwiftUI
import UniformTypeIdentifiers

/// What a durable Bot chat keeps across a rebuild of its views, as a
/// workspace chat's screen does (`AidenChatScreenParts`): the composer with
/// its draft, attachments and voice, the attachment picker, the reader's
/// place, and the conversation with its feed. The feed runs here rather than
/// in a view's task, so opening or closing an iPhone Duo, which builds the
/// views again, doesn't end it.
@MainActor
final class AidenBotSessionScreenParts: AidenTranscriptPlace {
    let composerSession: AidenComposerSession
    let follow = AidenTranscriptFollowController()
    let attachmentPicker = AidenAttachmentPickerState()
    /// The conversation whose feed is running, while one is.
    private(set) var model: AidenBotSessionModel?
    /// The grants its feed opened with (`aidenBotSessionFeedGrants`).
    var feedOpenedWith: Set<AidenRemoteCapability> = []
    private var feed: Task<Void, Never>?
    /// Which start the feed is for: the machine and the Try again count.
    private var startKey: String?
    /// Counts feeds opened, so a feed that ends clears only its own state,
    /// never a newer feed's.
    private var feedsOpened = 0

    init(composerSession: AidenComposerSession? = nil) {
        self.composerSession = composerSession ?? AidenComposerSession()
        super.init()
    }

    /// The conversation a feed is still running for `key`, which a rebuilt
    /// view takes over instead of starting another. Once the feed has ended
    /// (its machine was forgotten, or it was stopped) there is none, and the
    /// next start opens a new conversation.
    func runningModel(for key: String) -> AidenBotSessionModel? {
        guard key == startKey, feed != nil else { return nil }
        return model
    }

    /// Opens `model`'s feed, in place of any feed running: its first
    /// snapshot and its stream, with the outbox it sends. Returns the feed,
    /// for tests.
    @discardableResult
    func run(_ model: AidenBotSessionModel, for key: String) -> Task<Void, Never> {
        stop()
        self.model = model
        startKey = key
        feedsOpened += 1
        let opened = feedsOpened
        let feed = Task { @MainActor [weak self] in
            async let firstLoad: Void = model.load()
            await model.listen()
            // Leaving stops the sending at once; the read still finishing doesn't hold it up.
            model.release()
            // The listener also returns by itself once its machine's pairing
            // is gone: a released model is no longer a running conversation.
            self?.ended(opened)
            _ = await firstLoad
        }
        self.feed = feed
        return feed
    }

    private func ended(_ opened: Int) {
        guard opened == feedsOpened else { return }
        feed = nil
        model = nil
        startKey = nil
    }

    /// Ends the feed: the screen is hidden, or another start replaces it.
    func stop() {
        feed?.cancel()
        feed = nil
        model = nil
        startKey = nil
    }
}

/// The Bot chat on a host that advertises `bot-durable-session-v1`: one
/// durable conversation per Bot, loaded from `GET /bots/{id}/session` and kept
/// live by its event stream.
struct AidenBotSessionChatView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let botID: String
    var initialSummary: AidenBotSummary?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenConversationMachine) private var conversationMachine
    @State private var isChatVisible = false
    @Environment(\.aidenPalette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AidenBotSessionModel?
    @State private var summary: AidenBotSummary?
    /// The Bot's own stored wording; revision 61 phones read Show tool activity instead.
    @State private var storedWording: AidenBotChatActivityWording?
    @AppStorage(AidenToolActivityPreference.defaultsKey) private var showToolActivity = false
    /// Lives here, not in the composer: the composer leaves while the Bot needs a model.
    @State private var composerSession: AidenComposerSession
    @State private var peerExchangeID: String?
    @State private var isShowingProfile = false
    /// What the header avatar shows, spoken by the title capsule.
    @State private var settledAvatar: AidenBotAvatarState = .idle
    /// The profile sheet opens straight to Memory (from "Memory updated").
    @State private var profileOpensMemory = false
    @State private var isShowingAdvanced = false
    @State private var isConfirmingDelete = false
    @State private var isDeleting = false
    @State private var deleteErrorMessage: String?
    /// An Advanced Save that didn't reach the Mac after Advanced closed (R15).
    @State private var advancedSaveError: String?
    /// The Bot's conversation tools, loaded once it has a conversation; Files
    /// is offered only when they grant file access.
    @State private var filesTools: AidenBotChatToolsModel?
    @State private var presentedFilesGrant: AidenBotConversationFileGrant?
    /// Steer or Queue while the Bot works; back to Queue when the turn ends.
    @State private var busyMode = aidenBotBusyMode(nil, isRunning: false)
    /// Bumped by Try again after the chat couldn't start, to start it again.
    @State private var startAttempt = 0
    /// The chat couldn't start (no pairing or credential to reach the Mac with).
    @State private var startFailed = false
    /// The grants this chat's feed opened with (`aidenBotSessionFeedGrants`).
    @State private var feedOpenedWith: Set<AidenRemoteCapability> = []
    /// Content growth must not be mistaken for the reader scrolling away.
    @State private var follow: AidenTranscriptFollowController
    /// Bumped by the person's own send: the transcript scrolls to it wherever it was.
    @State private var ownSendScroll = 0
    @State private var spending = AidenSpendingNoticeModel()
    @Environment(\.aidenReduceMotion) private var reduceMotion
    /// The workspace chat's + picker (Files, Camera, Photos), reused as is (revision 33).
    @State private var attachmentPicker: AidenAttachmentPickerState
    @State private var isFileImporterPresented = false
    @State private var attachButtonCenter: CGPoint?
    @State private var composerTopY: CGFloat?
    @State private var showsSessionSheet = false
    /// Runs once the sheet has closed, so what it opens has the screen to itself.
    @State private var pendingSessionAction: AidenSessionAction?

    /// The shell's hold on this chat's screen, when it keeps one.
    private let screen: AidenChatScreen?
    /// Everything that outlives these views, and the reader's place.
    @State private var parts: AidenBotSessionScreenParts
    /// This screen's rows, as against those of the screen a fold replaces.
    @State private var rowFrameScreen = UUID()

    /// `screen` and `parts` are the shell's, when it keeps this chat's
    /// screen across a rebuild of its views.
    init(
        coordinator: AidenRemoteCoordinator,
        botID: String,
        initialSummary: AidenBotSummary? = nil,
        composerSession: AidenComposerSession? = nil,
        machine: String,
        screen: AidenChatScreen? = nil,
        parts: AidenBotSessionScreenParts? = nil
    ) {
        self.coordinator = coordinator
        self.botID = botID
        self.initialSummary = initialSummary
        self.screen = screen
        let parts = parts ?? AidenBotSessionScreenParts(composerSession: composerSession)
        _parts = State(initialValue: parts)
        _composerSession = State(initialValue: parts.composerSession)
        _follow = State(initialValue: parts.follow)
        _attachmentPicker = State(initialValue: parts.attachmentPicker)
        // A Bot chat stays on the machine it opened on, whatever the default does.
        _openedOn = State(initialValue: machine)
    }

    /// Only while the chat itself is in front: any sheet over it, the session
    /// sheet included, ends the foreground visit.
    private var resumeVisitIsActive: Bool {
        isChatVisible && scenePhase == .active && !isShowingProfile && !isShowingAdvanced && !showsSessionSheet
            && peerExchangeID == nil && presentedFilesGrant == nil && !isFileImporterPresented && !attachmentPicker.isPresented
    }

    private var bot: AidenBotSummary? { summary ?? initialSummary }

    /// The machine the chat opened on, so moving the default leaves it there.
    @State private var openedOn: String
    private var machineID: String { openedOn }
    /// This screen while it shows `openedOn`'s chat. A machine that revokes this
    /// phone keeps its data until the screen goes, as a chat's does, so the
    /// draft isn't purged from under the person.
    @State private var onScreen = AidenBotChatOnScreen()

    /// The machine this chat belongs to.
    /// The status line's wording: the Bot's own, or this phone's Show tool
    /// activity switch on a Mac with the revision 61 cards.
    private func applyWording() {
        model?.wording = AidenToolActivityPreference.wording(
            botWording: storedWording,
            hostOffersBotUX: ownerConnection?.installation.offersBotUX == true,
            showToolActivity: showToolActivity
        )
    }

    private var ownerConnection: AidenHostConnection? {
        coordinator.hosts.connection(for: model?.owner.instanceId ?? machineID)
    }

    private func isAdvertised(_ feature: String) -> Bool {
        AidenBotHostFeature.isAdvertised(feature, by: coordinator.knownServerFeatures(of: machineID))
    }

    private var activitySupported: Bool {
        aidenBotActivitySupported(server: ownerConnection?.server, installation: ownerConnection?.installation)
    }

    /// Profile, Advanced, Files and Delete, all on the chat's own machine.
    var tools: AidenBotSessionTools {
        AidenBotSessionTools(coordinator: coordinator, machine: openedOn, botID: botID)
    }

    private func machineContext() throws -> AidenRemoteRequestContext {
        try coordinator.ownerContext(for: openedOn)
    }

    private var canWrite: Bool {
        ownerConnection?.connectionState == .connected && canCompose
    }

    /// Whether the chat's own machine keeps spending limits.
    private var supportsSpending: Bool {
        ownerConnection?.server?.supportsSpendingLimits == true
    }

    private var spendingTransport: AidenSpendingTransport? {
        guard supportsSpending else { return nil }
        guard let context = try? coordinator.ownerContext(for: model?.owner.instanceId ?? machineID) else { return nil }
        return try? coordinator.remoteClient(for: context)
    }

    private var spendingRefreshKey: String {
        [
            machineID,
            String(supportsSpending),
            String(model?.isRunning == true),
            String(model?.entries.count ?? 0),
            model?.errorMessage ?? "",
        ].joined(separator: "|")
    }

    private var canCompose: Bool { AidenBotSessionModel.canCompose(on: ownerConnection) }

    /// Answering a Bot's tool approval needs `approval:respond` beside Bot write.
    private var canRespondToApprovals: Bool {
        canWrite && ownerConnection?.installation.hasNegotiatedAccess(to: .approvalRespond) == true
    }

    /// Answering a routine proposal needs Bot write and `bot-proactive-v1`.
    private var canRespondToProposals: Bool {
        canWrite && isAdvertised(AidenBotHostFeature.proactive)
    }

    private var canRequestConnections: Bool {
        canWrite && isAdvertised(AidenBotHostFeature.connectionRequests)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            // The title capsule names the machine on its status line.
            AidenTranscriptScaffold(dock: dock, showsMachineSubtitle: false) { transcript }
                // The name capsule hangs just under the avatar in the bar.
                .safeAreaBar(edge: .top, spacing: 0) { AidenChatStackedTitle(capsule: header) }
            if let model, model.attachmentsSupported {
                attachmentPickerOverlay(model)
            }
        }
        .coordinateSpace(name: AidenBotComposerCoordinateSpace.name)
        .onPreferenceChange(AidenAttachmentButtonCenterPreferenceKey.self) { center in
            guard attachButtonCenter != center else { return }
            attachButtonCenter = center
        }
        .onPreferenceChange(AidenComposerTopYPreferenceKey.self) { topY in
            guard composerTopY != topY else { return }
            composerTopY = topY
        }
        .preference(key: AidenChatHoldsAttachmentsKey.self, value: composerSession.holdsAttachments)
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.image, .plainText, .sourceCode, .json, .xml, .commaSeparatedText],
            allowsMultipleSelection: true
        ) { result in
            attachFiles(result)
        }
        .onChange(of: scenePhase) { _, phase in
            if AidenVoiceCaptureLifecyclePolicy.shouldDiscardRecording(for: phase) {
                composerSession.stopVoice()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .aidenStopDictationForReadAloud)) { _ in
            composerSession.stopVoice()
        }
        .onAppear {
            screen?.appeared()
            parts.screenAppeared(rowFrameScreen)
            coordinator.setOnScreen(true, view: onScreen, instanceId: openedOn)
            isChatVisible = true
            model?.setResumeForegroundVisit(active: resumeVisitIsActive)
        }
        .onDisappear {
            isChatVisible = false
            coordinator.setOnScreen(false, view: onScreen, instanceId: openedOn)
            let hidden = { [parts, attachmentPicker, composerSession] in
                parts.model?.setResumeForegroundVisit(active: false)
                parts.stop()
                attachmentPicker.reset()
                composerSession.stopVoice()
                composerSession.discardAttachments()
            }
            // A screen the shell keeps knows whether this is its containers
            // being swapped or the reader leaving (`AidenChatScreen`). A swap
            // keeps the feed, the draft, the attachments and a recording.
            if let screen {
                screen.disappeared(hidden: hidden, left: {})
            } else {
                hidden()
            }
        }
        .onChange(of: resumeVisitIsActive) { _, active in
            // The feed remains alive for background hand-offs (G24).
            model?.setResumeForegroundVisit(active: active)
        }
        .background(palette.canvas.ignoresSafeArea())
        // The header takes the title's place in a bar along the top. A side
        // rail can't hold it, so the title says whose chat this is there.
        .navigationTitle(bot?.name ?? String(localized: "Bot"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { avatarHeader }
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
        }
        .aidenPrefersToolbarItems()
        .aidenBotDeleteConfirmation(
            isPresented: $isConfirmingDelete,
            botName: bot?.name ?? "this Bot",
            onConfirm: deleteBot
        )
        .sheet(isPresented: Binding(
            get: { presentedFilesGrant != nil },
            set: { if !$0 { presentedFilesGrant = nil } }
        )) {
            if let grant = presentedFilesGrant {
                NavigationStack {
                    AidenBotConversationFilesView(coordinator: coordinator, grant: grant)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { presentedFilesGrant = nil }
                            }
                        }
                }
            }
        }
        .sheet(isPresented: $showsSessionSheet, onDismiss: runPendingSessionAction) {
            AidenSessionSheet(
                config: sessionSheetConfig,
                actions: AidenSessionActions { pendingSessionAction = $0 }
            )
        }
        .sheet(isPresented: Binding(get: { peerExchangeID != nil }, set: { if !$0 { peerExchangeID = nil } })) {
            if let peerExchangeID {
                NavigationStack {
                    AidenBotPeerExchangeView(coordinator: coordinator, machine: openedOn, botID: botID, exchangeID: peerExchangeID)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { self.peerExchangeID = nil } } }
                }
            }
        }
        .sheet(isPresented: $isShowingProfile, onDismiss: { profileOpensMemory = false }) {
            if let bot {
                tools.profile(
                    bot,
                    opensMemory: profileOpensMemory,
                    onChanged: { Task { await loadSummary() } },
                    onDeleted: {
                        isShowingProfile = false
                        dismiss()
                    }
                )
            }
        }
        .navigationDestination(isPresented: $isShowingAdvanced) {
            // "Set up" and "Advanced" land here; a saved model or access
            // change refreshes the session state.
            tools.advanced(
                onSaved: { updated in
                    summary = AidenBotSummary(detail: updated)
                    storedWording = updated.chatActivity?.wording
                    applyWording()
                    Task { await model?.load() }
                },
                onSaveFailed: { advancedSaveError = $0 }
            )
        }
        .alert("Resume with an unconfirmed cost?", isPresented: Binding(
            get: { model?.resumeModel?.needsConsent == true },
            set: { _ in }
        )) {
            Button("Resume and acknowledge possible charge") { Task { await model?.confirmUnknownCostResume() } }
            Button("Cancel", role: .cancel) { model?.resumeModel?.cancelConsent() }
        } message: { Text(AidenBotResumeModel.confirmation) }
        .alert(
            "Something Went Wrong",
            isPresented: Binding(
                get: { alertMessage != nil },
                set: { if !$0 { clearErrors() } }
            )
        ) {
            Button("OK", role: .cancel) { clearErrors() }
        } message: {
            Text(alertMessage ?? "Please try again.")
        }
        .task(id: "\(machineID)|\(startAttempt)") {
            await start()
        }
        .task(id: filesLookupKey) {
            await loadFilesTools()
        }
        // Revision 47: re-read the Bot's month after each reply, send and refusal.
        .task(id: spendingRefreshKey) {
            await spending.refresh(owner: .bot(botID), transport: spendingTransport)
        }
        // Chat activity is changed in Advanced; reread the Bot when it closes.
        .onChange(of: isShowingAdvanced) { _, showing in
            if !showing { Task { await loadSummary() } }
        }
        .onChange(of: model?.isRunning == true) { _, running in
            busyMode = aidenBotBusyMode(busyMode, isRunning: running)
        }
        .onChange(of: dockContent.keepsComposer) { _, keepsComposer in
            guard !keepsComposer else { return }
            composerSession.putAwayKeyboard()
            attachmentPicker.dismiss()
        }
        // The last-known capabilities stand in until the Mac answers (R21).
        .onChange(of: activitySupported) { _, supported in
            model?.activitySupported = supported
        }
        .onChange(of: isAdvertised(AidenBotHostFeature.attachments)) { _, supported in
            model?.attachmentsSupported = supported
            if !supported { attachmentPicker.dismiss() }
        }
        // The Mac shapes the feed by the grants this phone holds when it opens
        // (cards, Chat activity, hand-offs and the paused state). The chat can
        // open from the saved features while the phone connects, before this
        // connection negotiated a grant (`bot:handoffs` after the Mac updates);
        // once it is negotiated, a feed that opened without it opens again.
        .onChange(of: showToolActivity) { _, _ in applyWording() }
        .onChange(of: aidenBotSessionFeedGrants(ownerConnection?.installation)) { _, grants in
            guard let model, grants != feedOpenedWith else { return }
            feedOpenedWith = grants
            parts.feedOpenedWith = grants
            model.allowedSupported = grants.contains(.botAllowed)
            model.plansSupported = grants.contains(.botPlans)
            model.reopenFeed()
        }
        // A first load that failed is a quiet hint while the chat keeps
        // reconnecting; once a snapshot arrives it is no longer news.
        .onChange(of: model?.hasLoaded == true) { _, loaded in
            if loaded { model?.errorMessage = nil }
        }
    }

    /// A failed delete, then unsent messages that couldn't be restored (shown
    /// even before the first snapshot), then the chat's own error once loaded.
    private var alertMessage: String? {
        deleteErrorMessage ?? advancedSaveError ?? model?.restoreNotice ?? (model?.hasLoaded == true ? model?.errorMessage : nil)
    }

    private func clearErrors() {
        deleteErrorMessage = nil
        advancedSaveError = nil
        model?.restoreNotice = nil
        // Before the first snapshot the chat's error is the connection hint, not this alert.
        if model?.hasLoaded == true { model?.errorMessage = nil }
    }

    private var filesGrant: AidenBotConversationFileGrant? {
        filesTools?.reachableFileGrant(coordinator: coordinator, hostAllowsMutations: canWrite)
    }

    /// Looked up again once the chat has entries, since a brand-new Bot has
    /// no conversation until its first message.
    private var filesLookupKey: String {
        "\(machineID)|\(model?.entries.isEmpty == false)"
    }

    /// Profile, Files, Memory, Advanced and Delete for this Bot.
    private var moreMenu: some View {
        Button {
            showsSessionSheet = true
        } label: {
            // A title as well as the symbol, for the side rail's overflow.
            Label("More", systemImage: AidenChromeSymbols.overflowMenu)
        }
        .disabled(bot == nil)
        .accessibilityLabel("More for \(bot?.name ?? "this Bot")")
    }

    private var sessionSheetConfig: AidenSessionSheetConfig {
        .bot(
            title: bot?.name ?? "Bot",
            hasFiles: filesGrant != nil,
            hasMemory: isAdvertised(AidenBotHostFeature.memory),
            hasAdvanced: true,
            canDelete: tools.canDelete,
            isDeleting: isDeleting
        )
    }

    private func runPendingSessionAction() {
        guard let action = pendingSessionAction else { return }
        pendingSessionAction = nil
        switch action {
        case .profile:
            isShowingProfile = true
        case .files:
            presentedFilesGrant = filesGrant
        case .memory:
            profileOpensMemory = true
            isShowingProfile = true
        case .advanced:
            isShowingAdvanced = true
        case .delete:
            isConfirmingDelete = true
        case .rename, .fork, .readAloud:
            // A durable Bot's chat has no rename, forks or read aloud today.
            break
        }
    }

    private func deleteBot() {
        let name = bot?.name ?? "This Bot"
        isDeleting = true
        Task {
            defer { isDeleting = false }
            do {
                try await tools.delete()
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                deleteErrorMessage = "\(name) wasn’t deleted. Please try again."
            }
        }
    }

    @MainActor
    private func loadFilesTools() async {
        // These tools read and write the chat's own machine.
        guard let context = try? machineContext(),
              let client = try? coordinator.remoteClient(for: context),
              let query = try? AidenBotConversationQuery(botId: botID),
              let page = try? await client.botConversations(query: query),
              coordinator.holds(context),
              let chatID = aidenBotSessionConversationChatID(botID: botID, conversations: page.conversations),
              filesTools?.chatID != chatID || filesGrant == nil else {
            return
        }
        let files = tools.filesTools(chatID: chatID)
        await files.load(coordinator: coordinator)
        guard coordinator.holds(context) else { return }
        filesTools = files
    }

    /// Telegram's chat header: the Bot's name over what it is doing on a glass
    /// capsule. Tapping it opens the Bot's profile.
    private var header: AidenChatTitleCapsule {
        AidenChatTitleCapsule(
            title: bot?.name ?? String(localized: "Bot"),
            status: bot == nil ? nil : titleStatus,
            accessibilityHint: "Opens the Bot’s profile",
            settledAvatar: bot == nil ? nil : settledAvatar
        ) {
            // Nothing to open until the Bot has loaded.
            if bot != nil { isShowingProfile = true }
        }
    }

    /// The status line's word while the Bot works, why it can't answer when it
    /// can't, and otherwise what it is for.
    private var titleStatus: AidenChatTitleStatus {
        if let model {
            return model.titleStatus(
                nowMs: Int(Date().timeIntervalSince1970 * 1_000), purpose: bot?.purpose, machine: conversationMachine
            )
        }
        // Before the session loads, the summary's state stands in.
        return .bot(
            state: bot?.paused == true ? .paused : bot?.sessionState,
            statusWord: nil,
            waitsForYou: false,
            purpose: bot?.purpose,
            machine: conversationMachine
        )
    }

    /// The header avatar's signal. Before the model loads, nothing has run, so
    /// a missing model reads as a quiet stop rather than a turn that finished.
    private var avatarSignal: AidenBotAvatarSignal {
        model.map { AidenBotAvatarSignal(model: $0) } ?? AidenBotAvatarSignal(stopped: true)
    }

    /// The Bot's face in the middle of the bar, over its name; like the name,
    /// it opens the profile. It plays what the turn is doing, while the
    /// capsule's status line says the same in words for VoiceOver.
    private var avatarHeader: some View {
        AidenChatHeaderAvatar {
            isShowingProfile = true
        } avatar: {
            if let bot {
                AidenBotSettledAvatarState(signal: avatarSignal, onShownChange: { settledAvatar = $0 }) { state in
                    AidenBotCanonicalAvatarView(
                        coordinator: coordinator,
                        machine: openedOn,
                        botID: bot.id,
                        avatar: bot.avatar,
                        name: bot.name,
                        size: AidenChatHeaderAvatar<EmptyView>.size,
                        // A resting header draws the still sprite, with no animation clock.
                        state: state == .idle ? nil : state
                    )
                }
            } else {
                Circle().fill(palette.raised)
            }
        }
        .disabled(bot == nil)
        .accessibilityIdentifier("chat-avatar")
    }

    /// Never a spinner or a blocking error (R14): the last transcript, or
    /// skeleton bubbles, with the person's own messages drawn at once.
    @ViewBuilder
    private var transcript: some View {
        if let model {
            ScrollViewReader { proxy in
                ScrollView {
                    AidenTranscriptRowStack(spacing: 12, bottomAnchorID: "bottom") {
                        if model.showsSkeleton {
                            AidenBotSessionSkeletonBubbles(still: isUnreachable)
                        }
                        ForEach(AidenBotTranscriptRow.rows(for: model.entries)) { row in
                            rowView(row, model: model)
                                .id(row.id)
                                .onGeometryChange(for: CGRect.self) {
                                    $0.frame(in: .named(AidenTranscriptRowSpace.name))
                                } action: { frame in
                                    rowFrameChanged(frame, for: row.id, proxy: proxy)
                                }
                                .onDisappear { rowFrameChanged(nil, for: row.id, proxy: proxy) }
                        }
                        AidenBotSessionPartialRow(model: model) { partial in
                            assistantBubble(partial, interrupted: false, isStreaming: true)
                        }
                        ForEach(model.queued, id: \.submissionId) { message in
                            queuedBubble(message)
                        }
                        ForEach(model.outgoing) { message in
                            outgoingBubble(message, model: model)
                        }
                        ForEach(model.openIssues.filter { issue in
                            issue.isAvailable(accessRequests: ownerConnection?.installation.hasNegotiatedAccess(to: .botAccessRequests) == true)
                        }) { issue in
                            // Revision 42: a "Needs you" card from the host.
                            AidenBotIssueCardView(
                                issue: issue,
                                canAct: canWrite && model.canActOnIssue,
                                isBusy: model.actingIssue?.id == issue.id,
                                onAct: { action in Task { await model.actOnIssue(issue, action: action) } }
                            )
                            .id("issue:\(issue.id)")
                        }
                        if let approval = model.approval {
                            approvalCard(approval, model: model)
                        } else if let answered = model.approvalAnsweredButton {
                            AidenApprovalAnsweredLine(button: answered)
                        }
                        AidenBotStatusLineView(model: model)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .coordinateSpace(.named(AidenTranscriptRowSpace.name))
                    .background {
                        AidenChatScrollObserver(
                            onFollowEvent: { follow.handle($0) },
                            onMetrics: { follow.updateMetrics($0) }
                        )
                    }
                }
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .onScrollPhaseChange { _, phase, context in
                    // Only the reader moves the reading place, not a layout pass
                    // on the way back to it.
                    guard phase == .idle, !follow.holdsPlace else { return }
                    parts.readingPlace = follow.isFollowing
                        ? nil
                        : place(in: context.geometry, model: model) ?? parts.readingPlace
                }
                .onChange(of: follow.isFollowing) { _, following in
                    if following { parts.readingPlace = nil }
                }
                // A rebuilt screen (an iPhone Duo opening or closing) starts at
                // the latest; the reader goes back to their place, and again as
                // the rows measure, until they scroll or ask for the latest.
                .onAppear { startReturningToReadingPlace(proxy, model: model) }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { _ in
                    startReturningToReadingPlace(proxy, model: model)
                }
                .onScrollGeometryChange(for: CGSize.self) { $0.contentSize } action: { _, _ in
                    guard follow.holdsPlace else { return }
                    returnToReadingPlace(proxy, model: model)
                }
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    geometry.containerSize.height
                } action: { _, height in
                    parts.visibleHeight = height
                    if follow.holdsPlace { returnToReadingPlace(proxy, model: model) }
                }
                .defaultScrollAnchor(
                    AidenChatScrollPolicy.sizeChangeAnchor(shouldFollowLatest: follow.isFollowing),
                    for: .sizeChanges
                )
                .scrollDismissesKeyboard(.interactively)
                .gesture(AidenTranscriptTap { composerSession.putAwayKeyboard() })
                .aidenReportsTranscriptFit(to: follow)
                .aidenOnComposerInsetChange { followIfAtEnd(proxy) }
                .onChange(of: model.approval?.waitId) { _, waitId in
                    guard waitId != nil else { return }
                    composerSession.putAwayKeyboard()
                    followIfAtEnd(proxy)
                }
                .onChange(of: model.entries.count) { _, _ in followIfAtEnd(proxy) }
                .background {
                    AidenBotSessionPartialFollow(model: model) { followIfAtEnd(proxy) }
                }
                .onChange(of: model.queued.count) { _, _ in followIfAtEnd(proxy) }
                .onChange(of: model.outgoing.count) { _, _ in followIfAtEnd(proxy) }
                .onChange(of: ownSendScroll) { _, _ in followIfAtEnd(proxy, userInitiated: true) }
                .onAppear { follow.setStreaming(model.isRunning) }
                .onChange(of: reduceMotion, initial: true) { _, reduce in
                    model.pacesPartialReveal = !reduce
                }
                .onChange(of: model.isRunning) { _, running in follow.setStreaming(running) }
                .overlay(alignment: .bottom) {
                    if follow.showsJumpButton {
                        AidenChatJumpToLatestButton {
                            followIfAtEnd(proxy, userInitiated: true)
                        }
                        .padding(.bottom, 10)
                    }
                }
            }
        } else {
            ScrollView {
                AidenBotSessionSkeletonBubbles(still: isUnreachable)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            }
            .scrollDisabled(true)
        }
    }

    private func rowFrameChanged(_ frame: CGRect?, for id: String, proxy: ScrollViewProxy) {
        // The place's row measured at a new height after the reader was
        // brought back: bring them back again.
        guard parts.setRowFrame(frame, for: id, from: rowFrameScreen), follow.holdsPlace, let model else { return }
        returnToReadingPlace(proxy, model: model)
    }

    /// Where the reader is now: the first row across the visible top.
    private func place(in geometry: ScrollGeometry, model: AidenBotSessionModel) -> AidenReadingPlace? {
        let rows = AidenBotTranscriptRow.rows(for: model.entries)
            .compactMap { row in parts.rowFrames[row.id].map { (id: row.id, frame: $0) } }
        return AidenReadingPlace.at(top: geometry.contentOffset.y + geometry.contentInsets.top, rows: rows)
    }

    private func startReturningToReadingPlace(_ proxy: ScrollViewProxy, model: AidenBotSessionModel) {
        guard parts.readingPlace != nil else { return }
        follow.handle(.holdPlace)
        returnToReadingPlace(proxy, model: model)
    }

    private func returnToReadingPlace(_ proxy: ScrollViewProxy, model: AidenBotSessionModel) {
        guard let place = parts.readingPlace, !follow.isFollowing else { return }
        Task { @MainActor in
            await Task.yield()
            guard parts.readingPlace == place, !follow.isFollowing else { return }
            // The place's row is gone: nothing to go back to.
            guard AidenBotTranscriptRow.rows(for: model.entries).contains(where: { $0.id == place.rowID }) else {
                parts.readingPlace = nil
                follow.handle(.releasePlace)
                return
            }
            let anchor = place.anchor(rowHeight: parts.rowFrames[place.rowID]?.height, viewHeight: parts.visibleHeight)
            proxy.scrollTo(place.rowID, anchor: anchor)
        }
    }

    private func followIfAtEnd(_ proxy: ScrollViewProxy, userInitiated: Bool = false) {
        follow.scheduleFollowScroll(isUserInitiated: userInitiated, animated: false) { _ in
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }

    /// The Mac can't be reached right now: skeletons hold still instead of shimmering.
    private var isUnreachable: Bool {
        if startFailed { return true }
        if case .offline = ownerConnection?.connectionState { return true }
        guard let model else { return false }
        if case .unreachable = aidenBotConnectionHint(for: model, nowMs: Int(Date().timeIntervalSince1970 * 1_000)) {
            return true
        }
        return false
    }

    /// The chat couldn't start: a quiet hint with Try again, never an endless skeleton.
    private var startFailureHint: some View {
        HStack(spacing: 6) {
            Text(AidenBotSessionCopy.unreachable)
                .lineLimit(2)
            Button(AidenBotSessionCopy.tryAgain) {
                startFailed = false
                startAttempt += 1
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(palette.accent)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .buttonStyle(.plain)
        }
        .font(.footnote)
        // Full strength: the glass under it takes on whatever scrolls behind,
        // and a secondary tint fell under 3:1 on it.
        .foregroundStyle(palette.foreground)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func rowView(_ row: AidenBotTranscriptRow, model: AidenBotSessionModel) -> some View {
        switch row {
        case let .entry(entry):
            entryView(entry, model: model)
        case .memoryUpdated:
            AidenBotMemoryUpdatedCaption {
                profileOpensMemory = true
                isShowingProfile = true
            }
            .disabled(bot == nil)
        }
    }

    @ViewBuilder
    private func entryView(_ entry: AidenBotSessionEntry, model: AidenBotSessionModel) -> some View {
        switch entry {
        case let .message(message):
            if message.role == .user {
                VStack(alignment: .trailing, spacing: 4) {
                    if let label = message.label {
                        Label(label, systemImage: "clock")
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                    }
                    Text(message.text)
                        .foregroundStyle(palette.foreground)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 48)
            } else {
                assistantBubble(message.text, interrupted: message.interrupted)
            }
        case let .connectCard(card):
            if card.status != .dismissed {
                AidenBotConnectCardView(
                    card: card,
                    canRequest: canRequestConnections,
                    requestSent: model.sentConnectionRequests.contains(card.pluginId)
                ) {
                    Task { await model.requestConnection(pluginId: card.pluginId) }
                }
            }
        case .notice:
            Text(AidenBotSessionCopy.sessionReset)
                .font(.footnote)
                .foregroundStyle(palette.secondary)
                .frame(maxWidth: .infinity)
        case let .failedTurn(turn):
            AidenBotFailedTurnCard(
                canRetry: model.retryableFailedTurn?.id == turn.id && canWrite && model.canSend && model.hasLoaded,
                isBusy: model.inFlight.contains(.retry),
                onRetry: { Task { await model.retry() } }
            )
        case .memoryUpdate:
            // Rendered by `rowView` as one caption per run of updates.
            EmptyView()
        case let .routineProposal(card):
            AidenBotRoutineProposalCardView(
                card: card,
                canRespond: canRespondToProposals,
                isBusy: model.respondingProposals.contains(card.proposalId),
                onRespond: { decision in
                    Task { await model.respondToProposal(card.proposalId, decision: decision) }
                }
            )
        case let .settingsChange(change):
            AidenBotSettingsChangeCardView(
                change: change,
                botName: bot?.name ?? "This Bot",
                canRespond: canWrite,
                isBusy: model.respondingBotUX.contains(change.id),
                onRespond: { decision in Task { await model.respondToSettingsChange(change, decision: decision) } }
            )
        case let .skillProposal(proposal):
            AidenBotSkillProposalCardView(
                proposal: proposal,
                canRespond: canWrite,
                isBusy: model.respondingBotUX.contains(proposal.id),
                onRespond: { decision in Task { await model.respondToSkillProposal(proposal, decision: decision) } }
            )
        case let .lesson(lesson):
            AidenBotLessonCardView(
                lesson: lesson,
                canRespond: canWrite,
                isBusy: model.respondingBotUX.contains(lesson.id),
                onRespond: { decision in Task { await model.respondToLesson(lesson, decision: decision) } },
                onUndo: { Task { await model.removeLesson(lesson) } }
            )
        case let .memoryTidy(tidy):
            AidenBotMemoryTidyLine(
                tidy: tidy,
                canUndo: canWrite && !model.respondingBotUX.contains(tidy.id),
                onUndo: { Task { await model.undoMemoryTidy(tidy) } }
            )
        case let .peer(peer):
            if ownerConnection?.server?.supportsBotPeerExchanges == true {
                AidenBotPeerTranscriptRow(peer: peer) { peerExchangeID = peer.exchangeId }
            }
        case let .sharedImage(image):
            // Revision 45: the image the Bot shared, read from the Mac when it is drawn.
            AidenMessageImageAttachmentsView(
                attachments: [image.attachment],
                edge: .leading,
                loadData: { attachment in await model.sharedImageData(entryId: attachment.id) }
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, 48)
        }
    }

    /// A user bubble the Mac's transcript doesn't hold yet: a Queued message,
    /// or one of the person's own on its way.
    private func pendingBubble<Caption: View>(
        _ text: String,
        faded: Bool,
        attachments: [AidenAttachmentReference] = [],
        @ViewBuilder caption: () -> Caption
    ) -> some View {
        VStack(alignment: .trailing, spacing: 4) {
            if !attachments.isEmpty {
                AidenBotAttachmentChips(attachments: attachments)
            }
            // Waiting reads in the quieter text colour, which keeps 4.5:1 on the bubble.
            if !text.isEmpty {
                Text(text)
                    .foregroundStyle(faded ? Color(aidenHex: aidenBotPendingTextHex(palette)) : palette.foreground)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            caption()
                .font(.caption)
                .foregroundStyle(palette.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
    }

    /// A message the Mac holds until the reply finishes (Queue) or has already
    /// joined the reply (Steer).
    private func queuedBubble(_ message: AidenBotQueuedMessage) -> some View {
        queuedLook(message.text, mode: message.mode)
    }

    private func queuedLook(_ text: String, mode: AidenStreamInputMode, attachments: [AidenAttachmentReference] = []) -> some View {
        // A queued message waits for the reply; a steer has already joined it.
        pendingBubble(text, faded: mode == .queue, attachments: attachments) {
            if mode == .queue {
                Text(AidenBotSessionCopy.queued)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(mode == .queue ? "Sends when the current reply finishes" : "")
    }

    /// The person's own message before the Mac's transcript shows it (R14).
    @ViewBuilder
    private func outgoingBubble(_ message: AidenBotOutgoingMessage, model: AidenBotSessionModel) -> some View {
        switch model.look(of: message) {
        case .sending, .sent:
            // It looks sent at once and stays that way while the Mac takes it:
            // the status line carries the wait, and only a send that fails says so.
            pendingBubble(message.text, faded: false, attachments: message.attachments) { EmptyView() }
        case let .queued(mode):
            queuedLook(message.text, mode: mode, attachments: message.attachments)
        case .failed:
            let expired = model.attachmentsExpired(message)
            pendingBubble(message.text, faded: false, attachments: message.attachments) {
                HStack(spacing: 6) {
                    Label(
                        expired ? AidenBotSessionCopy.attachmentsExpired : AidenBotSessionCopy.couldNotSend,
                        systemImage: "exclamationmark.circle.fill"
                    )
                        .labelStyle(.titleAndIcon)
                        .foregroundStyle(palette.danger)
                    Text("·")
                        .accessibilityHidden(true)
                    Button {
                        if expired {
                            // The words go back in the composer; the files are picked again.
                            if let text = model.reattach(message.id, into: composerSession.text) {
                                composerSession.text = text
                                composerSession.raiseKeyboard()
                            }
                        } else {
                            Task { await model.retrySend(message.id) }
                        }
                    } label: {
                        Text(expired ? AidenBotSessionCopy.attachAgain : AidenBotSessionCopy.tryAgain)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.accent)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .disabled(!canCompose)
                    Button {
                        model.discardSend(message.id)
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption.weight(.semibold))
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(AidenBotSessionCopy.removeMessage)
                }
                .buttonStyle(.plain)
            }
            .accessibilityElement(children: .contain)
        }
    }

    private func assistantBubble(_ text: String, interrupted: Bool, isStreaming: Bool = false) -> some View {
        AidenMarkdownView(content: text, isStreaming: isStreaming)
            .foregroundStyle(palette.foreground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .opacity(interrupted ? 0.7 : 1)
            .accessibilityHint(interrupted ? "This answer was cut off" : "")
    }

    private var dockContent: AidenDockContent {
        guard let model else { return .composer(busy: false) }
        return .resolve(model.dockInput(
            connection: ownerConnection,
            hasSpendingNotice: spending.spending != nil && !model.needsModel && !model.isPaused
        ))
    }

    /// The composer is there at once; messages wait for the Mac (R14).
    private var dock: AidenChatDock {
        var config = AidenComposerConfig.bot()
        if let model {
            config.placeholder = composerPlaceholder(model)
            config.showsAttachments = model.attachmentsSupported
        }
        return AidenChatDock(
            content: dockContent,
            session: composerSession,
            config: config,
            actions: AidenDockActions(
                onSend: { if let model { submit(model, whenBusy: nil) } },
                stop: model.flatMap(dockStop)
            ),
            slots: AidenDockSlots(
                above: {
                    if let model {
                        dockNotices(model)
                    } else if startFailed {
                        startFailureHint
                    }
                },
                footer: {
                    if let model { footerCards(model) }
                },
                question: { stop in
                    if let model { questionCard(model, stop: stop) }
                },
                composer: { config in
                    if let model { composer(model, config: config) }
                }
            )
        )
    }

    private func dockStop(_ model: AidenBotSessionModel) -> AidenDockStop? {
        guard model.isRunning else { return nil }
        return AidenDockStop(
            label: String(localized: "Stop"),
            isEnabled: canWrite && !model.isStopping && !model.inFlight.contains(.stop),
            action: { Task { await model.stop() } }
        )
    }

    /// The Bot's A–E quick replies. A Bot question has no deadline.
    @ViewBuilder
    private func questionCard(_ model: AidenBotSessionModel, stop: AidenDockStop?) -> some View {
        if let question = model.question, !model.needsModel {
            AidenQuestionCard(
                prompt: AidenPendingQuestion(
                    id: question.waitId,
                    questions: question.questions,
                    expiresAt: .distantFuture,
                    canRespond: canWrite
                ),
                stop: stop,
                onSubmit: { request in Task { await model.answerQuestion(request) } }
            )
            .disabled(!canWrite || !model.canAnswerQuestion)
            .id(question.waitId)
        }
    }

    /// A tool approval sits in the transcript, as in a workspace chat, with the
    /// composer in view.
    @ViewBuilder
    private func approvalCard(_ approval: AidenRemoteBotApproval, model: AidenBotSessionModel) -> some View {
        if let card = approval.card {
            // Revision 61: the Mac's card, with Always among its own buttons.
            AidenTypedApprovalCard(
                card: card,
                canRespond: canRespondToApprovals,
                sendableScopes: model.sendableScopes(for: approval),
                answersEnabled: canRespondToApprovals && model.canAnswerApproval
            ) { button in
                Task { await model.answerApproval(button: button) }
            }
            .id(approval.waitId)
        } else {
            legacyApprovalCard(approval, model: model)
        }
    }

    private func legacyApprovalCard(_ approval: AidenRemoteBotApproval, model: AidenBotSessionModel) -> some View {
        VStack(spacing: 10) {
            if let count = approval.alwaysCount, model.allowedSupported {
                Text("You’ve allowed this \(count) times in the last 2 weeks.").font(.footnote).foregroundStyle(palette.secondary)
                Button("Always allow for \(bot?.name ?? "Bot")") { Task { await model.answerApproval(.allow, scope: .always) } }
                    .buttonStyle(.bordered).buttonBorderShape(.capsule)
                    .disabled(!canRespondToApprovals || !model.canAnswerApproval)
            }
            // The workspace chat's approval card. Allow is hidden when the
            // Mac says this tool can only be denied from a phone.
            AidenApprovalCard(
                summary: approval.summary,
                toolName: approval.toolName,
                kind: .action,
                canRespond: canRespondToApprovals,
                hasRequiredWriteCapability: canRespondToApprovals,
                canAllow: approval.canAllow,
                scopes: [.once],
                onDeny: { Task { await model.answerApproval(.deny) } },
                onAllow: { _ in Task { await model.answerApproval(.allow) } }
            )
            .disabled(!canRespondToApprovals || !model.canAnswerApproval)
        }
        .id(approval.waitId)
    }

    /// What the Bot keeps above its footer cards, whatever holds the composer's place.
    @ViewBuilder
    private func dockNotices(_ model: AidenBotSessionModel) -> some View {
        if let hint = aidenBotConnectionHint(for: model, nowMs: Int(Date().timeIntervalSince1970 * 1_000)) {
            // It floats over the transcript too, so it sits on glass to stay readable.
            connectionHint(hint, model: model)
                .padding(.horizontal, 14)
                .aidenChromeGlass(in: Capsule())
                .accessibilityIdentifier("aiden.connection-hint")
        }
        // An offline Bot keeps its composer for the outbox, so its question stays
        // in view above it until the machine can take an answer.
        if dockContent != .question {
            questionCard(model, stop: nil)
        }
        if let notice = model.approvalSuccessNotice { Text(notice).font(.footnote).foregroundStyle(palette.secondary) }
        if let notice = model.botUXNotice {
            // Revision 61: why an Undo didn't happen.
            Text(notice).font(.footnote).foregroundStyle(palette.secondary)
                .onTapGesture { model.clearBotUXNotice() }
        }
        if let plan = model.plan, model.plansSupported {
            AidenBotPlanCard(plan: plan, botName: bot?.name ?? "Bot",
                canAnswer: canWrite && model.canRespondToPlan(plan), error: model.planError,
                onRespond: { decision in Task { await model.respondToPlan(decision) } })
                .id(plan.planId)
        }
        if let request = model.accessRequest, ownerConnection?.installation.hasNegotiatedAccess(to: .botAccessRequests) == true {
            AidenBotAccessRequestCard(request: request, botName: bot?.name ?? "Bot",
                showsApprovalCount: ownerConnection?.installation.hasNegotiatedAccess(to: .botAllowed) == true,
                canAnswer: canWrite && model.canAnswerAccessRequest,
                onAnswer: { choice in Task { await model.answerAccessRequest(choice) } })
                .id(request.waitId)
        }
        if let notice = model.accessSuccessNotice {
            Text(notice)
                .font(.footnote)
                .foregroundStyle(palette.success)
                .accessibilityIdentifier("bot_access_success_notice")
        }
    }

    /// Hand-off, spending, needs a model, paused and interrupted. Each keeps its
    /// own actions, and several can show at once.
    @ViewBuilder
    private func footerCards(_ model: AidenBotSessionModel) -> some View {
        if let handoff = model.handoff {
            // Revision 37: the step the Bot handed back. A sign-in is
            // finished on the Mac; any other step is Done or Skip here.
            AidenBotHandoffCard(
                handoff: handoff,
                canAnswer: canWrite && model.canAnswerHandoff,
                isFinishing: model.inFlight.contains(.openHandoffOnMac),
                macPrompt: model.handoffMacPrompt.flatMap { $0.waitId == handoff.waitId ? $0.text : nil },
                onDone: { Task { await model.answerHandoff(.done) } },
                onSkip: { Task { await model.answerHandoff(.skipped) } },
                onFinishOnMac: { Task { await model.finishHandoffOnMac() } },
                twoStep: ownerConnection?.installation.offersBotUX == true
            )
            .id(handoff.waitId)
        }
        if let current = spending.spending, !model.needsModel, !model.isPaused {
            AidenSpendingNotice(
                spending: current,
                botName: bot?.name,
                isAllowing: spending.isAllowing,
                canAllow: canWrite,
                errorMessage: spending.errorMessage,
                onAllowMore: { Task { await spending.allowMore(transport: spendingTransport) } }
            )
        }
        if model.needsModel {
            AidenBotNeedsModelCard(
                botName: bot?.name ?? "this Bot",
                canSetUp: canWrite,
                onSetUp: { isShowingAdvanced = true }
            )
        } else if model.isPaused {
            AidenBotPausedCard(
                botName: bot?.name ?? "This Bot",
                isBusy: model.inFlight.contains(.unpause),
                canAct: canWrite,
                onResume: { Task { await model.unpause() } }
            )
        } else if model.isInterrupted {
            AidenBotInterruptedCard(
                isAccessBlocked: model.isAccessBlocked,
                isBusy: model.inFlight.contains(.resume) || model.inFlight.contains(.dismiss) || model.resumeModel?.busy == true,
                canAct: canWrite,
                onResume: { Task { await model.resume() } },
                onDismiss: { Task { await model.dismiss() } },
                canOpenAdvanced: true,
                onOpenAdvanced: { isShowingAdvanced = true }
            )
        }
    }

    /// A quiet line above the composer, never a blocking screen (R14).
    private func connectionHint(_ hint: AidenBotConnectionHint, model: AidenBotSessionModel) -> some View {
        HStack(spacing: 6) {
            switch hint {
            case .connecting:
                Text(AidenBotSessionCopy.connecting)
            case let .unreachable(message):
                Text(message)
                    .lineLimit(2)
                Button(AidenBotSessionCopy.tryAgain) { Task { await model.load() } }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.accent)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                    .buttonStyle(.plain)
            }
        }
        .font(.footnote)
        .foregroundStyle(palette.secondary)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }

    /// The draft clears at once and the bubble shows (R14); a refused message
    /// comes back to the composer. While a step waits (revision 37), the text
    /// is its note instead and Send marks the step done, when the card's own
    /// Done could (connected); staged photos or files say to wait.
    private func submit(_ model: AidenBotSessionModel, whenBusy mode: AidenStreamInputMode?) {
        guard !model.composerHeldForPlan else { return }
        // The busy pill and the held Send come here without the surface's own
        // Send, so dictation ends here too: nothing may land after the words go.
        composerSession.stopVoice()
        if model.composerAnswersHandoff {
            let note = composerSession.text
            let connected = canWrite
            composerSession.text = ""
            Task {
                guard !(await model.answerHandoffFromComposer(note, connected: connected)) else { return }
                // The answer can outlast this machine on the screen: `text` writes to
                // whichever model owns the draft now, and a note stays off another machine.
                let owner = composerSession.draftOwner as? AidenBotSessionModel
                if owner?.owner.instanceId == model.owner.instanceId {
                    if composerSession.text.isEmpty { composerSession.text = note }
                } else if model.draft.isEmpty {
                    // Saved under its own machine, if that machine is still paired.
                    model.draft = note
                }
            }
            return
        }
        guard composerSession.hasContent, !model.isPreparingAttachments else { return }
        let text = composerSession.text
        composerSession.text = ""
        // The person's own message scrolls into view wherever they were reading.
        ownSendScroll += 1
        Task {
            if !(await model.send(text, whenBusy: mode)), composerSession.text.isEmpty {
                composerSession.text = text
            }
        }
    }

    /// Steer or Queue while the Bot works (desktop and Android parity): the mode's
    /// name sends in that mode; touch and hold for the menu, which works with an
    /// empty draft too, so the mode can be picked before typing.
    private func busyPill(_ model: AidenBotSessionModel) -> some View {
        let available = canCompose && model.canSend && !model.composerHeldForPlan
        let enabled = available && composerSession.hasContent && !model.isPreparingAttachments
        return AidenBotBusyPill(
            title: busyMode.busyLabel,
            actionLabel: busyMode.busyActionLabel,
            isAvailable: available,
            canSubmit: enabled,
            onSubmit: { submit(model, whenBusy: busyMode) },
            modeMenu: {
                ForEach(AidenStreamInputMode.busyModes, id: \.self) { mode in
                    Button {
                        busyMode = mode
                    } label: {
                        if busyMode == mode {
                            Label { Text(mode.busyLabel); Text(mode.busyDetail) } icon: { Image(systemName: "checkmark") }
                        } else {
                            Text(mode.busyLabel)
                            Text(mode.busyDetail)
                        }
                    }
                    .accessibilityAddTraits(busyMode == mode ? .isSelected : [])
                }
            }
        )
    }

    /// The shared surface: the +, the field and the send controls on one row.
    private func composer(_ model: AidenBotSessionModel, config: AidenComposerConfig) -> some View {
        AidenComposerSurface(
            session: composerSession,
            config: config,
            controls: model.composerControls(connection: ownerConnection, hasContent: composerSession.hasContent),
            onSend: { submit(model, whenBusy: nil) },
            onStop: model.isRunning ? { Task { await model.stop() } } : nil,
            accessory: {
                if !composerSession.attachments.isEmpty || !model.stagingAttachments.isEmpty {
                    pendingAttachments(model)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            },
            attachButton: { attachButton(model) },
            busyControl: {
                if model.composerAnswersHandoff || model.composerIsHeld {
                    // A waiting step's note goes with a plain Send, never Steer or Queue,
                    // and a held composer offers neither.
                    AidenComposerSendButton(
                        label: model.composerSendLabel,
                        isEnabled: model.canSendFromComposer(connection: ownerConnection, hasContent: composerSession.hasContent)
                    ) {
                        submit(model, whenBusy: nil)
                    }
                } else if model.offersBusyModes {
                    busyPill(model)
                }
            }
        )
        .background {
            GeometryReader { proxy in
                let minY = (proxy.frame(in: .named(AidenBotComposerCoordinateSpace.name)).minY * 2).rounded() / 2
                Color.clear.preference(
                    key: AidenComposerTopYPreferenceKey.self,
                    value: minY
                )
            }
        }
        .animation(
            reduceMotion ? nil : .smooth(duration: 0.28),
            value: composerSession.attachments.isEmpty && model.stagingAttachments.isEmpty
        )
    }

    private func composerPlaceholder(_ model: AidenBotSessionModel) -> String {
        if model.composerHeldForPlan { return "Review the plan to continue" }
        if model.isPaused { return AidenBotSessionCopy.pausedPlaceholder(bot?.name ?? "This Bot") }
        switch model.handoff?.kind {
        case .action:
            return model.composerHeldForNoNote
                ? AidenBotSessionCopy.handoffNoNotePlaceholder
                : AidenBotSessionCopy.handoffNotePlaceholder
        case .signIn: return AidenBotSessionCopy.signInPlaceholder
        case nil: return "Message"
        }
    }

    /// The workspace chat's +: Files, Camera and Photos on tap; quick-photo strip on long-press.
    private func attachButton(_ model: AidenBotSessionModel) -> some View {
        let canOpen = canCompose && canWrite && model.canAttach
        let canQuickPick = canOpen && !attachmentPicker.isPresented
        return AidenComposerAttachButton(
            isOpen: attachmentPicker.isPresented,
            isBusy: model.isAttaching || !model.stagingAttachments.isEmpty,
            showsSpinner: model.stagingAttachments.isEmpty && model.uploadProgress == nil,
            hint: canQuickPick
                ? String(localized: "Tap for attachment options, or touch and hold for quick photos")
                : String(localized: "Attach a photo or a text file"),
            coordinateSpace: AidenBotComposerCoordinateSpace.name,
            action: { toggleAttachmentPicker(model) },
            onLongPress: canQuickPick ? { openQuickPhotos(model) } : nil
        )
        .disabled(!canOpen && !attachmentPicker.isPresented)
    }

    /// The photos and files waiting to go with the next message.
    private func pendingAttachments(_ model: AidenBotSessionModel) -> some View {
        AidenComposerAttachmentStrip(
            pendingAttachments: composerSession.attachments,
            stagingStore: model.attachmentStagingStore,
            loadImageData: { attachment in
                model.attachmentImageData(attachment.id)
            },
            onRemovePending: { attachment in
                Task { await model.removeAttachment(attachment.id) }
            },
            onCancelStaging: { id in
                model.cancelStagingAttachment(id: id)
            }
        )
    }

    private func attachmentPickerOverlay(_ model: AidenBotSessionModel) -> some View {
        AidenAttachmentPickerOverlay(
            picker: attachmentPicker,
            attachmentCapacity: model.attachmentCapacity,
            canChoosePhotos: true,
            isBotChat: false,
            isBusy: model.isPreparingAttachments || !canWrite,
            attachmentButtonCenter: attachButtonCenter,
            composerTopY: composerTopY,
            onUnavailableBotPhotos: {},
            onChooseFiles: { isFileImporterPresented = true },
            onCaptureCameraPhoto: { data in attachCapturedPhoto(data, model: model) },
            onCommitPhotos: { attachSelectedPhotos(model) },
            onPickQuickPhoto: { selection in attachQuickPhoto(selection, model: model) }
        )
        .allowsHitTesting(attachmentPicker.isPresented)
        .accessibilityHidden(!attachmentPicker.isPresented)
        .zIndex(20)
    }

    private func toggleAttachmentPicker(_ model: AidenBotSessionModel) {
        if attachmentPicker.isPresented {
            attachmentPicker.dismiss()
            return
        }
        guard canCompose, canWrite, model.canAttach else { return }
        composerSession.putAwayKeyboard()
        attachmentPicker.openMenu()
    }

    private func openQuickPhotos(_ model: AidenBotSessionModel) {
        guard canCompose, canWrite, model.canAttach, !attachmentPicker.isPresented else { return }
        composerSession.putAwayKeyboard()
        attachmentPicker.openQuickPhotos()
    }

    /// Revision 50: this phone holds `attachments:raw` on the connected Mac.
    private var rawImageUploadsGranted: Bool {
        ownerConnection?.server?.supportsRawUploads == true
    }

    private func attachQuickPhoto(_ selection: AidenQuickPhotoSelection, model: AidenBotSessionModel) {
        attachmentPicker.dismiss()
        guard canWrite, model.canAttach else { return }
        model.rawImageUploads = rawImageUploadsGranted
        model.stageAndAttach([.quickPhoto(selection)])
    }

    private func attachSelectedPhotos(_ model: AidenBotSessionModel) {
        guard canWrite, !model.isPreparingAttachments,
              let commit = attachmentPicker.beginCommit(pendingCount: model.pendingAttachments.count) else { return }
        let items = commit.assets.map(AidenAttachmentStageItem.photoAsset)
        model.rawImageUploads = rawImageUploadsGranted
        guard let task = model.stageAndAttach(items) else {
            attachmentPicker.finishCommit(commit.id)
            return
        }
        Task { @MainActor in
            _ = await task.value
            attachmentPicker.finishCommit(commit.id)
        }
    }

    private func attachCapturedPhoto(_ data: Data, model: AidenBotSessionModel) {
        attachmentPicker.dismiss()
        guard canWrite, model.canAttach else { return }
        model.rawImageUploads = rawImageUploadsGranted
        model.stageAndAttach([.cameraCapture(data)])
    }

    private func attachFiles(_ result: Result<[URL], Error>) {
        guard let model, canWrite, case let .success(urls) = result, !urls.isEmpty else { return }
        let items = urls.map(AidenAttachmentStageItem.fileURL)
        model.rawImageUploads = rawImageUploadsGranted
        model.stageAndAttach(items)
    }

    @MainActor
    private func start() async {
        let startKey = "\(machineID)|\(startAttempt)"
        if let running = parts.runningModel(for: startKey) {
            // A rebuilt screen (an iPhone Duo opening or closing) takes over
            // the conversation its last view left running.
            startFailed = false
            model = running
            feedOpenedWith = parts.feedOpenedWith
            running.setResumeForegroundVisit(active: resumeVisitIsActive)
            await loadSummary()
            return
        }
        guard let context = try? coordinator.ownerContext(for: machineID),
              let client = try? coordinator.remoteClient(for: context) else {
            // No way to reach the Mac yet: say so, with Try again, instead of an endless skeleton.
            if model == nil { startFailed = true }
            return
        }
        startFailed = false
        // The chat opens on its last transcript and adopts the messages a
        // previous visit or launch left unsent (R14, R17).
        let model = AidenBotSessionModel(
            botID: botID,
            transport: client,
            owner: context,
            isOwnerLive: { [coordinator] in coordinator.isLive(context) },
            cacheKey: AidenBotSessionKey(instanceId: context.instanceId, deviceId: context.deviceId, botID: botID),
            allowedSupported: ownerConnection?.installation.hasNegotiatedAccess(to: .botAllowed) == true,
            plansSupported: ownerConnection?.installation.hasNegotiatedAccess(to: .botPlans) == true,
            isOwnerRetained: { [coordinator] in coordinator.isRetained(context) },
            speech: client
        )
        model.setResumeForegroundVisit(active: resumeVisitIsActive)
        model.routineModelsSupported = { [coordinator] in
            coordinator.botServer(on: context.instanceId)?.supportsBotRoutineModels == true
        }
        model.resumeModel = AidenBotResumeModel(botID: botID, transport: client,
            // The model's own foreground visit (`canResumeExecution`), not this
            // view's: a rebuilt screen's new view takes the model over.
            mayResume: { [weak model] in
                UIApplication.shared.applicationState == .active
                    && coordinator.isLive(context) && coordinator.botServer(on: context.instanceId)?.supportsBotRoutineModels == true
                    && coordinator.botConnectionState(on: context.instanceId) == .connected
                    && coordinator.botInstallation(on: context.instanceId)?.canWriteBots == true
                    && model?.canResumeExecution == true
            }, version: { [weak model] in model?.resumeConfirmationVersion ?? "released" },
            store: .shared, scope: .init(instanceID: context.instanceId, deviceID: context.deviceId, botID: botID))
        model.activitySupported = activitySupported
        model.attachmentsSupported = isAdvertised(AidenBotHostFeature.attachments)
        model.wording = AidenToolActivityPreference.wording(
            botWording: storedWording,
            hostOffersBotUX: ownerConnection?.installation.offersBotUX == true,
            showToolActivity: showToolActivity
        )
        feedOpenedWith = aidenBotSessionFeedGrants(ownerConnection?.installation)
        // G24: a hand-off that arrives while the person is away from this
        // chat (the app went to the background) alerts once, on this phone.
        let instanceID = context.instanceId
        let botID = botID
        model.onHandoffArrived = { handoff in
            let name = bot?.name ?? "Your Bot"
            Task { @MainActor in
                await AidenRunAlertNotifier.shared.notifyBotHandoff(
                    waitID: handoff.waitId,
                    kind: handoff.kind,
                    instanceID: instanceID,
                    botID: botID,
                    botName: name,
                    isChatOnScreen: true
                )
            }
        }
        // A model already here is this screen's last visit, or another machine's
        // chat. A late transcript must reach neither.
        if self.model != nil { composerSession.stopVoice() }
        self.model = model
        composerSession.draftOwner = model
        composerSession.attachmentOwner = model
        parts.feedOpenedWith = feedOpenedWith
        // Nothing waits on another: the first snapshot, the stream (with the
        // outbox it sends) and the Bot's detail start together.
        parts.run(model, for: startKey)
        await loadSummary()
    }

    @MainActor
    private func loadSummary() async {
        guard let context = try? machineContext() else { return }
        if summary == nil,
           let cached = await AidenBotCache.shared.load(instanceId: context.instanceId, deviceId: context.deviceId),
           let bot = cached.list?.bots.first(where: { $0.id == botID }) {
            summary = bot
        }
        if let detail = try? await coordinator.remoteClient(for: context).bot(id: botID),
           coordinator.holds(context) {
            summary = AidenBotSummary(detail: detail)
            storedWording = detail.chatActivity?.wording
            applyWording()
        }
    }
}

/// The conversation a durable Bot chat's Files open: this Bot's canonical
/// conversation (the same rule as Bots Home), or nil when it has none yet.
/// Conversations owned by another Bot are ignored.
func aidenBotSessionConversationChatID(
    botID: String,
    conversations: [AidenBotConversationItem]
) -> String? {
    aidenCanonicalBotConversations(conversations.filter { $0.botId == botID }).first?.chatId
}

extension AidenBotSessionModel {
    /// Messages are taken while the Mac is still connecting: they wait in the
    /// outbox and go out on connect (R14).
    static func canCompose(on connection: AidenHostConnection?) -> Bool {
        guard let connection, !AidenDockInput.isRevoked(connection) else { return false }
        return connection.installation.canWriteBots
    }

    /// Revision 37: a paused Bot takes nothing, and a waiting sign-in is
    /// finished on the Mac or skipped, so the composer waits for either.
    /// Revision 40: so does a password-or-code card, which takes no note.
    var composerIsHeld: Bool {
        isPaused || handoff?.kind == .signIn || composerHeldForNoNote
    }

    var composerSendLabel: String {
        composerAnswersHandoff ? String(localized: "Send and mark done") : String(localized: "Send")
    }

    func canSendFromComposer(connection: AidenHostConnection?, hasContent: Bool) -> Bool {
        let canCompose = Self.canCompose(on: connection)
        return canCompose && canSend && !composerHeldForPlan && !composerIsHeld && hasContent && !isPreparingAttachments
            && (!composerAnswersHandoff || (connection?.connectionState == .connected && canAnswerHandoff))
    }

    /// `connection` is the owner's. The mic follows the chat's: never into a field
    /// that takes nothing, and off while a reply runs. An offline machine can't
    /// hear a recording made for it, though its outbox will take typed words.
    func composerControls(
        connection: AidenHostConnection?,
        hasContent: Bool,
        voiceMode: AidenVoiceInputMode = .selected
    ) -> AidenComposerControls {
        let canCompose = Self.canCompose(on: connection)
        let fieldIsDisabled = !canCompose || composerIsHeld
        let machineCanHear = voiceMode == .onDevice || AidenDockInput.isOnline(connection)
        return AidenComposerControls(
            canSend: canSendFromComposer(connection: connection, hasContent: hasContent),
            sendLabel: composerSendLabel,
            canStop: canCompose && connection?.connectionState == .connected && !isStopping && !inFlight.contains(.stop),
            stopLabel: String(localized: "Stop"),
            fieldIsDisabled: fieldIsDisabled,
            // The busy pill takes the mic's place, as in a chat.
            offersMic: !offersBusyModes,
            micIsEnabled: !fieldIsDisabled && !isRunning && machineCanHear
        )
    }
}

extension AidenBotSessionCopy {
    static let couldNotSend = "Couldn’t send"
    static let tryAgain = "Try again"
    static let connecting = "Connecting…"
    static let removeMessage = "Remove message"
    static let unreachable = "Aiden couldn’t reach your computer. Try again."
}

/// The Steer/Queue pill's mode: Queue by default, kept while the Bot works, and
/// back to Queue when the turn ends (ruling 6, as in normal chats).
func aidenBotBusyMode(_ current: AidenStreamInputMode?, isRunning: Bool) -> AidenStreamInputMode {
    guard isRunning, let current else { return .queue }
    return current
}

/// The text of a message still waiting (Queued): the palette's quieter
/// text colour, nudged toward the main one only if a theme or contrast setting
/// leaves it under 4.5:1 on the bubble.
func aidenBotPendingTextHex(_ palette: AidenPalette) -> String {
    var hex = palette.secondaryHex
    var step = 0.0
    while aidenContrastRatio(hex, palette.raisedHex) < 4.5, step < 1 {
        step += 0.1
        hex = Color.mixHex(palette.secondaryHex, palette.foregroundHex, fraction: step)
    }
    return hex
}

/// WCAG 2 contrast between two `#RRGGBB` colours.
func aidenContrastRatio(_ first: String, _ second: String) -> Double {
    func luminance(_ hex: String) -> Double {
        let clean = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let value = Int(clean, radix: 16) ?? 0
        let channels = [(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF].map { channel -> Double in
            let c = Double(channel) / 255
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    }
    let (a, b) = (luminance(first), luminance(second))
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)
}

/// The quiet hint under a Bot chat while the Mac isn't reachable (R14).
enum AidenBotConnectionHint: Equatable {
    /// "Connecting…": no snapshot yet, or the stream dropped.
    case connecting
    /// The first load failed: its message, with Try again. The chat stays usable
    /// and keeps reconnecting.
    case unreachable(String)
}

/// The hint to show, or nil when connected. While a turn runs the status line
/// already says "Reconnecting to your computer", so the hint stays out of the way.
@MainActor
func aidenBotConnectionHint(for model: AidenBotSessionModel, nowMs: Int) -> AidenBotConnectionHint? {
    guard model.isConnecting else { return nil }
    if model.statusLine(nowMs: nowMs)?.display.phase == "reconnecting" { return nil }
    if !model.hasLoaded, let message = model.errorMessage { return .unreachable(message) }
    return .connecting
}

/// The streamed answer so far. Only this row and `AidenBotSessionPartialFollow`
/// read `revealedPartial`, so Observation redraws just them on each revealed
/// token instead of the whole transcript.
private struct AidenBotSessionPartialRow<Bubble: View>: View {
    let model: AidenBotSessionModel
    @ViewBuilder let bubble: (String) -> Bubble

    var body: some View {
        if let partial = model.revealedPartial, !partial.isEmpty {
            bubble(partial)
                .id("partial")
        }
    }
}

/// Keeps the transcript following the streamed answer as it grows.
private struct AidenBotSessionPartialFollow: View {
    let model: AidenBotSessionModel
    let onChange: () -> Void

    var body: some View {
        Color.clear
            .onChange(of: model.revealedPartial) { _, _ in onChange() }
    }
}

/// Skeleton bubbles while a chat opens with nothing cached (R14), shaped like
/// the shell's Bot chat skeleton so nothing jumps; never a spinner.
private struct AidenBotSessionSkeletonBubbles: View {
    /// The Mac can't be reached: the shimmer stops, so nothing pretends to load.
    var still = false
    @Environment(\.aidenReduceMotion) private var reduceMotion

    var body: some View {
        let quiet = reduceMotion || still
        VStack(alignment: .leading, spacing: 14) {
            AidenBotSkeletonBlock(width: 206, height: 48, radius: 20, reduceMotion: quiet)
            AidenBotSkeletonBlock(width: 252, height: 70, radius: 20, reduceMotion: quiet)
            HStack {
                Spacer(minLength: 72)
                AidenBotSkeletonBlock(width: 164, height: 48, radius: 20, reduceMotion: quiet)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading chat")
    }
}

/// The status line while a Bot works (spec §12): a native activity mark and the
/// shared word, plus the elapsed time after 20 seconds. No steps, no Stop.
struct AidenBotStatusLineView: View {
    let model: AidenBotSessionModel

    @Environment(\.aidenPalette) private var palette
    @State private var announcer = AidenBotStatusAnnouncer()
    @ScaledMetric(relativeTo: .subheadline) private var markSize: CGFloat = 18

    var body: some View {
        // Whether the line shows changes with the session, not the clock.
        let shown = model.statusLine(nowMs: Int(Date().timeIntervalSince1970 * 1_000)) != nil
        Group {
            // The clock ticks only while the line can show (FR-m1).
            if model.statusLineTicks {
                ticking
            }
        }
        .onChange(of: shown) { _, visible in
            // A hidden line starts afresh: its next word is announced at once.
            if !visible { announcer.reset() }
        }
    }

    private var ticking: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            if let line = model.statusLine(nowMs: Int(context.date.timeIntervalSince1970 * 1_000)) {
                HStack(spacing: 8) {
                    AidenActivityMark(mark: line.display.mark, size: markSize, color: palette.secondary)
                    Text(line.display.word)
                    if let elapsed = line.elapsed {
                        Text("· \(elapsed)").monospacedDigit()
                    }
                }
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                // The accessible name is the word; the elapsed time is its value.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(line.display.word)
                .accessibilityValue(line.elapsed ?? "")
                .accessibilityAddTraits(.updatesFrequently)
                .onChange(of: line.display.word, initial: true) { _, word in announce(word) }
            }
        }
    }

    /// VoiceOver hears a change at most once every 2 seconds; the newest word wins.
    private func announce(_ word: String) {
        let offer = announcer.offer(word, at: Date().timeIntervalSinceReferenceDate)
        if let text = offer.announce {
            AccessibilityNotification.Announcement(text).post()
        } else if let retry = offer.retryAfter {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(retry))
                if let latest = model.statusLine(nowMs: Int(Date().timeIntervalSince1970 * 1_000))?.display.word {
                    announce(latest)
                }
            }
        }
    }
}

/// A centred, quiet "Memory updated" line. Tapping it opens Profile → Memory.
struct AidenBotMemoryUpdatedCaption: View {
    let onOpen: () -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        Button(action: onOpen) {
            Label(AidenBotSessionCopy.memoryUpdated, systemImage: AidenBotMemorySymbol.name)
                .font(.footnote)
                .foregroundStyle(palette.secondary)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .accessibilityHint("Opens what this Bot remembers")
    }
}

/// "Add a routine?" with Add routine and Not now; after a decision it reads
/// "Added ✓ · {label}" or "Not added".
struct AidenBotRoutineProposalCardView: View {
    let card: AidenBotRoutineProposalCard
    let canRespond: Bool
    let isBusy: Bool
    let onRespond: (AidenBotRoutineProposalDecision) -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "calendar.badge.clock")
                .font(.title3)
                .foregroundStyle(palette.foreground)
                .frame(width: 40, height: 40)
                .background(palette.canvas, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(AidenBotSessionCopy.proposalTitle)
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                Text(AidenBotSessionCopy.proposalBody(name: card.name, label: card.label))
                    .font(.subheadline)
                    .foregroundStyle(palette.foreground)
                Text(card.prompt)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(2)
                status
                    .padding(.top, 4)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var status: some View {
        switch card.status {
        case .accepted:
            Text(AidenBotSessionCopy.proposalAdded(label: card.label))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.success)
        case .dismissed:
            Text(AidenBotSessionCopy.notAdded)
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
        case .pending:
            if canRespond {
                HStack(spacing: 10) {
                    Button(AidenBotSessionCopy.addRoutine) { onRespond(.accept) }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .aidenSolidFillTint()
                    Button(AidenBotSessionCopy.notNow) { onRespond(.dismiss) }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                }
                .disabled(isBusy)
            } else {
                Text(AidenBotSessionCopy.finishOnMacReadOnly)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
        }
    }
}

/// Revision 42 (`bot:issues`): a "Needs you" card the host raised, with up to
/// two actions. A card that offers nothing a phone can do (the Mac's own
/// settings opened it) says "Open on your computer".
struct AidenBotIssueCardView: View {
    let issue: AidenRemoteBotIssue
    let canAct: Bool
    let isBusy: Bool
    let onAct: (AidenBotIssueAction) -> Void

    @Environment(\.aidenPalette) private var palette

    private var symbol: String {
        switch issue.kind {
        case .preflightFailed: "wrench.and.screwdriver"
        case .routineFailed: "clock.badge.exclamationmark"
        case .routinePaused: "pause.circle"
        case .runStalled: "hourglass"
        case .accessNeeded: "folder"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(palette.foreground)
                .frame(width: 40, height: 40)
                .background(palette.canvas, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(AidenBotSessionCopy.issueNeedsYou)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                Text(issue.title)
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                if !issue.body.isEmpty {
                    Text(issue.body)
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                }
                actions
                    .padding(.top, 4)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var actions: some View {
        if issue.actions.isEmpty {
            // `open_settings` never crosses the wire: the rest is on the Mac.
            Text(AidenBotSessionCopy.issueOpenOnMac)
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
        } else if canAct {
            HStack(spacing: 10) {
                ForEach(Array(issue.actions.enumerated()), id: \.offset) { index, action in
                    Button(AidenBotSessionModel.issueActionTitle(action)) { onAct(action) }
                        .modifier(AidenBotIssueButtonStyle(isPrimary: index == issue.actions.count - 1))
                }
            }
            .disabled(isBusy)
        } else {
            Text(AidenBotSessionCopy.finishOnMacReadOnly)
                .font(.footnote)
                .foregroundStyle(palette.secondary)
        }
    }
}

/// The last action is primary: it carries the solid fill; the other stays bordered.
private struct AidenBotIssueButtonStyle: ViewModifier {
    let isPrimary: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isPrimary {
            content
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .aidenSolidFillTint()
        } else {
            content
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
        }
    }
}

/// `I couldn't finish that reply.`, with Retry on the newest failed turn.
struct AidenBotFailedTurnCard: View {
    let canRetry: Bool
    let isBusy: Bool
    let onRetry: () -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(AidenBotSessionCopy.failedTurn, systemImage: "exclamationmark.circle")
                .foregroundStyle(palette.foreground)
            if canRetry {
                Button(AidenBotSessionCopy.retry, action: onRetry)
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .aidenSolidFillTint()
                    .disabled(isBusy)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

/// `I got interrupted while working on this.` with Resume and Dismiss.
struct AidenBotInterruptedCard: View {
    let isAccessBlocked: Bool
    let isBusy: Bool
    let canAct: Bool
    let onResume: () -> Void
    let onDismiss: () -> Void
    var canOpenAdvanced = true
    var onOpenAdvanced: () -> Void = {}

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(AidenBotSessionCopy.interrupted, systemImage: "pause.circle")
                .foregroundStyle(palette.foreground)
            if isAccessBlocked {
                Text(AidenBotSessionCopy.accessChanged)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
            HStack(spacing: 10) {
                if isAccessBlocked {
                    if canOpenAdvanced {
                        Button(AidenBotSessionCopy.openAdvanced, action: onOpenAdvanced)
                            .buttonStyle(.borderedProminent)
                            .buttonBorderShape(.capsule)
                            .aidenSolidFillTint()
                    }
                } else {
                    Button(AidenBotSessionCopy.resume, action: onResume)
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .aidenSolidFillTint()
                }
                Button(AidenBotSessionCopy.dismiss, action: onDismiss)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
            }
            .disabled(isBusy || !canAct)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

/// Shown instead of the composer when the Bot has no AI model.
/// "Set up" opens Advanced, where the AI model is chosen; a phone that may
/// not change Bots is pointed to the Mac instead.
struct AidenBotNeedsModelCard: View {
    let botName: String
    let canSetUp: Bool
    let onSetUp: () -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(AidenBotSessionCopy.needsModel, systemImage: "cpu")
                .font(.headline)
                .foregroundStyle(palette.foreground)
            Text(AidenBotSessionCopy.needsModelDetail(botName: botName))
                .font(.footnote)
                .foregroundStyle(palette.secondary)
            if canSetUp {
                Button(AidenBotSessionCopy.setUp, action: onSetUp)
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .aidenSolidFillTint()
            } else {
                Text(AidenBotSessionCopy.needsModelHint)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The footer floats over the transcript: the soft fill sits on the canvas it was drawn on.
        .background {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(palette.warning.opacity(0.12))
                .background(palette.canvas, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .accessibilityElement(children: .contain)
    }
}

/// A Bot's request to connect a service. Credentials stay on the Mac.
struct AidenBotConnectCardView: View {
    let card: AidenBotConnectCard
    let canRequest: Bool
    let requestSent: Bool
    let onRequest: () -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: aidenBotConnectionSymbol(iconId: card.iconId))
                .font(.title3)
                .foregroundStyle(palette.foreground)
                .frame(width: 40, height: 40)
                .background(palette.canvas, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(AidenBotSessionCopy.connectTitle(card.name))
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                Text(card.reason)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                status
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var status: some View {
        switch card.status {
        case .connected:
            Text(AidenBotSessionCopy.connected)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.success)
        case .pending:
            if !canRequest {
                Text(AidenBotSessionCopy.finishOnMacReadOnly)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            } else if requestSent {
                Button(AidenBotSessionCopy.checkYourMac) {}
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .disabled(true)
            } else {
                Button(AidenBotSessionCopy.finishOnMac, action: onRequest)
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .aidenSolidFillTint()
            }
        case .dismissed:
            EmptyView()
        }
    }
}

// MARK: - Liquid Glass composer (revision 33 adds its +)

private enum AidenBotComposerCoordinateSpace {
    static let name = "aiden-bot-composer-coordinate-space"
}

/// The photos and files on one of the person's own messages before the Mac shows it.
struct AidenBotAttachmentChips: View {
    let attachments: [AidenAttachmentReference]
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            ForEach(attachments) { attachment in
                Label(attachment.name, systemImage: attachment.kind == .image ? "photo" : "doc.text")
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundStyle(palette.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(palette.raised, in: Capsule())
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The Bot's Steer or Queue control, the height of the composer's other controls.
struct AidenBotBusyPill<ModeMenu: View>: View {
    @Environment(\.aidenPalette) private var palette
    @AidenComposerActionSize private var actionSize
    let title: String
    let actionLabel: String
    let isAvailable: Bool
    let canSubmit: Bool
    let onSubmit: () -> Void
    @ViewBuilder let modeMenu: () -> ModeMenu

    var body: some View {
        Menu {
            modeMenu()
        } label: {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: actionSize)
                .foregroundStyle(canSubmit ? palette.onFillAccent : palette.secondary)
                // Inside the glass pill a quiet tint, not a second raised surface.
                .background(canSubmit ? palette.fillAccent : palette.foreground.opacity(0.08), in: Capsule())
        } primaryAction: {
            onSubmit()
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .disabled(!isAvailable)
        .accessibilityLabel(actionLabel)
        .accessibilityHint("Touch and hold to choose Steer or Queue")
    }
}

/// Who the coordinator counts as showing a Bot chat's machine.
private final class AidenBotChatOnScreen {}

/// Where a Bot chat's tools go. Profile, Advanced, Files and Delete all read and
/// write `machine`, the chat's own.
@MainActor
struct AidenBotSessionTools {
    let coordinator: AidenRemoteCoordinator
    let machine: String
    let botID: String

    func profile(
        _ bot: AidenBotSummary,
        opensMemory: Bool,
        onChanged: @escaping () -> Void,
        onDeleted: @escaping () -> Void
    ) -> AidenBotProfileView {
        AidenBotProfileView(
            coordinator: coordinator,
            machine: machine,
            initialSummary: bot,
            onChanged: onChanged,
            onDeleted: onDeleted,
            opensMemory: opensMemory
        )
    }

    func advanced(
        onSaved: @escaping (AidenBotDetail) -> Void,
        onSaveFailed: @escaping (String) -> Void
    ) -> AidenBotAdvancedView {
        AidenBotAdvancedView(
            coordinator: coordinator,
            machine: machine,
            botID: botID,
            onSaved: onSaved,
            onSaveFailed: onSaveFailed
        )
    }

    func filesTools(chatID: String) -> AidenBotChatToolsModel {
        AidenBotChatToolsModel(chatID: chatID, botID: botID, machine: machine)
    }

    var canDelete: Bool {
        AidenBotDeletion.isAvailable(coordinator: coordinator, machine: machine)
    }

    func delete() async throws {
        try await AidenBotDeletion.deleteListed(botID: botID, coordinator: coordinator, machine: machine)
    }
}
