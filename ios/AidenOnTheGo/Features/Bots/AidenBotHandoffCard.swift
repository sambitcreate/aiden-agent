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

/// Revision 55. Only the host's offered choices can grant access.
struct AidenBotAccessRequestCard: View {
    let request: AidenRemoteBotAccessRequest
    let botName: String
    var showsApprovalCount = false
    let canAnswer: Bool
    let onAnswer: (AidenBotAccessChoice) -> Void
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("\(botName) wants to use \(request.label)", systemImage: request.target == .wholeMac ? "laptopcomputer" : "folder")
                .font(.headline).foregroundStyle(palette.foreground)
                .fixedSize(horizontal: false, vertical: true)
            if let place = request.place {
                Text(verbatim: place).font(.footnote).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if showsApprovalCount, let count = request.approvalCount { Text("You’ve allowed this \(count) times in the last 2 weeks.").font(.footnote).foregroundStyle(palette.secondary) }
            Text(verbatim: request.why).font(.subheadline).foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { actions }
                VStack(alignment: .leading, spacing: 8) { actions }
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot_session_access_request_card")
    }

    @ViewBuilder private var actions: some View {
        ForEach(request.choices, id: \.rawValue) { choice in
            if choice == .once {
                Button(choice.title) { onAnswer(choice) }
                    .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).aidenSolidFillTint()
                    .disabled(!canAnswer)
            } else {
                Button(choice.title) { onAnswer(choice) }
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).disabled(!canAnswer)
            }
        }
    }
}

/// Revision 56. The review scrolls independently so its decisions stay reachable.
struct AidenBotPlanCard: View {
    let plan: AidenRemoteBotPlan
    let botName: String
    let canAnswer: Bool
    let error: String?
    let onRespond: (AidenBotPlanDecision) -> Void
    @Environment(\.aidenPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var detailsShown = false

    var body: some View {
        if plan.status != .pending && plan.status != .active {
            Text("Plan ended · \(plan.completedSteps) of \(plan.steps.count) steps")
                .font(.footnote).foregroundStyle(palette.secondary)
                .accessibilityIdentifier("bot_plan_ended")
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(plan.from.map { "\($0) asked \(botName) to do this" } ?? "\(botName) has a plan")
                            .font(.caption).foregroundStyle(palette.secondary)
                        Text(verbatim: plan.title).font(.headline).foregroundStyle(palette.foreground)
                        Text(verbatim: plan.why).font(.subheadline).foregroundStyle(palette.secondary)
                        if plan.status == .active {
                            TimelineView(.periodic(from: .now, by: 60)) { context in
                                Text(plan.expiry.map { "Approved · ends in \(max(0, Int(ceil($0.timeIntervalSince(context.date) / 60)))) min" } ?? "Approved")
                                    .font(.footnote).foregroundStyle(palette.secondary)
                            }
                        }
                        ForEach(Array(plan.steps.enumerated()), id: \.offset) { index, step in
                            HStack(alignment: .top, spacing: 8) {
                                if plan.status == .pending {
                                    Text("\(index + 1).").accessibilityHidden(true)
                                } else {
                                    Image(systemName: step.status == .done ? "checkmark.circle" : step.status == .skipped ? "minus.circle" : "circle")
                                        .accessibilityLabel(step.status == .done ? "Done" : step.status == .skipped ? "Skipped" : "Pending")
                                }
                                Text(verbatim: step.text).fixedSize(horizontal: false, vertical: true)
                            }
                            .font(.subheadline).foregroundStyle(palette.foreground)
                            .accessibilityElement(children: .combine)
                        }
                        ForEach(Array(plan.items.enumerated()), id: \.offset) { _, item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(verbatim: item.line).font(.subheadline).foregroundStyle(palette.foreground)
                                if plan.status == .active, let used = item.used, let max = item.max {
                                    Text("\(used) of \(max) used").font(.caption).foregroundStyle(palette.secondary)
                                }
                                if detailsShown {
                                    ForEach(Array(item.details.enumerated()), id: \.offset) { _, detail in
                                        Text(verbatim: detail).font(.footnote).foregroundStyle(palette.secondary)
                                    }
                                }
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: dynamicTypeSize.isAccessibilitySize ? 180 : 240)
                .accessibilityLabel("Plan review")
                if let error { Text(error).font(.footnote).foregroundStyle(palette.danger).accessibilityIdentifier("bot_plan_error") }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { actions }
                    VStack(alignment: .leading, spacing: 8) { actions }
                }
                .controlSize(.large)
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("bot_session_plan_card")
        }
    }
    @ViewBuilder private var actions: some View {
        if plan.status == .pending {
            Button("Approve plan") { onRespond(.approve) }
                .padding(.horizontal, 16).frame(minHeight: 44)
                .buttonStyle(AidenSolidFillButtonStyle(shape: RoundedRectangle(cornerRadius: 16, style: .continuous)))
                .disabled(!canAnswer)
            Button("Not now") { onRespond(.notNow) }
                .buttonStyle(.bordered).buttonBorderShape(.roundedRectangle(radius: 16)).disabled(!canAnswer)
        } else {
            Button("Stop plan") { onRespond(.stop) }
                .buttonStyle(.bordered).buttonBorderShape(.roundedRectangle(radius: 16)).disabled(!canAnswer)
        }
        Button(detailsShown ? "Hide details" : "Show details") { detailsShown.toggle() }
            .buttonStyle(.bordered).buttonBorderShape(.roundedRectangle(radius: 16))
            .accessibilityValue(detailsShown ? "Expanded" : "Collapsed")
    }
}
