#if DEBUG
import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

/// The Machines page and the per-machine editor, through the model both views read.
@MainActor
final class AidenMachineDetailTests: XCTestCase {
    private var responder = AidenDemoResponder()
    private var defaults = AidenDemoHosts.isolatedDefaults()

    /// SwiftUI fills a List row's accessibility tree only while automation is on, as it is
    /// under XCUITest. Without it a hosted list shows no elements to find or activate.
    private func setAccessibilityAutomation(_ enabled: Bool) {
        typealias SetFunction = @convention(c) (Bool) -> Void
        guard let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
              let symbol = dlsym(library, "_AXSSetAutomationEnabled") else { return }
        unsafeBitCast(symbol, to: SetFunction.self)(enabled)
    }

    override func tearDown() {
        setAccessibilityAutomation(false)
        super.tearDown()
    }

    override func setUp() {
        super.setUp()
        setAccessibilityAutomation(true)
        responder = AidenDemoResponder()
        defaults = AidenDemoHosts.isolatedDefaults()
    }

    private func makeModel(
        _ scenario: AidenDemoScenario
    ) -> (model: AidenMachinesModel, coordinator: AidenRemoteCoordinator, preferences: AidenMachinePreferencesStore) {
        let preferences = AidenMachinePreferencesStore(defaults: defaults)
        let coordinator = AidenDemoHosts.coordinator(scenario, responder: responder, machinePreferences: preferences)
        let model = AidenMachinesModel(coordinator: coordinator, preferences: preferences)
        // What the page's `.task` does once it appears.
        model.register()
        return (model, coordinator, preferences)
    }

    private func pairedIDs(_ coordinator: AidenRemoteCoordinator) -> [String] {
        coordinator.installationStore.installations.map(\.instanceId)
    }

    private func serverRequests(_ instanceId: String) -> Int {
        responder.requests(instanceId: instanceId).filter { $0 == "GET /server" }.count
    }

    // MARK: Hiding

    func testHidingAMachineKeepsItPaired() {
        let (model, coordinator, preferences) = makeModel(.four)

        model.setHidden("laptop", true)

        XCTAssertTrue(preferences.preferences(for: "laptop").isHidden)
        XCTAssertEqual(model.row("laptop")?.isHidden, true)
        XCTAssertEqual(Set(pairedIDs(coordinator)), ["studio", "laptop", "mini", "build"])
        XCTAssertNotNil(coordinator.hosts.connection(for: "laptop"), "A hidden machine keeps its connection")
        XCTAssertEqual(model.rows.map(\.id), ["studio", "laptop", "mini", "build"], "A hidden machine stays on this page")
        XCTAssertFalse(try XCTUnwrap(model.row("studio")).isHidden)

        model.setHidden("laptop", false)
        XCTAssertFalse(preferences.preferences(for: "laptop").isHidden)
    }

    // MARK: Forgetting

    func testForgettingAMachineClearsItsPreferences() async throws {
        let (model, coordinator, preferences) = makeModel(.four)
        model.setName("laptop", "Travel laptop")
        model.setSymbol("laptop", .laptop)
        model.setColor("laptop", .purple)
        model.setHidden("laptop", true)
        model.setName("mini", "Kitchen")

        let outcome = await model.forget("laptop")

        guard case .success = outcome else { return XCTFail("Got \(outcome)") }
        XCTAssertFalse(pairedIDs(coordinator).contains("laptop"))
        XCTAssertNil(coordinator.hosts.connection(for: "laptop"))
        XCTAssertNil(model.row("laptop"))
        // A fresh store reading the saved blob has nothing for the machine, so a
        // machine paired again later starts from the defaults.
        let reloaded = AidenMachinePreferencesStore(defaults: defaults)
        let again = reloaded.preferences(for: "laptop")
        XCTAssertNil(again.nameOverride)
        XCTAssertEqual(again.symbol, .desktop)
        XCTAssertFalse(again.isHidden)
        XCTAssertEqual(preferences.preferences(for: "mini").nameOverride, "Kitchen", "Other machines keep their choices")
    }

    func testForgettingTheSelectedMachineSelectsAnotherOne() async throws {
        let (model, coordinator, _) = makeModel(.four)
        XCTAssertEqual(coordinator.activeInstanceId, "studio")

        let outcome = await model.forget("studio")

        guard case .success = outcome else { return XCTFail("Got \(outcome)") }
        let selected = try XCTUnwrap(coordinator.activeInstanceId)
        XCTAssertNotEqual(selected, "studio")
        XCTAssertTrue(pairedIDs(coordinator).contains(selected))
        XCTAssertEqual(model.rows.filter(\.isSelected).map(\.id), [selected])
        XCTAssertNotEqual(coordinator.connectionState, .needsPairing)
    }

