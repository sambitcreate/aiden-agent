import SwiftUI

/// Contract revision 37 (`bot:handoffs`): a step the Bot hands back to the
/// person, "Your turn: …", shown beside the question and approval cards.
///
/// Done and Skip answer it once, by its wait id; Open opens the page it names
/// in the phone's browser. A sign-in is finished in the Bot's own browser on
/// the Mac, so it offers Finish on your Mac and Skip instead (desktop and
/// Android parity). A step on the Bot's own browser or computer (`onMac`,
/// revision 43) offers Finish on your Mac, Skip and Done.
struct AidenBotHandoffCard: View {
    let handoff: AidenRemoteBotHandoff
    /// This phone may answer: it is connected and may change Bots.
    let canAnswer: Bool
    /// Finish on your Mac is on its way.
    let isFinishing: Bool
    /// What the Mac said after Finish on your Mac, for this card.
    let macPrompt: String?
    let onDone: () -> Void
    let onSkip: () -> Void
    let onFinishOnMac: () -> Void

    @Environment(\.aidenPalette) private var palette
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text(AidenBotSessionCopy.handoffTitle(handoff.action))
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: handoff.kind == .signIn ? "person.badge.key" : "hand.raised")
                    .foregroundStyle(palette.accent)
                    .accessibilityHidden(true)
            }
            if let why = handoff.why {
                Text(why)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if handoff.onMac, macPrompt == nil {
                Text(AidenBotSessionCopy.handoffOnMacDetail)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
            if let macPrompt {
                Text(macPrompt)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { actions }
                VStack(alignment: .leading, spacing: 8) { actions }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var actions: some View {
        switch handoff.kind {
        case .signIn:
            Button(AidenBotSessionCopy.finishOnMac, action: onFinishOnMac)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .aidenSolidFillTint()
                .disabled(!canAnswer || isFinishing)
            Button(AidenBotSessionCopy.handoffSkip, action: onSkip)
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .disabled(!canAnswer)
        case .action:
            if handoff.onMac {
                Button(AidenBotSessionCopy.finishOnMac, action: onFinishOnMac)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .disabled(!canAnswer || isFinishing)
            } else if let url = openURLValue {
                Button(openLabel(url)) { openURL(url) }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
            }
            Button(AidenBotSessionCopy.handoffSkip, action: onSkip)
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .disabled(!canAnswer)
            Button(AidenBotSessionCopy.handoffDone, action: onDone)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .aidenSolidFillTint()
                .disabled(!canAnswer)
        }
    }

    /// The page the hand-off names. The Mac only sends an https page, and the
    /// decoder refuses anything else, so this is checked once more for safety.
    private var openURLValue: URL? {
        guard let value = handoff.open?.url, AidenBotHandoffWire.isOpenURL(value) else { return nil }
        return URL(string: value, encodingInvalidCharacters: true)
    }

    /// "Open bank.example.com", or "Open" when the host can't be shown.
    private func openLabel(_ url: URL) -> String {
        guard let host = url.host(), !host.isEmpty else { return AidenBotSessionCopy.handoffOpen }
        return "\(AidenBotSessionCopy.handoffOpen) \(host)"
    }
}

/// Revision 37: a Bot the person paused. It is a calm state, not a warning:
/// Resume lifts the pause, and a reply the pause cut short then shows the
/// interrupted card with its own Resume and Dismiss.
struct AidenBotPausedCard: View {
    let botName: String
    let isBusy: Bool
    let canAct: Bool
    let onResume: () -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(AidenBotSessionCopy.pausedTitle(botName), systemImage: "pause.circle")
                .font(.headline)
                .foregroundStyle(palette.foreground)
            Text(AidenBotSessionCopy.pausedDetail(botName))
                .font(.footnote)
                .foregroundStyle(palette.secondary)
            Button(AidenBotSessionCopy.resume, action: onResume)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .aidenSolidFillTint()
                .disabled(isBusy || !canAct)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}
