import AVFoundation
import SwiftUI
import UIKit

struct AidenDiscoveredAgent: Identifiable, Equatable {
    let id: String
    let name: String
    let endpoint: String?
}

enum AidenPairingAlertCopy {
    static let title = String(localized: "Aiden On The Go")
    static let fallbackMessage = String(localized: "Try again from Aiden Agent → Settings → Connections.")
}

enum AidenDesktopDownloadLinks {
    static let macURL = URL(string: "https://chatwithaiden.com/")!
    static let linuxURL = URL(string: "https://github.com/sambitcreate/aiden-agent")!
    static let serverURL = URL(string: "https://github.com/sambitcreate/aiden-agent")!
}

enum AidenPairingSubmission: Equatable {
    case payload(String)
    case manual(endpoint: URL, code: String)
}

enum AidenPairingInputParser {
    private static let allowedCodeScalars = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// Detects a full one-time pairing payload pasted into either input field.
    static func fullPayload(from raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.hasPrefix("{")
            || trimmed.hasPrefix("aiden-otg:")
            || trimmed.hasPrefix("aiden-pair:") else {
            return nil
        }
        guard let data = trimmed.data(using: .utf8),
              (try? AidenRemoteJSONDecoder.decodePairingPayload(from: data)) != nil else {
            return trimmed.hasPrefix("{") ? trimmed : nil
        }
        return trimmed
    }

    /// Normalizes a canonical URL or bare host[:port] (e.g. `mac.local:49220` or
    /// `mac.tailnet.ts.net`) into a validated canonical `https://.../api/aiden/v1` URL.
    /// Rejects plaintext `http://` and malformed endpoints.
    static func normalizedEndpointURL(from raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if isCanonicalAidenEndpoint(trimmed) {
            return URL(string: trimmed)
        }
        let lowercased = trimmed.lowercased()
        if lowercased.hasPrefix("http://") {
            return nil
        }

        var candidate = trimmed
        if !candidate.contains("://") {
            candidate = "https://\(candidate)"
        }
        while candidate.hasSuffix("/") {
            candidate.removeLast()
        }
        if !candidate.hasSuffix(AidenRemoteProtocol.basePath) {
            candidate += AidenRemoteProtocol.basePath
        }
        guard isCanonicalAidenEndpoint(candidate) else { return nil }
        return URL(string: candidate)
    }

    /// Formats a 20-character Crockford Base32 manual pairing code as 4-character
    /// groups without mangling a pasted JSON/URI payload.
    static func formattedManualCodeInput(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{") || trimmed.hasPrefix("aiden-") {
            return value
        }
        guard value.unicodeScalars.allSatisfy({ scalar in
            scalar.isASCII && (scalar.value == 32 || scalar.value == 45
                || (48...57).contains(scalar.value)
                || (65...90).contains(scalar.value)
                || (97...122).contains(scalar.value))
        }) else { return value }
        let characters = value
            .uppercased()
            .filter { $0 != "-" && $0 != " " }
            .prefix(20)
        guard characters.allSatisfy(allowedCodeScalars.contains) else { return value }
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

    /// Resolves whether the current Address + Code fields can be submitted as a
    /// full pasted payload or as a manual endpoint + setup code pair.
    static func submission(address: String, code: String) -> AidenPairingSubmission? {
        if let payload = fullPayload(from: code) ?? fullPayload(from: address) {
            return .payload(payload)
        }
        guard let endpoint = normalizedEndpointURL(from: address),
              (try? AidenRemoteClient.normalizeManualPairingCode(code)) != nil else {
            return nil
        }
        return .manual(endpoint: endpoint, code: code)
    }

    /// Compact display form for a Bonjour-resolved endpoint (`host:port`).
    static func compactDisplayAddress(_ endpoint: String) -> String {
        var value = endpoint
        if value.hasPrefix("https://") {
            value.removeFirst("https://".count)
        }
        if value.hasSuffix(AidenRemoteProtocol.basePath) {
            value.removeLast(AidenRemoteProtocol.basePath.count)
        }
        return value
    }
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

/// Calm zero-computer empty state shared across the shell tabs.
struct AidenNoComputersEmptyView: View {
    enum Surface {
        case inbox
        case bots
        case workspaces
        case search

        var description: String {
            switch self {
            case .inbox:
                String(localized: "Connect a Mac, Linux desktop, or server running Aiden to access your workspaces and Bots.")
            case .bots:
                String(localized: "Connect a computer running Aiden to see and chat with your Bots.")
            case .workspaces:
                String(localized: "Connect a computer running Aiden to browse workspaces and start chats.")
            case .search:
                String(localized: "Connect a computer running Aiden to search your chats and Bots.")
            }
        }
    }

    let surface: Surface
    let onAddComputer: () -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        VStack(spacing: AidenSpacing.l) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(palette.secondary)
                .frame(width: 48, height: 48)
                .background(palette.sidebar, in: RoundedRectangle(cornerRadius: AidenRadius.control, style: .continuous))
                .accessibilityHidden(true)

            VStack(spacing: AidenSpacing.s) {
                Text("No computers connected")
                    .font(.title3.bold())
                    .foregroundStyle(palette.foreground)
                    .multilineTextAlignment(.center)
                Text(surface.description)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: 320)

            Button(action: onAddComputer) {
                Text("Add Computer")
                    .font(.headline)
                    .padding(.horizontal, AidenSpacing.xl)
                    .foregroundStyle(palette.onFillAccent)
            }
            .controlSize(.large)
            .aidenSolidFillTint()
            .buttonStyle(.glassProminent)
            .padding(.top, AidenSpacing.xs)
        }
        .padding(.horizontal, AidenSpacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.canvas.ignoresSafeArea())
    }
}

