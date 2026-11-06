import Darwin
import SwiftUI
import XCTest
@testable import AidenOnTheGo

/// A run of tool steps reads as one quiet line. The grouping is display only:
/// the rows it works from, and the timeline behind them, are unchanged.
@MainActor
final class AidenToolStepGroupingTests: XCTestCase {

    override func setUp() {
        super.setUp()
        Self.setAccessibilityAutomation(true)
    }

    override func tearDown() {
        Self.setAccessibilityAutomation(false)
        super.tearDown()
    }

    private static func setAccessibilityAutomation(_ isEnabled: Bool) {
        typealias Setter = @convention(c) (Int32) -> Void
        guard let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
              let symbol = dlsym(library, "_AXSSetAutomationEnabled") else {
            XCTFail("_AXSSetAutomationEnabled is missing, so the accessibility tree can't be read")
            return
        }
        unsafeBitCast(symbol, to: Setter.self)(isEnabled ? 1 : 0)
    }

    // MARK: - Grouping

    func testConsecutiveToolStepsCollapseToOneGroup() throws {
        let rows = rows(text: "", steps: [
            step(1, "read_file"), step(2, "read_file"), step(3, "run_command"),
            step(4, "read_file"), step(5, "read_file"), step(6, "run_command"),
        ])

        let blocks = rows.groupedForDisplay()

        XCTAssertEqual(blocks.count, 1)
        let group = try XCTUnwrap(blocks.first?.group)
        XCTAssertEqual(group.summary, "Explored 4 files, ran 2 commands")
        XCTAssertEqual(group.stepCount, 6)
        XCTAssertFalse(group.isRunning)
        XCTAssertFalse(group.hasFailure)
    }

    func testToolRowsOnlyWhitespaceApartJoinOneGroup() throws {
        // Two offsets with a blank line between them project to two tool rows.
        let rows = rows(text: "\n", steps: [
            step(1, "read_file", offset: 0), step(2, "read_file", offset: 1),
        ])
        XCTAssertEqual(rows.filter { $0.kind == .tool }.count, 2, "The fixture should project to two tool rows")

        let blocks = rows.groupedForDisplay()

        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(blocks.first?.group?.summary, "Explored 2 files")
        XCTAssertEqual(blocks.first?.group?.steps.count, 2)
    }

    func testAssistantTextEndsAGroup() throws {
        let rows = rows(text: "Looking.Found it.", steps: [
            step(1, "read_file", offset: 0), step(2, "grep", offset: 0),
            step(3, "read_file", offset: 8), step(4, "edit_file", offset: 8), step(5, "run_command", offset: 8),
        ])

        let blocks = rows.groupedForDisplay()

        XCTAssertEqual(blocks.map(\.kindName), ["group", "text", "group", "text"])
        XCTAssertEqual(blocks[0].group?.summary, "Explored 1 file, 1 search")
        XCTAssertEqual(blocks[2].group?.summary, "Explored 1 file, edited 1 file, ran 1 command")
        XCTAssertNotEqual(blocks[0].id, blocks[2].id)
    }

    func testALoneStepStaysAnOrdinaryRow() {
        let blocks = rows(text: "Before.After.", steps: [step(1, "read_file", offset: 7)]).groupedForDisplay()

        XCTAssertEqual(blocks.map(\.kindName), ["text", "row", "text"])
    }

    func testAnApprovalIsNeverFoldedIntoAGroup() throws {
        let rows = rows(text: "", steps: [
            step(1, "read_file"), step(2, "read_file"),
            step(3, "run_command", status: .awaitingApproval, detail: "rm -rf build"),
        ], running: true)

        let blocks = rows.groupedForDisplay()

        XCTAssertEqual(blocks.map(\.kindName), ["group", "row"])
        XCTAssertEqual(blocks[0].group?.steps.flatMap(\.steps).map(\.id), ["tool-1", "tool-2"])
        XCTAssertEqual(blocks[1].row?.steps.map(\.id), ["tool-3"])
        XCTAssertEqual(blocks[1].row?.steps.first?.status, .awaitingApproval)
    }