    func testForgettingTheLastMachineGoesToPairing() async throws {
        let (model, coordinator, _) = makeModel(.one)
        model.setName("studio", "Desk")

        let outcome = await model.forget("studio")

        guard case .success = outcome else { return XCTFail("Got \(outcome)") }
        XCTAssertTrue(pairedIDs(coordinator).isEmpty)
        XCTAssertNil(coordinator.activeInstanceId)
        XCTAssertEqual(coordinator.connectionState, .needsPairing)
        XCTAssertTrue(model.rows.isEmpty)
        XCTAssertTrue(model.hasNoMachines)
        XCTAssertNil(AidenMachinePreferencesStore(defaults: defaults).preferences(for: "studio").nameOverride)
    }

    func testAForgetThatFailsKeepsThePairingAndItsPreferences() async throws {
        let keychain = SaveFailingKeychain()
        let preferences = AidenMachinePreferencesStore(defaults: defaults)
        let coordinator = AidenDemoHosts.coordinator(
            installations: [
                AidenDemoHosts.installation(instanceId: "studio", name: "Studio Mac"),
                AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop"),
            ],
            responder: responder,
            keychain: keychain,
            machinePreferences: preferences
        )
        let model = AidenMachinesModel(coordinator: coordinator, preferences: preferences)
        model.register()
        model.setName("laptop", "Travel laptop")
        keychain.failsSavingInstallations = true

        let outcome = await model.forget("laptop")

        guard case .failure = outcome else { return XCTFail("Got \(outcome)") }
        XCTAssertTrue(pairedIDs(coordinator).contains("laptop"))
        XCTAssertEqual(preferences.preferences(for: "laptop").nameOverride, "Travel laptop")
        XCTAssertEqual(model.row("laptop")?.name, "Travel laptop")
        // The coordinator already says why, and the shell shows it, so this page adds nothing.
        XCTAssertNotNil(coordinator.presentedError)
        XCTAssertNil(model.failureMessage(for: outcome, fallback: "Try again."))
    }

    func testAFailureWithNoErrorOfItsOwnGetsTheFallbackMessage() {
        let (model, coordinator, _) = makeModel(.four)
        XCTAssertNil(coordinator.presentedError)
        XCTAssertEqual(model.failureMessage(for: AidenRemoteMutationOutcome<Void>.failure, fallback: "Try again."), "Try again.")
        XCTAssertEqual(model.failureMessage(for: AidenRemoteMutationOutcome<Void>.busy, fallback: "Try again.")?.isEmpty, false)
        XCTAssertNil(model.failureMessage(for: AidenRemoteMutationOutcome<Void>.success(()), fallback: "Try again."))
        XCTAssertNil(model.failureMessage(for: AidenRemoteMutationOutcome<Void>.cancelled, fallback: "Try again."))
    }

    // MARK: Reconnecting and switching

    func testReconnectRetriesOnlyThatMachine() async throws {
        let (model, coordinator, _) = makeModel(.four)
        let others = ["studio", "laptop", "mini"]
        let before = Dictionary(uniqueKeysWithValues: others.map { ($0, responder.requests(instanceId: $0).count) })
        let buildBefore = serverRequests("build")

        await model.reconnect("build")

        XCTAssertEqual(serverRequests("build"), buildBefore + 1)
        for instanceId in others {
            XCTAssertEqual(responder.requests(instanceId: instanceId).count, before[instanceId], instanceId)
        }
        XCTAssertEqual(coordinator.activeInstanceId, "studio", "Retrying a machine never changes the selected one")
        XCTAssertEqual(model.row("build")?.status, .offline)
    }

    func testReconnectBringsAMachineBackOnce() async throws {
        let (model, _, _) = makeModel(.four)
        await model.reconnect("mini")
        XCTAssertEqual(model.row("mini")?.status, .online)
        XCTAssertEqual(serverRequests("mini"), 1)
    }

    func testSwitchingToAMachineSelectsIt() async throws {
        let (model, coordinator, _) = makeModel(.four)

        let outcome = await model.select("mini")

        guard case .success = outcome else { return XCTFail("Got \(outcome)") }
        XCTAssertEqual(coordinator.activeInstanceId, "mini")
        XCTAssertEqual(model.rows.filter(\.isSelected).map(\.id), ["mini"])
    }

