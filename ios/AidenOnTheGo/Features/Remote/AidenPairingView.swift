import AVFoundation
import SwiftUI

struct AidenDiscoveredAgent: Identifiable, Equatable {
    let id: String
    let name: String
    let endpoint: String?
}

enum AidenPairingAlertCopy {
    static let title = String(localized: "Aiden On The Go")
    static let fallbackMessage = String(localized: "Try again from Aiden Agent Remote Access settings.")
}

enum AidenDiscoveryIdentity {
    static func instanceID(fromTXTRecord data: Data?) -> String? {
        guard let data,
              let value = NetService.dictionary(fromTXTRecord: data)["instance"],
              let instanceID = String(data: value, encoding: .utf8),
              !instanceID.isEmpty,
              instanceID.unicodeScalars.count <= AidenRemoteProtocol.maxIdentifierLength,
              instanceID.unicodeScalars.allSatisfy({
                  CharacterSet.alphanumerics.contains($0)
                      || CharacterSet(charactersIn: "_-").contains($0)
              }) else { return nil }
        return instanceID
    }
}

final class AidenDiscoveryModel: NSObject, ObservableObject, NetServiceBrowserDelegate, NetServiceDelegate {
    @Published private(set) var agents: [AidenDiscoveredAgent] = []
    @Published private(set) var isSearching = false

    private let browser = NetServiceBrowser()
    private var services: [String: NetService] = [:]

    override init() {
        super.init()
        browser.delegate = self
    }

    func start() {
        guard !isSearching else { return }
        isSearching = true
        browser.searchForServices(ofType: "_aiden-agent._tcp.", inDomain: "local.")
    }

    func stop() {
        browser.stop()
        isSearching = false
    }

    func netServiceBrowserWillSearch(_ browser: NetServiceBrowser) {
        isSearching = true
    }

    func netServiceBrowserDidStopSearch(_ browser: NetServiceBrowser) {
        isSearching = false
    }

    func netServiceBrowser(
        _ browser: NetServiceBrowser,
        didNotSearch errorDict: [String: NSNumber]
    ) {
        isSearching = false
    }

    func netServiceBrowser(
        _ browser: NetServiceBrowser,
        didFind service: NetService,
        moreComing: Bool
    ) {
        services[service.name] = service
        service.delegate = self
        service.resolve(withTimeout: 5)
        if !moreComing { publish() }
    }

    func netServiceBrowser(
        _ browser: NetServiceBrowser,
        didRemove service: NetService,
        moreComing: Bool
    ) {
        services[service.name] = nil
        if !moreComing { publish() }
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        publish()
    }

