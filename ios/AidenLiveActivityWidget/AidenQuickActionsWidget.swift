import AppIntents
import ImageIO
import SwiftUI
import UIKit
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
                AidenWidgetBrandMark(size: family == .systemSmall ? 22 : 26)

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

/// Downsamples the bundled Aiden app icon (`aiden-icon-june15.png`, 1024×1024)
/// to a 96 px image so it stays well within WidgetKit's image pixel budget
/// while adapting to accented and Liquid Glass rendering modes.
private struct AidenWidgetBrandMark: View {
    let size: CGFloat

    private static let downsampledLogo: UIImage? = {
        guard let url = Bundle.main.url(forResource: "aiden-icon-june15", withExtension: "png"),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: 96,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: cgImage, scale: 3, orientation: .up)
    }()

    var body: some View {
        if let logo = Self.downsampledLogo {
            Image(uiImage: logo)
                .resizable()
                .widgetAccentedRenderingMode(.accentedDesaturated)
                .scaledToFill()
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
                .accessibilityHidden(true)
        } else {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: size * 0.8, weight: .semibold))
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
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
}
