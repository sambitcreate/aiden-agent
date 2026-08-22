import Observation
import SwiftUI

enum AidenAppearanceMode: String, CaseIterable, Identifiable, Codable, Sendable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

enum AidenThemePresetID: String, CaseIterable, Identifiable, Codable, Sendable {
    case aiden
    case slate
    case berry
    case moss

    var id: String { rawValue }

    var title: String {
        switch self {
        case .aiden: "Aiden"
        case .slate: "Slate"
        case .berry: "Berry"
        case .moss: "Moss"
        }
    }
}

enum AidenUIFontID: String, CaseIterable, Identifiable, Codable, Sendable {
    case system
    case rounded
    case humanist

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "System"
        case .rounded: "Rounded"
        case .humanist: "Humanist"
        }
    }

    func font(size: CGFloat) -> Font {
        switch self {
        case .system: .system(size: size)
        case .rounded: .system(size: size, design: .rounded)
        case .humanist: .custom("Avenir Next", size: size)
        }
    }
}

enum AidenCodeFontID: String, CaseIterable, Identifiable, Codable, Sendable {
    case sfMono = "sf-mono"
    case menlo
    case monaco

    var id: String { rawValue }

    var title: String {
        switch self {
        case .sfMono: "SF Mono"
        case .menlo: "Menlo"
        case .monaco: "Monaco"
        }
    }

    func font(size: CGFloat, relativeTo style: Font.TextStyle = .body) -> Font {
        let name = switch self {
        case .sfMono: "SFMono-Regular"
        case .menlo: "Menlo-Regular"
        case .monaco: "Monaco"
        }
        return .custom(name, size: size, relativeTo: style)
    }
}

enum AidenReduceMotionPreference: String, CaseIterable, Identifiable, Codable, Sendable {
    case system
    case on
    case off

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "Follow System"
        case .on: "On"
        case .off: "Off"
        }
    }
}

enum AidenDiffMarkerPreference: String, CaseIterable, Identifiable, Codable, Sendable {
    case color
    case symbols

    var id: String { rawValue }
    var title: String { self == .symbols ? "Symbols and color" : "Color only" }
}

struct AidenPalette: Equatable, Sendable {
    let canvasHex: String
    let sidebarHex: String
    let raisedHex: String
    let foregroundHex: String
    let secondaryHex: String
    let accentHex: String
    let successHex: String
    let warningHex: String
    let dangerHex: String

    var canvas: Color { Color(aidenHex: canvasHex) }
    var sidebar: Color { Color(aidenHex: sidebarHex) }
    var raised: Color { Color(aidenHex: raisedHex) }
    var foreground: Color { Color(aidenHex: foregroundHex) }
    var secondary: Color { Color(aidenHex: secondaryHex) }
    var accent: Color { Color(aidenHex: accentHex) }
    var success: Color { Color(aidenHex: successHex) }
    var warning: Color { Color(aidenHex: warningHex) }
    var danger: Color { Color(aidenHex: dangerHex) }

    func applyingContrast(_ contrast: Int, baseline: Int) -> AidenPalette {
        guard contrast != baseline else { return self }
        let delta = Double(contrast - baseline)
        let secondaryTarget = delta > 0 ? foregroundHex : canvasHex
        let fraction = min(abs(delta) / 100 * (delta > 0 ? 0.7 : 0.25), 0.7)
        return AidenPalette(
            canvasHex: canvasHex,
            sidebarHex: sidebarHex,
            raisedHex: raisedHex,
            foregroundHex: foregroundHex,
            secondaryHex: Color.mixHex(secondaryHex, secondaryTarget, fraction: fraction),
            accentHex: accentHex,
            successHex: successHex,
            warningHex: warningHex,
            dangerHex: dangerHex
        )
    }
}

enum AidenThemeCatalog {
    static func palette(preset: AidenThemePresetID, scheme: ColorScheme) -> AidenPalette {
        palettes[preset]![scheme == .dark ? 1 : 0]
    }

