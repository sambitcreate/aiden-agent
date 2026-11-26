import SwiftUI

/// Which tab chrome the shell draws. On a stack (an iPhone in either
/// orientation, a closed iPhone Duo, a narrow iPad window) the system tab bar
/// is hidden and Aiden draws its own dock; beside the list (an iPad, an open
/// iPhone Duo) the system's sidebar-adaptable tab view stays as it is.
enum AidenTabChrome: Equatable {
    case dock, system

    static func resolve(besideList: Bool) -> Self {
        besideList ? .system : .dock
    }

    /// Whether the lists sit beside their detail: at regular width, except
    /// on an iPhone held sideways. A Plus or Pro Max in landscape is regular
    /// wide but compact tall; it keeps the stack and the dock it had upright,
    /// as every smaller iPhone does, instead of swapping layouts as it turns.
    /// An iPad and an open iPhone Duo are regular both ways.
    static func besideList(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?) -> Bool {
        horizontal == .regular && vertical != .compact
    }

    /// Whether the keyboard takes the shell's bottom edge, so the dock steps
    /// aside: a keyboard docked along the bottom of the screen (as wide as the
    /// screen and taller than a hardware keyboard's shortcut bar) that covers
    /// the bottom of the shell's window. A floating or undocked keyboard (which
    /// can sit against any edge, the bottom too, and can be as wide as a Slide
    /// Over window), the shortcut bar alone, a keyboard off screen, or one
    /// below a Stage Manager window that ends above it leave the dock where it
    /// is. Every frame is in the screen's coordinate space, as the keyboard
    /// notifications give theirs; `window` is the shell window's frame there.
    static func keyboardTakesBottomEdge(keyboard: CGRect, screen: CGRect, window: CGRect) -> Bool {
        let visible = keyboard.intersection(screen)
        guard !visible.isNull,
              visible.maxY >= screen.maxY - 1,
              visible.width >= screen.width - 1,
              visible.height >= minimumKeyboardHeight else { return false }
        let overWindow = visible.intersection(window)
        return !overWindow.isNull && overWindow.height > 0 && overWindow.maxY >= window.maxY - 1
    }

    /// Taller than a shortcut or predictive bar, shorter than any on-screen keyboard.
    static let minimumKeyboardHeight: CGFloat = 120

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

    /// The dock's line icon, the same chosen or not: the pill marks the choice.
    var dockSymbol: String {
        switch self {
        case .chats: "bubble"
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

/// The compact-width tab dock (concept 02): bare line icons spread along the
/// bottom edge, the chosen one in a neutral pill with its name beside the
/// icon, and a dot on the Inbox while chats wait. It sits in each screen's
/// bottom bar, so the content above keeps clear of it and scrolls under the
/// bar's soft edge.
///
/// VoiceOver reads it as a tab bar: each tab says its name, whether it's
/// chosen and, for the Inbox, how many chats need the person.
///
/// It takes plain values and compares equal on them, so a shell that redraws
/// for something else leaves it alone (`.equatable()`). `onSelect` is not
/// compared: give it a closure whose behaviour depends only on those values
/// and on references that outlive the dock.
struct AidenDock: View, Equatable {
    let selection: AidenAppTab
    let needsYouCount: Int
    /// What a tap on the chosen tab does, as VoiceOver's hint for it.
    var chosenTabHint: String?
    let onSelect: (AidenAppTab) -> Void

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var scaledIconSize: CGFloat = 20
    @Namespace private var pill

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.selection == rhs.selection
            && lhs.needsYouCount == rhs.needsYouCount
            && lhs.chosenTabHint == rhs.chosenTabHint
    }

    /// The metric reads the text size above the dock, which the dock's own
    /// clamp doesn't reach, so it stops where the clamp does (xxxLarge).
    private var iconSize: CGFloat { min(scaledIconSize, 27) }

    /// The pill's slide and the name's fade, one spring for both.
    static let selectionSpring = Animation.spring(response: 0.32, dampingFraction: 0.82)

    var body: some View {
        // Past a size where the chosen tab's name fits, the pill alone marks
        // it, and a held press shows the name large.
        ViewThatFits(in: .horizontal) {
            row(namesChosenTab: true)
            row(namesChosenTab: false)
        }
        .padding(.horizontal, AidenSpacing.xl)
        .padding(.vertical, AidenSpacing.xs)
        // A bar keeps its height; held presses show the large version.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .animation(reduceMotion ? nil : Self.selectionSpring, value: selection)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isTabBar)
        .accessibilityIdentifier("aiden.dock")
    }

    private func row(namesChosenTab: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(AidenAppTab.allCases, id: \.self) { tab in
                if tab != AidenAppTab.allCases.first {
                    Spacer(minLength: 0)
                }
                item(tab, showsName: namesChosenTab && tab == selection, namesChosenTab: namesChosenTab)
            }
        }
    }

    private func item(_ tab: AidenAppTab, showsName: Bool, namesChosenTab: Bool) -> some View {
        let isSelected = tab == selection
        return Button {
            onSelect(tab)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: tab.dockSymbol)
                    .font(.system(size: iconSize, weight: .medium))
                    .frame(width: iconSize + 2, height: iconSize + 2)
                    .overlay(alignment: .topTrailing) {
                        if tab == .inbox, needsYouCount > 0 {
                            Circle()
                                .fill(palette.danger)
                                .frame(width: 8, height: 8)
                                .offset(x: 3, y: -2)
                        }
                    }
                if showsName {
                    Text(tab.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .fixedSize()
                        .transition(.opacity)
                }
            }
            .foregroundStyle(isSelected ? palette.foreground : palette.secondary)
            .padding(.horizontal, AidenSpacing.l)
            .frame(minWidth: AidenSettingsTokens.minimumHitSize, minHeight: AidenSettingsTokens.minimumHitSize)
            .background {
                if isSelected {
                    Capsule()
                        .fill(AidenListRowBackground.selectedFill(palette))
                        // One pill slides between the tabs. ViewThatFits
                        // builds both rows, so each has its own.
                        .matchedGeometryEffect(id: namesChosenTab ? "pill.named" : "pill", in: pill)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(AidenDockItemButtonStyle())
        // In a tab bar the tab's value is whether it's chosen, so the Inbox's
        // count rides in its name ("Inbox, 3 chats need you"); Voice Control
        // still answers to the bare name.
        .accessibilityLabel(Text(accessibilityName(of: tab)))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityHint(Text(isSelected ? chosenTabHint ?? "" : ""))
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

/// A dock tab's press: it dims and settles a little, as a system tab does.
private struct AidenDockItemButtonStyle: ButtonStyle {
    @Environment(\.aidenReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.6 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.94 : 1)
            .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: configuration.isPressed)
    }
}

/// The round glass buttons of Home's own header: 44 points, the icon in the
/// foreground colour, on the chrome glass the rest of the bars use.
struct AidenChromeIconButtonStyle: ButtonStyle {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled
    @ScaledMetric(relativeTo: .body) private var scaledIconSize: CGFloat = 17

    /// Fits the 44-point circle at any text size; a held press shows it large.
    private var iconSize: CGFloat { min(scaledIconSize, 24) }

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
