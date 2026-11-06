#if DEBUG
import XCTest
@testable import AidenOnTheGo

/// The Machines page and the per-machine editor, through the model both views read.
@MainActor
final class AidenMachineDetailTests: XCTestCase {
    private var responder = AidenDemoResponder()
    private var defaults = AidenDemoHosts.isolatedDefaults()

    override func setUp() {
        super.setUp()
        responder = AidenDemoResponder()
        defaults = AidenDemoHosts.isolatedDefaults()
    }

    private func makeModel(
        _ scenario: AidenDemoScenario
    ) -> (model: AidenMachinesModel, coordinator: AidenRemoteCoordinator, preferences: AidenMachinePreferencesStore) {
        let coordinator = AidenDemoHosts.coordinator(scenario, responder: responder)
        let preferences = AidenMachinePreferencesStore(defaults: defaults)
        return (AidenMachinesModel(coordinator: coordinator, preferences: preferences), coordinator, preferences)
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
        let (model, coordinator, preferences) = makeModel(.one)
        model.setName("studio", "Desk")

        let outcome = await model.forget("studio")

        guard case .success = outcome else { return XCTFail("Got \(outcome)") }
        XCTAssertTrue(pairedIDs(coordinator).isEmpty)
        XCTAssertNil(coordinator.activeInstanceId)
        XCTAssertEqual(coordinator.connectionState, .needsPairing)
        XCTAssertTrue(model.rows.isEmpty)
        XCTAssertTrue(model.hasNoMachines)
        XCTAssertNil(AidenMachinePreferencesStore(defaults: defaults).preferences(for: "studio").nameOverride)
        _ = preferences
    }

    func testAForgetThatFailsKeepsThePairingAndItsPreferences() async throws {
        let keychain = SaveFailingKeychain()
        let coordinator = AidenDemoHosts.coordinator(
            installations: [
                AidenDemoHosts.installation(instanceId: "studio", name: "Studio Mac"),
                AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop"),
            ],
            responder: responder,
            keychain: keychain
        )
        let preferences = AidenMachinePreferencesStore(defaults: defaults)
        let model = AidenMachinesModel(coordinator: coordinator, preferences: preferences)
        model.setName("laptop", "Travel laptop")
        keychain.failsSavingInstallations = true

        let outcome = await model.forget("laptop")

        guard case .failure = outcome else { return XCTFail("Got \(outcome)") }
        XCTAssertTrue(pairedIDs(coordinator).contains("laptop"))
        XCTAssertEqual(preferences.preferences(for: "laptop").nameOverride, "Travel laptop")
        XCTAssertEqual(model.row("laptop")?.name, "Travel laptop")
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

    func testSameNamedMachinesShowTheirIdentitySuffix() {
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
        XCTAssertEqual(model.onlineCount, 0, "Nothing has connected yet")
        XCTAssertEqual(model.rows.count, 4)
    }

    func testRegisteringMachinesAssignsDistinctColoursOutsideAnyView() {
        let (model, _, preferences) = makeModel(.four)
        let colours = model.rows.map(\.color)
        XCTAssertEqual(Set(colours).count, 4, "Each machine gets its own colour")
        XCTAssertEqual(colours, model.rows.map { preferences.preferences(for: $0.id).color })
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
