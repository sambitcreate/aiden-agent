import SwiftUI
import XCTest
@testable import AidenOnTheGo

/// The Hi-bit sprite against the shared `botAvatarSprite` fixture, and its states.
final class AidenBotSpriteFixtureTests: XCTestCase {
    private func sprite() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try XCTUnwrap(object["botAvatarSprite"] as? [String: Any])
    }

    func testBodiesAndTonesMatchTheSharedFixture() throws {
        let sprite = try sprite()
        XCTAssertEqual(sprite["gridSize"] as? Int, AidenBotSprite.gridSize)
        XCTAssertEqual(sprite["viewBox"] as? Double, AidenBotSprite.viewBox)
        XCTAssertEqual(sprite["smallMaxPx"] as? Double, AidenBotSprite.smallMaxPoints)
        XCTAssertEqual(sprite["smallGlintHex"] as? String, AidenBotSprite.smallGlintHex)
        XCTAssertEqual(String(format: "#%06X", AidenBotSprite.smallGlintRGB), AidenBotSprite.smallGlintHex)

        let bodies = try XCTUnwrap(sprite["bodies"] as? [String: String])
        XCTAssertEqual(Set(bodies.keys), Set(AidenBotAvatarShape.allCases.map(\.rawValue)))
        for shape in AidenBotAvatarShape.allCases {
            XCTAssertEqual(AidenBotSprite.body(for: shape), bodies[shape.rawValue], "\(shape.rawValue) body differs")
        }

        let tones = try XCTUnwrap(sprite["tones"] as? [String: [String: String]])
        XCTAssertEqual(Set(tones.keys), Set(AidenBotAvatarColor.allCases.map(\.rawValue)))
        func hex(_ rgb: UInt32) -> String { String(format: "#%06X", rgb) }
        for color in AidenBotAvatarColor.allCases {
            let tone = color.spriteTone
            let expected = try XCTUnwrap(tones[color.rawValue])
            let actual = [
                "tint": hex(tone.tint), "shade": hex(tone.shade), "deep": hex(tone.deep),
                "light": hex(tone.light), "markLight": hex(tone.markLight), "markDark": hex(tone.markDark),
            ]
            XCTAssertEqual(actual, expected, "\(color.rawValue) tones differ")
            XCTAssertEqual(tone.tint, color.rgb, "the body is the character colour")
        }
    }

    func testExpansionReproducesEveryFixtureGrid() throws {
        let grids = try XCTUnwrap(try sprite()["grids"] as? [String: [String: [String]]])
        XCTAssertEqual(Set(grids.keys), Set(AidenBotAvatarShape.allCases.map(\.rawValue)))
        for shape in AidenBotAvatarShape.allCases {
            let expected = try XCTUnwrap(grids[shape.rawValue])
            for (cut, small) in [("full", false), ("small", true)] {
                let rows = AidenBotSprite.grid(for: shape, small: small).map { String($0.map(\.rawValue)) }
                XCTAssertEqual(rows, expected[cut], "\(shape.rawValue) \(cut) grid differs")
            }
        }
    }
}

final class AidenBotAvatarStateTests: XCTestCase {
    private func working(_ phase: String?, streaming: Bool = false) -> AidenBotAvatarSignal {
        AidenBotAvatarSignal(working: true, phase: phase, streamingText: streaming)
    }

    func testTheActivitySignalPicksTheState() {
        XCTAssertEqual(aidenBotAvatarState(for: .init()), .idle)
        XCTAssertEqual(aidenBotAvatarState(for: .init(lastTurnFailed: true)), .error, "a failed turn heads to error; the settler decides if it shows")
        XCTAssertEqual(aidenBotAvatarState(for: .init(session: .interrupted)), .error)
        XCTAssertEqual(aidenBotAvatarState(for: .init(session: .needsModel)), .error)
        XCTAssertEqual(aidenBotAvatarState(for: .init(session: .paused)), .idle)
        XCTAssertEqual(aidenBotAvatarState(for: .init(sending: true)), .thinking, "a message on its way shows thought at once")
        XCTAssertEqual(aidenBotAvatarState(for: working(nil)), .thinking)
        XCTAssertEqual(aidenBotAvatarState(for: working("preparing")), .thinking)
        XCTAssertEqual(aidenBotAvatarState(for: working("thinking")), .thinking)
        XCTAssertEqual(aidenBotAvatarState(for: working("tidying")), .thinking, "tidying is thought, as on the desktop")
        for phase in ["reading", "searching", "photo"] {
            XCTAssertEqual(aidenBotAvatarState(for: working(phase)), .reading, phase)
        }
        XCTAssertEqual(aidenBotAvatarState(for: working("editing")), .editing)
        XCTAssertEqual(aidenBotAvatarState(for: working("writing")), .writing)
        for phase in ["command", "app", "computer", "helper", "remembering", "routine", "working", "a-phase-from-a-newer-mac"] {
            XCTAssertEqual(aidenBotAvatarState(for: working(phase)), .tool, phase)
        }
    }