    private func publish() {
        agents = services.values.map { service in
            let endpoint: String?
            if let hostName = service.hostName?.trimmingCharacters(in: CharacterSet(charactersIn: ".")),
               !hostName.isEmpty,
               service.port > 0 {
                endpoint = "https://\(hostName):\(service.port)\(AidenRemoteProtocol.basePath)"
            } else {
                endpoint = nil
            }
            return AidenDiscoveredAgent(
                id: AidenDiscoveryIdentity.instanceID(fromTXTRecord: service.txtRecordData())
                    ?? "\(service.domain)|\(service.type)|\(service.name)",
                name: service.name,
                endpoint: endpoint
            )
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

enum AidenPairingMethod: String, CaseIterable, Identifiable, Hashable {
    case scanQRCode
    case nearbyMac
    case privateAddress
    case pastePayload

    var id: String { rawValue }

    static let primary: [AidenPairingMethod] = [
        .scanQRCode,
        .nearbyMac,
        .privateAddress,
    ]

    static let advanced: [AidenPairingMethod] = [.pastePayload]

    var tabTitle: String {
        switch self {
        case .scanQRCode: return String(localized: "QR")
        case .nearbyMac: return String(localized: "Nearby")
        case .privateAddress: return String(localized: "Tailscale")
        case .pastePayload: return String(localized: "Payload")
        }
    }

    var title: String {
        switch self {
        case .scanQRCode: return String(localized: "Scan QR Code")
        case .nearbyMac: return String(localized: "Nearby Mac + Setup Code")
        case .privateAddress: return String(localized: "Private Address + Setup Code")
        case .pastePayload: return String(localized: "Paste Pairing Payload")
        }
    }

    var detail: String {
        switch self {
        case .scanQRCode:
            return String(localized: "Scan the one-time QR shown by Aiden Agent.")
        case .nearbyMac:
            return String(localized: "Find your Mac on local Wi-Fi, then enter its setup code.")
        case .privateAddress:
            return String(localized: "Enter the private Tailscale address and setup code shown on your Mac.")
        case .pastePayload:
            return String(localized: "Use the complete one-time payload when the camera is unavailable.")
        }
    }

    var systemImage: String {
        switch self {
        case .scanQRCode: return "qrcode.viewfinder"
        case .nearbyMac: return "wifi"
        case .privateAddress: return "network"
        case .pastePayload: return "doc.on.clipboard"
        }
    }

    var badge: String? {
        switch self {
        case .scanQRCode: return String(localized: "Recommended")
        case .nearbyMac: return String(localized: "Local Network")
        case .privateAddress: return String(localized: "Tailscale")
        case .pastePayload: return nil
        }
    }
}

enum AidenMobileOnboardingPhase: String, CaseIterable, Identifiable, Hashable {
    case build
    case extend
    case control

    var id: String { rawValue }

    var eyebrow: String {
        switch self {
        case .build: return String(localized: "BOTS AND WORKSPACES")
        case .extend: return String(localized: "CHOOSE AND EXTEND")
        case .control: return String(localized: "AUTOMATE AND STAY IN CONTROL")
        }
    }

    var title: String {
        switch self {
        case .build: return String(localized: "Choose how Aiden helps")
        case .extend: return String(localized: "Bring the right intelligence")
        case .control: return String(localized: "Keep Aiden moving")
        }
    }

    var detail: String {
        switch self {
        case .build:
            return String(localized: "Use Workspaces for project-focused work with files, commands, review, and Git. When Bots are available on your paired Mac, use them as reusable helpers and tap the Aiden logo to switch.")
        case .extend:
            return String(localized: "Choose models and thinking levels, attach images, use web search, and extend Aiden with skills and MCP connectors.")
        case .control:
            return String(localized: "Approve actions, manage scheduled work, use voice, and follow private usage from your iPhone or iPad.")
        }
    }

    var imageName: String {
        switch self {
        case .build: return "OnboardingBuild"
        case .extend: return "OnboardingExtend"
        case .control: return "OnboardingControl"
        }
    }
}

enum AidenMobileOnboardingLayout {
    static let maximumContentWidth: CGFloat = 620
    static let maximumContentHeight: CGFloat = 760
    static let maximumActionWidth: CGFloat = 360
    static let actionHorizontalPadding: CGFloat = 24
    static let actionBottomPadding: CGFloat = 12
    static let artworkSide: CGFloat = 232

    static func contentWidth(for availableWidth: CGFloat) -> CGFloat {
        max(0, min(availableWidth, maximumContentWidth))
    }

    static func contentHeight(for availableHeight: CGFloat) -> CGFloat {
        max(0, min(availableHeight, maximumContentHeight))
    }
}

struct AidenPairingView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Environment(AidenAppearanceStore.self) private var appearance
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenCodeTypography) private var codeTypography
    var onPaired: (() -> Void)?

    @StateObject private var discovery = AidenDiscoveryModel()
    @State private var pairingPayload = ""
    @State private var manualCode = ""
    @State private var manualEndpoint = ""
    @State private var selectedAgentID: String?
    @State private var selectedPairingMethod: AidenPairingMethod = .scanQRCode
    @State private var selectedOnboardingPhase: AidenMobileOnboardingPhase = .build
    @State private var isShowingScanner = false
    @State private var isShowingAppearance = false
    @State private var isShowingPayloadFallback = false
    @State private var pairingTask: Task<Void, Never>?
    @State private var step: Int

    private let onIntroductionComplete: (() -> Void)?

    init(
        coordinator: AidenRemoteCoordinator,
        showsIntroduction: Bool = true,
        onIntroductionComplete: (() -> Void)? = nil,
        onPaired: (() -> Void)? = nil
    ) {
        self.coordinator = coordinator
        self.onIntroductionComplete = onIntroductionComplete
        self.onPaired = onPaired
        _step = State(initialValue: onPaired == nil && showsIntroduction ? 0 : 2)
    }

    private var canPair: Bool {
        !pairingPayload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !coordinator.isMutating
    }

    private var manualEndpointURL: URL? {
        let value = manualEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isCanonicalAidenEndpoint(value) else { return nil }
        return URL(string: value)
    }

    private var canPairManually: Bool {
        (try? AidenRemoteClient.normalizeManualPairingCode(manualCode)) != nil
            && manualEndpointURL != nil
            && !coordinator.isMutating
    }

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case 0: welcomePage
                case 1: preparePage
                default: pairingPage
                }
            }
            .background(palette.canvas)
            .toolbar {
                if step > 0 && onPaired == nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { step -= 1 } label: { Image(systemName: "chevron.left") }
                            .accessibilityLabel("Back")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if step == 2 {
                        Menu {
                            Button {
                                isShowingPayloadFallback = true
                            } label: {
                                Label("Paste Pairing Payload", systemImage: "doc.on.clipboard")
                            }
                            Button {
                                isShowingAppearance = true
                            } label: {
                                Label("Appearance", systemImage: "circle.lefthalf.filled")
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                        .accessibilityLabel("More pairing options")
                    } else {
                        Button {
                            isShowingAppearance = true
                        } label: {
                            Image(systemName: "circle.lefthalf.filled")
                        }
                        .accessibilityLabel("Appearance")
                    }
                }
            }
            .overlay {
                if coordinator.isMutating {
                    ProgressView("Pairing…")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .task(id: step) {
                if step == 2 {
                    discovery.start()
                } else {
                    discovery.stop()
                }
            }
            .onDisappear {
                pairingTask?.cancel()
                pairingTask = nil
                discovery.stop()
                pairingPayload = ""
                manualCode = ""
                manualEndpoint = ""
                selectedAgentID = nil
            }
            .sheet(isPresented: $isShowingScanner) {
                NavigationStack {
                    AidenQRCodeScanner { payload in
                        pairingPayload = payload
                        isShowingScanner = false
                        startPairing { await coordinator.pair(qrPayload: payload) }
                    }
                    .ignoresSafeArea(edges: .bottom)
                    .navigationTitle("Scan Pairing QR")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { isShowingScanner = false }
                        }
                    }
                }
            }
            .sheet(isPresented: $isShowingAppearance) {
                AidenAppearanceSettingsView(appearance: appearance)
            }
            .sheet(isPresented: $isShowingPayloadFallback) {
                NavigationStack {
                    pastePayloadPairingPage
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { isShowingPayloadFallback = false }
                            }
                        }
                }
            }
            .alert(
                AidenPairingAlertCopy.title,
                isPresented: Binding(
                    get: { coordinator.presentedError != nil },
                    set: { if !$0 { coordinator.presentedError = nil } }
                )
            ) {
                Button("OK", role: .cancel) { coordinator.presentedError = nil }
            } message: {
                Text(coordinator.presentedError ?? AidenPairingAlertCopy.fallbackMessage)
            }
        }
    }

    private var welcomePage: some View {
        GeometryReader { proxy in
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image("AidenAppIcon")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 42, height: 42)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Aiden On The Go")
                            .font(.headline)
                        Text("Aiden, wherever you are.")
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                    }
                    Spacer()
                }
                .padding(.horizontal, 24)
                .padding(.top, 16)

                TabView(selection: $selectedOnboardingPhase) {
                    ForEach(AidenMobileOnboardingPhase.allCases) { phase in
                        onboardingPhasePage(phase)
                            .tag(phase)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .accessibilityLabel("Aiden capabilities")

            }
            .frame(
                width: AidenMobileOnboardingLayout.contentWidth(for: proxy.size.width),
                height: AidenMobileOnboardingLayout.contentHeight(for: proxy.size.height)
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 12) {
                onboardingPageIndicator
                onboardingActionButton(action: advanceOnboarding) {
                    Text(isOnboardingLastPage ? "Set Up Connection" : "Continue")
                }
            }
            .padding(.bottom, AidenMobileOnboardingLayout.actionBottomPadding)
        }
        .navigationBarHidden(true)
    }

    private func onboardingPhasePage(_ phase: AidenMobileOnboardingPhase) -> some View {
        ViewThatFits(in: .vertical) {
            VStack(spacing: 0) {
                Spacer(minLength: 16)
                onboardingPhaseContent(phase)
                Spacer(minLength: 16)
            }

            ScrollView {
                onboardingPhaseContent(phase)
                    .padding(.vertical, 16)
            }
            .scrollIndicators(.hidden)
        }
    }

    private func onboardingPhaseContent(_ phase: AidenMobileOnboardingPhase) -> some View {
        VStack(spacing: 22) {
            ZStack {
                Circle()
                    .fill(palette.accent.opacity(0.07))
                    .frame(
                        width: AidenMobileOnboardingLayout.artworkSide,
                        height: AidenMobileOnboardingLayout.artworkSide
                    )
                Circle()
                    .stroke(palette.accent.opacity(0.14), lineWidth: 1)
                    .frame(width: 196, height: 196)
                Image(phase.imageName)
                    .resizable()
                    .scaledToFit()
                    .frame(
                        maxWidth: AidenMobileOnboardingLayout.artworkSide,
                        maxHeight: AidenMobileOnboardingLayout.artworkSide
                    )
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity)

            VStack(spacing: 10) {
                Text(phase.eyebrow)
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(palette.accent)
                Text(phase.title)
                    .font(.title.bold())
                    .multilineTextAlignment(.center)
                Text(phase.detail)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: 480)
            .padding(.horizontal, 26)
        }
        .frame(maxWidth: .infinity)
    }

    private var isOnboardingLastPage: Bool {
        selectedOnboardingPhase == AidenMobileOnboardingPhase.allCases.last
    }

    private var onboardingPageIndicator: some View {
        HStack(spacing: 4) {
            ForEach(AidenMobileOnboardingPhase.allCases) { phase in
                Button {
                    selectedOnboardingPhase = phase
                } label: {
                    Capsule()
                        .fill(phase == selectedOnboardingPhase ? palette.accent : palette.secondary.opacity(0.24))
                        .frame(width: phase == selectedOnboardingPhase ? 22 : 7, height: 7)
                        .frame(width: 34, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(phase.title)
                .accessibilityValue(phase == selectedOnboardingPhase ? "Current page" : "")
            }
        }
    }

    private func advanceOnboarding() {
        if isOnboardingLastPage {
            step = 1
        } else if let index = AidenMobileOnboardingPhase.allCases.firstIndex(of: selectedOnboardingPhase) {
            selectedOnboardingPhase = AidenMobileOnboardingPhase.allCases[index + 1]
        }
    }

    private func onboardingActionButton<Label: View>(
        action: @escaping () -> Void,
        @ViewBuilder label: () -> Label
    ) -> some View {
        prominentGlassButton(action: action, label: label)
            .frame(maxWidth: AidenMobileOnboardingLayout.maximumActionWidth)
            .padding(.horizontal, AidenMobileOnboardingLayout.actionHorizontalPadding)
    }

    @ViewBuilder
    private func prominentGlassButton<Label: View>(
        action: @escaping () -> Void,
        @ViewBuilder label: () -> Label
    ) -> some View {
        let button = Button(action: action) {
            label()
                .frame(maxWidth: .infinity)
        }
        .font(.headline)
        .frame(maxWidth: .infinity)
        .controlSize(.large)

        if #available(iOS 26, *) {
            button.buttonStyle(.glassProminent)
        } else {
            button.buttonStyle(.borderedProminent)
        }
    }

    private var preparePage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Prepare your Mac").font(.largeTitle.bold())
                    Text("Aiden Agent remains the server and keeps provider credentials on your Mac.")
                        .foregroundStyle(palette.secondary)
                }

                pairingStep(number: 1, title: "Open Aiden Agent", detail: "On your Mac, go to Settings → Remote Access.")
                pairingStep(number: 2, title: "Turn on Remote Access", detail: "Choose Local Network, Tailscale, or both. Tailscale is best when you are away from home.")
                pairingStep(number: 3, title: "Create a pairing code", detail: "Keep the QR or setup code visible. Both expire after five minutes and can be used once.")

                VStack(alignment: .leading, spacing: 10) {
                    Label("Per-device credential", systemImage: "key.fill")
                    Label("Pinned HTTPS identity", systemImage: "lock.shield.fill")
                    Label("Revocable from your Mac", systemImage: "checkmark.shield")
                }
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
            }
            .frame(maxWidth: AidenMobileOnboardingLayout.maximumContentWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(24)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            onboardingActionButton(action: {
                onIntroductionComplete?()
                step = 2
            }) {
                Text("Choose How to Connect")
            }
            .padding(.bottom, AidenMobileOnboardingLayout.actionBottomPadding)
        }
        .navigationTitle("Connect")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func pairingStep(number: Int, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Text("\(number)")
                .font(.caption.bold())
                .foregroundStyle(palette.canvas)
                .frame(width: 26, height: 26)
                .background(palette.accent, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(palette.secondary)
            }
        }
    }

    private var pairingPage: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Choose the connection shown in Aiden Agent’s Add Device window.")
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Picker("Connection method", selection: $selectedPairingMethod) {
                    ForEach(AidenPairingMethod.primary) { method in
                        Text(method.tabTitle).tag(method)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityHint("Swipe the content below or choose a tab.")
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 10)

            TabView(selection: $selectedPairingMethod) {
                qrPairingPage.tag(AidenPairingMethod.scanQRCode)
                nearbyMacPairingPage.tag(AidenPairingMethod.nearbyMac)
                privateAddressPairingPage.tag(AidenPairingMethod.privateAddress)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .accessibilityLabel("Connection setup")
        }
        .background(palette.canvas)
        .navigationTitle("Pair Aiden")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: discovery.agents) { _, agents in
            guard let selectedAgentID else { return }
            guard let selected = agents.first(where: { $0.id == selectedAgentID }),
                  selected.endpoint == manualEndpoint else {
                self.selectedAgentID = nil
                return
            }
        }
    }

    private var qrPairingPage: some View {
        Form {
            Section {
                Label("Open Aiden Agent’s Add Device window and keep the one-time QR visible.", systemImage: "desktopcomputer")
                Label("The QR already contains the selected Local Network or Tailscale address.", systemImage: "network")
            } header: {
                Text("On your Mac")
            }

            Section("Private pairing") {
                Text("The QR expires after five minutes and can be used once. Aiden pins the Mac’s HTTPS identity during pairing.")
                    .foregroundStyle(palette.secondary)
            }
        }
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            onboardingActionButton(action: { isShowingScanner = true }) {
                Label("Open Camera", systemImage: "qrcode.viewfinder")
            }
            .padding(.bottom, AidenMobileOnboardingLayout.actionBottomPadding)
        }
    }

    private var nearbyMacPairingPage: some View {
        Form {
            Section {
                if discovery.agents.isEmpty {
                    HStack(spacing: 10) {
                        if discovery.isSearching { ProgressView() }
                        Text(discovery.isSearching ? "Looking for Aiden Agent…" : "No nearby Aiden Agent found")
                            .foregroundStyle(palette.secondary)
                    }
                } else {
                    ForEach(discovery.agents) { agent in
                        discoveredAgentButton(agent)
                    }
                }
            } header: {
                Text("Nearby Macs")
            } footer: {
                Text("Your iPhone or iPad and Mac must be on the same local network. Select the Mac shown in Aiden Agent’s Add Device window.")
            }

            Section {
                manualEndpointField(
                    placeholder: "https://mac-name.local:49220/api/aiden/v1",
                    accessibilityLabel: "Nearby Aiden Agent address"
                )
                manualSetupCodeField
                manualPairingButton
            } header: {
                Text("Setup code")
            } footer: {
                Text("If discovery is unavailable, enter the exact nearby Mac address shown in Aiden Agent. The setup code is encrypted and can be used once.")
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
    }

    private var privateAddressPairingPage: some View {
        Form {
            Section {
                manualEndpointField(
                    placeholder: "https://mac-name.tailnet.ts.net/api/aiden/v1",
                    accessibilityLabel: "Private Tailscale address"
                )
                manualSetupCodeField
                manualPairingButton
            } header: {
                Text("Private address and setup code")
            } footer: {
                Text("Copy both values exactly from Aiden Agent. The private address must use HTTPS and end in /api/aiden/v1. Your setup code never leaves this device.")
            }

            Section("Before pairing") {
                Label("Sign in to the same Tailscale network on both devices", systemImage: "network")
                Label("Keep Aiden Agent open on your Mac", systemImage: "desktopcomputer")
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
    }

    private var pastePayloadPairingPage: some View {
        Form {
            Section {
                PasteButton(payloadType: String.self) { values in
                    if let payload = values.first { pairingPayload = payload }
                }

                TextEditor(text: $pairingPayload)
                    .frame(minHeight: 120)
                    .font(codeTypography.swiftUIFont(relativeTo: .footnote))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Full pairing setup payload")

                Button("Pair with Setup Payload") {
                    let payload = pairingPayload.trimmingCharacters(in: .whitespacesAndNewlines)
                    startPairing { await coordinator.pair(qrPayload: payload) }
                }
                .disabled(!canPair)
            } header: {
                Text("One-time pairing payload")
            } footer: {
                Text("Use only the complete payload copied from your own Mac. It contains a one-time secret and expires after five minutes.")
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Paste Payload")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func discoveredAgentButton(_ agent: AidenDiscoveredAgent) -> some View {
        Button {
            guard let endpoint = agent.endpoint else { return }
            selectedAgentID = agent.id
            manualEndpoint = endpoint
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Label(agent.name, systemImage: "desktopcomputer")
                    if let endpoint = agent.endpoint {
                        Text(endpoint)
                            .font(codeTypography.swiftUIFont(relativeTo: .caption))
                            .foregroundStyle(palette.secondary)
                    }
                }
                Spacer()
                if selectedAgentID == agent.id {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(palette.accent)
                        .accessibilityHidden(true)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(agent.endpoint == nil)
        .accessibilityLabel(agent.endpoint.map { "\(agent.name), \($0)" } ?? agent.name)
        .accessibilityValue(selectedAgentID == agent.id ? "Selected" : "Not selected")
        .accessibilityAddTraits(selectedAgentID == agent.id ? .isSelected : [])
        .accessibilityHint(agent.endpoint == nil
            ? "This Mac is still resolving its network address."
            : "Use this Mac for setup-code pairing.")
    }

    private func manualEndpointField(
        placeholder: String,
        accessibilityLabel: String
    ) -> some View {
        TextField(placeholder, text: $manualEndpoint)
            .font(codeTypography.swiftUIFont(relativeTo: .footnote))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .accessibilityLabel(accessibilityLabel)
            .onChange(of: manualEndpoint) { _, value in
                guard let selectedAgentID else { return }
                let selectedEndpoint = discovery.agents.first {
                    $0.id == selectedAgentID
                }?.endpoint
                if selectedEndpoint != value { self.selectedAgentID = nil }
            }
    }

    private var manualSetupCodeField: some View {
        TextField("XXXX-XXXX-XXXX-XXXX-XXXX", text: $manualCode)
            .font(codeTypography.swiftUIFont(relativeTo: .body))
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .keyboardType(.asciiCapable)
            .onChange(of: manualCode) { _, value in
                manualCode = formattedManualCodeInput(value)
            }
            .accessibilityLabel("Manual pairing setup code")
    }

    private var manualPairingButton: some View {
        Button("Pair with Setup Code") {
            guard let endpoint = manualEndpointURL else { return }
            let code = manualCode
            startPairing {
                await coordinator.pair(manualCode: code, endpoint: endpoint)
            }
        }
        .disabled(!canPairManually)
    }

    private func formattedManualCodeInput(_ value: String) -> String {
        guard value.unicodeScalars.allSatisfy({ scalar in
            scalar.isASCII && (scalar.value == 32 || scalar.value == 45
                || (48...57).contains(scalar.value)
                || (65...90).contains(scalar.value)
                || (97...122).contains(scalar.value))
        }) else { return value }
        let allowed = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        let characters = value
            .uppercased()
            .filter { $0 != "-" && $0 != " " }
            .prefix(20)
        guard characters.allSatisfy(allowed.contains) else { return value }
        return stride(from: 0, to: characters.count, by: 4).map { start in
            let lower = characters.index(characters.startIndex, offsetBy: start)
            let upper = characters.index(
                lower,
                offsetBy: min(4, characters.count - start),
                limitedBy: characters.endIndex
            ) ?? characters.endIndex
            return String(characters[lower..<upper])
        }.joined(separator: "-")
    }

    private func startPairing(
        operation: @escaping @MainActor () async -> AidenPairingAttemptResult
    ) {
        guard pairingTask == nil else { return }
        pairingTask = Task { @MainActor in
            let result = await operation()
            guard !Task.isCancelled else {
                pairingTask = nil
                return
            }
            if result == .succeeded {
                pairingPayload = ""
                manualCode = ""
                manualEndpoint = ""
                selectedAgentID = nil
                onPaired?()
            }
            pairingTask = nil
        }
    }
}

private struct AidenQRCodeScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> AidenQRCodeScannerViewController {
        let controller = AidenQRCodeScannerViewController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ uiViewController: AidenQRCodeScannerViewController, context: Context) {}
}

private final class AidenQRCodeScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var deliveredCode = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        requestCameraAndConfigure()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [session] in session.stopRunning() }
        }
    }

    private func requestCameraAndConfigure() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                guard granted else { return }
                DispatchQueue.main.async { self?.configureSession() }
            }
        default:
            showCameraUnavailable()
        }
    }

    private func configureSession() {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else {
            showCameraUnavailable()
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            showCameraUnavailable()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer

        DispatchQueue.global(qos: .userInitiated).async { [session] in session.startRunning() }
    }

    private func showCameraUnavailable() {
        let label = UILabel()
        label.text = "Camera access is required to scan the pairing QR. You can paste the pairing payload instead."
        label.textColor = .white
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !deliveredCode,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let value = object.stringValue else { return }
        deliveredCode = true
        session.stopRunning()
        onCode?(value)
    }
}