    func testAnApprovalInTheMiddleSplitsTheRunAndKeepsEachSideGrouped() throws {
        let rows = rows(text: "", steps: [
            step(1, "read_file"), step(2, "read_file"),
            step(3, "run_command", status: .awaitingApproval),
            step(4, "grep"), step(5, "grep"),
        ], running: true)

        let blocks = rows.groupedForDisplay()

        XCTAssertEqual(blocks.map(\.kindName), ["group", "row", "group"])
        XCTAssertEqual(Set(blocks.map(\.id)).count, 3, "Block identities stay unique for ForEach")
    }

    func testRowsThatAreNotToolStepsStayOutOfGroups() throws {
        let questionnaire = AidenChronologicalRow(id: "questionnaire-q", kind: .questionnaire, text: "", steps: [step(9, "ask_user_question")])
        let reasoning = AidenChronologicalRow(id: "reasoning-t", kind: .reasoning, text: "Hm.", steps: [])
        let toolRows = rows(text: "", steps: [step(1, "read_file"), step(2, "read_file")])
        let more = rows(text: "", steps: [step(3, "grep"), step(4, "grep")])
            .map { AidenChronologicalRow(id: "again-\($0.id)", kind: $0.kind, text: $0.text, steps: $0.steps) }

        let blocks = (toolRows + [questionnaire, reasoning] + more).groupedForDisplay()

        XCTAssertEqual(blocks.map(\.kindName), ["group", "row", "row", "group"])
    }

    func testAFailureGroupsAndABlockedStepDoesNot() throws {
        let failed = rows(text: "", steps: [step(1, "read_file"), step(2, "run_command", status: .failed)]).groupedForDisplay()
        let denied = rows(text: "", steps: [step(1, "read_file"), step(2, "run_command", status: .blocked)]).groupedForDisplay()

        XCTAssertEqual(failed.first?.group?.hasFailure, true)
        XCTAssertEqual(denied.first?.group?.hasFailure, false, "A denied command is the person's own call, not a failure")
        XCTAssertEqual(denied.first?.group?.summary, "Explored 1 file, skipped 1 command")
    }

    // MARK: - Identity

    func testAGroupKeepsItsIdentityWhenAStepIsAdded() throws {
        let before = rows(text: "", steps: [step(1, "read_file"), step(2, "read_file")], running: true).groupedForDisplay(scope: "run-a")
        let after = rows(text: "", steps: [
            step(1, "read_file"), step(2, "read_file"), step(3, "run_command", status: .running),
        ], running: true).groupedForDisplay(scope: "run-a")

        let group = try XCTUnwrap(after.first?.group)
        XCTAssertEqual(before.first?.id, after.first?.id)
        XCTAssertEqual(group.stepCount, 3)
        XCTAssertTrue(group.isRunning)
    }

    func testALoneStepKeepsItsRowIdentity() throws {
        let rows = rows(text: "", steps: [step(1, "read_file", status: .running)], running: true)

        XCTAssertEqual(rows.groupedForDisplay(scope: "run-a").first?.id, rows.first?.id)
    }

    func testTwoRunsNeverShareAGroupIdentity() {
        // The Mac numbers steps from tool-1 in every run, so the first step's ID alone repeats.
        let steps = [step(1, "read_file"), step(2, "read_file")]
        let first = rows(text: "", steps: steps).groupedForDisplay(scope: "stream-1")
        let second = rows(text: "", steps: steps).groupedForDisplay(scope: "stream-2")

        XCTAssertNotEqual(first.first?.id, second.first?.id)
    }

    func testAGroupKeepsItsIdentityWhenTheRunSettles() {
        // The live view and the settled message group the same timeline under its generation ID.
        let live = rows(text: "", steps: [step(1, "read_file", status: .running), step(2, "grep", status: .running)], running: true)
            .groupedForDisplay(scope: "stream-1")
        let settled = rows(text: "Done.", steps: [step(1, "read_file"), step(2, "grep")])
            .groupedForDisplay(scope: "stream-1")

        XCTAssertEqual(live.first?.id, settled.first?.id)
    }

