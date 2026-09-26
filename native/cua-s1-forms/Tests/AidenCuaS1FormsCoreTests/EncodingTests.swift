import XCTest

@testable import AidenCuaS1FormsCore

// Ported from FluidAudio's MIT-licensed CuaS1FormsTests.swift
// (pinned revision 87a39dfe4068fef0f1c69bfe704b2b3ef4fbc5bc).
final class EncodingTests: XCTestCase {
    func testByteEncodingAndPadding() throws {
        let input = try CuaS1FormsInput(context: "é\0", options: ["skip", "check"])
        XCTAssertEqual(Array(input.contextIDs.prefix(3)), [196, 170, 1])
        XCTAssertTrue(input.contextIDs.dropFirst(3).allSatisfy { $0 == 0 })
        XCTAssertEqual(Array(input.optionIDs.prefix(4)), [116, 108, 106, 113])
        XCTAssertTrue(input.optionIDs[4..<96].allSatisfy { $0 == 0 })
        XCTAssertEqual(Array(input.optionIDs[96..<101]), [100, 105, 102, 100, 108])
        XCTAssertTrue(input.optionIDs.dropFirst(101).allSatisfy { $0 == 0 })
        XCTAssertEqual(input.optionMask, [1, 1] + Array(repeating: 0, count: 30))
        XCTAssertFalse(input.contextWasTruncated)
        XCTAssertEqual(input.truncatedOptionIndices, [])
    }

    func testUTF8TruncationCanSplitACharacter() throws {
        let input = try CuaS1FormsInput(
            context: String(repeating: "a", count: 223) + "🙂",
            options: [String(repeating: "b", count: 95) + "🙂", "skip"]
        )
        XCTAssertEqual(input.contextIDs.count, 224)
        XCTAssertEqual(input.contextIDs.last, 241)  // First byte of the emoji, plus one.
        XCTAssertEqual(input.optionIDs[95], 241)
        XCTAssertTrue(input.contextWasTruncated)
        XCTAssertEqual(input.truncatedOptionIndices, [0])
    }

    func testExactLimitsAndFullOptionCapacity() throws {
        let input = try CuaS1FormsInput(
            context: String(repeating: "a", count: 224),
            options: Array(repeating: String(repeating: "b", count: 96), count: 32)
        )
        XCTAssertFalse(input.contextWasTruncated)
        XCTAssertEqual(input.truncatedOptionIndices, [])
        XCTAssertTrue(input.optionIDs.allSatisfy { $0 == 99 })
        XCTAssertTrue(input.optionMask.allSatisfy { $0 == 1 })
    }

    func testInvalidInputsAreRejected() {
        XCTAssertThrowsError(try CuaS1FormsInput(context: "", options: ["check", "skip"])) {
            XCTAssertEqual($0 as? CuaS1FormsError, .emptyContext)
        }
        for count in [0, 1, 33] {
            XCTAssertThrowsError(
                try CuaS1FormsInput(
                    context: "context",
                    options: Array(repeating: "skip", count: count)
                )
            ) {
                XCTAssertEqual($0 as? CuaS1FormsError, .invalidOptionCount(count))
            }
        }
        XCTAssertThrowsError(try CuaS1FormsInput(context: "context", options: ["skip", ""])) {
            XCTAssertEqual($0 as? CuaS1FormsError, .emptyOption(1))
        }
    }
}
