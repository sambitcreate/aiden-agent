import ActivityKit
import Foundation
import XCTest
@testable import AidenOnTheGo

/// Phase 6 Live Activity state-machine coverage: the exact identity, stale, and
/// revoked transitions that drive the widget are exercised here as pure state
/// semantics so they do not depend on a physical ActivityKit device or the
/// opt-in process-boundary proof in `AidenNativeIntegrationTests`.
@MainActor
final class AidenBotLiveActivityStateTests: XCTestCase {
    private func baseState(
        sessionID: String = "chat-1",
        title: String = "Chat",
        startedAt: Date = Date(timeIntervalSince1970: 1_000)
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityStateReducer.initialState(
            sessionID: sessionID,
            sessionTitle: title,
            startedAt: startedAt
        )
    }

    func testLiveActivityExactIdentityReuseRequiresSameSessionAndStream() {
        // Stream IDs are normalized (trimmed, empty becomes nil) before compare,
        // so a whitespace-padded reuse attempt still resolves to the exact activity.
        XCTAssertEqual(
            AgentLiveActivityReusePolicy.normalizedStreamID("  stream-1  "),
            "stream-1"
        )
        XCTAssertNil(AgentLiveActivityReusePolicy.normalizedStreamID("   "))
        XCTAssertNil(AgentLiveActivityReusePolicy.normalizedStreamID(nil))

        XCTAssertTrue(AgentLiveActivityReusePolicy.canReuseActivity(
            existingSessionID: "chat-1",
            existingStreamID: "stream-1",
            requestedSessionID: "chat-1",
            requestedStreamID: "stream-1"
        ))
        XCTAssertTrue(AgentLiveActivityReusePolicy.canReuseActivity(
            existingSessionID: "chat-1",
            existingStreamID: " stream-1 ",
            requestedSessionID: "chat-1",
            requestedStreamID: "stream-1"
        ))
        XCTAssertTrue(AgentLiveActivityReusePolicy.canReuseActivity(
            existingSessionID: "chat-1",
            existingStreamID: nil,
            requestedSessionID: "chat-1",
            requestedStreamID: nil
        ))
        XCTAssertFalse(AgentLiveActivityReusePolicy.canReuseActivity(
            existingSessionID: "chat-1",
            existingStreamID: "stream-1",
            requestedSessionID: "chat-2",
            requestedStreamID: "stream-1"
        ))
        XCTAssertFalse(AgentLiveActivityReusePolicy.canReuseActivity(
            existingSessionID: "chat-1",
            existingStreamID: "stream-1",
            requestedSessionID: "chat-1",
            requestedStreamID: "stream-2"
        ))
        XCTAssertFalse(AgentLiveActivityReusePolicy.canReuseActivity(
            existingSessionID: "chat-1",
            existingStreamID: nil,
            requestedSessionID: "chat-1",
            requestedStreamID: "stream-1"
        ))
    }

    func testLiveActivityInitialStateIsBoundedAndNeverFinalOrStale() {
        let longTitle = String(repeating: "Title ", count: 30)
        let state = baseState(title: longTitle)

        XCTAssertEqual(state.status, .starting)
        XCTAssertEqual(state.responseExcerpt, "")
        XCTAssertLessThanOrEqual(state.sessionTitle.count, AgentRunActivitySanitizer.maximumSessionTitleCharacters)
        XCTAssertFalse(state.isStale)
        XCTAssertFalse(state.isFinal)
        XCTAssertNil(state.errorSummary)
        XCTAssertEqual(state.sessionID, "chat-1")
        XCTAssertFalse(state.currentActivity.isEmpty)
    }

    func testLiveActivityTokenAppendStaysBoundedAndFlipsToResponding() {
        let initial = baseState()
        let longToken = String(repeating: "private response ", count: 30)
        let updated = AgentRunActivityStateReducer.appendingToken(longToken, to: initial)

        XCTAssertEqual(updated.status, .responding)
        XCTAssertLessThanOrEqual(updated.responseExcerpt.count, AgentRunActivitySanitizer.maximumExcerptCharacters)
        XCTAssertFalse(updated.isStale)
        XCTAssertFalse(updated.isFinal)

        let singleLine = AgentRunActivityStateReducer.appendingToken("line one\n\nline two", to: initial)
        XCTAssertFalse(singleLine.responseExcerpt.contains("\n"))

        // Appending empty text must not mutate the state.
        let unchanged = AgentRunActivityStateReducer.appendingToken("", to: initial)
        XCTAssertEqual(unchanged.responseExcerpt, initial.responseExcerpt)
        XCTAssertEqual(unchanged.status, initial.status)
    }

    func testLiveActivityStalePreservesStatusWhileExcerptClearingStaysNonTerminal() {
        var state = baseState()
        state = AgentRunActivityStateReducer.appendingToken("visible but private", to: state)

        let stale = AgentRunActivityStateReducer.stale(state: state)
        XCTAssertTrue(stale.isStale)
        XCTAssertEqual(stale.status, .responding)
        XCTAssertFalse(stale.isFinal)
        XCTAssertEqual(stale.responseExcerpt, state.responseExcerpt)
        XCTAssertFalse(stale.currentActivity.isEmpty)

        let cleared = AgentRunActivityStateReducer.clearingResponseExcerpt(state: stale)
        XCTAssertEqual(cleared.responseExcerpt, "")
        XCTAssertTrue(cleared.isStale)
        XCTAssertEqual(cleared.status, stale.status)
        XCTAssertFalse(cleared.isFinal)
    }

