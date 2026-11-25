import SwiftUI

// The grouped-page kit: the iOS counterpart of the web's `SettingsPage`,
// `FieldSet` and `Field` and Android's `AidenSettings*` composables
// (docs/settings-design-system.md). Pages are large titles over borderless
// raised cards; rows put their control at the trailing edge; status shows
// in soft fills, never a coloured border.
//
// Every piece of text the kit draws is a `LocalizedStringKey`: a literal is
// looked up in the strings table, and a runtime value goes in as `"\(value)"`,
// which draws as it is.

extension View {
    /// Sets a step of the grouped-page type scale, at the phone's text size
    /// and the in-app Text size and font.
    func aidenType(_ step: AidenTypeScale) -> some View {
        modifier(AidenTypeModifier(step: step))
    }

    /// Where the separator under this row of an `AidenGroupedCard` starts.
    /// Kit rows set their own; anything else gets the text-row inset.
    func aidenSeparatorInset(_ inset: CGFloat) -> some View {
        containerValue(\.aidenSeparatorInset, inset)
    }
}

extension ContainerValues {
    @Entry var aidenSeparatorInset: CGFloat = AidenSettingsTokens.textRowSeparatorInset
}

private struct AidenTypeModifier: ViewModifier {
    let step: AidenTypeScale
    @Environment(\.aidenUIFont) private var uiFont
    @Environment(\.aidenUIFontSize) private var uiFontSize
    /// The phone's text size against the default, in percent, for this step's style.
    @ScaledMetric private var percent: CGFloat

    init(step: AidenTypeScale) {
        self.step = step
        _percent = ScaledMetric(wrappedValue: 100, relativeTo: step.textStyle)
    }

    func body(content: Content) -> some View {
        let size = step.pointSize(uiFontSize: uiFontSize) * percent / 100
        content.font(uiFont.font(size: size).weight(step.weight))
    }
}

// MARK: - Page

/// A grouped page: the system large title, an optional line under it, and
/// its sections stacked on the page background. The title is the navigation
/// bar's own (HIG), so it follows Dynamic Type but not the in-app Text size.
/// In a wide detail pane the column stops at a readable width.
struct AidenLargeTitlePage<Content: View>: View {
    let title: LocalizedStringKey
    var subtitle: LocalizedStringKey?
    @ViewBuilder let content: () -> Content
    @Environment(\.aidenPalette) private var palette

    init(_ title: LocalizedStringKey, subtitle: LocalizedStringKey? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: AidenSpacing.xxl) {
                if let subtitle {
                    Text(subtitle)
                        .aidenType(.footnote)
                        .foregroundStyle(palette.secondary)
                        .padding(.horizontal, AidenSettingsTokens.rowHPadding)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                content()
            }
            .padding(.horizontal, AidenSpacing.l)
            .padding(.vertical, AidenSpacing.m)
            .frame(maxWidth: AidenSettingsTokens.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollContentBackground(.hidden)
        .background(AidenSettingsTokens.pageBackground(palette).ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.large)
    }
}

/// A section of a grouped page: its caption, its card and the card's
/// footnote, held close together. The page spaces sections apart.
struct AidenSettingsSection<Content: View, Trailing: View>: View {
    var caption: LocalizedStringKey?
    var footer: LocalizedStringKey?
    @ViewBuilder let content: () -> Content
    @ViewBuilder let trailing: () -> Trailing

    init(
        _ caption: LocalizedStringKey? = nil,
        footer: LocalizedStringKey? = nil,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) {
        self.caption = caption
        self.footer = footer
        self.content = content
        self.trailing = trailing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AidenSpacing.s) {
            if let caption {
                AidenSectionCaption(caption, trailing: trailing)
            }
            AidenGroupedCard(footer: footer, content: content)
        }
    }
}

extension AidenSettingsSection where Trailing == EmptyView {
    init(_ caption: LocalizedStringKey? = nil, footer: LocalizedStringKey? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.init(caption, footer: footer, content: content) { EmptyView() }
    }
}

/// The secondary heading above a card, with an optional control at its end.
/// Like Android's group title it is inset by the row padding, inside the
/// page padding, so it lines up with a text row's title.
struct AidenSectionCaption<Trailing: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder let trailing: () -> Trailing
    @Environment(\.aidenPalette) private var palette

    init(_ title: LocalizedStringKey, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.title = title
        self.trailing = trailing
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .aidenType(.sectionCaption)
                .foregroundStyle(palette.secondary)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: AidenSpacing.s)
            trailing()
        }
        .padding(.horizontal, AidenSettingsTokens.rowHPadding)
    }
}

