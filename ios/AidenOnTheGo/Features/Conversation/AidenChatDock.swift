import SwiftUI

/// The Bot's cards that sit under its transcript.
enum AidenBotFooterKind: Equatable, CaseIterable {
    case handoff, spending, needsModel, paused, interrupted

    /// Several can show at once. This is the one that decides what the dock is
    /// doing: the card that holds the Bot back the most.
    static func leading(
        needsModel: Bool = false,
        isPaused: Bool = false,
        isInterrupted: Bool = false,
        hasHandoff: Bool = false,
        hasSpendingNotice: Bool = false
    ) -> Self? {
        if needsModel { return .needsModel }
        if isPaused { return .paused }
        if isInterrupted { return .interrupted }
        if hasHandoff { return .handoff }
        return hasSpendingNotice ? .spending : nil
    }
}

/// What the dock decides from. Nothing here may change with each token: the
/// conversation's screen reads it, and the transcript sits on that screen.
struct AidenDockInput: Equatable {
    /// False once the machine is known to be down. A machine still connecting
    /// counts as online, so the composer doesn't flash away as a chat opens.
    var isOnline: Bool
    /// A Bot conversation with an outbox, so it can take messages offline.
    var isBot: Bool
    var isBusy: Bool
    var hasOpenQuestion: Bool
    var isScheduledTask: Bool = false
    var cannotRespondReason: String? = nil
    var botFooter: AidenBotFooterKind? = nil

    /// Reads the machine that owns the conversation, which may not be the
    /// selected one.
    @MainActor
    static func isOnline(_ connection: AidenHostConnection?) -> Bool {
        guard let connection else { return true }
        return !connection.isKnownOffline && connection.connectionState != .needsPairing
    }

    /// True once this phone's pairing with the machine has ended.
    @MainActor
    static func isRevoked(_ connection: AidenHostConnection?) -> Bool {
        connection?.isRevoked == true || connection?.connectionState == .needsPairing
    }
}

enum AidenDockCopy {
    static let offline = String(localized: "This machine is offline. You can read this chat until it’s back.")
    static let machineRevoked = String(localized: "This phone is no longer paired with this machine. Pair it again to send messages.")
    static let noRunInput = String(localized: "This machine can’t take messages during a run. Stop it, or wait for it to finish.")
    static let cannotMessageBot = String(localized: "This phone can read this Bot’s messages but can’t reply.")
    static let scheduledTask = String(localized: "Review the scheduled task above before Aiden saves it.")
}

/// What sits under a conversation's transcript.
enum AidenDockContent: Equatable {
    case composer(busy: Bool)
    case question                         // replaces the composer
    case scheduledTask
    case cannotRespond(String)
    case offlineReadOnly
    case botFooter(AidenBotFooterKind)    // handoff, spending, needsModel, paused, interrupted

    static func resolve(_ input: AidenDockInput) -> Self {
        // Without a model there is nothing to ask or tell.
        if input.isBot, input.botFooter == .needsModel { return .botFooter(.needsModel) }
        if let reason = input.cannotRespondReason { return .cannotRespond(reason) }
        // An offline chat can't take a message either way, so its question stays
        // in view. An offline Bot still can, and its outbox outranks a card it
        // can't answer yet.
        if input.hasOpenQuestion, input.isOnline || !input.isBot { return .question }
        if !input.isOnline, !input.isBot { return .offlineReadOnly }
        if let footer = input.botFooter { return .botFooter(footer) }
        if input.isScheduledTask { return .scheduledTask }
        return .composer(busy: input.isBusy)
    }

    /// False when something else takes the composer's place. Input state lives
    /// in the session, so it survives either way.
    var keepsComposer: Bool {
        switch self {
        case .question, .offlineReadOnly, .botFooter(.needsModel): false
        default: true
        }
    }

    /// The line that explains this state, shown above the composer or in its place.
    var notice: AidenDockNotice? {
        switch self {
        case .scheduledTask: AidenDockNotice(text: AidenDockCopy.scheduledTask, symbol: "calendar.badge.clock")
        case .cannotRespond(let reason): AidenDockNotice(text: reason, symbol: "lock.fill")
        case .offlineReadOnly: AidenDockNotice(text: AidenDockCopy.offline, symbol: "wifi.slash")
        default: nil
        }
    }

    /// What VoiceOver says on arriving here, or nil when nothing new needs the
    /// person. A run starting or ending says nothing: the status line covers it.
    func announcement(from previous: Self) -> String? {
        guard self != previous else { return nil }
        switch self {
        case .composer: return nil
        case .question: return String(localized: "Aiden needs your input")
        case .scheduledTask: return AidenDockCopy.scheduledTask
        case .cannotRespond(let reason): return reason
        case .offlineReadOnly: return AidenDockCopy.offline
        case .botFooter(.handoff): return String(localized: "A step needs you")
        case .botFooter(.spending): return String(localized: "This Bot reached its spending limit")
        case .botFooter(.needsModel): return String(localized: "This Bot needs a model")
        case .botFooter(.paused): return String(localized: "This Bot is paused")
        case .botFooter(.interrupted): return String(localized: "The reply was interrupted")
        }
    }
}

