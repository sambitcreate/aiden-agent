#if DEBUG
import SwiftUI

enum AidenBotPrototypeState: String, CaseIterable, Identifiable {
    case ready
    case empty
    case loading
    case error
    case offline
    case degraded
    case archived
    case noResults = "no-results"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .ready: "Ready"
        case .empty: "Empty"
        case .loading: "Loading"
        case .error: "Error"
        case .offline: "Offline"
        case .degraded: "Degraded"
        case .archived: "Archived"
        case .noResults: "No Results"
        }
    }
}

enum AidenBotPrototypeScreen: String, CaseIterable, Identifiable {
    case inbox
    case profile
    case editor
    case access
    case chat

    var id: String { rawValue }
}

struct AidenBotFirstPrototypeConfiguration {
    let theme: AidenThemePresetID
    let state: AidenBotPrototypeState
    let screen: AidenBotPrototypeScreen
    let noticeAcknowledged: Bool

    static var current: AidenBotFirstPrototypeConfiguration? {
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.contains("--bot-first-prototype") else { return nil }
        return AidenBotFirstPrototypeConfiguration(
            theme: value(after: "--bot-first-prototype-theme", in: arguments)
                .flatMap(AidenThemePresetID.init(rawValue:)) ?? .aiden,
            state: value(after: "--bot-first-prototype-state", in: arguments)
                .flatMap(AidenBotPrototypeState.init(rawValue:)) ?? .ready,
            screen: value(after: "--bot-first-prototype-screen", in: arguments)
                .flatMap(AidenBotPrototypeScreen.init(rawValue:)) ?? .inbox,
            noticeAcknowledged: value(after: "--bot-first-prototype-notice", in: arguments)
                == "acknowledged"
        )
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }
}

struct AidenBotFirstPrototypeLaunchView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion
    @Environment(\.aidenReduceMotion) private var aidenReduceMotion
    @State private var theme: AidenThemePresetID
    @State private var fixtureState: AidenBotPrototypeState
    @State private var noticeAcknowledged: Bool
    let screen: AidenBotPrototypeScreen

    init(configuration: AidenBotFirstPrototypeConfiguration) {
        screen = configuration.screen
        _theme = State(initialValue: configuration.theme)
        _fixtureState = State(initialValue: configuration.state)
        _noticeAcknowledged = State(initialValue: configuration.noticeAcknowledged)
    }

    var body: some View {
        AidenBotFirstPrototypeView(
            theme: $theme,
            fixtureState: $fixtureState,
            noticeAcknowledged: $noticeAcknowledged,
            initialScreen: screen
        )
        .environment(\.aidenPalette, AidenThemeCatalog.palette(preset: theme, scheme: colorScheme))
        .environment(\.aidenReduceMotion, aidenReduceMotion || accessibilityReduceMotion)
    }
}

private enum AidenBotPrototypeRoute: Hashable {
    case chat(String)
    case newChat(botID: String, sequence: Int)
    case profile(String)
}

private enum AidenBotPrototypeProductArea: String, Hashable {
    case bots = "Bots"
    case workspaces = "Workspaces"
}

private enum AidenBotPrototypeAccess: String, CaseIterable, Identifiable, Hashable {
    case full
    case custom

    var id: String { rawValue }
    var title: String { self == .full ? "Full Access" : "Custom" }
}

private enum AidenBotPrototypeChatAccess: String, CaseIterable, Identifiable, Hashable {
    case inheritBot = "Inherit Bot"
    case customize = "Customize"
    var id: String { rawValue }
}

private enum AidenBotPrototypeFileAccess: String, CaseIterable, Identifiable, Hashable {
    case fullMac = "Full Mac"
    case botFolderOnly = "Bot folder only"
    case chosenLocations = "Chosen locations"
    case off = "Off"

    var id: String { rawValue }

    private var ceilingRank: Int {
        switch self {
        case .off: 0
        case .botFolderOnly: 1
        case .chosenLocations: 2
        case .fullMac: 3
        }
    }

    func limited(to ceiling: Self) -> Self {
        ceilingRank <= ceiling.ceilingRank ? self : ceiling
    }
}

private enum AidenBotPrototypeCatalogMode: String, CaseIterable, Identifiable, Hashable {
    case all
    case selected
    case off

    var id: String { rawValue }
}

private struct AidenBotPrototypeCapabilities: Hashable {
    static let allChosenLocationIDs: Set<String> = ["desktop", "documents", "downloads"]
    static let allConnectionIDs: Set<String> = ["calendar", "github", "notion"]
    static let allSkillIDs: Set<String> = ["research-brief", "writing-coach", "file-organizer"]

    var files: AidenBotPrototypeFileAccess
    var chosenLocationIDs: Set<String>
    var shell: Bool
    var web: Bool
    var connectionMode: AidenBotPrototypeCatalogMode
    var connectionIDs: Set<String>
    var skillMode: AidenBotPrototypeCatalogMode
    var skillIDs: Set<String>

    static let all = AidenBotPrototypeCapabilities(
        files: .fullMac,
        chosenLocationIDs: allChosenLocationIDs,
        shell: true,
        web: true,
        connectionMode: .all,
        connectionIDs: allConnectionIDs,
        skillMode: .all,
        skillIDs: allSkillIDs
    )

    static let customFixture = AidenBotPrototypeCapabilities(
        files: .botFolderOnly,
        chosenLocationIDs: ["documents"],
        shell: false,
        web: true,
        connectionMode: .selected,
        connectionIDs: ["calendar", "notion"],
        skillMode: .selected,
        skillIDs: ["research-brief", "writing-coach"]
    )

    func intersecting(_ ceiling: AidenBotPrototypeCapabilities) -> AidenBotPrototypeCapabilities {
        let limitedConnectionIDs = connectionIDs.intersection(ceiling.allowedConnectionIDs)
        let limitedSkillIDs = skillIDs.intersection(ceiling.allowedSkillIDs)
        let limitedLocationIDs = chosenLocationIDs.intersection(ceiling.allowedChosenLocationIDs)
        let limitedFiles = files.limited(to: ceiling.files)
        return .init(
            files: limitedFiles == .chosenLocations && limitedLocationIDs.isEmpty
                ? .botFolderOnly
                : limitedFiles,
            chosenLocationIDs: limitedLocationIDs,
            shell: shell && ceiling.shell,
            web: web && ceiling.web,
            connectionMode: Self.intersectedMode(
                requested: connectionMode,
                ceiling: ceiling.connectionMode,
                retainedIDs: limitedConnectionIDs
            ),
            connectionIDs: limitedConnectionIDs,
            skillMode: Self.intersectedMode(
                requested: skillMode,
                ceiling: ceiling.skillMode,
                retainedIDs: limitedSkillIDs
            ),
            skillIDs: limitedSkillIDs
        )
    }

    var allowedConnectionIDs: Set<String> {
        switch connectionMode {
        case .all: Self.allConnectionIDs
        case .selected: connectionIDs
        case .off: []
        }
    }

    var allowedChosenLocationIDs: Set<String> {
        switch files {
        case .fullMac: Self.allChosenLocationIDs
        case .chosenLocations: chosenLocationIDs
        case .botFolderOnly, .off: []
        }
    }

    var allowedSkillIDs: Set<String> {
        switch skillMode {
        case .all: Self.allSkillIDs
        case .selected: skillIDs
        case .off: []
        }
    }

    private static func intersectedMode(
        requested: AidenBotPrototypeCatalogMode,
        ceiling: AidenBotPrototypeCatalogMode,
        retainedIDs: Set<String>
    ) -> AidenBotPrototypeCatalogMode {
        if requested == .off || ceiling == .off { return .off }
        if requested == .all, ceiling == .all { return .all }
        return retainedIDs.isEmpty ? .off : .selected
    }
}

private struct AidenBotPrototypeBotAccessPolicy: Hashable {
    var mode: AidenBotPrototypeAccess
    var capabilities: AidenBotPrototypeCapabilities

    static func fixture(mode: AidenBotPrototypeAccess) -> AidenBotPrototypeBotAccessPolicy {
        .init(
            mode: mode,
            capabilities: mode == .full ? .all : .customFixture
        )
    }

    var ceiling: AidenBotPrototypeCapabilities {
        mode == .full ? .all : capabilities
    }
}

private struct AidenBotPrototypeChatAccessPolicy: Hashable {
    var mode: AidenBotPrototypeChatAccess
    var capabilities: AidenBotPrototypeCapabilities

    static func inheriting(_ botPolicy: AidenBotPrototypeBotAccessPolicy) -> AidenBotPrototypeChatAccessPolicy {
        .init(mode: .inheritBot, capabilities: botPolicy.ceiling)
    }

    func intersecting(_ botPolicy: AidenBotPrototypeBotAccessPolicy) -> AidenBotPrototypeChatAccessPolicy {
        guard mode == .customize else { return .inheriting(botPolicy) }
        return .init(mode: .customize, capabilities: capabilities.intersecting(botPolicy.ceiling))
    }
}

private struct AidenBotPrototypeChatAccessKey: Hashable {
    let botID: String
    let chatID: String
}