    func testStreamedTextIsWritingOnlyWhenTheTurnSaysNothingElseOrWrites() {
        XCTAssertEqual(aidenBotAvatarState(for: working(nil, streaming: true)), .writing)
        XCTAssertEqual(aidenBotAvatarState(for: working("writing", streaming: true)), .writing)
        XCTAssertEqual(aidenBotAvatarState(for: working("thinking", streaming: true)), .thinking, "thinking stays thinking")
        XCTAssertEqual(aidenBotAvatarState(for: working("command", streaming: true)), .tool)
        XCTAssertEqual(aidenBotAvatarState(for: working("reading", streaming: true)), .reading)
    }

    func testACardWaitingForThePersonWinsOverTheTurn() {
        var signal = working("command")
        signal.waitingForPerson = true
        XCTAssertEqual(aidenBotAvatarState(for: signal), .waiting)
        XCTAssertEqual(aidenBotAvatarState(for: .init(waitingForPerson: true)), .waiting)
    }
}

final class AidenBotAvatarStateSettlerTests: XCTestCase {
    private let thinking = AidenBotAvatarSignal(working: true, phase: "thinking")
    private func tool(_ phase: String) -> AidenBotAvatarSignal { .init(working: true, phase: phase) }

    func testAViewShowsTheLiveStateAtOnceButNeverAPastOutcome() {
        XCTAssertEqual(AidenBotAvatarStateSettler(signal: thinking, at: 0).shown, .thinking)
        let afterFailure = AidenBotAvatarStateSettler(signal: .init(lastTurnFailed: true), at: 0)
        XCTAssertEqual(afterFailure.shown, .idle)
        XCTAssertNil(afterFailure.nextWake, "nothing is due for a resting Bot")
    }

    func testQuickToolBurstsDoNotFlicker() {
        var settler = AidenBotAvatarStateSettler(signal: thinking, at: 0)
        settler.receive(tool("reading"), at: 1.0)
        settler.receive(tool("command"), at: 1.1)
        settler.receive(tool("editing"), at: 1.2)
        settler.receive(thinking, at: 1.3)
        settler.advance(to: 2)
        XCTAssertEqual(settler.shown, .thinking, "states shorter than the debounce never show")
        XCTAssertNil(settler.pending)

        settler.receive(tool("reading"), at: 3)
        settler.advance(to: 3.2)
        XCTAssertEqual(settler.shown, .thinking)
        XCTAssertEqual(settler.nextWake ?? 0, 3.25, accuracy: 0.0001)
        settler.advance(to: 3.25)
        XCTAssertEqual(settler.shown, .reading, "a state held past the debounce shows")
    }

    func testAFinishedTurnShowsDoneAtOnceThenRestsInIdle() {
        var settler = AidenBotAvatarStateSettler(signal: thinking, at: 0)
        settler.receive(.init(), at: 5)
        XCTAssertEqual(settler.shown, .done, "an outcome needs no debounce")
        XCTAssertEqual(settler.nextWake ?? 0, 6.5, accuracy: 0.0001)
        settler.advance(to: 6.4)
        XCTAssertEqual(settler.shown, .done, "done holds for about 1.5 s")
        settler.advance(to: 6.5)
        XCTAssertEqual(settler.shown, .idle)
        XCTAssertNil(settler.nextWake)

        // Another quiet update later does not replay the hop.
        settler.receive(.init(), at: 10)
        settler.advance(to: 11)
        XCTAssertEqual(settler.shown, .idle)
    }