struct AidenDockNotice: Equatable {
    let text: String
    let symbol: String
}

/// What a chat says while its machine has revoked this phone. The machine's chats
/// stay until nothing shows them, so leaving is what removes them.
struct AidenRevokedMachineNotice: Equatable {
    let machineName: String

    var text: String {
        String(localized: "Closing this chat removes \(machineName)’s chats from this phone.")
    }
}

/// Says what leaving will do, and offers it. The reason the chat can't be
/// answered is already above, in the dock.
struct AidenRevokedMachineNoticeRow: View {
    let notice: AidenRevokedMachineNotice
    let onClose: () -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            Text(notice.text)
                .font(.footnote)
                .foregroundStyle(palette.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Close chat", action: onClose)
                .font(.footnote.weight(.semibold))
                .frame(minHeight: 44)
        }
        .padding(.horizontal, 16)
        .accessibilityElement(children: .contain)
    }
}

struct AidenDockActions {
    var onSend: () -> Void = {}
    /// Non-nil while a run can be stopped.
    var stop: AidenDockStop? = nil
}

/// What only one kind of conversation has. Each is read by the dock's own body,
/// so what it depends on updates the dock and leaves the transcript alone.
struct AidenDockSlots {
    let above: () -> AnyView
    let footer: () -> AnyView
    let question: (AidenDockStop?) -> AnyView
    /// Nil uses the plain shared surface.
    let composer: ((AidenComposerConfig) -> AnyView)?

    init() {
        self.init(above: { EmptyView() })
    }

    init<Above: View, Footer: View, Question: View>(
        @ViewBuilder above: @escaping () -> Above = { EmptyView() },
        @ViewBuilder footer: @escaping () -> Footer = { EmptyView() },
        @ViewBuilder question: @escaping (AidenDockStop?) -> Question = { _ in EmptyView() }
    ) {
        self.above = { AnyView(above()) }
        self.footer = { AnyView(footer()) }
        self.question = { AnyView(question($0)) }
        composer = nil
    }

    init<Above: View, Footer: View, Question: View, Composer: View>(
        @ViewBuilder above: @escaping () -> Above = { EmptyView() },
        @ViewBuilder footer: @escaping () -> Footer = { EmptyView() },
        @ViewBuilder question: @escaping (AidenDockStop?) -> Question = { _ in EmptyView() },
        @ViewBuilder composer: @escaping (AidenComposerConfig) -> Composer
    ) {
        self.above = { AnyView(above()) }
        self.footer = { AnyView(footer()) }
        self.question = { AnyView(question($0)) }
        self.composer = { AnyView(composer($0)) }
    }
}

/// The one bottom dock chats and Bots share. Notices and Bot cards stack above
/// whatever holds the composer's place.
struct AidenChatDock: View {
    private let content: AidenDockContent
    private let session: AidenComposerSession
    private let config: AidenComposerConfig
    private let actions: AidenDockActions
    private let slots: AidenDockSlots

    init(
        content: AidenDockContent,
        session: AidenComposerSession,
        config: AidenComposerConfig,
        actions: AidenDockActions,
        slots: AidenDockSlots = AidenDockSlots()
    ) {
        self.content = content
        self.session = session
        self.config = config
        self.actions = actions
        self.slots = slots
    }

    var body: some View {
        VStack(spacing: AidenSpacing.s) {
            slots.above()
            slots.footer()
            if content.keepsComposer, let notice = content.notice {
                AidenDockNoticeRow(notice: notice)
            }
            // One branch for every state that shows the composer, so moving
            // between them keeps the field and its keyboard.
            if content.keepsComposer {
                composer
            } else {
                replacement
            }
        }
        .padding(.horizontal, AidenSpacing.l)
        .padding(.vertical, AidenSpacing.s)
        .onChange(of: content) { previous, current in
            if let text = current.announcement(from: previous) {
                AccessibilityNotification.Announcement(text).post()
            }
        }
    }

    @ViewBuilder
    private var composer: some View {
        if let build = slots.composer {
            build(config)
        } else {
            AidenComposerSurface(
                session: session,
                config: config,
                controls: AidenComposerControls(
                    canStop: actions.stop?.isEnabled ?? false,
                    stopLabel: actions.stop?.label ?? String(localized: "Stop response")
                ),
                onSend: actions.onSend,
                onStop: actions.stop?.action
            )
        }
    }

    /// A recording keeps running with the composer away, so its stop stays here.
    @ViewBuilder
    private var replacement: some View {
        if content == .question {
            AidenDecisionDock(session: session) { slots.question(actions.stop) }
        } else {
            AidenComposerListeningBar(session: session)
            if let notice = content.notice { AidenDockNoticeRow(notice: notice) }
        }
    }
}