extension AidenSectionCaption where Trailing == EmptyView {
    init(_ title: LocalizedStringKey) {
        self.init(title) { EmptyView() }
    }
}

// MARK: - Card

/// A borderless raised card that draws an inset separator under each row but
/// the last, starting where that row asks (`aidenSeparatorInset`), and an
/// optional footnote under it.
struct AidenGroupedCard<Content: View>: View {
    var footer: LocalizedStringKey?
    @ViewBuilder let content: () -> Content
    @Environment(\.aidenPalette) private var palette
    @Environment(\.displayScale) private var displayScale

    init(footer: LocalizedStringKey? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.footer = footer
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AidenSpacing.s) {
            Group(subviews: content()) { rows in
                VStack(spacing: 0) {
                    ForEach(rows) { row in
                        row
                        if row.id != rows.last?.id {
                            Rectangle()
                                .fill(AidenSettingsTokens.separator(palette))
                                .frame(height: 1 / displayScale)
                                .padding(.leading, row.containerValues.aidenSeparatorInset)
                                .accessibilityHidden(true)
                        }
                    }
                }
                .background(AidenSettingsTokens.cardFill(palette))
                .clipShape(RoundedRectangle(cornerRadius: AidenSettingsTokens.cardRadius, style: .continuous))
            }
            if let footer {
                Text(footer)
                    .aidenType(.footnote)
                    .foregroundStyle(palette.secondary)
                    .padding(.horizontal, AidenSettingsTokens.rowHPadding)
            }
        }
    }
}

// MARK: - Rows

/// What a row shows at its trailing edge. A row with its own trailing view
/// passes it to `AidenSettingsRow(…) { … }` instead.
enum AidenSettingsAccessory {
    case none
    case value(LocalizedStringKey)
    case chevron
    case valueChevron(LocalizedStringKey)
    /// A switch; the whole row flips it, and the row's `action` is not used.
    case toggle(Binding<Bool>)
    /// A switch whose state isn't known yet (its host hasn't answered): a
    /// spinner in its place, and nothing to flip.
    case loadingToggle
    case chip(LocalizedStringKey, tone: AidenStatusTone)

    var showsChevron: Bool {
        switch self {
        case .chevron, .valueChevron: true
        default: false
        }
    }
}

extension AidenSettingsTokens {
    /// The icon column at a text size: 28pt by default, growing with the
    /// symbol so a large glyph never runs into its title.
    static func iconColumnWidth(uiFontSize: Int, percent: CGFloat) -> CGFloat {
        let scaled = iconColumnWidth * CGFloat(uiFontSize) / CGFloat(defaultUIFontSize) * percent / 100
        return max(iconColumnWidth, scaled.rounded(.up))
    }

    /// Where the separator under a row starts: at its title.
    static func separatorInset(iconColumn: CGFloat?) -> CGFloat {
        guard let iconColumn else { return textRowSeparatorInset }
        return rowHPadding + iconColumn + AidenSpacing.m
    }
}

/// A settings row: a plain leading symbol (never on a tile), a title, an
/// optional line under it, and its control at the end. With an action it is
/// a button, so it keeps the keyboard focus ring; a toggle row flips its
/// switch from anywhere on the row. A disabled reason dims the row and says
/// why under the title. A trailing view must not be a control of its own in
/// a row with an action: the whole row is already the button.
struct AidenSettingsRow<Trailing: View>: View {
    var icon: String?
    let title: LocalizedStringKey
    var subtitle: LocalizedStringKey?
    var accessory: AidenSettingsAccessory
    var disabledReason: LocalizedStringKey?
    var action: (() -> Void)?
    @ViewBuilder let trailing: () -> Trailing

    @Environment(\.aidenUIFontSize) private var uiFontSize
    @ScaledMetric(relativeTo: .body) private var iconPercent: CGFloat = 100

    init(
        icon: String? = nil,
        title: LocalizedStringKey,
        subtitle: LocalizedStringKey? = nil,
        accessory: AidenSettingsAccessory = .none,
        disabledReason: LocalizedStringKey? = nil,
        action: (() -> Void)? = nil,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.accessory = accessory
        self.disabledReason = disabledReason
        self.action = action
        self.trailing = trailing
    }