    func testAFailedTurnShowsErrorAtOnceThenIdle() {
        var settler = AidenBotAvatarStateSettler(signal: tool("command"), at: 0)
        settler.receive(.init(lastTurnFailed: true), at: 2)
        XCTAssertEqual(settler.shown, .error)
        settler.advance(to: 3.5)
        XCTAssertEqual(settler.shown, .idle)
    }

    func testAFailureLandingJustAfterTheEndReplacesDone() {
        var settler = AidenBotAvatarStateSettler(signal: thinking, at: 0)
        settler.receive(.init(), at: 5)
        XCTAssertEqual(settler.shown, .done)
        settler.receive(.init(lastTurnFailed: true), at: 5.1)
        XCTAssertEqual(settler.shown, .error)
        settler.advance(to: 6.6)
        XCTAssertEqual(settler.shown, .idle)
    }

    func testANewTurnRightAfterTheLastFollowsItsDone() {
        var settler = AidenBotAvatarStateSettler(signal: thinking, at: 0)
        settler.receive(.init(), at: 1)
        XCTAssertEqual(settler.shown, .done)
        settler.receive(thinking, at: 1.1)
        settler.advance(to: 2)
        XCTAssertEqual(settler.shown, .thinking)
        XCTAssertNil(settler.nextWake, "the old done's return to idle is dropped")
    }

    func testAShortTurnThatEndedBeforeItShowedSettlesQuietly() {
        var settler = AidenBotAvatarStateSettler(signal: .init(), at: 0)
        settler.receive(thinking, at: 1)
        settler.receive(.init(), at: 1.1)
        XCTAssertEqual(settler.shown, .idle)
        settler.advance(to: 5)
        XCTAssertEqual(settler.shown, .idle, "no done for work never shown")
        XCTAssertNil(settler.nextWake)
    }

    func testASendThatNeverStartedATurnEndsQuietly() {
        var settler = AidenBotAvatarStateSettler(signal: .init(), at: 0)
        settler.receive(.init(sending: true), at: 1)
        settler.advance(to: 1.25)
        XCTAssertEqual(settler.shown, .thinking)
        settler.receive(.init(), at: 3)
        XCTAssertEqual(settler.shown, .idle)
        XCTAssertNil(settler.nextWake)
    }

    func testAStoppedTurnGoesStraightToIdle() {
        var settler = AidenBotAvatarStateSettler(signal: tool("command"), at: 0)
        settler.receive(AidenBotAvatarSignal(working: true, phase: "stopping", stopped: true), at: 1)
        // The stop intent clears with the turn, so the ending signal no longer says so.
        settler.receive(.init(), at: 2)
        XCTAssertEqual(settler.shown, .idle, "a stop is quiet: no hop, no wait")
        XCTAssertNil(settler.pending)
        XCTAssertNil(settler.nextWake)

        // The next turn is not stopped, so it ends with done again.
        settler.receive(thinking, at: 3)
        settler.advance(to: 3.25)
        settler.receive(.init(), at: 5)
        XCTAssertEqual(settler.shown, .done)
    }

    func testAStopArrivingWithTheTurnsEndIsQuiet() {
        var settler = AidenBotAvatarStateSettler(signal: thinking, at: 0)
        settler.receive(.init(stopped: true), at: 2)
        XCTAssertEqual(settler.shown, .idle)
        XCTAssertNil(settler.nextWake)
    }

    func testATurnEndingInterruptedOrNeedingAModelShowsErrorThenIdle() {
        for session in [AidenBotSessionStateKind.interrupted, .needsModel] {
            var settler = AidenBotAvatarStateSettler(signal: thinking, at: 0)
            settler.receive(.init(session: session), at: 2)
            XCTAssertEqual(settler.shown, .error, session.rawValue)
            settler.advance(to: 3.45)
            XCTAssertEqual(settler.shown, .error, "\(session.rawValue) holds for about 1.5 s")
            settler.advance(to: 3.5)
            XCTAssertEqual(settler.shown, .idle, session.rawValue)
        }
        let opened = AidenBotAvatarStateSettler(signal: .init(session: .interrupted), at: 0)
        XCTAssertEqual(opened.shown, .idle, "an old interruption is not replayed")
    }

