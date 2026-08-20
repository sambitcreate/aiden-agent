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
            return AidenDiscoveredAgent(id: service.name, name: service.name, endpoint: endpoint)
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
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
    @State private var isShowingScanner = false
    @State private var isShowingAppearance = false
    @State private var step: Int

    init(coordinator: AidenRemoteCoordinator, onPaired: (() -> Void)? = nil) {
        self.coordinator = coordinator
        self.onPaired = onPaired
        _step = State(initialValue: onPaired == nil ? 0 : 2)
    }

    private var canPair: Bool {
        !pairingPayload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !coordinator.isMutating
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
                    Button {
                        isShowingAppearance = true
                    } label: {
                        Image(systemName: "circle.lefthalf.filled")
                    }
                    .accessibilityLabel("Appearance")
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
            .onDisappear { discovery.stop() }
            .sheet(isPresented: $isShowingScanner) {
                NavigationStack {
                    AidenQRCodeScanner { payload in
                        pairingPayload = payload
                        isShowingScanner = false
                        Task {
                            await coordinator.pair(qrPayload: payload)
                            if coordinator.connectionState == .connected { onPaired?() }
                        }
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
        VStack(spacing: 0) {
            Spacer(minLength: 32)
            AidenSidebarLogo(size: 132, color: palette.accent)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Aiden")
            Spacer(minLength: 34)
            VStack(alignment: .leading, spacing: 12) {
                Text("Aiden, wherever you are.")
                    .font(.system(size: 32, weight: .bold))
                Text("Control Aiden Agent on your Mac from iPhone or iPad—chats, workspaces, files, Git, scheduled tasks, and approvals.")
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 28)
            Spacer(minLength: 24)
            Button("Get Started") { step = 1 }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 24)
                .padding(.bottom, 20)
        }
        .navigationBarHidden(true)
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
                pairingStep(number: 3, title: "Create a pairing QR", detail: "Keep the QR visible. It expires after five minutes and can be used once.")

                VStack(alignment: .leading, spacing: 10) {
                    Label("Per-device credential", systemImage: "key.fill")
                    Label("Pinned HTTPS identity", systemImage: "lock.shield.fill")
                    Label("Revocable from your Mac", systemImage: "checkmark.shield")
                }
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
            }
            .padding(24)
        }
        .safeAreaInset(edge: .bottom) {
            Button("Scan Pairing QR") { step = 2 }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
                .padding(20)
                .background(.bar)
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
        Form {
            Section {
                Button { isShowingScanner = true } label: {
                    Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                }

                TextEditor(text: $pairingPayload)
                    .frame(minHeight: 96)
                    .font(codeTypography.swiftUIFont(relativeTo: .footnote))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Pairing payload")

                Button("Pair with Aiden Agent") {
                    Task {
                        await coordinator.pair(qrPayload: pairingPayload.trimmingCharacters(in: .whitespacesAndNewlines))
                        if coordinator.connectionState == .connected { onPaired?() }
                    }
                }
                .disabled(!canPair)
            } header: {
                Text("Pairing code")
            } footer: {
                Text("Scan the one-time QR from Aiden Agent → Settings → Remote Access, or paste its full payload.")
            }

            Section {
                if discovery.agents.isEmpty {
                    HStack {
                        if discovery.isSearching { ProgressView() }
                        Text(discovery.isSearching ? "Looking for Aiden Agent…" : "No nearby Aiden Agent found")
                            .foregroundStyle(palette.secondary)
                    }
                } else {
                    ForEach(discovery.agents) { agent in
                        VStack(alignment: .leading, spacing: 3) {
                            Label(agent.name, systemImage: "desktopcomputer")
                            if let endpoint = agent.endpoint {
                                Text(endpoint)
                                    .font(codeTypography.swiftUIFont(relativeTo: .caption))
                                    .foregroundStyle(palette.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            } header: {
                Text("Nearby Macs")
            } footer: {
                Text("Discovery only confirms reachability. The QR verifies your Mac’s certificate and public-key fingerprint.")
            }

            Section("Connection") {
                Label("Local Network uses pinned HTTPS", systemImage: "wifi")
                Label("Tailscale uses the same device credential", systemImage: "network")
                Label("Provider keys stay on your Mac", systemImage: "checkmark.shield")
            }
        }
        .scrollContentBackground(.hidden)
        .navigationTitle("Pair Aiden")
        .navigationBarTitleDisplayMode(.inline)
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
