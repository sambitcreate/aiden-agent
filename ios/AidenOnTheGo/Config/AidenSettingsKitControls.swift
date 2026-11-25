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
    private let text: String
    private let tone: AidenStatusTone
    private let symbol: String?
    private let isDimmed: Bool

    @Environment(\.aidenPalette) private var palette
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    init(_ text: String, tone: AidenStatusTone = .neutral, symbol: String? = nil, isDimmed: Bool = false) {
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
        .font(.caption.weight(.semibold))
        .foregroundStyle(Color(aidenHex: isDimmed ? palette.secondaryHex : tone.textHex(palette)))
        .lineLimit(1)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(
            Color(aidenHex: isDimmed ? palette.secondaryHex : tone.fillHex(palette))
                .opacity(AidenPalette.statusChipFillOpacity),
            in: Capsule()
        )
    }
}

// MARK: - Pill segmented control

/// A capsule track with a raised thumb under the chosen option, for two to
/// four short choices (Daily / Weekly / Monthly). VoiceOver reads it as one
/// adjustable control: swipe up or down to move the choice.
struct AidenPillSegmentedControl<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [Value]
    let accessibilityLabel: String
    let label: (Value) -> String

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Namespace private var thumb

    init(
        selection: Binding<Value>,
        options: [Value],
        accessibilityLabel: String,
        label: @escaping (Value) -> String
    ) {
        _selection = selection
        self.options = options
        self.accessibilityLabel = accessibilityLabel
        self.label = label
    }

    /// The option `offset` steps from `current`, held at the ends. An unknown
    /// current value starts from the first option.
    static func step(from current: Value, by offset: Int, in options: [Value]) -> Value? {
        guard !options.isEmpty else { return nil }
        let index = options.firstIndex(of: current) ?? 0
        return options[min(max(index + offset, 0), options.count - 1)]
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.self) { option in
                Button {
                    choose(option)
                } label: {
                    Text(label(option))
                        .aidenType(.rowValue)
                        .fontWeight(option == selection ? .semibold : .regular)
                        .foregroundStyle(option == selection ? palette.foreground : palette.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, minHeight: 32)
                        .padding(.horizontal, AidenSpacing.s)
                        .background {
                            if option == selection {
                                Capsule()
                                    .fill(palette.raised)
                                    .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
                                    .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(AidenSpacing.xs)
        .background(palette.sidebar, in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(label(selection))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: move(by: 1)
            case .decrement: move(by: -1)
            @unknown default: break
            }
        }
    }

    private func move(by offset: Int) {
        if let next = Self.step(from: selection, by: offset, in: options) { choose(next) }
    }

    private func choose(_ option: Value) {
        guard option != selection else { return }
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { selection = option }
    }
}

// MARK: - Swatches

/// A round colour choice. `ring` paints an inner dot (a theme's accent over
/// its canvas). The chosen swatch shows a check, never a border.
struct AidenSwatch: View {
    let fill: Color
    var ring: Color?
    let isSelected: Bool
    let label: String
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
    let label: String
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
    let caption: String
    @ViewBuilder let accessory: () -> Accessory
    @Environment(\.aidenPalette) private var palette

    init(value: String, caption: String, @ViewBuilder accessory: @escaping () -> Accessory) {
        self.value = value
        self.caption = caption
        self.accessory = accessory
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AidenSpacing.s) {
            VStack(alignment: .leading, spacing: 2) {
                Text(value)
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
    init(value: String, caption: String) {
        self.init(value: value, caption: caption) { EmptyView() }
    }
}

// MARK: - Heatmap

/// Days as squares in rows of `columns`, darker accent for busier days, with
/// a Less/More legend. Each square says its own label to VoiceOver.
struct AidenHeatmap<Day: Identifiable>: View {
    let days: [Day]
    var columns: Int = 10
    let value: (Day) -> Double
    let label: (Day) -> String
    @Environment(\.aidenPalette) private var palette

    /// How strongly a day is tinted, 0...1, or nil for a day with nothing.
    /// It grows with the square root, so a quiet day next to a busy one still shows.
    static func intensity(_ value: Double, maximum: Double) -> Double? {
        guard value > 0, maximum > 0 else { return nil }
        return 0.22 + 0.78 * min(value / maximum, 1).squareRoot()
    }

    var body: some View {
        let maximum = days.map(value).max() ?? 0
        VStack(alignment: .leading, spacing: AidenSpacing.s) {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: AidenSpacing.xs), count: max(columns, 1)),
                spacing: AidenSpacing.xs
            ) {
                ForEach(days) { day in
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(cellColor(Self.intensity(value(day), maximum: maximum)))
                        .aspectRatio(1, contentMode: .fit)
                        .accessibilityElement()
                        .accessibilityLabel(label(day))
                }
            }
            HStack(spacing: AidenSpacing.xs) {
                Text("Less")
                ForEach(0..<5, id: \.self) { level in
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(cellColor(level == 0 ? nil : 0.22 + 0.78 * (Double(level) / 4)))
                        .frame(width: 14, height: 14)
                }
                Text("More")
            }
            .aidenType(.statCaption)
            .foregroundStyle(palette.secondary)
            .accessibilityHidden(true)
        }
    }

    private func cellColor(_ intensity: Double?) -> Color {
        guard let intensity else { return palette.sidebar }
        return palette.accent.opacity(intensity)
    }
}

// MARK: - Circle icon button

/// A round, solid-filled glyph button: compose, send, start. The glyph sits
/// on the palette's solid fill, and the hit area stays 44pt.
struct AidenCircleIconButton: View {
    let symbol: String
    let label: String
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