    static let palettes: [AidenThemePresetID: [AidenPalette]] = [
        .aiden: [
            .init(canvasHex: "#F6F7F9", sidebarHex: "#EEF0F3", raisedHex: "#FFFFFF", foregroundHex: "#3D3F41", secondaryHex: "#6B7280", accentHex: "#006AD6", successHex: "#30D158", warningHex: "#FF9F0A", dangerHex: "#FF453A"),
            .init(canvasHex: "#181B21", sidebarHex: "#20242C", raisedHex: "#292E37", foregroundHex: "#D1D4DA", secondaryHex: "#9AA3AE", accentHex: "#3E97F6", successHex: "#32D17A", warningHex: "#FFB020", dangerHex: "#FF5E57"),
        ],
        .slate: [
            .init(canvasHex: "#F2F5F9", sidebarHex: "#E6EBF2", raisedHex: "#FFFFFF", foregroundHex: "#3A434E", secondaryHex: "#637083", accentHex: "#087581", successHex: "#2DB67D", warningHex: "#E0A72E", dangerHex: "#E24D5B"),
            .init(canvasHex: "#181E26", sidebarHex: "#202833", raisedHex: "#29323E", foregroundHex: "#D1D6DE", secondaryHex: "#94A3BB", accentHex: "#21A9BE", successHex: "#35C08A", warningHex: "#D4A72C", dangerHex: "#F87171"),
        ],
        .berry: [
            .init(canvasHex: "#FBF4F7", sidebarHex: "#F1E8EE", raisedHex: "#FFFFFF", foregroundHex: "#443F4A", secondaryHex: "#6E6470", accentHex: "#B42C70", successHex: "#22C7A8", warningHex: "#E3A23C", dangerHex: "#E24C5A"),
            .init(canvasHex: "#1D1822", sidebarHex: "#251D2B", raisedHex: "#2E2435", foregroundHex: "#D5CFD6", secondaryHex: "#A39AA6", accentHex: "#E8629F", successHex: "#32D1B2", warningHex: "#D9A441", dangerHex: "#F0717A"),
        ],
        .moss: [
            .init(canvasHex: "#F3F6F4", sidebarHex: "#E7ECE8", raisedHex: "#FFFFFF", foregroundHex: "#3F4943", secondaryHex: "#65736B", accentHex: "#157862", successHex: "#3DBF7D", warningHex: "#D4A22A", dangerHex: "#E05353"),
            .init(canvasHex: "#18201C", sidebarHex: "#202A25", raisedHex: "#29342E", foregroundHex: "#D1D6D3", secondaryHex: "#95A39B", accentHex: "#42B596", successHex: "#47D18C", warningHex: "#D9B43A", dangerHex: "#EB6B6B"),
        ],
    ]
}

struct AidenSidebarLogo: View {
    var size: CGFloat = 24
    var color: Color? = nil

