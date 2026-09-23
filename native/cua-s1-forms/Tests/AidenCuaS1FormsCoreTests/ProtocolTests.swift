import XCTest

@testable import AidenCuaS1FormsCore

final class ProtocolTests: XCTestCase {
    func testScoreRequestValidation() throws {
        let request = CuaS1FormsRequest(
            version: cuaS1FormsProtocolVersion,
            id: "r1",
            method: .score,
            context: "TASK fill the form from the document, then submit\nFORM F\nELEMENT Edit \"Email\" value=\"\"",
            options: ["fill E-mail: a@example.com", "skip"]
        )
        XCTAssertNoThrow(try request.validated())
    }

    func testUnsupportedVersionIsRejected() {
        let request = CuaS1FormsRequest(
            version: 99,
            id: "r1",
            method: .score,
            context: "context",
            options: ["a", "b"]
        )
        XCTAssertThrowsError(try request.validated()) {
            XCTAssertEqual($0 as? CuaS1FormsError, .unsupportedProtocol(99))
        }
    }

    func testScoreBounds() {
        // Empty context.
        XCTAssertThrowsError(
            try CuaS1FormsRequest(version: 1, id: "r", method: .score, context: "", options: ["a", "b"]).validated()
        )
        // 33 options rejected, never silently dropped.
        XCTAssertThrowsError(
            try CuaS1FormsRequest(
                version: 1, id: "r", method: .score, context: "c",
                options: Array(repeating: "x", count: 33)
            ).validated()
        ) {
            XCTAssertEqual($0 as? CuaS1FormsError, .invalidOptionCount(33))
        }
        // Empty option rejected with its index.
        XCTAssertThrowsError(
            try CuaS1FormsRequest(
                version: 1, id: "r", method: .score, context: "c", options: ["a", ""]
            ).validated()
        ) {
            XCTAssertEqual($0 as? CuaS1FormsError, .emptyOption(1))
        }
        // Oversized context rejected at the transport layer.
        XCTAssertThrowsError(
            try CuaS1FormsRequest(
                version: 1, id: "r", method: .score,
                context: String(repeating: "c", count: cuaS1FormsMaximumTextBytes + 1),
                options: ["a", "b"]
            ).validated()
        )
    }

    func testLoadAndCompileRequireAbsolutePaths() {
        XCTAssertThrowsError(
            try CuaS1FormsRequest(
                version: 1, id: "r", method: .load, modelPath: "relative/model.mlpackage"
            ).validated()
        )
        XCTAssertThrowsError(
            try CuaS1FormsRequest(
                version: 1, id: "r", method: .load, modelPath: "/tmp/\0bad.mlpackage"
            ).validated()
        )
        XCTAssertThrowsError(
            try CuaS1FormsRequest(
                version: 1, id: "r", method: .compile, modelPath: "/tmp/m.mlpackage",
                destinationDirectory: nil
            ).validated()
        )
        XCTAssertNoThrow(
            try CuaS1FormsRequest(
                version: 1, id: "r", method: .compile, modelPath: "/tmp/m.mlpackage",
                destinationDirectory: "/tmp/out"
            ).validated()
        )
    }

    func testScoreBeforeLoadFailsClosed() async {
        let service = CuaS1FormsService()
        let response = await service.handle(
            CuaS1FormsRequest(
                version: 1, id: "s1", method: .score, context: "c", options: ["a", "b"]
            )
        )
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.error?.code, .modelNotLoaded)
    }

    func testShutdownIsReported() async {
        let service = CuaS1FormsService()
        let response = await service.handle(
            CuaS1FormsRequest(version: 1, id: "x", method: .shutdown)
        )
        XCTAssertTrue(response.ok)
        let state = await service.shutdownRequested
        XCTAssertTrue(state)
    }

    func testResponseRoundTrip() throws {
        let response = CuaS1FormsResponse.success(
            id: "r1",
            result: CuaS1FormsResultPayload(
                score: CuaS1FormsScoreResult(
                    selectedIndex: 1,
                    probabilities: [0.1, 0.9],
                    rawProbabilities: [0.1, 0.9],
                    logits: [0.0, 2.0],
                    contextWasTruncated: false,
                    truncatedOptionIndices: []
                )
            )
        )
        let decoded = try JSONDecoder().decode(
            CuaS1FormsResponse.self,
            from: JSONEncoder().encode(response)
        )
        XCTAssertEqual(decoded, response)
        XCTAssertEqual(decoded.result?.score?.selectedIndex, 1)
    }
}