private struct AidenBotPrototypeBot: Identifiable, Hashable {
    let id: String
    let name: String
    let summary: String
    let symbol: String
    let tintIndex: Int
    let favorite: Bool
    let access: AidenBotPrototypeAccess
    let connections: Int
    let skills: Int
}

private struct AidenBotPrototypeRecent: Identifiable, Hashable {
    let id: String
    let botID: String
    let title: String
    let preview: String
    let time: String
    let activity: AidenBotPrototypeActivity?
}

private enum AidenBotPrototypeActivity: String, Hashable {
    case responding
    case approvalRequired
    case failed

    var label: String {
        switch self {
        case .responding: "Responding now"
        case .approvalRequired: "Needs approval"
        case .failed: "Last response failed"
        }
    }
}

private enum AidenBotPrototypeFixtures {
    static let bots: [AidenBotPrototypeBot] = [
        .init(id: "scout", name: "Scout", summary: "Finds the signal in a busy week", symbol: "binoculars.fill", tintIndex: 0, favorite: true, access: .full, connections: 4, skills: 7),
        .init(id: "studio", name: "Studio", summary: "Turns rough ideas into finished work", symbol: "paintbrush.pointed.fill", tintIndex: 1, favorite: true, access: .full, connections: 3, skills: 5),
        .init(id: "keeper", name: "Keeper", summary: "Remembers decisions and loose ends", symbol: "bookmark.fill", tintIndex: 2, favorite: true, access: .custom, connections: 2, skills: 6),
        .init(id: "atlas", name: "Atlas", summary: "Plans trips, errands, and logistics", symbol: "map.fill", tintIndex: 3, favorite: true, access: .full, connections: 5, skills: 4),
        .init(id: "muse", name: "Muse", summary: "A patient creative collaborator", symbol: "wand.and.stars", tintIndex: 4, favorite: false, access: .custom, connections: 1, skills: 3),
    ]

    static let recents: [AidenBotPrototypeRecent] = [
        .init(id: "week", botID: "scout", title: "Plan the week around my calendar", preview: "I found three quiet focus blocks and moved the errands…", time: "7:02 PM", activity: .responding),
        .init(id: "launch", botID: "studio", title: "Launch story for Aiden", preview: "Here is the tighter opening, with the product moment first.", time: "6:19 PM", activity: nil),
        .init(id: "notes", botID: "keeper", title: "What did we decide about onboarding?", preview: "The final decision was a single notice before Full Access…", time: "3:16 PM", activity: .approvalRequired),
        .init(id: "tokyo", botID: "atlas", title: "Tokyo plan for October", preview: "I saved a calm five-day route with two flexible mornings.", time: "Yesterday", activity: nil),
        .init(id: "voice", botID: "muse", title: "Give this essay a warmer voice", preview: "This version keeps your argument but lets it breathe.", time: "Mon", activity: .failed),
    ]

    static func bot(id: String) -> AidenBotPrototypeBot {
        bots.first { $0.id == id } ?? bots[0]
    }

    static func chat(id: String) -> AidenChat {
        let recent = recents.first { $0.id == id } ?? recents[0]
        let bot = bot(id: recent.botID)
        let base = Date(timeIntervalSince1970: 1_787_410_800)
        return AidenChat(
            id: "prototype-\(recent.id)",
            workspaceId: "prototype-managed-home-\(bot.id)",
            botId: bot.id,
            title: bot.name,
            providerId: nil,
            modelId: nil,
            messages: [
                AidenChatMessage(
                    id: "prototype-user-\(recent.id)",
                    role: .user,
                    text: recent.title,
                    createdAt: base
                ),
                AidenChatMessage(
                    id: "prototype-assistant-\(recent.id)",
                    role: .assistant,
                    text: recent.preview.replacingOccurrences(of: "…", with: ". I’ll keep the working files together here and tell you before anything needs a decision."),
                    createdAt: base.addingTimeInterval(42)
                ),
            ],
            createdAt: base,
            updatedAt: base.addingTimeInterval(42),
            revision: "prototype-1"
        )
    }

    static func newChat(bot: AidenBotPrototypeBot, sequence: Int) -> AidenChat {
        let base = Date(timeIntervalSince1970: 1_787_500_000 + Double(sequence))
        let id = "prototype-new-\(bot.id)-\(sequence)"
        return AidenChat(
            id: id,
            workspaceId: "prototype-managed-home-\(bot.id)",
            botId: bot.id,
            title: bot.name,
            providerId: nil,
            modelId: nil,
            messages: [
                AidenChatMessage(
                    id: "\(id)-greeting",
                    role: .assistant,
                    text: "Hi — what should we work on?",
                    createdAt: base
                ),
            ],
            createdAt: base,
            updatedAt: base,
            revision: "prototype-new-\(sequence)"
        )
    }
}