    func testAViewComingBackNeverReplaysAnEnding() {
        var settler = AidenBotAvatarStateSettler(signal: thinking, at: 0)
        settler.receive(.init(), at: 5)
        XCTAssertEqual(settler.shown, .done)
        settler.resync(.init(), at: 5.2)
        XCTAssertEqual(settler.shown, .idle)
        XCTAssertNil(settler.nextWake)
        settler.resync(tool("reading"), at: 6)
        XCTAssertEqual(settler.shown, .reading, "a Bot still at work shows its work at once")
    }

    /// A Bots list row: it knows a turn runs, and the session's state, never how a turn ended.
    func testAHomeRowNeverShowsDone() {
        let running = AidenBotAvatarSignal(working: true, session: .running)
        var settler = AidenBotAvatarStateSettler(signal: .init(session: .idle), at: 0, showsDone: false)
        settler.receive(running, at: 1)
        XCTAssertEqual(settler.shown, .idle, "working waits out the debounce")
        settler.advance(to: 1.25)
        XCTAssertEqual(settler.shown, .thinking)
        settler.receive(.init(session: .idle), at: 5)
        XCTAssertEqual(settler.shown, .idle, "a normal end settles quietly")
        XCTAssertNil(settler.nextWake)

        for failed in [AidenBotSessionStateKind.interrupted, .needsModel] {
            var row = AidenBotAvatarStateSettler(signal: running, at: 0, showsDone: false)
            row.receive(.init(session: failed), at: 5)
            XCTAssertEqual(row.shown, .error, failed.rawValue)
            row.advance(to: 6.5)
            XCTAssertEqual(row.shown, .idle, failed.rawValue)
        }
    }

    func testATurnEndingPausedGoesStraightToIdle() {
        var settler = AidenBotAvatarStateSettler(signal: tool("reading"), at: 0)
        settler.receive(.init(session: .paused), at: 2)
        XCTAssertEqual(settler.shown, .idle)
        XCTAssertNil(settler.nextWake)
    }

    func testALegacyChatStreamSettlesLikeTheDesktop() {
        func settle(_ end: AidenStreamState?, stopping: Bool = false, awaiting: Bool = false) -> AidenBotAvatarState {
            var settler = AidenBotAvatarStateSettler(signal: .init(stream: .running, isStopping: false), at: 0)
            if stopping { settler.receive(.init(stream: .running, isStopping: true), at: 0.5) }
            settler.receive(.init(stream: end, isStopping: false, awaitingPerson: awaiting), at: 1)
            settler.advance(to: 1.25)
            return settler.shown
        }
        XCTAssertEqual(settle(.waitingForApproval), .waiting)
        XCTAssertEqual(settle(.running, awaiting: true), .waiting, "a pending question waits on the person")
        for state in [AidenStreamState.queued, .running, .reconciling] {
            XCTAssertEqual(settle(state), .thinking, state.rawValue)
        }
        XCTAssertEqual(settle(.error), .error)
        XCTAssertEqual(settle(.interrupted), .error)
        XCTAssertEqual(settle(.done), .done)
        XCTAssertEqual(settle(.cancelled), .idle)
        XCTAssertEqual(settle(.done, stopping: true), .idle, "a stop that lands as done is still quiet")
        XCTAssertEqual(settle(nil), .idle, "a stream cleared mid-run was abandoned, not finished")
        XCTAssertEqual(AidenBotAvatarStateSettler(signal: .init(stream: nil, isStopping: false), at: 0).shown, .idle)
        XCTAssertEqual(AidenBotAvatarStateSettler(signal: .init(stream: .done, isStopping: false), at: 0).shown, .idle,
                       "opening a finished chat shows idle, not done")
    }

    func testAnApprovalBetweenTurnsWaitsThenTheTurnEnds() {
        var settler = AidenBotAvatarStateSettler(signal: tool("command"), at: 0)
        settler.receive(.init(waitingForPerson: true), at: 1)
        settler.advance(to: 1.25)
        XCTAssertEqual(settler.shown, .waiting)
        settler.receive(.init(), at: 4)
        XCTAssertEqual(settler.shown, .done, "the turn that asked ends when the card is answered")
    }
}