    var body: some View {
        let column = AidenSettingsTokens.iconColumnWidth(uiFontSize: uiFontSize, percent: iconPercent)
        AidenSettingsRowShell(
            title: title,
            subtitle: subtitle,
            accessory: accessory,
            disabledReason: disabledReason,
            action: action,
            leading: { if let icon { AidenSettingsRowIcon(symbol: icon, width: column) } },
            trailing: trailing
        )
        .aidenSeparatorInset(AidenSettingsTokens.separatorInset(iconColumn: icon == nil ? nil : column))
    }
}

extension AidenSettingsRow where Trailing == EmptyView {
    init(
        icon: String? = nil,
        title: LocalizedStringKey,
        subtitle: LocalizedStringKey? = nil,
        accessory: AidenSettingsAccessory = .none,
        disabledReason: LocalizedStringKey? = nil,
        action: (() -> Void)? = nil
    ) {
        self.init(
            icon: icon, title: title, subtitle: subtitle, accessory: accessory,
            disabledReason: disabledReason, action: action
        ) { EmptyView() }
    }
}

/// A row that opens a page on the current stack.
struct AidenNavigationRow: View {
    let route: AidenAppRoute
    var icon: String?
    let title: LocalizedStringKey
    var subtitle: LocalizedStringKey?
    var value: LocalizedStringKey?

    @Environment(\.aidenUIFontSize) private var uiFontSize
    @ScaledMetric(relativeTo: .body) private var iconPercent: CGFloat = 100

    var body: some View {
        let column = AidenSettingsTokens.iconColumnWidth(uiFontSize: uiFontSize, percent: iconPercent)
        NavigationLink(value: route) {
            AidenSettingsRowLabel(
                title: title,
                subtitle: subtitle,
                accessory: value.map { .valueChevron($0) } ?? .chevron,
                disabledReason: nil,
                leading: { if let icon { AidenSettingsRowIcon(symbol: icon, width: column) } },
                trailing: { EmptyView() }
            )
        }
        .buttonStyle(AidenSettingsRowButtonStyle())
        .aidenSeparatorInset(AidenSettingsTokens.separatorInset(iconColumn: icon == nil ? nil : column))
    }
}

/// A row led by a Bot's avatar: a per-Bot usage line, a Bot picker's value.
struct AidenAvatarValueRow: View {
    let avatar: AidenBotSemanticAvatar
    let name: String
    var subtitle: LocalizedStringKey?
    var value: LocalizedStringKey?
    var action: (() -> Void)?

    var body: some View {
        AidenSettingsRowShell(
            title: "\(name)",
            subtitle: subtitle,
            accessory: value.map { action == nil ? .value($0) : .valueChevron($0) } ?? (action == nil ? .none : .chevron),
            disabledReason: nil,
            action: action,
            leading: {
                AidenBotSemanticAvatarView(avatar: avatar, name: name, size: 28)
                    .frame(width: AidenSettingsTokens.iconColumnWidth)
            },
            trailing: { EmptyView() }
        )
        .aidenSeparatorInset(AidenSettingsTokens.separatorLeadingInset)
    }
}

private struct AidenSettingsRowIcon: View {
    let symbol: String
    let width: CGFloat
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        Image(systemName: symbol)
            .aidenType(.rowTitle)
            .foregroundStyle(palette.secondary)
            .frame(width: width)
            .accessibilityHidden(true)
    }
}

/// Wraps a row's label in what makes it interactive: a switch, a button or nothing.
private struct AidenSettingsRowShell<Leading: View, Trailing: View>: View {
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey?
    let accessory: AidenSettingsAccessory
    let disabledReason: LocalizedStringKey?
    let action: (() -> Void)?
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        Group {
            if case .toggle(let isOn) = accessory {
                Toggle(isOn: isOn) { label(showsControl: false) }
                    .toggleStyle(AidenSettingsRowToggleStyle())
            } else if case .loadingToggle = accessory {
                label(showsControl: true)
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isToggle)
                    .accessibilityValue(Text("Loading"))
            } else if let action {
                Button(action: action) { label(showsControl: true) }
                    .buttonStyle(AidenSettingsRowButtonStyle())
            } else {
                label(showsControl: true)
                    .accessibilityElement(children: .combine)
            }
        }
        .disabled(disabledReason != nil)
    }

    private func label(showsControl: Bool) -> AidenSettingsRowLabel<Leading, Trailing> {
        AidenSettingsRowLabel(
            title: title,
            subtitle: subtitle,
            accessory: showsControl ? accessory : .none,
            disabledReason: disabledReason,
            leading: leading,
            trailing: trailing
        )
    }
}

