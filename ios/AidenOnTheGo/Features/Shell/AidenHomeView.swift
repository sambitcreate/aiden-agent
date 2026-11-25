import SwiftUI

/// Reads every live machine's routine feed for Home, through the reader the
/// notifier shares, all machines at once. Machines the Inbox hides, and
/// machines that don't serve `bot-proactive-v1`, are skipped. Returns how
/// each machine's read went.
@MainActor
enum AidenHomeFeedRefresh {
    static func run(
        coordinator: AidenRemoteCoordinator,
        hiddenMachines: Set<String>,
        reader: AidenBotRoutineFeedReader? = nil,
        force: Bool = false
    ) async -> [String: AidenBotRoutineFeedReader.Outcome] {
        let reader = reader ?? .shared
        var outcomes: [String: AidenBotRoutineFeedReader.Outcome] = [:]
        await withTaskGroup(of: (String, AidenBotRoutineFeedReader.Outcome).self) { group in
            for connection in coordinator.hosts.ordered
            where !connection.isRevoked && connection.connectionState == .connected
                && !hiddenMachines.contains(connection.instanceId) {
                let instanceId = connection.instanceId
                guard AidenBotHostFeature.isAdvertised(
                          AidenBotHostFeature.proactive,
                          by: coordinator.knownServerFeatures(of: instanceId)
                      ),
                      let context = try? coordinator.ownerContext(for: instanceId),
                      let client = try? coordinator.remoteClient(for: context) else {
                    outcomes[instanceId] = .skipped
                    continue
                }
                let grants = AidenBotRoutineNotifier.audienceGrants(
                    installation: coordinator.botInstallation(on: instanceId),
                    server: coordinator.botServer(on: instanceId)
                )
                group.addTask { @MainActor in
                    let outcome = await reader.refreshIfStale(
                        instanceId: instanceId, transport: client, grants: grants, force: force
                    ) {
                        coordinator.isLive(context) && coordinator.botConnectionState(on: instanceId) == .connected
                    }
                    return (instanceId, outcome)
                }
            }
            for await (instanceId, outcome) in group { outcomes[instanceId] = outcome }
        }
        return outcomes
    }
}

/// How Home's feed reads went, kept by the shell so a pull to refresh and the
/// card share them. A machine with no outcome yet is still being read.
@MainActor
@Observable
final class AidenHomeFeedModel {
    /// How often an open Home reads again.
    static let interval: Duration = .seconds(60)

    let reader: AidenBotRoutineFeedReader
    private(set) var outcomes: [String: AidenBotRoutineFeedReader.Outcome] = [:]

    init(reader: AidenBotRoutineFeedReader? = nil) {
        self.reader = reader ?? .shared
    }

    func refresh(coordinator: AidenRemoteCoordinator, hiddenMachines: Set<String>, force: Bool = false) async {
        let results = await AidenHomeFeedRefresh.run(
            coordinator: coordinator, hiddenMachines: hiddenMachines, reader: reader, force: force
        )
        guard !Task.isCancelled else { return }
        outcomes.merge(results) { $1 }
    }

    /// Drops what's known about machines Home no longer shows, so one that
    /// comes back is read afresh rather than shown as read.
    func keep(only machines: Set<String>) {
        let kept = outcomes.filter { machines.contains($0.key) }
        if kept.count != outcomes.count { outcomes = kept }
    }

    /// Reads now, then again every `interval` while Home is on screen.
    func keepReading(coordinator: AidenRemoteCoordinator, hiddenMachines: Set<String>) async {
        while !Task.isCancelled {
            await refresh(coordinator: coordinator, hiddenMachines: hiddenMachines)
            try? await Task.sleep(for: Self.interval)
        }
    }
}

/// The Bots Home can show: every unblocked machine the Inbox shows, online
/// or not. An offline machine's Bots are the ones it last listed.
enum AidenHomeBots {
    static func entries(
        snapshots: [String: AidenHostInboxSnapshot],
        hiddenMachines: Set<String>
    ) -> [AidenHomeDigest.BotEntry] {
        snapshots.values
            .filter { !$0.isBlocked && !hiddenMachines.contains($0.instanceId) }
            .sorted { $0.instanceId < $1.instanceId }
            .flatMap { snapshot in snapshot.bots.map { AidenHomeDigest.BotEntry(instanceId: snapshot.instanceId, bot: $0) } }
    }

