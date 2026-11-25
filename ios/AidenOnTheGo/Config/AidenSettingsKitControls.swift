import SwiftUI

// The grouped-page kit's controls: status chip, pill segmented control,
// swatches, a stat hero, a heatmap and a round icon button. See
// AidenSettingsKit.swift for the page, card and rows.

// MARK: - Status chip

/// The tone of a status chip. Each is a soft fill of its colour with text
/// that passes 4.5:1 on that fill; never a coloured border.
enum AidenStatusTone: Sendable, CaseIterable {
    case neutral
    case accent
    case success
    case warning
    case danger

    /// The colour the chip's capsule is tinted with.
    func fillHex(_ palette: AidenPalette) -> String {
        switch self {
        case .neutral: palette.secondaryHex
        case .accent: palette.accentHex
        case .success: palette.successHex
        case .warning: palette.warningHex
        case .danger: palette.dangerHex
        }
    }

    /// The colour of the chip's label and symbol.
    func textHex(_ palette: AidenPalette) -> String {
        switch self {
        case .neutral: palette.foregroundHex
        case .accent: palette.accentTextHex
        case .success: palette.successTextHex
        case .warning: palette.warningTextHex
        case .danger: palette.dangerTextHex
        }
    }
}

/// A short status label in a softly tinted capsule: "Needs approval",
/// "Failed", "Paused". The words use the palette's text-safe tint, which holds
/// 4.5:1 where the fill colour itself would not. Warning and danger differ by
/// colour, so with Differentiate Without Colour on each carries its own
/// symbol. Dimmed, a chip takes the secondary tint (a row whose machine is away).
struct AidenStatusChip: View {
    private let text: LocalizedStringKey
    private let tone: AidenStatusTone
    private let symbol: String?
    private let isDimmed: Bool

    @Environment(\.aidenPalette) private var palette
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    init(_ text: LocalizedStringKey, tone: AidenStatusTone = .neutral, symbol: String? = nil, isDimmed: Bool = false) {
        self.text = text
        self.tone = tone
        self.symbol = symbol
        self.isDimmed = isDimmed
    }

    private var shownSymbol: String? {
        if let symbol { return symbol }
        guard differentiateWithoutColor else { return nil }
        return switch tone {
        case .danger: "xmark.octagon.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .neutral, .accent, .success: nil
        }
    }

    var body: some View {
        HStack(spacing: AidenSpacing.xs) {
            if let shownSymbol {
                Image(systemName: shownSymbol).accessibilityHidden(true)
            }
            Text(text)
        }
        .aidenType(.chipLabel)
        .foregroundStyle(Color(aidenHex: isDimmed ? palette.secondaryHex : tone.textHex(palette)))
        .lineLimit(1)
        .padding(.horizontal, AidenSettingsTokens.chipHPadding)
        .padding(.vertical, AidenSettingsTokens.chipVPadding)
        .background(
            Color(aidenHex: isDimmed ? palette.secondaryHex : tone.fillHex(palette))
                .opacity(AidenPalette.statusChipFillOpacity),
            in: Capsule()
        )
    }
}

// MARK: - Pill segmented control

/// A track with a solid thumb under the chosen option, for two to four short
/// choices (Daily / Weekly / Monthly). Each option is a 44pt button that
/// VoiceOver reads with the selected trait, and swiping up or down on any of
/// them moves the choice. At accessibility text sizes the options stack, so
/// no label is cut short.
struct AidenPillSegmentedControl<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [Value]
    let accessibilityLabel: LocalizedStringKey
    let label: (Value) -> LocalizedStringKey

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Namespace private var thumb

    init(
        selection: Binding<Value>,
        options: [Value],
        accessibilityLabel: LocalizedStringKey,
        label: @escaping (Value) -> LocalizedStringKey
    ) {
        _selection = selection
        self.options = options
        self.accessibilityLabel = accessibilityLabel
        self.label = label
    }

    /// The option `offset` steps from `current`, held at the ends. An unknown
    /// current value starts from the first option.
    nonisolated static func step(from current: Value, by offset: Int, in options: [Value]) -> Value? {
        guard !options.isEmpty else { return nil }
        let index = options.firstIndex(of: current) ?? 0
        return options[min(max(index + offset, 0), options.count - 1)]
    }

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 0))
            : AnyLayout(HStackLayout(spacing: 0))
        layout {
            ForEach(options, id: \.self) { option in
                segment(option)
            }
        }
        .background(palette.sidebar, in: RoundedRectangle(cornerRadius: AidenSettingsTokens.minimumHitSize / 2, style: .continuous))
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: selection)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }

    private func segment(_ option: Value) -> some View {
        let isSelected = option == selection
        return Button {
            selection = option
        } label: {
            Text(label(option))
                .aidenType(.rowValue)
                .fontWeight(isSelected ? .semibold : .regular)
                .foregroundStyle(isSelected ? palette.onFillAccent : palette.foreground)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: AidenSettingsTokens.minimumHitSize - 2 * AidenSpacing.xs)
                .padding(.horizontal, AidenSpacing.s)
                .background {
                    if isSelected {
                        Capsule()
                            .fill(palette.fillAccent)
                            .matchedGeometryEffect(id: "thumb", in: thumb)
                    }
                }
                .padding(AidenSpacing.xs)
                .frame(minHeight: AidenSettingsTokens.minimumHitSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: move(by: 1)
            case .decrement: move(by: -1)
            @unknown default: break
            }
        }
    }

    /// Moves the choice `offset` options along, as VoiceOver's swipe does.
    func move(by offset: Int) {
        if let next = Self.step(from: selection, by: offset, in: options), next != selection {
            selection = next
        }
    }
}