    var body: some View {
        Image("AidenSidebarLogo")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(color ?? .primary)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

@MainActor
@Observable
final class AidenAppearanceStore {
    private enum Key {
        static let mode = "aiden.appearance.mode"
        static let lightPreset = "aiden.appearance.lightPreset"
        static let darkPreset = "aiden.appearance.darkPreset"
        static let lightUIFont = "aiden.appearance.lightUIFont"
        static let darkUIFont = "aiden.appearance.darkUIFont"
        static let lightCodeFont = "aiden.appearance.lightCodeFont"
        static let darkCodeFont = "aiden.appearance.darkCodeFont"
        static let lightContrast = "aiden.appearance.lightContrast"
        static let darkContrast = "aiden.appearance.darkContrast"
        static let lightTranslucentSidebar = "aiden.appearance.lightTranslucentSidebar"
        static let darkTranslucentSidebar = "aiden.appearance.darkTranslucentSidebar"
        static let reduceMotion = "aiden.appearance.reduceMotion"
        static let uiFontSize = "aiden.appearance.uiFontSize"
        static let codeFontSize = "aiden.appearance.codeFontSize"
        static let diffMarkers = "aiden.appearance.diffMarkers"
    }

    private let defaults: UserDefaults
    var mode: AidenAppearanceMode { didSet { defaults.set(mode.rawValue, forKey: Key.mode) } }
    var lightPreset: AidenThemePresetID { didSet { defaults.set(lightPreset.rawValue, forKey: Key.lightPreset) } }
    var darkPreset: AidenThemePresetID { didSet { defaults.set(darkPreset.rawValue, forKey: Key.darkPreset) } }
    var lightUIFont: AidenUIFontID { didSet { defaults.set(lightUIFont.rawValue, forKey: Key.lightUIFont) } }
    var darkUIFont: AidenUIFontID { didSet { defaults.set(darkUIFont.rawValue, forKey: Key.darkUIFont) } }
    var lightCodeFont: AidenCodeFontID { didSet { defaults.set(lightCodeFont.rawValue, forKey: Key.lightCodeFont) } }
    var darkCodeFont: AidenCodeFontID { didSet { defaults.set(darkCodeFont.rawValue, forKey: Key.darkCodeFont) } }
    var lightContrast: Int { didSet { defaults.set(Self.clamp(lightContrast, to: 0...100), forKey: Key.lightContrast) } }
    var darkContrast: Int { didSet { defaults.set(Self.clamp(darkContrast, to: 0...100), forKey: Key.darkContrast) } }
    var lightTranslucentSidebar: Bool { didSet { defaults.set(lightTranslucentSidebar, forKey: Key.lightTranslucentSidebar) } }
    var darkTranslucentSidebar: Bool { didSet { defaults.set(darkTranslucentSidebar, forKey: Key.darkTranslucentSidebar) } }
    var reduceMotion: AidenReduceMotionPreference { didSet { defaults.set(reduceMotion.rawValue, forKey: Key.reduceMotion) } }
    var uiFontSize: Int { didSet { defaults.set(Self.clamp(uiFontSize, to: 12...18), forKey: Key.uiFontSize) } }
    var codeFontSize: Int { didSet { defaults.set(Self.clamp(codeFontSize, to: 10...18), forKey: Key.codeFontSize) } }
    var diffMarkers: AidenDiffMarkerPreference { didSet { defaults.set(diffMarkers.rawValue, forKey: Key.diffMarkers) } }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        mode = AidenAppearanceMode(rawValue: defaults.string(forKey: Key.mode) ?? "") ?? .system
        lightPreset = AidenThemePresetID(rawValue: defaults.string(forKey: Key.lightPreset) ?? "") ?? .aiden
        darkPreset = AidenThemePresetID(rawValue: defaults.string(forKey: Key.darkPreset) ?? "") ?? .aiden
        lightUIFont = AidenUIFontID(rawValue: defaults.string(forKey: Key.lightUIFont) ?? "") ?? .system
        darkUIFont = AidenUIFontID(rawValue: defaults.string(forKey: Key.darkUIFont) ?? "") ?? .system
        lightCodeFont = AidenCodeFontID(rawValue: defaults.string(forKey: Key.lightCodeFont) ?? "") ?? .sfMono
        darkCodeFont = AidenCodeFontID(rawValue: defaults.string(forKey: Key.darkCodeFont) ?? "") ?? .sfMono
        lightContrast = defaults.object(forKey: Key.lightContrast) == nil ? 45 : Self.clamp(defaults.integer(forKey: Key.lightContrast), to: 0...100)
        darkContrast = defaults.object(forKey: Key.darkContrast) == nil ? 60 : Self.clamp(defaults.integer(forKey: Key.darkContrast), to: 0...100)
        lightTranslucentSidebar = defaults.object(forKey: Key.lightTranslucentSidebar) == nil ? true : defaults.bool(forKey: Key.lightTranslucentSidebar)
        darkTranslucentSidebar = defaults.object(forKey: Key.darkTranslucentSidebar) == nil ? true : defaults.bool(forKey: Key.darkTranslucentSidebar)
        reduceMotion = AidenReduceMotionPreference(rawValue: defaults.string(forKey: Key.reduceMotion) ?? "") ?? .system
        uiFontSize = defaults.object(forKey: Key.uiFontSize) == nil ? 14 : Self.clamp(defaults.integer(forKey: Key.uiFontSize), to: 12...18)
        codeFontSize = defaults.object(forKey: Key.codeFontSize) == nil ? 12 : Self.clamp(defaults.integer(forKey: Key.codeFontSize), to: 10...18)
        diffMarkers = AidenDiffMarkerPreference(rawValue: defaults.string(forKey: Key.diffMarkers) ?? "") ?? .symbols
    }

    func palette(for scheme: ColorScheme, systemHighContrast: Bool = false) -> AidenPalette {
        let isDark = scheme == .dark
        let baseline = isDark ? 60 : 45
        let requested = (isDark ? darkContrast : lightContrast) + (systemHighContrast ? 20 : 0)
        return AidenThemeCatalog
            .palette(preset: isDark ? darkPreset : lightPreset, scheme: scheme)
            .applyingContrast(Self.clamp(requested, to: 0...100), baseline: baseline)
    }

    func uiFont(for scheme: ColorScheme) -> AidenUIFontID { scheme == .dark ? darkUIFont : lightUIFont }
    func codeFont(for scheme: ColorScheme) -> AidenCodeFontID { scheme == .dark ? darkCodeFont : lightCodeFont }
    func translucentSidebar(for scheme: ColorScheme) -> Bool { scheme == .dark ? darkTranslucentSidebar : lightTranslucentSidebar }

    func resolvedReduceMotion(system: Bool) -> Bool {
        switch reduceMotion {
        case .system: system
        case .on: true
        case .off: false
        }
    }

    private static func clamp(_ value: Int, to range: ClosedRange<Int>) -> Int {
        min(max(value, range.lowerBound), range.upperBound)
    }
}

private struct AidenPaletteEnvironmentKey: EnvironmentKey {
    static let defaultValue = AidenThemeCatalog.palette(preset: .aiden, scheme: .light)
}

private struct AidenReduceMotionEnvironmentKey: EnvironmentKey { static let defaultValue = false }
private struct AidenDiffMarkerEnvironmentKey: EnvironmentKey { static let defaultValue = AidenDiffMarkerPreference.symbols }
private struct AidenSidebarTranslucencyEnvironmentKey: EnvironmentKey { static let defaultValue = true }
private struct AidenCodeTypographyEnvironmentKey: EnvironmentKey {
    static let defaultValue = AidenCodeTypography(font: .sfMono, size: 12)
}

struct AidenCodeTypography: Equatable, Sendable {
    let font: AidenCodeFontID
    let size: Int