    // MARK: The editor

    func testTheEditorSavesSymbolColourAndName() {
        let (model, _, preferences) = makeModel(.four)

        model.setSymbol("mini", .server)
        model.setColor("mini", .pink)
        model.setName("mini", "  Rack in the garage  ")

        let saved = preferences.preferences(for: "mini")
        XCTAssertEqual(saved.symbol, .server)
        XCTAssertEqual(saved.color, .pink)
        XCTAssertEqual(saved.nameOverride, "Rack in the garage")
        let row = model.row("mini")
        XCTAssertEqual(row?.name, "Rack in the garage")
        XCTAssertEqual(row?.symbol, .server)
        XCTAssertEqual(row?.color, .pink)
        // Saved for the next launch, not only for this model.
        let reloaded = AidenMachinePreferencesStore(defaults: defaults).preferences(for: "mini")
        XCTAssertEqual(reloaded.symbol, .server)
        XCTAssertEqual(reloaded.color, .pink)
        XCTAssertEqual(reloaded.nameOverride, "Rack in the garage")
    }

    func testAnEmptyNameFallsBackToTheMachinesOwnName() {
        let (model, _, preferences) = makeModel(.four)
        model.setName("mini", "Kitchen")
        XCTAssertEqual(model.row("mini")?.name, "Kitchen")

        model.setName("mini", "   \n ")

        XCTAssertNil(preferences.preferences(for: "mini").nameOverride)
        XCTAssertEqual(model.row("mini")?.name, "Home Mini")
    }

    func testAnOverlongNameIsClippedSoRowsCannotBreak() throws {
        let (model, _, preferences) = makeModel(.four)

        model.setName("mini", String(repeating: "w", count: 300))

        let saved = try XCTUnwrap(preferences.preferences(for: "mini").nameOverride)
        XCTAssertEqual(saved.count, AidenMachinesModel.maxNameLength)
        XCTAssertEqual(model.row("mini")?.name, saved)
        XCTAssertEqual(AidenMachinesModel.normalizedName(String(repeating: " ", count: 3) + "a" + String(repeating: " ", count: 80)), "a")
        XCTAssertNil(AidenMachinesModel.normalizedName(""))
        // Clipping leaves no trailing space for the store to trim away behind our back.
        XCTAssertEqual(
            AidenMachinesModel.normalizedName(String(repeating: "a", count: AidenMachinesModel.maxNameLength - 1) + "  tail"),
            String(repeating: "a", count: AidenMachinesModel.maxNameLength - 1)
        )
    }

    func testTheEditorOnlyOffersTheCuratedSymbolsAndColours() {
        XCTAssertEqual(AidenMachineSymbol.allCases.count, 13)
        XCTAssertEqual(AidenMachineColor.allCases.count, 9)
        for symbol in AidenMachineSymbol.allCases {
            XCTAssertFalse(symbol.title.isEmpty, "\(symbol) needs a name VoiceOver can say")
        }
        for color in AidenMachineColor.allCases {
            XCTAssertFalse(color.title.isEmpty, "\(color) needs a name VoiceOver can say")
        }
        XCTAssertEqual(Set(AidenMachineColor.allCases.map(\.title)).count, 9, "Colour names are distinct")
    }

    func testEveryColourKeepsItsGlyphReadableInBothAppearances() {
        // The fill does not change with the appearance, so one check covers both.
        for color in AidenMachineColor.allCases {
            let ratio = AidenMachineSwatch.glyphContrast(for: color)
            XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(color) glyph contrast is \(ratio)")
        }
    }

    // MARK: Rows

    func testSameNamedMachinesShowTheirIdentitySuffix() throws {
        let coordinator = AidenDemoHosts.coordinator(
            installations: [
                AidenDemoHosts.installation(instanceId: "desk-aaaa1234", name: "Studio"),
                AidenDemoHosts.installation(instanceId: "desk-bbbb5678", name: "studio"),
                AidenDemoHosts.installation(instanceId: "desk-cccc9abc", name: "Laptop"),
            ],
            responder: responder
        )
        let model = AidenMachinesModel(
            coordinator: coordinator,
            preferences: AidenMachinePreferencesStore(defaults: defaults)
        )
        model.register()

        XCTAssertEqual(model.row("desk-aaaa1234")?.identitySuffix, "1234")
        XCTAssertEqual(model.row("desk-bbbb5678")?.identitySuffix, "5678")
        XCTAssertNil(model.row("desk-cccc9abc")?.identitySuffix)
        XCTAssertTrue(try XCTUnwrap(model.row("desk-aaaa1234")).accessibilityLabel.contains("1234"))

        // A name override can make two machines read the same, or tell them apart.
        model.setName("desk-cccc9abc", "Studio")
        XCTAssertEqual(model.row("desk-cccc9abc")?.identitySuffix, "9abc")
        model.setName("desk-aaaa1234", "Studio one")
        model.setName("desk-bbbb5678", "Studio two")
        model.setName("desk-cccc9abc", nil)
        XCTAssertNil(model.row("desk-aaaa1234")?.identitySuffix)
    }