final class AidenBotSpritePoseTests: XCTestCase {
    /// Pixel-exact motion: the rig, glitch and plug move in whole quarter-cells
    /// (0.75 of the 48-unit box), never in between.
    func testMotionMovesOnlyInWholeSteps() {
        func onGrid(_ value: Double) -> Bool { abs((value / 0.75).rounded() * 0.75 - value) < 0.0001 }
        for state in AidenBotAvatarState.allCases {
            for tick in 0..<240 {
                let pose = AidenBotSpritePose(state: state, elapsed: Double(tick) / 40)
                for value in [pose.rigX, pose.rigY, pose.glitchX, pose.plugX ?? 0] {
                    XCTAssertTrue(onGrid(value), "\(state) moved \(value) at \(Double(tick) / 40) s")
                }
            }
        }
    }

    func testDoneAndErrorPlayOnceAndRestOnTheirStillPose() {
        for state in [AidenBotAvatarState.done, .error] {
            XCTAssertNotEqual(AidenBotSpritePose(state: state, elapsed: 0.3), AidenBotSpritePose(still: state))
            XCTAssertEqual(AidenBotSpritePose(state: state, elapsed: 0.7), AidenBotSpritePose(still: state))
            XCTAssertEqual(AidenBotSpritePose(state: state, elapsed: 3), AidenBotSpritePose(still: state))
        }
    }

    /// Each loop's length, from the plan's state table.
    private let periods: [(AidenBotAvatarState, TimeInterval)] = [
        (.idle, 6), (.thinking, 1.2), (.reading, 1.1), (.tool, 1.2), (.writing, 1.2), (.editing, 1), (.waiting, 2.4),
    ]

    func testLoopsRepeat() {
        for (state, period) in periods {
            // From the second loop on: writing's columns join over its first.
            for tick in 0..<40 {
                let t = period + Double(tick) * period / 40 + 0.0037
                XCTAssertEqual(AidenBotSpritePose(state: state, elapsed: t), AidenBotSpritePose(state: state, elapsed: t + 3 * period),
                               "\(state) at \(t) s")
            }
        }
    }

    func testWritingTypesAcrossTheColumnsWhileTheOutlineHolds() {
        let grid = AidenBotSprite.grid(for: .orb, small: false)
        var dipped = Set<Int>()
        for tick in 0..<120 {
            let t = Double(tick) * 0.02
            let pose = AidenBotSpritePose(state: .writing, elapsed: t)
            for (y, row) in grid.enumerated() {
                for (x, cell) in row.enumerated() where cell != .empty {
                    let opacity = pose.opacity(of: cell, x: x, y: y)
                    if cell == .outline {
                        XCTAssertEqual(opacity, 1, "the outline holds at \(t) s")
                    } else {
                        XCTAssertTrue(opacity == 0.35 || opacity == 0.92, "\(opacity) at \(t) s")
                        if opacity == 0.35 { dipped.insert(x >> 1) }
                    }
                }
            }
        }
        var filled = Set<Int>()
        for row in grid {
            for (x, cell) in row.enumerated() where cell != .empty && cell != .outline { filled.insert(x >> 1) }
        }
        XCTAssertFalse(filled.isEmpty)
        XCTAssertEqual(dipped, filled, "every pair of columns with a filled cell types")
        // A column waiting on its delay holds at .92 rather than dipping early.
        let start = AidenBotSpritePose(state: .writing, elapsed: 0.01)
        XCTAssertEqual(start.opacity(of: .body, x: 0, y: 8), 0.35)
        XCTAssertEqual(start.opacity(of: .body, x: 14, y: 8), 0.92)
        XCTAssertEqual(AidenBotSpritePose(state: .writing, elapsed: 1.06).opacity(of: .body, x: 14, y: 8), 0.35)
    }

