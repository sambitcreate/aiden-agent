import SwiftUI

/// Reads every live machine's routine feed for Home, through the reader the
/// notifier shares. Machines the Inbox hides, and machines that don't serve
/// `bot-proactive-v1`, are skipped.
@MainActor
enum AidenHomeFeedRefresh {
    static func run(
        coordinator: AidenRemoteCoordinator,
        hiddenMachines: Set<String>,
        reader: AidenBotRoutineFeedReader? = nil
    ) async {
        let reader = reader ?? .shared
        for connection in coordinator.hosts.ordered
        where !connection.isRevoked && connection.connectionState == .connected
            && !hiddenMachines.contains(connection.instanceId) {
            let instanceId = connection.instanceId
            guard !Task.isCancelled else { return }
            guard AidenBotHostFeature.isAdvertised(
                      AidenBotHostFeature.proactive,
                      by: coordinator.knownServerFeatures(of: instanceId)
                  ),
                  let context = try? coordinator.ownerContext(for: instanceId),
                  let client = try? coordinator.remoteClient(for: context) else { continue }
            let grants = AidenBotRoutineNotifier.audienceGrants(
                installation: coordinator.botInstallation(on: instanceId),
                server: coordinator.botServer(on: instanceId)
            )
            await reader.refreshIfStale(instanceId: instanceId, transport: client, grants: grants) {
                coordinator.isLive(context) && coordinator.botConnectionState(on: instanceId) == .connected
            }
        }
    }
}

/// The Bots Home can show: every online, unblocked machine the Inbox shows.
enum AidenHomeBots {
    static func entries(
        snapshots: [String: AidenHostInboxSnapshot],
        hiddenMachines: Set<String>
    ) -> [AidenHomeDigest.BotEntry] {
        snapshots.values
            .filter { $0.isOnline && !$0.isBlocked && !hiddenMachines.contains($0.instanceId) }
            .sorted { $0.instanceId < $1.instanceId }
            .flatMap { snapshot in snapshot.bots.map { AidenHomeDigest.BotEntry(instanceId: snapshot.instanceId, bot: $0) } }
    }

    static func route(_ entry: AidenHomeDigest.BotEntry, snapshots: [String: AidenHostInboxSnapshot]) -> AidenAppRoute? {
        guard let snapshot = snapshots[entry.instanceId] else { return nil }
        return .bot(AidenHostObjectID(instanceId: entry.instanceId, deviceId: snapshot.deviceId, objectId: entry.bot.id))
    }
}

/// The top of Home: the greeting, the Bots as sprites, and "From your Bots".
/// List content, so the screen it sits on keeps its own list below.
struct AidenHomeHeader: View {
    let coordinator: AidenRemoteCoordinator
    let store: AidenUnifiedInboxStore
    var reader: AidenBotRoutineFeedReader = .shared
    let onOpen: (AidenAppRoute) -> Void
    let onSeeAllBots: () -> Void

    @AppStorage(AidenHomeName.defaultsKey) private var localName = ""
    @Environment(\.aidenPalette) private var palette
    /// True until the first feed read for the shown machines finishes, so the
    /// card holds skeleton rows rather than flashing "Nothing new".
    @State private var feedPending = true

