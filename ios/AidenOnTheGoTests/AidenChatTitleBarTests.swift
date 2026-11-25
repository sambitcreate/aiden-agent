import XCTest
@testable import AidenOnTheGo

/// The Telegram-style chat title: what its status line says for Workspace and
/// Bot chats, and the typing dots' wave.
final class AidenChatTitleBarTests: XCTestCase {
    func testAnIdleWorkspaceChatNamesItsWorkspace() {
        let status = AidenChatTitleStatus.workspace(
            isStreaming: false, streamState: .done, runningToolName: nil, hasLiveText: false,
            workspaceName: "  aiden-agent "
        )
        XCTAssertEqual(status, AidenChatTitleStatus("aiden-agent"))
        XCTAssertEqual(
            AidenChatTitleStatus.workspace(
                isStreaming: false, streamState: nil, runningToolName: nil, hasLiveText: false,
                workspaceName: "aiden-agent", branch: "main"
            ),
            AidenChatTitleStatus("aiden-agent · main")
        )
    }

    func testWithSeveralMachinesTheStatusLineNamesTheMachine() {
        XCTAssertEqual(
            AidenChatTitleStatus.workspace(
                isStreaming: false, streamState: nil, runningToolName: nil, hasLiveText: false,
                workspaceName: "aiden-agent", branch: "main", machine: "Studio Mac"
            ),
            AidenChatTitleStatus("aiden-agent · Studio Mac")
        )
        XCTAssertEqual(
            AidenChatTitleStatus.bot(state: .idle, statusWord: nil, waitsForYou: false, purpose: "Finds the signal", machine: "Studio Mac"),
            AidenChatTitleStatus("Studio Mac · Finds the signal")
        )
        // A working Bot says what it is doing, not where.
        XCTAssertEqual(
            AidenChatTitleStatus.bot(state: .running, statusWord: "Reading", waitsForYou: false, purpose: nil, machine: "Studio Mac"),
            AidenChatTitleStatus("Reading", tone: .accent, isActive: true)
        )
    }

    func testAChatWithNoWorkspaceAndNothingHappeningHasNoStatusLine() {
        XCTAssertNil(AidenChatTitleStatus.workspace(
            isStreaming: false, streamState: nil, runningToolName: nil, hasLiveText: false, workspaceName: " "
        ))
    }

    func testABusyAgentSaysWhatItIsDoingWithTypingDotsAndNoSecondEllipsis() {
        func status(_ state: AidenStreamState, tool: String? = nil, text: Bool = false) -> AidenChatTitleStatus? {
            .workspace(isStreaming: true, streamState: state, runningToolName: tool, hasLiveText: text, workspaceName: "w")
        }
        XCTAssertEqual(status(.running), AidenChatTitleStatus("Thinking", tone: .accent, isActive: true))
        XCTAssertEqual(status(.running, text: true), AidenChatTitleStatus("Responding", tone: .accent, isActive: true))
        XCTAssertEqual(status(.running, tool: "grep"), AidenChatTitleStatus("Searching", tone: .accent, isActive: true))
        XCTAssertEqual(status(.queued), AidenChatTitleStatus("Preparing", tone: .accent, isActive: true))
    }

    func testAChatWaitingForApprovalWarnsWithoutDots() {
        let status = AidenChatTitleStatus.workspace(
            isStreaming: true, streamState: .waitingForApproval, runningToolName: "run_command",
            hasLiveText: false, workspaceName: "w"
        )
        XCTAssertEqual(status, AidenChatTitleStatus("Waiting for approval", tone: .warning))
    }

    func testAnIdleBotShowsWhatItIsForOrBot() {
        XCTAssertEqual(
            AidenChatTitleStatus.bot(state: .idle, statusWord: nil, waitsForYou: false, purpose: "Finds the signal"),
            AidenChatTitleStatus("Finds the signal")
        )
        XCTAssertEqual(
            AidenChatTitleStatus.bot(state: nil, statusWord: nil, waitsForYou: false, purpose: "  "),
            AidenChatTitleStatus("Bot")
        )
    }

    func testAWorkingBotSaysWhatItIsDoing() {
        XCTAssertEqual(
            AidenChatTitleStatus.bot(state: .running, statusWord: "Searching the web", waitsForYou: false, purpose: "x"),
            AidenChatTitleStatus("Searching the web", tone: .accent, isActive: true)
        )
        // The status line hides while the reply's words stream; the title says Writing.
        XCTAssertEqual(
            AidenChatTitleStatus.bot(state: .running, statusWord: nil, waitsForYou: false, purpose: "x"),
            AidenChatTitleStatus("Writing", tone: .accent, isActive: true)
        )
        // Just sent, before the Mac's state catches up.
        XCTAssertEqual(
            AidenChatTitleStatus.bot(state: .idle, statusWord: "Getting ready", waitsForYou: false, purpose: "x"),
            AidenChatTitleStatus("Getting ready", tone: .accent, isActive: true)
        )
    }

    func testABotThatCantAnswerOrWaitsOnThePersonWarns() {
        XCTAssertEqual(
            AidenChatTitleStatus.bot(state: .paused, statusWord: nil, waitsForYou: false, purpose: "x"),
            AidenChatTitleStatus("Paused", tone: .warning)
        )
        XCTAssertEqual(
            AidenChatTitleStatus.bot(state: .running, statusWord: "Thinking", waitsForYou: true, purpose: "x"),
            AidenChatTitleStatus("Waiting for you", tone: .warning)
        )
    }

    func testOnlyANewKindOfStatusAnimates() {
        let reading = AidenChatTitleStatus("Reading", tone: .accent, isActive: true)
        let searching = AidenChatTitleStatus("Searching the web", tone: .accent, isActive: true)
        XCTAssertEqual(reading.kind, searching.kind)
        XCTAssertNotEqual(reading.kind, AidenChatTitleStatus("Paused", tone: .warning).kind)
    }

    func testTheTypingDotsGrowShrinkAndRestEachCycle() {
        XCTAssertEqual(AidenTypingDots.scale(at: 0), 1, accuracy: 0.0001)
        XCTAssertEqual(AidenTypingDots.scale(at: 0.4), 1.5, accuracy: 0.0001)
        XCTAssertEqual(AidenTypingDots.scale(at: 0.6), 1.25, accuracy: 0.0001)
        XCTAssertEqual(AidenTypingDots.scale(at: 0.9), 1, accuracy: 0.0001)
        // The wave repeats every cycle.
        XCTAssertEqual(AidenTypingDots.scale(at: 3.4), 1.5, accuracy: 0.0001)
    }

    func testAWorkspaceAvatarShowsUpToTwoInitials() {
        XCTAssertEqual(AidenWorkspaceInitialsAvatar.initials(for: "aiden-agent"), "AA")
        XCTAssertEqual(AidenWorkspaceInitialsAvatar.initials(for: "Notes"), "N")
        XCTAssertEqual(AidenWorkspaceInitialsAvatar.initials(for: "my big project"), "MB")
        XCTAssertEqual(AidenWorkspaceInitialsAvatar.initials(for: "—"), "#")
    }
}
