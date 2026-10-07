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
        .alert(
            "Something Went Wrong",
            isPresented: Binding(
                get: { model?.errorMessage != nil && model?.hasLoaded == true },
                set: { if !$0 { model?.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { model?.errorMessage = nil }
        } message: {
            Text(model?.errorMessage ?? "Please try again.")
        }
        .task(id: coordinator.activeInstanceId) {
            await start()
        }
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
            if model.needsModel {
                AidenBotNeedsModelCard()
            } else if model.isInterrupted {
                AidenBotInterruptedCard(
                    isAccessBlocked: model.isAccessBlocked,
                    isBusy: model.inFlight.contains(.resume) || model.inFlight.contains(.dismiss),
                    canAct: canWrite,
                    onResume: { Task { await model.resume() } },
                    onDismiss: { Task { await model.dismiss() } }
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

/// `I got interrupted while working on this.` with Resume and Dismiss.
struct AidenBotInterruptedCard: View {
    let isAccessBlocked: Bool
    let isBusy: Bool
    let canAct: Bool
    let onResume: () -> Void
    let onDismiss: () -> Void

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
                if !isAccessBlocked {
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
struct AidenBotNeedsModelCard: View {
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(AidenBotSessionCopy.needsModel, systemImage: "cpu")
                .font(.headline)
                .foregroundStyle(palette.foreground)
            Text("\(AidenBotSessionCopy.needsModelHint): open Aiden Agent and choose a model for this Bot.")
                .font(.footnote)
                .foregroundStyle(palette.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
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