    func testATokenInTheTextBelowChangesNoBlockAbove() throws {
        func blocks(_ text: String) -> [AidenChronologicalBlock] {
            rows(text: text, steps: [
                step(1, "read_file", offset: 0), step(2, "read_file", offset: 0),
                step(3, "grep", offset: 9), step(4, "grep", offset: 9),
            ], running: true).groupedForDisplay(scope: "s")
        }
        let early = blocks("Reading.\n\nMore")
        let later = blocks("Reading.\n\nMore of it, and a good deal more besides")

        XCTAssertEqual(early.count, later.count)
        XCTAssertEqual(early.last?.kindName, "text")
        for index in 0..<(early.count - 1) {
            XCTAssertEqual(early[index], later[index], "Block \(index) changed when a token landed below it")
            XCTAssertEqual(early[index].id, later[index].id)
        }
        XCTAssertNotEqual(early.last, later.last)
    }

    // MARK: - Expansion

    func testExpansionSurvivesAStreamingAppend() throws {
        let expansion = AidenToolStepGroupExpansion()
        let before = try XCTUnwrap(rows(text: "", steps: [step(1, "read_file"), step(2, "read_file")], running: true)
            .groupedForDisplay(scope: "s").first?.group)
        XCTAssertFalse(expansion.isExpanded(before))

        expansion.setExpanded(true, for: before.id)
        let after = try XCTUnwrap(rows(text: "", steps: [
            step(1, "read_file"), step(2, "read_file"), step(3, "grep", status: .running),
        ], running: true).groupedForDisplay(scope: "s").first?.group)

        XCTAssertEqual(before.id, after.id)
        XCTAssertTrue(expansion.isExpanded(after), "The group the person opened closed when a step arrived")
    }

    func testAFailedGroupStartsExpanded() throws {
        let expansion = AidenToolStepGroupExpansion()
        let group = try XCTUnwrap(rows(text: "", steps: [step(1, "read_file"), step(2, "run_command", status: .failed)])
            .groupedForDisplay(scope: "s").first?.group)

        XCTAssertTrue(expansion.isExpanded(group))
    }

    func testAFailedGroupTheReaderClosedStaysClosedThroughLaterUpdates() throws {
        let expansion = AidenToolStepGroupExpansion()
        func group(_ steps: [AidenAgentStep]) throws -> AidenToolStepGroup {
            try XCTUnwrap(rows(text: "", steps: steps, running: true).groupedForDisplay(scope: "s").first?.group)
        }
        let failed = try group([step(1, "read_file"), step(2, "run_command", status: .failed)])
        XCTAssertTrue(expansion.isExpanded(failed))

        expansion.setExpanded(false, for: failed.id)
        let later = try group([
            step(1, "read_file"), step(2, "run_command", status: .failed), step(3, "run_command", status: .failed),
            step(4, "grep", status: .running),
        ])

        XCTAssertTrue(later.hasFailure)
        XCTAssertFalse(expansion.isExpanded(failed))
        XCTAssertFalse(expansion.isExpanded(later), "A group the reader collapsed re-expanded on the next update")
    }

    func testAGroupThatFailsLaterOpensUnlessTheReaderChoseOtherwise() throws {
        let expansion = AidenToolStepGroupExpansion()
        func group(_ steps: [AidenAgentStep]) throws -> AidenToolStepGroup {
            try XCTUnwrap(rows(text: "", steps: steps, running: true).groupedForDisplay(scope: "s").first?.group)
        }
        let healthy = try group([step(1, "read_file"), step(2, "read_file")])
        let failing = try group([step(1, "read_file"), step(2, "read_file"), step(3, "run_command", status: .failed)])
        XCTAssertFalse(expansion.isExpanded(healthy))
        XCTAssertTrue(expansion.isExpanded(failing), "A failure nobody has looked at should be visible")

        expansion.setExpanded(true, for: healthy.id)
        XCTAssertTrue(expansion.isExpanded(failing))
    }

