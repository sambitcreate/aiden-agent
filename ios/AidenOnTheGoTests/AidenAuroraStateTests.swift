import SwiftUI
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenAuroraStateTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_787_100_000)
    private let mac = "mac-1"

    private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }
    private func key(_ id: String, on scope: String? = nil) -> AidenActivityKey {
        AidenActivityKey(scope: scope ?? mac, id: id)
    }

    private func signals(
        working: [String] = [],
        needsYou: [String] = [],
        failed: [String] = [],
        live: [String]? = nil,
        listening: Bool = false
    ) -> AidenActivitySignals {
        AidenActivitySignals(
            working: Set(working.map { key($0) }),
            needsYou: Set(needsYou.map { key($0) }),
            failed: Set(failed.map { key($0) }),
            liveScopes: Set(live ?? [mac]),
            listening: listening
        )
    }

    /// Applies each read at its time and returns the phase straight after.
    private func run(_ steps: [(TimeInterval, AidenActivitySignals)]) -> (AidenAuroraState, [AidenAmbientActivity]) {
        var state = AidenAuroraState()
        var phases: [AidenAmbientActivity] = []
        for (time, next) in steps {
            state.apply(next, now: at(time))
            phases.append(state.phase(at: at(time)))
        }
        return (state, phases)
    }

    private func phase(_ state: AidenAuroraState, after seconds: TimeInterval) -> AidenAmbientActivity {
        var state = state
        state.settle(now: at(seconds))
        return state.phase(at: at(seconds))
    }

    // MARK: Priority

    func testPriorityFollowsListeningNeedsYouFailedDoneWorkingIdle() {
        let (_, phases) = run([
            (0, signals(working: ["a"], needsYou: ["b"], failed: ["c"], listening: true)),
            (1, signals(working: ["a"], needsYou: ["b"], failed: ["c"])),
            (2, signals(working: ["a"], failed: ["c"])),
            (3, signals(working: ["a"])),
            (4, signals()),
        ])
        XCTAssertEqual(phases, [.listening, .needsYou, .failed, .working, .working])
    }

    func testNeedsYouOutranksAnUnreadFailure() {
        let (_, phases) = run([(0, signals(needsYou: ["approval"], failed: ["broken"]))])
        XCTAssertEqual(phases, [.needsYou])
    }

    func testDoneOutranksOtherWorkStillRunningThenReturnsToWorking() {
        let (state, _) = run([
            (0, signals(working: ["a", "b"])),
            (1, signals(working: ["b"])),
        ])
        XCTAssertEqual(phase(state, after: 1.7), .done)
        XCTAssertEqual(phase(state, after: 3.7), .working)
    }

    // MARK: Debounce

    func testWorkHoldsForSixHundredMillisecondsBeforeGoingQuiet() {
        let (state, phases) = run([
            (0, signals(working: ["a"])),
            (10, signals()),
        ])
        XCTAssertEqual(phases.last, .working)
        XCTAssertEqual(phase(state, after: 10.5), .working)
        XCTAssertNotEqual(phase(state, after: 10.61), .working)
    }

    func testARunThatResumesInsideTheHoldNeverLeavesWorkingOrShowsDone() {
        let (state, phases) = run([
            (0, signals(working: ["a"])),
            (5, signals()),
            (5.3, signals(working: ["a"])),
        ])
        XCTAssertEqual(phases, [.working, .working, .working])
        XCTAssertEqual(phase(state, after: 6), .working)
        XCTAssertNil(state.nextChange)
    }

    func testIdleToWorkingIsImmediate() {
        let (_, phases) = run([(0, signals()), (1, signals(working: ["a"]))])
        XCTAssertEqual(phases, [.idle, .working])
    }

    // MARK: Done comes only from a real finish

    func testFirstLoadNeverShowsDone() {
        let (state, phases) = run([(0, signals())])
        XCTAssertEqual(phases, [.idle])
        XCTAssertEqual(phase(state, after: 1), .idle)
        XCTAssertNil(state.nextChange)
    }

    func testAFinishedRunShowsDoneAfterTheHold() {
        let (state, _) = run([(0, signals(working: ["a"])), (4, signals())])
        XCTAssertEqual(phase(state, after: 4.61), .done)
    }

    func testAMachineGoingOfflineIsNotAFinish() {
        let (state, phases) = run([
            (0, signals(working: ["a"])),
            (4, signals(live: [])),
        ])
        XCTAssertEqual(phases.last, .idle)
        XCTAssertEqual(phase(state, after: 5), .idle)
    }

    func testAReconnectReportingIdleIsNotAFinish() {
        let (state, _) = run([
            (0, signals(working: ["a"])),
            (4, signals(live: [])),
            (9, signals()),
        ])
        XCTAssertEqual(phase(state, after: 10), .idle)
    }

    func testCachedRowsBeforeTheFirstLiveListDoNotCount() {
        // A machine whose list has not been fetched yet is not live: cached
        // rows that say "working" and then a live list that says idle are
        // not a finish.
        let (state, _) = run([
            (0, signals(working: ["a"], live: [])),
            (2, signals()),
        ])
        XCTAssertEqual(phase(state, after: 3), .idle)
    }

    func testARunThatStopsToAskForApprovalIsNotDone() {
        let (state, _) = run([
            (0, signals(working: ["a"])),
            (2, signals(needsYou: ["a"])),
        ])
        XCTAssertEqual(phase(state, after: 3), .needsYou)
        XCTAssertNotEqual(phase(state, after: 3), .done)
    }

    func testARunThatFailsShowsFailedNotDone() {
        let (state, _) = run([
            (0, signals(working: ["a"])),
            (2, signals(failed: ["a"])),
        ])
        XCTAssertEqual(phase(state, after: 3), .failed)
        XCTAssertEqual(phase(state, after: 6), .failed)
    }

    func testTheOpenChatFinishingDoesNotFlashDone() {
        var finished = signals()
        finished.focused = key("a")
        let (state, _) = run([(0, signals(working: ["a"])), (2, finished)])
        XCTAssertEqual(phase(state, after: 2.7), .idle)
    }

    // MARK: Done expiry

    func testDoneLastsTwoSecondsThenGoesIdle() {
        let (state, _) = run([(0, signals(working: ["a"])), (4, signals())])
        XCTAssertEqual(phase(state, after: 6.5), .done)
        XCTAssertEqual(phase(state, after: 6.61), .idle)
    }

    func testNextChangeNamesTheHoldThenTheDoneExpiry() throws {
        var (state, _) = run([(0, signals(working: ["a"])), (4, signals())])
        let hold = try XCTUnwrap(state.nextChange)
        XCTAssertEqual(hold.timeIntervalSince(at(4)), 0.6, accuracy: 0.001)
        state.settle(now: hold)
        XCTAssertEqual(state.phase(at: hold), .done)
        let expiry = try XCTUnwrap(state.nextChange)
        XCTAssertEqual(expiry.timeIntervalSince(at(4)), 2.6, accuracy: 0.001)
        state.settle(now: expiry)
        XCTAssertEqual(state.phase(at: expiry), .idle)
        XCTAssertNil(state.nextChange)
    }

    func testAReadLongAfterTheFinishDoesNotReviveAStaleDone() {
        // The app was in the background past the whole Done window.
        let (state, _) = run([(0, signals(working: ["a"])), (4, signals())])
        XCTAssertEqual(phase(state, after: 30), .idle)
    }

    // MARK: Signals from the inbox

    func testSignalsReadChatsAndBotsFromShownOnlineMachinesOnly() {
        let working = AidenChatSummary(
            id: "run", workspaceId: "w", title: "Run", titlePending: false,
            createdAt: t0, updatedAt: t0, revision: "1", activity: .active
        )
        let waiting = AidenChatSummary(
            id: "ask", workspaceId: "w", title: "Ask", titlePending: false,
            createdAt: t0, updatedAt: t0, revision: "1", activity: .active, rowState: .needsApproval
        )
        let broken = AidenChatSummary(
            id: "bad", workspaceId: "w", title: "Bad", titlePending: false,
            createdAt: t0, updatedAt: t0, revision: "1", activity: .idle, unread: true, lastRunFailed: true
        )
        func snapshot(_ id: String, online: Bool = true, fetched: Bool = true) -> AidenHostInboxSnapshot {
            AidenHostInboxSnapshot(
                instanceId: id, deviceId: "d", chats: [working, waiting, broken], workspaceNames: [:],
                isOnline: online, isBlocked: false, fetchedAt: fetched ? t0 : nil,
                supportsReadState: true, supportsTriage: false, bots: []
            )
        }
        let signals = AidenActivitySignals.make(
            snapshots: [snapshot("shown"), snapshot("hidden"), snapshot("offline", online: false), snapshot("cached", fetched: false)],
            hiddenMachines: ["hidden"]
        )
        XCTAssertEqual(signals.working, [AidenActivityKey(scope: "shown", id: "chat:run"), AidenActivityKey(scope: "cached", id: "chat:run")])
        XCTAssertEqual(signals.needsYou.map(\.id).sorted(), ["chat:ask", "chat:ask"])
        XCTAssertEqual(signals.failed.map(\.scope).sorted(), ["cached", "shown"])
        XCTAssertEqual(signals.liveScopes, ["shown"])
    }

    // MARK: Gate

    func testGateHidesInLowPowerAndHoldsStillForAccessibility() {
        var gate = AidenAmbientGate(
            level: .subtle, sceneActive: true, lowPowerMode: false, visible: true,
            reduceMotion: false, reduceTransparency: false, voiceOver: false
        )
        XCTAssertEqual(gate.rendering, .animated)
        XCTAssertFalse(gate.isPaused)

        gate.lowPowerMode = true
        XCTAssertEqual(gate.rendering, .hidden)
        gate.lowPowerMode = false

        for flag in [\AidenAmbientGate.reduceMotion, \.reduceTransparency, \.voiceOver] {
            var still = gate
            still[keyPath: flag] = true
            XCTAssertEqual(still.rendering, .still)
            XCTAssertTrue(still.isPaused)
        }

        var background = gate
        background.sceneActive = false
        XCTAssertTrue(background.isPaused)
        var offscreen = gate
        offscreen.visible = false
        XCTAssertTrue(offscreen.isPaused)
        var off = gate
        off.level = .off
        XCTAssertEqual(off.rendering, .hidden)
    }

    // MARK: Palette and contrast

    private var everyPalette: [(String, AidenPalette)] {
        AidenThemePresetID.allCases.flatMap { preset in
            [ColorScheme.light, .dark].map { scheme in
                ("\(preset.rawValue)/\(scheme == .dark ? "dark" : "light")", AidenThemeCatalog.palette(preset: preset, scheme: scheme))
            }
        }
    }

    private func hue(_ hex: String) -> Double {
        let clean = hex.dropFirst()
        let value = Int(clean, radix: 16) ?? 0
        let r = Double((value >> 16) & 0xFF) / 255
        let g = Double((value >> 8) & 0xFF) / 255
        let b = Double(value & 0xFF) / 255
        let maxC = max(r, g, b), minC = min(r, g, b), delta = maxC - minC
        guard delta > 0 else { return 0 }
        var h: Double
        if maxC == r { h = (g - b) / delta } else if maxC == g { h = (b - r) / delta + 2 } else { h = (r - g) / delta + 4 }
        h *= 60
        return h < 0 ? h + 360 : h
    }

    private func hueDistance(_ a: String, _ b: String) -> Double {
        let d = abs(hue(a) - hue(b))
        return min(d, 360 - d)
    }

    func testActivityDefaultsToTheBlueForEachScheme() {
        XCTAssertEqual(AidenThemeCatalog.palette(preset: .aiden, scheme: .light).activityHex, "#006AD6")
        XCTAssertEqual(AidenThemeCatalog.palette(preset: .aiden, scheme: .dark).activityHex, "#3E97F6")
    }

    func testActivityHueStaysClearOfEveryStatusColour() {
        for (name, palette) in everyPalette {
            for status in [palette.successHex, palette.warningHex, palette.dangerHex] {
                XCTAssertGreaterThanOrEqual(hueDistance(palette.activityHex, status), 30, "\(name) activity vs \(status)")
            }
        }
    }

    func testEveryStateAtItsCapLeavesTextLegibleOverTheCanvas() {
        for (name, palette) in everyPalette {
            for level in [AidenAuroraLevel.subtle, .vivid] {
                let cap = AidenAuroraContrast.maximumOpacity(level, palette: palette)
                for activity in AidenAmbientActivity.allCases {
                    let colour = AidenAuroraTone.of(activity).hex(in: palette)
                    // The brightest point: the state's colour at full strength
                    // and the level's cap, laid over the canvas.
                    let ground = Color.mixHex(palette.canvasHex, colour, fraction: cap)
                    XCTAssertGreaterThanOrEqual(
                        Color.contrastRatio(palette.foregroundHex, ground), 4.5,
                        "\(name) \(level) \(activity) foreground"
                    )
                    XCTAssertGreaterThanOrEqual(
                        Color.contrastRatio(palette.secondaryHex, ground), 3.0,
                        "\(name) \(level) \(activity) secondary"
                    )
                }
            }
        }
    }

    func testCapsStayVisibleAndVividIsNeverWeakerThanSubtle() {
        for (name, palette) in everyPalette {
            let subtle = AidenAuroraContrast.maximumOpacity(.subtle, palette: palette)
            let vivid = AidenAuroraContrast.maximumOpacity(.vivid, palette: palette)
            XCTAssertGreaterThan(subtle, 0.05, "\(name) subtle would be invisible")
            XCTAssertGreaterThanOrEqual(vivid, subtle, name)
            XCTAssertLessThanOrEqual(subtle, AidenAuroraLevel.subtle.nominalOpacity, name)
            XCTAssertEqual(AidenAuroraContrast.maximumOpacity(.off, palette: palette), 0, name)
            XCTAssertEqual(
                AidenAuroraContrast.maximumOpacity(.vivid, palette: palette, increasedContrast: true),
                vivid / 2, accuracy: 0.0001, name
            )
        }
    }

    // MARK: Setting

    func testAmbientBackgroundDefaultsToSubtleAndFollowingAndPersists() throws {
        let suite = "aurora-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = AidenAppearanceStore(defaults: defaults)
        XCTAssertEqual(store.auroraLevel, .subtle)
        XCTAssertTrue(store.auroraFollowsActivity)
        store.auroraLevel = .vivid
        store.auroraFollowsActivity = false

        let reopened = AidenAppearanceStore(defaults: defaults)
        XCTAssertEqual(reopened.auroraLevel, .vivid)
        XCTAssertFalse(reopened.auroraFollowsActivity)
    }

    func testFooterAddsTheLowPowerNoteOnlyWhileItIsOn() {
        XCTAssertFalse(AidenAmbientBackgroundSection.footer(lowPowerMode: false).contains("Off while Low Power Mode is on"))
        XCTAssertTrue(AidenAmbientBackgroundSection.footer(lowPowerMode: true).hasSuffix("Off while Low Power Mode is on."))
    }
}