/// A plain line on the composer's surface, readable over the transcript passing
/// under it.
private struct AidenDockNoticeRow: View {
    @Environment(\.aidenPalette) private var palette
    let notice: AidenDockNotice

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AidenSpacing.s) {
            Image(systemName: notice.symbol)
                .accessibilityHidden(true)
            Text(notice.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .font(.footnote)
        .foregroundStyle(palette.secondary)
        .padding(.horizontal, AidenSpacing.l)
        .padding(.vertical, AidenSpacing.m)
        .frame(minHeight: 44)
        .aidenComposerGlass()
        .accessibilityElement(children: .combine)
    }
}

extension AidenChatViewModel {
    /// Every part comes from the machine that owns this chat, and none of it
    /// moves with a token.
    var dockInput: AidenDockInput {
        let connection = ownerHostConnection
        return AidenDockInput(
            isOnline: AidenDockInput.isOnline(connection),
            // A Bot chat opened here has no outbox, so offline it reads like any chat.
            isBot: false,
            isBusy: isStreaming,
            hasOpenQuestion: pendingQuestion != nil,
            isScheduledTask: pendingApproval?.kind == .scheduledTask,
            cannotRespondReason: cannotRespondReason(connection)
        )
    }

    var isOwnerRevoked: Bool { AidenDockInput.isRevoked(ownerHostConnection) }

    /// Nil unless leaving this chat is what's holding up its machine's purge.
    var revokedMachineNotice: AidenRevokedMachineNotice? {
        guard let connection = ownerHostConnection, connection.isPurgePending else { return nil }
        return AidenRevokedMachineNotice(machineName: connection.installation.name)
    }

    var ownerConnectionState: AidenRemoteConnectionState? { ownerHostConnection?.connectionState }

    var ownerWorkspace: AidenWorkspace? {
        ownerHostConnection?.workspaces.first { $0.id == chat.workspaceId }
    }

    /// Safe to read from a view's body, unlike `simulatorsClient`.
    var offersSimulators: Bool {
        !isReadOnlyFixture && ownerHostConnection?.isRevoked != true
            && ownerServer?.supportsMobileSimulators == true
            && ownerInstallation?.hasNegotiatedAccess(to: .simulatorsMobile) == true
    }

    /// Nil unless the owner offers simulators to this phone. The owner's, for the
    /// same reason as `spendingTransport`.
    var simulatorsClient: AidenRemoteClient? {
        offersSimulators ? try? coordinator.remoteClient(for: owner) : nil
    }

    /// The old shell files every chat under the selected machine, so it opens
    /// forks only from there. The tab shell's routes carry their machine.
    func opensForks(inTabShell: Bool = AppConfig.tabShellEnabled) -> Bool {
        inTabShell || coordinator.activeInstanceId == owner.instanceId
    }

    /// Revision 49: a Workspace chat's background jobs, once this phone holds
    /// `chat:jobs`. The owner's, for the same reason as `spendingTransport`.
    var backgroundJobsTransport: AidenBackgroundJobTransport? {
        guard !isReadOnlyFixture, !chat.isBotChat,
              ownerServer?.capabilities.contains(.chatJobs) == true else { return nil }
        return try? coordinator.remoteClient(for: owner)
    }

    /// The owner's, since this chat can stay on screen across a machine switch.
    var spendingTransport: AidenSpendingTransport? {
        guard !isReadOnlyFixture, ownerServer?.supportsSpendingLimits == true else { return nil }
        return try? coordinator.remoteClient(for: owner)
    }

    /// A read-only fixture has no machine behind it.
    private var ownerHostConnection: AidenHostConnection? {
        isReadOnlyFixture ? nil : coordinator.hosts.connection(for: owner.instanceId)
    }

    private func cannotRespondReason(_ connection: AidenHostConnection?) -> String? {
        if AidenDockInput.isRevoked(connection) { return AidenDockCopy.machineRevoked }
        // A machine that hasn't answered yet may still take run input. An open
        // question is its own way in, and an answer isn't run input.
        if pendingQuestion == nil, isStreaming, let server = connection?.server, !server.supportsChatRunInput {
            return AidenDockCopy.noRunInput
        }
        return nil
    }
}

extension AidenBotSessionModel {
    /// `connection` is the owner's: a Bot's machine may not be the selected one.
    func dockInput(connection: AidenHostConnection?, hasSpendingNotice: Bool) -> AidenDockInput {
        AidenDockInput(
            isOnline: AidenDockInput.isOnline(connection),
            isBot: true,
            isBusy: isRunning,
            hasOpenQuestion: question != nil,
            cannotRespondReason: cannotRespondReason(connection),
            botFooter: .leading(
                needsModel: needsModel,
                isPaused: isPaused,
                isInterrupted: isInterrupted,
                hasHandoff: handoff != nil,
                hasSpendingNotice: hasSpendingNotice
            )
        )
    }

    private func cannotRespondReason(_ connection: AidenHostConnection?) -> String? {
        if AidenDockInput.isRevoked(connection) { return AidenDockCopy.machineRevoked }
        if connection?.installation.canWriteBots == false { return AidenDockCopy.cannotMessageBot }
        return nil
    }
}