struct AidenPairingView: View {
    private enum Route: Hashable {
        case getDesktop
        case addComputer
    }

    private enum Field: Hashable {
        case address
        case code
    }

    @Bindable var coordinator: AidenRemoteCoordinator
    let showsDesktopCheck: Bool
    var onClose: (() -> Void)?
    var onPaired: (() -> Void)?

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenCodeTypography) private var codeTypography
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @StateObject private var discovery = AidenDiscoveryModel()
    @State private var path: [Route] = []
    @State private var addressInput = ""
    @State private var codeInput = ""
    @State private var selectedAgentID: String?
    @State private var inlineError: String?
    @State private var isCameraActive = false
    @State private var scanComplete = false
    @State private var showsCameraPermissionAlert = false
    @State private var pairingTask: Task<Void, Never>?
    @State private var hapticScope = UUID()
    @FocusState private var focusedField: Field?

    init(
        coordinator: AidenRemoteCoordinator,
        showsDesktopCheck: Bool = false,
        onClose: (() -> Void)? = nil,
        onPaired: (() -> Void)? = nil
    ) {
        self.coordinator = coordinator
        self.showsDesktopCheck = showsDesktopCheck
        self.onClose = onClose
        self.onPaired = onPaired
    }

    private var submission: AidenPairingSubmission? {
        guard !coordinator.isMutating else { return nil }
        return AidenPairingInputParser.submission(address: addressInput, code: codeInput)
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if showsDesktopCheck {
                    desktopCheckPage
                } else {
                    addComputerPage(isRoot: true)
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .getDesktop:
                    getDesktopPage
                case .addComputer:
                    addComputerPage(isRoot: false)
                }
            }
        }
        .background(palette.canvas.ignoresSafeArea())
        .onAppear {
            coordinator.haptics.activate(scope: hapticScope)
            discovery.start()
        }
        .onDisappear {
            coordinator.haptics.deactivate(scope: hapticScope)
            pairingTask?.cancel()
            pairingTask = nil
            isCameraActive = false
            discovery.stop()
            addressInput = ""
            codeInput = ""
            selectedAgentID = nil
            inlineError = nil
        }
        .alert("Camera access needed", isPresented: $showsCameraPermissionAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    openURL(url)
                }
            }
        } message: {
            Text("Allow camera access in Settings to scan the pairing QR, or enter the address and setup code below.")
        }
    }

    // MARK: - Step 1: Desktop Check

    private var desktopCheckPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AidenSpacing.xl) {
                VStack(alignment: .leading, spacing: AidenSpacing.s) {
                    Text("Do you have Aiden on your computer?")
                        .font(.title2.bold())
                        .foregroundStyle(palette.foreground)
                    Text("Aiden On The Go connects directly to Aiden Agent on your Mac, Linux computer, or server.")
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, AidenSpacing.xs)

                VStack(spacing: 0) {
                    NavigationLink(value: Route.addComputer) {
                        desktopCheckRow(
                            title: String(localized: "Yes, it’s installed"),
                            subtitle: String(localized: "Scan a QR code or enter a setup code"),
                            systemImage: "checkmark.circle",
                            iconForeground: palette.accent,
                            iconBackground: palette.accent.opacity(0.12)
                        )
                    }
                    .buttonStyle(.plain)

                    Divider().padding(.leading, 64)

                    NavigationLink(value: Route.getDesktop) {
                        desktopCheckRow(
                            title: String(localized: "Not yet — get Aiden"),
                            subtitle: String(localized: "Download for Mac, Linux, or server"),
                            systemImage: "arrow.down.circle",
                            iconForeground: palette.foreground,
                            iconBackground: palette.sidebar
                        )
                    }
                    .buttonStyle(.plain)
                }
                .background(palette.raised, in: RoundedRectangle(cornerRadius: AidenRadius.card, style: .continuous))

                if let firstAgent = discovery.agents.first {
                    HStack(spacing: AidenSpacing.s) {
                        Circle()
                            .fill(palette.success)
                            .frame(width: 8, height: 8)
                            .accessibilityHidden(true)
                        Text(
                            discovery.agents.count == 1
                                ? String(localized: "\(firstAgent.name) is already running on this Wi-Fi.")
                                : String(localized: "\(discovery.agents.count) computers are already running on this Wi-Fi.")
                        )
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                    }
                    .padding(.horizontal, AidenSpacing.xs)
                }
            }
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, AidenSpacing.l)
            .padding(.top, AidenSpacing.xl)
            .padding(.bottom, AidenSpacing.xxl)
        }
        .background(palette.canvas.ignoresSafeArea())
        .navigationTitle("Connect Aiden")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let onClose {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        onClose()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }
            }
        }
    }

    private func desktopCheckRow(
        title: String,
        subtitle: String,
        systemImage: String,
        iconForeground: Color,
        iconBackground: Color
    ) -> some View {
        HStack(spacing: AidenSpacing.m) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(iconForeground)
                .frame(width: 36, height: 36)
                .background(iconBackground, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.foreground)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }

            Spacer(minLength: AidenSpacing.s)

            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(palette.secondary.opacity(0.65))
                .accessibilityHidden(true)
        }
        .padding(.horizontal, AidenSpacing.l)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
    }

    // MARK: - Step 2: Get Aiden (Desktop / Server Links)

    private var getDesktopPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AidenSpacing.l) {
                Text("Install Aiden on the computer you want to connect. Share a link to open it on your Mac or Linux machine.")
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, AidenSpacing.xs)

                VStack(spacing: 0) {
                    downloadRow(
                        title: String(localized: "Mac"),
                        subtitle: "chatwithaiden.com",
                        systemImage: "laptopcomputer",
                        url: AidenDesktopDownloadLinks.macURL,
                        accentIcon: true
                    )
                    Divider().padding(.leading, 62)
                    downloadRow(
                        title: String(localized: "Linux"),
                        subtitle: "github.com/sambitcreate/aiden-agent",
                        systemImage: "terminal",
                        url: AidenDesktopDownloadLinks.linuxURL,
                        accentIcon: false
                    )
                    Divider().padding(.leading, 62)
                    downloadRow(
                        title: String(localized: "Server"),
                        subtitle: "aiden serve · GitHub",
                        systemImage: "server.rack",
                        url: AidenDesktopDownloadLinks.serverURL,
                        accentIcon: false
                    )
                }
                .background(palette.raised, in: RoundedRectangle(cornerRadius: AidenRadius.card, style: .continuous))

                Text("Once installed, open Settings → Connections in Aiden Agent or run `aiden serve`.")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, AidenSpacing.xs)
            }
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, AidenSpacing.l)
            .padding(.top, AidenSpacing.l)
            .padding(.bottom, AidenSpacing.xxl)
        }
        .background(palette.canvas.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Button {
                path.append(.addComputer)
            } label: {
                Text("I Have Aiden — Continue")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .foregroundStyle(palette.onFillAccent)
            }
            .controlSize(.large)
            .aidenSolidFillTint()
            .buttonStyle(.glassProminent)
            .frame(maxWidth: 420)
            .padding(.horizontal, AidenSpacing.xl)
            .padding(.top, AidenSpacing.s)
            .padding(.bottom, AidenSpacing.m)
        }
        .navigationTitle("Get Aiden")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func downloadRow(
        title: String,
        subtitle: String,
        systemImage: String,
        url: URL,
        accentIcon: Bool
    ) -> some View {
        HStack(spacing: AidenSpacing.m) {
            Button {
                openURL(url)
            } label: {
                HStack(spacing: AidenSpacing.m) {
                    Image(systemName: systemImage)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(accentIcon ? palette.accent : palette.foreground)
                        .frame(width: 36, height: 36)
                        .background(
                            accentIcon ? palette.accent.opacity(0.12) : palette.sidebar,
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                        )
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(palette.foreground)
                        Text(subtitle)
                            .font(.footnote)
                            .foregroundStyle(palette.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    Spacer(minLength: AidenSpacing.s)

                    Image(systemName: "arrow.up.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(accentIcon ? palette.accent : palette.secondary)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(title), \(subtitle)")
            .accessibilityHint("Opens download link in Safari.")

            ShareLink(item: url) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(palette.foreground)
                    .frame(width: 32, height: 32)
                    .background(palette.sidebar, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Share \(title) link")
        }
        .padding(.horizontal, AidenSpacing.l)
        .padding(.vertical, 13)
    }

    // MARK: - Step 3: Add Computer (Inline Frosted QR + Nearby + Manual)

    private func addComputerPage(isRoot: Bool) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                scanCard

                if !discovery.agents.isEmpty {
                    nearbySection
                }

                manualEntrySection
            }
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, AidenSpacing.l)
            .padding(.top, AidenSpacing.s)
            .padding(.bottom, AidenSpacing.xxxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.canvas.ignoresSafeArea())
        .navigationTitle("Add Computer")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isRoot, let onClose {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        onClose()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    submitManual()
                } label: {
                    if coordinator.isMutating {
                        ProgressView()
                    } else {
                        Image(systemName: "checkmark")
                    }
                }
                .disabled(submission == nil)
                .accessibilityLabel(coordinator.isMutating ? "Connecting" : "Add Computer")
            }
        }
        .onChange(of: discovery.agents) { _, agents in
            guard let selectedAgentID else { return }
            guard let selected = agents.first(where: { $0.id == selectedAgentID }),
                  selected.endpoint == addressInput else {
                self.selectedAgentID = nil
                return
            }
        }
        .onDisappear {
            isCameraActive = false
        }
    }

    private var scanCard: some View {
        let isDark = colorScheme == .dark
        let cardShape = RoundedRectangle(cornerRadius: 26, style: .continuous)
        let active = isCameraActive && !scanComplete && !coordinator.isMutating

        return Button {
            activateCameraIfAllowed()
        } label: {
            ZStack {
                RadialGradient(
                    colors: isDark
                        ? [Color(aidenHex: "#2B2F38"), Color(aidenHex: "#111318")]
                        : [palette.raised, palette.sidebar],
                    center: .center,
                    startRadius: 10,
                    endRadius: 210
                )

                if active {
                    AidenInlineQRScannerView { payload in
                        handleScannedQRPayload(payload)
                    }
                    AidenFrostedCutoutView(
                        cutoutTop: 34,
                        cutoutSize: 144,
                        cutoutRadius: 28,
                        isDark: isDark,
                        reduceTransparency: reduceTransparency,
                        fallbackFill: UIColor(palette.canvas)
                    )
                    .allowsHitTesting(false)
                }

                VStack(spacing: 14) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 28, style: .continuous)
                            .stroke(
                                active
                                    ? Color.white.opacity(0.88)
                                    : (isDark ? Color.white.opacity(0.75) : palette.foreground.opacity(0.68)),
                                lineWidth: 2.8
                            )
                            .frame(width: 144, height: 144)

                        if coordinator.isMutating {
                            VStack(spacing: AidenSpacing.s) {
                                ProgressView()
                                Text("Connecting…")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(isDark ? Color.white.opacity(0.84) : palette.foreground)
                            }
                        } else if !active {
                            VStack(spacing: 6) {
                                Image(systemName: "qrcode.viewfinder")
                                    .font(.system(size: 40, weight: .light))
                                Text("Tap to scan")
                                    .font(.subheadline.weight(.medium))
                            }
                            .foregroundStyle(isDark ? Color.white.opacity(0.78) : palette.foreground.opacity(0.76))
                        }
                    }

                    Group {
                        if active {
                            Text("Point at the QR on your computer")
                        } else {
                            Text("Scan the code from `aiden serve` or Connections settings")
                        }
                    }
                    .font(.footnote.weight(active ? .medium : .regular))
                    .foregroundStyle(
                        active
                            ? (isDark ? Color.white.opacity(0.90) : palette.foreground.opacity(0.85))
                            : (isDark ? Color.white.opacity(0.72) : palette.foreground.opacity(0.72))
                    )
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, AidenSpacing.l)
                }
                .padding(.top, 34)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
            .frame(height: 244)
            .clipShape(cardShape)
        }
        .buttonStyle(.plain)
        .disabled(active || coordinator.isMutating)
        .accessibilityLabel(active ? "QR camera active" : "Scan QR code")
        .accessibilityHint(active ? "Point your camera at the QR shown on your computer." : "Activates the camera to scan your computer’s pairing QR.")
    }

    private var nearbySection: some View {
        VStack(alignment: .leading, spacing: AidenSpacing.s) {
            Text("Nearby on Wi-Fi")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(palette.secondary)
                .padding(.horizontal, AidenSpacing.m)

            VStack(spacing: 0) {
                ForEach(Array(discovery.agents.enumerated()), id: \.element.id) { index, agent in
                    if index > 0 {
                        Divider().padding(.leading, AidenSpacing.l)
                    }
                    Button {
                        guard let endpoint = agent.endpoint else { return }
                        selectedAgentID = agent.id
                        addressInput = endpoint
                        inlineError = nil
                        focusedField = .code
                    } label: {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(agent.endpoint != nil ? palette.success : palette.secondary.opacity(0.4))
                                .frame(width: 8, height: 8)
                                .accessibilityHidden(true)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(agent.name)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(palette.foreground)
                                    .lineLimit(1)
                                if let endpoint = agent.endpoint {
                                    Text(AidenPairingInputParser.compactDisplayAddress(endpoint))
                                        .font(codeTypography.swiftUIFont(relativeTo: .caption))
                                        .foregroundStyle(palette.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                } else {
                                    Text("Resolving address…")
                                        .font(.caption)
                                        .foregroundStyle(palette.secondary)
                                }
                            }

                            Spacer(minLength: AidenSpacing.s)

                            if selectedAgentID == agent.id {
                                Image(systemName: "checkmark")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(palette.accent)
                                    .accessibilityHidden(true)
                            } else if agent.endpoint != nil {
                                Text("Use")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(palette.accent)
                            }
                        }
                        .padding(.horizontal, AidenSpacing.l)
                        .frame(minHeight: 54)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(agent.endpoint == nil)
                    .accessibilityLabel(agent.endpoint.map { "\(agent.name), \(AidenPairingInputParser.compactDisplayAddress($0))" } ?? agent.name)
                    .accessibilityValue(selectedAgentID == agent.id ? "Selected" : "Not selected")
                    .accessibilityAddTraits(selectedAgentID == agent.id ? .isSelected : [])
                }
            }
            .background(palette.raised, in: RoundedRectangle(cornerRadius: AidenRadius.card, style: .continuous))
        }
    }

    private var manualEntrySection: some View {
        let cardShape = RoundedRectangle(cornerRadius: AidenRadius.card, style: .continuous)

        return VStack(alignment: .leading, spacing: AidenSpacing.s) {
            Text("Or enter it")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(palette.secondary)
                .padding(.horizontal, AidenSpacing.m)

            VStack(spacing: 0) {
                HStack(spacing: AidenSpacing.m) {
                    Text("Address")
                        .font(.body)
                        .foregroundStyle(palette.secondary)
                        .frame(width: 72, alignment: .leading)
                        .accessibilityHidden(true)

                    TextField("mac.local or host.ts.net", text: $addressInput)
                        .font(codeTypography.swiftUIFont(relativeTo: .subheadline))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .submitLabel(.next)
                        .focused($focusedField, equals: .address)
                        .onSubmit { focusedField = .code }
                        .accessibilityLabel("Computer address")
                        .onChange(of: addressInput) { _, value in
                            inlineError = nil
                            if let selectedAgentID {
                                let selectedEndpoint = discovery.agents.first { $0.id == selectedAgentID }?.endpoint
                                if selectedEndpoint != value { self.selectedAgentID = nil }
                            }
                        }
                }
                .padding(.horizontal, AidenSpacing.l)
                .frame(minHeight: 52)

                Divider().padding(.leading, AidenSpacing.l)

                HStack(spacing: AidenSpacing.m) {
                    Text("Code")
                        .font(.body)
                        .foregroundStyle(palette.secondary)
                        .frame(width: 72, alignment: .leading)
                        .accessibilityHidden(true)

                    TextField("Setup code or payload", text: $codeInput)
                        .font(codeTypography.swiftUIFont(relativeTo: .subheadline))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .keyboardType(.asciiCapable)
                        .submitLabel(.go)
                        .focused($focusedField, equals: .code)
                        .onSubmit { submitManual() }
                        .accessibilityLabel("Setup code or pairing payload")
                        .onChange(of: codeInput) { _, value in
                            inlineError = nil
                            let formatted = AidenPairingInputParser.formattedManualCodeInput(value)
                            if formatted != value {
                                codeInput = formatted
                            }
                        }
                }
                .padding(.horizontal, AidenSpacing.l)
                .frame(minHeight: 52)
            }
            .background(palette.raised, in: cardShape)
            .overlay {
                if inlineError != nil {
                    cardShape.stroke(palette.danger, lineWidth: 1)
                }
            }

            Text(
                inlineError
                    ?? String(localized: "For computers on your local network or Tailscale. Your provider keys stay on your computer.")
            )
            .font(.footnote)
            .foregroundStyle(inlineError != nil ? palette.dangerText : palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, AidenSpacing.m)
        }
    }

    // MARK: - Actions

    private func activateCameraIfAllowed() {
        inlineError = nil
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            scanComplete = false
            isCameraActive = true
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    if granted {
                        scanComplete = false
                        isCameraActive = true
                    } else {
                        showsCameraPermissionAlert = true
                    }
                }
            }
        default:
            showsCameraPermissionAlert = true
        }
    }

    private func handleScannedQRPayload(_ payload: String) {
        guard !scanComplete else { return }
        scanComplete = true
        isCameraActive = false
        inlineError = nil
        startPairing {
            await coordinator.pair(qrPayload: payload)
        }
    }

    private func submitManual() {
        guard let submission else { return }
        focusedField = nil
        inlineError = nil
        switch submission {
        case .payload(let payload):
            startPairing {
                await coordinator.pair(qrPayload: payload)
            }
        case .manual(let endpoint, let code):
            startPairing {
                await coordinator.pair(manualCode: code, endpoint: endpoint)
            }
        }
    }

    private func startPairing(
        operation: @escaping @MainActor () async -> AidenPairingAttemptResult
    ) {
        guard pairingTask == nil else { return }
        let attemptID = UUID()
        pairingTask = Task { @MainActor in
            let result = await operation()
            guard !Task.isCancelled else {
                pairingTask = nil
                return
            }
            if result == .succeeded {
                coordinator.haptics.play(
                    .success,
                    scope: hapticScope,
                    dedupeKey: "pair:\(attemptID.uuidString)"
                )
                addressInput = ""
                codeInput = ""
                selectedAgentID = nil
                inlineError = nil
                onPaired?()
            } else if result == .failed {
                coordinator.haptics.play(
                    .error,
                    scope: hapticScope,
                    dedupeKey: "pair:\(attemptID.uuidString)"
                )
                inlineError = coordinator.presentedError ?? AidenPairingAlertCopy.fallbackMessage
                coordinator.presentedError = nil
                scanComplete = false
            }
            pairingTask = nil
        }
    }
}