    func testLiveActivityRevokedFinalStateIsBoundedTerminalAndNeverStale() {
        var state = baseState(title: "Revocation probe")
        state = AgentRunActivityStateReducer.appendingToken(
            String(repeating: "pending ", count: 40),
            to: state
        )
        let revoked = AgentRunActivityStateReducer.final(
            status: .failed,
            activity: "Connection revoked",
            state: state
        )

        XCTAssertTrue(revoked.isFinal)
        XCTAssertFalse(revoked.isStale)
        XCTAssertEqual(revoked.status, .failed)
        XCTAssertLessThanOrEqual(revoked.responseExcerpt.count, AgentRunActivitySanitizer.maximumExcerptCharacters)
        XCTAssertFalse(revoked.currentActivity.isEmpty)
        XCTAssertLessThanOrEqual(revoked.currentActivity.count, AgentRunActivitySanitizer.maximumActivityCharacters)

        let complete = AgentRunActivityStateReducer.final(
            status: .complete,
            activity: "Response complete",
            state: baseState()
        )
        XCTAssertTrue(complete.isFinal)
        XCTAssertEqual(complete.status, .complete)
        XCTAssertFalse(complete.isStale)
    }

    func testLiveActivityToolApprovalAndReasoningTransitionsMapToBoundedStatuses() {
        let initial = baseState()

        XCTAssertEqual(
            AgentRunActivityStateReducer.toolStarted(name: "xcodebuild", state: initial).status,
            .runningCommand
        )
        XCTAssertEqual(
            AgentRunActivityStateReducer.toolStarted(name: "rg search", state: initial).status,
            .searchingFiles
        )
        XCTAssertEqual(
            AgentRunActivityStateReducer.toolStarted(name: "read_file", state: initial).status,
            .readingFiles
        )
        XCTAssertEqual(
            AgentRunActivityStateReducer.toolStarted(name: "random_tool", state: initial).status,
            .usingTool
        )
        XCTAssertEqual(
            AgentRunActivityStateReducer.waitingForApproval(state: initial).status,
            .waitingForApproval
        )
        XCTAssertEqual(
            AgentRunActivityStateReducer.reasoning("", state: initial).status,
            .thinking
        )
        XCTAssertEqual(
            AgentRunActivityStateReducer.toolCompleted(state: initial).status,
            .responding
        )
        XCTAssertEqual(
            AgentRunActivityStateReducer.responding(state: initial).status,
            .responding
        )
        XCTAssertEqual(
            AgentRunActivityStateReducer.updatingSessionTitle("New title", state: initial).sessionTitle,
            "New title"
        )
        XCTAssertEqual(
            AgentRunActivityStateReducer.settingInterimAssistant("short", on: initial).responseExcerpt,
            "short"
        )
    }

    func testLiveActivitySanitizerBoundsEverySurfaceString() {
        XCTAssertLessThanOrEqual(
            AgentRunActivitySanitizer.sessionTitle(String(repeating: "T", count: 200)).count,
            AgentRunActivitySanitizer.maximumSessionTitleCharacters
        )
        XCTAssertLessThanOrEqual(
            AgentRunActivitySanitizer.activityLine(String(repeating: "activity ", count: 30)).count,
            AgentRunActivitySanitizer.maximumActivityCharacters
        )
        XCTAssertLessThanOrEqual(
            AgentRunActivitySanitizer.responseExcerpt(String(repeating: "excerpt ", count: 60)).count,
            AgentRunActivitySanitizer.maximumExcerptCharacters
        )
        XCTAssertLessThanOrEqual(
            AgentRunActivitySanitizer.toolLabel("very_long_tool_name_that_is_really_long_here").count,
            AgentRunActivitySanitizer.maximumToolLabelCharacters
        )

        // Multi-line and whitespace-normalized inputs collapse to one line.
        let singleLine = AgentRunActivitySanitizer.sessionTitle("first   line\n\tsecond")
        XCTAssertFalse(singleLine.contains("\n"))
        XCTAssertFalse(singleLine.contains("\t"))
        XCTAssertEqual(singleLine, "first line second")

        // Tool labels drop path prefixes and underscore/hyphen separators.
        XCTAssertEqual(
            AgentRunActivitySanitizer.toolLabel("private/path/to/read_file"),
            "read file"
        )
        XCTAssertEqual(
            AgentRunActivitySanitizer.toolLabel(""),
            "tool"
        )

        // Tool classification follows the bounded shell/search/files vocabulary.
        XCTAssertEqual(AgentRunActivitySanitizer.toolKind(name: "xcodebuild"), .command)
        XCTAssertEqual(AgentRunActivitySanitizer.toolKind(name: "ripgrep"), .search)
        XCTAssertEqual(AgentRunActivitySanitizer.toolKind(name: "read_file"), .files)
        if case .generic(let label) = AgentRunActivitySanitizer.toolKind(name: "custom_tool") {
            XCTAssertEqual(label, "custom tool")
        } else {
            XCTFail("Expected a generic tool kind for an unrecognized tool name.")
        }
    }

    func testLiveActivityElapsedTimeFormatterUsesProductBoundaries() {
        let start = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(
            AgentRunElapsedTimeFormatter.label(startedAt: start, updatedAt: Date(timeIntervalSince1970: 65)),
            "01:05"
        )
        XCTAssertEqual(
            AgentRunElapsedTimeFormatter.label(startedAt: start, updatedAt: Date(timeIntervalSince1970: 3_661)),
            "1:01:01"
        )
        XCTAssertEqual(
            AgentRunElapsedTimeFormatter.label(
                startedAt: Date(timeIntervalSince1970: 1_000),
                updatedAt: Date(timeIntervalSince1970: 900)
            ),
            "00:00",
            "A clock regression must not produce a negative elapsed label."
        )
    }
}