    static func route(_ entry: AidenHomeDigest.BotEntry, snapshots: [String: AidenHostInboxSnapshot]) -> AidenAppRoute? {
        guard let snapshot = snapshots[entry.instanceId] else { return nil }
        return .bot(AidenHostObjectID(instanceId: entry.instanceId, deviceId: snapshot.deviceId, objectId: entry.bot.id))
    }

    /// Every paired machine as Home's Bots see it.
    @MainActor
    static func machines(
        coordinator: AidenRemoteCoordinator,
        snapshots: [String: AidenHostInboxSnapshot],
        hiddenMachines: Set<String>
    ) -> [AidenHomeBotsState.Machine] {
        coordinator.hosts.ordered.filter { !$0.isRevoked }.map { connection in
            AidenHomeBotsState.Machine(
                readsBots: connection.installation.hasNegotiatedAccess(to: .botRead),
                isHidden: hiddenMachines.contains(connection.instanceId),
                isBlocked: snapshots[connection.instanceId]?.isBlocked ?? false,
                isOnline: connection.isKnownOnline,
                isOffline: connection.isKnownOffline,
                answered: snapshots[connection.instanceId]?.fetchedAt != nil
            )
        }
    }
}

/// The top of Home: the greeting, the Bots as sprites, and "From your Bots".
/// List content, so the screen it sits on keeps its own list below.
struct AidenHomeHeader: View {
    let coordinator: AidenRemoteCoordinator
    let store: AidenUnifiedInboxStore
    let feedModel: AidenHomeFeedModel
    let onOpen: (AidenAppRoute) -> Void
    /// The Bots tab, where a Bot is made and every Bot is listed.
    let onOpenBots: () -> Void
    /// "See all": Catch Up when something waits, else every Bot.
    let onSeeAll: () -> Void

    @AppStorage(AidenHomeName.defaultsKey) private var localName = ""
    @AppStorage(AidenHomeVisit.defaultsKey) private var lastVisit: Double = 0
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    /// The visit before this one, read once as Home appears, so "while you
    /// were away" holds while the person reads.
    @State private var previousVisit: Date?

