import SwiftUI

// A chat's top bar after Telegram's: the conversation's name over one status
// line on a glass capsule in the middle of the bar, and the other side's avatar
// on the right. Workspace chats and Bot chats (durable and legacy) share it.

/// The line under a chat's title.
struct AidenChatTitleStatus: Equatable {
    enum Tone: Equatable {
        /// Where the chat lives, or what the Bot is for.
        case secondary
        /// Busy: the agent or Bot is working right now.
        case accent
        /// It can't go on without the person, or can't answer at all.
        case warning
    }

    let text: String
    let tone: Tone
    /// Shows the typing dots before the text.
    let isActive: Bool

    init(_ text: String, tone: Tone = .secondary, isActive: Bool = false) {
        self.text = text
        self.tone = tone
        self.isActive = isActive
    }

    /// A new kind of status drops into place; text changing within one kind
    /// (one tool step to the next) does not, as in Telegram.
    var kind: String { "\(tone)-\(isActive)" }

    /// The dots already say "in progress", so a trailing ellipsis would say it twice.
    private static func withoutEllipsis(_ text: String) -> String {
        var trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.hasSuffix("…") { trimmed.removeLast() }
        if trimmed.hasSuffix("...") { trimmed.removeLast(3) }
        return trimmed.trimmingCharacters(in: .whitespaces)
    }

    /// A Workspace chat: what the agent is doing while a reply is in progress,
    /// otherwise the workspace it works in, and the machine when several are
    /// paired (else the branch).
    static func workspace(
        isStreaming: Bool,
        streamState: AidenStreamState?,
        runningToolName: String?,
        hasLiveText: Bool,
        workspaceName: String?,
        branch: String? = nil,
        machine: String? = nil
    ) -> AidenChatTitleStatus? {
        if isStreaming || streamState == .waitingForApproval {
            let activity = AidenActivityMarkKind.liveResponse(
                streamState: streamState,
                runningToolName: runningToolName,
                hasLiveText: hasLiveText
            )
            if streamState == .waitingForApproval {
                return AidenChatTitleStatus(withoutEllipsis(activity.label), tone: .warning)
            }
            return AidenChatTitleStatus(withoutEllipsis(activity.label), tone: .accent, isActive: true)
        }
        let parts = [workspaceName, nonEmpty(machine) ?? branch].compactMap(nonEmpty)
        guard !parts.isEmpty else { return nil }
        return AidenChatTitleStatus(parts.joined(separator: " · "))
    }

    private static func nonEmpty(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    /// A Bot chat: what it is doing while it works, why it can't answer when it
    /// can't, and otherwise what it is for (Telegram shows "bot" here), after
    /// the machine when several are paired.
    static func bot(
        state: AidenBotSessionStateKind?,
        statusWord: String?,
        waitsForYou: Bool,
        purpose: String?,
        machine: String? = nil
    ) -> AidenChatTitleStatus {
        if waitsForYou { return AidenChatTitleStatus("Waiting for you", tone: .warning) }
        switch state {
        case .running:
            // While the reply's words stream the status line hides; up here it says Writing.
            return AidenChatTitleStatus(withoutEllipsis(statusWord ?? "Writing"), tone: .accent, isActive: true)
        case .paused:
            return AidenChatTitleStatus("Paused", tone: .warning)
        case .unavailable:
            return AidenChatTitleStatus("Unavailable", tone: .warning)
        case .needsModel:
            return AidenChatTitleStatus("Needs a model", tone: .warning)
        case .interrupted:
            return AidenChatTitleStatus("Interrupted", tone: .warning)
        case .idle, nil:
            if let statusWord {
                // A message just sent: "Getting ready" before the Mac's state catches up.
                return AidenChatTitleStatus(withoutEllipsis(statusWord), tone: .accent, isActive: true)
            }
            let about = nonEmpty(purpose) ?? "Bot"
            guard let machine = nonEmpty(machine) else { return AidenChatTitleStatus(about) }
            return AidenChatTitleStatus("\(machine) · \(about)")
        }
    }
}

/// Three dots that grow and brighten in a 0.7-second wave, Telegram's typing
/// indicator. Reduce Motion holds them still.
struct AidenTypingDots: View {
    @Environment(\.aidenReduceMotion) private var reduceMotion

    private static let period = 0.7
    /// Each dot runs a beat behind the one before it.
    private static let offsets: [Double] = [0.4, 0.2, 0]

    var body: some View {
        if reduceMotion {
            dots(scales: [1, 1, 1])
        } else {
            TimelineView(.animation) { context in
                let time = context.date.timeIntervalSinceReferenceDate / Self.period
                dots(scales: Self.offsets.map { Self.scale(at: time + $0) })
            }
        }
    }