// MARK: - Frosted Cutout & Inline QR Camera

/// One continuous blur with a rounded-rect hole, horizontally centered, avoiding
/// seams from tiling separate blur views. Falls back to an opaque mask under
/// Reduce Transparency.
private struct AidenFrostedCutoutView: UIViewRepresentable {
    let cutoutTop: CGFloat
    let cutoutSize: CGFloat
    let cutoutRadius: CGFloat
    let isDark: Bool
    let reduceTransparency: Bool
    let fallbackFill: UIColor

    func makeUIView(context: Context) -> FrostedCutoutUIView {
        FrostedCutoutUIView()
    }

    func updateUIView(_ uiView: FrostedCutoutUIView, context: Context) {
        uiView.configure(
            cutoutTop: cutoutTop,
            cutoutSize: cutoutSize,
            cutoutRadius: cutoutRadius,
            isDark: isDark,
            reduceTransparency: reduceTransparency,
            fallbackFill: fallbackFill
        )
    }

    final class FrostedCutoutUIView: UIView {
        private var cutoutTop: CGFloat = 0
        private var cutoutSize: CGFloat = 0
        private var cutoutRadius: CGFloat = 0
        private var isDark = false
        private var reduceTransparency = false
        private var fallbackFill: UIColor = .systemBackground

