import SwiftUI

/// The Bot chat on a host that advertises `bot-durable-session-v1`: one
/// durable conversation per Bot, loaded from `GET /bots/{id}/session` and kept
/// live by its event stream.
struct AidenBotSessionChatView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let botID: String
    var initialSummary: AidenBotSummary?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var model: AidenBotSessionModel?
    @State private var summary: AidenBotSummary?
    @State private var draft = ""
    @State private var isShowingProfile = false
    /// The profile sheet opens straight to Memory (from "Memory updated").
    @State private var profileOpensMemory = false
    @State private var isShowingAdvanced = false
    @State private var isConfirmingDelete = false
    @State private var isDeleting = false
    @State private var deleteErrorMessage: String?
    /// The Bot's conversation tools, loaded once it has a conversation; Files
    /// is offered only when they grant file access.
    @State private var filesTools: AidenBotChatToolsModel?
    @State private var presentedFilesGrant: AidenBotConversationFileGrant?
    /// Steer or Queue while the Bot works; back to Queue when the turn ends.
    @State private var busyMode: AidenStreamInputMode = .queue
    @FocusState private var composerFocused: Bool

    private var bot: AidenBotSummary? { summary ?? initialSummary }

    private var canWrite: Bool {
        coordinator.connectionState == .connected && canCompose
    }

    /// Messages are taken while the Mac is still connecting: they wait in the
    /// outbox and go out on connect (R14).
    private var canCompose: Bool {
        coordinator.installationStore.activeInstallation?.canWriteBots == true
    }

    /// Answering a Bot's tool approval needs `approval:respond` beside Bot write.
    private var canRespondToApprovals: Bool {
        canWrite && coordinator.installationStore.activeInstallation?.hasNegotiatedAccess(to: .approvalRespond) == true
    }

    /// Answering a routine proposal needs Bot write and `bot-proactive-v1`.
    private var canRespondToProposals: Bool {
        canWrite && AidenBotHostFeature.isAdvertised(AidenBotHostFeature.proactive, coordinator: coordinator)
    }

    private var canRequestConnections: Bool {
        canWrite && AidenBotHostFeature.isAdvertised(AidenBotHostFeature.connectionRequests, coordinator: coordinator)
    }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            // The composer is there at once; messages wait for the Mac (R14).
            if let model {
                footer(model)
            }
        }
        .background(palette.canvas.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { header }
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
        }
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
        .sheet(isPresented: $isShowingProfile, onDismiss: { profileOpensMemory = false }) {
            if let bot {
                AidenBotProfileView(
                    coordinator: coordinator,
                    initialSummary: bot,
                    onChanged: { Task { await loadSummary() } },
                    onDeleted: {
                        isShowingProfile = false
                        dismiss()
                    },
                    opensMemory: profileOpensMemory
                )
            }
        }
        .navigationDestination(isPresented: $isShowingAdvanced) {
            // "Set up" and "Advanced" land here; a saved model or access
            // change refreshes the session state.
            AidenBotAdvancedView(coordinator: coordinator, botID: botID) { updated in
                summary = AidenBotSummary(detail: updated)
                Task { await model?.load() }
            }
        }
        .alert(
            "Something Went Wrong",
            isPresented: Binding(
                get: { deleteErrorMessage != nil || (model?.errorMessage != nil && model?.hasLoaded == true) },
                set: { if !$0 { clearErrors() } }
            )
        ) {
            Button("OK", role: .cancel) { clearErrors() }
        } message: {
            Text(deleteErrorMessage ?? model?.errorMessage ?? "Please try again.")
        }
        .task(id: coordinator.activeInstanceId) {
            await start()
        }
        .task(id: filesLookupKey) {
            await loadFilesTools()
        }
        // Chat activity is changed in Advanced; reread the Bot when it closes.
        .onChange(of: isShowingAdvanced) { _, showing in
            if !showing { Task { await loadSummary() } }
        }
        .onChange(of: model?.isRunning == true) { _, running in
            if !running { busyMode = .queue }
        }
        .onChange(of: coordinator.server?.supportsBotActivity == true) { _, supported in
            model?.activitySupported = supported
        }
        // A first load that failed is a quiet hint while the chat keeps
        // reconnecting; once a snapshot arrives it is no longer news.
        .onChange(of: model?.hasLoaded == true) { _, loaded in
            if loaded { model?.errorMessage = nil }
        }
    }

    private func clearErrors() {
        deleteErrorMessage = nil
        model?.errorMessage = nil
    }

    private var filesGrant: AidenBotConversationFileGrant? {
        filesTools?.fileGrant(coordinator: coordinator, hostAllowsMutations: canWrite)
    }

    /// Looked up again once the chat has entries, since a brand-new Bot has
    /// no conversation until its first message.
    private var filesLookupKey: String {
        "\(coordinator.activeInstanceId ?? "")|\(model?.entries.isEmpty == false)"
    }

    /// Profile, Files, Memory, Advanced and Delete for this Bot.
    private var moreMenu: some View {
        Menu {
            Button {
                isShowingProfile = true
            } label: {
                Label("Profile", systemImage: "person.crop.circle")
            }
            if let grant = filesGrant {
                Button {
                    presentedFilesGrant = grant
                } label: {
                    Label("Files", systemImage: "folder")
                }
            }
            if AidenBotHostFeature.isAdvertised(AidenBotHostFeature.memory, coordinator: coordinator) {
                Button {
                    profileOpensMemory = true
                    isShowingProfile = true
                } label: {
                    Label("Memory", systemImage: AidenBotMemorySymbol.name)
                }
            }
            Button {
                isShowingAdvanced = true
            } label: {
                Label("Advanced", systemImage: "slider.horizontal.3")
            }
            if AidenBotDeletion.isAvailable(coordinator: coordinator) {
                Divider()
                Button(role: .destructive) {
                    isConfirmingDelete = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .disabled(isDeleting)
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .disabled(bot == nil)
        .accessibilityLabel("More for \(bot?.name ?? "this Bot")")
    }

    private func deleteBot() {
        let name = bot?.name ?? "This Bot"
        isDeleting = true
        Task {
            defer { isDeleting = false }
            do {
                try await AidenBotDeletion.deleteListed(botID: botID, coordinator: coordinator)
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
        guard let context = try? coordinator.requestContext(),
              let client = try? coordinator.remoteClient(for: context),
              let query = try? AidenBotConversationQuery(botId: botID),
              let page = try? await client.botConversations(query: query),
              coordinator.isCurrent(context),
              let chatID = aidenBotSessionConversationChatID(botID: botID, conversations: page.conversations),
              filesTools?.chatID != chatID else {
            return
        }
        let tools = AidenBotChatToolsModel(chatID: chatID, botID: botID)
        await tools.load(coordinator: coordinator)
        guard coordinator.isCurrent(context) else { return }
        filesTools = tools
    }

    private var header: some View {
        Button {
            isShowingProfile = true
        } label: {
            HStack(spacing: 8) {
                if let bot {
                    AidenBotCanonicalAvatarView(
                        coordinator: coordinator,
                        botID: bot.id,
                        avatar: bot.avatar,
                        name: bot.name,
                        size: 26
                    )
                }
                Text(bot?.name ?? "Bot")
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(bot == nil)
        .accessibilityHint("Opens the Bot’s profile")
    }

    /// Never a spinner or a blocking error (R14): the last transcript, or
    /// skeleton bubbles, with the person's own messages drawn at once.
    @ViewBuilder
    private var transcript: some View {
        if let model {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if model.showsSkeleton {
                            AidenBotSessionSkeletonBubbles()
                        }
                        ForEach(AidenBotTranscriptRow.rows(for: model.entries)) { row in
                            rowView(row, model: model)
                                .id(row.id)
                        }
                        if let partial = model.partial {
                            assistantBubble(partial, interrupted: false)
                                .id("partial")
                        }
                        ForEach(model.queued, id: \.submissionId) { message in
                            queuedBubble(message)
                        }
                        ForEach(model.outgoing) { message in
                            outgoingBubble(message, model: model)
                        }
                        AidenBotStatusLineView(model: model)
                            .id("status")
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: model.entries.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                .onChange(of: model.partial) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                .onChange(of: model.queued.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                .onChange(of: model.outgoing.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        } else {
            ScrollView {
                AidenBotSessionSkeletonBubbles()
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            }
            .scrollDisabled(true)
        }
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
                canRetry: model.retryableFailedTurn?.id == turn.id && canWrite && model.canSend,
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
        }
    }

    /// A user bubble the Mac's transcript doesn't hold yet: a Queued message,
    /// or one of the person's own on its way.
    private func pendingBubble<Caption: View>(
        _ text: String,
        faded: Bool,
        @ViewBuilder caption: () -> Caption
    ) -> some View {
        VStack(alignment: .trailing, spacing: 4) {
            Text(text)
                .foregroundStyle(palette.foreground)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .opacity(faded ? 0.55 : 1)
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

    private func queuedLook(_ text: String, mode: AidenStreamInputMode) -> some View {
        // A queued message waits for the reply; a steer has already joined it.
        pendingBubble(text, faded: mode == .queue) {
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
        case .sending:
            pendingBubble(message.text, faded: true) {
                Text(AidenBotSessionCopy.sending)
            }
            .accessibilityElement(children: .combine)
        case .sent:
            pendingBubble(message.text, faded: false) { EmptyView() }
        case let .queued(mode):
            queuedLook(message.text, mode: mode)
        case .failed:
            pendingBubble(message.text, faded: false) {
                HStack(spacing: 6) {
                    Label(AidenBotSessionCopy.couldNotSend, systemImage: "exclamationmark.circle.fill")
                        .labelStyle(.titleAndIcon)
                        .foregroundStyle(palette.danger)
                    Text("·")
                        .accessibilityHidden(true)
                    Button(AidenBotSessionCopy.tryAgain) {
                        Task { await model.retrySend(message.id) }
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.accent)
                    .disabled(!canCompose)
                    Button {
                        model.discardSend(message.id)
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption.weight(.semibold))
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Remove message")
                }
                .buttonStyle(.plain)
            }
            .accessibilityElement(children: .contain)
        }
    }

    private func assistantBubble(_ text: String, interrupted: Bool) -> some View {
        AidenMarkdownView(content: text)
            .foregroundStyle(palette.foreground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .opacity(interrupted ? 0.7 : 1)
            .accessibilityHint(interrupted ? "This answer was cut off" : "")
    }

    @ViewBuilder
    private func footer(_ model: AidenBotSessionModel) -> some View {
        VStack(spacing: 10) {
            if let hint = aidenBotConnectionHint(for: model, nowMs: Int(Date().timeIntervalSince1970 * 1_000)) {
                connectionHint(hint, model: model)
            }
            if let question = model.question, !model.needsModel {
                // The Bot's A–E quick replies. A Bot question has no deadline.
                AidenQuestionCard(
                    prompt: AidenPendingQuestion(
                        id: question.waitId,
                        questions: question.questions,
                        expiresAt: .distantFuture,
                        canRespond: canWrite
                    ),
                    onSubmit: { request in Task { await model.answerQuestion(request) } }
                )
                .disabled(!canWrite || !model.canAnswerQuestion)
                .id(question.waitId)
            }
            if let approval = model.approval {
                // The workspace chat's approval card. Allow is hidden when the
                // Mac says this tool can only be denied from a phone.
                AidenApprovalCard(
                    summary: approval.summary,
                    kind: .action,
                    canRespond: canRespondToApprovals,
                    hasRequiredWriteCapability: canRespondToApprovals,
                    canAllow: approval.canAllow,
                    scopes: [.once],
                    onDeny: { Task { await model.answerApproval(.deny) } },
                    onAllow: { _ in Task { await model.answerApproval(.allow) } }
                )
                .disabled(!canRespondToApprovals || !model.canAnswerApproval)
                .id(approval.waitId)
            }
            if model.needsModel {
                AidenBotNeedsModelCard(
                    botName: bot?.name ?? "this Bot",
                    canSetUp: canWrite,
                    onSetUp: { isShowingAdvanced = true }
                )
            } else if model.isInterrupted {
                AidenBotInterruptedCard(
                    isAccessBlocked: model.isAccessBlocked,
                    isBusy: model.inFlight.contains(.resume) || model.inFlight.contains(.dismiss),
                    canAct: canWrite,
                    onResume: { Task { await model.resume() } },
                    onDismiss: { Task { await model.dismiss() } },
                    onOpenAdvanced: { isShowingAdvanced = true }
                )
            }
            if !model.needsModel {
                composer(model)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
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
                    .buttonStyle(.plain)
            }
        }
        .font(.footnote)
        .foregroundStyle(palette.secondary)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }

    private var draftIsEmpty: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The draft clears at once and the bubble shows (R14); a refused message
    /// comes back to the composer.
    private func submit(_ model: AidenBotSessionModel, whenBusy mode: AidenStreamInputMode?) {
        let text = draft
        draft = ""
        Task {
            if !(await model.send(text, whenBusy: mode)), draft.isEmpty { draft = text }
        }
    }

    /// Steer or Queue while the Bot works (desktop and Android parity): the mode's
    /// name sends in that mode; touch and hold for the menu.
    private func busyPill(_ model: AidenBotSessionModel) -> some View {
        let enabled = canCompose && model.canSend && !draftIsEmpty
        return Menu {
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
        } label: {
            Text(busyMode.busyLabel)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .frame(minHeight: 40)
                .foregroundStyle(enabled ? palette.onAccent : palette.secondary)
                .background(enabled ? palette.accent : palette.raised, in: Capsule())
        } primaryAction: {
            submit(model, whenBusy: busyMode)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(busyMode.busyActionLabel)
        .accessibilityHint("Touch and hold to choose Steer or Queue")
    }

    private func composer(_ model: AidenBotSessionModel) -> some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Message", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composerFocused)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .disabled(!canCompose)
            if model.isRunning {
                if model.offersBusyModes {
                    busyPill(model)
                }
                Button {
                    Task { await model.stop() }
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.body.weight(.semibold))
                        .frame(width: 40, height: 40)
                        .background(palette.raised, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canWrite || model.isStopping || model.inFlight.contains(.stop))
                .accessibilityLabel("Stop")
            } else {
                Button {
                    submit(model, whenBusy: nil)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(palette.onAccent)
                        .frame(width: 40, height: 40)
                        .background(palette.accent, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canCompose || !model.canSend || draftIsEmpty)
                .accessibilityLabel("Send")
            }
        }
    }

    @MainActor
    private func start() async {
        guard let context = try? coordinator.requestContext(),
              let client = try? coordinator.remoteClient(for: context) else { return }
        // The chat opens on its last transcript and adopts the messages a
        // previous visit or launch left unsent (R14, R17).
        let model = AidenBotSessionModel(
            botID: botID,
            transport: client,
            cacheKey: AidenBotSessionKey(instanceId: context.instanceId, botID: botID)
        )
        model.activitySupported = coordinator.server?.supportsBotActivity == true
        self.model = model
        // Nothing waits on another: the first snapshot, the Bot's detail and the
        // stream (with the outbox it sends) start together.
        async let summaryLoad: Void = loadSummary()
        async let firstLoad: Void = model.load()
        await model.listen()
        _ = await (summaryLoad, firstLoad)
        model.release()
    }

    @MainActor
    private func loadSummary() async {
        guard let context = try? coordinator.requestContext() else { return }
        if summary == nil,
           let cached = await AidenBotCache.shared.load(instanceId: context.instanceId, deviceId: context.deviceId),
           let bot = cached.list?.bots.first(where: { $0.id == botID }) {
            summary = bot
        }
        if let detail = try? await coordinator.remoteClient(for: context).bot(id: botID),
           coordinator.isCurrent(context) {
            summary = AidenBotSummary(detail: detail)
            model?.wording = detail.chatActivity?.wording ?? .follows
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

extension AidenBotSessionCopy {
    static let sending = "Sending…"
    static let couldNotSend = "Couldn't send"
    static let tryAgain = "Try again"
    static let connecting = "Connecting…"
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
/// already says "Reconnecting to your Mac", so the hint stays out of the way.
@MainActor
func aidenBotConnectionHint(for model: AidenBotSessionModel, nowMs: Int) -> AidenBotConnectionHint? {
    guard model.isConnecting else { return nil }
    if model.statusLine(nowMs: nowMs)?.display.phase == "reconnecting" { return nil }
    if !model.hasLoaded, let message = model.errorMessage { return .unreachable(message) }
    return .connecting
}

/// Skeleton bubbles while a chat opens with nothing cached (R14), shaped like
/// the shell's Bot chat skeleton so nothing jumps; never a spinner.
private struct AidenBotSessionSkeletonBubbles: View {
    @Environment(\.aidenReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            AidenBotSkeletonBlock(width: 206, height: 48, radius: 20, reduceMotion: reduceMotion)
            AidenBotSkeletonBlock(width: 252, height: 70, radius: 20, reduceMotion: reduceMotion)
            HStack {
                Spacer(minLength: 72)
                AidenBotSkeletonBlock(width: 164, height: 48, radius: 20, reduceMotion: reduceMotion)
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

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            if let line = model.statusLine(nowMs: Int(context.date.timeIntervalSince1970 * 1_000)) {
                HStack(spacing: 8) {
                    AidenActivityMark(mark: line.display.mark, size: 18, color: palette.secondary)
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
                        .tint(palette.accent)
                        .foregroundStyle(palette.onAccent)
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
                    .tint(palette.accent)
                    .foregroundStyle(palette.onAccent)
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
                    Button(AidenBotSessionCopy.openAdvanced, action: onOpenAdvanced)
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .tint(palette.accent)
                        .foregroundStyle(palette.onAccent)
                } else {
                    Button(AidenBotSessionCopy.resume, action: onResume)
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .tint(palette.accent)
                        .foregroundStyle(palette.onAccent)
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
                    .tint(palette.accent)
                    .foregroundStyle(palette.onAccent)
            } else {
                Text(AidenBotSessionCopy.needsModelHint)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
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
                    .tint(palette.accent)
                    .foregroundStyle(palette.onAccent)
            }
        case .dismissed:
            EmptyView()
        }
    }
}