    /// Grows over the first 40% of the cycle, shrinks over the next 40%, rests for 20%.
    static func scale(at time: Double) -> Double {
        let phase = time - time.rounded(.down)
        let rise: Double
        if phase < 0.4 { rise = phase / 0.4 } else if phase < 0.8 { rise = 1 - (phase - 0.4) / 0.4 } else { rise = 0 }
        return 1 + 0.5 * rise
    }

    private func dots(scales: [Double]) -> some View {
        HStack(spacing: 2.5) {
            ForEach(scales.indices, id: \.self) { index in
                Circle()
                    .frame(width: 3, height: 3)
                    .scaleEffect(scales[index])
                    .opacity(0.75 + 0.25 * (scales[index] - 1) / 0.5)
            }
        }
        .frame(width: 16, height: 8)
        .accessibilityHidden(true)
    }
}

/// The title and its status line on a glass capsule, for a toolbar's principal
/// slot. Tapping it opens the chat's details, as tapping a Telegram title opens
/// the profile.
struct AidenChatTitleCapsule: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    let title: String
    let status: AidenChatTitleStatus?
    let accessibilityHint: LocalizedStringKey
    /// The state the Bot's header avatar is showing. Its face is hidden from
    /// VoiceOver, so a finished or failed turn is spoken here instead.
    var settledAvatar: AidenBotAvatarState? = nil
    let action: () -> Void

    /// What VoiceOver reads after the title: a Done or Something went wrong
    /// the avatar is playing, else the status line.
    static func accessibilityValue(status: AidenChatTitleStatus?, settledAvatar: AidenBotAvatarState?) -> String {
        if let settledAvatar, settledAvatar.isOutcome, let spoken = settledAvatar.accessibilityValue {
            return spoken
        }
        return status?.text ?? ""
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: 0) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                if let status {
                    statusLine(status)
                        .id(status.kind)
                        .transition(
                            reduceMotion
                                ? .identity
                                : .asymmetric(
                                    insertion: .opacity.combined(with: .offset(y: -4)),
                                    removal: .opacity.combined(with: .offset(y: 4))
                                )
                        )
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: status?.kind)
            .padding(.horizontal, 14)
            .frame(minWidth: 120, minHeight: 44)
            .background {
                if reduceTransparency {
                    Capsule().fill(palette.raised)
                }
            }
            .modifier(AidenChatTitleGlass(enabled: !reduceTransparency))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        // The nav bar has a fixed height: past this size the large content viewer reads it.
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .accessibilityShowsLargeContentViewer()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(Self.accessibilityValue(status: status, settledAvatar: settledAvatar))
        .accessibilityHint(accessibilityHint)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("chat-title-capsule")
    }

    private func statusLine(_ status: AidenChatTitleStatus) -> some View {
        HStack(spacing: 4) {
            if status.isActive { AidenTypingDots() }
            Text(status.text)
                .lineLimit(1)
        }
        .font(.caption)
        .foregroundStyle(color(for: status.tone))
    }

    private func color(for tone: AidenChatTitleStatus.Tone) -> Color {
        switch tone {
        case .secondary: palette.secondary
        case .accent: palette.accent
        case .warning: palette.warningText
        }
    }
}

private struct AidenChatTitleGlass: ViewModifier {
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            content
        }
    }
}

/// A Bot's face in the middle of the bar, over its name capsule (which sits just
/// under the bar), as a Telegram profile header stacks a photo over the name.
/// It opens what the capsule opens, so VoiceOver hears the capsule alone.
struct AidenChatHeaderAvatar<Avatar: View>: View {
    static var size: CGFloat { 52 }

    let action: () -> Void
    @ViewBuilder let avatar: Avatar

    var body: some View {
        Button(action: action) {
            avatar
                .frame(width: Self.size, height: Self.size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        // Bar items are 44pt high: the face reaches a little past the bar's
        // edges, toward the capsule, and is tappable inside the bar.
        .frame(width: Self.size, height: 44)
        .accessibilityHidden(true)
    }
}

/// The name capsule under a Bot's avatar, centred just below the bar.
struct AidenChatStackedTitle: View {
    let capsule: AidenChatTitleCapsule

    var body: some View {
        capsule
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 72)
            // Tucked up against the face, which reaches past the bar's edge.
            .padding(.top, -10)
            .padding(.bottom, 6)
    }
}

/// A workspace drawn as a chat avatar: its initials on the accent fill, like a
/// Telegram chat without a photo.
struct AidenWorkspaceInitialsAvatar: View {
    @Environment(\.aidenPalette) private var palette

    let name: String
    var size: CGFloat = 32

    static func initials(for name: String) -> String {
        let words = name.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        let letters = words.prefix(2).compactMap(\.first)
        guard !letters.isEmpty else { return "#" }
        return String(letters).uppercased()
    }

    var body: some View {
        Circle()
            .fill(palette.fillAccent.gradient)
            .overlay {
                Text(Self.initials(for: name))
                    .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
                    .foregroundStyle(palette.onFillAccent)
                    .minimumScaleFactor(0.6)
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
