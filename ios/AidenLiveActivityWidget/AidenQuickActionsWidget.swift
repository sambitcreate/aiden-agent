import AppIntents
import SwiftUI
import WidgetKit

struct AidenQuickActionsEntry: TimelineEntry {
    let date: Date
}

struct AidenQuickActionsTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> AidenQuickActionsEntry {
        AidenQuickActionsEntry(date: .now)
    }

    func getSnapshot(in context: Context, completion: @escaping (AidenQuickActionsEntry) -> Void) {
        completion(AidenQuickActionsEntry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<AidenQuickActionsEntry>) -> Void) {
        completion(Timeline(entries: [AidenQuickActionsEntry(date: .now)], policy: .never))
    }
}

struct AidenQuickActionsWidget: Widget {
    static let kind = "AidenQuickActionsWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: AidenQuickActionsTimelineProvider()) { entry in
            AidenQuickActionsWidgetView(entry: entry)
        }
        .configurationDisplayName("Ask Aiden")
        .description("Start a new chat with text, camera, or voice, or open Workspaces and Bots.")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}

private struct AidenQuickActionsWidgetView: View {
    let entry: AidenQuickActionsEntry

    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.colorScheme) private var colorScheme

    private var isAccented: Bool {
        renderingMode != .fullColor
    }

    private var theme: AidenQuickActionsWidgetTheme {
        AidenQuickActionsWidgetTheme(colorScheme: colorScheme, isAccented: isAccented)
    }

    var body: some View {
        VStack(spacing: family == .systemSmall ? 10 : 12) {
            askPromptButton

            HStack(spacing: family == .systemSmall ? 10 : 12) {
                ForEach(circleActions, id: \.action) { item in
                    actionCircleButton(action: item.action, systemImage: item.systemImage, label: item.label)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(14)
        .containerBackground(for: .widget) {
            theme.cardBackground
        }
    }

    /// Small fits the two capture actions; medium adds the two tab roots.
    private var circleActions: [AidenQuickActionsWidgetItem] {
        let capture: [AidenQuickActionsWidgetItem] = [
            .init(action: .newChatCamera, systemImage: "camera", label: "New chat with camera"),
            .init(action: .newChatVoice, systemImage: "waveform", label: "Start voice"),
        ]
        guard family != .systemSmall else { return capture }
        return capture + [
            .init(action: .workspaces, systemImage: "folder", label: "Workspaces"),
            .init(action: .bots, systemImage: "person.2", label: "Bots"),
        ]
    }

    private var askPromptButton: some View {
        Button(intent: AidenHomeActionIntent(.newChat)) {
            HStack(spacing: family == .systemSmall ? 8 : 10) {
                Image("aiden-sidebar-logo")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: family == .systemSmall ? 20 : 24, height: family == .systemSmall ? 20 : 24)
                    .foregroundStyle(theme.brandMark)
                    .widgetAccentable()

                Text(family == .systemSmall ? "Ask" : "Ask Aiden")
                    .font(family == .systemSmall ? .headline.weight(.medium) : .title3.weight(.medium))
                    .foregroundStyle(theme.primaryForeground)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, family == .systemSmall ? 14 : 18)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.controlFill, in: Capsule(style: .continuous))
            .overlay {
                if let stroke = theme.controlStroke {
                    Capsule(style: .continuous)
                        .strokeBorder(stroke, lineWidth: 0.5)
                }
            }
            .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .frame(height: family == .systemSmall ? 48 : 54)
        .accessibilityLabel("Ask Aiden")
    }

    private func actionCircleButton(
        action: AidenHomeAction,
        systemImage: String,
        label: LocalizedStringKey
    ) -> some View {
        Button(intent: AidenHomeActionIntent(action)) {
            ZStack {
                Circle()
                    .fill(theme.controlFill)

                if let stroke = theme.controlStroke {
                    Circle()
                        .strokeBorder(stroke, lineWidth: 0.5)
                }

                Image(systemName: systemImage)
                    .font(.system(size: family == .systemSmall ? 19 : 21, weight: .medium))
                    .foregroundStyle(theme.primaryForeground)
                    .widgetAccentable()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .aspectRatio(1, contentMode: .fit)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel(label)
    }
}

private struct AidenQuickActionsWidgetItem {
    let action: AidenHomeAction
    let systemImage: String
    let label: LocalizedStringKey
}

private struct AidenQuickActionsWidgetTheme {
    let colorScheme: ColorScheme
    let isAccented: Bool

    /// Full-color surfaces align with Aiden's default light/dark palettes;
    /// accented and Liquid Glass modes use translucent fills so the system tint
    /// and glass depth remain legible.
    var cardBackground: Color {
        if isAccented {
            return .clear
        }
        if colorScheme == .dark {
            return Color(red: 0.125, green: 0.141, blue: 0.173) // #20242C
        }
        return Color(red: 0.933, green: 0.941, blue: 0.953) // #EEF0F3
    }

    var controlFill: Color {
        if isAccented {
            return Color.white.opacity(0.14)
        }
        if colorScheme == .dark {
            return Color(red: 0.078, green: 0.090, blue: 0.114) // #14171D
        }
        return Color.white
    }

    var controlStroke: Color? {
        if isAccented {
            return Color.white.opacity(0.18)
        }
        if colorScheme == .dark {
            return Color.white.opacity(0.06)
        }
        return Color.black.opacity(0.05)
    }

    var primaryForeground: Color {
        if isAccented {
            return .white
        }
        if colorScheme == .dark {
            return Color(red: 0.949, green: 0.957, blue: 0.973) // #F2F4F8
        }
        return Color(red: 0.122, green: 0.137, blue: 0.157) // #1F2328
    }

    var brandMark: Color {
        if isAccented {
            return .white
        }
        if colorScheme == .dark {
            return Color(red: 0.243, green: 0.592, blue: 0.965) // #3E97F6
        }
        return Color(red: 0.0, green: 0.416, blue: 0.839) // #006AD6
    }
}
