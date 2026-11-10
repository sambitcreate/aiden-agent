import SwiftUI

// MARK: Symbol and colour presentation

extension AidenMachineSymbol {
    /// What VoiceOver says for the symbol button.
    var title: String {
        switch self {
        case .desktop: String(localized: "Desktop")
        case .laptop: String(localized: "Laptop")
        case .mini: String(localized: "Small desktop")
        case .studio: String(localized: "Tall desktop")
        case .server: String(localized: "Server rack")
        case .home: String(localized: "Home")
        case .work: String(localized: "Work")
        case .bolt: String(localized: "Bolt")
        case .flask: String(localized: "Flask")
        case .moon: String(localized: "Moon")
        case .star: String(localized: "Star")
        case .cloud: String(localized: "Cloud")
        case .game: String(localized: "Game controller")
        }
    }
}

extension AidenMachineColor {
    /// What VoiceOver says for the colour swatch, so colour is never the only signal.
    var title: String {
        switch self {
        case .blue: String(localized: "Blue")
        case .teal: String(localized: "Teal")
        case .green: String(localized: "Green")
        case .amber: String(localized: "Amber")
        case .orange: String(localized: "Orange")
        case .red: String(localized: "Red")
        case .pink: String(localized: "Pink")
        case .purple: String(localized: "Purple")
        case .slate: String(localized: "Slate")
        }
    }

    var color: Color { AidenMachineSwatch.color(hex: hex) }

    /// The symbol colour drawn on this fill: whichever of white and black reads better.
    var glyphColor: Color { AidenMachineSwatch.glyphIsLight(for: self) ? .white : .black }
}

