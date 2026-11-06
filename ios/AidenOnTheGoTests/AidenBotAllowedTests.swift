import Foundation
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenBotAllowedTests: XCTestCase {
    func fixture() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try XCTUnwrap(root["botAllowed"] as? [String: Any])
    }
    func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try AidenRemoteJSONDecoder.decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
    func testHostOfferedApprovalAndFolderCountsDecodeWithoutPrivateAuthority() throws {
        let f = try fixture()
        let approval = try decode(AidenRemoteBotApproval.self, f["approval"]!)
        let access = try decode(AidenRemoteBotAccessRequest.self, f["accessRequest"]!)
        let a = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(approval)) as? [String: Any])
        let b = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(access)) as? [String: Any])
        XCTAssertEqual(a["alwaysCount"] as? Int, 3)
        XCTAssertEqual(b["approvalCount"] as? Int, 3)
        XCTAssertNil(a["always"])
    }
}

extension AidenBotAllowedTests {
    func page(_ key: String) throws -> AidenBotAllowedList {
        let f = try fixture()
        if key == "list" { return try decode(AidenBotAllowedList.self,f[key]!) }
        return try decode(AidenBotAllowedList.self, (f["paginated"] as! [String: Any])[key]!)
    }
    func testCompleteViewIncludesFoldersBeyondFiftyRulesAndRemoveRepages() async throws {
        let t = AllowedTransport(first: try page("firstPage"), next: try page("nextPage"), removed: try page("afterRemove"), removedNext: try page("afterRemoveNextPage"))
        let model = AidenBotAllowedModel(botID: t.first.botId,transport: t)
        await model.load()
        XCTAssertEqual(model.entries.count,53)
        XCTAssertEqual(model.entries.filter { $0.kind == .folder }.count,3)
        XCTAssertEqual(model.countSummary,"53")
        let id = try XCTUnwrap(model.entries.first?.id)
        await model.remove(id)
        XCTAssertEqual(model.entries.count,52)
        XCTAssertEqual(model.entries.filter { $0.kind == .folder }.count,3)
        XCTAssertFalse(model.entries.contains { $0.id == id })
        XCTAssertEqual(model.countSummary,"52")
        XCTAssertEqual(t.cursors.compactMap { $0 }.count,2)
    }
    func testCanonicalDisplayRowsPreserveHostStringsAndFolderHasNoUsage() throws {
        let list=try page("list")
        XCTAssertEqual(list.entries.map(\.what),["Google Calendar · Create event","Click on amazon.com","Folder · ~/Documents/Reports 1"])
        XCTAssertEqual(list.entries.map(\.uses),[0,12,nil])
        XCTAssertNil(list.entries[2].lastUsedAt)
    }
    func testStrictListRejectsPrivateFieldsNullsUsageAndBounds() throws {
        let original = try fixture()["list"] as! [String: Any]
        let row = (original["entries"] as! [[String: Any]])[0]
        var invalidRows: [[String: Any]] = []
        for (key,value) in [("target","secret" as Any),("uses",NSNull()),("uses",-1),("uses",1.5),("uses",true),("uses",9_007_199_254_740_992),("id","bad/id"),("id","valid\n"),("what","Safe\u{202E}hidden"),("what",String(repeating:"🧭",count:201)),("addedAt","yesterday"),("lastUsedAt",NSNull())] {
            var r = row; r[key] = value; invalidRows.append(r)
        }
        var missing = row; missing["uses"] = nil; invalidRows.append(missing)
        var folder = row; folder["kind"] = "folder"; invalidRows.append(folder)
        for r in invalidRows { var o = original; o["entries"] = [r]; XCTAssertThrowsError(try decode(AidenBotAllowedList.self,o)) }
        for value: Any in [NSNull(),"cur_bad","cur_" + String(repeating:"A",count:43) + "\n",42] { var o = original; o["nextCursor"] = value; XCTAssertThrowsError(try decode(AidenBotAllowedList.self,o)) }
        var o = original; o["entries"] = [row,row]; XCTAssertThrowsError(try decode(AidenBotAllowedList.self,o))
        o["entries"] = Array(repeating:row,count:51); XCTAssertThrowsError(try decode(AidenBotAllowedList.self,o))
        var unicode = row; unicode["what"] = String(repeating:"🧭",count:200); o["entries"] = [unicode]
        XCTAssertEqual(try decode(AidenBotAllowedList.self,o).entries[0].what.unicodeScalars.count,200)
    }
    func testCountsAbsentOnlyAndOfferedOnly() throws {
        let f = try fixture()
        XCTAssertNil(try decode(AidenRemoteBotApproval.self,f["legacyApproval"]!).alwaysCount)
        XCTAssertNil(try decode(AidenRemoteBotAccessRequest.self,f["legacyAccessRequest"]!).approvalCount)
        for (key,countKey,type) in [("approval","alwaysCount",true),("accessRequest","approvalCount",false)] {
            for value: Any in [NSNull(),true,2,21,3.5,"3"] {
                var o = f[key] as! [String: Any]; o[countKey] = value
                if type { XCTAssertThrowsError(try decode(AidenRemoteBotApproval.self,o)) }
                else { XCTAssertThrowsError(try decode(AidenRemoteBotAccessRequest.self,o)) }
            }
        }
        var approval = f["approval"] as! [String: Any]; approval["canAllow"] = false
        XCTAssertThrowsError(try decode(AidenRemoteBotApproval.self,approval))
        var access = f["accessRequest"] as! [String: Any]; access["choices"] = ["not_now","once"]
        XCTAssertThrowsError(try decode(AidenRemoteBotAccessRequest.self,access))
    }
    func testExpiredCursorRefreshesFromFirstPageAndNoGrantMakesNoCalls() async throws {
        let t = AllowedTransport(first:try page("firstPage"),next:try page("nextPage"),removed:try page("afterRemove"),removedNext:try page("afterRemoveNextPage"))
        let body = try decode(AidenRemoteErrorEnvelope.Body.self,["code":"invalid_request","message":"Refresh","requestId":"req","retryable":true])
        t.pageFailure = AidenRemoteClientError.server(statusCode:400,body:body)
        let model = AidenBotAllowedModel(botID:t.first.botId,transport:t)
        await model.load()
        XCTAssertEqual(model.entries.count,53)
        XCTAssertEqual(t.cursors.count,4)
        let denied = AidenBotAllowedModel(botID:t.first.botId,transport:t,isCurrent:{ false })
        await denied.load()
        XCTAssertEqual(t.cursors.count,4); XCTAssertNil(denied.countSummary)
    }
    func testCursorLoopAndMixedPagesNeverPublishPartialCount() async throws {
        let t = AllowedTransport(first: try page("firstPage"),next: try page("firstPage"),removed: try page("list"),removedNext: try page("nextPage"))
        let model = AidenBotAllowedModel(botID:t.first.botId,transport:t)
        await model.load()
        XCTAssertFalse(model.hasLoaded); XCTAssertNil(model.countSummary); XCTAssertNotNil(model.error)
    }
    func testLatePageCannotMixOldSnapshotIntoRefresh() async throws {
        let t=AllowedTransport(first:try page("firstPage"),next:try page("nextPage"),removed:try page("afterRemove"),removedNext:try page("afterRemoveNextPage"))
        let entered=expectation(description:"page entered")
        let gate=AllowedGate(entered:entered); t.pageGate=gate
        let model=AidenBotAllowedModel(botID:t.first.botId,transport:t)
        let old=Task { await model.load() }
        await fulfillment(of:[entered],timeout:2)
        t.first=try page("list"); t.pageGate=nil
        await model.load(); await gate.release(); await old.value
        XCTAssertEqual(model.entries.count,3)
        XCTAssertEqual(model.countSummary,"3"); XCTAssertNil(model.error)
    }
    func testFailedRemoveKeepsRowAndLateRemoveCannotReplaceRefresh() async throws {
        let t = AllowedTransport(first:try page("list"),next:try page("nextPage"),removed:try page("afterRemove"),removedNext:try page("afterRemoveNextPage"))
        let model = AidenBotAllowedModel(botID:t.first.botId,transport:t)
        await model.load(); let before = model.entries
        t.removeFailure = URLError(.networkConnectionLost)
        await model.remove(before[0].id)
        XCTAssertEqual(model.entries,before); XCTAssertNotNil(model.error)
        let entered = expectation(description:"remove entered")
        t.gate = AllowedGate(entered:entered)
        let request = Task { await model.remove(before[0].id) }
        await fulfillment(of:[entered],timeout:2)
        XCTAssertEqual(model.entries,before); XCTAssertEqual(model.removing,before[0].id)
        await model.load()
        await t.gate?.release(); await request.value
        XCTAssertEqual(model.entries,before); XCTAssertNil(model.removing)
        model.invalidate(); XCTAssertNil(model.countSummary)
    }
}
private actor AllowedGate {
    let entered: XCTestExpectation
    var continuation: CheckedContinuation<Void,Never>?
    init(entered:XCTestExpectation) { self.entered = entered }
    func wait() async { await withCheckedContinuation { continuation = $0; entered.fulfill() } }
    func release() { continuation?.resume(); continuation = nil }
}
private final class AllowedTransport: AidenBotAllowedTransport, @unchecked Sendable {
    var first: AidenBotAllowedList; let next: AidenBotAllowedList; let removed: AidenBotAllowedList; let removedNext: AidenBotAllowedList
    var pageGate: AllowedGate?
    var pageFailure: Error?
    var cursors:[String?] = []; var didRemove = false; var removeFailure: Error?; var gate: AllowedGate?
    init(first:AidenBotAllowedList,next:AidenBotAllowedList,removed:AidenBotAllowedList,removedNext:AidenBotAllowedList) { self.first=first; self.next=next; self.removed=removed; self.removedNext=removedNext }
    func botAllowed(botId:String,cursor:String?) async throws -> AidenBotAllowedList { cursors.append(cursor); let result = cursor == nil ? first : (didRemove ? removedNext : next); if cursor != nil { await pageGate?.wait(); if let error = pageFailure { pageFailure = nil; throw error } }; return result }
    func removeBotAllowed(botId:String,entryId:String) async throws -> AidenBotAllowedList {
        await gate?.wait()
        if let error=removeFailure { removeFailure=nil; throw error }; didRemove=true; return removed
    }
}
