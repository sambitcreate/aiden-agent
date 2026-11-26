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
    /// Waits out an interval; a test steps it by hand.
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void

    init(
        reader: AidenBotRoutineFeedReader? = nil,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.reader = reader ?? .shared
        self.sleep = sleep
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
        await repeatEveryInterval { [weak self] in
            await self?.refresh(coordinator: coordinator, hiddenMachines: hiddenMachines)
        }
    }

    /// Runs `read` now and again after every `interval`, until cancelled.
    func repeatEveryInterval(_ read: @MainActor () async -> Void) async {
        while !Task.isCancelled {
            await read()
            do { try await sleep(Self.interval) } catch { return }
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

/// What Home's feed reading restarts on: the machines it shows, and which of
/// them are connected now.
struct AidenHomeFeedKey: Equatable {
    var shown: Set<String>
    var connected: Set<String>
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
        let feedMachines = shown.sorted().map { instanceId in
            let connection = coordinator.hosts.connection(for: instanceId)
            return AidenHomeFeedState.Machine(
                id: instanceId,
                isConnected: connection?.connectionState == .connected,
                isOffline: connection.map { $0.isKnownOffline || $0.isRevoked } ?? true
            )
        }
        let feedState = AidenHomeFeedState.make(
            hasRows: !digest.rows.isEmpty,
            machines: feedMachines,
            outcomes: feedModel.outcomes,
            hasRead: { reader.hasFullRead($0) }
        )
        // Read again when a machine connects, not only on the next pass.
        let readable = AidenHomeFeedKey(shown: shown, connected: Set(feedMachines.filter(\.isConnected).map(\.id)))
        Section {
            greeting(away: digest.hasNewSince(previousVisit))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            botsArea(state: state, entries: bots, machines: machines)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
        .task(id: readable) {
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
                    // With the nav bar's title gone at Home, the greeting is
                    // the screen's heading for the rotor.
                    .accessibilityAddTraits(.isHeader)
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
            case .offline:
                Text("Your computer is offline. News from your Bots shows up once it’s back.")
                    .aidenType(.rowValue)
                    .foregroundStyle(palette.secondary)
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("home.digest.offline")
            case .partial:
                Text("Nothing new from the computers that answered. Pull down to try the others.")
                    .aidenType(.rowValue)
                    .foregroundStyle(palette.secondary)
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("home.digest.partial")
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

/// Where Home's Send can take the person once its chat exists: only while
/// they are still on Home, so a slow send never pulls them off what they
/// moved on to.
struct AidenHomeSendPlace {
    /// True while Home's root is on screen.
    var isOnHome: @MainActor () -> Bool
    var open: @MainActor (AidenHostObjectID) -> Void

    static let stays = AidenHomeSendPlace(isOnHome: { false }, open: { _ in })
}

/// What Home's composer holds, kept by the shell so the words survive the
/// layout rebuilding (a Duo folding or unfolding) and, saved on this device
/// like a chat's draft, a relaunch.
///
/// Send starts a chat at once: the words leave the field, a chat is made on
/// the machine the chip shows, and the chat sends them as soon as it can.
/// Nothing waits on the tap. Until the chat exists the words stay in the
/// saved draft, so a relaunch mid-send finds them back in the field. If no
/// chat can be made, the words come back quietly, ahead of anything typed
/// since, with the reason below the field.
@MainActor
@Observable
final class AidenHomeComposerModel {
    /// Where the draft is kept: a reserved place no paired machine or chat
    /// can name.
    static let draftInstanceId = "aiden.home"
    static let draftChatId = "composer"
    static let lastMachineKey = "aiden.home.lastMachine"
    /// The folder Home's composer last chose on each machine, by machine id.
    static let foldersKey = "aiden.home.folders"

    /// Where the app keeps Home's choices. A demo run keeps its own, so its
    /// picks never reach the person's real ones or the next run.
    static var appDefaults: UserDefaults {
#if DEBUG
        if AidenDemoScenario.requested(in: ProcessInfo.processInfo.arguments) != nil {
            return AidenDemoHosts.isolatedDefaults()
        }
#endif
        return .standard
    }

    let session = AidenComposerSession()
    /// "Starting a chat on Studio…" while sends are on their way.
    private(set) var status: String?
    /// Why the last Send made no chat, or that it made one the person can
    /// open, until they type or send again.
    private(set) var notice: String?
    /// A chat a Send made while the person was elsewhere: the notice opens it.
    private(set) var readyChat: AidenHostObjectID?
    /// Where a finished Send may take the person. Set by the shell.
    var place: AidenHomeSendPlace = .stays
    /// The folder chosen on each machine, by machine id; a machine missing
    /// here starts a Just chat. Kept on this device.
    private(set) var folders: [String: String] = [:]
    /// The next Send's chat starts in a new worktree of its folder. Off again
    /// once a Send takes it, since each worktree is its own.
    var startsInNewWorktree = false

    @ObservationIgnored private let store: AidenChatDraftStore
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let saveDelay: Duration
    @ObservationIgnored private var storeSession: AidenChatDraftStore.Session?
    @ObservationIgnored private var restoring: Task<Void, Never>?
    @ObservationIgnored private var saving: Task<Void, Never>?
    @ObservationIgnored private var sends: [UUID: Task<Void, Never>] = [:]
    /// The words of sends still on their way, oldest first. They stay in the
    /// saved draft until their chat exists.
    @ObservationIgnored private var inFlight: [(id: UUID, prompt: String)] = []
    /// The newest Send: only it may move the person to its chat.
    @ObservationIgnored private var latestSend: UUID?
    /// Bumped by every edit, so a restore that lands late never overwrites
    /// words typed meanwhile.
    @ObservationIgnored private var edits: UInt64 = 0
    /// Text this model put in the field itself, so the field's change
    /// callback doesn't take it for the person typing (which clears the notice).
    @ObservationIgnored private var ownWrite: String?
    /// The chip as Home last aimed it. A chip showing anything else was picked
    /// by hand, and is left alone.
    @ObservationIgnored private var aimed: (picker: ObjectIdentifier, machine: String?)?

    init(store: AidenChatDraftStore = .shared, defaults: UserDefaults? = nil, saveDelay: Duration = .milliseconds(250)) {
        let defaults = defaults ?? Self.appDefaults
        self.store = store
        self.defaults = defaults
        self.saveDelay = saveDelay
        folders = defaults.dictionary(forKey: Self.foldersKey) as? [String: String] ?? [:]
        restoring = Task { [weak self] in await self?.restore() }
    }

    /// The folder chosen on the machine: nil for Just chat.
    func folder(on instanceId: String?) -> String? {
        instanceId.flatMap { folders[$0] }
    }

    /// Chooses where the machine's next chat starts: a folder's id, or nil
    /// for Just chat. A new folder starts without a new worktree.
    func choose(folder workspaceId: String?, on instanceId: String) {
        guard folders[instanceId] != workspaceId else { return }
        folders[instanceId] = workspaceId
        startsInNewWorktree = false
        defaults.set(folders, forKey: Self.foldersKey)
    }

    /// The folder Send uses on the machine: the chosen one while the machine
    /// still lists it, otherwise Just chat.
    func sendFolder(on instanceId: String?, using flow: AidenNewWorkChatFlow) -> AidenWorkspace? {
        guard let id = folder(on: instanceId) else { return nil }
        return flow.homeFolders(on: instanceId).first { $0.id == id }
    }

    /// Finished once the saved draft, if any, is back in the field.
    func restored() async { await restoring?.value }

    /// Finished once the latest edit is saved.
    func saved() async { await saving?.value }

    /// The machine Home last started a chat on.
    var lastMachine: String? { defaults.string(forKey: Self.lastMachineKey) }

    /// How many sends are still on their way.
    var pendingSends: Int { sends.count }

    /// What the saved draft holds: the words of sends still on their way,
    /// then the field.
    private var durableText: String {
        inFlight.reversed().reduce(session.text) { current, send in
            AidenDraftSendReconciliation.failedDraft(submitted: send.prompt, current: current)
        }
    }

    private func restore() async {
        let session = await store.beginSession(instanceId: Self.draftInstanceId, chatId: Self.draftChatId)
        storeSession = session
        let editsBefore = edits
        guard let saved = await store.load(session: session), !saved.isEmpty,
              edits == editsBefore, session == storeSession, self.session.text.isEmpty else { return }
        write(saved)
    }

    /// The field changed. The person typing clears the notice; either way
    /// the draft is saved shortly.
    func textChanged() {
        let typed = ownWrite != session.text
        ownWrite = nil
        guard typed else { return }
        edits &+= 1
        if !session.text.isEmpty {
            notice = nil
            readyChat = nil
        }
        scheduleSave()
    }

    /// Puts text in the field on the model's own behalf.
    private func write(_ text: String) {
        ownWrite = text == session.text ? nil : text
        session.text = text
        edits &+= 1
        scheduleSave()
    }

    /// `immediately` skips the typing debounce: once a chat exists on the Mac
    /// its words must leave the saved draft at once, so a kill right after
    /// can't bring them back and start the same chat twice.
    private func scheduleSave(immediately: Bool = false) {
        let text = durableText
        saving?.cancel()
        let delay = immediately ? .zero : saveDelay
        saving = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            guard !Task.isCancelled, let self else { return }
            await self.restoring?.value
            guard !Task.isCancelled, let session = self.storeSession, self.durableText == text else { return }
            _ = try? await self.store.save(text, session: session)
        }
    }

    /// The machine Home's chip starts on: the last one Home used while it
    /// can still take a chat, otherwise the picker's own default. A machine
    /// picked by hand stays picked.
    func aim(_ picker: AidenNewWorkPicker) {
        let id = ObjectIdentifier(picker)
        let current = picker.target?.instanceId
        if let aimed, aimed.picker == id, aimed.machine != current, picker.canStart { return }
        let last = lastMachine.flatMap { id in picker.machines.first { $0.id == id && $0.canBePicked }?.id }
        if let last, current != last {
            picker.pick(last)
        } else if !picker.canStart {
            picker.startOver(preferring: last, offeringHidden: false)
        }
        aimed = (id, picker.target?.instanceId)
    }

    /// Send: hands the field's words to a new chat on exactly the machine the
    /// chip shows, and empties the field.
    func send(using flow: AidenNewWorkChatFlow) {
        let prompt = session.text
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let picker = flow.homePicker
        if picker.target == nil { aim(picker) }
        guard let target = picker.target else {
            notice = String(localized: "Pair a computer to start a chat.")
            return
        }
        notice = nil
        readyChat = nil
        let name = picker.pickedMachine?.label.name
        // Exactly what the chip shows: a folder the machine no longer lists
        // reads as Just chat there, and goes as one.
        let workspaceId = sendFolder(on: target.instanceId, using: flow)?.id
        let worktree = startsInNewWorktree && flow.homeOffersNewWorktree(in: workspaceId, on: target.instanceId)
        startsInNewWorktree = false
        let id = UUID()
        latestSend = id
        inFlight.append((id, prompt))
        write("")
        sends[id] = Task { [weak self] in
            let outcome = await flow.startChat(sending: prompt, on: target, in: workspaceId, inNewWorktree: worktree)
            self?.finish(id, prompt: prompt, target: target, outcome: outcome)
        }
        updateStatus(machineName: name)
    }

    /// Opens the chat a Send made while the person was elsewhere.
    func openReadyChat() {
        guard let readyChat else { return }
        self.readyChat = nil
        notice = nil
        place.open(readyChat)
    }

    private func finish(_ id: UUID, prompt: String, target: AidenNewWorkTarget, outcome: AidenHomeSendOutcome) {
        sends[id] = nil
        inFlight.removeAll { $0.id == id }
        let isLatest = latestSend == id
        if isLatest { latestSend = nil }
        switch outcome {
        case .started(let chat):
            defaults.set(target.instanceId, forKey: Self.lastMachineKey)
            scheduleSave(immediately: true)
            if isLatest, place.isOnHome() {
                place.open(chat)
            } else {
                readyChat = chat
                notice = String(localized: "Chat started. Tap to open it.")
            }
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
        readyChat = nil
        write(AidenDraftSendReconciliation.failedDraft(submitted: prompt, current: session.text))
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
    @Environment(\.aidenReduceMotion) private var reduceMotion
    /// The keyboard is up: the person has opened the composer.
    @State private var isComposing = false
    @State private var showsEnvironment = false

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
        // A container of its own, so the status and notice keep their own
        // identifiers instead of taking this one.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.composer")
        .animation(reduceMotion ? nil : .snappy(duration: 0.24), value: showsChips(picker))
        .onChange(of: model.session.text) { model.textChanged() }
        .onAppear { model.aim(picker) }
        .onChange(of: picker.machines(includingHidden: false).map(\.id)) { model.aim(picker) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            isComposing = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            isComposing = false
        }
        .sheet(isPresented: $showsEnvironment) {
            AidenHomeEnvironmentSheet(flow: flow, model: model, picker: picker)
        }
    }

    private var hasMachine: Bool { !flow.homePicker.machines(includingHidden: false).isEmpty }

    /// Where the chat runs shows once the person opens the composer, and stays
    /// while there's something to send or a place other than the default.
    private func showsChips(_ picker: AidenNewWorkPicker) -> Bool {
        guard hasMachine else { return false }
        return isComposing || showsEnvironment || model.session.hasContent
            || model.sendFolder(on: picker.target?.instanceId, using: flow) != nil
    }

    @ViewBuilder
    private func accessory(_ picker: AidenNewWorkPicker) -> some View {
        let line = model.notice ?? model.status
        let chips = showsChips(picker)
        if chips || picker.refusalMessage != nil || line != nil {
            VStack(alignment: .leading, spacing: AidenSpacing.xs) {
                if chips {
                    chipRow(picker)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                if let refusal = picker.refusalMessage {
                    Text(refusal)
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if model.readyChat != nil, let line {
                    Button(action: model.openReadyChat) {
                        Text(line)
                            .aidenType(.footnote)
                            .foregroundStyle(palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the chat.")
                    .accessibilityIdentifier("home.composer.ready")
                } else if let line {
                    Text(line)
                        .aidenType(.footnote)
                        .foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier(model.notice != nil ? "home.composer.notice" : "home.composer.status")
                }
            }
        }
    }

    private func chipRow(_ picker: AidenNewWorkPicker) -> some View {
        let instanceId = picker.target?.instanceId
        let folder = model.sendFolder(on: instanceId, using: flow)
        let offersWorktree = flow.homeOffersNewWorktree(in: folder?.id, on: instanceId)
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: AidenSpacing.s) {
                environmentChip(picker, folder: folder)
                if offersWorktree { worktreeChip }
            }
            VStack(alignment: .leading, spacing: 0) {
                environmentChip(picker, folder: folder)
                if offersWorktree { worktreeChip }
            }
        }
    }

    private func environmentChip(_ picker: AidenNewWorkPicker, folder: AidenWorkspace?) -> some View {
        let place = folder?.name ?? AidenHomeEnvironmentCopy.justChat
        let title = picker.showsPicker
            ? picker.pickedMachine.map { "\($0.label.name) · \(place)" } ?? place
            : place
        return Button { showsEnvironment = true } label: {
            AidenHomeChipLabel(
                systemImage: folder == nil ? "bubble.left" : "folder",
                title: title,
                isOn: false,
                showsDisclosure: true
            )
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(Text(AidenHomeEnvironmentCopy.title))
        .accessibilityValue(Text(title))
        .accessibilityHint(Text(picker.showsPicker
            ? "Chooses the computer and folder this chat starts in."
            : "Chooses the folder this chat starts in."))
        .accessibilityIdentifier("home.composer.environment")
    }

    private var worktreeChip: some View {
        @Bindable var model = model
        return Button { model.startsInNewWorktree.toggle() } label: {
            AidenHomeChipLabel(
                systemImage: model.startsInNewWorktree ? "checkmark.circle.fill" : "arrow.triangle.branch",
                title: AidenNewWorktreeCopy.toggle,
                isOn: model.startsInNewWorktree,
                showsDisclosure: false
            )
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(Text(AidenNewWorktreeCopy.toggle))
        .accessibilityValue(Text(model.startsInNewWorktree ? "On" : "Off"))
        .accessibilityAddTraits(model.startsInNewWorktree ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint(Text(AidenNewWorktreeCopy.hint))
        .accessibilityIdentifier("home.composer.worktree")
    }
}

enum AidenHomeEnvironmentCopy {
    static let title = String(localized: "Where it runs")
    static let justChat = String(localized: "Just chat")
    static let justChatDetail = String(localized: "Work without a folder")
}

/// A small filled capsule inside the composer: the composer is already glass,
/// so its chips sit on a soft fill rather than glass of their own.
struct AidenHomeChipLabel: View {
    let systemImage: String
    let title: String
    let isOn: Bool
    let showsDisclosure: Bool

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .foregroundStyle(isOn ? palette.accent : palette.secondary)
                .accessibilityHidden(true)
            Text(title)
                .lineLimit(1)
                .truncationMode(.middle)
            if showsDisclosure {
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .accessibilityHidden(true)
            }
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(palette.foreground)
        .padding(.horizontal, AidenSpacing.m)
        .frame(minHeight: 32)
        .background(Capsule().fill(isOn ? palette.accent.opacity(0.14) : palette.foreground.opacity(0.06)))
    }
}

/// Where Home's next chat runs: the computer, when there's more than one, the
/// folder (or Just chat), and whether it starts in a new worktree.
struct AidenHomeEnvironmentSheet: View {
    let flow: AidenNewWorkChatFlow
    let model: AidenHomeComposerModel
    let picker: AidenNewWorkPicker

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette

    private var instanceId: String? { picker.target?.instanceId }

    var body: some View {
        @Bindable var model = model
        let folders = flow.homeFolders(on: instanceId)
        let chosen = model.sendFolder(on: instanceId, using: flow)
        NavigationStack {
            List {
                if picker.showsPicker {
                    Section("Computer") {
                        ForEach(picker.machines) { machine in
                            machineRow(machine)
                        }
                    }
                }
                Section("Folder") {
                    placeRow(
                        title: AidenHomeEnvironmentCopy.justChat,
                        detail: AidenHomeEnvironmentCopy.justChatDetail,
                        systemImage: "bubble.left",
                        isChosen: chosen == nil,
                        identifier: "home.environment.justChat"
                    ) { choose(nil) }
                    ForEach(folders) { folder in
                        placeRow(
                            title: folder.name,
                            detail: detail(for: folder),
                            systemImage: folder.hasFolder ? "folder" : "tray",
                            isChosen: chosen?.id == folder.id,
                            identifier: "home.environment.folder.\(folder.id)"
                        ) { choose(folder.id) }
                    }
                }
                if flow.homeOffersNewWorktree(in: chosen?.id, on: instanceId) {
                    Section {
                        Toggle(AidenNewWorktreeCopy.toggle, isOn: $model.startsInNewWorktree)
                            .tint(palette.accent)
                            .accessibilityIdentifier("home.environment.worktree")
                    } footer: {
                        Text(AidenNewWorktreeCopy.hint)
                    }
                }
            }
            .navigationTitle(AidenHomeEnvironmentCopy.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("home.environment.done")
                }
            }
            .task(id: instanceId) {
                if let instanceId { await flow.refreshHomeFolders(on: instanceId) }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func choose(_ workspaceId: String?) {
        guard let instanceId else { return }
        model.choose(folder: workspaceId, on: instanceId)
    }

    private func detail(for folder: AidenWorkspace) -> String? {
        switch (folder.repositoryName, folder.branchName) {
        case let (repository?, branch?) where repository != folder.name: "\(repository) · \(branch)"
        case let (_, branch?): branch
        case let (repository?, nil) where repository != folder.name: repository
        default: nil
        }
    }

    private func machineRow(_ machine: AidenNewWorkMachine) -> some View {
        let isPicked = picker.target?.instanceId == machine.id
        return Button { picker.pick(machine.id) } label: {
            HStack(spacing: AidenSpacing.m) {
                AidenMachineChip(label: machine.label)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(machine.label.name)
                        .foregroundStyle(palette.foreground)
                    if let detail = machine.detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                    }
                }
                Spacer(minLength: AidenSpacing.s)
                if isPicked {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(palette.accent)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!machine.canBePicked)
        .opacity(machine.canBePicked ? 1 : 0.5)
        .accessibilityAddTraits(isPicked ? .isSelected : [])
        .accessibilityIdentifier("home.environment.machine.\(machine.id)")
    }

    private func placeRow(
        title: String,
        detail: String?,
        systemImage: String,
        isChosen: Bool,
        identifier: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: AidenSpacing.m) {
                Image(systemName: systemImage)
                    .foregroundStyle(palette.secondary)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .foregroundStyle(palette.foreground)
                        .lineLimit(1)
                    if let detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: AidenSpacing.s)
                if isChosen {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(palette.accent)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isChosen ? .isSelected : [])
        .accessibilityIdentifier(identifier)
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