    func swiftUIFont(relativeTo style: Font.TextStyle = .body) -> Font {
        font.font(size: CGFloat(size), relativeTo: style)
    }
}

extension EnvironmentValues {
    var aidenPalette: AidenPalette {
        get { self[AidenPaletteEnvironmentKey.self] }
        set { self[AidenPaletteEnvironmentKey.self] = newValue }
    }

    var aidenReduceMotion: Bool {
        get { self[AidenReduceMotionEnvironmentKey.self] }
        set { self[AidenReduceMotionEnvironmentKey.self] = newValue }
    }

    var aidenDiffMarkers: AidenDiffMarkerPreference {
        get { self[AidenDiffMarkerEnvironmentKey.self] }
        set { self[AidenDiffMarkerEnvironmentKey.self] = newValue }
    }

    var aidenSidebarTranslucent: Bool {
        get { self[AidenSidebarTranslucencyEnvironmentKey.self] }
        set { self[AidenSidebarTranslucencyEnvironmentKey.self] = newValue }
    }

    var aidenCodeTypography: AidenCodeTypography {
        get { self[AidenCodeTypographyEnvironmentKey.self] }
        set { self[AidenCodeTypographyEnvironmentKey.self] = newValue }
    }
}

struct AidenAppearanceRoot<Content: View>: View {
    @Bindable var appearance: AidenAppearanceStore
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @ViewBuilder let content: () -> Content

    var body: some View {
        let effectiveScheme: ColorScheme = switch appearance.mode {
        case .system: colorScheme
        case .light: .light
        case .dark: .dark
        }
        let palette = appearance.palette(
            for: effectiveScheme,
            systemHighContrast: colorSchemeContrast == .increased
        )
        content()
            .environment(\.aidenPalette, palette)
            .environment(\.aidenReduceMotion, appearance.resolvedReduceMotion(system: systemReduceMotion))
            .environment(\.aidenDiffMarkers, appearance.diffMarkers)
            .environment(\.aidenSidebarTranslucent, appearance.translucentSidebar(for: effectiveScheme))
            .environment(\.aidenCodeTypography, AidenCodeTypography(font: appearance.codeFont(for: effectiveScheme), size: appearance.codeFontSize))
            .modifier(AidenUITypographyModifier(font: appearance.uiFont(for: effectiveScheme), size: appearance.uiFontSize))
            .preferredColorScheme(appearance.mode.colorScheme)
            .tint(palette.accent)
            .background(palette.canvas.ignoresSafeArea())
    }
}

struct AidenAppearanceSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var appearance: AidenAppearanceStore
    @AppStorage(AidenRemoteLiveActivityManager.responseExcerptPreferenceKey)
    private var showsLiveActivityResponseExcerpts = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Mode", selection: $appearance.mode) {
                        ForEach(AidenAppearanceMode.allCases) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section("Light Style") {
                    presetPicker(selection: $appearance.lightPreset, scheme: .light)
                    variantControls(
                        uiFont: $appearance.lightUIFont,
                        codeFont: $appearance.lightCodeFont,
                        contrast: $appearance.lightContrast,
                        translucentSidebar: $appearance.lightTranslucentSidebar
                    )
                }