// MARK: - Swatches

/// A round colour choice. `ring` paints an inner dot (a theme's accent over
/// its canvas). The chosen swatch shows a check, never a border.
struct AidenSwatch: View {
    let fill: Color
    var ring: Color?
    let isSelected: Bool
    let label: LocalizedStringKey
    var size: CGFloat = 36
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        ZStack {
            Circle().fill(fill)
            if let ring {
                Circle().fill(ring).padding(size * 0.28)
            }
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.38, weight: .bold))
                    .foregroundStyle(palette.foreground)
                    .padding(size * 0.14)
                    .background(palette.raised, in: Circle())
            }
        }
        .frame(width: size, height: size)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Circle())
        .accessibilityElement()
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// What a swatch grid draws for one item.
struct AidenSwatchStyle {
    let fill: Color
    var ring: Color?
    let label: LocalizedStringKey
}

/// Swatches in rows of `columns`; tapping one chooses it.
struct AidenSwatchGrid<Item: Identifiable>: View {
    var columns: Int = 5
    let items: [Item]
    @Binding var selection: Item.ID
    let style: (Item) -> AidenSwatchStyle

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: AidenSpacing.s), count: max(columns, 1)),
            spacing: AidenSpacing.s
        ) {
            ForEach(items) { item in
                let look = style(item)
                Button {
                    selection = item.id
                } label: {
                    AidenSwatch(fill: look.fill, ring: look.ring, isSelected: item.id == selection, label: look.label)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Stat hero

/// One large figure with its caption, and an optional mark beside it.
struct AidenStatHero<Accessory: View>: View {
    let value: String
    let caption: LocalizedStringKey
    @ViewBuilder let accessory: () -> Accessory
    @Environment(\.aidenPalette) private var palette

    /// `value` is a figure and draws as it is; `caption` is looked up.
    init(value: String, caption: LocalizedStringKey, @ViewBuilder accessory: @escaping () -> Accessory) {
        self.value = value
        self.caption = caption
        self.accessory = accessory
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AidenSpacing.s) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: value)
                    .aidenType(.statHero)
                    .monospacedDigit()
                    .foregroundStyle(palette.foreground)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                Text(caption)
                    .aidenType(.statCaption)
                    .foregroundStyle(palette.secondary)
            }
            Spacer(minLength: 0)
            accessory()
        }
        .accessibilityElement(children: .combine)
    }
}

extension AidenStatHero where Accessory == EmptyView {
    init(value: String, caption: LocalizedStringKey) {
        self.init(value: value, caption: caption) { EmptyView() }
    }
}

// MARK: - Heatmap

/// Days as squares in rows of `columns`, a deeper accent for busier days and
/// a small dot for a day with nothing, with a Less/More legend. VoiceOver
/// reads it as one element: the caller's summary of the period.
struct AidenHeatmap<Day: Identifiable>: View {
    let days: [Day]
    var columns: Int = 10
    let value: (Day) -> Double
    let accessibilitySummary: LocalizedStringKey
    @Environment(\.aidenPalette) private var palette

    /// How strongly a day is tinted, 0...1, or nil for a day with nothing.
    /// It grows with the square root, so a quiet day next to a busy one still shows.
    nonisolated static func intensity(_ value: Double, maximum: Double) -> Double? {
        guard value > 0, maximum > 0 else { return nil }
        return 0.22 + 0.78 * min(value / maximum, 1).squareRoot()
    }

    /// The share of a square an empty day's dot fills.
    static var emptyDotScale: CGFloat { 0.3 }

    var body: some View {
        let maximum = days.map(value).max() ?? 0
        VStack(alignment: .leading, spacing: AidenSpacing.s) {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: AidenSpacing.xs), count: max(columns, 1)),
                spacing: AidenSpacing.xs
            ) {
                ForEach(days) { day in
                    cell(Self.intensity(value(day), maximum: maximum), cornerRadius: 5)
                        .aspectRatio(1, contentMode: .fit)
                }
            }
            HStack(spacing: AidenSpacing.xs) {
                Text("Less")
                ForEach(0..<5, id: \.self) { level in
                    cell(level == 0 ? nil : Self.intensity(Double(level), maximum: 4), cornerRadius: 3)
                        .frame(width: 14, height: 14)
                }
                Text("More")
            }
            .aidenType(.statCaption)
            .foregroundStyle(palette.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    /// A tinted square, or for an empty day a secondary-ink dot, which holds
    /// 3:1 on the card where a faint square would vanish.
    @ViewBuilder
    private func cell(_ intensity: Double?, cornerRadius: CGFloat) -> some View {
        if let intensity {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(palette.accent.opacity(intensity))
        } else {
            GeometryReader { proxy in
                let side = min(proxy.size.width, proxy.size.height) * Self.emptyDotScale
                Circle()
                    .fill(palette.secondary)
                    .frame(width: side, height: side)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

// MARK: - Circle icon button

/// A round, solid-filled glyph button: compose, send, start. The glyph sits
/// on the palette's solid fill, and the hit area stays 44pt.
struct AidenCircleIconButton: View {
    let symbol: String
    let label: LocalizedStringKey
    var tone: AidenSolidFillTone = .accent
    var diameter: CGFloat = 36
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: diameter * 0.42, weight: .semibold))
                .frame(width: diameter, height: diameter)
        }
        .buttonStyle(AidenSolidFillButtonStyle(tone: tone, shape: Circle(), hitSize: max(diameter, 44)))
        .accessibilityLabel(label)
    }
}