    func testReadingScansDownTheRowsInSteps() {
        for tick in 0..<110 {
            let t = Double(tick) * 0.01 + 0.003
            let pose = AidenBotSpritePose(state: .reading, elapsed: t)
            for y in 0..<16 {
                for cell in [AidenBotSpriteCell.outline, .body, .highlight] {
                    let opacity = pose.opacity(of: cell, x: 7, y: y)
                    XCTAssertTrue(opacity == 1 || opacity == 0.42, "\(opacity) is a ramp at \(t) s")
                }
            }
        }
        // The top pair dips first, outline included; the next follows 0.11 s later.
        let first = AidenBotSpritePose(state: .reading, elapsed: 0.15)
        XCTAssertEqual(first.opacity(of: .outline, x: 0, y: 0), 0.42)
        XCTAssertEqual(first.opacity(of: .body, x: 4, y: 1), 0.42)
        XCTAssertEqual(first.opacity(of: .body, x: 4, y: 2), 1)
        XCTAssertEqual(AidenBotSpritePose(state: .reading, elapsed: 0.26).opacity(of: .body, x: 4, y: 2), 0.42)
        XCTAssertEqual(AidenBotSpritePose(state: .reading, elapsed: 0.3).opacity(of: .body, x: 4, y: 1), 1)
    }

    /// The timeline wakes only at step edges: between two wakes the pose never
    /// changes, so nothing is missed and no frame is drawn for nothing.
    func testTheScheduleWakesAtEveryStep() {
        let start = Date(timeIntervalSinceReferenceDate: 1_000)
        for state in AidenBotAvatarState.allCases {
            let schedule = AidenBotSpriteSchedule(start: start, steps: AidenBotSpriteSteps(state))
            for from in [0.0, 4.37] {
                let dates = Array(schedule.entries(from: start.addingTimeInterval(from), mode: .normal).prefix(41))
                let wakes = dates.map { $0.timeIntervalSince(start) }
                XCTAssertEqual(wakes.first ?? -1, from, accuracy: 0.0001, "\(state) draws at once")
                XCTAssertEqual(wakes, wakes.sorted(), "\(state) wakes in order")
                // A one-shot's schedule ends; after its last wake the pose holds for good.
                let finished = wakes.count < 41
                let ends: [Double?] = wakes.dropFirst().map(Optional.some) + (finished ? [nil] : [])
                for (wake, next) in zip(wakes, ends) {
                    let until = next ?? wake + 3
                    let pose = AidenBotSpritePose(state: state, elapsed: wake)
                    for step in 1..<20 {
                        let t = wake + (until - wake) * Double(step) / 20
                        XCTAssertEqual(AidenBotSpritePose(state: state, elapsed: t), pose,
                                       "\(state) changed at \(t) s between wakes at \(wake) and \(until)")
                    }
                }
            }
        }
    }
}

@MainActor
final class AidenBotSpriteRenderTests: XCTestCase {
    private struct Pixel: Hashable { let r: UInt8, g: UInt8, b: UInt8, a: UInt8 }

    private func pixels(_ state: AidenBotAvatarState, color: AidenBotAvatarColor, size: CGFloat, scale: CGFloat) throws -> [Pixel] {
        try pixels(AidenBotSpritePose(still: state), color: color, size: size, scale: scale)
    }