    func testAGroupTheReaderOpenedStaysOpenWhenAFailureLandsInIt() throws {
        let expansion = AidenToolStepGroupExpansion()
        let healthy = try XCTUnwrap(rows(text: "", steps: [step(1, "read_file"), step(2, "read_file")], running: true)
            .groupedForDisplay(scope: "s").first?.group)
        expansion.setExpanded(true, for: healthy.id)
        let failing = try XCTUnwrap(rows(text: "", steps: [
            step(1, "read_file"), step(2, "read_file"), step(3, "run_command", status: .failed),
        ], running: true).groupedForDisplay(scope: "s").first?.group)

        XCTAssertTrue(expansion.isExpanded(failing))
    }

    func testOpeningOneGroupLeavesTheOthersAlone() throws {
        let expansion = AidenToolStepGroupExpansion()
        let blocks = rows(text: "A.B.", steps: [
            step(1, "read_file", offset: 0), step(2, "read_file", offset: 0),
            step(3, "grep", offset: 2), step(4, "grep", offset: 2),
        ]).groupedForDisplay(scope: "s")
        let groups = blocks.compactMap(\.group)
        XCTAssertEqual(groups.count, 2)

        expansion.setExpanded(true, for: groups[0].id)

        XCTAssertTrue(expansion.isExpanded(groups[0]))
        XCTAssertFalse(expansion.isExpanded(groups[1]))
    }

    func testATapTellsTheScreenFirstAndThenFlipsTheGroup() throws {
        var events: [String] = []
        var expansion: AidenToolStepGroupExpansion!
        let healthy = try XCTUnwrap(rows(text: "", steps: [step(1, "read_file"), step(2, "read_file")])
            .groupedForDisplay(scope: "s").first?.group)
        expansion = AidenToolStepGroupExpansion(onToggle: { events.append("told, open: \(expansion.isExpanded(healthy))") })

        expansion.toggle(healthy)
        expansion.toggle(healthy)

        XCTAssertEqual(events, ["told, open: false", "told, open: true"], "The screen must hear of a tap before the group changes")
        XCTAssertFalse(expansion.isExpanded(healthy))
    }

    func testATapClosesAFailedGroupThatStartedOpen() throws {
        let expansion = AidenToolStepGroupExpansion()
        let failed = try XCTUnwrap(rows(text: "", steps: [step(1, "read_file"), step(2, "run_command", status: .failed)])
            .groupedForDisplay(scope: "s").first?.group)

        expansion.toggle(failed)

        XCTAssertFalse(expansion.isExpanded(failed))
    }

    func testARunningGroupShowsItsLatestStepAndStaysCollapsed() throws {
        let expansion = AidenToolStepGroupExpansion()
        let group = try XCTUnwrap(rows(text: "", steps: [
            step(1, "read_file", detail: "a.swift"), step(2, "read_file", detail: "b.swift"),
            step(3, "run_command", status: .running, detail: "swift test"),
        ], running: true).groupedForDisplay(scope: "s").first?.group)

        XCTAssertTrue(group.isRunning)
        XCTAssertFalse(expansion.isExpanded(group))
        XCTAssertEqual(group.summary, "Exploring 2 files, running 1 command")
        XCTAssertEqual(group.latestStep?.id, "tool-3")
        XCTAssertEqual(group.runningLine, "Running swift test")
    }

    func testASettledGroupHasNoRunningLine() throws {
        let group = try XCTUnwrap(rows(text: "", steps: [step(1, "read_file"), step(2, "grep")])
            .groupedForDisplay(scope: "s").first?.group)

        XCTAssertNil(group.runningLine)
    }

    func testTheGroupsLabelStatesTheSummaryAndWhetherItIsOpen() throws {
        let group = try XCTUnwrap(rows(text: "", steps: [
            step(1, "read_file"), step(2, "read_file"), step(3, "run_command", status: .failed),
        ]).groupedForDisplay(scope: "s").first?.group)

        XCTAssertEqual(group.accessibilityLabel(isExpanded: false), "Explored 2 files, ran 1 command, 1 failed, collapsed")
        XCTAssertEqual(group.accessibilityLabel(isExpanded: true), "Explored 2 files, ran 1 command, 1 failed, expanded")
    }