                Section("Dark Style") {
                    presetPicker(selection: $appearance.darkPreset, scheme: .dark)
                    variantControls(
                        uiFont: $appearance.darkUIFont,
                        codeFont: $appearance.darkCodeFont,
                        contrast: $appearance.darkContrast,
                        translucentSidebar: $appearance.darkTranslucentSidebar
                    )
                }

                Section("Text and Motion") {
                    Stepper("UI size: \(appearance.uiFontSize)", value: $appearance.uiFontSize, in: 12...18)
                    Stepper("Code size: \(appearance.codeFontSize)", value: $appearance.codeFontSize, in: 10...18)
                    Picker("Reduce Motion", selection: $appearance.reduceMotion) {
                        ForEach(AidenReduceMotionPreference.allCases) { preference in
                            Text(preference.title).tag(preference)
                        }
                    }
                    Picker("Diff markers", selection: $appearance.diffMarkers) {
                        ForEach(AidenDiffMarkerPreference.allCases) { preference in
                            Text(preference.title).tag(preference)
                        }
                    }
                }

                Section {
                    Toggle("Show response excerpts on Lock Screen", isOn: $showsLiveActivityResponseExcerpts)
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("Off by default. Live Activities otherwise show only the chat title and bounded status.")
                }
            }
            .navigationTitle("Appearance")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private func variantControls(
        uiFont: Binding<AidenUIFontID>,
        codeFont: Binding<AidenCodeFontID>,
        contrast: Binding<Int>,
        translucentSidebar: Binding<Bool>
    ) -> some View {
        Picker("UI font", selection: uiFont) {
            ForEach(AidenUIFontID.allCases) { font in Text(font.title).tag(font) }
        }
        Picker("Code font", selection: codeFont) {
            ForEach(AidenCodeFontID.allCases) { font in Text(font.title).tag(font) }
        }
        VStack(alignment: .leading) {
            HStack {
                Text("Contrast")
                Spacer()
                Text("\(contrast.wrappedValue)").foregroundStyle(.secondary)
            }
            Slider(
                value: Binding(
                    get: { Double(contrast.wrappedValue) },
                    set: { contrast.wrappedValue = Int($0.rounded()) }
                ),
                in: 0...100,
                step: 1
            )
            .accessibilityLabel("Contrast")
            .accessibilityValue("\(contrast.wrappedValue) percent")
        }
        Toggle("Translucent sidebar", isOn: translucentSidebar)
    }

    private func presetPicker(
        selection: Binding<AidenThemePresetID>,
        scheme: ColorScheme
    ) -> some View {
        Picker("Style", selection: selection) {
            ForEach(AidenThemePresetID.allCases) { preset in
                let palette = AidenThemeCatalog.palette(preset: preset, scheme: scheme)
                Label {
                    Text(preset.title)
                } icon: {
                    Image(systemName: "circle.fill").foregroundStyle(palette.accent)
                }
                .tag(preset)
            }
        }
        .pickerStyle(.inline)
        .labelsHidden()
    }
}

private struct AidenUITypographyModifier: ViewModifier {
    let font: AidenUIFontID
    @ScaledMetric(relativeTo: .body) private var scaledSize: CGFloat = 14

    init(font: AidenUIFontID, size: Int) {
        self.font = font
        _scaledSize = ScaledMetric(wrappedValue: CGFloat(size), relativeTo: .body)
    }

    func body(content: Content) -> some View {
        content.font(font.font(size: scaledSize))
    }
}

extension Color {
    init(aidenHex: String) {
        let hex = aidenHex.hasPrefix("#") ? String(aidenHex.dropFirst()) : aidenHex
        let value = UInt64(hex, radix: 16) ?? 0
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }

    fileprivate static func mixHex(_ from: String, _ to: String, fraction: Double) -> String {
        let start = rgb(from)
        let end = rgb(to)
        let amount = min(max(fraction, 0), 1)
        let channels = zip(start, end).map { Int((Double($0.0) + (Double($0.1) - Double($0.0)) * amount).rounded()) }
        return String(format: "#%02X%02X%02X", channels[0], channels[1], channels[2])
    }

    private static func rgb(_ hex: String) -> [Int] {
        let clean = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let value = Int(clean, radix: 16) ?? 0
        return [(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]
    }
}