    private func pixels(_ pose: AidenBotSpritePose, color: AidenBotAvatarColor, size: CGFloat, scale: CGFloat) throws -> [Pixel] {
        let view = AidenBotSpriteCanvas(shape: .orb, color: color, size: size, pose: pose)
            .environment(\.colorScheme, .light)
        let renderer = ImageRenderer(content: view)
        renderer.scale = scale
        let image = try XCTUnwrap(renderer.cgImage)
        let width = image.width, height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(
            data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return stride(from: 0, to: bytes.count, by: 4).map { Pixel(r: bytes[$0], g: bytes[$0 + 1], b: bytes[$0 + 2], a: bytes[$0 + 3]) }
    }

    private func matches(_ pixel: Pixel, _ rgb: UInt32) -> Bool {
        abs(Int(pixel.r) - Int((rgb >> 16) & 0xFF)) <= 2
            && abs(Int(pixel.g) - Int((rgb >> 8) & 0xFF)) <= 2
            && abs(Int(pixel.b) - Int(rgb & 0xFF)) <= 2
    }

    /// No anti-aliasing: at any size and display scale, every pixel is fully
    /// clear or one of the Bot's tones, never a blend.
    func testEveryPixelIsATone() throws {
        let tone = AidenBotAvatarColor.rose.spriteTone
        let palette = [tone.tint, tone.shade, tone.deep, tone.light, AidenBotSprite.smallGlintRGB]
        for (size, scale) in [(CGFloat(48), CGFloat(1)), (40, 3), (64, 2), (20, 3)] {
            for pixel in try pixels(.idle, color: .rose, size: size, scale: scale) {
                XCTAssertTrue(pixel.a == 0 || pixel.a == 255, "a blended edge at \(size) pt @\(scale)x")
                if pixel.a == 255 {
                    XCTAssertTrue(palette.contains { matches(pixel, $0) }, "\(pixel) is not a tone at \(size) pt @\(scale)x")
                }
            }
        }
    }

    /// The small cut drops the highlight cells; larger sprites, the 26 pt chat
    /// header included, keep them.
    func testTheSmallCutHasNoHighlight() throws {
        let light = AidenBotAvatarColor.sky.spriteTone.light
        XCTAssertTrue(try pixels(.idle, color: .sky, size: 48, scale: 2).contains { $0.a == 255 && matches($0, light) })
        XCTAssertTrue(try pixels(.idle, color: .sky, size: 26, scale: 3).contains { $0.a == 255 && matches($0, light) })
        XCTAssertFalse(try pixels(.idle, color: .sky, size: 24, scale: 2).contains { $0.a == 255 && matches($0, light) })
    }

    /// Eyes are `deep` at every size; the small cut's open eye wears a white
    /// glint square at its top-left.
    func testTheSmallCutsOpenEyeIsDeepWithAWhiteGlint() throws {
        let tone = AidenBotAvatarColor.rose.spriteTone
        // At 24 pt @2x one view-box unit is one pixel: the left eye is 15–21 × 18–24
        // and its glint 15–18 × 18–21.
        let small = try pixels(.idle, color: .rose, size: 24, scale: 2)
        XCTAssertTrue(matches(small[21 * 48 + 18], tone.deep), "\(small[21 * 48 + 18]) is not the deep eye")
        XCTAssertTrue(matches(small[23 * 48 + 20], tone.deep))
        XCTAssertTrue(matches(small[19 * 48 + 16], AidenBotSprite.smallGlintRGB), "\(small[19 * 48 + 16]) is not the white glint")
        let full = try pixels(.idle, color: .rose, size: 48, scale: 1)
        XCTAssertTrue(matches(full[21 * 48 + 18], tone.deep), "full-size eyes are deep")
    }

    /// The blink's shut frame, done's `^` and error's `> <` have no glint.
    func testClosedSmallEyesHaveNoGlint() throws {
        let tone = AidenBotAvatarColor.rose.spriteTone
        let shut = AidenBotSpritePose(state: .idle, elapsed: 5.9)
        XCTAssertTrue(shut.eyesShut, "the idle loop's last 3% is the shut frame")
        XCTAssertFalse(AidenBotSpritePose(state: .idle, elapsed: 5.7).eyesShut, "the blink steps, with no closing frames")
        let faces = [
            ("shut", try pixels(shut, color: .rose, size: 24, scale: 3)),
            ("done", try pixels(.done, color: .rose, size: 24, scale: 2)),
            ("error", try pixels(.error, color: .rose, size: 24, scale: 2)),
        ]
        for (name, face) in faces {
            XCTAssertFalse(face.contains { $0.a == 255 && matches($0, AidenBotSprite.smallGlintRGB) }, "\(name) shows white")
            XCTAssertTrue(face.contains { $0.a == 255 && matches($0, tone.deep) }, name)
        }
    }

    /// A photo can't move, so it wears the activity mark whenever the settled
    /// state is active, even when the caller passes only the state.
    func testAPhotoAvatarMarksEveryActiveStateButNotRestOrOutcomes() {
        for state in AidenBotAvatarState.allCases {
            let marked = AidenBotCanonicalAvatarView.photoShowsActivityMark(working: false, state: state)
            XCTAssertEqual(marked, ![.idle, .done, .error].contains(state), "\(state)")
        }
        XCTAssertFalse(AidenBotCanonicalAvatarView.photoShowsActivityMark(working: false, state: nil))
        XCTAssertTrue(AidenBotCanonicalAvatarView.photoShowsActivityMark(working: true, state: nil))
    }

    /// Error's wince eyes are drawn without anti-aliasing too.
    func testStrokedEyesStayCrisp() throws {
        for pixel in try pixels(.error, color: .mint, size: 44, scale: 3) {
            XCTAssertTrue(pixel.a == 0 || pixel.a == 255)
        }
    }
}