/// A row's layout: leading mark, text, trailing control. At accessibility
/// text sizes the value moves under the title and wraps instead of
/// truncating; the chevron stays at the end.
private struct AidenSettingsRowLabel<Leading: View, Trailing: View>: View {
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey?
    let accessory: AidenSettingsAccessory
    let disabledReason: LocalizedStringKey?
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing
    @Environment(\.aidenPalette) private var palette
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let stacked = dynamicTypeSize.isAccessibilitySize
        let content = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: AidenSpacing.xs))
            : AnyLayout(HStackLayout(spacing: AidenSpacing.m))
        HStack(alignment: stacked ? .firstTextBaseline : .center, spacing: AidenSpacing.m) {
            leading()
            content {
                // The title is offered its width first; the value takes what
                // is left and truncates, or wraps under it when stacked.
                text
                    .frame(maxWidth: stacked ? .infinity : nil, alignment: .leading)
                    .layoutPriority(1)
                if !stacked {
                    Spacer(minLength: 0)
                }
                control(stacked: stacked)
                trailing()
            }
            if accessory.showsChevron {
                chevron
            }
        }
        .padding(.horizontal, AidenSettingsTokens.rowHPadding)
        .padding(.vertical, AidenSettingsTokens.rowVPadding)
        .frame(minHeight: AidenSettingsTokens.rowMinHeight)
        .contentShape(Rectangle())
    }

    /// Title, subtitle and reason. Disabled, the title steps back and the
    /// reason, the line that matters, keeps the foreground ink.
    private var text: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .aidenType(.rowTitle)
                .foregroundStyle(isEnabled ? palette.foreground : palette.secondary)
            if let subtitle {
                Text(subtitle)
                    .aidenType(.footnote)
                    .foregroundStyle(palette.secondary)
            }
            if let disabledReason {
                Text(disabledReason)
                    .aidenType(.footnote)
                    .foregroundStyle(palette.foreground)
            }
        }
    }

    @ViewBuilder
    private func control(stacked: Bool) -> some View {
        switch accessory {
        case .none, .chevron, .toggle:
            EmptyView()
        case .loadingToggle:
            ProgressView()
                .controlSize(.small)
                .accessibilityHidden(true)
        case .value(let value), .valueChevron(let value):
            Text(value)
                .aidenType(.rowValue)
                .foregroundStyle(palette.secondary)
                .lineLimit(stacked ? nil : 1)
                .multilineTextAlignment(stacked ? .leading : .trailing)
                .fixedSize(horizontal: false, vertical: stacked)
        case .chip(let text, let tone):
            AidenStatusChip(text, tone: tone)
        }
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .aidenType(.footnote)
            .fontWeight(.semibold)
            .foregroundStyle(AidenSettingsTokens.chevron(palette))
            .accessibilityHidden(true)
    }
}

/// A row's press: the card dims under the finger. Focus stays the system's.
struct AidenSettingsRowButtonStyle: ButtonStyle {
    @Environment(\.aidenPalette) private var palette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? AidenSettingsTokens.pressedFill(palette) : .clear)
    }
}

/// A toggle row: the label on the left, the palette's switch on the right.
/// The row is one button, so the whole row flips the switch and keeps the
/// keyboard focus ring; the switch inside only draws the state.
private struct AidenSettingsRowToggleStyle: ToggleStyle {
    @Environment(\.aidenPalette) private var palette

    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            HStack(spacing: 0) {
                configuration.label
                Toggle("", isOn: configuration.$isOn)
                    .labelsHidden()
                    .toggleStyle(AidenSwitchToggleStyle(onTrack: Color(aidenHex: palette.switchOnTrackHex)))
                    .allowsHitTesting(false)
                    .padding(.trailing, AidenSettingsTokens.rowHPadding)
                    .accessibilityHidden(true)
            }
        }
        .buttonStyle(AidenSettingsRowButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? Text("On") : Text("Off"))
    }
}
