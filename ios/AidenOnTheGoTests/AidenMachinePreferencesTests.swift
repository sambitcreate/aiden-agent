import UIKit
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenMachinePreferencesTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "AidenMachinePreferencesTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    private func makeStore() -> AidenMachinePreferencesStore {
        AidenMachinePreferencesStore(defaults: defaults)
    }

    // MARK: Host object IDs

    func testStorageKeyRoundTripsIDsThatContainColons() {
        let id = AidenHostObjectID(instanceId: "a:b", deviceId: "d", objectId: "bot:1:2")
        XCTAssertEqual(AidenHostObjectID(storageKey: id.storageKey), id)
        XCTAssertNotEqual(id.storageKey, AidenHostObjectID(instanceId: "a", deviceId: "b:d", objectId: "bot:1:2").storageKey)
    }

    func testStorageKeyCountsUTF8BytesNotCharacters() {
        let id = AidenHostObjectID(instanceId: "é", deviceId: "d", objectId: "o")
        XCTAssertEqual(id.storageKey, "2:é1:d1:o")
        XCTAssertEqual(AidenHostObjectID(storageKey: id.storageKey), id)
    }

    func testMalformedStorageKeysReturnNil() {
        let malformed = [
            "",
            "1:a1:b",                // two segments
            "1:a1:b1:c1:d",          // four segments
            "1:a1:b1:cX",            // trailing bytes
            "9:a1:b1:c",             // length runs past the end
            "x:a1:b1:c",             // non-numeric length
            "-1:a1:b1:c",            // negative length
            "1a1:b1:c",              // missing colon
            "1:a1:b1:",              // truncated payload
        ]
        for key in malformed {
            XCTAssertNil(AidenHostObjectID(storageKey: key), key)
        }
    }

    func testEmptySegmentsRoundTrip() {
        let id = AidenHostObjectID(instanceId: "", deviceId: "", objectId: "")
        XCTAssertEqual(id.storageKey, "0:0:0:")
        XCTAssertEqual(AidenHostObjectID(storageKey: id.storageKey), id)
    }

    // MARK: Machine preferences

    func testDefaultSymbolIsDesktopComputer() {
        XCTAssertEqual(makeStore().preferences(for: "m1").symbol, .desktop)
        XCTAssertEqual(AidenMachineSymbol.desktop.systemName, "desktopcomputer")
    }

    func testNewMachineTakesTheFirstColourNotAlreadyUsed() {
        let store = makeStore()
        XCTAssertEqual(store.preferences(for: "m1").color, .blue)
        XCTAssertEqual(store.preferences(for: "m2").color, .teal)
        store.update("m2") { $0.color = .green }
        // blue and green are taken, teal is free again.
        XCTAssertEqual(store.preferences(for: "m3").color, .teal)
    }

    func testColourAssignmentIsStableAcrossReads() {
        let store = makeStore()
        _ = store.preferences(for: "m1")
        let second = store.preferences(for: "m2").color
        XCTAssertEqual(store.preferences(for: "m2").color, second)
        XCTAssertEqual(store.preferences(for: "m1").color, .blue)
    }

    func testColoursWrapToBlueOnceAllNineAreUsed() {
        let store = makeStore()
        for index in 0..<AidenMachineColor.allCases.count {
            XCTAssertEqual(store.preferences(for: "m\(index)").color, AidenMachineColor.allCases[index])
        }
        XCTAssertEqual(store.preferences(for: "tenth").color, .blue)
    }

    func testPreferencesSurviveARelaunchAndRemoveClearsThem() {
        let first = makeStore()
        first.update("m1") {
            $0.nameOverride = "Studio"
            $0.symbol = .studio
            $0.color = .purple
            $0.isHidden = true
        }
        let relaunched = makeStore()
        let restored = relaunched.preferences(for: "m1")
        XCTAssertEqual(restored.nameOverride, "Studio")
        XCTAssertEqual(restored.symbol, .studio)
        XCTAssertEqual(restored.color, .purple)
        XCTAssertTrue(restored.isHidden)

        relaunched.remove("m1")
        let afterRemove = makeStore().preferences(for: "m1")
        XCTAssertNil(afterRemove.nameOverride)
        XCTAssertEqual(afterRemove.symbol, .desktop)
        XCTAssertFalse(afterRemove.isHidden)
    }

    func testRemoveFreesTheColourForTheNextMachine() {
        let store = makeStore()
        _ = store.preferences(for: "m1")
        _ = store.preferences(for: "m2")
        store.remove("m1")
        XCTAssertEqual(store.preferences(for: "m3").color, .blue)
    }

    func testEverySymbolExistsInTheSystem() {
        for symbol in AidenMachineSymbol.allCases {
            XCTAssertNotNil(UIImage(systemName: symbol.systemName), symbol.systemName)
        }
    }

    func testEveryColourHasASixDigitHex() {
        let expected = ["2F6FDE", "0E8F8F", "2E8B57", "B9770E", "D2601A", "C93C3C", "C2337F", "7B4FD0", "5A6070"]
        XCTAssertEqual(AidenMachineColor.allCases.map(\.hex), expected)
    }

    func testAnEmptyNameOverrideClearsToNil() {
        let store = makeStore()
        store.update("m1") { $0.nameOverride = "Studio" }
        store.update("m1") { $0.nameOverride = "   \n " }
        XCTAssertNil(store.preferences(for: "m1").nameOverride)
        XCTAssertNil(makeStore().preferences(for: "m1").nameOverride)
    }

    func testNameOverrideIsTrimmed() {
        let store = makeStore()
        store.update("m1") { $0.nameOverride = "  Studio \n" }
        XCTAssertEqual(store.preferences(for: "m1").nameOverride, "Studio")
    }

    func testCorruptStoredPreferencesFallBackToEmpty() {
        defaults.set(Data("not json".utf8), forKey: "aiden.machine-preferences.v1")
        let store = makeStore()
        XCTAssertEqual(store.preferences(for: "m1").color, .blue)
        XCTAssertEqual(store.preferences(for: "m1").symbol, .desktop)
        store.update("m1") { $0.nameOverride = "Recovered" }
        XCTAssertEqual(makeStore().preferences(for: "m1").nameOverride, "Recovered")
    }
}
