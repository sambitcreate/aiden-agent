import Foundation
import XCTest
@testable import AidenOnTheGo

/// Revision 46: the spending notice's words and its Allow more, against a
/// transport that behaves like the Mac's ledger.
@MainActor
final class AidenSpendingTests: XCTestCase {
    private func spending(
        _ state: AidenSpending.State,
        period: AidenSpending.Period = .chat,
        spent: Double = 4.1,
        allowed: Double = 5,
        revision: String = "sp_1"
    ) -> AidenSpending {
        AidenSpending(
            period: period,
            state: state,
            limitUsd: 5,
            allowedUsd: allowed,
            spentUsd: spent,
            allowMoreUsd: 5,
            revision: revision
        )
    }

    func testTheNoticeSaysWhatTheMacSays() {
        XCTAssertNil(AidenSpendingCopy.notice(spending(.under), botName: nil))
        XCTAssertEqual(
            AidenSpendingCopy.notice(spending(.nearing), botName: nil)?.title,
            "This chat has used $4.10 of its $5.00 limit."
        )
        let reached = AidenSpendingCopy.notice(spending(.reached, period: .month, spent: 5.37), botName: "Ada")
        XCTAssertEqual(reached?.title, "Ada reached its $5.00 spending limit this month.")
        XCTAssertEqual(reached?.body, "It has spent $5.37. Allow $5.00 more to keep going, or change the limit on your Mac.")
        XCTAssertEqual(reached?.allowMore, "Allow $5.00 more")
        XCTAssertEqual(AidenSpendingCopy.notice(spending(.reached, period: .month), botName: "  ")?.title,
                       "This Bot reached its $5.00 spending limit this month.")
        XCTAssertEqual(AidenSpendingCopy.usd(1_250), "$1,250.00")
        XCTAssertEqual(AidenSpendingCopy.usd(0.004), "less than $0.01")
    }

    func testAllowMoreAddsOnceAndACrossedTapRereadsInsteadOfAddingTwice() async {
        let mac = FakeSpendingMac(current: spending(.reached, spent: 5.37))
        let model = AidenSpendingNoticeModel()
        await model.refresh(owner: .chat("chat-1"), transport: mac)
        XCTAssertEqual(model.spending?.state, .reached)

        // Another device allowed more first: this tap's revision is stale.
        await mac.allowElsewhere()
        await model.allowMore(transport: mac)
        let allowances = await mac.allowances
        XCTAssertEqual(allowances, 1, "the crossed tap added nothing")
        XCTAssertEqual(model.spending?.state, .under, "the notice shows what the Mac has now")
        XCTAssertEqual(model.spending?.allowedUsd, 10)
        XCTAssertNil(model.errorMessage)
    }

    func testAMacWithoutTheFeatureShowsNothing() async {
        let model = AidenSpendingNoticeModel()
        await model.refresh(owner: .bot("ada"), transport: nil)
        XCTAssertNil(model.spending)
    }
}

private actor FakeSpendingMac: AidenSpendingTransport {
    private var current: AidenSpending
    private(set) var allowances = 0

    init(current: AidenSpending) {
        self.current = current
    }

    func allowElsewhere() {
        allow()
    }

    func spending(owner: AidenSpendingOwner) async throws -> AidenSpendingStatus {
        AidenSpendingStatus(spending: current)
    }

    func allowMoreSpending(owner: AidenSpendingOwner, revision: String) async throws -> AidenSpendingStatus {
        guard revision == current.revision else {
            throw AidenRemoteClientError.server(
                statusCode: 409,
                body: try AidenRemoteJSONDecoder.decode(
                    AidenRemoteErrorEnvelope.self,
                    from: Data(#"{"error":{"code":"revision_conflict","message":"The spending limit changed. Refresh it before trying again.","requestId":"request_1","retryable":false,"details":{"currentRevision":"\#(current.revision)"}}}"#.utf8)
                ).error
            )
        }
        allow()
        return AidenSpendingStatus(spending: current)
    }

    private func allow() {
        allowances += 1
        current = AidenSpending(
            period: current.period,
            state: .under,
            limitUsd: current.limitUsd,
            allowedUsd: current.allowedUsd + current.allowMoreUsd,
            spentUsd: current.spentUsd,
            allowMoreUsd: current.allowMoreUsd,
            revision: "sp_\(allowances + 1)"
        )
    }
}