    func testARowReadsAsOneLabelNamingTheMachineAndItsStatus() async throws {
        let (model, _, _) = makeModel(.four)
        await model.reconnect("mini")
        await model.reconnect("build")
        model.setHidden("mini", true)

        let mini = try XCTUnwrap(model.row("mini"))
        XCTAssertTrue(mini.accessibilityLabel.contains("Home Mini"))
        XCTAssertTrue(mini.accessibilityLabel.localizedCaseInsensitiveContains("online"))
        XCTAssertTrue(mini.accessibilityValue.localizedCaseInsensitiveContains("hidden from Inbox"))
        let build = try XCTUnwrap(model.row("build"))
        XCTAssertTrue(build.accessibilityLabel.contains("Build Box"))
        XCTAssertTrue(build.accessibilityLabel.localizedCaseInsensitiveContains("offline"))
        XCTAssertFalse(build.accessibilityLabel.contains("Mac "), "Copy says machine")
    }

    func testRowsFollowPairingOrderAndMarkTheSelectedMachine() {
        let (model, _, _) = makeModel(.four)
        XCTAssertEqual(model.rows.map(\.id), ["studio", "laptop", "mini", "build"])
        XCTAssertEqual(model.rows.filter(\.isSelected).map(\.id), ["studio"])
        XCTAssertEqual(model.rows.count, 4)
    }

    func testRegisteringMachinesAssignsDistinctColoursOutsideAnyView() {
        let (model, _, preferences) = makeModel(.four)
        let colours = model.rows.map(\.color)
        XCTAssertEqual(Set(colours).count, 4, "Each machine gets its own colour")
        XCTAssertEqual(colours, model.rows.map { preferences.preferences(for: $0.id).color })
    }

    // MARK: Nothing is written until the page loads

    private var savedBlob: Data? { defaults.data(forKey: "aiden.machine-preferences.v1") }

    func testConstructingTheModelOrTheViewsWritesNothing() {
        let preferences = AidenMachinePreferencesStore(defaults: defaults)
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder, machinePreferences: preferences)

        let model = AidenMachinesModel(coordinator: coordinator, preferences: preferences)
        _ = AidenMachinesView(coordinator: coordinator, preferences: preferences, addMachine: {})
        _ = AidenMachineDetailView(instanceId: "laptop", coordinator: coordinator, preferences: preferences)

        XCTAssertNil(savedBlob, "Building a model or a view assigned a colour")
        XCTAssertTrue(model.rows.isEmpty, "Rows wait for the page to register the machines")
        XCTAssertFalse(model.hasNoMachines, "Four machines are paired, so the empty state must not show")

        model.register()