private struct AidenBotFirstPrototypeView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.aidenPalette) private var palette
    @Binding var theme: AidenThemePresetID
    @Binding var fixtureState: AidenBotPrototypeState
    @Binding var noticeAcknowledged: Bool
    @State private var productArea: AidenBotPrototypeProductArea = .bots
    @State private var canonicalRoute: AidenBotPrototypeRoute?
    @State private var compactPath: [AidenBotPrototypeRoute] = []
    @State private var selectedRoute: AidenBotPrototypeRoute?
    @State private var workspacePath: [String] = []
    @State private var newBotDefaultAccess: AidenBotPrototypeAccess = .full
    @State private var newConversationSequence = 0
    @State private var botAccessPolicies: [String: AidenBotPrototypeBotAccessPolicy] = Dictionary(
        uniqueKeysWithValues: AidenBotPrototypeFixtures.bots.map {
            ($0.id, AidenBotPrototypeBotAccessPolicy.fixture(mode: $0.access))
        }
    )
    @State private var chatAccessPolicies: [AidenBotPrototypeChatAccessKey: AidenBotPrototypeChatAccessPolicy] = [:]
    @State private var archivedBotIDs: Set<String> = []
    @State private var shouldOpenCustomEditorAfterNotice = false
    @State private var isPresentingPostNoticeEditor = false
    let initialScreen: AidenBotPrototypeScreen

    var body: some View {
        screenContent
            .tint(palette.accent)
            .fullScreenCover(
                isPresented: Binding(
                    get: { !noticeAcknowledged },
                    set: { _ in }
                ),
                onDismiss: presentCustomEditorAfterNoticeIfNeeded
            ) {
                AidenBotPrototypeFullAccessNoticeView(
                    onContinue: {
                        newBotDefaultAccess = .full
                        shouldOpenCustomEditorAfterNotice = false
                        noticeAcknowledged = true
                    },
                    onCustomize: {
                        newBotDefaultAccess = .custom
                        shouldOpenCustomEditorAfterNotice = true
                        noticeAcknowledged = true
                    }
                )
                .interactiveDismissDisabled()
            }
            .sheet(isPresented: $isPresentingPostNoticeEditor) {
                AidenBotPrototypeEditorView(bot: nil, initialAccess: .custom)
            }
            .onChange(of: compactPath) { _, path in
                let route = path.last
                canonicalRoute = route
                if selectedRoute != route { selectedRoute = route }
            }
            .onChange(of: selectedRoute) { _, route in
                canonicalRoute = route
                let path = route.map { [$0] } ?? []
                if compactPath != path { compactPath = path }
            }
            .onChange(of: horizontalSizeClass) { _, sizeClass in
                reconcileRoute(for: sizeClass)
            }
    }

    @ViewBuilder
    private var screenContent: some View {
        if initialScreen == .inbox {
            ZStack {
                adaptiveInbox
                    .opacity(productArea == .bots ? 1 : 0)
                    .allowsHitTesting(productArea == .bots)
                    .accessibilityHidden(productArea != .bots)
                    .zIndex(productArea == .bots ? 1 : 0)

                AidenBotPrototypeWorkspacesView(
                    path: $workspacePath,
                    theme: $theme,
                    fixtureState: $fixtureState,
                    onSelectBots: { productArea = .bots }
                )
                .opacity(productArea == .workspaces ? 1 : 0)
                .allowsHitTesting(productArea == .workspaces)
                .accessibilityHidden(productArea != .workspaces)
                .zIndex(productArea == .workspaces ? 1 : 0)
            }
        } else {
            directScreen
        }
    }

    @ViewBuilder
    private var adaptiveInbox: some View {
        Group {
            if horizontalSizeClass == .regular {
                NavigationSplitView {
                    inbox(onOpen: { open($0) })
                        .navigationSplitViewColumnWidth(min: 330, ideal: 390, max: 460)
                } detail: {
                    NavigationStack {
                        if let selectedRoute {
                            destination(selectedRoute)
                        } else {
                            AidenBotPrototypeWelcomeView()
                        }
                    }
                }
            } else {
                NavigationStack(path: $compactPath) {
                    inbox(onOpen: { open($0) })
                        .navigationDestination(for: AidenBotPrototypeRoute.self) { route in
                            destination(route)
                        }
                }
            }
        }
    }

    @ViewBuilder
    private var directScreen: some View {
        switch initialScreen {
        case .inbox:
            EmptyView()
        case .profile:
            NavigationStack(path: $compactPath) {
                AidenBotPrototypeProfileView(
                    bot: resolvedBot(id: "scout"),
                    accessPolicy: botPolicy(for: "scout"),
                    allowsMutations: fixtureState != .offline,
                    isArchived: isBotArchived("scout"),
                    onNewConversation: {
                        startNewConversation(botID: "scout", forceCompact: true)
                    },
                    onArchiveChanged: { setBotArchived($0, botID: "scout") },
                    onAccessChanged: { updateBotPolicy($0, for: "scout") }
                )
                .navigationDestination(for: AidenBotPrototypeRoute.self) { route in
                    destination(route)
                }
            }
        case .editor:
            AidenBotPrototypeEditorView(bot: nil, initialAccess: newBotDefaultAccess)
        case .access:
            AidenBotPrototypeAccessView(
                bot: resolvedBot(id: "scout"),
                scope: .bot,
                botPolicy: botPolicy(for: "scout"),
                onBotPolicyChanged: { updateBotPolicy($0, for: "scout") }
            )
        case .chat:
            NavigationStack {
                chatDestination(
                    botID: "scout",
                    chat: AidenBotPrototypeFixtures.chat(id: "week")
                )
            }
        }
    }

    private func inbox(onOpen: @escaping (AidenBotPrototypeRoute) -> Void) -> some View {
        AidenBotPrototypeInboxView(
            theme: $theme,
            fixtureState: $fixtureState,
            defaultNewBotAccess: $newBotDefaultAccess,
            archivedBotIDs: $archivedBotIDs,
            onSelectWorkspaces: { productArea = .workspaces },
            onNewConversation: { startNewConversation(botID: $0) },
            onOpen: onOpen
        )
    }

    @ViewBuilder
    private func destination(_ route: AidenBotPrototypeRoute) -> some View {
        switch route {
        case .chat(let id):
            let recent = AidenBotPrototypeFixtures.recents.first { $0.id == id } ?? AidenBotPrototypeFixtures.recents[0]
            chatDestination(
                botID: recent.botID,
                chat: AidenBotPrototypeFixtures.chat(id: id)
            )
        case .newChat(let botID, let sequence):
            let bot = resolvedBot(id: botID)
            chatDestination(botID: botID, chat: AidenBotPrototypeFixtures.newChat(bot: bot, sequence: sequence))
        case .profile(let id):
            AidenBotPrototypeProfileView(
                bot: resolvedBot(id: id),
                accessPolicy: botPolicy(for: id),
                allowsMutations: fixtureState != .offline,
                isArchived: isBotArchived(id),
                onNewConversation: { startNewConversation(botID: id) },
                onArchiveChanged: { setBotArchived($0, botID: id) },
                onAccessChanged: { updateBotPolicy($0, for: id) }
            )
        }
    }

    @ViewBuilder
    private func chatDestination(botID: String, chat: AidenChat) -> some View {
        let bot = resolvedBot(id: botID)
        let policy = botPolicy(for: botID)
        let key = AidenBotPrototypeChatAccessKey(botID: botID, chatID: chat.id)
        let chatPolicy = (chatAccessPolicies[key] ?? .inheriting(policy)).intersecting(policy)
        AidenBotPrototypeChatDestination(
            bot: bot,
            chat: chat,
            botPolicy: policy,
            chatPolicy: chatPolicy,
            allowsAccessChanges: fixtureState != .offline,
            onChatPolicyChanged: { updated in
                if updated.mode == .inheritBot {
                    chatAccessPolicies.removeValue(forKey: key)
                } else {
                    chatAccessPolicies[key] = updated.intersecting(botPolicy(for: botID))
                }
            }
        )
    }

    private func open(_ route: AidenBotPrototypeRoute, forceCompact: Bool = false) {
        canonicalRoute = route
        if horizontalSizeClass == .regular, !forceCompact {
            selectedRoute = route
        } else {
            compactPath = [route]
        }
    }

    private func startNewConversation(botID: String, forceCompact: Bool = false) {
        guard !isBotArchived(botID) else { return }
        newConversationSequence += 1
        open(
            .newChat(botID: botID, sequence: newConversationSequence),
            forceCompact: forceCompact
        )
    }

    private func botPolicy(for botID: String) -> AidenBotPrototypeBotAccessPolicy {
        botAccessPolicies[botID]
            ?? .fixture(mode: AidenBotPrototypeFixtures.bot(id: botID).access)
    }

    private func resolvedBot(id: String) -> AidenBotPrototypeBot {
        let bot = AidenBotPrototypeFixtures.bot(id: id)
        return .init(
            id: bot.id,
            name: bot.name,
            summary: bot.summary,
            symbol: bot.symbol,
            tintIndex: bot.tintIndex,
            favorite: bot.favorite,
            access: botPolicy(for: id).mode,
            connections: bot.connections,
            skills: bot.skills
        )
    }

    private func updateBotPolicy(_ policy: AidenBotPrototypeBotAccessPolicy, for botID: String) {
        botAccessPolicies[botID] = policy
        let affectedKeys = chatAccessPolicies.keys.filter { $0.botID == botID }
        for key in affectedKeys {
            guard let chatPolicy = chatAccessPolicies[key] else { continue }
            if chatPolicy.mode == .inheritBot {
                chatAccessPolicies.removeValue(forKey: key)
            } else {
                chatAccessPolicies[key] = chatPolicy.intersecting(policy)
            }
        }
    }

    private func isBotArchived(_ botID: String) -> Bool {
        archivedBotIDs.contains(botID)
            || (fixtureState == .archived
                && AidenBotPrototypeFixtures.bots.suffix(2).contains { $0.id == botID })
    }

    private func setBotArchived(_ archived: Bool, botID: String) {
        if archived {
            archivedBotIDs.insert(botID)
        } else {
            archivedBotIDs.remove(botID)
            if fixtureState == .archived { fixtureState = .ready }
        }
    }

    private func presentCustomEditorAfterNoticeIfNeeded() {
        guard shouldOpenCustomEditorAfterNotice else { return }
        shouldOpenCustomEditorAfterNotice = false
        isPresentingPostNoticeEditor = true
    }

    private func reconcileRoute(for sizeClass: UserInterfaceSizeClass?) {
        if sizeClass == .regular {
            if selectedRoute != canonicalRoute { selectedRoute = canonicalRoute }
        } else {
            let path = canonicalRoute.map { [$0] } ?? []
            if compactPath != path { compactPath = path }
        }
    }
}

private struct AidenBotPrototypeFullAccessNoticeView: View {
    @Environment(\.aidenPalette) private var palette
    let onContinue: () -> Void
    let onCustomize: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Image(systemName: "checkmark.shield.fill")
                        .font(.system(size: 42, weight: .semibold))
                        .foregroundStyle(palette.accent)
                        .frame(width: 78, height: 78)
                        .background(palette.accent.opacity(0.12), in: Circle())

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Bots can use your Mac")
                            .font(.largeTitle.bold())
                        Text("By default, bots can use files your Mac lets Aiden access, run commands, and use connections and skills enabled in Aiden. Each bot starts in a private Aiden folder, but Full Access can work elsewhere when your request needs it. Capabilities you enable later in Aiden are also available to Full Access bots. You can choose Custom Access now or change access in Bot Settings anytime.")
                            .font(.body)
                            .foregroundStyle(palette.secondary)
                    }

                    Label(
                        "Your existing bots will keep the capabilities they already use. Aiden prepared a private working folder for each.",
                        systemImage: "folder.badge.gearshape"
                    )
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .padding(16)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .padding(24)
                .frame(maxWidth: 620, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(palette.canvas.ignoresSafeArea())
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 10) {
                    Button("Continue with Full Access", action: onContinue)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .frame(maxWidth: .infinity)
                    Button("Customize first", action: onCustomize)
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .frame(maxWidth: .infinity)
                }
                .padding(16)
                .background(.ultraThinMaterial)
            }
            .navigationTitle("Bot Access")
            .navigationBarTitleDisplayMode(.inline)
        }
        .accessibilityIdentifier("bot-full-access-v1")
    }
}

private struct AidenBotPrototypeWorkspacesView: View {
    @Environment(\.aidenPalette) private var palette
    @Binding var path: [String]
    @Binding var theme: AidenThemePresetID
    @Binding var fixtureState: AidenBotPrototypeState
    let onSelectBots: () -> Void

