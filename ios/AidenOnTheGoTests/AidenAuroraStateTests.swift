import Synchronization
import SwiftUI
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenAuroraStateTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_787_100_000)
    private let mac = "mac-1"

    private func key(_ id: String, on scope: String? = nil) -> AidenActivityKey {
        AidenActivityKey(scope: scope ?? mac, id: id)
    }

    /// One read of the signals. Live machines report a fetch at `fetched`
    /// seconds; `idle` lists the chats and Bots resting normally.
    private func signals(
        working: [String] = [],
        needsYou: [String] = [],
        failed: [String] = [],
        idle: [String] = [],
        live: [String]? = nil,
        fetched: TimeInterval = 0,
        listening: Bool = false
    ) -> AidenActivitySignals {
        let scopes = live ?? [mac]
        return AidenActivitySignals(
            working: Set(working.map { key($0) }),
            needsYou: Set(needsYou.map { key($0) }),
            failed: Set(failed.map { key($0) }),
            quiet: Set(idle.map { key($0) }),
            liveScopes: Set(scopes),
            fetchedAt: Dictionary(uniqueKeysWithValues: scopes.map { ($0, t0.addingTimeInterval(fetched)) }),
            listening: listening
        )
    }

    /// Applies each read at its time and returns the phase straight after.
    private func run(_ steps: [(TimeInterval, AidenActivitySignals)]) -> (AidenAuroraState, [AidenAmbientActivity]) {
        var state = AidenAuroraState()
        var phases: [AidenAmbientActivity] = []
        for (time, next) in steps {
            state.apply(next, now: time)
            phases.append(state.phase(at: time))
        }
        return (state, phases)
    }

    private func phase(_ state: AidenAuroraState, after seconds: TimeInterval) -> AidenAmbientActivity {
        var state = state
        state.settle(now: seconds)
        return state.phase(at: seconds)
    }

    // MARK: Priority

    func testPriorityFollowsListeningNeedsYouFailedDoneWorkingIdle() {
        let (_, phases) = run([
            (0, signals(working: ["a"], needsYou: ["b"], failed: ["c"], listening: true)),
            (1, signals(working: ["a"], needsYou: ["b"], failed: ["c"])),
            (2, signals(working: ["a"], failed: ["c"])),
            (3, signals(working: ["a"])),
            (4, signals(idle: ["a"])),
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
            (1, signals(working: ["b"], idle: ["a"])),
        ])
        XCTAssertEqual(phase(state, after: 1.7), .done)
        XCTAssertEqual(phase(state, after: 3.7), .working)
    }

    // MARK: Debounce

    func testWorkHoldsForSixHundredMillisecondsBeforeGoingQuiet() {
        let (state, phases) = run([
            (0, signals(working: ["a"])),
            (10, signals(idle: ["a"])),
        ])
        XCTAssertEqual(phases.last, .working)
        XCTAssertEqual(phase(state, after: 10.5), .working)
        XCTAssertNotEqual(phase(state, after: 10.61), .working)
    }

    func testARunThatResumesInsideTheHoldNeverLeavesWorkingOrShowsDone() {
        let (state, phases) = run([
            (0, signals(working: ["a"])),
            (5, signals(idle: ["a"])),
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
        let (state, phases) = run([(0, signals(idle: ["a"]))])
        XCTAssertEqual(phases, [.idle])
        XCTAssertEqual(phase(state, after: 1), .idle)
        XCTAssertNil(state.nextChange)
    }

    func testAFinishedRunShowsDoneAfterTheHold() {
        let (state, _) = run([(0, signals(working: ["a"])), (4, signals(idle: ["a"]))])
        XCTAssertEqual(phase(state, after: 4.61), .done)
    }

    func testAnArchivedOrDeletedChatIsNotAFinish() {
        // The chat leaves the list altogether rather than coming to rest.
        let (state, _) = run([(0, signals(working: ["a"])), (4, signals())])
        XCTAssertEqual(phase(state, after: 4.61), .idle)
        XCTAssertEqual(phase(state, after: 5), .idle)
    }

    func testABotThatPausesOrGoesUnavailableIsNotAFinish() throws {
        func bot(_ state: AidenBotSessionStateKind) throws -> AidenBotSummary {
            var object: [String: Any] = [
                "id": "courier", "name": "Courier", "purpose": "",
                "avatar": ["semantic": ["version": 1, "shape": "orb", "color": "rose"]],
                "health": state == .unavailable ? "unavailable" : "ready",
                "createdAt": "2026-08-01T10:00:00.000Z", "updatedAt": "2026-08-01T10:00:00.000Z",
                "revision": "bot_revision_courier", "sessionState": state.rawValue,
            ]
            if state == .paused { object["paused"] = true }
            return try AidenRemoteJSONDecoder.decode(AidenBotSummary.self, from: JSONSerialization.data(withJSONObject: object))
        }
        func read(_ state: AidenBotSessionStateKind) throws -> AidenActivitySignals {
            AidenActivitySignals.make(snapshots: [snapshot(mac, bots: [try bot(state)])], hiddenMachines: [])
        }
        for stop in [AidenBotSessionStateKind.paused, .unavailable] {
            let (state, _) = try run([(0, read(.running)), (4, read(stop))])
            XCTAssertEqual(phase(state, after: 4.61), .idle, "\(stop)")
        }
        let (finished, _) = try run([(0, read(.running)), (4, read(.idle))])
        XCTAssertEqual(phase(finished, after: 4.61), .done)
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
            (9, signals(idle: ["a"], fetched: 9)),
        ])
        XCTAssertEqual(phase(state, after: 10), .idle)
    }

    func testAReconnectThatShowsTheOldRowsFirstIsNotAFinish() {
        // Back online, the list still holds the rows from before the drop
        // (same fetch) and says the run is working. The first fresh list
        // then says it rests: the run finished while the machine was away.
        let (state, phases) = run([
            (0, signals(working: ["a"], fetched: 0)),
            (4, signals(live: [])),
            (9, signals(working: ["a"], fetched: 0)),
            (10, signals(idle: ["a"], fetched: 10)),
        ])
        XCTAssertEqual(phases.last, .idle)
        XCTAssertEqual(phase(state, after: 10.7), .idle)
        XCTAssertEqual(phase(state, after: 12), .idle)
    }

    func testAReconnectedRunThatFinishesLaterStillShowsDone() {
        let (state, _) = run([
            (0, signals(working: ["a"], fetched: 0)),
            (4, signals(live: [])),
            (9, signals(working: ["a"], fetched: 9)),
            (12, signals(idle: ["a"], fetched: 12)),
        ])
        XCTAssertEqual(phase(state, after: 12.7), .done)
    }

    func testCachedRowsBeforeTheFirstLiveListDoNotCount() {
        let (state, _) = run([
            (0, signals(working: ["a"], live: [])),
            (2, signals(idle: ["a"])),
        ])
        XCTAssertEqual(phase(state, after: 3), .idle)
    }

    func testARunThatStopsToAskForApprovalIsNotDone() {
        let (state, _) = run([
            (0, signals(working: ["a"])),
            (2, signals(needsYou: ["a"])),
        ])
        XCTAssertEqual(phase(state, after: 3), .needsYou)
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
        var finished = signals(idle: ["a"])
        finished.focused = key("a")
        let (state, _) = run([(0, signals(working: ["a"])), (2, finished)])
        XCTAssertEqual(phase(state, after: 2.7), .idle)
    }

    // MARK: Done expiry

    func testDoneLastsTwoSecondsThenGoesIdle() {
        let (state, _) = run([(0, signals(working: ["a"])), (4, signals(idle: ["a"]))])
        XCTAssertEqual(phase(state, after: 6.5), .done)
        XCTAssertEqual(phase(state, after: 6.61), .idle)
    }

    func testRunsSettlingTogetherHoldDoneFromTheLatestFinish() {
        var (state, _) = run([
            (0, signals(working: ["a", "b"])),
            (1, signals(working: ["b"], idle: ["a"])),
            (1.3, signals(idle: ["a", "b"])),
        ])
        // Both holds end before this one pass.
        state.settle(now: 2)
        XCTAssertEqual(state.phase(at: 2), .done)
        // a's Done would end at 3.6, b's at 3.9.
        XCTAssertEqual(phase(state, after: 3.7), .done)
        XCTAssertEqual(phase(state, after: 3.91), .idle)
    }

    func testNextChangeNamesTheHoldThenTheDoneExpiry() throws {
        var (state, _) = run([(0, signals(working: ["a"])), (4, signals(idle: ["a"]))])
        let hold = try XCTUnwrap(state.nextChange)
        XCTAssertEqual(hold, 4.6, accuracy: 0.001)
        state.settle(now: hold)
        XCTAssertEqual(state.phase(at: hold), .done)
        let expiry = try XCTUnwrap(state.nextChange)
        XCTAssertEqual(expiry, 6.6, accuracy: 0.001)
        state.settle(now: expiry)
        XCTAssertEqual(state.phase(at: expiry), .idle)
        XCTAssertNil(state.nextChange)
    }

    func testAReadLongAfterTheFinishDoesNotReviveAStaleDone() {
        let (state, _) = run([(0, signals(working: ["a"])), (4, signals(idle: ["a"]))])
        XCTAssertEqual(phase(state, after: 30), .idle)
    }

    // MARK: Signals from the inbox

    private func chat(
        _ id: String,
        activity: AidenChatSummaryActivity,
        rowState: AidenChatRowState? = nil,
        failed: Bool = false
    ) -> AidenChatSummary {
        AidenChatSummary(
            id: id, workspaceId: "w", title: id, titlePending: false,
            createdAt: t0, updatedAt: t0, revision: "1", activity: activity,
            rowState: rowState, unread: failed, lastRunFailed: failed
        )
    }

    private func snapshot(
        _ id: String,
        chats: [AidenChatSummary] = [],
        bots: [AidenBotSummary] = [],
        online: Bool = true,
        fetchedAt: Date? = nil,
        fetched: Bool = true
    ) -> AidenHostInboxSnapshot {
        AidenHostInboxSnapshot(
            instanceId: id, deviceId: "d", chats: chats, workspaceNames: [:],
            isOnline: online, isBlocked: false, fetchedAt: fetched ? (fetchedAt ?? t0) : nil,
            supportsReadState: true, supportsTriage: false, bots: bots
        )
    }

    func testSignalsReadChatsAndBotsFromShownOnlineMachinesOnly() {
        let chats = [
            chat("run", activity: .active),
            chat("ask", activity: .active, rowState: .needsApproval),
            chat("bad", activity: .idle, failed: true),
            chat("rest", activity: .idle),
        ]
        let signals = AidenActivitySignals.make(
            snapshots: [
                snapshot("shown", chats: chats),
                snapshot("hidden", chats: chats),
                snapshot("offline", chats: chats, online: false),
                snapshot("cached", chats: chats, fetched: false),
            ],
            hiddenMachines: ["hidden"]
        )
        XCTAssertEqual(signals.working, [AidenActivityKey(scope: "shown", id: "chat:run"), AidenActivityKey(scope: "cached", id: "chat:run")])
        XCTAssertEqual(signals.needsYou.map(\.id).sorted(), ["chat:ask", "chat:ask"])
        XCTAssertEqual(signals.failed.map(\.scope).sorted(), ["cached", "shown"])
        // A failed chat is not resting normally.
        XCTAssertEqual(signals.quiet.map(\.id), ["chat:rest", "chat:rest"])
        XCTAssertEqual(signals.liveScopes, ["shown"])
        XCTAssertEqual(signals.fetchedAt, ["shown": t0])
    }

    // MARK: Gate

    func testGateHidesInLowPowerAndHoldsStillForAccessibility() {
        var gate = AidenAmbientGate(
            level: .subtle, sceneActive: true, lowPowerMode: false, visible: true,
            reduceMotion: false, reduceTransparency: false, voiceOver: false
        )
        XCTAssertEqual(gate.rendering, .animated)
        XCTAssertFalse(gate.isPaused)
        XCTAssertEqual(gate.stillScale, 1)

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

    func testAStillGradientIsDimmedUnlessReduceTransparencyAlreadyCapsIt() {
        var still = AidenAmbientGate(
            level: .vivid, sceneActive: true, lowPowerMode: false, visible: true,
            reduceMotion: true, reduceTransparency: false, voiceOver: false
        )
        XCTAssertLessThan(still.stillScale, 1)
        still.reduceTransparency = true
        XCTAssertEqual(still.stillScale, 1)
    }

    func testFollowActivityOffShowsOnlyListeningAndAForcedPhaseWins() {
        XCTAssertEqual(AidenAmbientAurora.shown(.working, followsActivity: true), .working)
        for activity in AidenAmbientActivity.allCases where activity != .listening {
            XCTAssertEqual(AidenAmbientAurora.shown(activity, followsActivity: false), .idle, "\(activity)")
        }
        XCTAssertEqual(AidenAmbientAurora.shown(.listening, followsActivity: false), .listening)
        XCTAssertEqual(AidenAmbientAurora.shown(.idle, followsActivity: false, forced: .done), .done)
    }

    // MARK: Band

    func testTheBandIsAtMost400PointsAndFadesOutBy45PercentOfTheView() {
        for height in [300.0, 600, 874, 1366] {
            let band = AidenAmbientLayout.band(forHeight: height)
            XCTAssertLessThanOrEqual(band.height, 400, "\(height)")
            // The fade ends 45% up the view, or at the band's top if lower.
            XCTAssertEqual(band.height * band.fadeEnd, min(height * 0.45, band.height), accuracy: 0.01, "\(height)")
        }
        XCTAssertEqual(AidenAmbientLayout.band(forHeight: 874).height, 400)
    }

    // MARK: Drift

    func testDriftCarriesOnAcrossASpeedChangeInsteadOfJumping() {
        var drift = AidenAuroraDrift()
        _ = drift.advance(to: 100, speed: 0.5)
        let before = drift.advance(to: 100.05, speed: 0.5)
        let after = drift.advance(to: 100.1, speed: 0.1)
        // One 50 ms frame at the new speed: a cycle every 200 s.
        XCTAssertEqual(after - before, 0.05 * 0.1 * 2 * .pi / 20, accuracy: 1e-9)
    }

    func testDriftAfterAPauseMovesOnlyOneShortStep() {
        var drift = AidenAuroraDrift()
        _ = drift.advance(to: 0, speed: 0.5)
        let resumed = drift.advance(to: 600, speed: 0.5)
        XCTAssertLessThanOrEqual(resumed, AidenAuroraDrift.maximumStep * 0.5 * 2 * .pi / 20 + 1e-9)
    }

    func testListeningHoldsTheMeshStillAndTheMicLiftsIt() {
        let quiet = AidenAuroraTone.of(.listening, micLevel: 0)
        let loud = AidenAuroraTone.of(.listening, micLevel: 1)
        XCTAssertEqual(quiet.speed, 0)
        XCTAssertEqual(loud.speed, 0)
        XCTAssertGreaterThan(loud.lift, quiet.lift)
        XCTAssertGreaterThan(loud.intensity, quiet.intensity)
        var drift = AidenAuroraDrift()
        _ = drift.advance(to: 0, speed: 0.5)
        let held = drift.advance(to: 0.05, speed: 0.5)
        XCTAssertEqual(drift.advance(to: 0.1, speed: quiet.speed), held)
    }

    // MARK: Palette and contrast

    private var everyPalette: [(String, AidenPalette)] {
        AidenThemePresetID.allCases.flatMap { preset in
            [ColorScheme.light, .dark].map { scheme in
                ("\(preset.rawValue)/\(scheme == .dark ? "dark" : "light")", AidenThemeCatalog.palette(preset: preset, scheme: scheme))
            }
        }
    }

    private func channels(_ hex: String) -> [Double] {
        let value = Int(hex.dropFirst(), radix: 16) ?? 0
        return [16, 8, 0].map { Double((value >> $0) & 0xFF) }
    }

    private func hexString(_ rgb: [Double]) -> String {
        String(format: "#%02X%02X%02X", Int(rgb[0]), Int(rgb[1]), Int(rgb[2]))
    }

    /// `share` of the way from `a` to `b`, per 8-bit channel.
    private func blend(_ a: String, _ b: String, _ share: Double) -> String {
        hexString(zip(channels(a), channels(b)).map { ($0 + ($1 - $0) * share).rounded() })
    }

    /// WCAG 2.x contrast between two sRGB colours.
    private func contrast(_ a: String, _ b: String) -> Double {
        func luminance(_ hex: String) -> Double {
            let c = channels(hex).map { v -> Double in
                let s = v / 255
                return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        }
        let (x, y) = (luminance(a), luminance(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    /// The worst text contrast over any colour the mesh can draw at
    /// `opacity`: each status colour, and each 16% toward white and toward
    /// black (the mesh's edges), laid over the canvas.
    private func worstContrast(_ palette: AidenPalette, opacity: Double) -> (foreground: Double, secondary: Double) {
        var foreground = Double.infinity, secondary = Double.infinity
        for base in [palette.secondaryHex, palette.activityHex, palette.warningHex, palette.successHex, palette.dangerHex] {
            for stop in [base, blend(base, "#FFFFFF", 0.16), blend(base, "#000000", 0.16)] {
                let ground = blend(palette.canvasHex, stop, opacity)
                foreground = min(foreground, contrast(palette.foregroundHex, ground))
                secondary = min(secondary, contrast(palette.secondaryHex, ground))
            }
        }
        return (foreground, secondary)
    }

    func testEveryDrawnColourAtTheCapLeavesTextLegible() {
        for (name, palette) in everyPalette {
            for level in [AidenAuroraLevel.subtle, .vivid] {
                let worst = worstContrast(palette, opacity: AidenAuroraContrast.maximumOpacity(level, palette: palette))
                XCTAssertGreaterThanOrEqual(worst.foreground, 4.5, "\(name) \(level) body text")
                XCTAssertGreaterThanOrEqual(worst.secondary, 3.0, "\(name) \(level) secondary text")
            }
        }
    }

    func testTheContrastCheckCatchesTheShadedEdgesTheOldCapMissed() {
        // Step 1 capped Aiden light Vivid at 0.28, checking the base colour
        // only. Its darker edges leave secondary text under 3:1.
        let palette = AidenThemeCatalog.palette(preset: .aiden, scheme: .light)
        XCTAssertLessThan(worstContrast(palette, opacity: 0.28).secondary, 3.0)
        XCTAssertLessThan(AidenAuroraContrast.maximumOpacity(.vivid, palette: palette), 0.28)
    }

    func testVividIsStrongerThanSubtleInEveryPreset() {
        for (name, palette) in everyPalette {
            let subtle = AidenAuroraContrast.maximumOpacity(.subtle, palette: palette)
            let vivid = AidenAuroraContrast.maximumOpacity(.vivid, palette: palette)
            XCTAssertGreaterThan(subtle, 0.05, "\(name) subtle would be invisible")
            XCTAssertGreaterThan(vivid, subtle, name)
            XCTAssertLessThanOrEqual(subtle, AidenAuroraLevel.subtle.nominalOpacity, name)
            XCTAssertLessThanOrEqual(vivid, AidenAuroraLevel.vivid.nominalOpacity, name)
            XCTAssertEqual(AidenAuroraContrast.maximumOpacity(.off, palette: palette), 0, name)
        }
    }

    func testIncreaseContrastAndReduceTransparencyCapAtHalfOfSubtle() {
        for (name, palette) in everyPalette {
            let half = AidenAuroraContrast.maximumOpacity(.subtle, palette: palette) / 2
            for level in [AidenAuroraLevel.subtle, .vivid] {
                XCTAssertEqual(AidenAuroraContrast.maximumOpacity(level, palette: palette, increasedContrast: true), half, accuracy: 0.0001, name)
                XCTAssertEqual(AidenAuroraContrast.maximumOpacity(level, palette: palette, reduceTransparency: true), half, accuracy: 0.0001, name)
            }
        }
    }

    private func hue(_ hex: String) -> Double? {
        let rgb = channels(hex).map { $0 / 255 }
        let maxC = rgb.max() ?? 0, minC = rgb.min() ?? 0, delta = maxC - minC
        guard delta > 0.02 else { return nil }
        var h: Double
        if maxC == rgb[0] { h = (rgb[1] - rgb[2]) / delta } else if maxC == rgb[1] { h = (rgb[2] - rgb[0]) / delta + 2 } else { h = (rgb[0] - rgb[1]) / delta + 4 }
        h *= 60
        return h < 0 ? h + 360 : h
    }

    func testActivityDefaultsToTheBlueForEachScheme() {
        XCTAssertEqual(AidenThemeCatalog.palette(preset: .aiden, scheme: .light).activityHex, "#006AD6")
        XCTAssertEqual(AidenThemeCatalog.palette(preset: .aiden, scheme: .dark).activityHex, "#3E97F6")
    }

    func testMonochromeWorkGlowsGreyNotBlue() {
        for scheme in [ColorScheme.light, .dark] {
            let palette = AidenThemeCatalog.palette(preset: .monochrome, scheme: scheme)
            XCTAssertNil(hue(palette.activityHex), "\(scheme) activity has a hue")
            XCTAssertEqual(palette.activityHex, palette.secondaryHex)
        }
    }

    func testAColouredActivityHueStaysClearOfEveryStatusColour() {
        for (name, palette) in everyPalette {
            guard let activity = hue(palette.activityHex) else { continue }
            for status in [palette.successHex, palette.warningHex, palette.dangerHex] {
                guard let other = hue(status) else { continue }
                let d = abs(activity - other)
                XCTAssertGreaterThanOrEqual(min(d, 360 - d), 30, "\(name) activity vs \(status)")
            }
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

    func testFooterNamesEachStillCaseAndLowPowerOnce() {
        for lowPower in [false, true] {
            let footer = AidenAmbientBackgroundSection.footer(lowPowerMode: lowPower)
            XCTAssertEqual(footer.components(separatedBy: "Low Power Mode").count - 1, 1, footer)
            XCTAssertTrue(footer.contains("Reduce Transparency"), footer)
            XCTAssertTrue(footer.contains("VoiceOver"), footer)
        }
        XCTAssertNotEqual(
            AidenAmbientBackgroundSection.footer(lowPowerMode: true),
            AidenAmbientBackgroundSection.footer(lowPowerMode: false)
        )
    }

    // MARK: Activity model and its timer

    private func liveSnapshot(working: Bool, fetched: TimeInterval = 0) -> AidenHostInboxSnapshot {
        snapshot(mac, chats: [chat("a", activity: working ? .active : .idle)], fetchedAt: t0.addingTimeInterval(fetched))
    }

    /// Lets the model's wake task run until `condition` holds.
    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { await Task.yield() }
    }

    func testTheWakeTurnsAFinishIntoDoneThenIdle() async {
        let clock = AidenAuroraTestClock()
        let model = AidenAmbientActivityModel(clock: clock)
        model.update(snapshots: [liveSnapshot(working: true)], hiddenMachines: [], focusedChat: nil)
        XCTAssertEqual(model.activity, .working)

        model.update(snapshots: [liveSnapshot(working: false)], hiddenMachines: [], focusedChat: nil)
        XCTAssertEqual(model.activity, .working, "Held while the run settles")
        await settle { clock.sleeperCount == 1 }
        XCTAssertEqual(clock.sleeperCount, 1)

        clock.advance(by: .milliseconds(600))
        await settle { model.activity == .done }
        XCTAssertEqual(model.activity, .done)

        await settle { clock.sleeperCount == 1 }
        clock.advance(by: .seconds(2))
        await settle { model.activity == .idle }
        XCTAssertEqual(model.activity, .idle)
        await settle { clock.sleeperCount == 0 }
        XCTAssertEqual(clock.sleeperCount, 0)
    }

    func testANewerReadCancelsTheOlderWake() async {
        let clock = AidenAuroraTestClock()
        let model = AidenAmbientActivityModel(clock: clock)
        model.update(snapshots: [liveSnapshot(working: true)], hiddenMachines: [], focusedChat: nil)
        model.update(snapshots: [liveSnapshot(working: false)], hiddenMachines: [], focusedChat: nil)
        await settle { clock.sleeperCount == 1 }

        // The run resumes inside the hold: nothing is left to wake for.
        model.update(snapshots: [liveSnapshot(working: true)], hiddenMachines: [], focusedChat: nil)
        await settle { clock.sleeperCount == 0 }
        XCTAssertEqual(clock.sleeperCount, 0)
        clock.advance(by: .seconds(5))
        await settle { model.activity != .working }
        XCTAssertEqual(model.activity, .working)
    }

    func testListeningTakesOverAndHandsBackTheWorkPhase() async {
        let clock = AidenAuroraTestClock()
        let model = AidenAmbientActivityModel(clock: clock)
        model.update(snapshots: [liveSnapshot(working: true)], hiddenMachines: [], focusedChat: nil)
        model.setVoice(listening: true, level: 0.2)
        XCTAssertEqual(model.activity, .listening)
        XCTAssertEqual(model.micLevel, 0.2, accuracy: 0.0001)
        model.setVoice(listening: false, level: 0)
        XCTAssertEqual(model.activity, .working)
        XCTAssertEqual(model.micLevel, 0)
    }

    func testAMicLevelTickKeepsThePendingWake() async {
        let clock = AidenAuroraTestClock()
        let model = AidenAmbientActivityModel(clock: clock)
        model.update(snapshots: [liveSnapshot(working: true)], hiddenMachines: [], focusedChat: nil)
        model.update(snapshots: [liveSnapshot(working: false)], hiddenMachines: [], focusedChat: nil)
        await settle { clock.sleeperCount == 1 }
        model.setVoice(listening: true, level: 0.1)
        await settle { clock.sleeperCount == 1 }
        let wakesBefore = clock.sleepsStarted
        for level in stride(from: 0.2, through: 1, by: 0.2) {
            model.setVoice(listening: true, level: level)
        }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(clock.sleepsStarted, wakesBefore, "A level change restarted the wake")
        XCTAssertEqual(model.micLevel, 1, accuracy: 0.0001)
        XCTAssertEqual(model.activity, .listening)
    }
}

/// A clock the test moves by hand. A sleeper wakes once `advance` reaches its
/// deadline, or throws when its task is cancelled.
final class AidenAuroraTestClock: Clock, Sendable {
    struct Instant: InstantProtocol {
        let offset: Duration
        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
    }

    private struct Sleeper {
        let id: Int
        let deadline: Instant
        let continuation: CheckedContinuation<Void, any Error>
    }

    private struct State {
        var now = Instant(offset: .zero)
        var sleepers: [Sleeper] = []
        var cancelled: Set<Int> = []
        var started = 0
    }

    private let state = Mutex(State())

    var now: Instant { state.withLock { $0.now } }
    var minimumResolution: Duration { .zero }
    var sleeperCount: Int { state.withLock { $0.sleepers.count } }
    var sleepsStarted: Int { state.withLock { $0.started } }

    func sleep(until deadline: Instant, tolerance: Duration?) async throws {
        let id = state.withLock { state -> Int in
            state.started += 1
            return state.started
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let outcome: Result<Void, any Error>? = state.withLock { state in
                    if state.cancelled.remove(id) != nil { return .failure(CancellationError()) }
                    if deadline <= state.now { return .success(()) }
                    state.sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
                    return nil
                }
                if let outcome { continuation.resume(with: outcome) }
            }
        } onCancel: {
            let sleeper = state.withLock { state -> Sleeper? in
                guard let index = state.sleepers.firstIndex(where: { $0.id == id }) else {
                    state.cancelled.insert(id)
                    return nil
                }
                return state.sleepers.remove(at: index)
            }
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    func advance(by duration: Duration) {
        let due = state.withLock { state -> [Sleeper] in
            state.now = state.now.advanced(by: duration)
            let now = state.now
            let due = state.sleepers.filter { $0.deadline <= now }
            state.sleepers.removeAll { $0.deadline <= now }
            return due
        }
        for sleeper in due { sleeper.continuation.resume() }
    }
}
