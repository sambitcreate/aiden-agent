import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

private actor OpenWorkHost: AidenBotOpenWorkTransport {
    var snapshot: AidenOpenWorkSnapshot
    var reads = 0
    var writes: [AidenOpenWorkMutation] = []
    var replies: [Result<AidenOpenWorkResult, Error>] = []
    var evidence: AidenOpenWorkEvidence?
    var readError: Error?
    var holdNextWrite = false
    var heldWrite: CheckedContinuation<AidenOpenWorkResult, Error>?
    var holdNextRead = false
    var heldRead: CheckedContinuation<AidenOpenWorkSnapshot, Error>?
    var holdEvidence = false
    var heldEvidence: CheckedContinuation<AidenOpenWorkEvidence, Error>?
    init(_ snapshot: AidenOpenWorkSnapshot) { self.snapshot = snapshot }
    func setSnapshot(_ snapshot: AidenOpenWorkSnapshot) { self.snapshot = snapshot }
    func queue(_ reply: Result<AidenOpenWorkResult, Error>) { replies.append(reply) }
    func setReadError(_ error: Error?) { readError = error }
    func holdWrite() { holdNextWrite = true }
    func releaseWrite(_ result: Result<AidenOpenWorkResult, Error>) { heldWrite?.resume(with: result); heldWrite = nil }
    func holdRead() { holdNextRead = true }
    func releaseRead(_ snapshot: AidenOpenWorkSnapshot) { heldRead?.resume(returning: snapshot); heldRead = nil }
    func setEvidence(_ value: AidenOpenWorkEvidence) { evidence = value }
    func holdEvidenceRead() { holdEvidence = true }
    func releaseEvidence(_ value: AidenOpenWorkEvidence) { heldEvidence?.resume(returning: value); heldEvidence = nil }
    func botOpenWork(botId: String) async throws -> AidenOpenWorkSnapshot {
        reads += 1
        if holdNextRead { holdNextRead = false; return try await withCheckedThrowingContinuation { heldRead = $0 } }
        if let readError { throw readError }
        return snapshot
    }
    func mutateBotOpenWork(botId: String, mutation: AidenOpenWorkMutation) async throws -> AidenOpenWorkResult {
        writes.append(mutation)
        if holdNextWrite { holdNextWrite = false; return try await withCheckedThrowingContinuation { heldWrite = $0 } }
        guard !replies.isEmpty else { throw URLError(.networkConnectionLost) }
        return try replies.removeFirst().get()
    }
    func botOpenWorkEvidence(botId: String, itemId: String, kind: AidenOpenWorkEvidenceKind) async throws -> AidenOpenWorkEvidence {
        if holdEvidence { holdEvidence = false; return try await withCheckedThrowingContinuation { heldEvidence = $0 } }
        guard let evidence else { throw URLError(.resourceUnavailable) }
        return evidence
    }
}

@MainActor
final class AidenBotOpenWorkTests: XCTestCase {
    private let botID = "bot_fixture"
    private let itemID = "item.one"
    private let originalID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    private func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try AidenRemoteJSONDecoder.decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
    private func itemObject(_ changes: [String: Any] = [:]) -> [String: Any] {
        var value: [String: Any] = ["id": itemID, "revision": "item-1", "title": "Review the brief", "note": "Check assumptions",
            "state": "open", "createdAt": 1000, "updatedAt": 1000,
            "source": ["kind": "person", "submissionId": "9007199254740993", "entryId": "9007199254740995"],
            "links": [["kind": "source", "submissionId": "9007199254740993", "entryId": "9007199254740995"]],
            "execution": ["state": "running", "canStop": true]]
        value.merge(changes) { _, new in new }
        return value
    }
    private func snapshotObject(items: [[String: Any]]? = nil, undo: [[String: Any]] = [], revision: String = "snapshot-1") -> [String: Any] {
        ["botId": botID, "revision": revision, "items": items ?? [itemObject()], "undo": undo]
    }
    private func snapshot(items: [[String: Any]]? = nil, undo: [[String: Any]] = [], revision: String = "snapshot-1") throws -> AidenOpenWorkSnapshot {
        try decode(AidenOpenWorkSnapshot.self, snapshotObject(items: items, undo: undo, revision: revision))
    }
    private func option(_ nonce: UUID, itemID: String = "item.one", revision: String = "item-1", expires: Int = 8_000_000_000_000) -> [String: Any] {
        ["mutationId": nonce.uuidString, "itemId": itemID, "expectedRevision": revision, "expiresAt": expires]
    }
    private func stop(_ nonce: UUID, state: String) -> [String: Any] {
        ["mutationId": nonce.uuidString, "state": state, "requestedAt": 1000]
    }
    private func accepted(_ nonce: UUID, snapshot: [String: Any]? = nil, stop: [String: Any]? = nil) throws -> AidenOpenWorkResult {
        var value: [String: Any] = ["ok": true, "mutationId": nonce.uuidString, "replayed": true, "itemId": itemID,
            "snapshot": snapshot ?? snapshotObject()]
        if let stop { value["stop"] = stop }
        return try decode(AidenOpenWorkResult.self, value)
    }
    private func rejected(_ code: String, snapshot: [String: Any]? = nil) throws -> AidenOpenWorkResult {
        var value: [String: Any] = ["ok": false, "code": code, "error": "The host refused this operation."]
        if let snapshot { value["snapshot"] = snapshot }
        return try decode(AidenOpenWorkResult.self, value)
    }
    private func setup() async throws -> (AidenBotOpenWorkModel, OpenWorkHost) {
        let host = try OpenWorkHost(snapshot())
        let model = AidenBotOpenWorkModel(botID: botID, transport: host)
        await model.load()
        return (model, host)
    }
    private func newDraft(_ model: AidenBotOpenWorkModel) {
        model.begin(); model.draft?.title = "Review the brief"; model.draft?.note = "Keep these assumptions"
    }
    private func serverError(_ status: Int) throws -> AidenRemoteClientError {
        .server(statusCode: status, body: try decode(AidenRemoteErrorEnvelope.Body.self,
            ["code": status == 401 ? "authentication_required" : status == 404 ? "not_found" : "capability_denied", "message": "Refused", "requestId": "request-1", "retryable": false]))
    }