    var body: some View {
        let bots = AidenHomeBots.entries(snapshots: store.snapshots, hiddenMachines: store.hiddenMachines)
        let feed = bots.isEmpty ? [] : Set(bots.map(\.instanceId)).sorted().flatMap { instanceId in
            reader.notifications(for: instanceId).map { AidenHomeDigest.FeedEntry(instanceId: instanceId, notification: $0) }
        }
        let digest = AidenHomeDigest.make(bots: bots, feed: feed)
        Section {
            greeting
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            if !bots.isEmpty {
                spriteRow(AidenHomeBotRoster.sprites(bots))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        .task(id: Set(bots.map(\.instanceId))) {
            await AidenHomeFeedRefresh.run(coordinator: coordinator, hiddenMachines: store.hiddenMachines, reader: reader)
            if !Task.isCancelled { feedPending = false }
        }
        if !bots.isEmpty {
            digestSection(
                digest,
                loading: feedPending && !bots.contains { reader.windows[$0.instanceId] != nil }
            )
        }
    }

    private var greeting: some View {
        TimelineView(.everyMinute) { context in
            Text(AidenGreeting.make(date: context.date, name: AidenHomeName.resolve(host: nil, local: localName)))
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(palette.foreground)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("home.greeting")
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func spriteRow(_ entries: [AidenHomeDigest.BotEntry]) -> some View {
        HStack(alignment: .top, spacing: AidenSpacing.l) {
            ForEach(entries, id: \.bot.id) { entry in
                Button {
                    if let route = AidenHomeBots.route(entry, snapshots: store.snapshots) { onOpen(route) }
                } label: {
                    VStack(spacing: AidenSpacing.xs) {
                        AidenBotCanonicalAvatarView(
                            coordinator: coordinator,
                            machine: entry.instanceId,
                            botID: entry.bot.id,
                            avatar: entry.bot.avatar,
                            name: entry.bot.name,
                            size: 56,
                            working: AidenBotAttention.isRunning(entry.bot)
                        )
                        Text(entry.bot.name)
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                            .lineLimit(1)
                    }
                    .frame(minWidth: 64, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(entry.bot.name)
                .accessibilityValue(AidenBotAttention.reason(entry.bot) ?? "")
                .accessibilityHint("Opens the Bot.")
                .accessibilityIdentifier("home.bot")
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func digestSection(_ digest: AidenHomeDigest, loading: Bool) -> some View {
        Section {
            if digest.rows.isEmpty, loading {
                AidenChatListSkeleton(rowCount: 2, accessibilityText: "Loading news from your Bots")
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("home.digest.loading")
            } else if digest.rows.isEmpty {
                Text("Nothing new from your Bots.")
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .accessibilityIdentifier("home.digest.empty")
            }
            ForEach(digest.rows) { row in
                Button {
                    let entry = AidenHomeDigest.BotEntry(instanceId: row.instanceId, bot: row.bot)
                    if let route = AidenHomeBots.route(entry, snapshots: store.snapshots) { onOpen(route) }
                } label: {
                    AidenHomeDigestRow(coordinator: coordinator, row: row)
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.clear)
                .accessibilityIdentifier("home.digest.row")
            }
        } header: {
            HStack {
                Text("From your Bots")
                    .aidenType(.sectionCaption)
                    .foregroundStyle(palette.secondary)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if digest.hasMore || !digest.rows.isEmpty {
                    Button("See all", action: onSeeAllBots)
                        .font(.footnote.weight(.semibold))
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("home.digest.seeAll")
                }
            }
            .textCase(nil)
        }
    }
}

/// One "From your Bots" row: the Bot's sprite, its name and news, and a chip
/// when it needs the person, works, or failed.
private struct AidenHomeDigestRow: View {
    let coordinator: AidenRemoteCoordinator
    let row: AidenHomeDigest.Row

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: AidenSpacing.m) {
            AidenBotCanonicalAvatarView(
                coordinator: coordinator,
                machine: row.instanceId,
                botID: row.bot.id,
                avatar: row.bot.avatar,
                name: row.bot.name,
                size: 36,
                working: row.status == .working
            )
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: AidenSpacing.s) {
                    Text(row.bot.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    chip
                }
                Text(row.title)
                    .font(.subheadline)
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                if !row.preview.isEmpty {
                    Text(row.preview)
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(2)
                }
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the Bot.")
    }

    @ViewBuilder
    private var chip: some View {
        switch row.status {
        case .needsYou: AidenStatusChip("Needs you", tone: .warning)
        case .working: AidenStatusChip("Working", tone: .accent)
        case .failed: AidenStatusChip("Failed", tone: .danger)
        case .update: EmptyView()
        }
    }
}

/// Home's composer. It reuses the shared composer surface; Send asks where the
/// chat runs (the same choices as the New chat button) and hands the text to
/// the new chat's composer, and the mic starts a voice chat on the default
/// machine.
struct AidenHomeComposerSlot: View {
    let flow: AidenNewWorkChatFlow
    /// The machine the page is showing, if just one.
    var machine: String? = nil

    @State private var session = AidenComposerSession()
    @State private var isShowingChoices = false
    @State private var choosing: Task<Void, Never>?

    var body: some View {
        AidenComposerSurface(
            session: session,
            config: .home(),
            controls: AidenComposerControls(
                // Only "no computer to ask" disables these; a chat still being
                // made never does (the owner's never-gate rule).
                canSend: session.hasContent && hasMachine,
                sendLabel: String(localized: "Start chat"),
                micIsEnabled: hasMachine
            ),
            onSend: ask,
            onStop: nil,
            onToggleVoice: { AidenForegroundIntentRouter.shared.submit(homeAction: .newChatVoice) }
        )
        .accessibilityIdentifier("home.composer")
        .popover(isPresented: $isShowingChoices, arrowEdge: .bottom) {
            AidenNewAgentPopover(
                choices: flow.choices,
                canUseExistingWorkspace: !flow.existingWorkspaces.isEmpty,
                machinePicker: AidenNewWorkMachinePicker(picker: flow.picker),
                canStart: flow.canStart,
                onSelect: start
            )
            .frame(width: 320)
            .presentationCompactAdaptation(.popover)
        }
        .onChange(of: flow.deliveredPromptCount) { session.text = "" }
    }

    private var hasMachine: Bool { !flow.picker.machines(includingHidden: false).isEmpty }

    private func ask() {
        guard session.hasContent else { return }
        flow.picker.startOver(preferring: machine, offeringHidden: false)
        isShowingChoices = true
    }

    private func start(_ choice: AidenNewAgentChoice) {
        isShowingChoices = false
        let prompt = session.text
        choosing?.cancel()
        choosing = Task { @MainActor in
            await Task.yield()
            await flow.select(choice, prompt: prompt)
        }
    }
}

/// Settings → Appearance → Home: what Home calls the person. Kept on this
/// device only.
struct AidenHomeNameSection: View {
    @AppStorage(AidenHomeName.defaultsKey) private var name = ""

    var body: some View {
        Section {
            TextField("Your name", text: $name)
                .textContentType(.givenName)
                .submitLabel(.done)
                .onChange(of: name) { _, value in
                    if value.count > AidenHomeName.maximumLength {
                        name = String(value.prefix(AidenHomeName.maximumLength))
                    }
                }
                .accessibilityIdentifier("settings.home.name")
        } header: {
            Text("Home")
        } footer: {
            Text("Home greets you by this name. It stays on this iPhone. Leave it empty for a plain greeting.")
        }
    }
}
