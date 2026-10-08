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
    @State private var isShowingAdvanced = false
    @State private var isConfirmingDelete = false
    @State private var isDeleting = false
    @State private var deleteErrorMessage: String?
    /// The Bot's conversation tools, loaded once it has a conversation; Files
    /// is offered only when they grant file access.
    @State private var filesTools: AidenBotChatToolsModel?
    @State private var presentedFilesGrant: AidenBotConversationFileGrant?
    @FocusState private var composerFocused: Bool

    private var bot: AidenBotSummary? { summary ?? initialSummary }

    private var canWrite: Bool {
        coordinator.connectionState == .connected
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
    }

    private var canRequestConnections: Bool {
        canWrite && AidenBotHostFeature.isAdvertised(AidenBotHostFeature.connectionRequests, coordinator: coordinator)
    }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if let model, model.hasLoaded {
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
        .sheet(isPresented: $isShowingProfile) {
            if let bot {
                AidenBotProfileView(
                    coordinator: coordinator,
                    initialSummary: bot,
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

    /// Profile, Files, and Delete for this Bot.
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
            if AidenBotDeletion.isAvailable(coordinator: coordinator) {
                Button(role: .destructive) {
                    isConfirmingDelete = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .disabled(isDeleting)
            }
        } label: {
            Image(systemName: "ellipsis.circle")
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

    @ViewBuilder
    private var transcript: some View {
        if let model, model.hasLoaded {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(model.entries) { entry in
                            entryView(entry, model: model)
                                .id(entry.id)
                        }
                        if let partial = model.partial {
                            assistantBubble(partial, interrupted: false)
                                .id("partial")
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: model.entries.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                .onChange(of: model.partial) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        } else if let message = model?.errorMessage {
            ContentUnavailableView {
                Label("Couldn’t Load Chat", systemImage: "exclamationmark.bubble")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model?.load() } }
            }
            .frame(maxHeight: .infinity)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Loading chat")
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

    private func composer(_ model: AidenBotSessionModel) -> some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Message", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($composerFocused)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .disabled(!canWrite)
            if model.isRunning {
                Button {
                    Task { await model.stop() }
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.body.weight(.semibold))
                        .frame(width: 40, height: 40)
                        .background(palette.raised, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canWrite || model.inFlight.contains(.stop))
                .accessibilityLabel("Stop")
            } else {
                Button {
                    let text = draft
                    Task {
                        if await model.send(text) { draft = "" }
                    }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(palette.onAccent)
                        .frame(width: 40, height: 40)
                        .background(palette.accent, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canWrite || !model.canSend
                          || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send")
            }
        }
    }

    @MainActor
    private func start() async {
        guard let context = try? coordinator.requestContext(),
              let client = try? coordinator.remoteClient(for: context) else { return }
        let model = AidenBotSessionModel(botID: botID, transport: client)
        self.model = model
        async let summaryLoad: Void = loadSummary()
        await model.load()
        _ = await summaryLoad
        await model.listen()
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