    func testSharedRevision55FixtureDecodesEveryResponseAndMutation() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bot-open-work", withExtension: "json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(fixture["contractRevision"] as? Int, 59)
        let snapshot = try decode(AidenOpenWorkSnapshot.self, XCTUnwrap(fixture["snapshot"]))
        XCTAssertEqual(snapshot.items.first, try decode(AidenOpenWorkItem.self, XCTUnwrap(fixture["item"])))
        _ = try decode(AidenOpenWorkUndo.self, XCTUnwrap(fixture["undo"]))
        _ = try decode(AidenOpenWorkStop.self, XCTUnwrap(fixture["stop"]))
        guard case .accepted = try decode(AidenOpenWorkResult.self, XCTUnwrap(fixture["result"])) else { return XCTFail("Accepted receipt") }
        guard case let .rejected(stale) = try decode(AidenOpenWorkResult.self, XCTUnwrap(fixture["stale"])) else { return XCTFail("Typed stale receipt") }
        XCTAssertEqual(stale.code, .stale)
        XCTAssertEqual(try decode(AidenOpenWorkEvidence.self, XCTUnwrap(fixture["evidenceSource"])).kind, .source)
        XCTAssertEqual(try decode(AidenOpenWorkEvidence.self, XCTUnwrap(fixture["evidenceResult"])).kind, .result)
        let mutations = try XCTUnwrap(fixture["mutations"] as? [String: Any])
        for action in ["add", "edit", "undo", "stop"] {
            XCTAssertEqual(try decode(AidenOpenWorkMutation.self, XCTUnwrap(mutations[action])).action.rawValue, action)
        }
    }

    func testOpaqueIdentitiesAndLargeDecimalEntriesAreNeverRounded() throws {
        let item = try decode(AidenOpenWorkItem.self, itemObject(["revision": "opaque:r-2"] ))
        XCTAssertEqual(item.id, "item.one")
        XCTAssertEqual(item.revision, "opaque:r-2")
        XCTAssertEqual(item.source.submissionId, "9007199254740993")
        XCTAssertEqual(item.links.first?.entryId, "9007199254740995")
        for id in ["../other", "hello/world", "é", String(repeating: "a", count: 161)] {
            XCTAssertThrowsError(try decode(AidenOpenWorkItem.self, itemObject(["id": id])))
        }
        for source: [String: Any] in [["kind": "person", "submissionId": 10, "entryId": "11"],
            ["kind": "person", "submissionId": "01", "entryId": "11"], ["kind": "person", "submissionId": "10"]] {
            XCTAssertThrowsError(try decode(AidenOpenWorkItem.self, itemObject(["source": source])))
        }
    }

    func testTextValidatesUnicodeScalarsUTF8AndNULWithoutTruncating() throws {
        XCTAssertEqual(try decode(AidenOpenWorkItem.self, itemObject(["title": String(repeating: "😀", count: 160)])).title.unicodeScalars.count, 160)
        XCTAssertThrowsError(try decode(AidenOpenWorkItem.self, itemObject(["title": String(repeating: "😀", count: 161)])))
        XCTAssertThrowsError(try decode(AidenOpenWorkItem.self, itemObject(["note": String(repeating: "界", count: 683)])))
        XCTAssertEqual(try decode(AidenOpenWorkItem.self, itemObject(["note": String(repeating: "界", count: 682)])).note.utf8.count, 2046)
        XCTAssertThrowsError(try decode(AidenOpenWorkItem.self, itemObject(["note": "contains\0nul"])))
        let raw = Data(#"{"kind":"person","submissionId":"\ud83d","entryId":"11"}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenOpenWorkSource.self, from: raw))
    }

    func testPartialItemsWaitingAndExecutionAuthorityFailClosed() throws {
        for key in ["id", "revision", "state", "source", "execution", "createdAt"] {
            var value = itemObject(); value.removeValue(forKey: key)
            XCTAssertThrowsError(try decode(AidenOpenWorkItem.self, value), key)
        }
        for change: [String: Any] in [["state": "waiting"], ["state": "open", "waitingReason": "Later"],
            ["execution": ["state": "idle", "canStop": true]], ["execution": ["state": "running", "canStop": true, "blockedReason": "mixed_inputs"]],
            ["completion": ["by": "person", "at": 1000]], ["createdAt": -1], ["updatedAt": 1.5]] {
            XCTAssertThrowsError(try decode(AidenOpenWorkItem.self, itemObject(change)))
        }
        let waiting = try decode(AidenOpenWorkItem.self, itemObject(["state": "waiting", "waitingReason": "Updated brief"]))
        XCTAssertEqual(waiting.waitingReason, "Updated brief")
    }

    func testSnapshotBoundsOwnershipAndUndoRevisionAreValidated() throws {
        let active = (0..<64).map { itemObject(["id": "active.\($0)"]) }
        let terminal = (0..<128).map { itemObject(["id": "done.\($0)", "state": "done"]) }
        XCTAssertEqual(try snapshot(items: active + terminal).items.count, 192)
        XCTAssertThrowsError(try snapshot(items: active + [itemObject(["id": "extra"])]))
        XCTAssertThrowsError(try snapshot(items: terminal + [itemObject(["id": "extra", "state": "dismissed"])]))
        XCTAssertThrowsError(try snapshot(items: [itemObject(), itemObject()]))
        XCTAssertThrowsError(try snapshot(undo: [option(originalID, revision: "another-revision")]))
        XCTAssertThrowsError(try snapshot(undo: [option(originalID, itemID: "other.item")]))
    }

    func testPrivateFieldsAreRejectedAndCompletionResultIsExplicitEvidence() throws {
        for change: [String: Any] in [["path": "/private"], ["unknown": ["credential": "private"]], ["url": "https://example.test"], ["toolArguments": [:]]] {
            XCTAssertThrowsError(try decode(AidenOpenWorkItem.self, itemObject(change)))
        }
        let item = try decode(AidenOpenWorkItem.self, itemObject(["state": "done", "completion": ["by": "person", "at": 1001,
            "result": ["submissionId": "9007199254740993", "entryId": "9007199254740997"]]]))
        XCTAssertEqual(item.completion?.result?.entryId, "9007199254740997")
        XCTAssertTrue(item.hasResult)
        XCTAssertEqual(try decode(AidenOpenWorkItem.self, itemObject(["safeFutureFlag": true])).id, itemID)
    }

    func testEvidenceRequiresOwnedStringIdentitiesTruncationAndBoundedText() throws {
        let value: [String: Any] = ["itemId": itemID, "kind": "source", "submissionId": "9007199254740993", "entryId": "9007199254740995",
            "title": "Request", "text": "Actual retained request", "truncated": true]
        XCTAssertTrue(try decode(AidenOpenWorkEvidence.self, value).truncated)
        for key in ["itemId", "kind", "submissionId", "entryId", "text", "truncated"] {
            var missing = value; missing.removeValue(forKey: key)
            XCTAssertThrowsError(try decode(AidenOpenWorkEvidence.self, missing))
        }
        var oversized = value; oversized["text"] = String(repeating: "a", count: 32769)
        XCTAssertThrowsError(try decode(AidenOpenWorkEvidence.self, oversized))
    }

    func testMutationEncoderCannotAuthorProvenanceOrTurnCreation() throws {
        let request = try AidenOpenWorkMutation(action: .add, expectedRevision: "snapshot-1", title: "Metadata only", note: "A note")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["action", "mutationId", "expectedRevision", "title", "note"])
        XCTAssertThrowsError(try AidenOpenWorkMutation(action: .edit, expectedRevision: "item-1", id: itemID, patch: .init(state: .waiting)))
        XCTAssertThrowsError(try AidenOpenWorkMutation(action: .edit, expectedRevision: "item-1", id: itemID, patch: .init(state: .done, waitingReason: "stale")))
    }

    func testEqualRevisionRefreshUpdatesExecutionAndPreservesEditedText() async throws {
        let (model, host) = try await setup()
        model.begin(item: try decode(AidenOpenWorkItem.self, itemObject()))
        model.draft?.note = "My draft"
        await host.setSnapshot(try snapshot(items: [itemObject(["execution": ["state": "interrupted", "canStop": true]])]))
        await model.load()
        XCTAssertEqual(model.snapshot?.revision, "snapshot-1")
        XCTAssertEqual(model.baseline?.execution.state, .interrupted)
        XCTAssertEqual(model.draft?.note, "My draft")
        XCTAssertNil(model.conflict)
    }

    func testStaleEditRetainsDraftAndRequiresExplicitRevisionReview() async throws {
        let (model, host) = try await setup()
        model.begin(item: try decode(AidenOpenWorkItem.self, itemObject()))
        model.draft?.note = "My draft"
        let current = snapshotObject(items: [itemObject(["revision": "item-2", "note": "Host edit"])], revision: "snapshot-2")
        await host.setSnapshot(try decode(AidenOpenWorkSnapshot.self, current))
        await host.queue(.success(try rejected("stale", snapshot: current)))
        await model.saveDraft()
        XCTAssertFalse(model.uncertain)
        XCTAssertEqual(model.draft?.note, "My draft")
        XCTAssertEqual(model.conflict?.note, "Host edit")
        XCTAssertFalse(model.canSave)
        model.useLatestRevision()
        XCTAssertEqual(model.baseline?.revision, "item-2")
        XCTAssertEqual(model.draft?.note, "My draft")
        XCTAssertTrue(model.canSave)
    }

    func testRemovedItemDraftCannotResurrectTheItem() async throws {
        let (model, host) = try await setup()
        model.begin(item: try decode(AidenOpenWorkItem.self, itemObject()))
        await host.setSnapshot(try snapshot(items: [])); await model.load(); await model.saveDraft()
        XCTAssertTrue(model.wasRemoved)
        XCTAssertNotNil(model.draft)
        let writes = await host.writes
        XCTAssertTrue(writes.isEmpty)
    }

    func testMetadataOnlyAddEditWaitingDoneReopenDismissAndUndoJourney() async throws {
        let host = try OpenWorkHost(snapshot(items: []))
        let model = AidenBotOpenWorkModel(botID: botID, transport: host)
        await model.load()
        func finish(_ response: @escaping (AidenOpenWorkMutation) -> [String: Any], operation: @escaping @MainActor () async -> Void) async throws -> AidenOpenWorkMutation {
            await host.holdWrite()
            let job = Task { await operation() }
            while await host.heldWrite == nil { await Task.yield() }
            let sent = await host.writes
            let mutation = try XCTUnwrap(sent.last)
            let object = response(mutation)
            await host.setSnapshot(try decode(AidenOpenWorkSnapshot.self, object))
            await host.releaseWrite(.success(try accepted(mutation.mutationId, snapshot: object)))
            await job.value
            return mutation
        }
        let created = itemObject(["note": "Keep these assumptions", "source": ["kind": "person"], "links": [],
            "execution": ["state": "idle", "canStop": false]])
        newDraft(model)
        let add = try await finish({ _ in self.snapshotObject(items: [created], revision: "snapshot-2") }, operation: { await model.saveDraft() })
        XCTAssertEqual(add.action, .add)
        XCTAssertNil(add.id)
        XCTAssertNil(add.patch)
        XCTAssertNil(model.draft)
        XCTAssertEqual(model.snapshot?.items.first?.execution.state, .idle)
        XCTAssertFalse(model.snapshot?.items.first?.hasSource ?? true)
        model.begin(item: try XCTUnwrap(model.snapshot?.items.first))
        model.draft?.title = "Review the updated brief"; model.draft?.note = "Need the owner’s revision"
        model.draft?.state = .waiting; model.draft?.waitingReason = "Updated brief"
        var waiting = created
        waiting.merge(["revision": "item-2", "title": "Review the updated brief", "note": "Need the owner’s revision", "state": "waiting", "waitingReason": "Updated brief"]) { _, next in next }
        let edit = try await finish({ _ in self.snapshotObject(items: [waiting], revision: "snapshot-3") }, operation: { await model.saveDraft() })
        XCTAssertEqual(edit.expectedRevision, "item-1")
        XCTAssertEqual(model.snapshot?.items.first?.waitingReason, "Updated brief")
        XCTAssertEqual(model.snapshot?.items.first?.note, "Need the owner’s revision")
        var done = waiting; done.removeValue(forKey: "waitingReason")
        done.merge(["revision": "item-3", "state": "done", "completion": ["by": "person", "at": 1001]]) { _, next in next }
        let waitingItem = try XCTUnwrap(model.snapshot?.items.first)
        let markDone = try await finish({ _ in self.snapshotObject(items: [done], revision: "snapshot-4") }, operation: { await model.setState(waitingItem, .done) })
        XCTAssertNil(markDone.patch?.waitingReason)
        XCTAssertEqual(model.snapshot?.items.first?.completion?.by, .person)
        var reopened = done; reopened.removeValue(forKey: "completion"); reopened["state"] = "open"; reopened["revision"] = "item-4"
        let doneItem = try XCTUnwrap(model.snapshot?.items.first)
        _ = try await finish({ _ in self.snapshotObject(items: [reopened], revision: "snapshot-5") }, operation: { await model.setState(doneItem, .open) })
        XCTAssertEqual(model.snapshot?.items.first?.state, .open)
        var dismissed = reopened; dismissed["revision"] = "item-5"; dismissed["state"] = "dismissed"
        let openItem = try XCTUnwrap(model.snapshot?.items.first)
        let dismissal = try await finish({ mutation in self.snapshotObject(items: [dismissed], undo: [self.option(mutation.mutationId, revision: "item-5")], revision: "snapshot-6") }, operation: { await model.act(.dismiss, on: openItem) })
        XCTAssertEqual(dismissal.action, .dismiss)
        XCTAssertEqual(model.snapshot?.items.first?.state, .dismissed)
        let undo = try XCTUnwrap(model.snapshot?.undo.first)
        reopened["revision"] = "item-6"
        let undone = try await finish({ _ in self.snapshotObject(items: [reopened], revision: "snapshot-7") }, operation: { await model.undo(undo) })
        XCTAssertEqual(undone.undoOf, dismissal.mutationId)
        XCTAssertEqual(undone.expectedRevision, "item-5")
        XCTAssertEqual(model.snapshot?.items.first?.state, .open)
        XCTAssertTrue(model.snapshot?.undo.isEmpty == true)
    }

    func testPartialOrMismatchedReceiptsCannotClaimAcceptedIdentity() throws {
        let base: [String: Any] = ["ok": true, "mutationId": originalID.uuidString, "replayed": false, "snapshot": snapshotObject()]
        for key in ["mutationId", "replayed", "snapshot"] {
            var missing = base; missing.removeValue(forKey: key)
            XCTAssertThrowsError(try decode(AidenOpenWorkResult.self, missing))
        }
        var mismatch = base
        mismatch["stop"] = stop(UUID(), state: "stopped")
        XCTAssertThrowsError(try decode(AidenOpenWorkResult.self, mismatch))
        var missingStop = stop(originalID, state: "stopped"); missingStop.removeValue(forKey: "mutationId")
        XCTAssertThrowsError(try decode(AidenOpenWorkStop.self, missingStop))
    }

    func testHostReportedPendingStopAlsoFencesUndoFromAnotherClient() async throws {
        let record = itemObject(["lastStop": stop(UUID(), state: "uncertain"), "execution": ["state": "stopping", "canStop": false]])
        let host = try OpenWorkHost(snapshot(items: [record], undo: [option(originalID)]))
        let model = AidenBotOpenWorkModel(botID: botID, transport: host)
        await model.load()
        await model.undo(try XCTUnwrap(model.snapshot?.undo.first))
        let writes = await host.writes
        XCTAssertTrue(writes.isEmpty)
        XCTAssertEqual(model.snapshot?.items.first?.state, .open)
    }

    func testParsedUnavailableKeepsTheExactAddAndBlocksFreshMutations() async throws {
        let (model, host) = try await setup()
        newDraft(model)
        await host.queue(.success(try rejected("unavailable")))
        await model.saveDraft()
        XCTAssertTrue(model.uncertain)
        let sent = await host.writes
        let first = try XCTUnwrap(sent.first)
        model.draft?.title = "A different unsent title"
        await model.saveDraft()
        await model.retryPending()
        let writes = await host.writes
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes[1], first)
        XCTAssertEqual(writes[1].title, "Review the brief")
    }

    func testLostAddSettlesOnlyByMatchingHostUndoReceiptNeverByTitle() async throws {
        let (model, host) = try await setup()
        newDraft(model); await model.saveDraft()
        let sent = await host.writes
        let request = try XCTUnwrap(sent.first)
        await host.setSnapshot(try snapshot(undo: [option(originalID)])); await model.load()
        XCTAssertTrue(model.uncertain, "Matching title or another action’s receipt cannot settle Add")
        await host.setSnapshot(try snapshot(undo: [option(request.mutationId)])); await model.load()
        XCTAssertFalse(model.uncertain)
        XCTAssertNil(model.draft)
    }

    func testUndoDisappearanceDoesNotSettleALostUndoAndRefusalKeepsOriginalIdentity() async throws {
        let host = try OpenWorkHost(snapshot(undo: [option(originalID)]))
        let model = AidenBotOpenWorkModel(botID: botID, transport: host)
        await model.load()
        let undo = try XCTUnwrap(model.snapshot?.undo.first)
        await model.undo(undo)
        await host.setSnapshot(try snapshot()); await model.load()
        XCTAssertTrue(model.uncertain)
        await host.queue(.success(try rejected("undo_conflict")))
        await model.retryPending()
        XCTAssertTrue(model.uncertain)
        let writes = await host.writes
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes[0], writes[1])
    }

    func testUndoIsRevisionedDurableAndExpiresWithoutDispatch() async throws {
        let host = try OpenWorkHost(snapshot(undo: [option(originalID, expires: 2000)]))
        let model = AidenBotOpenWorkModel(botID: botID, transport: host)
        await model.load()
        let undo = try XCTUnwrap(model.snapshot?.undo.first)
        await model.undo(undo, now: Date(timeIntervalSince1970: 3))
        var writes = await host.writes
        XCTAssertTrue(writes.isEmpty)
        await model.undo(undo, now: Date(timeIntervalSince1970: 1))
        writes = await host.writes
        XCTAssertEqual(writes.first?.action, .undo)
        XCTAssertEqual(writes.first?.undoOf, originalID)
        XCTAssertEqual(writes.first?.expectedRevision, "item-1")
    }

    func testStopAndDismissWaitsForAnExactTerminalAcknowledgement() async throws {
        let (model, host) = try await setup()
        let item = try decode(AidenOpenWorkItem.self, itemObject())
        await host.holdWrite()
        let job = Task { await model.act(.stopAndDismiss, on: item) }
        while await host.heldWrite == nil { await Task.yield() }
        let sent = await host.writes
        let nonce = try XCTUnwrap(sent.first?.mutationId)
        await host.releaseWrite(.success(try accepted(nonce, stop: stop(nonce, state: "requested"))))
        await job.value
        XCTAssertTrue(model.uncertain)
        XCTAssertEqual(model.snapshot?.items.first?.state, .open)
        await model.setState(item, .done)
        await model.act(.dismiss, on: item)
        let blocked = await host.writes
        XCTAssertEqual(blocked.count, 1)
        await host.setSnapshot(try snapshot(items: [itemObject(["lastStop": stop(originalID, state: "stopped")])]))
        await model.load()
        XCTAssertTrue(model.uncertain, "A different Stop receipt is unrelated")
        await host.setSnapshot(try snapshot(items: [itemObject(["state": "dismissed", "lastStop": stop(nonce, state: "stopped"),
            "execution": ["state": "idle", "canStop": false]])]))
        await model.load()
        XCTAssertFalse(model.uncertain)
        XCTAssertEqual(model.snapshot?.items.first?.state, .dismissed)
    }

    func testBlockedStopSettlesWithoutClaimingCancellationOrDismissal() async throws {
        let (model, host) = try await setup()
        let item = try decode(AidenOpenWorkItem.self, itemObject())
        await model.act(.stopAndDismiss, on: item)
        let sent = await host.writes
        let nonce = try XCTUnwrap(sent.first?.mutationId)
        await host.setSnapshot(try snapshot(items: [itemObject(["lastStop": stop(nonce, state: "blocked")])]))
        await model.load()
        XCTAssertFalse(model.uncertain)
        XCTAssertEqual(model.snapshot?.items.first?.state, .open)
        XCTAssertTrue(model.message?.contains("refused") == true)
    }

    func testMixedInputAndUnlinkedRunsDoNotDispatchStop() async throws {
        let (model, host) = try await setup()
        for reason in ["mixed_inputs", "not_linked", "host_unavailable"] {
            let item = try decode(AidenOpenWorkItem.self, itemObject(["execution": ["state": "running", "canStop": false, "blockedReason": reason]]))
            XCTAssertNotNil(item.execution.explanation)
            await model.act(.stop, on: item)
            await model.act(.stopAndDismiss, on: item)
        }
        let writes = await host.writes
        XCTAssertTrue(writes.isEmpty)
    }

    func testAnyDeniedRetryPreservesPriorUnknownEvenAfterGrantRestoration() async throws {
        for status in [401, 403, 404] {
            let (model, host) = try await setup()
            await model.act(.stop, on: try decode(AidenOpenWorkItem.self, itemObject()))
            await host.queue(.failure(try serverError(status)))
            await model.retryPending()
            XCTAssertTrue(model.uncertain)
            let sent = await host.writes
            XCTAssertEqual(sent.count, 2)
            XCTAssertEqual(sent[0], sent[1])
        }
    }

    func testAuthoritativeReceiptWinsOverLateDeniedRetry() async throws {
        let (model, host) = try await setup()
        newDraft(model); await model.saveDraft()
        await host.holdWrite()
        let replay = Task { await model.retryPending() }
        while await host.heldWrite == nil { await Task.yield() }
        let writes = await host.writes
        let nonce = try XCTUnwrap(writes.first?.mutationId)
        await host.setSnapshot(try snapshot(undo: [option(nonce)])); await model.load()
        await host.releaseWrite(.failure(try serverError(403))); await replay.value
        XCTAssertFalse(model.uncertain)
        XCTAssertNil(model.draft)
    }

    func testJournalPrecedesDispatchAndActuallyReplaysAcrossRecreation() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "open-work-retention-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotOpenWorkDraftStore(root: root)
        let scope = AidenBotOpenWorkDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: botID)
        let host = try OpenWorkHost(snapshot())
        let model = AidenBotOpenWorkModel(botID: botID, transport: host, store: store, scope: scope)
        await model.load(); newDraft(model); await host.holdWrite()
        let save = Task { await model.saveDraft() }
        while await host.heldWrite == nil { await Task.yield() }
        let retained = try XCTUnwrap(try store.load(scope)?.attempt)
        XCTAssertEqual(retained.mutation.title, "Review the brief")
        XCTAssertEqual(try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        await host.releaseWrite(.failure(URLError(.networkConnectionLost))); await save.value
        let restored = AidenBotOpenWorkModel(botID: botID, transport: host, store: store, scope: scope)
        await restored.load(); await restored.retryPending()
        let writes = await host.writes
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes[1], retained.mutation)
        XCTAssertEqual(restored.draft?.note, "Keep these assumptions")
        XCTAssertNil(try store.load(.init(instanceID: "host-1", deviceID: "other-phone", botID: botID)))
        store.purge(instanceID: "host-1")
        XCTAssertNil(try store.load(scope))
    }

    func testStopChecksSurvive24HoursButOrdinaryExpiredRequestsCannotGetNewKeys() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "open-work-expiry-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotOpenWorkDraftStore(root: root)
        for action in [AidenOpenWorkMutation.Action.stop, .add] {
            let scope = AidenBotOpenWorkDraftStore.Scope(instanceID: "host-\(action.rawValue)", deviceID: "phone-1", botID: botID)
            let mutation = try AidenOpenWorkMutation(action: action, expectedRevision: "rev-1",
                id: action.isStop ? itemID : nil, title: action == .add ? "Draft" : nil)
            try store.save(.init(draft: nil, baseline: nil, draftRevision: nil,
                attempt: .init(mutation: mutation, itemID: mutation.id, consumesDraft: false, createdAt: Date().addingTimeInterval(-25 * 3600))), scope: scope)
            let host = try OpenWorkHost(snapshot())
            let model = AidenBotOpenWorkModel(botID: botID, transport: host, store: store, scope: scope)
            await model.load(); await model.retryPending()
            let writes = await host.writes
            XCTAssertEqual(writes.count, action.isStop ? 1 : 0)
            XCTAssertTrue(model.uncertain)
            if let first = writes.first { XCTAssertEqual(first, mutation) }
        }
    }

    func testAnotherWindowCannotOverwriteAnUnknownCommand() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "open-work-windows-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotOpenWorkDraftStore(root: root)
        let scope = AidenBotOpenWorkDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: botID)
        let host = try OpenWorkHost(snapshot())
        let first = AidenBotOpenWorkModel(botID: botID, transport: host, store: store, scope: scope)
        let second = AidenBotOpenWorkModel(botID: botID, transport: host, store: store, scope: scope)
        await first.load(); await second.load()
        newDraft(first); await first.saveDraft()
        let pending = try store.load(scope)?.attempt
        newDraft(second); await second.saveDraft()
        XCTAssertFalse(second.canWrite)
        XCTAssertEqual(try store.load(scope)?.attempt, pending)
        let writes = await host.writes
        XCTAssertEqual(writes.count, 1)
    }

    func testLateMutationCannotResurrectAPurgedPairing() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "open-work-purge-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotOpenWorkDraftStore(root: root)
        let scope = AidenBotOpenWorkDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: botID)
        let host = try OpenWorkHost(snapshot())
        var current = true
        let model = AidenBotOpenWorkModel(botID: botID, transport: host, isCurrent: { current }, store: store, scope: scope)
        await model.load(); newDraft(model); await host.holdWrite()
        let job = Task { await model.saveDraft() }
        while await host.heldWrite == nil { await Task.yield() }
        let sent = await host.writes
        let nonce = try XCTUnwrap(sent.first?.mutationId)
        current = false; store.purge(instanceID: "host-1")
        await host.releaseWrite(.success(try accepted(nonce))); await job.value
        XCTAssertNil(try store.load(scope))
        XCTAssertNotNil(model.draft)
        XCTAssertFalse(model.canWrite)
    }

    func testReadOnlyAndStaleReadsCannotPublishOrMutateAnotherScope() async throws {
        let host = try OpenWorkHost(snapshot())
        var current = true
        let model = AidenBotOpenWorkModel(botID: botID, transport: host, isCurrent: { current }, mayWrite: { false })
        await model.load(); newDraft(model); await model.saveDraft()
        await host.holdRead()
        let job = Task { await model.load() }
        while await host.heldRead == nil { await Task.yield() }
        current = false
        await host.releaseRead(try snapshot(items: [])); await job.value
        XCTAssertEqual(model.snapshot?.items.count, 1)
        let writes = await host.writes
        XCTAssertTrue(writes.isEmpty)
    }

    func testEvidenceShowsActualOwnedTextAndDropsClosedOrCrossItemResponses() async throws {
        let (model, host) = try await setup()
        let item = try decode(AidenOpenWorkItem.self, itemObject())
        let value = try decode(AidenOpenWorkEvidence.self, ["itemId": itemID, "kind": "source", "submissionId": "9007199254740993", "entryId": "9007199254740995",
            "title": "Actual source", "text": "Review the original brief.", "truncated": true])
        await host.setEvidence(value); await model.loadEvidence(item: item, kind: .source)
        XCTAssertEqual(model.evidence?.text, "Review the original brief.")
        XCTAssertTrue(model.evidence?.truncated == true)
        await host.holdEvidenceRead()
        let job = Task { await model.loadEvidence(item: item, kind: .source) }
        while await host.heldEvidence == nil { await Task.yield() }
        model.closeEvidence(); await host.releaseEvidence(value); await job.value
        XCTAssertNil(model.evidence)
        await model.loadEvidence(item: item, kind: .result)
        XCTAssertNil(model.evidence)
        XCTAssertNotNil(model.evidenceError)
    }

    func testCorruptJournalFailsClosedBeforeAnyMutation() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "open-work-corrupt-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotOpenWorkDraftStore(root: root)
        let scope = AidenBotOpenWorkDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: botID)
        var draft = AidenOpenWorkDraft(); draft.title = "Saved draft"
        try store.save(.init(draft: draft, baseline: nil, draftRevision: "snapshot-1", attempt: nil), scope: scope)
        try Data("corrupt".utf8).write(to: store.fileURL(scope))
        let host = try OpenWorkHost(snapshot())
        let model = AidenBotOpenWorkModel(botID: botID, transport: host, store: store, scope: scope)
        await model.load(); await model.act(.stop, on: try decode(AidenOpenWorkItem.self, itemObject()))
        XCTAssertFalse(model.canWrite)
        let writes = await host.writes
        XCTAssertTrue(writes.isEmpty)
    }

    func testJournalWriteFailurePreventsTransmissionAndKeepsTheDraft() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "open-work-write-failure-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotOpenWorkDraftStore(root: root)
        let scope = AidenBotOpenWorkDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: botID)
        let host = try OpenWorkHost(snapshot())
        let model = AidenBotOpenWorkModel(botID: botID, transport: host, store: store, scope: scope)
        await model.load(); newDraft(model)
        XCTAssertTrue(model.canSave)
        try FileManager.default.removeItem(at: root)
        try Data("not a directory".utf8).write(to: root)
        await model.saveDraft()
        let writes = await host.writes
        XCTAssertTrue(writes.isEmpty)
        XCTAssertFalse(model.canWrite)
        XCTAssertEqual(model.draft?.title, "Review the brief")
    }

    func testOldHostsAndMissingChatVisibilityDoNotOfferManagement() throws {
        func server(_ support: [String]?, _ grants: [String]) throws -> AidenServer {
            var value: [String: Any] = ["protocolVersion": 1, "instanceId": "host-1", "name": "Host", "appVersion": "1",
                "capabilities": grants, "connectionMode": "lan", "serverTime": "2026-11-03T00:00:00Z"]
            if let support { value["serverCapabilities"] = support }
            return try decode(AidenServer.self, value)
        }
        let required = ["bot:read", "chat:read", "bot:open-work"]
        XCTAssertFalse(try server(nil, ["bot:read", "chat:read"]).supportsBotOpenWork)
        XCTAssertFalse(try server(required, ["bot:read", "bot:open-work"]).supportsBotOpenWork)
        XCTAssertFalse(try server(required, ["bot:read", "chat:read"]).supportsBotOpenWork)
        XCTAssertTrue(try server(required, required).supportsBotOpenWork)
        XCTAssertTrue(AidenRemoteCoordinator.capabilitiesAskedForAlone.contains([.botOpenWork]))
        XCTAssertFalse(AidenRemoteCapability.v1Known.contains(.botOpenWork))
    }

    func testNativeEditorKeepsTitleAndRequiresAWaitingReason() async throws {
        let (model, _) = try await setup()
        model.begin(item: try decode(AidenOpenWorkItem.self, itemObject()))
        model.draft?.state = .waiting; model.draft?.waitingReason = ""
        let controller = UIHostingController(rootView: AidenOpenWorkEditorView(model: model))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = controller; window.makeKeyAndVisible(); controller.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(200))
        func descendants(_ view: UIView) -> [UIView] { view.subviews + view.subviews.flatMap(descendants) }
        XCTAssertTrue(descendants(controller.view).contains { ($0 as? UITextField)?.text == "Review the brief" || ($0 as? UITextView)?.text == "Review the brief" })
        XCTAssertFalse(model.canSave)
        model.draft?.waitingReason = "Updated brief"
        XCTAssertTrue(model.canSave)
        window.isHidden = true
    }
}