        private let effectView = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterialDark))
        private let opaqueOverlayView = UIView()
        private let maskHostView = UIView()
        private let maskLayer = CAShapeLayer()

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            maskLayer.fillRule = .evenOdd
            maskHostView.layer.addSublayer(maskLayer)
            addSubview(effectView)
            addSubview(opaqueOverlayView)
            opaqueOverlayView.isHidden = true
            effectView.mask = maskHostView
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        func configure(
            cutoutTop: CGFloat,
            cutoutSize: CGFloat,
            cutoutRadius: CGFloat,
            isDark: Bool,
            reduceTransparency: Bool,
            fallbackFill: UIColor
        ) {
            self.cutoutTop = cutoutTop
            self.cutoutSize = cutoutSize
            self.cutoutRadius = cutoutRadius
            self.isDark = isDark
            self.reduceTransparency = reduceTransparency
            self.fallbackFill = fallbackFill

            effectView.effect = UIBlurEffect(
                style: isDark ? .systemThinMaterialDark : .systemThinMaterialLight
            )
            opaqueOverlayView.backgroundColor = fallbackFill.withAlphaComponent(0.92)
            effectView.isHidden = reduceTransparency
            opaqueOverlayView.isHidden = !reduceTransparency

            if reduceTransparency {
                effectView.mask = nil
                opaqueOverlayView.mask = maskHostView
            } else {
                opaqueOverlayView.mask = nil
                effectView.mask = maskHostView
            }
            setNeedsLayout()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            effectView.frame = bounds
            opaqueOverlayView.frame = bounds
            maskHostView.frame = bounds
            maskLayer.frame = bounds

            let path = UIBezierPath(rect: bounds)
            if cutoutSize > 0 {
                let hole = CGRect(
                    x: (bounds.width - cutoutSize) / 2,
                    y: cutoutTop,
                    width: cutoutSize,
                    height: cutoutSize
                )
                path.append(UIBezierPath(roundedRect: hole, cornerRadius: cutoutRadius))
            }
            maskLayer.path = path.cgPath
        }
    }
}

