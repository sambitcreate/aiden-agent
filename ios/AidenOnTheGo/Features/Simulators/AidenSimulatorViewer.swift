import CoreMotion
import SwiftUI
import UIKit

// Full-screen simulator viewer and its chat entry point.
// Adapted from t3code apps/mobile/src/features/devices/DevicePreviewRouteScreen.tsx
// and device-preview-button.tsx (MIT).

/// Decides whether a chat shows the device button. It reads
/// `GET /simulators?chatId=` once when the chat opens, again on return to the
/// foreground and when the viewer closes. It never polls.
@MainActor
@Observable
final class AidenChatSimulatorsModel {
    private(set) var listing: AidenSimulatorListing?

    var deviceCount: Int { listing?.showsChatDeviceButton == true ? listing?.chatDeviceIds.count ?? 0 : 0 }

    static func isAvailable(coordinator: AidenRemoteCoordinator) -> Bool {
        guard coordinator.server?.supportsMobileSimulators == true,
              let installation = coordinator.installationStore.activeInstallation else { return false }
        return installation.hasNegotiatedAccess(to: .simulatorsMobile)
    }

    func refresh(coordinator: AidenRemoteCoordinator?, chatId: String) async {
        guard let coordinator, Self.isAvailable(coordinator: coordinator) else {
            listing = nil
            return
        }
        do {
            let value = try await coordinator.remoteClient().simulators(chatId: chatId)
            guard !Task.isCancelled else { return }
            listing = value
        } catch {
            guard !Task.isCancelled else { return }
            listing = nil
        }
    }

    func makeViewer(coordinator: AidenRemoteCoordinator?) -> AidenSimulatorViewerModel? {
        guard let coordinator, let listing, listing.showsChatDeviceButton,
              let client = try? coordinator.remoteClient() else { return nil }
        return AidenSimulatorViewerModel(client: client, listing: listing)
    }
}

/// The composer's device button: an iPhone glyph with a count badge when the
/// chat has more than one device.
struct AidenSimulatorDeviceButton: View {
    @Environment(\.aidenPalette) private var palette

    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "iphone")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(palette.accent)
                .frame(width: 36, height: 36)
                .aidenChromeGlass(isInteractive: true, in: Circle())
                .overlay(alignment: .topTrailing) {
                    if count > 1 {
                        Text(count, format: .number)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(palette.onAccent)
                            .padding(.horizontal, 4)
                            .frame(minWidth: 16, minHeight: 16)
                            .background(palette.accent, in: Capsule())
                            .offset(x: 4, y: -4)
                    }
                }
        }
        .buttonStyle(.plain)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(count == 1 ? Text("View device") : Text("View \(count) devices"))
        .accessibilityHint(Text("Watch and control simulators open in this chat"))
    }
}

