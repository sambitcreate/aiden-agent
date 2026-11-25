import SwiftUI

// The grouped-page kit: the iOS counterpart of the web's `SettingsPage`,
// `FieldSet` and `Field` and Android's `AidenSettings*` composables
// (docs/settings-design-system.md). Pages are large titles over borderless
// raised cards; rows put their control at the trailing edge; status shows
// in soft fills, never a coloured border.

extension View {
    /// Sets a step of the grouped-page type scale, at the phone's text size
    /// and the in-app Text size.
    func aidenType(_ step: AidenTypeScale) -> some View {
        modifier(AidenTypeModifier(step: step))
    }
}

private struct AidenTypeModifier: ViewModifier {
    let step: AidenTypeScale
    @Environment(\.aidenUIFont) private var uiFont
    @Environment(\.aidenUIFontSize) private var uiFontSize
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        let size = UIFontMetrics(forTextStyle: step.textStyle.uiTextStyle)
            .scaledValue(for: step.pointSize(uiFontSize: uiFontSize), compatibleWith: dynamicTypeSize.traitCollection)
        content.font(uiFont.font(size: size).weight(step.weight))
    }
}

private extension Font.TextStyle {
    var uiTextStyle: UIFont.TextStyle {
        switch self {
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .subheadline: .subheadline
        case .callout: .callout
        case .footnote: .footnote
        case .caption: .caption1
        case .caption2: .caption2
        default: .body
        }
    }
}

private extension DynamicTypeSize {
    var traitCollection: UITraitCollection {
        let category: UIContentSizeCategory = switch self {
        case .xSmall: .extraSmall
        case .small: .small
        case .medium: .medium
        case .large: .large
        case .xLarge: .extraLarge
        case .xxLarge: .extraExtraLarge
        case .xxxLarge: .extraExtraExtraLarge
        case .accessibility1: .accessibilityMedium
        case .accessibility2: .accessibilityLarge
        case .accessibility3: .accessibilityExtraLarge
        case .accessibility4: .accessibilityExtraExtraLarge
        case .accessibility5: .accessibilityExtraExtraExtraLarge
        @unknown default: .large
        }
        return UITraitCollection(preferredContentSizeCategory: category)
    }
}

// MARK: - Page

/// A grouped page: a large title, an optional line under it, and its cards
/// and captions stacked on the canvas.
struct AidenLargeTitlePage<Content: View>: View {
    let title: LocalizedStringKey
    var subtitle: String?
    @ViewBuilder let content: () -> Content
    @Environment(\.aidenPalette) private var palette

    init(_ title: LocalizedStringKey, subtitle: String? = nil, @ViewBuilder content: @escaping () -> Content) {
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
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                content()
            }
            .padding(.horizontal, AidenSpacing.l)
            .padding(.vertical, AidenSpacing.m)
        }
        .scrollContentBackground(.hidden)
        .background(AidenSettingsTokens.pageBackground(palette).ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.large)
    }
}

/// The secondary heading above a card, with an optional control at its end.
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
        .padding(.horizontal, AidenSpacing.l)
    }
}

extension AidenSectionCaption where Trailing == EmptyView {
    init(_ title: LocalizedStringKey) {
        self.init(title) { EmptyView() }
    }
}

// MARK: - Card

/// A borderless raised card that draws an inset separator between each pair
/// of its rows, and an optional footnote under it.
struct AidenGroupedCard<Content: View>: View {
    var footer: LocalizedStringKey?
    var separatorInset: CGFloat = AidenSettingsTokens.separatorLeadingInset
    @ViewBuilder let content: () -> Content
    @Environment(\.aidenPalette) private var palette
    @Environment(\.displayScale) private var displayScale