private struct AidenInlineQRScannerView: UIViewRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode)
    }

    func makeUIView(context: Context) -> PreviewUIView {
        let view = PreviewUIView()
        context.coordinator.start(in: view)
        return view
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {
        context.coordinator.onCode = onCode
    }

    static func dismantleUIView(_ uiView: PreviewUIView, coordinator: Coordinator) {
        coordinator.stop()
    }

    final class PreviewUIView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: (String) -> Void
        private let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "aiden.inline-qr-scanner")
        private var configured = false
        private var delivered = false

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func start(in view: PreviewUIView) {
            view.previewLayer.session = session
            view.previewLayer.videoGravity = .resizeAspectFill
            queue.async { [weak self] in
                guard let self else { return }
                if !self.configured {
                    self.configureSession()
                    self.configured = true
                }
                if !self.session.isRunning {
                    self.session.startRunning()
                }
            }
        }

        func stop() {
            queue.async { [session] in
                if session.isRunning {
                    session.stopRunning()
                }
            }
        }

        private func configureSession() {
            guard let camera = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input) else {
                return
            }
            session.beginConfiguration()
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            if session.canAddOutput(output) {
                session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                output.metadataObjectTypes = [.qr]
            }
            session.commitConfiguration()
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !delivered,
                  let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  object.type == .qr,
                  let value = object.stringValue else { return }
            delivered = true
            stop()
            onCode(value)
        }
    }
}