enum AidenMachineSwatch {
    private static func components(hex: String) -> (red: Double, green: Double, blue: Double) {
        var value: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&value)
        return (
            Double((value >> 16) & 0xFF) / 255,
            Double((value >> 8) & 0xFF) / 255,
            Double(value & 0xFF) / 255
        )
    }

    static func color(hex: String) -> Color {
        let c = components(hex: hex)
        return Color(.sRGB, red: c.red, green: c.green, blue: c.blue, opacity: 1)
    }

    /// WCAG relative luminance.
    private static func luminance(hex: String) -> Double {
        func linear(_ channel: Double) -> Double {
            channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        let c = components(hex: hex)
        return 0.2126 * linear(c.red) + 0.7152 * linear(c.green) + 0.0722 * linear(c.blue)
    }

    private static func contrast(_ a: Double, _ b: Double) -> Double {
        (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    static func glyphIsLight(for color: AidenMachineColor) -> Bool {
        let fill = luminance(hex: color.hex)
        return contrast(1, fill) >= contrast(0, fill)
    }

    /// Contrast of the better of white and black against the fill. The fill is the
    /// same in light and dark, so this holds in both.
    static func glyphContrast(for color: AidenMachineColor) -> Double {
        let fill = luminance(hex: color.hex)
        return max(contrast(1, fill), contrast(0, fill))
    }
}

/// A machine's symbol on its colour.
struct AidenMachineChipImage: View {
    let symbol: AidenMachineSymbol
    let color: AidenMachineColor
    let size: CGFloat
    var symbolScale: CGFloat = 0.46
    var cornerRadius = AidenRadius.code

    var body: some View {
        Image(systemName: symbol.systemName)
            .symbolRenderingMode(.monochrome)
            .font(.system(size: size * symbolScale, weight: .semibold))
            .foregroundStyle(color.glyphColor)
            .frame(width: size, height: size)
            .background(color.color, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .accessibilityHidden(true)
    }
}

// MARK: Machine page

/// One machine: its name, symbol and colour, whether it shows in the Inbox, its
/// connection, and forgetting it. Edits save as they are made.
/// One symbol in the editor's grid. The fill says which is picked. Without colour,
/// an outline does, as on the colours.
struct AidenMachineSymbolTileFace: View {
    let symbol: AidenMachineSymbol
    let color: AidenMachineColor
    let isSelected: Bool
    let tileSize: CGFloat

    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    var body: some View {
        Image(systemName: symbol.systemName)
            .font(.title3)
            .foregroundStyle(isSelected ? color.glyphColor : Color.primary)
            .frame(maxWidth: .infinity, minHeight: tileSize)
            .background(
                isSelected ? color.color : Color(.tertiarySystemFill),
                in: RoundedRectangle(cornerRadius: AidenRadius.code, style: .continuous)
            )
            .overlay {
                if isSelected && differentiateWithoutColor {
                    RoundedRectangle(cornerRadius: AidenRadius.code, style: .continuous)
                        .strokeBorder(Color.primary, lineWidth: 2)
                        .padding(-AidenSpacing.xs)
                }
            }
            .contentShape(Rectangle())
    }
}

struct AidenMachineDetailView: View {
    let instanceId: String
    let coordinator: AidenRemoteCoordinator
    let preferences: AidenMachinePreferencesStore

    @Environment(\.dismiss) private var dismiss
    /// Nil where nothing put an Inbox store in the environment, such as a preview.
    @Environment(AidenUnifiedInboxStore.self) private var inboxStore: AidenUnifiedInboxStore?
    @State private var model: AidenMachinesModel
    @State private var draftName = ""
    @State private var loadedName = false
    @State private var showsForget = false
    @State private var failure: String?
    @State private var hapticScope = UUID()
    @FocusState private var nameIsFocused: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var scaledTileSize: CGFloat = 44
    @ScaledMetric(relativeTo: .body) private var scaledHeaderChipSize: CGFloat = 56

    // Tiles and the header symbol grow with text but stop short of filling the screen.
    private var tileSize: CGFloat { min(scaledTileSize, 64) }
    private var headerChipSize: CGFloat { min(scaledHeaderChipSize, 72) }

    init(
        instanceId: String,
        coordinator: AidenRemoteCoordinator,
        preferences: AidenMachinePreferencesStore
    ) {
        self.instanceId = instanceId
        self.coordinator = coordinator
        self.preferences = preferences
        _model = State(initialValue: AidenMachinesModel(coordinator: coordinator, preferences: preferences))
    }

    var body: some View {
        Group {
            if let row = model.row(instanceId) {
                form(for: row)
            } else if model.isLoading(instanceId) {
                ProgressView()
            } else {
                ContentUnavailableView(
                    "Machine not found",
                    systemImage: "desktopcomputer",
                    description: Text("This machine is no longer paired.")
                )
            }
        }
        .navigationTitle(model.row(instanceId)?.name ?? String(localized: "Machine"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.machineIDs) {
            model.register()
            if !loadedName, let row = model.row(instanceId) {
                draftName = row.name == row.ownName ? "" : row.name
                loadedName = true
            }
        }
        .onAppear { model.activateHaptics(scope: hapticScope) }
        .onDisappear {
            commitName()
            model.deactivateHaptics(scope: hapticScope)
        }
    }

    private func form(for row: AidenMachineRow) -> some View {
        Form {
            Section {
                let header = Group {
                    AidenMachineChipImage(symbol: row.symbol, color: row.color, size: headerChipSize)
                    Text(row.name)
                        .font(.title3.weight(.semibold))
                        .lineLimit(3)
                        .truncationMode(.tail)
                }
                // At the largest text sizes the name goes under the symbol instead of beside it.
                (dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: AidenSpacing.m))
                    : AnyLayout(HStackLayout(spacing: AidenSpacing.l))) {
                    header
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel)
                .listRowBackground(Color.clear)
            }

            Section {
                TextField("Name", text: $draftName, prompt: Text(row.ownName))
                    .accessibilityIdentifier("aiden.machine-name")
                    .focused($nameIsFocused)
                    .submitLabel(.done)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .onChange(of: draftName) { _, newValue in
                        if newValue.count > AidenMachinesModel.maxNameLength {
                            draftName = String(newValue.prefix(AidenMachinesModel.maxNameLength))
                        }
                    }
                    .onChange(of: nameIsFocused) { _, focused in
                        if !focused { commitName() }
                    }
                    .onSubmit { commitName() }
            } header: {
                Text("Name")
            } footer: {
                Text("Leave it blank to use the machine's own name, \(row.ownName). The name only changes on this phone.")
            }

            Section("Symbol") {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: tileSize + AidenSpacing.s), spacing: AidenSpacing.s)],
                    spacing: AidenSpacing.s
                ) {
                    ForEach(AidenMachineSymbol.allCases, id: \.self) { symbol in
                        symbolTile(symbol, row: row)
                    }
                }
                .padding(.vertical, AidenSpacing.xs)
            }

            Section("Colour") {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: tileSize + AidenSpacing.s), spacing: AidenSpacing.s)],
                    spacing: AidenSpacing.s
                ) {
                    ForEach(AidenMachineColor.allCases, id: \.self) { color in
                        colourTile(color, row: row)
                    }
                }
                .padding(.vertical, AidenSpacing.xs)
            }

            Section {
                Toggle("Hide from Inbox", isOn: Binding(
                    get: { row.isHidden },
                    set: { model.setHidden(instanceId, $0) }
                ))
            } footer: {
                Text("A hidden machine stays paired. Its chats leave the Inbox, and you can still open the machine from Machines.")
            }

            Section("Connection") {
                LabeledContent("Status") {
                    HStack(spacing: AidenSpacing.xs) {
                        Image(systemName: row.status.systemImage)
                            .imageScale(.small)
                            .accessibilityHidden(true)
                        Text(row.status.title)
                    }
                }
                LabeledContent("Connection", value: row.transport)
                if row.status != .online {
                    LabeledContent("Last connected", value: AidenInstallationPresentation.lastConnection(row.lastConnectedAt))
                }
                if row.workspaceCount > 0 {
                    LabeledContent("Workspaces", value: row.workspaceCount.formatted())
                }
                if let openChats = inboxStore?.openChatCount(on: instanceId) {
                    LabeledContent("Open chats", value: openChats.formatted())
                }
                LabeledContent("Identity", value: String(row.id.suffix(4)).lowercased())
                if row.offersReconnect {
                    Button {
                        Task { await model.reconnect(instanceId) }
                    } label: {
                        HStack {
                            Label("Reconnect", systemImage: "arrow.clockwise")
                            if row.isReconnecting {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(!row.canReconnect)
                }
                if row.isSelected {
                    Label("This is the default machine", systemImage: "checkmark")
                        .foregroundStyle(.secondary)
                } else {
                    Button {
                        Task { await switchToMachine() }
                    } label: {
                        Label("Make this the default machine", systemImage: "arrow.left.arrow.right")
                    }
                    .disabled(model.isBusy || coordinator.connectionState == .connecting)
                }
            }

            Section {
                Button(role: .destructive) {
                    commitName()
                    showsForget = true
                } label: {
                    Label("Forget this machine", systemImage: "trash")
                        .foregroundStyle(.red)
                }
                .disabled(model.isBusy)
            }
        }
        .confirmationDialog(
            String(localized: "Forget \(row.name)?"),
            isPresented: $showsForget,
            titleVisibility: .visible
        ) {
            Button("Forget machine", role: .destructive) {
                Task { await forget() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(model.forgetMessage(for: instanceId))
        }
        .alert(
            "Could not complete that",
            isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
    }

    // MARK: Tiles

    private func symbolTile(_ symbol: AidenMachineSymbol, row: AidenMachineRow) -> some View {
        let selected = row.symbol == symbol
        return Button {
            model.setSymbol(instanceId, symbol)
        } label: {
            AidenMachineSymbolTileFace(symbol: symbol, color: row.color, isSelected: selected, tileSize: tileSize)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(symbol.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func colourTile(_ color: AidenMachineColor, row: AidenMachineRow) -> some View {
        let selected = row.color == color
        return Button {
            model.setColor(instanceId, color)
        } label: {
            ZStack {
                Circle().fill(color.color)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.bold))
                        .foregroundStyle(color.glyphColor)
                }
            }
            .frame(width: tileSize, height: tileSize)
            .overlay {
                if selected {
                    Circle().strokeBorder(Color.primary, lineWidth: 2).padding(-AidenSpacing.xs)
                }
            }
            .frame(maxWidth: .infinity, minHeight: tileSize + AidenSpacing.s)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(color.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Actions

    private func commitName() {
        guard loadedName, model.row(instanceId) != nil else { return }
        let normalized = AidenMachinesModel.normalizedName(draftName)
        let current = preferences.preferences(for: instanceId).nameOverride
        draftName = normalized ?? ""
        guard normalized != current else { return }
        model.setName(instanceId, normalized)
    }

    private func switchToMachine() async {
        let key = "machine-switch:\(UUID().uuidString)"
        let outcome = await model.select(instanceId)
        switch outcome {
        case .success:
            model.playHaptic(.success, scope: hapticScope, key: key)
        case .failure:
            model.playHaptic(.error, scope: hapticScope, key: key)
        case .busy, .cancelled, .stale:
            break
        }
        // A switch that could not save says why through the coordinator; the machine
        // only "did not answer" when the selection itself went through.
        failure = model.failureMessage(
            for: outcome,
            fallback: String(localized: "The machine did not answer. It is now the default machine, and you can reconnect from here.")
        )
    }

    private func forget() async {
        let key = "machine-forget:\(UUID().uuidString)"
        let outcome = await model.forget(instanceId)
        switch outcome {
        case .success:
            model.playHaptic(.success, scope: hapticScope, key: key)
            dismiss()
        case .failure:
            model.playHaptic(.error, scope: hapticScope, key: key)
        case .busy, .cancelled, .stale:
            break
        }
        failure = model.failureMessage(for: outcome, fallback: String(localized: "The machine is still paired. Try again in a moment."))
    }
}