    init(
        footer: LocalizedStringKey? = nil,
        separatorInset: CGFloat = AidenSettingsTokens.separatorLeadingInset,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.footer = footer
        self.separatorInset = separatorInset
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AidenSpacing.s) {
            Group(subviews: content()) { rows in
                VStack(spacing: 0) {
                    ForEach(rows.indices, id: \.self) { index in
                        rows[index]
                        if index < rows.count - 1 {
                            Rectangle()
                                .fill(palette.secondary.opacity(AidenSettingsTokens.separatorOpacity))
                                .frame(height: 1 / displayScale)
                                .padding(.leading, separatorInset)
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
                    .padding(.horizontal, AidenSpacing.l)
            }
        }
    }
}

// MARK: - Rows

/// What a row shows at its trailing edge.
enum AidenSettingsAccessory {
    case none
    case value(String)
    case chevron
    case valueChevron(String)
    case toggle(Binding<Bool>)
    case chip(String, tone: AidenStatusTone)
    case custom(AnyView)
}

/// A settings row: a plain leading symbol (never on a tile), a title, an
/// optional line under it, and its control at the end. With an action it is
/// a button, so it keeps the keyboard focus ring; a toggle row flips its
/// switch from anywhere on the row. A disabled reason dims the row and says
/// why under the title.
struct AidenSettingsRow: View {
    var icon: String?
    let title: String
    var subtitle: String?
    var accessory: AidenSettingsAccessory = .none
    var disabledReason: String?
    var action: (() -> Void)?

    init(
        icon: String? = nil,
        title: String,
        subtitle: String? = nil,
        accessory: AidenSettingsAccessory = .none,
        disabledReason: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.accessory = accessory
        self.disabledReason = disabledReason
        self.action = action
    }

    var body: some View {
        AidenSettingsRowShell(
            title: title,
            subtitle: subtitle,
            accessory: accessory,
            disabledReason: disabledReason,
            action: action
        ) {
            if let icon { AidenSettingsRowIcon(symbol: icon) }
        }
    }
}

/// A row that opens a page on the current stack.
struct AidenNavigationRow: View {
    let route: AidenAppRoute
    var icon: String?
    let title: String
    var subtitle: String?
    var value: String?

    var body: some View {
        NavigationLink(value: route) {
            AidenSettingsRowLabel(
                title: title,
                subtitle: subtitle,
                accessory: value.map { .valueChevron($0) } ?? .chevron,
                disabledReason: nil
            ) {
                if let icon { AidenSettingsRowIcon(symbol: icon) }
            }
        }
        .buttonStyle(AidenSettingsRowButtonStyle())
    }
}

/// A row led by a Bot's avatar: a per-Bot usage line, a Bot picker's value.
struct AidenAvatarValueRow: View {
    let avatar: AidenBotSemanticAvatar
    let name: String
    var subtitle: String?
    var value: String?
    var action: (() -> Void)?

    var body: some View {
        AidenSettingsRowShell(
            title: name,
            subtitle: subtitle,
            accessory: value.map { action == nil ? .value($0) : .valueChevron($0) } ?? (action == nil ? .none : .chevron),
            disabledReason: nil,
            action: action
        ) {
            AidenBotSemanticAvatarView(avatar: avatar, name: name, size: 28)
                .frame(width: AidenSettingsTokens.iconColumnWidth)
        }
    }
}

private struct AidenSettingsRowIcon: View {
    let symbol: String
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        Image(systemName: symbol)
            .aidenType(.rowTitle)
            .foregroundStyle(palette.secondary)
            .frame(width: AidenSettingsTokens.iconColumnWidth)
            .accessibilityHidden(true)
    }
}

/// Wraps a row's label in what makes it interactive: a switch, a button or nothing.
private struct AidenSettingsRowShell<Leading: View>: View {
    let title: String
    let subtitle: String?
    let accessory: AidenSettingsAccessory
    let disabledReason: String?
    let action: (() -> Void)?
    @ViewBuilder let leading: () -> Leading

    var body: some View {
        Group {
            if case .toggle(let isOn) = accessory {
                Toggle(isOn: isOn) { label(showsControl: false) }
                    .toggleStyle(AidenSettingsRowToggleStyle())
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

    private func label(showsControl: Bool) -> AidenSettingsRowLabel<Leading> {
        AidenSettingsRowLabel(
            title: title,
            subtitle: subtitle,
            accessory: showsControl ? accessory : .none,
            disabledReason: disabledReason,
            leading: leading
        )
    }
}

/// A row's layout: leading mark, text, trailing control.
private struct AidenSettingsRowLabel<Leading: View>: View {
    let title: String
    let subtitle: String?
    let accessory: AidenSettingsAccessory
    let disabledReason: String?
    @ViewBuilder let leading: () -> Leading
    @Environment(\.aidenPalette) private var palette
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        HStack(spacing: AidenSpacing.m) {
            leading()
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
                        .foregroundStyle(palette.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(.horizontal, AidenSettingsTokens.rowHPadding)
        .padding(.vertical, AidenSettingsTokens.rowVPadding)
        .frame(minHeight: AidenSettingsTokens.rowMinHeight)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var trailing: some View {
        switch accessory {
        case .none, .toggle:
            EmptyView()
        case .value(let value):
            valueText(value)
        case .chevron:
            chevron
        case .valueChevron(let value):
            HStack(spacing: AidenSpacing.s) {
                valueText(value)
                chevron
            }
        case .chip(let text, let tone):
            AidenStatusChip(text, tone: tone)
        case .custom(let view):
            view
        }
    }

    private func valueText(_ value: String) -> some View {
        Text(value)
            .aidenType(.rowValue)
            .foregroundStyle(palette.secondary)
            .lineLimit(1)
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .aidenType(.footnote)
            .fontWeight(.semibold)
            .foregroundStyle(palette.secondary.opacity(0.7))
            .accessibilityHidden(true)
    }
}

/// A row's press: the card dims under the finger. Focus stays the system's.
struct AidenSettingsRowButtonStyle: ButtonStyle {
    @Environment(\.aidenPalette) private var palette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? palette.foreground.opacity(0.08) : .clear)
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
