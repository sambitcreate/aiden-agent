import XCTest

@testable import AidenCuaS1FormsCore

/// End-to-end tests against the pinned FP16 `.mlpackage`. These run only when
/// `CUA_S1_FORMS_MODEL_PATH` points at a locally installed package — the test
/// suite never downloads model artifacts.
final class ModelIntegrationTests: XCTestCase {
    struct GoldenRow: Decodable {
        let context: String
        let options: [String]
        let label: Int
    }

    private func modelPath() throws -> String {
        guard let path = ProcessInfo.processInfo.environment["CUA_S1_FORMS_MODEL_PATH"],
            FileManager.default.fileExists(atPath: path)
        else {
            throw XCTSkip("Set CUA_S1_FORMS_MODEL_PATH to a local .mlpackage to run.")
        }
        return path
    }

    private func goldenRows() throws -> [GoldenRow] {
        // Golden rows: upstream demo.jsonl subset (dataset revision
        // 8273f34778b99ac2e12d9f6e7d57dad99ae20845).
        let url = try XCTUnwrap(Bundle.module.url(forResource: "demo-golden", withExtension: "jsonl", subdirectory: "Fixtures"))
        var rows: [GoldenRow] = []
        for line in try String(contentsOf: url).split(separator: "\n") {
            rows.append(try JSONDecoder().decode(GoldenRow.self, from: Data(line.utf8)))
        }
        return rows
    }

    func testGoldenArgmaxRows() async throws {
        let scorer = try await CuaS1FormsScorer.load(
            from: URL(fileURLWithPath: modelPath())
        )
        for (index, row) in try goldenRows().enumerated() {
            let result = try await scorer.score(context: row.context, options: row.options)
            XCTAssertEqual(
                result.selectedIndex, row.label,
                "golden row \(index) selected \(result.selectedIndex), expected \(row.label)"
            )
            XCTAssertEqual(result.selectedOption, row.options[row.label])
            XCTAssertTrue(result.probabilities.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 1 })
            XCTAssertEqual(result.probabilities.reduce(0, +), 1, accuracy: 0.0001)
        }
    }

    func testLoadRejectsMalformedArtifactPath() async throws {
        let path = try modelPath()
        _ = path  // path must exist; invalid extension is what we test next.
        let invalid = URL(fileURLWithPath: path).deletingPathExtension()
            .appendingPathExtension("txt")
        await XCTAssertAsyncThrowsError(try await CuaS1FormsScorer.load(from: invalid))
    }
}

func XCTAssertAsyncThrowsError<T>(
    _ expression: @autoclosure () async throws -> T,
    _ message: String = "",
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected error\(message.isEmpty ? "" : ": \(message)")", file: file, line: line)
    } catch {}
}
