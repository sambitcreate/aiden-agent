import CoreGraphics
import Foundation
import Observation

/// Reports a shake after two strong jolts within a short window. A single
/// bump, setting the phone down, or walking stays below the threshold or the
/// count. Adapted from t3code apps/mobile/src/features/devices/shakeDetector.ts (MIT).
struct AidenShakeDetector {
    /// Acceleration magnitude in g, gravity included.
    var threshold = 1.8
    var window: TimeInterval = 0.6
    var cooldown: TimeInterval = 1.0
    private var jolts: [TimeInterval] = []
    private var lastShake = -TimeInterval.infinity

    init(threshold: Double = 1.8, window: TimeInterval = 0.6, cooldown: TimeInterval = 1.0) {
        self.threshold = threshold
        self.window = window
        self.cooldown = cooldown
    }

    /// `timestamp` is in seconds. Returns true when this sample completes a shake.
    mutating func ingest(x: Double, y: Double, z: Double, timestamp: TimeInterval) -> Bool {
        if timestamp - lastShake < cooldown { return false }
        if (x * x + y * y + z * z).squareRoot() < threshold { return false }
        jolts = jolts.filter { timestamp - $0 <= window } + [timestamp]
        guard jolts.count >= 2 else { return false }
        jolts = []
        lastShake = timestamp
        return true
    }
}

/// Whether the viewer's controls overlay is showing. Controls greet the user
/// while connecting, then get out of the stream's way once input connects.
/// Adapted from t3code apps/mobile/src/features/devices/DevicePreviewRouteScreen.tsx (MIT).
struct AidenSimulatorControlsState: Equatable {
    enum Event: Equatable {
        case connecting
        case inputConnected
        case inputDisconnected
        case toggle
        case backdropTapped
        case reveal
    }

    private(set) var isVisible = true
    private(set) var inputConnected = false

    /// The dimmed, tappable backdrop exists only once the stream takes input.
    var showsBackdrop: Bool { isVisible && inputConnected }

    mutating func apply(_ event: Event) {
        switch event {
        case .connecting:
            inputConnected = false
            isVisible = true
        case .inputConnected:
            inputConnected = true
            isVisible = false
        case .inputDisconnected:
            inputConnected = false
            isVisible = true
        case .toggle:
            isVisible.toggle()
        case .backdropTapped:
            if inputConnected { isVisible = false }
        case .reveal:
            isVisible = true
        }
    }
}

/// Maps a touch in the viewer into the displayed frame, normalized 0...1
/// from the top left. The frame is aspect-fit inside the container.
enum AidenSimulatorTouchMapping {
    static func fittedRect(imageSize: CGSize, in container: CGSize) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0, container.width > 0, container.height > 0 else {
            return .zero
        }
        let scale = min(container.width / imageSize.width, container.height / imageSize.height)
        let size = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        return CGRect(
            x: (container.width - size.width) / 2,
            y: (container.height - size.height) / 2,
            width: size.width,
            height: size.height
        )
    }

    /// Nil outside the fitted frame unless `clamped` (a touch that began inside
    /// keeps tracking at the edge).
    static func normalizedPoint(
        _ location: CGPoint,
        imageSize: CGSize,
        container: CGSize,
        clamped: Bool = false
    ) -> CGPoint? {
        let rect = fittedRect(imageSize: imageSize, in: container)
        guard rect.width > 0, rect.height > 0 else { return nil }
        let x = (location.x - rect.minX) / rect.width
        let y = (location.y - rect.minY) / rect.height
        if clamped { return CGPoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1)) }
        guard (0...1).contains(x), (0...1).contains(y) else { return nil }
        return CGPoint(x: x, y: y)
    }
}

enum AidenSimulatorViewerCopy {
    static let sharingOff = String(localized:
        "Turn on Share with Aiden On The Go in Aiden on your Mac (Settings → Simulator)."
    )
    static let refused = String(localized: "This iPhone can’t control simulators on this Mac.")
    static let generic = String(localized: "Couldn’t reach the simulator.")
    static let openOnMac = String(localized: "Open on your Mac to view")

    static func message(for error: Error) -> String {
        guard let error = error as? AidenRemoteClientError else { return generic }
        switch error {
        case .server(let status, let body):
            if status == 401 || status == 403 || body.code.rawValue == "capability_denied" { return refused }
            if status == 404 || body.code.rawValue == "not_found" { return sharingOff }
            return generic
        case .unexpectedStatus(let status):
            return message(forHTTPStatus: status)
        default:
            return generic
        }
    }

    static func message(for failure: AidenSimulatorStreamFailure) -> String {
        switch failure {
        case .refused: return refused
        case .notFound: return sharingOff
        case .capacity, .status, .partTooLarge, .disconnected: return generic
        }
    }

    private static func message(forHTTPStatus status: Int) -> String {
        switch status {
        case 401, 403: return refused
        case 404: return sharingOff
        default: return generic
        }
    }
}