    var body: some View {
        let hidden = store.hiddenMachines
        let bots = AidenHomeBots.entries(snapshots: store.snapshots, hiddenMachines: hidden)
        let machines = AidenHomeBots.machines(coordinator: coordinator, snapshots: store.snapshots, hiddenMachines: hidden)
        let state = AidenHomeBotsState.make(hasBots: !bots.isEmpty, machines: machines)
        let shown = Set(bots.map(\.instanceId))
        let reader = feedModel.reader
        let feed = shown.sorted().flatMap { instanceId in
            reader.notifications(for: instanceId, grants: grants(on: instanceId))
                .map { AidenHomeDigest.FeedEntry(instanceId: instanceId, notification: $0) }
        }
        let digest = AidenHomeDigest.make(
            bots: bots, feed: feed, since: Date.now.addingTimeInterval(-AidenHomeDigest.newsWindow)
        )
        let feedState = AidenHomeFeedState.make(
            hasRows: !digest.rows.isEmpty,
            machines: shown.sorted(),
            outcomes: feedModel.outcomes,
            hasWindow: { reader.windows[$0] != nil }
        )
        Section {
            greeting(away: digest.hasNewSince(previousVisit))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            botsArea(state: state, entries: bots, machines: machines)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
        .task(id: shown) {
            feedModel.keep(only: shown)
            guard !shown.isEmpty else { return }
            await feedModel.keepReading(coordinator: coordinator, hiddenMachines: hidden)
        }
        .onAppear {
            if previousVisit == nil, lastVisit > 0 { previousVisit = Date(timeIntervalSince1970: lastVisit) }
            lastVisit = Date.now.timeIntervalSince1970
        }
        if !bots.isEmpty {
            digestSection(digest, state: feedState)
        }
    }

    private func grants(on instanceId: String) -> Set<AidenRemoteCapability> {
        AidenBotRoutineNotifier.audienceGrants(
            installation: coordinator.botInstallation(on: instanceId),
            server: coordinator.botServer(on: instanceId)
        )
    }

    private func greeting(away: Bool) -> some View {
        TimelineView(.everyMinute) { context in
            VStack(alignment: .leading, spacing: AidenSpacing.xs) {
                Text(AidenGreeting.make(date: context.date, name: AidenHomeName.resolve(host: nil, local: localName)))
                    .aidenType(.statHero)
                    .foregroundStyle(palette.foreground)
                    .accessibilityIdentifier("home.greeting")
                if away {
                    Text("Your Bots worked while you were away")
                        .aidenType(.rowValue)
                        .foregroundStyle(palette.secondary)
                        .accessibilityIdentifier("home.greeting.away")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func botsArea(
        state: AidenHomeBotsState,
        entries: [AidenHomeDigest.BotEntry],
        machines: [AidenHomeBotsState.Machine]
    ) -> some View {
        switch state {
        case .bots:
            VStack(alignment: .leading, spacing: AidenSpacing.s) {
                spriteRow(AidenHomeBotRoster.sprites(entries))
                if AidenHomeBotsState.isAllOffline(machines) {
                    offlineNote("Your computer is offline. These are your Bots as it last listed them.")
                }
            }
        case .loading:
            spriteSkeleton
        case .noBots:
            Button(action: onOpenBots) {
                Label("Make your first Bot", systemImage: "plus.circle")
                    .aidenType(.rowTitle)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(palette.accent)
            .accessibilityHint("Opens Bots.")
            .accessibilityIdentifier("home.bots.first")
        case .offline:
            offlineNote("Your computer is offline. Your Bots show here when it's back.")
        case .none:
            EmptyView()
        }
    }

    private func offlineNote(_ text: LocalizedStringKey) -> some View {
        Label(text, systemImage: "wifi.slash")
            .aidenType(.footnote)
            .foregroundStyle(palette.secondary)
            .accessibilityIdentifier("home.bots.offline")
    }

    private var spriteSkeleton: some View {
        HStack(spacing: AidenSpacing.l) {
            ForEach(0..<3, id: \.self) { _ in
                AidenBotSkeletonBlock(width: 56, height: 56, radius: 28, reduceMotion: reduceMotion)
                    .frame(minWidth: 64)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading your Bots"))
        .accessibilityIdentifier("home.bots.loading")
    }

    private func spriteRow(_ entries: [AidenHomeDigest.BotEntry]) -> some View {
        HStack(alignment: .top, spacing: AidenSpacing.l) {
            ForEach(entries, id: \.bot.id) { entry in
                let isOnline = store.snapshots[entry.instanceId]?.isOnline ?? false
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
                            working: isOnline && AidenBotAttention.isRunning(entry.bot)
                        )
                        .opacity(isOnline ? 1 : 0.5)
                        Text(entry.bot.name)
                            .aidenType(.statCaption)
                            .foregroundStyle(palette.secondary)
                            .lineLimit(1)
                    }
                    .frame(minWidth: 64, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(entry.bot.name)
                .accessibilityValue(
                    isOnline ? AidenBotAttention.reason(entry.bot) ?? "" : String(localized: "Offline")
                )
                .accessibilityHint("Opens the Bot.")
                .accessibilityIdentifier("home.bot")
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func digestSection(_ digest: AidenHomeDigest, state: AidenHomeFeedState) -> some View {
        Section {
            switch state {
            case .rows:
                EmptyView()
            case .loading:
                AidenChatListSkeleton(rowCount: 2, accessibilityText: "Loading news from your Bots")
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("home.digest.loading")
            case .failed:
                Text("Couldn't get news from your Bots. Pull down to try again.")
                    .aidenType(.rowValue)
                    .foregroundStyle(palette.secondary)
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("home.digest.failed")
            case .quiet:
                Text("Nothing new from your Bots today.")
                    .aidenType(.rowValue)
                    .foregroundStyle(palette.secondary)
                    .listRowBackground(Color.clear)
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
                if digest.hasMore {
                    Button("See all", action: onSeeAll)
                        .aidenType(.sectionCaption)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("home.digest.seeAll")
                }
            }
            .textCase(nil)
        }
    }
}

/// When the person last opened Home, kept on this device only.
enum AidenHomeVisit {
    static let defaultsKey = "aiden.home.lastVisit"
}

/// One "From your Bots" row: the Bot's sprite, its name and news, and a chip
/// when it needs the person, works, or failed. At accessibility text sizes
/// the chip goes under the name instead of squeezing it.
private struct AidenHomeDigestRow: View {
    let coordinator: AidenRemoteCoordinator
    let row: AidenHomeDigest.Row

    @Environment(\.aidenPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
                let nameLayout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: AidenSpacing.xs))
                    : AnyLayout(HStackLayout(spacing: AidenSpacing.s))
                nameLayout {
                    Text(row.bot.name)
                        .aidenType(.rowTitle)
                        .fontWeight(.semibold)
                        .foregroundStyle(palette.foreground)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
                    chip
                }
                Text(row.title)
                    .aidenType(.rowValue)
                    .foregroundStyle(palette.foreground)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                if !row.preview.isEmpty {
                    Text(row.preview)
                        .aidenType(.rowValue)
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

/// What Home's composer holds, kept by the shell so the words survive the
/// layout rebuilding (a Duo folding or unfolding) and, saved on this device
/// like a chat's draft, a relaunch.
///
/// Send starts a chat at once: the words leave the field, a chat is made on
/// the last machine Home used (or the one its chip picks), and the chat sends
/// them as soon as it can. Nothing waits on the tap. If no chat can be made,
/// the words come back quietly, ahead of anything typed since.
@MainActor
@Observable
final class AidenHomeComposerModel {
    /// Where the draft is kept: a reserved place no paired machine or chat
    /// can name.
    static let draftInstanceId = "aiden.home"
    static let draftChatId = "composer"
    static let lastMachineKey = "aiden.home.lastMachine"

    let session = AidenComposerSession()
    /// "Starting a chat on Studio…" while sends are on their way.
    private(set) var status: String?
    /// Why the last Send made no chat, until the person types or sends again.
    private(set) var notice: String?

    @ObservationIgnored private let store: AidenChatDraftStore
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let saveDelay: Duration
    @ObservationIgnored private var storeSession: AidenChatDraftStore.Session?
    @ObservationIgnored private var restoring: Task<Void, Never>?
    @ObservationIgnored private var saving: Task<Void, Never>?
    @ObservationIgnored private var sends: [UUID: Task<Void, Never>] = [:]
    /// Bumped by every edit, so a restore that lands late never overwrites
    /// words typed meanwhile.
    @ObservationIgnored private var edits: UInt64 = 0
    /// The chip Home last aimed, so the last machine is offered once per chip
    /// and a later pick by hand is left alone.
    @ObservationIgnored private var aimed: ObjectIdentifier?

    init(store: AidenChatDraftStore = .shared, defaults: UserDefaults = .standard, saveDelay: Duration = .milliseconds(250)) {
        self.store = store
        self.defaults = defaults
        self.saveDelay = saveDelay
        restoring = Task { [weak self] in await self?.restore() }
    }

    /// Finished once the saved draft, if any, is back in the field.
    func restored() async { await restoring?.value }

    /// Finished once the latest edit is saved.
    func saved() async { await saving?.value }

    /// The machine Home last started a chat on.
    var lastMachine: String? { defaults.string(forKey: Self.lastMachineKey) }

    /// How many sends are still on their way.
    var pendingSends: Int { sends.count }

    private func restore() async {
        let session = await store.beginSession(instanceId: Self.draftInstanceId, chatId: Self.draftChatId)
        storeSession = session
        let editsBefore = edits
        guard let saved = await store.load(session: session), !saved.isEmpty,
              edits == editsBefore, session == storeSession, self.session.text.isEmpty else { return }
        self.session.text = saved
    }

    /// The field changed: save it shortly.
    func textChanged() {
        edits &+= 1
        if !session.text.isEmpty { notice = nil }
        let text = session.text
        saving?.cancel()
        saving = Task { [weak self, saveDelay] in
            try? await Task.sleep(for: saveDelay)
            guard !Task.isCancelled, let self else { return }
            await self.restoring?.value
            guard !Task.isCancelled, let session = self.storeSession, self.session.text == text else { return }
            _ = try? await self.store.save(text, session: session)
        }
    }

    /// The machine Home's chip starts on: the last one Home used while it
    /// can still take a chat, otherwise the picker's own default.
    func aim(_ picker: AidenNewWorkPicker) {
        let last = lastMachine.flatMap { id in picker.machines.first { $0.id == id && $0.canBePicked }?.id }
        // The last machine is offered once, as soon as it can take a chat.
        if aimed != ObjectIdentifier(picker), let last {
            aimed = ObjectIdentifier(picker)
            picker.pick(last)
            return
        }
        guard !picker.canStart else { return }
        picker.startOver(preferring: last, offeringHidden: false)
    }

    /// Send: hands the field's words to a new chat and empties the field.
    func send(using flow: AidenNewWorkChatFlow) {
        let prompt = session.text
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let picker = flow.homePicker
        aim(picker)
        guard let target = picker.target else {
            notice = String(localized: "Pair a computer to start a chat.")
            return
        }
        notice = nil
        session.text = ""
        textChanged()
        let name = picker.pickedMachine?.label.name
        let id = UUID()
        sends[id] = Task { [weak self] in
            let outcome = await flow.startChat(sending: prompt, on: target)
            self?.finish(id, prompt: prompt, target: target, outcome: outcome)
        }
        updateStatus(machineName: name)
    }

    private func finish(_ id: UUID, prompt: String, target: AidenNewWorkTarget, outcome: AidenHomeSendOutcome) {
        sends[id] = nil
        switch outcome {
        case .started:
            defaults.set(target.instanceId, forKey: Self.lastMachineKey)
        case .needsChoice:
            giveBack(prompt)
            notice = String(localized: "That computer can’t start a chat on its own yet. Use New chat to choose a workspace.")
        case .failed(let reason):
            giveBack(prompt)
            notice = reason ?? String(localized: "The chat didn’t start. Your words are back in the field.")
        }
        updateStatus(machineName: nil)
    }

    /// The words go back ahead of anything typed since Send.
    private func giveBack(_ prompt: String) {
        session.text = AidenDraftSendReconciliation.failedDraft(submitted: prompt, current: session.text)
        let notice = notice
        textChanged()
        self.notice = notice
    }

    private func updateStatus(machineName: String?) {
        if sends.isEmpty {
            status = nil
        } else if let machineName {
            status = String(localized: "Starting a chat on \(machineName)…")
        } else if status == nil {
            status = String(localized: "Starting a chat…")
        }
    }
}

/// Home's composer on the shared composer surface. Send starts a chat on the
/// machine the chip shows; the mic starts a voice chat.
struct AidenHomeComposerSlot: View {
    let flow: AidenNewWorkChatFlow
    let model: AidenHomeComposerModel

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        let picker = flow.homePicker
        AidenComposerSurface(
            session: model.session,
            config: .home(),
            controls: AidenComposerControls(
                // Only "no computer to ask" disables these; a machine still
                // connecting or a chat still being made never does.
                canSend: model.session.hasContent && hasMachine,
                sendLabel: String(localized: "Start chat"),
                micIsEnabled: hasMachine,
                micLabel: String(localized: "New voice chat"),
                micHint: String(localized: "Starts a chat you talk to.")
            ),
            onSend: { model.send(using: flow) },
            onStop: nil,
            onToggleVoice: { AidenForegroundIntentRouter.shared.submit(homeAction: .newChatVoice) },
            accessory: { accessory(picker) }
        )
        .accessibilityIdentifier("home.composer")
        .onChange(of: model.session.text) { model.textChanged() }
        .onAppear { model.aim(picker) }
        .onChange(of: picker.machines(includingHidden: false).map(\.id)) { model.aim(picker) }
    }

    private var hasMachine: Bool { !flow.homePicker.machines(includingHidden: false).isEmpty }

    @ViewBuilder
    private func accessory(_ picker: AidenNewWorkPicker) -> some View {
        let line = model.notice ?? model.status
        if picker.showsPicker || line != nil {
            VStack(alignment: .leading, spacing: AidenSpacing.xs) {
                AidenNewWorkMachinePicker(picker: picker)
                if let line {
                    Text(line)
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier(model.notice != nil ? "home.composer.notice" : "home.composer.status")
                }
            }
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
