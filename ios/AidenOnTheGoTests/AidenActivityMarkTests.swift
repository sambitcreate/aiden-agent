import XCTest
@testable import AidenOnTheGo

/// Activity marks must draw the same pictures as desktop and Android. Expected
/// values are read off the tables in docs/activity-marks.md, not recomputed.
final class AidenActivityMarkTests: XCTestCase {
    private let tolerance = 1e-6

    private func shape(_ kind: AidenActivityMarkKind, _ index: Int) -> AidenMarkShape {
        AidenActivityMarkSpec.make(kind).shapes[index]
    }

    private func track(_ shape: AidenMarkShape, _ property: AidenMarkProperty) throws -> AidenMarkTrack {
        try XCTUnwrap(shape.tracks.first { $0.property == property && !$0.isAdditive })
    }

    func testShapeCountsMatchTheSharedSpec() {
        let expected: [AidenActivityMarkKind: Int] = [
            .triStep: 3, .quadShuffle: 4, .compose: 3, .scanGrid: 9, .glance: 2, .bounce: 3,
            .helixCalm: 10, .helixTwist: 10, .helixSwell: 10, .helixDuplex: 10, .helixFlat: 10,
        ]
        for kind in AidenActivityMarkKind.allCases {
            XCTAssertEqual(AidenActivityMarkSpec.make(kind).shapes.count, expected[kind], kind.rawValue)
        }
    }

    func testMarkNamesMatchDesktopAndAndroid() {
        XCTAssertEqual(
            AidenActivityMarkKind.allCases.map(\.rawValue),
            ["tri-step", "quad-shuffle", "compose", "scan-grid", "glance", "bounce",
             "helix-calm", "helix-twist", "helix-swell", "helix-duplex", "helix-flat"]
        )
    }

    func testTriStepHoldsAThirdTurnAfterItsFirstStep() throws {
        let rotation = try XCTUnwrap(AidenActivityMarkSpec.make(.triStep).groups.first?.tracks.first)
        XCTAssertEqual(AidenActivityMarkEvaluator.value(of: rotation, atTime: 0.3 * 2.7), 2 * .pi / 3, accuracy: tolerance)
    }

    func testQuadShuffleTopLeftReachesTheDiagonal() throws {
        let topLeft = shape(.quadShuffle, 0)
        let time = 0.18 * 2.6
        XCTAssertEqual(AidenActivityMarkEvaluator.value(of: try track(topLeft, .translateX), atTime: time), -2.2, accuracy: tolerance)
        XCTAssertEqual(AidenActivityMarkEvaluator.value(of: try track(topLeft, .translateY), atTime: time), -2.2, accuracy: tolerance)
    }

    func testFrozenPosesAreVisible() throws {
        // Compose rests on full-width lines and Scan grid on a lit first column.
        XCTAssertEqual(AidenActivityMarkEvaluator.value(of: try track(shape(.compose, 0), .scaleX), atTime: 0), 1, accuracy: tolerance)
        let firstColumn = shape(.scanGrid, 0)
        XCTAssertEqual(AidenActivityMarkEvaluator.value(of: try track(firstColumn, .opacity), atTime: 0), 1, accuracy: tolerance)
        XCTAssertEqual(AidenActivityMarkEvaluator.value(of: try track(firstColumn, .scale), atTime: 0), 1.18, accuracy: tolerance)
    }

    func testBouncePeaksAndRepeatsEachCycle() throws {
        let rise = try track(shape(.bounce, 0), .translateY)
        XCTAssertEqual(AidenActivityMarkEvaluator.value(of: rise, atTime: 0.27 * 1.2), -5, accuracy: tolerance)
        XCTAssertEqual(AidenActivityMarkEvaluator.value(of: rise, atTime: 0.27 * 1.2 + 1.2 * 3), -5, accuracy: tolerance)
    }

    func testHelixFlatIsStillAndDimmedAsAWhole() {
        let flat = AidenActivityMarkSpec.make(.helixFlat)
        XCTAssertTrue(flat.shapes.allSatisfy { $0.tracks.isEmpty })
        XCTAssertEqual(flat.opacity, 0.45, accuracy: tolerance)
    }

    func testDuplexInksStrandBPerCircleAndDrawsItFirst() {
        let duplex = AidenActivityMarkSpec.make(.helixDuplex)
        XCTAssertEqual(duplex.shapes[0].fillOpacity, 0.55, accuracy: tolerance)
        XCTAssertEqual(duplex.shapes[5].fillOpacity, 1, accuracy: tolerance)
        XCTAssertTrue(duplex.groups.allSatisfy { $0.opacity == 1 })
    }

    func testSwellAddsItsSecondWaveOnTopOfTheBraid() {
        let swell = AidenActivityMarkSpec.make(.helixSwell)
        XCTAssertTrue(swell.shapes.allSatisfy { shape in shape.tracks.contains { $0.isAdditive && $0.property == .translateY } })
    }

    func testCoreAnimationOffsetReproducesTheSpecPhase() {
        // Negative delays start part-way through; positive ones wrap around.
        XCTAssertEqual(AidenActivityMarkEvaluator.animationTimeOffset(delay: -0.45, duration: 1.5), 0.45, accuracy: tolerance)
        XCTAssertEqual(AidenActivityMarkEvaluator.animationTimeOffset(delay: 0.13, duration: 1.2), 1.07, accuracy: tolerance)
    }

    func testLiveResponseMapsEachPhaseToItsMark() {
        func mark(_ state: AidenStreamState, tool: String? = nil, text: Bool = false) -> AidenActivityMarkKind {
            AidenActivityMarkKind.liveResponse(streamState: state, runningToolName: tool, hasLiveText: text).mark
        }
        XCTAssertEqual(mark(.waitingForApproval, tool: "bash"), .glance)
        XCTAssertEqual(mark(.running, tool: "render_artifact"), .scanGrid)
        XCTAssertEqual(mark(.running, tool: "workspace_grep"), .scanGrid)
        XCTAssertEqual(mark(.running, tool: "mcp:files-read"), .scanGrid)
        XCTAssertEqual(mark(.running, tool: "thread_create"), .quadShuffle)
        XCTAssertEqual(mark(.running, tool: "bash", text: true), .quadShuffle)
        XCTAssertEqual(mark(.running, text: true), .compose)
        XCTAssertEqual(mark(.queued), .bounce)
        XCTAssertEqual(mark(.running), .triStep)
        XCTAssertEqual(
            AidenActivityMarkKind.liveResponse(streamState: nil, runningToolName: nil, hasLiveText: false).mark,
            .triStep
        )
        XCTAssertEqual(
            AidenActivityMarkKind.liveResponse(streamState: .running, runningToolName: "render_artifact", hasLiveText: false).label,
            "Visualizing"
        )
    }
}