/// One full-screen viewer session: the listing it was opened from, the
/// selected device, the newest decoded frame, and the input socket.
@MainActor
@Observable
final class AidenSimulatorViewerModel: Identifiable {
    enum Phase: Equatable {
        case idle
        case starting(String)
        case connecting
        case streaming
        case openOnMac
        case shutDown(String)
        case failed(String)
    }

    let id = UUID()
    private(set) var listing: AidenSimulatorListing
    private(set) var selectedDeviceId: String?
    private(set) var frame: CGImage?
    private(set) var phase: Phase = .idle
    private(set) var screen: AidenSimulatorScreenConfig?
    private(set) var inputMessage: String?
    private(set) var isShuttingDown = false
    private(set) var isRefreshing = false
    var controls = AidenSimulatorControlsState()
    var alertMessage: String?

    @ObservationIgnored private let client: AidenRemoteClient
    @ObservationIgnored private var transport: AidenSimulatorTransport?
    @ObservationIgnored private var stream: AidenSimulatorFrameStream?
    @ObservationIgnored private var socket: AidenSimulatorInputSocket?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var inputRetries = 0
    @ObservationIgnored private var streamRetries = 0
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private var work: Task<Void, Never>?

    init(client: AidenRemoteClient, listing: AidenSimulatorListing) {
        self.client = client
        self.listing = listing
        selectedDeviceId = listing.defaultViewerDeviceId
    }

    var selectedDevice: AidenSimulatorDevice? {
        listing.devices.first { $0.id == selectedDeviceId }
    }

    var inputConnected: Bool { controls.inputConnected }

    /// Chat devices first, then the Mac's other devices.
    var pickerDevices: (chat: [AidenSimulatorDevice], other: [AidenSimulatorDevice]) {
        let chat = listing.chatDevices
        let chatIDs = Set(chat.map(\.id))
        return (chat, listing.devices.filter { !chatIDs.contains($0.id) })
    }

    var showsPicker: Bool { listing.devices.count > 1 }

    // MARK: Lifecycle

    /// The viewer is visible and the app is in the foreground.
    func activate() {
        guard !isActive else { return }
        isActive = true
        startStreaming()
    }

    /// The app went to the background or the viewer closed: release the
    /// stream, the socket and their session. The last frame stays on screen.
    func deactivate() {
        guard isActive else { return }
        isActive = false
        stopStreaming()
        if case .streaming = phase { phase = .idle }
        if case .connecting = phase { phase = .idle }
    }

    func select(_ deviceId: String) {
        guard deviceId != selectedDeviceId,
              let device = listing.devices.first(where: { $0.id == deviceId }),
              device.platform.isViewableOnPhone else { return }
        selectedDeviceId = deviceId
        frame = nil
        if isActive { startStreaming() }
    }

    func reload() {
        guard isActive else { return }
        startStreaming()
    }