    private let workspaces = [
        (id: "aiden", name: "Aiden", detail: "Full access · 6 conversations"),
        (id: "launch", name: "Launch", detail: "Selected folder · 3 conversations"),
        (id: "personal", name: "Personal", detail: "Selected folder · 2 conversations"),
    ]

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    ForEach(workspaces, id: \.id) { workspace in
                        NavigationLink(value: workspace.id) {
                            HStack(spacing: 12) {
                                Image(systemName: "folder.fill")
                                    .foregroundStyle(palette.accent)
                                    .frame(width: 36, height: 36)
                                    .background(palette.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(workspace.name).font(.body.weight(.semibold))
                                    Text(workspace.detail).font(.caption).foregroundStyle(palette.secondary)
                                }
                            }
                            .padding(.vertical, 5)
                        }
                    }
                } header: {
                    Text("Workspaces")
                } footer: {
                    Text("This fixture root stays mounted separately from Bots and never connects to a Mac.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { id in
                let workspace = workspaces.first { $0.id == id } ?? workspaces[0]
                ContentUnavailableView {
                    Label(workspace.name, systemImage: "folder.fill")
                } description: {
                    Text("Fixture conversations and Files would appear here.")
                }
                .background(palette.canvas.ignoresSafeArea())
            }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Menu {
                        Button(action: onSelectBots) { Text("Bots") }
                        Button { } label: { Label("Workspaces", systemImage: "checkmark") }
                    } label: {
                        HStack(spacing: 7) {
                            AidenSidebarLogo(size: 22, color: palette.foreground)
                            Text("Workspaces").font(.headline)
                            Image(systemName: "chevron.down")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(palette.secondary)
                        }
                        .foregroundStyle(palette.foreground)
                    }
                    .accessibilityLabel("Product area, Workspaces")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Theme", selection: $theme) {
                            ForEach(AidenThemePresetID.allCases) { preset in Text(preset.title).tag(preset) }
                        }
                        Picker("Fixture state", selection: $fixtureState) {
                            ForEach(AidenBotPrototypeState.allCases) { state in Text(state.title).tag(state) }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Prototype controls")
                }
            }
        }
    }
}

