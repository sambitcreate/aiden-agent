#if DEBUG
import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

/// What says which machine a row belongs to: the label, its chip, the filter
/// strip, offline rows, the status item and the chat's subtitle.
@MainActor
final class AidenMachineChromeTests: XCTestCase {
    private let storageKey = "aiden.machine-preferences.v1"
    private var responder = AidenDemoResponder()
    private var defaults = AidenDemoHosts.isolatedDefaults()
    private var preferences: AidenMachinePreferencesStore!
    private var root: URL!
    private var scheduler: AidenHostConnectScheduler?

    /// SwiftUI fills a view's accessibility tree only while automation is on, as it
    /// is under XCUITest.
    private func setAccessibilityAutomation(_ enabled: Bool) {
        typealias SetFunction = @convention(c) (Bool) -> Void
        guard let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
              let symbol = dlsym(library, "_AXSSetAutomationEnabled") else { return }
        unsafeBitCast(symbol, to: SetFunction.self)(enabled)
    }

    override func setUp() {
        super.setUp()
        setAccessibilityAutomation(true)
        responder = AidenDemoResponder()
        defaults = AidenDemoHosts.isolatedDefaults()
        preferences = AidenMachinePreferencesStore(defaults: defaults)
        root = FileManager.default.temporaryDirectory
            .appending(path: "AidenMachineChromeTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    override func tearDown() {
        setAccessibilityAutomation(false)
        scheduler = nil
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    // MARK: Fixtures

    private func coordinator(_ scenario: AidenDemoScenario) -> AidenRemoteCoordinator {
        AidenDemoHosts.coordinator(scenario, responder: responder, machinePreferences: preferences)
    }

    private func coordinator(named machines: [(id: String, name: String)]) -> AidenRemoteCoordinator {
        AidenDemoHosts.coordinator(
            installations: machines.map { AidenDemoHosts.installation(instanceId: $0.id, name: $0.name) },
            responder: responder,
            machinePreferences: preferences
        )
    }

    private func makeStore(_ coordinator: AidenRemoteCoordinator) -> AidenUnifiedInboxStore {
        let store = AidenUnifiedInboxStore(
            hosts: coordinator.hosts,
            preferences: preferences,
            cache: AidenChatCache(root: root.appending(path: "chats", directoryHint: .isDirectory)),
            clock: ContinuousClock()
        )
        store.connectScheduler = scheduler
        return store
    }

    /// Connects every machine the way the app does, through the scheduler.
    private func connectAll(_ coordinator: AidenRemoteCoordinator) async {
        let scheduler = AidenHostConnectScheduler(
            registry: coordinator.hosts,
            pathChanges: AsyncStream { _ in },
            maxConcurrentConnects: 2,
            probeTimeout: 30
        )
        self.scheduler = scheduler
        await coordinator.start()
        await scheduler.foregrounded()
    }

    private func labels(_ coordinator: AidenRemoteCoordinator) -> [String: AidenMachineLabel] {
        AidenMachineLabel.labels(connections: coordinator.hosts.ordered, preferences: preferences)
    }

    private func label(_ name: String, id: String = "studio", color: AidenMachineColor = .blue) -> AidenMachineLabel {
        AidenMachineLabel(instanceId: id, name: name, symbol: .laptop, color: color)
    }

    private func waitUntil(_ what: String, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(10)
        while !condition(), Date() < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(condition(), "Timed out waiting for \(what)")
    }

    // MARK: Names

    func testSameNamedMachinesGetASuffix() throws {
        let coordinator = coordinator(named: [
            (id: "machine-AB12", name: "Studio"),
            (id: "machine-cd34", name: "studio"),
            (id: "machine-ef56", name: "Laptop"),
        ])

        let labels = labels(coordinator)

        XCTAssertEqual(labels["machine-AB12"]?.name, "Studio (ab12)")
        XCTAssertEqual(labels["machine-cd34"]?.name, "studio (cd34)")
        XCTAssertEqual(labels["machine-ef56"]?.name, "Laptop", "A name nothing else shares keeps no suffix")
    }

    func testANameOverrideWins() throws {
        let coordinator = coordinator(.four)
        preferences.update("laptop", { $0.nameOverride = "Travel" })
        preferences.update("laptop", { $0.symbol = .bolt })
        preferences.update("laptop", { $0.color = .purple })

        let label = try XCTUnwrap(labels(coordinator)["laptop"])

        XCTAssertEqual(label.name, "Travel")
        XCTAssertEqual(label.symbol, .bolt)
        XCTAssertEqual(label.color, .purple)
        XCTAssertEqual(labels(coordinator)["mini"]?.name, "Home Mini", "Without one, the machine's own name shows")
    }

    func testAnOverrideThatMatchesAnotherMachineGetsASuffixToo() {
        let coordinator = coordinator(.four)
        preferences.update("laptop", { $0.nameOverride = "Studio Mac" })

        let labels = labels(coordinator)

        XCTAssertEqual(labels["laptop"]?.name, "Studio Mac (ptop)")
        XCTAssertEqual(labels["studio"]?.name, "Studio Mac (udio)")
    }

    // MARK: Nothing is written from a body

    private struct LabelProbe: View {
        let connections: [AidenHostConnection]
        let preferences: AidenMachinePreferencesStore
        let onBuild: ([String: AidenMachineLabel]) -> Void

        var body: some View {
            let labels = AidenMachineLabel.labels(connections: connections, preferences: preferences)
            let _ = onBuild(labels)
            VStack {
                ForEach(connections, id: \.instanceId) { connection in
                    if let label = labels[connection.instanceId] { AidenMachineChip(label: label) }
                }
            }
        }
    }

    func testBuildingLabelsFromABodyWritesNothing() throws {
        let coordinator = coordinator(.four)
        var built: [String: AidenMachineLabel] = [:]

        let window = try show(LabelProbe(
            connections: coordinator.hosts.ordered,
            preferences: preferences,
            onBuild: { built = $0 }
        ))
        defer { close(window) }

        XCTAssertEqual(built.count, 4, "The body never ran")
        XCTAssertEqual(built["laptop"]?.name, "Laptop", "A machine seen for the first time still has a name")
        XCTAssertNil(defaults.data(forKey: storageKey), "Building labels from a body saved a colour")
        for id in built.keys {
            XCTAssertNil(preferences.saved(for: id), "Building labels from a body assigned \(id) a colour")
        }
    }

    func testTheStoreSettlesEveryMachineBeforeAViewAsks() throws {
        let coordinator = coordinator(.four)

        let store = makeStore(coordinator)

        XCTAssertEqual(Set(store.roster.labels.keys), ["studio", "laptop", "mini", "build"])
        let colours = store.roster.labels.values.map(\.color)
        XCTAssertEqual(Set(colours).count, 4, "Each machine has its own assigned colour by the time a view asks")
        XCTAssertNotNil(preferences.saved(for: "laptop"))
    }

    // MARK: Strip

    func testTheStripOnlyShowsWithTwoOrMoreVisibleMachines() async throws {
        let coordinator = coordinator(.four)
        let store = makeStore(coordinator)
        XCTAssertTrue(store.roster.showsStrip)
        XCTAssertEqual(store.roster.visible.map(\.instanceId), ["studio", "laptop", "mini", "build"])

        preferences.update("laptop", { $0.isHidden = true })
        preferences.update("mini", { $0.isHidden = true })
        await waitUntil("two visible machines") { store.roster.visible.count == 2 }
        XCTAssertTrue(store.roster.showsStrip)
        XCTAssertEqual(store.roster.visible.map(\.instanceId), ["studio", "build"], "A hidden machine gets no chip")

        preferences.update("build", { $0.isHidden = true })
        await waitUntil("one visible machine") { store.roster.visible.count == 1 }
        XCTAssertFalse(store.roster.showsStrip)
    }

    func testARevokedMachineLeavesTheStrip() async throws {
        let coordinator = coordinator(.four)
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        let laptop = try XCTUnwrap(coordinator.hosts.connection(for: "laptop"))

        await coordinator.hostConnectionWasRevokedInBackground(laptop)

        await waitUntil("the machine to leave") { !store.roster.visible.contains { $0.instanceId == "laptop" } }
    }

    func testTheStripListsAllThenEachMachineAndMovesTheFilter() throws {
        var filter = AidenMachineFilter.all
        let binding = Binding(get: { filter }, set: { filter = $0 })
        let window = try show(AidenMachineStrip(
            labels: [label("Studio Mac"), label("Laptop", id: "laptop", color: .teal)],
            filter: binding
        ))
        defer { close(window) }

        let elements = accessibleElements(in: window)
        XCTAssertEqual(elements.compactMap(\.accessibilityLabel), ["All machines", "Studio Mac", "Laptop"])
        XCTAssertTrue(elements[0].accessibilityTraits.contains(.selected), "Selection isn't left to colour")
        XCTAssertFalse(elements[2].accessibilityTraits.contains(.selected))

        XCTAssertTrue(elements[2].accessibilityActivate())

        XCTAssertEqual(filter, .machine("laptop"))
    }

    func testAStripWithOneMachineDrawsNothing() throws {
        let window = try show(AidenMachineStrip(labels: [label("Studio Mac")], filter: .constant(.all)))
        defer { close(window) }

        XCTAssertTrue(accessibleElements(in: window).isEmpty)
    }

    // MARK: Row chips

    func testRowChipsOnlyShowWithMoreThanOneMachine() async throws {
        let alone = makeStore(coordinator(.one))
        XCTAssertNil(alone.roster.rowChip(for: "studio", filter: .all), "One machine has nothing to tell apart")

        let store = makeStore(coordinator(.four))
        XCTAssertEqual(store.roster.rowChip(for: "laptop", filter: .all)?.name, "Laptop")
        XCTAssertNil(
            store.roster.rowChip(for: "laptop", filter: .machine("laptop")),
            "Filtered to one machine, every row is on it"
        )

        for id in ["laptop", "mini", "build"] { preferences.update(id, { $0.isHidden = true }) }
        await waitUntil("one visible machine") { store.roster.visible.count == 1 }
        XCTAssertNil(store.roster.rowChip(for: "studio", filter: .all), "Hidden machines list no rows to tell apart")
    }

    func testTheRowSaysItsMachineAndThatItIsOfflineToVoiceOver() throws {
        let placement = AidenInboxPlacement(section: .updates, tier: 0, sortAt: Date())
        let row = AidenInboxProjection.Row(summary: summary(), placement: placement)
        let status = AidenInboxRowStatus.make(row, section: .updates, now: Date())

        func spoken(machine: AidenMachineLabel?, isDimmed: Bool) -> String {
            AidenInboxRowView(
                row: row,
                section: .updates,
                workspaceName: "Website",
                palette: AidenThemeCatalog.palette(preset: .aiden, scheme: .light),
                machine: machine,
                isDimmed: isDimmed
            ).accessibilityName(status)
        }

        XCTAssertTrue(spoken(machine: label("Laptop"), isDimmed: false).contains("On Laptop"))
        XCTAssertFalse(spoken(machine: label("Laptop"), isDimmed: false).contains("Offline"))
        XCTAssertTrue(spoken(machine: label("Laptop"), isDimmed: true).contains("Offline"))
        XCTAssertFalse(spoken(machine: nil, isDimmed: false).contains("On "))
    }

    func testSearchChipsFollowTheMachinesSearchReaches() async throws {
        let store = makeStore(coordinator(.four))
        XCTAssertEqual(store.roster.searchChip(for: "laptop")?.name, "Laptop")

        for id in ["laptop", "mini", "build"] { preferences.update(id, { $0.isHidden = true }) }
        await waitUntil("one visible machine") { store.roster.visible.count == 1 }

        XCTAssertNil(store.roster.searchChip(for: "studio"), "Search leaves hidden machines out, so nothing needs telling apart")
    }

    // MARK: Chip

    func testChipColoursMeetContrastInEveryTheme() throws {
        var checked = 0
        for (index, color) in AidenMachineColor.allCases.enumerated() {
            for preset in AidenThemePresetID.allCases {
                for scheme in [ColorScheme.light, .dark] {
                    let symbol = AidenMachineSymbol.allCases[(index + checked) % AidenMachineSymbol.allCases.count]
                    let chip = AidenMachineChip(label: AidenMachineLabel(
                        instanceId: "studio",
                        name: "Studio Mac",
                        symbol: symbol,
                        color: color
                    ))
                    .environment(\.aidenPalette, AidenThemeCatalog.palette(preset: preset, scheme: scheme))
                    .environment(\.colorScheme, scheme)

                    let contrast = try drawnContrast(of: chip)

                    XCTAssertGreaterThanOrEqual(
                        contrast, 4.5,
                        "\(symbol) on \(color) reads at \(contrast):1 in \(preset), \(scheme)"
                    )
                    checked += 1
                }
            }
        }
        XCTAssertEqual(checked, AidenMachineColor.allCases.count * AidenThemePresetID.allCases.count * 2)
    }

    func testTheChipSaysTheMachineNameToVoiceOver() throws {
        let window = try show(AidenMachineChip(label: label("Studio Mac")))
        defer { close(window) }

        XCTAssertEqual(accessibleElements(in: window).compactMap(\.accessibilityLabel), ["On Studio Mac"])
        XCTAssertEqual(label("Studio Mac").accessibilityLabel, "On Studio Mac")
    }

    func testTheChipStopsGrowingAtTheLargestTextSizes() throws {
        let renderer = ImageRenderer(content: AidenMachineChip(label: label("Studio Mac"))
            .environment(\.dynamicTypeSize, .accessibility5))
        let size = try XCTUnwrap(renderer.uiImage).size

        XCTAssertLessThanOrEqual(size.height, 32, "A chip beside the row's words must not outgrow them")
    }

    // MARK: Offline rows

    func testAnOfflineMachineGetsARowUntilItIsHidden() async throws {
        let coordinator = coordinator(.offlineMix)
        await connectAll(coordinator)
        let store = makeStore(coordinator)

        await waitUntil("the offline rows") { store.roster.offline.count == 2 }
        XCTAssertEqual(store.roster.offline.map(\.label.name), ["Laptop", "Build Box"])
        XCTAssertTrue(store.roster.isOffline("laptop"))
        XCTAssertFalse(store.roster.isOffline("studio"))

        preferences.update("laptop", { $0.isHidden = true })

        await waitUntil("the hidden machine's row to go") { store.roster.offline.map(\.id) == ["build"] }
    }

    func testAFilterNarrowsTheOfflineRowsToItsMachine() async throws {
        let coordinator = coordinator(.offlineMix)
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await waitUntil("the offline rows") { store.roster.offline.count == 2 }

        XCTAssertEqual(store.roster.offlineRows(under: .all).map(\.id), ["laptop", "build"])
        XCTAssertEqual(store.roster.offlineRows(under: .machine("build")).map(\.id), ["build"])
        XCTAssertTrue(store.roster.offlineRows(under: .machine("studio")).isEmpty)
    }

    func testAMachineStillConnectingForTheFirstTimeIsNotCalledOffline() {
        let store = makeStore(coordinator(.four))

        XCTAssertTrue(store.roster.offline.isEmpty, "Saved rows must not dim for the moment a launch takes to connect")
    }

    func testARevokedMachinesOfflineRowDrops() async throws {
        let coordinator = coordinator(.offlineMix)
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await waitUntil("the offline rows") { store.roster.offline.count == 2 }
        let laptop = try XCTUnwrap(coordinator.hosts.connection(for: "laptop"))

        await coordinator.hostConnectionWasRevokedInBackground(laptop)

        await waitUntil("the revoked machine's row to go") { store.roster.offline.map(\.id) == ["build"] }
    }

    func testReconnectAsksForThatMachineOnly() async throws {
        let coordinator = coordinator(.offlineMix)
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await waitUntil("the offline rows") { store.roster.offline.count == 2 }
        func probes(_ id: String) -> Int { responder.requests(instanceId: id).filter { $0 == "GET /server" }.count }
        let laptopBefore = probes("laptop")
        let buildBefore = probes("build")

        store.reconnect("laptop")

        await waitUntil("the machine to be tried") { probes("laptop") > laptopBefore }
        XCTAssertEqual(probes("build"), buildBefore)
    }

    func testTheOfflineRowNamesTheMachineAndReconnects() throws {
        var reconnects = 0
        let lastSeen = Date().addingTimeInterval(-3_600)
        let window = try show(AidenMachineOfflineRow(
            label: label("Build Box"),
            lastSeen: lastSeen,
            onReconnect: { reconnects += 1 }
        ))
        defer { close(window) }

        let elements = accessibleElements(in: window)
        let summary = try XCTUnwrap(elements.first?.accessibilityLabel)
        XCTAssertTrue(summary.contains("Build Box"), summary)
        XCTAssertTrue(summary.contains("offline"), summary)
        XCTAssertTrue(summary.contains(AidenInstallationPresentation.lastConnection(lastSeen)), summary)

        let reconnect = try XCTUnwrap(elements.first { $0.accessibilityLabel == "Reconnect" })
        XCTAssertTrue(reconnect.accessibilityActivate())
        XCTAssertEqual(reconnects, 1)
    }

    func testAnOfflineRowIsDimmedAndKeepsItsChip() throws {
        let palette = AidenThemeCatalog.palette(preset: .aiden, scheme: .light)
        let placement = AidenInboxPlacement(section: .updates, tier: 0, sortAt: Date())
        let row = AidenInboxProjection.Row(summary: summary(), placement: placement)
        func colours(isDimmed: Bool) throws -> Set<UInt32> {
            let view = AidenInboxRowView(
                row: row,
                section: .updates,
                workspaceName: "Website",
                palette: palette,
                machine: label("Laptop", color: .purple),
                isDimmed: isDimmed
            )
            .frame(width: 320)
            .background(palette.canvas)
            return Set(try pixels(of: view).map(\.packed))
        }
        let foreground = Self.pixel(hex: palette.foregroundHex).packed
        let chipFill = Self.pixel(hex: AidenMachineColor.purple.hex).packed

        let online = try colours(isDimmed: false)
        let offline = try colours(isDimmed: true)

        XCTAssertTrue(online.contains(foreground), "An online title draws in the foreground colour")
        XCTAssertFalse(offline.contains(foreground), "An offline row has dropped the foreground colour")
        XCTAssertTrue(offline.contains(chipFill), "Dimming leaves the chip at full strength, or its contrast goes")
    }

    // MARK: Status item

    func testTheStatusItemCountsOnlineMachinesOfEveryPairedOne() async throws {
        let coordinator = coordinator(.offlineMix)
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        await waitUntil("the machines to settle") { store.roster.online == 2 }

        XCTAssertEqual(store.roster.total, 4)

        preferences.update("mini", { $0.isHidden = true })
        await waitUntil("the hidden machine") { !store.roster.visible.contains { $0.instanceId == "mini" } }
        XCTAssertEqual(store.roster.online, 2, "The Machines page still lists a hidden machine")
        XCTAssertEqual(store.roster.total, 4)
    }

    func testTheStatusItemReadsAsACountAndOpens() throws {
        var opens = 0
        let window = try show(AidenHostStatusItem(online: 3, total: 4, onOpen: { opens += 1 }))
        defer { close(window) }

        XCTAssertEqual(AidenHostStatusItem.title(online: 3, total: 4), "3 of 4")
        let item = try XCTUnwrap(accessibleElements(in: window).first)
        XCTAssertEqual(item.accessibilityLabel, "3 of 4 machines online")
        XCTAssertTrue(item.accessibilityTraits.contains(.button))
        XCTAssertTrue(item.accessibilityActivate())
        XCTAssertEqual(opens, 1)
    }

    // MARK: Chat subtitle

    func testTheChatSubtitleNamesTheMachineOnlyWithSeveralMachines() async throws {
        XCTAssertNil(makeStore(coordinator(.one)).roster.chatSubtitle(for: "studio"))

        let store = makeStore(coordinator(.four))
        XCTAssertEqual(store.roster.chatSubtitle(for: "laptop"), "Laptop")

        preferences.update("laptop", { $0.isHidden = true })
        await waitUntil("the hidden machine") { !store.roster.visible.contains { $0.instanceId == "laptop" } }
        XCTAssertEqual(
            store.roster.chatSubtitle(for: "laptop"), "Laptop",
            "A notification can open a chat on a hidden machine, and it's still one of several"
        )
    }

    func testTheChatSubtitleCountsNoMachineThatLeft() async throws {
        let coordinator = coordinator(named: [(id: "studio", name: "Studio"), (id: "laptop", name: "Laptop")])
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        XCTAssertEqual(store.roster.chatSubtitle(for: "studio"), "Studio")
        let laptop = try XCTUnwrap(coordinator.hosts.connection(for: "laptop"))

        await coordinator.hostConnectionWasRevokedInBackground(laptop)

        await waitUntil("the subtitle to go") { store.roster.chatSubtitle(for: "studio") == nil }
    }

    // MARK: Machines page

    func testAPairedMachineLoadsRatherThanSayingItIsGone() {
        let coordinator = coordinator(.four)
        let model = AidenMachinesModel(coordinator: coordinator, preferences: preferences)

        XCTAssertTrue(model.isLoading("laptop"), "The first frame comes before the page registers its machines")
        XCTAssertFalse(model.isLoading("nobody"), "A machine that isn't paired has nothing to load")

        model.register()

        XCTAssertFalse(model.isLoading("laptop"))
        XCTAssertNotNil(model.row("laptop"))
    }

    func testOpenChatsLeaveOutDoneOnes() async throws {
        let coordinator = coordinator(.four)
        await connectAll(coordinator)
        let store = makeStore(coordinator)
        store.start()
        defer { store.stop() }
        await waitUntil("the chats") { store.snapshots["studio"]?.chats.isEmpty == false }
        let chats = try XCTUnwrap(store.snapshots["studio"]?.chats)

        XCTAssertEqual(store.openChatCount(on: "studio"), chats.filter { $0.inbox.doneAt == nil }.count)
        XCTAssertNil(store.openChatCount(on: "nobody"))
        XCTAssertEqual(AidenMachineRoster.openChatCount(in: [summary(), summary(done: true)]), 1)
    }

    // MARK: Drawing

    private func summary(done: Bool = false) -> AidenChatSummary {
        AidenChatSummary(
            id: "chat", workspaceId: "web", title: "Deploy the pricing page", titlePending: false,
            createdAt: Date(), updatedAt: Date(), revision: "r", activity: .idle, rowState: nil,
            unread: false, lastRunFailed: false,
            inbox: AidenChatInboxSignals(doneAt: done ? Date() : nil)
        )
    }

    private struct Pixel: Hashable {
        let red: UInt8, green: UInt8, blue: UInt8, alpha: UInt8

        var packed: UInt32 {
            UInt32(red) << 16 | UInt32(green) << 8 | UInt32(blue)
        }

        /// WCAG relative luminance, worked out here so the test doesn't lean on
        /// the app's own arithmetic.
        var luminance: Double {
            func linear(_ channel: UInt8) -> Double {
                let value = Double(channel) / 255
                return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
        }

        func contrast(with other: Pixel) -> Double {
            (max(luminance, other.luminance) + 0.05) / (min(luminance, other.luminance) + 0.05)
        }
    }

    private static func pixel(hex: String) -> Pixel {
        var value: UInt64 = 0
        Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&value)
        return Pixel(red: UInt8((value >> 16) & 0xFF), green: UInt8((value >> 8) & 0xFF), blue: UInt8(value & 0xFF), alpha: 255)
    }

    /// Every fully opaque pixel of the view as drawn, in sRGB.
    private func pixels(of view: some View) throws -> [Pixel] {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 4
        let image = try XCTUnwrap(renderer.cgImage, "The view drew nothing")
        let width = image.width, height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(
            data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return stride(from: 0, to: bytes.count, by: 4).compactMap { index in
            bytes[index + 3] == 255
                ? Pixel(red: bytes[index], green: bytes[index + 1], blue: bytes[index + 2], alpha: 255)
                : nil
        }
    }

    /// The fill is the commonest colour drawn. The symbol is whatever stands
    /// furthest from it, so a symbol drawn faint comes out faint here.
    private func drawnContrast(of chip: some View) throws -> Double {
        let drawn = try pixels(of: chip)
        var counts: [Pixel: Int] = [:]
        for pixel in drawn { counts[pixel, default: 0] += 1 }
        let fill = try XCTUnwrap(counts.max { $0.value < $1.value }?.key)
        return drawn.map { $0.contrast(with: fill) }.max() ?? 1
    }

    // MARK: Hosting

    private func show(_ view: some View) throws -> UIWindow {
        func connectedScene() -> UIWindowScene? {
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        }
        _ = runMainLoop(until: { connectedScene() != nil }, timeout: 10)
        let scene = try XCTUnwrap(connectedScene())
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        return window
    }

    private func close(_ window: UIWindow) {
        window.isHidden = true
        window.rootViewController = nil
    }

    private func accessibleElements(in root: NSObject) -> [NSObject] {
        var found: [NSObject] = []
        func walk(_ object: NSObject) {
            if object.isAccessibilityElement {
                found.append(object)
                return
            }
            if let elements = object.accessibilityElements {
                elements.compactMap { $0 as? NSObject }.forEach(walk)
            } else {
                (object as? UIView)?.subviews.forEach(walk)
            }
        }
        walk(root)
        return found
    }

    private func runMainLoop(until condition: () -> Bool, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }
}
#endif
