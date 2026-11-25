import SwiftUI

/// Which tab chrome the shell draws. At compact width (an iPhone, a closed
/// iPhone Duo, a narrow iPad window) the system tab bar is hidden and Aiden
/// draws its own dock; at regular width the system's sidebar-adaptable tab
/// view stays as it is.
enum AidenTabChrome: Equatable {
    case dock, system

    static func resolve(besideList: Bool) -> Self {
        besideList ? .system : .dock
    }

    /// Whether the dock is on screen now. It gives the bottom edge to a
    /// conversation's composer, as the system bar did, and to the keyboard.
    static func showsDock(besideList: Bool, showsConversation: Bool, keyboardIsUp: Bool) -> Bool {
        resolve(besideList: besideList) == .dock && !showsConversation && !keyboardIsUp
    }
}

extension AidenAppTab {
    /// The tab's name, as the system tab bar and the dock show it.
    var title: String {
        switch self {
        case .chats: String(localized: "Chats")
        case .bots: String(localized: "Bots")
        case .workspaces: String(localized: "Workspaces")
        case .inbox: String(localized: "Inbox")
        }
    }

    /// The dock's outline symbol. The chosen tab fills it.
    var dockSymbol: String {
        switch self {
        case .chats: "bubble.left.and.bubble.right"
        case .bots: "person.2"
        case .workspaces: "folder"
        case .inbox: "tray"
        }
    }

    /// What VoiceOver adds to the Inbox's name: how many chats wait on the
    /// person, since the badge or dot that shows it says nothing. Nil with
    /// none waiting, and for every other tab.
    func accessibilityCount(needsYou count: Int) -> String? {
        guard self == .inbox, count > 0 else { return nil }
        return count == 1
            ? String(localized: "1 chat needs you")
            : String(localized: "\(count) chats need you")
    }
}

/// The compact-width tab dock (concept 02): icon-only tabs on a chrome glass
/// capsule, the chosen one in a neutral pill with its name beside the icon,
/// and a dot on the Inbox while chats wait. It sits in each screen's bottom
/// bar, so the content above keeps clear of it and scrolls under its edge
/// effect; the glass keeps the tabs legible over the rows passing beneath,
/// as the system Liquid Glass bar did.
///
/// VoiceOver reads it as a tab bar: each tab says its name, whether it's
/// chosen and, for the Inbox, how many chats need the person.
struct AidenDock: View {
    let selection: AidenAppTab
    let needsYouCount: Int
    let onSelect: (AidenAppTab) -> Void

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 20
    @Namespace private var pill

    var body: some View {
        // Past a size where the chosen tab's name fits, the pill alone marks
        // it, and a held press shows the name large.
        ViewThatFits(in: .horizontal) {
            row(namesChosenTab: true)
            row(namesChosenTab: false)
        }
        .padding(AidenSpacing.xs)
        .aidenChromeGlass(in: Capsule())
        .padding(.horizontal, AidenSpacing.m)
        .padding(.bottom, AidenSpacing.xs)
        // A bar keeps its height; held presses show the large version.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: selection)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isTabBar)
        .accessibilityIdentifier("aiden.dock")
    }

    private func row(namesChosenTab: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(AidenAppTab.allCases, id: \.self) { tab in
                if tab != AidenAppTab.allCases.first {
                    Spacer(minLength: AidenSpacing.xs)
                }
                item(tab, showsName: namesChosenTab && tab == selection)
            }
        }
    }

    private func item(_ tab: AidenAppTab, showsName: Bool) -> some View {
        let isSelected = tab == selection
        return Button {
            onSelect(tab)
        } label: {
            HStack(spacing: AidenSpacing.s) {
                Image(systemName: tab.dockSymbol)
                    .symbolVariant(isSelected ? .fill : .none)
                    .font(.system(size: iconSize))
                    .frame(width: iconSize + AidenSpacing.xs, height: iconSize + AidenSpacing.xs)
                    .overlay(alignment: .topTrailing) {
                        if tab == .inbox, needsYouCount > 0 {
                            Circle()
                                .fill(palette.danger)
                                .frame(width: 8, height: 8)
                                .offset(x: 2, y: -1)
                        }
                    }
                if showsName {
                    Text(tab.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .foregroundStyle(isSelected ? palette.foreground : palette.secondary)
            .padding(.horizontal, AidenSpacing.l)
            .frame(minWidth: AidenSettingsTokens.minimumHitSize, minHeight: AidenSettingsTokens.minimumHitSize)
            .background {
                if isSelected {
                    Capsule()
                        .fill(AidenListRowBackground.selectedFill(palette))
                        .matchedGeometryEffect(id: "pill", in: pill)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        // In a tab bar the tab's value is whether it's chosen, so the Inbox's
        // count rides in its name ("Inbox, 3 chats need you"); Voice Control
        // still answers to the bare name.
        .accessibilityLabel(Text(accessibilityName(of: tab)))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityInputLabels([Text(tab.title)])
        .accessibilityShowsLargeContentViewer {
            Label(tab.title, systemImage: tab.dockSymbol)
        }
        .accessibilityIdentifier("aiden.dock.\(tab.rawValue)")
    }
}

extension AidenDock {
    func accessibilityName(of tab: AidenAppTab) -> String {
        guard let count = tab.accessibilityCount(needsYou: needsYouCount) else { return tab.title }
        return "\(tab.title), \(count)"
    }
}

/// The round glass buttons of Home's own header: 44 points, the icon in the
/// foreground colour, on the chrome glass the rest of the bars use.
struct AidenChromeIconButtonStyle: ButtonStyle {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled
    @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 17

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: iconSize, weight: .medium))
            .foregroundStyle(palette.foreground)
            .opacity(isEnabled ? 1 : 0.4)
            .frame(width: AidenSettingsTokens.minimumHitSize, height: AidenSettingsTokens.minimumHitSize)
            .contentShape(Circle())
            .aidenChromeGlass(isInteractive: true, in: Circle())
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.94 : 1)
            .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: configuration.isPressed)
    }
}