private struct AidenBotPrototypeInboxView: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion
    @Binding var theme: AidenThemePresetID
    @Binding var fixtureState: AidenBotPrototypeState
    @Binding var defaultNewBotAccess: AidenBotPrototypeAccess
    @Binding var archivedBotIDs: Set<String>
    @State private var query = ""
    @State private var isEditing = false
    @State private var isPresentingEditor = false
    @State private var isChoosingChatBot = false
    @State private var favoriteOrder = AidenBotPrototypeFixtures.bots.filter(\.favorite).map(\.id)
    @State private var deletedRecentIDs: Set<String> = []
    @State private var selectedRecentIDs: Set<String> = []
    @State private var isConfirmingMultiChatDelete = false
    @State private var pendingBotArchive: AidenBotPrototypeBot?
    let onSelectWorkspaces: () -> Void
    let onNewConversation: (String) -> Void
    let onOpen: (AidenBotPrototypeRoute) -> Void

    private var mutationsEnabled: Bool { fixtureState != .offline }
    private var effectiveReduceMotion: Bool { reduceMotion || accessibilityReduceMotion }

    private var effectiveArchivedBotIDs: Set<String> {
        guard fixtureState == .archived else { return archivedBotIDs }
        return archivedBotIDs.union(AidenBotPrototypeFixtures.bots.suffix(2).map(\.id))
    }

    private var availableBots: [AidenBotPrototypeBot] {
        AidenBotPrototypeFixtures.bots.filter { !effectiveArchivedBotIDs.contains($0.id) }
    }

    private var archivedBots: [AidenBotPrototypeBot] {
        AidenBotPrototypeFixtures.bots.filter { effectiveArchivedBotIDs.contains($0.id) }
    }

    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredBotResults: [AidenBotPrototypeBot] {
        if normalizedQuery.isEmpty {
            return favoriteOrder.compactMap { id in availableBots.first { $0.id == id } }
        }
        return availableBots.filter { bot in
            [bot.name, bot.summary].contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
        }
    }

    private var filteredRecents: [AidenBotPrototypeRecent] {
        guard fixtureState != .noResults else { return [] }
        let active = AidenBotPrototypeFixtures.recents.filter { !deletedRecentIDs.contains($0.id) }
        guard !normalizedQuery.isEmpty else { return active }
        return active.filter { recent in
            let bot = AidenBotPrototypeFixtures.bot(id: recent.botID)
            return [bot.name, bot.summary, recent.title, recent.preview].contains {
                $0.localizedCaseInsensitiveContains(normalizedQuery)
            }
        }
    }

    private var hasTypedNoResults: Bool {
        !normalizedQuery.isEmpty && filteredBotResults.isEmpty && filteredRecents.isEmpty
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                statusBanner
                inboxContent
            }
            .padding(.bottom, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.canvas.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            bottomDock
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { inboxToolbar }
        .sheet(isPresented: $isPresentingEditor) {
            AidenBotPrototypeEditorView(bot: nil, initialAccess: defaultNewBotAccess)
        }
        .confirmationDialog("New Conversation", isPresented: $isChoosingChatBot, titleVisibility: .visible) {
            ForEach(availableBots) { bot in
                Button(bot.name) {
                    onNewConversation(bot.id)
                }
            }
        } message: {
            Text("Choose a bot to start with.")
        }
        .confirmationDialog("Delete selected conversations?", isPresented: $isConfirmingMultiChatDelete, titleVisibility: .visible) {
            Button("Delete \(selectedRecentIDs.count) Conversations", role: .destructive) {
                guard mutationsEnabled else { return }
                deletedRecentIDs.formUnion(selectedRecentIDs)
                selectedRecentIDs.removeAll()
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This removes the selected chats from this fixture inbox. The bot stays available.")
        }
        .confirmationDialog("Archive this bot?", isPresented: Binding(
            get: { pendingBotArchive != nil },
            set: { if !$0 { pendingBotArchive = nil } }
        ), titleVisibility: .visible) {
            Button("Archive Bot", role: .destructive) {
                guard let pendingBotArchive, mutationsEnabled else { return }
                archivedBotIDs.insert(pendingBotArchive.id)
                favoriteOrder.removeAll { $0 == pendingBotArchive.id }
                self.pendingBotArchive = nil
            }
            Button("Cancel", role: .cancel) { pendingBotArchive = nil }
        } message: {
            Text(pendingBotArchive.map { "\($0.name) will become read-only until restored." } ?? "")
        }
        .onChange(of: fixtureState) { _, state in
            if state == .noResults {
                query = "zz-no-match"
            }
            if state == .offline {
                isEditing = false
                isPresentingEditor = false
                isChoosingChatBot = false
                selectedRecentIDs.removeAll()
                pendingBotArchive = nil
            }
        }
    }

    @ToolbarContentBuilder
    private var inboxToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button(isEditing ? "Done" : "Edit") {
                let nextValue = !isEditing
                if effectiveReduceMotion {
                    isEditing = nextValue
                } else {
                    withAnimation(.easeInOut(duration: 0.18)) { isEditing = nextValue }
                }
                if !nextValue { selectedRecentIDs.removeAll() }
            }
                .fontWeight(.medium)
                .disabled(!mutationsEnabled)
        }
        ToolbarItem(placement: .principal) {
            Menu {
                Button { } label: { Label("Bots", systemImage: "checkmark") }
                Button(action: onSelectWorkspaces) { Text("Workspaces") }
            } label: {
                HStack(spacing: 7) {
                    AidenSidebarLogo(size: 22, color: palette.foreground)
                    Text("Bots")
                        .font(.headline)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(palette.secondary)
                }
                .foregroundStyle(palette.foreground)
            }
            .accessibilityLabel("Product area, Bots")
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { isPresentingEditor = true } label: {
                Image(systemName: "plus")
            }
            .disabled(!mutationsEnabled)
            .accessibilityLabel("New bot")

            Menu {
                Picker("Theme", selection: $theme) {
                    ForEach(AidenThemePresetID.allCases) { preset in Text(preset.title).tag(preset) }
                }
                Picker("Fixture state", selection: $fixtureState) {
                    ForEach(AidenBotPrototypeState.allCases) { state in Text(state.title).tag(state) }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel("Prototype controls")
        }
    }

    private var bottomDock: some View {
        HStack(spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(palette.foreground)
                    .accessibilityHidden(true)

                TextField("Search", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .accessibilityLabel("Search bots and chats")

                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(palette.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 17)
            .frame(minHeight: 54)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay {
                Capsule()
                    .stroke(palette.foreground.opacity(0.12), lineWidth: 0.5)
            }

            Button { isChoosingChatBot = true } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(palette.foreground)
                    .frame(width: 54, height: 54)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!mutationsEnabled || availableBots.isEmpty)
            .background(.ultraThinMaterial, in: Circle())
            .overlay {
                Circle()
                    .stroke(palette.foreground.opacity(0.12), lineWidth: 0.5)
            }
            .accessibilityLabel("New conversation")
            .accessibilityHint("Choose a bot to start a new chat.")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    @ViewBuilder
    private var statusBanner: some View {
        switch fixtureState {
        case .offline:
            AidenBotPrototypeBanner(
                symbol: "wifi.slash",
                title: "Offline — showing saved bots.",
                detail: "Reconnect to create, edit, or send.",
                tone: palette.secondary
            )
        case .degraded:
            AidenBotPrototypeBanner(
                symbol: "exclamationmark.triangle",
                title: "Some selected access is unavailable.",
                detail: "Review it on your Mac.",
                tone: palette.warning
            )
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var inboxContent: some View {
        if hasTypedNoResults || fixtureState == .noResults {
            AidenBotPrototypeEmptyView(
                symbol: "magnifyingglass",
                title: "No matches",
                detail: "No bots or conversations match your search.",
                actionTitle: "Clear Search",
                action: {
                    query = ""
                    fixtureState = .ready
                }
            )
            .padding(.top, 70)
        } else {
            switch fixtureState {
            case .empty:
                AidenBotPrototypeEmptyView(
                    symbol: "bubble.left.and.sparkles",
                    title: "Make your first bot",
                    detail: "Create your first bot to give a familiar helper its own conversations and tools.",
                    actionTitle: "New Bot",
                    action: { isPresentingEditor = true }
                )
                .disabled(!mutationsEnabled)
                .padding(.top, 86)
            case .loading:
                normalContent(
                    bots: AidenBotPrototypeFixtures.bots.filter(\.favorite),
                    recents: AidenBotPrototypeFixtures.recents.filter { !deletedRecentIDs.contains($0.id) }
                )
                .redacted(reason: .placeholder)
                .allowsHitTesting(false)
                .overlay(alignment: .top) {
                    ProgressView("Loading bots…")
                        .padding(.top, 10)
                }
            case .error:
                AidenBotPrototypeEmptyView(
                    symbol: "arrow.clockwise.circle",
                    title: "Bots didn’t load",
                    detail: "The paired Mac did not return a complete Bot list.",
                    actionTitle: "Retry",
                    action: { fixtureState = .ready }
                )
                .padding(.top, 70)
            case .archived:
                archivedContent
            default:
                normalContent(bots: filteredBotResults, recents: filteredRecents)
            }
        }
    }

    private func normalContent(
        bots: [AidenBotPrototypeBot],
        recents: [AidenBotPrototypeRecent]
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !bots.isEmpty {
                Text(normalizedQuery.isEmpty ? "Favorites" : "Bots")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 18) {
                        ForEach(bots) { bot in
                            VStack(spacing: 7) {
                                Button { onOpen(.profile(bot.id)) } label: {
                                    VStack(spacing: 8) {
                                        AidenBotPrototypeAvatar(bot: bot, size: 72)
                                        Text(bot.name)
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(palette.foreground)
                                            .lineLimit(1)
                                    }
                                    .frame(width: 82)
                                }
                                .buttonStyle(.plain)
                                .disabled(isEditing)
                                .accessibilityHint("Opens \(bot.name)’s profile")

                                if isEditing {
                                    HStack(spacing: 2) {
                                        if favoriteOrder.contains(bot.id) {
                                            Button { moveFavorite(bot.id, by: -1) } label: {
                                                Image(systemName: "chevron.left")
                                                    .frame(width: 28, height: 28)
                                            }
                                            .disabled(favoriteOrder.first == bot.id)
                                            Button { moveFavorite(bot.id, by: 1) } label: {
                                                Image(systemName: "chevron.right")
                                                    .frame(width: 28, height: 28)
                                            }
                                            .disabled(favoriteOrder.last == bot.id)
                                        }
                                        Menu {
                                            if favoriteOrder.contains(bot.id) {
                                                Button { favoriteOrder.removeAll { $0 == bot.id } } label: {
                                                    Label("Remove Favorite", systemImage: "star.slash")
                                                }
                                            } else {
                                                Button { favoriteOrder.append(bot.id) } label: {
                                                    Label("Add to Favorites", systemImage: "star")
                                                }
                                            }
                                            Button(role: .destructive) { pendingBotArchive = bot } label: {
                                                Label("Archive Bot", systemImage: "archivebox")
                                            }
                                        } label: {
                                            Image(systemName: "ellipsis")
                                                .frame(width: 28, height: 28)
                                        }
                                    }
                                    .font(.caption.weight(.semibold))
                                    .buttonStyle(.borderless)
                                    .accessibilityElement(children: .contain)
                                    .accessibilityLabel("Edit \(bot.name)")
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .padding(.bottom, 22)
            }

            HStack {
                Text("Recent")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                Spacer()
                Text("\(recents.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(palette.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 4)

            if isEditing {
                HStack(spacing: 12) {
                    Text("\(selectedRecentIDs.count) selected")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Button(selectedRecentIDs.count == recents.count ? "Clear" : "Select All") {
                        if selectedRecentIDs.count == recents.count {
                            selectedRecentIDs.removeAll()
                        } else {
                            selectedRecentIDs = Set(recents.map(\.id))
                        }
                    }
                    .disabled(recents.isEmpty)
                    Button("Delete", role: .destructive) {
                        isConfirmingMultiChatDelete = true
                    }
                    .disabled(selectedRecentIDs.isEmpty || !mutationsEnabled)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(palette.raised)
            }

            ForEach(recents) { recent in
                AidenBotPrototypeRecentRow(
                    recent: recent,
                    bot: AidenBotPrototypeFixtures.bot(id: recent.botID),
                    editing: isEditing,
                    selected: selectedRecentIDs.contains(recent.id),
                    canEdit: mutationsEnabled,
                    onOpen: { onOpen(.chat(recent.id)) },
                    onProfile: { onOpen(.profile(recent.botID)) },
                    onToggleSelection: {
                        if selectedRecentIDs.contains(recent.id) {
                            selectedRecentIDs.remove(recent.id)
                        } else {
                            selectedRecentIDs.insert(recent.id)
                        }
                    },
                    onArchiveBot: { pendingBotArchive = AidenBotPrototypeFixtures.bot(id: recent.botID) }
                )
            }
        }
    }

    private var archivedContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Archived Bots")
                .font(.title3.weight(.semibold))
                .padding(.horizontal, 16)
            Text("Archived bots are read-only until restored.")
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            ForEach(archivedBots) { bot in
                HStack(spacing: 12) {
                    AidenBotPrototypeAvatar(bot: bot, size: 48)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(bot.name).font(.body.weight(.semibold))
                        Text(bot.summary).font(.caption).foregroundStyle(palette.secondary).lineLimit(1)
                    }
                    Spacer()
                    Button("Restore") {
                        archivedBotIDs.remove(bot.id)
                        if bot.favorite, !favoriteOrder.contains(bot.id) { favoriteOrder.append(bot.id) }
                        if fixtureState == .archived { fixtureState = .ready }
                    }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(!mutationsEnabled)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
        }
        .padding(.top, 8)
    }

    private func moveFavorite(_ botID: String, by offset: Int) {
        guard let index = favoriteOrder.firstIndex(of: botID) else { return }
        let destination = index + offset
        guard favoriteOrder.indices.contains(destination) else { return }
        let update = { favoriteOrder.swapAt(index, destination) }
        if effectiveReduceMotion {
            update()
        } else {
            withAnimation(.easeInOut(duration: 0.18), update)
        }
    }
}

private struct AidenBotPrototypeRecentRow: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let recent: AidenBotPrototypeRecent
    let bot: AidenBotPrototypeBot
    let editing: Bool
    let selected: Bool
    let canEdit: Bool
    let onOpen: () -> Void
    let onProfile: () -> Void
    let onToggleSelection: () -> Void
    let onArchiveBot: () -> Void

    var body: some View {
        HStack(spacing: dynamicTypeSize.isAccessibilitySize ? 8 : 12) {
            if editing {
                Button(action: onToggleSelection) {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(selected ? palette.accent : palette.secondary)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .disabled(!canEdit)
                .accessibilityLabel(selected ? "Deselect \(recent.title)" : "Select \(recent.title)")
            }

            Button(action: onProfile) {
                AidenBotPrototypeAvatar(bot: bot, size: 48)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.plain)
            .disabled(editing)
            .accessibilityLabel("View \(bot.name) profile")

            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(bot.name)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(palette.foreground)
                        Spacer(minLength: 8)
                        Text(recent.time)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(palette.secondary)
                    }
                    Text(recent.title)
                        .font(.body)
                        .foregroundStyle(palette.foreground)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                    Text(recent.preview)
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 2)
                    if let activity = recent.activity {
                        Label(activity.label, systemImage: activitySymbol(activity))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(activityTone(activity))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(editing)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(bot.name), \(recent.title). \(recent.preview)")
            .accessibilityValue(recent.activity?.label ?? "No current activity")
            .contextMenu {
                Button(action: onProfile) { Label("View \(bot.name)", systemImage: "person.crop.circle") }
                Button(role: .destructive, action: onArchiveBot) {
                    Label("Archive \(bot.name)", systemImage: "archivebox")
                }
                .disabled(!canEdit)
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.secondary.opacity(0.65))
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 16 : 12)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(palette.secondary.opacity(0.13))
                .frame(height: 0.5)
                .padding(.leading, editing ? 112 : 76)
        }
        .overlay(alignment: .leading) {
            if let activity = recent.activity {
                Circle()
                    .fill(activityTone(activity))
                    .frame(width: 7, height: 7)
                    .offset(x: 5)
                    .accessibilityHidden(true)
            }
        }
    }

    private func activityTone(_ activity: AidenBotPrototypeActivity) -> Color {
        switch activity {
        case .responding: palette.accent
        case .approvalRequired: palette.warning
        case .failed: palette.danger
        }
    }

    private func activitySymbol(_ activity: AidenBotPrototypeActivity) -> String {
        switch activity {
        case .responding: "waveform"
        case .approvalRequired: "checkmark.shield"
        case .failed: "exclamationmark.circle"
        }
    }
}

private struct AidenBotPrototypeAvatar: View {
    @Environment(\.aidenPalette) private var palette
    let bot: AidenBotPrototypeBot
    let size: CGFloat

    private var tint: Color {
        switch bot.tintIndex % 5 {
        case 1: palette.success
        case 2: palette.warning
        case 3: palette.accent.opacity(0.72)
        case 4: palette.danger.opacity(0.78)
        default: palette.accent
        }
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(tint.opacity(0.16))
            Circle()
                .strokeBorder(tint.opacity(0.2), lineWidth: 1)
            Image(systemName: bot.symbol)
                .font(.system(size: size * 0.36, weight: .medium, design: .rounded))
                .foregroundStyle(tint)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct AidenBotPrototypeProfileView: View {
    @Environment(\.aidenPalette) private var palette
    @State private var isEditing = false
    @State private var isShowingAccess = false
    @State private var isConfirmingArchive = false
    let bot: AidenBotPrototypeBot
    let accessPolicy: AidenBotPrototypeBotAccessPolicy
    let allowsMutations: Bool
    let isArchived: Bool
    let onNewConversation: () -> Void
    let onArchiveChanged: (Bool) -> Void
    let onAccessChanged: (AidenBotPrototypeBotAccessPolicy) -> Void

    private var allowsBotChanges: Bool { allowsMutations && !isArchived }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 12) {
                    AidenBotPrototypeAvatar(bot: bot, size: 112)
                    Text(bot.name)
                        .font(.largeTitle.weight(.bold))
                    Text(bot.summary)
                        .font(.body)
                        .foregroundStyle(palette.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 380)
                    Label(
                        isArchived ? "Archived bots are read-only until restored." : "Ready on your Mac",
                        systemImage: isArchived ? "archivebox.fill" : "checkmark.circle.fill"
                    )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(isArchived ? palette.secondary : palette.success)
                }

                VStack(spacing: 12) {
                    Button(action: onNewConversation) {
                        Label("New Conversation", systemImage: "square.and.pencil")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!allowsBotChanges)

                    HStack(spacing: 12) {
                        profileAction("Edit", symbol: "pencil") { isEditing = true }
                        profileAction(accessPolicy.mode.title, symbol: "slider.horizontal.3") { isShowingAccess = true }
                    }
                }

                VStack(spacing: 0) {
                    profileMetric("Access", value: accessSummary, symbol: "slider.horizontal.3")
                    Divider().padding(.leading, 50)
                    profileMetric("Files", value: accessPolicy.ceiling.files.rawValue, symbol: "folder")
                    Divider().padding(.leading, 50)
                    profileMetric(
                        "Connections",
                        value: catalogSummary(
                            mode: accessPolicy.ceiling.connectionMode,
                            selectedCount: accessPolicy.ceiling.allowedConnectionIDs.count,
                            allTitle: "All enabled"
                        ),
                        symbol: "link"
                    )
                    Divider().padding(.leading, 50)
                    profileMetric(
                        "Skills",
                        value: catalogSummary(
                            mode: accessPolicy.ceiling.skillMode,
                            selectedCount: accessPolicy.ceiling.allowedSkillIDs.count,
                            allTitle: "All available"
                        ),
                        symbol: "bolt.fill"
                    )
                }
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            .padding(24)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .background(palette.canvas.ignoresSafeArea())
        .navigationTitle(bot.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if isArchived {
                        Button { onArchiveChanged(false) } label: {
                            Label("Restore Bot", systemImage: "arrow.uturn.backward")
                        }
                    } else {
                        Button(role: .destructive) { isConfirmingArchive = true } label: {
                            Label("Archive Bot", systemImage: "archivebox")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(!allowsMutations)
                .accessibilityLabel("Bot actions")
            }
        }
        .sheet(isPresented: $isEditing) {
            AidenBotPrototypeEditorView(
                bot: bot,
                initialPolicy: accessPolicy,
                onSavePolicy: onAccessChanged
            )
        }
        .sheet(isPresented: $isShowingAccess) {
            AidenBotPrototypeAccessView(
                bot: bot,
                scope: .bot,
                botPolicy: accessPolicy,
                onBotPolicyChanged: onAccessChanged
            )
        }
        .confirmationDialog("Archive this bot?", isPresented: $isConfirmingArchive, titleVisibility: .visible) {
            Button("Archive Bot", role: .destructive) { onArchiveChanged(true) }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("\(bot.name) will be read-only and cannot start new conversations until restored.")
        }
    }

    private var accessSummary: String {
        guard accessPolicy.mode == .custom else { return "Full Access" }
        let enabled = accessPolicy.capabilities
        if !enabled.shell { return "Custom · Shell off" }
        return "Custom"
    }

    private func catalogSummary(
        mode: AidenBotPrototypeCatalogMode,
        selectedCount: Int,
        allTitle: String
    ) -> String {
        switch mode {
        case .all: allTitle
        case .selected: "\(selectedCount) selected"
        case .off: "Off"
        }
    }

    private func profileAction(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
        }
        .buttonStyle(.bordered)
        .disabled(!allowsBotChanges)
    }

    private func profileMetric(_ title: String, value: String, symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .frame(width: 26)
                .foregroundStyle(palette.accent)
            Text(title)
            Spacer()
            Text(value)
                .foregroundStyle(palette.secondary)
        }
        .padding(16)
    }
}

private enum AidenBotPrototypeLookStyle: String, CaseIterable, Identifiable {
    case aiden = "Aiden"
    case warm = "Warm"
    case focused = "Focused"

    var id: String { rawValue }

    var symbols: [String] {
        switch self {
        case .aiden: ["face.smiling.inverse", "sparkles", "wand.and.stars"]
        case .warm: ["sun.max.fill", "heart.fill", "cup.and.saucer.fill"]
        case .focused: ["scope", "binoculars.fill", "checkmark.seal.fill"]
        }
    }

    var tintIndex: Int {
        switch self {
        case .aiden: 0
        case .warm: 2
        case .focused: 3
        }
    }
}

private struct AidenBotPrototypeEditorView: View {
    private struct DraftSnapshot: Equatable {
        let name: String
        let summary: String
        let greeting: String
        let instructions: String
        let accessPolicy: AidenBotPrototypeBotAccessPolicy
        let lookStyle: AidenBotPrototypeLookStyle
        let symbol: String
        let tintIndex: Int
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var name: String
    @State private var summary: String
    @State private var greeting: String
    @State private var instructions: String
    @State private var accessPolicy: AidenBotPrototypeBotAccessPolicy
    @State private var lookStyle: AidenBotPrototypeLookStyle
    @State private var symbol: String
    @State private var tintIndex: Int
    @State private var shuffleIndex = 0
    @State private var isShowingAccess = false
    @State private var isShowingImagePlaygroundFallback = false
    @State private var isShowingDiscardConfirmation = false
    private let bot: AidenBotPrototypeBot
    private let initialSnapshot: DraftSnapshot
    private let onSavePolicy: ((AidenBotPrototypeBotAccessPolicy) -> Void)?

    init(
        bot: AidenBotPrototypeBot?,
        initialAccess: AidenBotPrototypeAccess = .full,
        initialPolicy: AidenBotPrototypeBotAccessPolicy? = nil,
        onSavePolicy: ((AidenBotPrototypeBotAccessPolicy) -> Void)? = nil
    ) {
        let resolvedPolicy = initialPolicy
            ?? .fixture(mode: bot?.access ?? initialAccess)
        let value = bot ?? .init(
            id: "new", name: "", summary: "", symbol: "face.smiling.inverse", tintIndex: 0,
            favorite: true, access: resolvedPolicy.mode, connections: 0, skills: 0
        )
        let initialGreeting = bot == nil ? "Hi — what should we work on?" : "What should we pick up next?"
        let initialInstructions = bot == nil ? "" : "Be thoughtful, direct, and keep ordinary work in this bot’s home."
        let initialLook = AidenBotPrototypeLookStyle.aiden
        self.bot = value
        _name = State(initialValue: value.name)
        _summary = State(initialValue: value.summary)
        _greeting = State(initialValue: initialGreeting)
        _instructions = State(initialValue: initialInstructions)
        _accessPolicy = State(initialValue: resolvedPolicy)
        _lookStyle = State(initialValue: initialLook)
        _symbol = State(initialValue: value.symbol)
        _tintIndex = State(initialValue: value.tintIndex)
        initialSnapshot = DraftSnapshot(
            name: value.name,
            summary: value.summary,
            greeting: initialGreeting,
            instructions: initialInstructions,
            accessPolicy: resolvedPolicy,
            lookStyle: initialLook,
            symbol: value.symbol,
            tintIndex: value.tintIndex
        )
        self.onSavePolicy = onSavePolicy
    }

    private var previewBot: AidenBotPrototypeBot {
        .init(
            id: bot.id,
            name: name,
            summary: summary,
            symbol: symbol,
            tintIndex: tintIndex,
            favorite: bot.favorite,
            access: accessPolicy.mode,
            connections: bot.connections,
            skills: bot.skills
        )
    }

    private var currentSnapshot: DraftSnapshot {
        .init(
            name: name,
            summary: summary,
            greeting: greeting,
            instructions: instructions,
            accessPolicy: accessPolicy,
            lookStyle: lookStyle,
            symbol: symbol,
            tintIndex: tintIndex
        )
    }

    private var isDirty: Bool { currentSnapshot != initialSnapshot }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Spacer()
                        VStack(spacing: 10) {
                            AidenBotPrototypeAvatar(bot: previewBot, size: 104)
                            Text(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Your bot" : name)
                                .font(.subheadline.weight(.semibold))
                        }
                        Spacer()
                    }
                    .listRowBackground(Color.clear)
                }

                Section("Identity") {
                    TextField("Name", text: $name)
                    TextField("One-line role", text: $summary, axis: .vertical)
                        .lineLimit(2...3)
                    TextField("Opening greeting", text: $greeting, axis: .vertical)
                        .lineLimit(2...4)
                }

                Section {
                    TextField("Instructions", text: $instructions, axis: .vertical)
                        .lineLimit(5...10)
                } header: {
                    Text("How this bot helps")
                } footer: {
                    Text("Write this in everyday language. Aiden adds the private operating details on your Mac.")
                }

                Section {
                    Button { isShowingAccess = true } label: {
                        HStack {
                            Label(accessPolicy.mode.title, systemImage: "slider.horizontal.3")
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.secondary)
                        }
                    }
                    .foregroundStyle(palette.foreground)
                } header: {
                    Text("Access")
                } footer: {
                    Text("Choose what this bot may use. A conversation can reduce access further, but never add to it.")
                }

                Section("Look") {
                    Picker("Style", selection: $lookStyle) {
                        ForEach(AidenBotPrototypeLookStyle.allCases) { style in
                            Text(style.rawValue).tag(style)
                        }
                    }
                    .pickerStyle(.segmented)

                    Button { shuffleLook() } label: {
                        Label("Shuffle Look", systemImage: "shuffle")
                    }

                    Button { isShowingImagePlaygroundFallback = true } label: {
                        Label("Create with Apple Intelligence", systemImage: "apple.intelligence")
                    }

                    Label("Image Playground isn’t available on this iPhone", systemImage: "iphone.slash")
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                }

                Section("Review") {
                    LabeledContent("Bot", value: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Name needed" : name)
                    LabeledContent("Look", value: lookStyle.rawValue)
                    LabeledContent("Access", value: accessPolicy.mode.title)
                    Text(accessPolicy.mode == .full
                         ? "Can use your Mac, shell, enabled connections, and skills."
                         : "Uses only the access you select. This chat can reduce it further.")
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                    if !greeting.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Label("Opening greeting included", systemImage: "bubble.left")
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas)
            .navigationTitle(bot.id == "new" ? "New Bot" : "Edit Bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSavePolicy?(accessPolicy)
                        dismiss()
                    }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .sheet(isPresented: $isShowingAccess) {
                AidenBotPrototypeAccessView(
                    bot: previewBot,
                    scope: .bot,
                    botPolicy: accessPolicy,
                    onBotPolicyChanged: { accessPolicy = $0 }
                )
            }
            .alert("Image Playground isn’t available on this iPhone", isPresented: $isShowingImagePlaygroundFallback) {
                Button("Keep Aiden Look", role: .cancel) { }
            } message: {
                Text("Use Style and Shuffle Look instead. No image request was sent.")
            }
            .confirmationDialog("Discard changes?", isPresented: $isShowingDiscardConfirmation) {
                Button("Discard Changes", role: .destructive) { dismiss() }
                Button("Keep Editing", role: .cancel) { }
            } message: {
                Text("Your changes have not been saved.")
            }
            .interactiveDismissDisabled(isDirty)
            .onChange(of: lookStyle) { _, style in
                symbol = style.symbols[0]
                tintIndex = style.tintIndex
                shuffleIndex = 0
            }
        }
    }

    private func shuffleLook() {
        shuffleIndex += 1
        symbol = lookStyle.symbols[shuffleIndex % lookStyle.symbols.count]
        tintIndex = (lookStyle.tintIndex + shuffleIndex) % 5
    }

    private func cancel() {
        if isDirty {
            isShowingDiscardConfirmation = true
        } else {
            dismiss()
        }
    }
}

private enum AidenBotPrototypeAccessScope: String, CaseIterable, Identifiable {
    case bot = "Bot Access"
    case chat = "Chat Access"
    var id: String { rawValue }
}

private struct AidenBotPrototypeAccessView: View {
    private enum Capability {
        case shell
        case web
    }

    private enum CatalogKind {
        case connections
        case skills
    }

    private struct CatalogItem: Identifiable {
        let id: String
        let title: String
        let detail: String
    }

    private static let locationCatalog = [
        CatalogItem(id: "documents", title: "Documents", detail: "Chosen on your Mac"),
        CatalogItem(id: "desktop", title: "Desktop", detail: "Chosen on your Mac"),
        CatalogItem(id: "downloads", title: "Downloads", detail: "Chosen on your Mac"),
    ]
    private static let connectionCatalog = [
        CatalogItem(id: "calendar", title: "Calendar", detail: "Events and availability"),
        CatalogItem(id: "github", title: "GitHub", detail: "Repositories and issues"),
        CatalogItem(id: "notion", title: "Notion", detail: "Pages and databases"),
    ]
    private static let skillCatalog = [
        CatalogItem(id: "research-brief", title: "Research Brief", detail: "Turns sources into a concise brief"),
        CatalogItem(id: "writing-coach", title: "Writing Coach", detail: "Improves structure and voice"),
        CatalogItem(id: "file-organizer", title: "File Organizer", detail: "Keeps project files orderly"),
    ]

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var access: AidenBotPrototypeAccess
    @State private var chatAccess: AidenBotPrototypeChatAccess
    @State private var files: AidenBotPrototypeFileAccess
    @State private var chosenLocationIDs: Set<String>
    @State private var shell: Bool
    @State private var web: Bool
    @State private var connectionMode: AidenBotPrototypeCatalogMode
    @State private var connectionIDs: Set<String>
    @State private var skillMode: AidenBotPrototypeCatalogMode
    @State private var skillIDs: Set<String>
    let bot: AidenBotPrototypeBot
    let scope: AidenBotPrototypeAccessScope
    let botPolicy: AidenBotPrototypeBotAccessPolicy
    let onBotPolicyChanged: ((AidenBotPrototypeBotAccessPolicy) -> Void)?
    let onChatPolicyChanged: ((AidenBotPrototypeChatAccessPolicy) -> Void)?

    init(
        bot: AidenBotPrototypeBot,
        scope: AidenBotPrototypeAccessScope,
        botPolicy: AidenBotPrototypeBotAccessPolicy? = nil,
        chatPolicy: AidenBotPrototypeChatAccessPolicy? = nil,
        onBotPolicyChanged: ((AidenBotPrototypeBotAccessPolicy) -> Void)? = nil,
        onChatPolicyChanged: ((AidenBotPrototypeChatAccessPolicy) -> Void)? = nil
    ) {
        self.bot = bot
        self.scope = scope
        let resolvedBotPolicy = botPolicy ?? .fixture(mode: bot.access)
        let resolvedChatPolicy = (chatPolicy ?? .inheriting(resolvedBotPolicy))
            .intersecting(resolvedBotPolicy)
        self.botPolicy = resolvedBotPolicy
        self.onBotPolicyChanged = onBotPolicyChanged
        self.onChatPolicyChanged = onChatPolicyChanged
        let capabilities = scope == .bot
            ? resolvedBotPolicy.capabilities
            : resolvedChatPolicy.capabilities
        _access = State(initialValue: resolvedBotPolicy.mode)
        _chatAccess = State(initialValue: resolvedChatPolicy.mode)
        _files = State(initialValue: capabilities.files)
        _chosenLocationIDs = State(initialValue: capabilities.chosenLocationIDs)
        _shell = State(initialValue: capabilities.shell)
        _web = State(initialValue: capabilities.web)
        _connectionMode = State(initialValue: capabilities.connectionMode)
        _connectionIDs = State(initialValue: capabilities.connectionIDs)
        _skillMode = State(initialValue: capabilities.skillMode)
        _skillIDs = State(initialValue: capabilities.skillIDs)
    }

    private var showsCustomCapabilities: Bool {
        scope == .bot ? access == .custom : chatAccess == .customize
    }

    var body: some View {
        NavigationStack {
            Form {
                if scope == .bot {
                    Section("Bot access") {
                        Picker("Bot access", selection: $access) {
                            ForEach(AidenBotPrototypeAccess.allCases) { option in
                                Text(option.title).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                } else {
                    Section("This chat") {
                        Picker("This chat", selection: $chatAccess) {
                            ForEach(AidenBotPrototypeChatAccess.allCases) { option in
                                Text(option.rawValue).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }

                if showsCustomCapabilities {
                    Section("Mac files") {
                        Picker("Files", selection: $files) {
                            ForEach(AidenBotPrototypeFileAccess.allCases) { option in
                                Text(option.rawValue)
                                    .tag(option)
                                    .disabled(!fileScopeAllowed(option))
                            }
                        }
                        if files == .chosenLocations {
                            ForEach(Self.locationCatalog) { location in
                                catalogToggle(
                                    location,
                                    selection: $chosenLocationIDs,
                                    allowed: locationAllowed(location.id)
                                )
                            }
                        }
                    }

                    Section("Other abilities") {
                        capabilityToggle("Shell", symbol: "terminal", isOn: $shell, capability: .shell)
                        capabilityToggle("Web", symbol: "globe", isOn: $web, capability: .web)
                    }

                    Section {
                        Picker("Connections", selection: $connectionMode) {
                            ForEach(AidenBotPrototypeCatalogMode.allCases) { mode in
                                Text(connectionTitle(mode))
                                    .tag(mode)
                                    .disabled(!catalogModeAllowed(mode, kind: .connections))
                            }
                        }
                        if connectionMode == .selected {
                            ForEach(Self.connectionCatalog) { connection in
                                catalogToggle(
                                    connection,
                                    selection: $connectionIDs,
                                    allowed: catalogItemAllowed(connection.id, kind: .connections)
                                )
                            }
                        }
                    } header: {
                        Text("Connections")
                    } footer: {
                        Text("Choose external apps and services already configured in Aiden. Some connections are powered by MCP; account details stay on your Mac.")
                    }

                    Section {
                        Picker("Skills", selection: $skillMode) {
                            ForEach(AidenBotPrototypeCatalogMode.allCases) { mode in
                                Text(skillTitle(mode))
                                    .tag(mode)
                                    .disabled(!catalogModeAllowed(mode, kind: .skills))
                            }
                        }
                        if skillMode == .selected {
                            ForEach(Self.skillCatalog) { skill in
                                catalogToggle(
                                    skill,
                                    selection: $skillIDs,
                                    allowed: catalogItemAllowed(skill.id, kind: .skills)
                                )
                            }
                        }
                    } header: {
                        Text("Skills")
                    } footer: {
                        Text(scope == .chat
                             ? "This chat can turn access off or choose from what \(bot.name) already allows."
                             : "Select the instructions and workflows this bot may use.")
                    }
                } else {
                    Section("Summary") {
                        if scope == .bot {
                            Label("Full Access", systemImage: "checkmark.shield.fill")
                                .foregroundStyle(palette.accent)
                            Text("Can use your Mac, shell, enabled connections, and skills.")
                                .font(.subheadline)
                                .foregroundStyle(palette.secondary)
                        } else {
                            Label("Inherits \(bot.name)’s \(botPolicy.mode.title)", systemImage: "arrow.turn.down.right")
                            Text(botPolicy.mode == .full
                                 ? "This chat uses the bot’s Full Access. Choose Customize to reduce it for this conversation."
                                 : "This chat uses only the capabilities allowed by the bot’s Custom Access.")
                                .font(.subheadline)
                                .foregroundStyle(palette.secondary)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas)
            .navigationTitle(scope.rawValue)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        if scope == .bot {
                            onBotPolicyChanged?(.init(mode: access, capabilities: selectedCapabilities))
                        } else {
                            let policy = chatAccess == .inheritBot
                                ? AidenBotPrototypeChatAccessPolicy.inheriting(botPolicy)
                                : AidenBotPrototypeChatAccessPolicy(
                                    mode: .customize,
                                    capabilities: selectedCapabilities
                                )
                                .intersecting(botPolicy)
                            onChatPolicyChanged?(policy)
                        }
                        dismiss()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func capabilityToggle(
        _ title: String,
        symbol: String,
        isOn: Binding<Bool>,
        capability: Capability
    ) -> some View {
        let allowed = scope == .bot || botAllows(capability)
        Toggle(isOn: isOn) {
            HStack {
                Label(title, systemImage: symbol)
                if !allowed {
                    Spacer()
                    Text("Off in Bot")
                        .font(.caption2)
                        .foregroundStyle(palette.secondary)
                }
            }
        }
        .disabled(!allowed)
    }

    private func botAllows(_ capability: Capability) -> Bool {
        let ceiling = botPolicy.ceiling
        switch capability {
        case .shell: return ceiling.shell
        case .web: return ceiling.web
        }
    }

    private func fileScopeAllowed(_ option: AidenBotPrototypeFileAccess) -> Bool {
        scope == .bot || option.limited(to: botPolicy.ceiling.files) == option
    }

    private func locationAllowed(_ id: String) -> Bool {
        scope == .bot || botPolicy.ceiling.allowedChosenLocationIDs.contains(id)
    }

    private func catalogModeAllowed(
        _ mode: AidenBotPrototypeCatalogMode,
        kind: CatalogKind
    ) -> Bool {
        guard scope == .chat else { return true }
        let ceilingMode = kind == .connections
            ? botPolicy.ceiling.connectionMode
            : botPolicy.ceiling.skillMode
        let allowedIDs = kind == .connections
            ? botPolicy.ceiling.allowedConnectionIDs
            : botPolicy.ceiling.allowedSkillIDs
        switch mode {
        case .all: return ceilingMode == .all
        case .selected: return !allowedIDs.isEmpty
        case .off: return true
        }
    }

    private func catalogItemAllowed(_ id: String, kind: CatalogKind) -> Bool {
        guard scope == .chat else { return true }
        switch kind {
        case .connections: return botPolicy.ceiling.allowedConnectionIDs.contains(id)
        case .skills: return botPolicy.ceiling.allowedSkillIDs.contains(id)
        }
    }

    @ViewBuilder
    private func catalogToggle(
        _ item: CatalogItem,
        selection: Binding<Set<String>>,
        allowed: Bool
    ) -> some View {
        Toggle(isOn: Binding(
            get: { selection.wrappedValue.contains(item.id) },
            set: { selected in
                if selected {
                    selection.wrappedValue.insert(item.id)
                } else {
                    selection.wrappedValue.remove(item.id)
                }
            }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                Text(allowed ? item.detail : "Off in Bot")
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
            }
        }
        .disabled(!allowed)
    }

    private func connectionTitle(_ mode: AidenBotPrototypeCatalogMode) -> String {
        switch mode {
        case .all: "All enabled"
        case .selected: "Selected"
        case .off: "Off"
        }
    }

    private func skillTitle(_ mode: AidenBotPrototypeCatalogMode) -> String {
        switch mode {
        case .all: "All available"
        case .selected: "Selected"
        case .off: "Off"
        }
    }

    private var selectedCapabilities: AidenBotPrototypeCapabilities {
        .init(
            files: files,
            chosenLocationIDs: chosenLocationIDs,
            shell: shell,
            web: web,
            connectionMode: connectionMode,
            connectionIDs: connectionIDs,
            skillMode: skillMode,
            skillIDs: skillIDs
        )
    }
}

private struct AidenBotPrototypeChatDestination: View {
    @State private var isShowingAccess = false
    let bot: AidenBotPrototypeBot
    let chat: AidenChat
    let botPolicy: AidenBotPrototypeBotAccessPolicy
    let chatPolicy: AidenBotPrototypeChatAccessPolicy
    let allowsAccessChanges: Bool
    let onChatPolicyChanged: (AidenBotPrototypeChatAccessPolicy) -> Void

    var body: some View {
        AidenChatDetailView(readOnlyFixture: chat)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { isShowingAccess = true } label: {
                        AidenBotPrototypeAvatar(bot: bot, size: 30)
                    }
                    .disabled(!allowsAccessChanges)
                    .accessibilityLabel(
                        "\(bot.name) access, \(chatPolicy.mode == .inheritBot ? "inherits \(botPolicy.mode.title)" : "custom for this chat")"
                    )
                }
            }
            .sheet(isPresented: $isShowingAccess) {
                AidenBotPrototypeAccessView(
                    bot: bot,
                    scope: .chat,
                    botPolicy: botPolicy,
                    chatPolicy: chatPolicy,
                    onChatPolicyChanged: onChatPolicyChanged
                )
            }
    }
}

private struct AidenBotPrototypeBanner: View {
    @Environment(\.aidenPalette) private var palette
    let symbol: String
    let title: String
    let detail: String
    let tone: Color

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(tone)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(palette.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(13)
        .background(tone.opacity(0.1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
    }
}

private struct AidenBotPrototypeEmptyView: View {
    @Environment(\.aidenPalette) private var palette
    let symbol: String
    let title: String
    let detail: String
    let actionTitle: String
    let action: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 34, weight: .medium))
                .foregroundStyle(palette.accent)
                .frame(width: 76, height: 76)
                .background(palette.accent.opacity(0.12), in: Circle())
            Text(title).font(.title2.weight(.bold))
            Text(detail)
                .font(.body)
                .foregroundStyle(palette.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 330)
            Button(actionTitle, action: action)
                .buttonStyle(.borderedProminent)
        }
        .padding(28)
        .frame(maxWidth: .infinity)
    }
}

private struct AidenBotPrototypeWelcomeView: View {
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        ContentUnavailableView {
            Label("Choose a bot", systemImage: "bubble.left.and.bubble.right")
        } description: {
            Text("Open a recent conversation or a bot profile.")
        }
        .background(palette.canvas.ignoresSafeArea())
    }
}
#endif
