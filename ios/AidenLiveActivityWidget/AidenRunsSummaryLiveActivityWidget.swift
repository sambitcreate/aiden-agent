import ActivityKit
import SwiftUI
import WidgetKit

/// Several runs on one Mac, as plain text: a headline, up to three chats with
/// their status, and how many more. A tap opens the most urgent chat.
struct AidenRunsSummaryLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AidenRunsSummaryActivityAttributes.self) { context in
            AidenRunsSummaryLockScreenView(rows: context.state.rows, machineName: context.attributes.machineName)
                .widgetURL(Self.tapURL(context))
        } dynamicIsland: { context in
            let rows = context.state.rows
            let headline = AidenRunsSummaryPolicy.headline(rows: rows, machineName: context.attributes.machineName)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    AidenRunsSummaryCard(rows: rows, machineName: context.attributes.machineName)
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                Text("\(rows.count) runs")
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            } compactTrailing: {
                if let trailing = headline.trailing {
                    Text(trailing)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                }
            } minimal: {
                Text(verbatim: "A")
                    .font(.caption2.weight(.semibold))
            }
            .widgetURL(Self.tapURL(context))
        }
        .supplementalActivityFamilies([.small])
    }

    private static func tapURL(_ context: ActivityViewContext<AidenRunsSummaryActivityAttributes>) -> URL? {
        guard let chatID = AidenRunsSummaryPolicy.tapChatID(context.state.rows) else { return nil }
        return AidenDeepLink.chatURL(instanceId: context.attributes.instanceID, chatId: chatID)
    }
}

private struct AidenRunsSummaryLockScreenView: View {
    let rows: [AidenRunsSummaryActivityAttributes.Row]
    let machineName: String
    @Environment(\.activityFamily) private var activityFamily

    var body: some View {
        if activityFamily == .small {
            // Watch Smart Stack and CarPlay: the headline only.
            let headline = AidenRunsSummaryPolicy.headline(rows: rows, machineName: machineName)
            VStack(alignment: .leading, spacing: 2) {
                Text(headline.title)
                    .font(.headline)
                    .lineLimit(1)
                if let trailing = headline.trailing {
                    Text(trailing)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
        } else {
            AidenRunsSummaryCard(rows: rows, machineName: machineName)
                .padding(16)
        }
    }
}

private struct AidenRunsSummaryCard: View {
    let rows: [AidenRunsSummaryActivityAttributes.Row]
    let machineName: String

    var body: some View {
        let headline = AidenRunsSummaryPolicy.headline(rows: rows, machineName: machineName)
        let visible = AidenRunsSummaryPolicy.visible(rows)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(headline.title)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                if let trailing = headline.trailing {
                    Text(trailing)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .multilineTextAlignment(.trailing)
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                ForEach(visible.shown, id: \.streamID) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(row.title)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 8)
                        // The status is short and says more than the end of a
                        // long chat title, so the title gives way first.
                        Text(AidenRunsSummaryPolicy.rowStatus(row))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .multilineTextAlignment(.trailing)
                            .layoutPriority(1)
                    }
                }
                if visible.hiddenCount > 0 {
                    Text("+\(visible.hiddenCount) more")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