struct AidenSimulatorViewer: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion
    @Environment(\.aidenReduceMotion) private var aidenReduceMotion
    @Environment(\.aidenPalette) private var palette
    @State private var model: AidenSimulatorViewerModel
    @State private var shakeMonitor = AidenShakeMonitor()
    @State private var isConfirmingShutdown = false
    @State private var showsToolVersions = false
    @State private var isVisible = false

    init(model: AidenSimulatorViewerModel) {
        _model = State(initialValue: model)
    }

    private var reduceMotion: Bool { accessibilityReduceMotion || aidenReduceMotion }

    private var deviceName: String {
        model.selectedDevice?.name ?? String(localized: "Devices")
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            screenContent
                .ignoresSafeArea()
            if model.controls.isVisible {
                controlsOverlay
                    .transition(.opacity)
            } else {
                showControlsHandle
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: model.controls.isVisible)
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .onAppear {
            isVisible = true
            updateActivity(for: scenePhase, visible: true)
        }
        .onDisappear {
            isVisible = false
            shakeMonitor.stop()
            model.deactivate()
        }
        .onChange(of: scenePhase) { _, phase in
            updateActivity(for: phase, visible: isVisible)
        }
        .confirmationDialog(
            Text("Shut down \(deviceName)?"),
            isPresented: $isConfirmingShutdown,
            titleVisibility: .visible
        ) {
            Button("Shut Down", role: .destructive) {
                Task { await model.shutDown() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The simulator closes on your Mac.")
        }
        .alert("Device tool versions", isPresented: $showsToolVersions) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(toolVersionsText)
        }
        .alert("Aiden On The Go", isPresented: Binding(
            get: { model.alertMessage != nil },
            set: { if !$0 { model.alertMessage = nil } }
        )) {
            Button("OK", role: .cancel) { model.alertMessage = nil }
        } message: {
            Text(model.alertMessage ?? AidenSimulatorViewerCopy.generic)
        }
    }

    /// Streams and the accelerometer run only while visible and active.
    private func updateActivity(for phase: ScenePhase, visible: Bool) {
        guard visible else { return }
        switch phase {
        case .active:
            model.activate()
            shakeMonitor.start {
                toggleControlsFromShake()
            }
        case .inactive:
            // Notification Center, Control Center or the app switcher took the touch.
            model.touchCancelled()
        case .background:
            shakeMonitor.stop()
            model.deactivate()
        default:
            break
        }
    }

    private func toggleControlsFromShake() {
        UISelectionFeedbackGenerator().selectionChanged()
        model.controls.apply(.toggle)
        AccessibilityNotification.Announcement(
            model.controls.isVisible
                ? String(localized: "Device controls shown")
                : String(localized: "Device controls hidden")
        ).post()
    }

    private var toolVersionsText: String {
        guard let versions = model.listing.toolVersions else {
            return String(localized: "Your Mac didn’t report its device tool versions.")
        }
        return String(localized: "Hub \(versions.hub)\nAgent \(versions.agent)\n\nDevice tools update with Aiden on your Mac.")
    }

    // MARK: Screen

    @ViewBuilder
    private var screenContent: some View {
        if let frame = model.frame, model.selectedDevice?.platform.isViewableOnPhone == true {
            AidenSimulatorFrameView(
                frame: frame,
                screen: model.screen,
                deviceName: deviceName,
                onTouchChanged: { inside, clamped in model.touchChanged(inside: inside, clamped: clamped) },
                onTouchEnded: { clamped in model.touchEnded(clamped: clamped) },
                onTouchCancelled: { model.touchCancelled() }
            )
        } else {
            placeholder
        }
    }

    @ViewBuilder
    private var placeholder: some View {
        VStack(spacing: 14) {
            switch model.phase {
            case .starting(let name):
                ProgressView().tint(.white)
                Text("Starting \(name)…")
            case .idle, .connecting, .streaming:
                ProgressView().tint(.white)
                Text("Connecting to \(deviceName)…")
            case .openOnMac:
                Image(systemName: "iphone")
                    .font(.system(size: 34, weight: .regular))
                    .accessibilityHidden(true)
                Text(AidenSimulatorViewerCopy.openOnMac)
            case .shutDown(let name):
                Image(systemName: "power")
                    .font(.system(size: 30, weight: .regular))
                    .accessibilityHidden(true)
                Text("\(name) is shut down.")
                placeholderAction(String(localized: "Start \(name)")) { model.reload() }
            case .failed(let message):
                Text(message)
                if model.listing.status.offersRetry {
                    placeholderAction(String(localized: "Retry")) { Task { await model.retry() } }
                } else {
                    placeholderAction(String(localized: "Reload stream")) { model.reload() }
                }
            }
        }
        .font(.callout)
        .multilineTextAlignment(.center)
        .foregroundStyle(.white.opacity(0.82))
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func placeholderAction(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.callout.weight(.medium))
                .foregroundStyle(palette.foreground)
                .padding(.horizontal, 20)
                .frame(minHeight: 44)
                .aidenChromeGlass(isInteractive: true, in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(model.isRefreshing)
    }

    // MARK: Controls

    private var controlsOverlay: some View {
        ZStack(alignment: .top) {
            if model.controls.showsBackdrop {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { model.controls.apply(.backdropTapped) }
                    .accessibilityElement()
                    .accessibilityLabel(Text("Hide device controls"))
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { model.controls.apply(.backdropTapped) }
            }
            VStack(spacing: 8) {
                controlsBar
                if let message = model.inputMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(palette.foreground)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .aidenChromeGlass(in: Capsule())
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
    }

    private var controlsBar: some View {
        HStack(spacing: 4) {
            controlButton("xmark", label: Text("Close device viewer")) {
                dismiss()
            }
            Text(deviceName)
                .font(.headline)
                .foregroundStyle(palette.foreground)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            controlButton("house", label: Text("Home"), enabled: model.inputConnected) {
                model.home()
            }
            optionsMenu
        }
        .padding(4)
        .aidenChromeGlass(in: Capsule())
    }

    private func controlButton(
        _ systemImage: String,
        label: Text,
        enabled: Bool = true,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(palette.foreground)
                .frame(width: 44, height: 44)
                .background(palette.raised.opacity(0.6), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        .accessibilityLabel(label)
    }

    private var optionsMenu: some View {
        Menu {
            if model.showsPicker {
                let devices = model.pickerDevices
                if !devices.chat.isEmpty {
                    Section("This chat") { ForEach(devices.chat) { deviceOption($0) } }
                }
                if !devices.other.isEmpty {
                    Section("On your Mac") { ForEach(devices.other) { deviceOption($0) } }
                }
            }
            Section {
                Button("Reload stream", systemImage: "arrow.clockwise") { model.reload() }
                    .disabled(model.isShuttingDown || model.selectedDevice?.platform.isViewableOnPhone != true)
                Button("App switcher", systemImage: "square.on.square") { model.appSwitcher() }
                    .disabled(!model.inputConnected)
                Button("Rotate device", systemImage: "rotate.right") { model.rotate() }
                    .disabled(!model.inputConnected)
                if model.listing.status.offersRetry {
                    Button("Retry", systemImage: "arrow.clockwise") { Task { await model.retry() } }
                        .disabled(model.isRefreshing)
                }
                Button("Device tool versions", systemImage: "info.circle") { showsToolVersions = true }
            }
            Section {
                Button(
                    model.isShuttingDown ? "Shutting down…" : "Shut down device",
                    systemImage: "power",
                    role: .destructive
                ) {
                    isConfirmingShutdown = true
                }
                .disabled(model.isShuttingDown || model.selectedDevice?.booted != true
                    || model.selectedDevice?.platform.isViewableOnPhone != true)
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(palette.foreground)
                .frame(width: 44, height: 44)
                .background(palette.raised.opacity(0.6), in: Circle())
                .contentShape(Circle())
        }
        .accessibilityLabel(Text("Device options"))
    }

    @ViewBuilder
    private func deviceOption(_ device: AidenSimulatorDevice) -> some View {
        if device.platform.isViewableOnPhone {
            Button {
                model.select(device.id)
            } label: {
                if device.id == model.selectedDeviceId {
                    Label(device.name, systemImage: "checkmark")
                } else {
                    Text(device.name)
                }
                Text(device.booted ? device.version : String(localized: "\(device.version) · Not running"))
            }
        } else {
            Button {} label: {
                Text(device.name)
                Text(AidenSimulatorViewerCopy.openOnMac)
            }
            .disabled(true)
        }
    }

    private var showControlsHandle: some View {
        Button {
            model.controls.apply(.reveal)
        } label: {
            Capsule()
                .fill(.white.opacity(0.4))
                .frame(width: 40, height: 5)
                .frame(width: 64, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
        .accessibilityLabel(Text("Show device controls"))
        .accessibilityHint(Text("Shaking the phone also shows them"))
    }
}

/// Samples the accelerometer at about 20 Hz while running, feeding the shake
/// detector. Run it only while the viewer is visible and the app foregrounded.
final class AidenShakeMonitor {
    /// Created on first start, so view re-initialisation stays cheap.
    private lazy var manager = CMMotionManager()
    private var detector = AidenShakeDetector()
    private var hasStarted = false

    var isRunning: Bool { hasStarted && manager.isAccelerometerActive }

    func start(onShake: @escaping @MainActor () -> Void) {
        guard manager.isAccelerometerAvailable, !manager.isAccelerometerActive else { return }
        hasStarted = true
        detector = AidenShakeDetector()
        manager.accelerometerUpdateInterval = 0.05
        manager.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
            guard let self, let data else { return }
            let acceleration = data.acceleration
            if detector.ingest(
                x: acceleration.x,
                y: acceleration.y,
                z: acceleration.z,
                timestamp: data.timestamp
            ) {
                MainActor.assumeIsolated { onShake() }
            }
        }
    }

    func stop() {
        guard hasStarted, manager.isAccelerometerActive else { return }
        manager.stopAccelerometerUpdates()
    }
}

/// The newest decoded frame, turned to the device's orientation and
/// aspect-fit, forwarding touches as points normalized to what is shown. The
/// model decides where a touch begins and moves; this view also reports a
/// gesture the system cancelled, which never reaches `onEnded`.
private struct AidenSimulatorFrameView: View {
    let frame: CGImage
    let screen: AidenSimulatorScreenConfig?
    let deviceName: String
    /// The point on the frame (nil outside it) and the same point pinned to the frame.
    let onTouchChanged: (CGPoint?, CGPoint?) -> Void
    let onTouchEnded: (CGPoint?) -> Void
    let onTouchCancelled: () -> Void

    /// Resets without `onEnded` when the system cancels the drag.
    @GestureState private var isPressing = false

    var body: some View {
        GeometryReader { proxy in
            let imageSize = CGSize(width: frame.width, height: frame.height)
            let rotation = AidenSimulatorDisplayRotation(screen: screen)
            let shown = AidenSimulatorTouchMapping.displayRect(imageSize: imageSize, rotation: rotation, in: proxy.size)
            // The image takes the unturned size of the shown rect and turns about its center.
            Image(decorative: frame, scale: 1)
                .resizable()
                .interpolation(.medium)
                .frame(
                    width: rotation.isSideways ? shown.height : shown.width,
                    height: rotation.isSideways ? shown.width : shown.height
                )
                .rotationEffect(.degrees(rotation.degrees))
                .frame(width: proxy.size.width, height: proxy.size.height)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0, coordinateSpace: .local)
                        .updating($isPressing) { _, pressing, _ in pressing = true }
                        .onChanged { value in
                            onTouchChanged(
                                AidenSimulatorTouchMapping.normalizedPoint(
                                    value.location, imageSize: imageSize, rotation: rotation, container: proxy.size
                                ),
                                AidenSimulatorTouchMapping.normalizedPoint(
                                    value.location, imageSize: imageSize, rotation: rotation,
                                    container: proxy.size, clamped: true
                                )
                            )
                        }
                        .onEnded { value in
                            onTouchEnded(AidenSimulatorTouchMapping.normalizedPoint(
                                value.location, imageSize: imageSize, rotation: rotation,
                                container: proxy.size, clamped: true
                            ))
                        }
                )
                // A completed drag already ended its touch, so this only lifts a cancelled one.
                .onChange(of: isPressing) { _, pressing in
                    if !pressing { onTouchCancelled() }
                }
        }
        .accessibilityElement()
        .accessibilityLabel(Text("\(deviceName) simulator screen"))
        .accessibilityAddTraits(.allowsDirectInteraction)
    }
}