    // MARK: - Cost

    func testGroupingAVeryLongRunIsLinear() {
        // 20,000 tool steps in runs of ten, split by text rows: 2,000 groups and 2,000 text rows.
        var rows: [AidenChronologicalRow] = []
        for run in 0..<2_000 {
            let steps = (0..<10).map { step(run * 10 + $0, "read_file", offset: run) }
            rows.append(AidenChronologicalRow(id: "tool-\(steps[0].id)", kind: .tool, text: "", steps: steps))
            rows.append(AidenChronologicalRow(id: "text-\(run)", kind: .text, text: "x", steps: []))
        }

        let start = ContinuousClock.now
        let blocks = rows.groupedForDisplay(scope: "s")
        let elapsed = ContinuousClock.now - start

        XCTAssertEqual(blocks.count, 4_000)
        XCTAssertEqual(blocks.compactMap(\.group).count, 2_000)
        XCTAssertLessThan(elapsed, .seconds(1), "Grouping 20,000 steps took \(elapsed)")
    }

    // MARK: - On screen

    func testACollapsedGroupIsOneButtonAtLeast44ptTall() throws {
        let window = try show(groupHost())
        defer { close(window) }

        let elements = accessibleElements(in: window)
        let group = try XCTUnwrap(elements.first { $0.accessibilityLabel?.hasPrefix("Explored 4 files") == true })
        XCTAssertEqual(group.accessibilityLabel, "Explored 4 files, ran 2 commands, collapsed")
        XCTAssertTrue(group.accessibilityTraits.contains(.button))
        XCTAssertGreaterThanOrEqual(group.accessibilityFrame.height, 44)
        XCTAssertFalse(
            elements.contains { $0.accessibilityLabel?.contains("a0.swift") == true },
            "A collapsed group still lists its steps"
        )
    }

    func testAGroupTheReaderOpenedShowsItsStepsAndSaysSo() throws {
        let expansion = AidenToolStepGroupExpansion()
        expansion.setExpanded(true, for: "stream-1/tool-tool-1")
        let window = try show(groupHost(expansion: expansion))
        defer { close(window) }

        let elements = accessibleElements(in: window)
        let group = try XCTUnwrap(elements.first { $0.accessibilityLabel?.hasPrefix("Explored 4 files") == true })
        XCTAssertEqual(group.accessibilityLabel, "Explored 4 files, ran 2 commands, expanded")
        XCTAssertTrue(group.accessibilityTraits.contains(.button))
        XCTAssertTrue(elements.contains { $0.accessibilityLabel?.contains("a0.swift") == true }, "The steps did not appear")
        XCTAssertEqual(Set(elements.compactMap(\.accessibilityLabel).filter { $0.hasPrefix("Read ") }).count, 4)
    }

    func testAnOpenedGroupStaysOpenAfterTheViewIsRebuilt() throws {
        // A lazy stack rebuilds a row that scrolled away, and the live reply is
        // rebuilt as the settled one. Both read the state held above them.
        let expansion = AidenToolStepGroupExpansion()
        expansion.setExpanded(true, for: "stream-1/tool-tool-1")
        let first = try show(groupHost(expansion: expansion))
        close(first)

        let second = try show(groupHost(expansion: expansion))
        defer { close(second) }

        XCTAssertTrue(accessibleElements(in: second).contains { $0.accessibilityLabel == "Explored 4 files, ran 2 commands, expanded" })
    }

    func testTheGroupHoldsAtTheLargestTextSize() throws {
        let window = try show(groupHost(textSize: .accessibility5))
        defer { close(window) }

        let group = try XCTUnwrap(accessibleElements(in: window).first { $0.accessibilityLabel?.hasPrefix("Explored 4 files") == true })
        let frame = group.accessibilityFrame
        XCTAssertGreaterThanOrEqual(frame.height, 44)
        XCTAssertLessThanOrEqual(frame.width, 390 + 0.5, "The group outgrew the screen")
        XCTAssertTrue(group.accessibilityTraits.contains(.button))
    }