    /// Explicit refetch of the Mac's listing. It may start an installed hub.
    func retry() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let refreshed = try await client.simulators()
            listing = refreshed.keepingChatDevices(of: listing)
            if selectedDevice == nil { selectedDeviceId = listing.defaultViewerDeviceId }
            if isActive { startStreaming() }
        } catch {
            phase = .failed(AidenSimulatorViewerCopy.message(for: error))
        }
    }

    // MARK: Input

    func touch(_ phase: AidenSimulatorTouchPhase, x: Double, y: Double) {
        guard inputConnected else { return }
        socket?.send(AidenSimulatorHelperMessage.touch(phase, x: x, y: y, screen: screen))
    }

    func home() { press(.home) }

    func appSwitcher() { press(.appSwitcher) }

    func rotate() {
        guard inputConnected else { return }
        socket?.send(AidenSimulatorHelperMessage.rotate(from: screen))
    }

    private func press(_ button: AidenSimulatorButton) {
        guard inputConnected else { return }
        socket?.send(AidenSimulatorHelperMessage.button(button))
    }

    /// The caller has confirmed with the user.
    func shutDown() async {
        guard let device = selectedDevice, !isShuttingDown else { return }
        isShuttingDown = true
        defer { isShuttingDown = false }
        do {
            try await client.shutdownSimulator(deviceId: device.id)
            stopStreaming()
            frame = nil
            listing = listing.replacing(device.withBooted(false))
            phase = .shutDown(device.name)
        } catch {
            alertMessage = AidenSimulatorViewerCopy.message(for: error)
        }
    }

    // MARK: Streaming

    private func startStreaming() {
        stopStreaming()
        generation &+= 1
        let current = generation
        inputRetries = 0
        streamRetries = 0
        inputMessage = nil
        screen = nil
        controls.apply(.connecting)
        guard listing.sharing else {
            phase = .failed(AidenSimulatorViewerCopy.sharingOff)
            return
        }
        guard let device = selectedDevice else {
            phase = .failed(AidenSimulatorViewerCopy.generic)
            return
        }
        guard device.platform.isViewableOnPhone else {
            phase = .openOnMac
            return
        }
        work = Task { [weak self] in
            guard let self else { return }
            if !device.booted {
                phase = .starting(device.name)
                do {
                    let opened = try await client.openSimulator(deviceId: device.id)
                    guard current == generation else { return }
                    listing = listing.replacing(opened)
                } catch {
                    guard current == generation, !Task.isCancelled else { return }
                    phase = .failed(AidenSimulatorViewerCopy.message(for: error))
                    return
                }
            }
            guard current == generation else { return }
            phase = .connecting
            openStream(deviceId: device.id, generation: current)
        }
    }

    private func stopStreaming() {
        generation &+= 1
        work?.cancel()
        work = nil
        stream?.cancel()
        stream = nil
        socket?.close()
        socket = nil
        transport?.close()
        transport = nil
        if controls.inputConnected { controls.apply(.inputDisconnected) }
    }

    private func currentTransport() throws -> AidenSimulatorTransport {
        if let transport { return transport }
        let created = try client.makeSimulatorTransport()
        transport = created
        return created
    }

    private func openStream(deviceId: String, generation current: Int) {
        do {
            let request = try client.simulatorStreamRequest(deviceId: deviceId)
            let sink = AidenSimulatorEventSink(self)
            let stream = try currentTransport().makeFrameStream(request: request) { event in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { sink.model?.handle(event, deviceId: deviceId, generation: current) }
                }
            }
            self.stream = stream
            stream.start()
        } catch {
            phase = .failed(AidenSimulatorViewerCopy.message(for: error))
        }
    }

    private func connectInput(deviceId: String, generation current: Int) {
        do {
            let request = try client.simulatorInputRequest(deviceId: deviceId)
            let sink = AidenSimulatorEventSink(self)
            let socket = try currentTransport().makeInputSocket(request: request) { event in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { sink.model?.handle(event, deviceId: deviceId, generation: current) }
                }
            }
            self.socket = socket
            socket.start()
        } catch {
            inputMessage = AidenSimulatorViewerCopy.message(for: error)
        }
    }

    fileprivate func handle(_ event: AidenSimulatorFrameStream.Event, deviceId: String, generation current: Int) {
        guard current == generation, isActive else { return }
        switch event {
        case .receiving:
            if socket == nil, inputMessage == nil { connectInput(deviceId: deviceId, generation: current) }
        case .frame(let image):
            frame = image
            streamRetries = 0
            if phase != .streaming { phase = .streaming }
        case .failed(let failure):
            stream?.cancel()
            stream = nil
            socket?.close()
            socket = nil
            if controls.inputConnected { controls.apply(.inputDisconnected) }
            if failure == .disconnected, streamRetries < 1 {
                streamRetries += 1
                scheduleAfterDelay(generation: current) { [weak self] in
                    self?.openStream(deviceId: deviceId, generation: current)
                }
            } else {
                phase = .failed(AidenSimulatorViewerCopy.message(for: failure))
            }
        }
    }

    fileprivate func handle(_ event: AidenSimulatorInputSocket.Event, deviceId: String, generation current: Int) {
        guard current == generation, isActive else { return }
        switch event {
        case .connected:
            inputMessage = nil
            controls.apply(.inputConnected)
        case .screen(let config):
            screen = config
        case .closed(let closeCode, let httpStatus):
            socket = nil
            if controls.inputConnected { controls.apply(.inputDisconnected) }
            switch AidenSimulatorInputRetryPolicy.decision(
                closeCode: closeCode,
                httpStatus: httpStatus,
                retriesUsed: inputRetries
            ) {
            case .refused:
                inputMessage = AidenSimulatorViewerCopy.refused
            case .giveUp:
                inputMessage = AidenSimulatorViewerCopy.generic
            case .retry(let delay):
                inputRetries += 1
                scheduleAfterDelay(delay, generation: current) { [weak self] in
                    guard let self, stream != nil else { return }
                    connectInput(deviceId: deviceId, generation: current)
                }
            }
        }
    }

    private func scheduleAfterDelay(
        _ delay: TimeInterval = AidenSimulatorInputRetryPolicy.retryDelay,
        generation current: Int,
        _ action: @escaping @MainActor () -> Void
    ) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, current == generation, isActive else { return }
            action()
        }
    }
}

/// Hands background stream events to the viewer model without keeping it alive.
private final class AidenSimulatorEventSink: @unchecked Sendable {
    weak var model: AidenSimulatorViewerModel?

    init(_ model: AidenSimulatorViewerModel) {
        self.model = model
    }
}

private extension AidenSimulatorDevice {
    func withBooted(_ booted: Bool) -> AidenSimulatorDevice {
        AidenSimulatorDevice(id: id, name: name, platform: platform, version: version, booted: booted, kind: kind)
    }
}

extension AidenSimulatorListing {
    /// The listing with one device replaced by a fresher copy.
    func replacing(_ device: AidenSimulatorDevice) -> AidenSimulatorListing {
        AidenSimulatorListing(
            sharing: sharing,
            status: status,
            detail: detail,
            devices: devices.map { $0.id == device.id ? device : $0 },
            chatDeviceIds: chatDeviceIds,
            toolVersions: toolVersions
        )
    }
}