        XCTAssertNotNil(savedBlob)
        XCTAssertEqual(model.rows.count, 4)
    }

    func testOpeningThePageRegistersTheMachinesOnceItLoads() throws {
        let preferences = AidenMachinePreferencesStore(defaults: defaults)
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder, machinePreferences: preferences)
        let window = try show(NavigationStack {
            AidenMachinesView(coordinator: coordinator, preferences: preferences, addMachine: {})
        })
        defer { close(window) }

        XCTAssertTrue(
            runMainLoop(until: { accessibleElements(in: window).contains { $0.accessibilityLabel?.hasPrefix("Laptop") == true } }),
            "The rows never appeared"
        )
        XCTAssertNotNil(savedBlob)
    }

    // MARK: Activation

    func testActivatingARowOpensThatMachinesPage() throws {
        let preferences = AidenMachinePreferencesStore(defaults: defaults)
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder, machinePreferences: preferences)
        let window = try show(NavigationStack {
            AidenMachinesView(coordinator: coordinator, preferences: preferences, addMachine: {})
        })
        defer { close(window) }
        XCTAssertTrue(runMainLoop(until: { accessibleElements(in: window).contains { $0.accessibilityLabel?.hasPrefix("Laptop") == true } }))
        let row = try XCTUnwrap(accessibleElements(in: window).first { $0.accessibilityLabel?.hasPrefix("Laptop") == true })
        XCTAssertTrue(row.accessibilityLabel?.hasPrefix("Laptop, ") == true)

        XCTAssertTrue(row.accessibilityActivate(), "The row is not activatable")

        XCTAssertTrue(
            runMainLoop(until: { accessibleElements(in: window).contains { $0.accessibilityLabel == "Desktop" } }),
            "Activating the row did not open the machine's page"
        )
    }

    // MARK: Behind the flag

    private func settingsLabels(tabShellEnabled: Bool) throws -> [String] {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let window = try show(AidenAppSettingsView(
            coordinator: coordinator,
            appearance: AidenAppearanceStore(),
            addInstallation: {},
            tabShellEnabled: tabShellEnabled
        ))
        defer { close(window) }
        _ = runMainLoop(until: { accessibleElements(in: window).contains { $0.accessibilityLabel?.contains("Appearance") == true } })
        return accessibleElements(in: window).compactMap(\.accessibilityLabel)
    }

    func testSettingsKeepsTheInstallationsButtonWhileTheTabShellIsOff() throws {
        let labels = try settingsLabels(tabShellEnabled: false)
        XCTAssertTrue(labels.contains { $0.contains("Paired Installations") }, "\(labels)")
        XCTAssertFalse(labels.contains { $0.hasPrefix("Machines") }, "\(labels)")
    }

    func testSettingsLinksTheMachinesPageWhileTheTabShellIsOn() throws {
        let labels = try settingsLabels(tabShellEnabled: true)
        XCTAssertTrue(labels.contains { $0.hasPrefix("Machines") }, "\(labels)")
        XCTAssertFalse(labels.contains { $0.contains("Paired Installations") }, "\(labels)")
    }

    func testTheTabShellShowsTheMachinesPageForItsRoute() throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let store = AidenAppNavigationStore(defaults: AidenDemoHosts.isolatedDefaults())
        store.save(AidenAppNavigationSnapshot(tab: .inbox, inboxPath: [.machines]))
        let window = try show(AidenAppShellView(coordinator: coordinator, navigationStore: store))
        defer { close(window) }

        XCTAssertTrue(
            runMainLoop(until: { accessibleElements(in: window).contains { $0.accessibilityLabel == "Pair a machine" } }),
            "The shell still shows a placeholder for Machines"
        )
    }

    func testTheTabShellShowsOneMachinesPageForItsRoute() throws {
        let coordinator = AidenDemoHosts.coordinator(.four, responder: responder)
        let store = AidenAppNavigationStore(defaults: AidenDemoHosts.isolatedDefaults())
        store.save(AidenAppNavigationSnapshot(tab: .inbox, inboxPath: [.machine(instanceId: "laptop")]))
        let window = try show(AidenAppShellView(coordinator: coordinator, navigationStore: store))
        defer { close(window) }

        XCTAssertTrue(
            runMainLoop(until: { accessibleElements(in: window).contains { $0.accessibilityLabel == "Desktop" } }),
            "The shell still shows a placeholder for a machine"
        )
    }

    // MARK: Forgetting and revoking clear a machine's choices, re-pairing keeps them

    private func waitUntil(_ what: String, _ condition: () -> Bool) throws {
        XCTAssertTrue(runMainLoop(until: condition, timeout: 15), "Timed out waiting for \(what)")
    }

    private let revokedJSON = Data("""
    {"error":{"code":"credential_revoked","message":"Pair this device again.",
    "requestId":"request-revoked","retryable":false}}
    """.utf8)

    func testRevokingAMachineClearsItsChoicesSoPairingItAgainStartsFresh() async throws {
        let (model, coordinator, _) = makeModel(.four)
        model.setName("laptop", "Travel laptop")
        model.setHidden("laptop", true)
        model.setColor("laptop", .pink)
        responder.reply(instanceId: "laptop", path: "/server", status: 401, json: revokedJSON)
        let laptop = try XCTUnwrap(coordinator.hosts.connection(for: "laptop"))

        await laptop.connect()
        await coordinator.completeRevokedPurge(instanceId: "laptop")?.value

        XCTAssertFalse(pairedIDs(coordinator).contains("laptop"))
        let again = AidenMachinePreferencesStore(defaults: defaults).preferences(for: "laptop")
        XCTAssertNil(again.nameOverride)
        XCTAssertFalse(again.isHidden)
    }

    func testRevokingTheSelectedMachineClearsItsChoices() async throws {
        let (model, coordinator, _) = makeModel(.four)
        model.setName("studio", "Desk")
        model.setHidden("studio", true)
        responder.reply(instanceId: "studio", path: "/server", status: 401, json: revokedJSON)
        await coordinator.start()
        try waitUntil("the revoked machine to leave") { !self.pairedIDs(coordinator).contains("studio") }

        let again = AidenMachinePreferencesStore(defaults: defaults).preferences(for: "studio")
        XCTAssertNil(again.nameOverride)
        XCTAssertFalse(again.isHidden)
    }

    func testPairingTheSameMachineAgainKeepsItsChoices() async throws {
        let (model, coordinator, _) = makeModel(.four)
        model.setName("laptop", "Travel laptop")
        model.setHidden("laptop", true)
        // A re-pair gives the machine a new device ID. Work still holding the old one is
        // purged as stale, while the machine stays paired.
        let old = AidenRemoteRequestContext(instanceId: "laptop", deviceId: "an-old-device", generation: 0)

        let retained = await coordinator.withRetainedInstallationData(for: old) {}

        XCTAssertFalse(retained)
        XCTAssertTrue(pairedIDs(coordinator).contains("laptop"))
        let kept = AidenMachinePreferencesStore(defaults: defaults).preferences(for: "laptop")
        XCTAssertEqual(kept.nameOverride, "Travel laptop")
        XCTAssertTrue(kept.isHidden)
    }

    func testForgettingFromTheInstallationsListClearsChoicesToo() async throws {
        let (model, coordinator, _) = makeModel(.four)
        model.setName("mini", "Kitchen")

        // The Installations sheet calls the coordinator directly.
        _ = await coordinator.removeInstallationOutcome("mini")

        XCTAssertNil(AidenMachinePreferencesStore(defaults: defaults).preferences(for: "mini").nameOverride)
    }

    // MARK: Copy and buttons

    func testTheForgetMessageSaysWhatGoes() {
        let (model, _, _) = makeModel(.four)
        let message = model.forgetMessage(for: "laptop")
        XCTAssertTrue(message.contains("name, symbol and colour"), message)
        XCTAssertTrue(message.localizedCaseInsensitiveContains("chats saved on this phone"), message)
        XCTAssertTrue(message.localizedCaseInsensitiveContains("drafts"), message)
    }

    func testARevokedMachineOffersNoReconnect() {
        func row(_ status: AidenMachineStatus, reconnecting: Bool = false) -> AidenMachineRow {
            AidenMachineRow(
                id: "x", ownName: "X", name: "X", identitySuffix: nil, symbol: .desktop, color: .blue,
                isHidden: false, isSelected: false, status: status, isReconnecting: reconnecting,
                transport: "Local Network", lastConnectedAt: nil, workspaceCount: 0
            )
        }
        XCTAssertFalse(row(.revoked).canReconnect)
        XCTAssertFalse(row(.needsPairing).canReconnect)
        XCTAssertFalse(row(.offline, reconnecting: true).canReconnect)
        XCTAssertTrue(row(.offline).canReconnect)
        XCTAssertTrue(row(.online).canReconnect)
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
        window.rootViewController = UIHostingController(rootView: view.environment(AidenHapticCenter()))
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
            }
            (object as? UIView)?.subviews.forEach(walk)
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

/// An in-memory Keychain whose saves of the paired-machines record can be made to fail.
private final class SaveFailingKeychain: KeychainStoring {
    struct Failure: Error {}
    private var values: [String: String] = [:]
    var failsSavingInstallations = false

    func save(_ value: String, forKey key: KeychainStore.Key) throws {
        if failsSavingInstallations, key == .remoteInstallations { throw Failure() }
        values[key.rawValue] = value
    }
    func load(_ key: KeychainStore.Key) throws -> String? { values[key.rawValue] }
    func delete(_ key: KeychainStore.Key) throws { values[key.rawValue] = nil }
    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        values[KeychainStore.scopedKey(key, scope: scope)] = value
    }
    func load(_ key: KeychainStore.Key, scope: String) throws -> String? {
        values[KeychainStore.scopedKey(key, scope: scope)]
    }
    func delete(_ key: KeychainStore.Key, scope: String) throws {
        values[KeychainStore.scopedKey(key, scope: scope)] = nil
    }
}
#endif