    // MARK: - Fixtures

    private func step(
        _ number: Int,
        _ tool: String,
        status: AidenAgentStepStatus = .completed,
        offset: Int = 0,
        detail: String? = nil
    ) -> AidenAgentStep {
        AidenAgentStep(
            id: "tool-\(number)",
            order: number - 1,
            kind: .tool,
            toolCallId: "call-\(number)",
            toolName: tool,
            label: tool,
            status: status,
            startedAt: 1_000 + Double(number),
            updatedAt: 1_000 + Double(number),
            finishedAt: status.isActive ? nil : 1_000 + Double(number),
            contentOffset: offset,
            durationMs: nil,
            target: nil,
            detail: detail,
            lineChanges: nil
        )
    }

    /// Rows as the projection builds them, so the fixtures stay honest about row identity.
    private func rows(text: String, steps: [AidenAgentStep], running: Bool = false) -> [AidenChronologicalRow] {
        // Step numbers in a hand-built list can start anywhere, but the timeline needs order == index.
        let ordered = steps.enumerated().map { index, step in
            AidenAgentStep(
                id: step.id, order: index, kind: step.kind, toolCallId: step.toolCallId, toolName: step.toolName,
                label: step.label, status: step.status, startedAt: step.startedAt, updatedAt: step.updatedAt,
                finishedAt: step.finishedAt, contentOffset: step.contentOffset, durationMs: step.durationMs,
                target: step.target, detail: step.detail, lineChanges: step.lineChanges
            )
        }
        let timeline = AidenGenerationTimeline(
            version: 3,
            generationId: "stream-1",
            status: running ? .running : .completed,
            startedAt: 1_000,
            finishedAt: running ? nil : 2_000,
            steps: ordered
        )
        return AidenChronologicalProjection.rows(text: text, reasoning: "", timeline: timeline) ?? []
    }

    private func groupHost(
        expansion: AidenToolStepGroupExpansion? = nil,
        textSize: DynamicTypeSize = .large
    ) -> some View {
        let steps = (0..<4).map { step($0 + 1, "read_file", detail: "a\($0).swift") }
            + (4..<6).map { step($0 + 1, "run_command", detail: "swift test \($0)") }
        return ScrollView {
            AidenChronologicalTranscript(rows: rows(text: "", steps: steps), active: false, groupScope: "stream-1")
                .padding(.horizontal, 16)
        }
        .environment(\.aidenToolGroupExpansion, expansion)
        .dynamicTypeSize(textSize)
    }

    private func show(_ view: some View) throws -> UIWindow {
        func connectedScene() -> UIWindowScene? {
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        }
        _ = runMainLoop(until: { connectedScene() != nil }, timeout: 10)
        let scene = try XCTUnwrap(connectedScene())
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        window.rootViewController = UIHostingController(rootView: view.environment(AidenHapticCenter()))
        window.makeKeyAndVisible()
        drainMainLoop()
        return window
    }

    private func close(_ window: UIWindow) {
        window.isHidden = true
        window.rootViewController = nil
    }

    private func accessibleElements(in root: NSObject) -> [NSObject] {
        var found: [NSObject] = []
        func walk(_ object: NSObject) {
            if object.isAccessibilityElement {
                found.append(object)
                return
            }
            if let elements = object.accessibilityElements {
                elements.compactMap { $0 as? NSObject }.forEach(walk)
            }
            (object as? UIView)?.subviews.forEach(walk)
        }
        walk(root)
        return found
    }

    private func runMainLoop(until condition: () -> Bool, timeout: TimeInterval = 3) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }

    private func drainMainLoop() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    }
}

private extension AidenChronologicalBlock {
    var kindName: String {
        switch self {
        case .toolGroup: "group"
        case .row(let row): row.kind == .text ? "text" : "row"
        }
    }

    var group: AidenToolStepGroup? {
        if case .toolGroup(let group) = self { return group }
        return nil
    }

    var row: AidenChronologicalRow? {
        if case .row(let row) = self { return row }
        return nil
    }
}
