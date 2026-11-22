import ActivityKit
import SwiftUI
import WidgetKit

@main
struct AidenLiveActivityWidgetBundle: WidgetBundle {
    var body: some Widget {
        AgentRunLiveActivityWidget()
    }
}

/// Plain text on the system background: a title, one status line and, when a
/// run finishes, its reply excerpt. No status marks, colors or tints.
struct AgentRunLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentRunActivityAttributes.self) { context in
            AgentRunLockScreenView(
                presentation: Self.presentation(context),
                chatURL: Self.chatURL(context)
            )
            .widgetURL(Self.chatURL(context))
        } dynamicIsland: { context in
            let presentation = Self.presentation(context)
            let chatURL = Self.chatURL(context)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    AgentRunTextCard(presentation: presentation, chatURL: chatURL)
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                Text(presentation.compactStatus)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            } compactTrailing: {
                AgentRunTimingText(timing: presentation.timing)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } minimal: {
                Text(verbatim: "A")
                    .font(.caption2.weight(.semibold))
            }
            .widgetURL(chatURL)
        }
        .supplementalActivityFamilies([.small])
    }

    private static func presentation(_ context: ActivityViewContext<AgentRunActivityAttributes>) -> AgentRunTextPresentation {
        AgentRunTextPresentation.make(state: context.state, systemMarkedStale: context.isStale)
    }

    private static func chatURL(_ context: ActivityViewContext<AgentRunActivityAttributes>) -> URL? {
        AidenDeepLink.chatURL(instanceId: context.attributes.instanceID, chatId: context.state.sessionID)
    }
}

private struct AgentRunLockScreenView: View {
    let presentation: AgentRunTextPresentation
    let chatURL: URL?
    @Environment(\.activityFamily) private var activityFamily

    var body: some View {
        if activityFamily == .small {
            // Watch Smart Stack and CarPlay: the title and the status only.
            VStack(alignment: .leading, spacing: 2) {
                Text(presentation.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(presentation.status)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
        } else {
            AgentRunTextCard(presentation: presentation, chatURL: chatURL)
                .padding(16)
        }
    }
}

private struct AgentRunTextCard: View {
    let presentation: AgentRunTextPresentation
    let chatURL: URL?
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(presentation.title)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                if !isLuminanceReduced {
                    AgentRunTimingText(timing: presentation.timing)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            Text(presentation.status)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)

            if let detail = presentation.detail, !isLuminanceReduced {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A running run counts up, a stale one says how long ago it last updated
/// (drawn by the system, so it keeps aging while the app is suspended), and a
/// finished one shows no time.
private struct AgentRunTimingText: View {
    let timing: AgentRunTextPresentation.Timing

    @ViewBuilder
    var body: some View {
        switch timing {
        case .running(let startedAt):
            AgentRunElapsedTimerText(startedAt: startedAt)
        case .updated(let date):
            // The relative style reserves width for longer values; pin the
            // text to the trailing edge so it lines up with the card's edge.
            Text("\(Text(date, style: .relative)) ago")
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .lineLimit(1)
        case .none:
            EmptyView()
        }
    }
}

private struct AgentRunElapsedTimerText: View {
    let startedAt: Date
    var alignment: TextAlignment = .trailing

    // `Text(timerInterval:)` reserves layout width for the largest value its range
    // could ever show, then draws the shorter live value leading-aligned inside that
    // leftover slack — which left-shifted the digits in the Dynamic Island and the
    // Lock Screen (#247). Bounding the range keeps an MM:SS-sized box, and an
    // explicit `multilineTextAlignment` pins the digits to the trailing edge.
    private static let maxDisplayInterval: TimeInterval = 99 * 60 + 59

    var body: some View {
        Text(
            timerInterval: startedAt...startedAt.addingTimeInterval(Self.maxDisplayInterval),
            countsDown: false,
            showsHours: false
        )
        .monospacedDigit()
        .multilineTextAlignment(alignment)
        .lineLimit(1)
    }
}
