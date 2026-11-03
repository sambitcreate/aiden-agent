import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

private actor WatchHost: AidenBotWatchTransport {
    var list: AidenBotWatchList
    var sources: AidenBotWatchSources
    var reads = 0
    var discoveries = 0
    var saves: [(String?, AidenBotWatchSaveRequest)] = []
    var actions: [(String, AidenBotWatchActionRequest)] = []
    var tests: [AidenBotWatchTestRequest] = []
    var saveResults: [Result<AidenBotWatch, Error>] = []
    var actionResult: Result<AidenBotWatch, Error>?
    var runResult: Result<AidenBotWatchRunResult, Error>?
    var removal: AidenBotWatchRemoval?
    var testResult: AidenBotWatchTestResult?
    var readError: Error?
    var heldRead: CheckedContinuation<AidenBotWatchList, Error>?
    var holdNextRead = false
    var holdNextSave = false
    var heldSave: CheckedContinuation<AidenBotWatch, Error>?
    var holdNextAction = false
    var heldAction: CheckedContinuation<AidenBotWatch, Error>?

    init(list: AidenBotWatchList, sources: AidenBotWatchSources) { self.list = list; self.sources = sources }
    func setList(_ value: AidenBotWatchList) { list = value }
    func queueSave(_ value: Result<AidenBotWatch, Error>) { saveResults.append(value) }
    func failReads(_ error: Error?) { readError = error }
    func setAction(_ value: Result<AidenBotWatch, Error>) { actionResult = value }
    func setRun(_ value: Result<AidenBotWatchRunResult, Error>) { runResult = value }
    func setRemoval(_ value: AidenBotWatchRemoval) { removal = value }
    func setTest(_ value: AidenBotWatchTestResult) { testResult = value }
    func holdRead() { holdNextRead = true }
    func holdSave() { holdNextSave = true }
    func holdAction() { holdNextAction = true }
    func releaseAction(_ result: Result<AidenBotWatch, Error>) { heldAction?.resume(with: result); heldAction = nil }
    func releaseSave(_ value: AidenBotWatch) { heldSave?.resume(returning: value); heldSave = nil }
    func releaseRead(_ value: AidenBotWatchList) { heldRead?.resume(returning: value); heldRead = nil }
    func botWatches(botId: String) async throws -> AidenBotWatchList {
        reads += 1
        if holdNextRead {
            holdNextRead = false
            return try await withCheckedThrowingContinuation { heldRead = $0 }
        }
        if let readError { throw readError }
        return list
    }
    func discoverBotWatchSources(botId: String) async throws -> AidenBotWatchSources { discoveries += 1; return sources }
    func saveBotWatch(botId: String, id: String?, request: AidenBotWatchSaveRequest) async throws -> AidenBotWatch {
        saves.append((id, request))
        if holdNextSave {
            holdNextSave = false
            return try await withCheckedThrowingContinuation { heldSave = $0 }
        }
        guard !saveResults.isEmpty else { throw URLError(.networkConnectionLost) }
        return try saveResults.removeFirst().get()
    }
    func setBotWatchEnabled(botId: String, id: String, request: AidenBotWatchActionRequest) async throws -> AidenBotWatch {
        actions.append(("enabled", request))
        if holdNextAction {
            holdNextAction = false
            return try await withCheckedThrowingContinuation { heldAction = $0 }
        }
        guard let actionResult else { throw URLError(.networkConnectionLost) }
        return try actionResult.get()
    }
    func removeBotWatch(botId: String, id: String, request: AidenBotWatchActionRequest) async throws -> AidenBotWatchRemoval {
        actions.append(("delete", request))
        guard let removal else { throw URLError(.networkConnectionLost) }
        return removal
    }
    func testBotWatch(botId: String, request: AidenBotWatchTestRequest) async throws -> AidenBotWatchTestResult {
        tests.append(request)
        guard let testResult else { throw URLError(.networkConnectionLost) }
        return testResult
    }
    func runBotWatch(botId: String, id: String, request: AidenBotWatchActionRequest) async throws -> AidenBotWatchRunResult {
        actions.append(("run", request))
        guard let runResult else { throw URLError(.networkConnectionLost) }
        return try runResult.get()
    }
}

@MainActor
final class AidenBotWatchTests: XCTestCase {
    private let bot = "bot_fixture_01"
    private let watchID = "11111111-1111-4111-8111-111111111111"
    private let sourceID = "22222222-2222-4222-8222-222222222222"

    private func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try AidenRemoteJSONDecoder.decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
    private func watchObject(_ changes: [String: Any] = [:]) -> [String: Any] {
        var value: [String: Any] = ["id": watchID, "botId": bot, "revision": "1", "name": "Important mail",
            "prompt": "Summarize important messages", "templateId": "mail_messages",
            "condition": ["kind": "email", "unreadOnly": false], "everyMinutes": 30,
            "source": ["providerLabel": "Mail", "accountLabel": "Work", "resourceLabel": "Inbox"],
            "enabled": true, "state": "waiting"]
        value.merge(changes) { _, new in new }
        return value
    }
    private var templates: [[String: Any]] { [
        ["id": "mail_messages", "kind": "email", "title": "Mail messages", "description": "Watch messages.",
         "available": true, "intervals": [15, 30, 60]],
        ["id": "calendar_upcoming", "kind": "calendar", "title": "Upcoming calendar events", "description": "Watch events.",
         "available": false, "unavailableReason": "Calendar cannot safely bind an exact account yet.", "intervals": [15, 30, 60]],
    ] }
    private func list(_ rows: [[String: Any]]? = nil) throws -> AidenBotWatchList {
        try decode(AidenBotWatchList.self, ["supported": true, "templates": templates, "watches": rows ?? [watchObject()]])
    }
    private func sources() throws -> AidenBotWatchSources {
        try decode(AidenBotWatchSources.self, ["choices": [["id": sourceID, "templateId": "mail_messages",
            "providerLabel": "Mail", "accountLabel": "Work", "resourceLabel": "Inbox", "available": true]], "unavailableReasons": []])
    }
    private func setup() async throws -> (AidenBotWatchModel, WatchHost) {
        let host = try WatchHost(list: list(), sources: sources())
        let model = AidenBotWatchModel(botID: bot, transport: host)
        await model.load()
        return (model, host)
    }
    private func serverError(_ status: Int, _ code: String) throws -> AidenRemoteClientError {
        .server(statusCode: status, body: try decode(AidenRemoteErrorEnvelope.Body.self,
            ["code": code, "message": "Refused", "requestId": "request_fixture_1", "retryable": false]))
    }
    private func newDraft(_ model: AidenBotWatchModel) async {
        model.begin()
        model.draft?.name = "Mail reminder"
        model.draft?.prompt = "Tell me when mail changes"
        await model.discover()
        model.draft?.sourceChoiceID = sourceID
    }

    func testSharedHostFixtureDecodesEveryWatchResponse() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bot-watches", withExtension: "json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let list = try decode(AidenBotWatchList.self, XCTUnwrap(fixture["list"]))
        let watch = try decode(AidenBotWatch.self, XCTUnwrap(fixture["watch"]))
        XCTAssertEqual(list.watches.first?.id, watch.id)
        XCTAssertEqual(try decode(AidenBotWatchSources.self, XCTUnwrap(fixture["sources"])).choices.first?.templateId, .mailMessages)
        XCTAssertGreaterThanOrEqual(try decode(AidenBotWatchTestResult.self, XCTUnwrap(fixture["test"])).checkedAt, 0)
        XCTAssertTrue(try decode(AidenBotWatchRemoval.self, XCTUnwrap(fixture["removal"])).removed)
        XCTAssertEqual(try decode(AidenBotWatchRunResult.self, XCTUnwrap(fixture["run"])).id, watch.id)
    }

    func testResponsesTolerateAdditiveFieldsButRejectMissingIdentityAndRevision() throws {
        XCTAssertEqual(try decode(AidenBotWatch.self, watchObject(["futureSafeField": true])).name, "Important mail")
        for field in ["id", "botId", "revision", "condition", "enabled"] {
            var value = watchObject(); value.removeValue(forKey: field)
            XCTAssertThrowsError(try decode(AidenBotWatch.self, value), field)
        }
        for changes in [["id": "../../private"], ["revision": ""], ["revision": "01"], ["revision": "deleted:1"],
                        ["state": "done"], ["templateId": "unknown"]] {
            XCTAssertThrowsError(try decode(AidenBotWatch.self, watchObject(changes)))
        }
    }

    func testWatchPrivacyRejectsPrivateFieldsAtAnyDepthWhileAcceptingAuthoredPrompt() throws {
        for changes: [String: Any] in [["toolArguments": ["query": "private"]], ["binding": ["providerFingerprint": "private"]],
                                      ["unknown": ["credential": "private"]], ["source": ["accountId": "private", "args": [:]]]] {
            XCTAssertThrowsError(try decode(AidenBotWatch.self, watchObject(changes)))
        }
        XCTAssertEqual(try decode(AidenBotWatch.self, watchObject()).prompt, "Summarize important messages")
    }

    func testBoundedTypedConditionsAndEpochMillisecondsFailClosed() throws {
        for changes: [String: Any] in [["everyMinutes": 1], ["lastCheckAt": -1], ["lastCheckAt": 1.5],
            ["condition": ["kind": "email"]], ["condition": ["kind": "calendar", "lookAheadMinutes": 60, "timezone": "UTC"]],
            ["condition": ["kind": "email", "unreadOnly": true, "sender": String(repeating: "a", count: 201)]]] {
            XCTAssertThrowsError(try decode(AidenBotWatch.self, watchObject(changes)))
        }
        XCTAssertThrowsError(try decode(AidenBotWatchCondition.self, ["kind": "calendar", "lookAheadMinutes": 1441, "timezone": "UTC"]))
        XCTAssertThrowsError(try list(Array(repeating: watchObject(), count: 2)))
    }

    func testListReadNeverDiscoversSourcesAndCalendarReasonComesFromHost() async throws {
        let (model, host) = try await setup()
        let count = await host.discoveries
        XCTAssertEqual(count, 0)
        XCTAssertEqual(model.list?.templates.last?.unavailableReason, "Calendar cannot safely bind an exact account yet.")
        model.begin(); model.selectTemplate(.calendarUpcoming)
        model.draft?.name = "Events"; model.draft?.prompt = "Tell me about events"
        XCTAssertFalse(model.canSave)
        XCTAssertFalse(model.canTestDraft)
    }

    func testDraftDiscoveryAndTestUseOpaqueSourceAndNeverRunOrSave() async throws {
        let (model, host) = try await setup()
        let result = try decode(AidenBotWatchTestResult.self, ["checkedAt": 1234, "result": "baseline", "itemCount": 1, "changeCount": 0, "preview": ["One message"]])
        await host.setTest(result)
        await newDraft(model)
        model.draft?.sender = "  alex@example.test  "
        XCTAssertTrue(model.canSave)
        await model.testDraft()
        let tests = await host.tests
        XCTAssertEqual(tests, [.draft(sourceChoiceId: sourceID, condition: .email(sender: "alex@example.test", subject: nil, unreadOnly: false))])
        XCTAssertEqual(model.testResult?.preview, ["One message"])
        let saves = await host.saves; let actions = await host.actions
        XCTAssertTrue(saves.isEmpty); XCTAssertTrue(actions.isEmpty)
    }

    func testSavedTestDoesNotSilentlyTestUnboundEditedConditions() async throws {
        let (model, _) = try await setup()
        model.begin(watch: try decode(AidenBotWatch.self, watchObject()))
        XCTAssertTrue(model.canTestDraft)
        model.draft?.subject = "updated"
        XCTAssertFalse(model.canTestDraft)
        await model.discover(); model.draft?.sourceChoiceID = sourceID
        XCTAssertTrue(model.canTestDraft)
    }

    func testConflictKeepsDraftAndRequiresReviewBeforeUsingLatestRevision() async throws {
        let (model, host) = try await setup()
        model.begin(watch: try decode(AidenBotWatch.self, watchObject()))
        model.draft?.prompt = "My unsaved instructions"
        await host.queueSave(.failure(try serverError(409, "revision_conflict")))
        await host.setList(try list([watchObject(["revision": "2", "prompt": "Edited on desktop"])]))
        await model.saveDraft()
        XCTAssertEqual(model.draft?.prompt, "My unsaved instructions")
        XCTAssertEqual(model.conflict?.prompt, "Edited on desktop")
        XCTAssertFalse(model.canSave)
        model.useLatestRevision()
        XCTAssertEqual(model.baseline?.revision, "2")
        XCTAssertEqual(model.draft?.prompt, "My unsaved instructions")
        XCTAssertTrue(model.canSave)
    }

    func testForegroundRefreshUpdatesSavedCheckStateWithoutReplacingDraft() async throws {
        let (model, host) = try await setup()
        model.begin(watch: try decode(AidenBotWatch.self, watchObject()))
        model.draft?.prompt = "Unsaved draft"
        await host.setList(try list([watchObject(["state": "changed", "lastCheckAt": 123456])]))
        await model.load()
        XCTAssertEqual(model.baseline?.state, .changed)
        XCTAssertEqual(model.baseline?.lastCheckAt, 123456)
        XCTAssertEqual(model.draft?.prompt, "Unsaved draft")
        XCTAssertNil(model.conflict)
    }

    func testRemovedWatchKeepsDraftAndRefusesToResurrectIt() async throws {
        let (model, host) = try await setup()
        model.begin(watch: try decode(AidenBotWatch.self, watchObject()))
        model.draft?.name = "Keep this draft"
        await host.setList(try list([])); await model.load()
        XCTAssertTrue(model.wasRemoved)
        XCTAssertEqual(model.draft?.name, "Keep this draft")
        await model.saveDraft()
        let writes = await host.saves
        XCTAssertTrue(writes.isEmpty)
    }

    func testUncertainCreateFreezesSnapshotAndRetriesSameMutationIdentity() async throws {
        let (model, host) = try await setup()
        await host.setList(try list([]))
        await newDraft(model)
        await model.saveDraft()
        XCTAssertTrue(model.uncertain)
        XCTAssertFalse(model.canEditDraft)
        XCTAssertNotNil(model.draft)
        let sent = await host.saves
        let original = try XCTUnwrap(sent.first?.1)
        // Even a programmatic draft change cannot change the replay body.
        model.draft?.prompt = "A different unsent edit"
        await model.retryPending()
        let saves = await host.saves
        XCTAssertEqual(saves.count, 2)
        XCTAssertEqual(saves[1].1, original)
        XCTAssertEqual(model.draft?.prompt, "A different unsent edit")
    }

    func testUncertainCreateReconcilesByMutationIdentityNeverByMatchingText() async throws {
        let (model, host) = try await setup()
        await host.setList(try list([])); await newDraft(model); await model.saveDraft()
        let sent = await host.saves
        let request = try XCTUnwrap(sent.first?.1)
        await host.setList(try list([watchObject(["name": request.name, "prompt": request.prompt])]))
        await model.load()
        XCTAssertTrue(model.uncertain, "Another same-text watch cannot settle the write")
        await host.setList(try list([watchObject(["id": request.mutationId.uuidString, "name": request.name, "prompt": request.prompt])]))
        await model.load()
        XCTAssertFalse(model.uncertain)
        XCTAssertNil(model.draft)
    }

    func testUncertainPauseSettlesFromAuthoritativeRead() async throws {
        let (model, host) = try await setup()
        await host.setList(try list([watchObject(["revision": "2", "enabled": false, "state": "paused"])]))
        await model.setEnabled(try decode(AidenBotWatch.self, watchObject()), false)
        XCTAssertFalse(model.uncertain)
        XCTAssertEqual(model.list?.watches.first?.enabled, false)
    }

    func testRunFalseIsHonestAndUnknownRunNeedsSameKeyReplay() async throws {
        let (model, host) = try await setup()
        let watch = try decode(AidenBotWatch.self, watchObject())
        await host.setRun(.failure(URLError(.networkConnectionLost)))
        await model.run(watch)
        XCTAssertTrue(model.uncertain)
        await host.setRun(.success(try decode(AidenBotWatchRunResult.self, ["id": watchID, "revision": "1", "admitted": false])))
        await model.retryPending()
        let actions = await host.actions
        XCTAssertEqual(actions[0].1.mutationId, actions[1].1.mutationId)
        XCTAssertFalse(model.uncertain)
        XCTAssertTrue(model.message?.contains("not started") == true)
    }

    func testDeniedRetryRetainsUnknownRunAcrossPermissionChangesAndRestart() async throws {
        for (status, code) in [(401, "authentication_required"), (403, "capability_denied"), (404, "not_found"), (409, "revision_conflict")] {
            let root = FileManager.default.temporaryDirectory.appending(path: "watch-denied-replay-\(UUID())")
            defer { try? FileManager.default.removeItem(at: root) }
            let store = AidenBotWatchDraftStore(root: root)
            let scope = AidenBotWatchDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: bot)
            let host = try WatchHost(list: list(), sources: sources())
            var hasWrite = true
            let model = AidenBotWatchModel(botID: bot, transport: host, mayWrite: { hasWrite }, draftStore: store, draftScope: scope)
            await model.load()
            let watch = try decode(AidenBotWatch.self, watchObject())
            // The host may have admitted Run before the reply disappeared.
            await host.setRun(.failure(URLError(.networkConnectionLost)))
            await model.run(watch)
            let original = try XCTUnwrap(try store.load(scope))
            XCTAssertTrue(model.uncertain)
            await host.setRun(.failure(try serverError(status, code)))
            await model.retryPending()
            XCTAssertTrue(model.uncertain, "A \(status) on a retry cannot settle the earlier Run")
            XCTAssertEqual(try store.load(scope)?.pending, original.pending)
            XCTAssertEqual(try store.load(scope)?.pendingSince, original.pendingSince)
            // A current coordinator permission update retains the owned pairing’s attempt.
            hasWrite = false
            let restored = AidenBotWatchModel(botID: bot, transport: host, mayWrite: { hasWrite }, draftStore: store, draftScope: scope)
            await restored.load()
            XCTAssertTrue(restored.uncertain)
            await restored.run(watch)
            hasWrite = true
            XCTAssertTrue(restored.canWrite, "Restoring a pending request must not block its same-key replay")
            await restored.run(watch)
            let beforeSettlement = await host.actions
            XCTAssertEqual(beforeSettlement.count, 2, "Neither permission restoration nor a new Run bypasses uncertainty")
            await host.setRun(.success(try decode(AidenBotWatchRunResult.self, ["id": watchID, "revision": "2", "admitted": true])))
            await restored.retryPending()
            let settled = await host.actions
            XCTAssertEqual(settled.count, 3)
            XCTAssertEqual(Set(settled.map { $0.1.mutationId }).count, 1)
            XCTAssertEqual(settled.map { $0.1.expectedRevision }, ["1", "1", "1"])
            XCTAssertFalse(restored.uncertain)
            XCTAssertNil(try store.load(scope))
        }
    }

    func testAuthoritativeSettlementWinsOverALateDeniedRetry() async throws {
        let (model, host) = try await setup()
        let watch = try decode(AidenBotWatch.self, watchObject())
        await model.setEnabled(watch, false)
        XCTAssertTrue(model.uncertain)
        await host.holdAction()
        let retry = Task { await model.retryPending() }
        while await host.heldAction == nil { await Task.yield() }
        await host.setList(try list([watchObject(["revision": "2", "enabled": false, "state": "paused"])]))
        await model.load()
        XCTAssertFalse(model.uncertain, "The host confirmed the intended saved state")
        await host.releaseAction(.failure(try serverError(403, "capability_denied")))
        await retry.value
        XCTAssertFalse(model.uncertain, "A late denial cannot undo authoritative settlement")
        XCTAssertEqual(model.list?.watches.first?.enabled, false)
        XCTAssertTrue(model.canWrite)
        await model.retryPending()
        let actions = await host.actions
        XCTAssertEqual(actions.count, 2, "A settled request has no remaining replay obligation")
    }

    func testFirstAttemptDefinitiveDenialDoesNotCreateAnUnknownRun() async throws {
        let (model, host) = try await setup()
        let watch = try decode(AidenBotWatch.self, watchObject())
        await host.setRun(.failure(try serverError(403, "capability_denied")))
        await model.run(watch)
        XCTAssertFalse(model.uncertain)
        await host.setRun(.success(try decode(AidenBotWatchRunResult.self, ["id": watchID, "revision": "2", "admitted": true])))
        await model.run(watch)
        let actions = await host.actions
        XCTAssertEqual(actions.count, 2)
        XCTAssertNotEqual(actions[0].1.mutationId, actions[1].1.mutationId)
        XCTAssertFalse(model.uncertain)
    }

    func testPauseResumeDeleteCarrySavedRevisionAndRefreshHostState() async throws {
        let (model, host) = try await setup()
        let watch = try decode(AidenBotWatch.self, watchObject())
        let paused = try decode(AidenBotWatch.self, watchObject(["revision": "2", "enabled": false, "state": "paused"]))
        await host.setAction(.success(paused)); await host.setList(try list([watchObject(["revision": "2", "enabled": false, "state": "paused"])]))
        await model.setEnabled(watch, false)
        await host.setAction(.success(try decode(AidenBotWatch.self, watchObject(["revision": "3"]))))
        await model.setEnabled(paused, true)
        await host.setRemoval(try decode(AidenBotWatchRemoval.self, ["id": watchID, "revision": "deleted:3", "removed": true]))
        await host.setList(try list([])); await model.remove(try decode(AidenBotWatch.self, watchObject(["revision": "3"])))
        let actions = await host.actions
        XCTAssertEqual(actions.map { $0.1.expectedRevision }, ["1", "2", "3"])
        XCTAssertEqual(actions.prefix(2).map { $0.1.enabled }, [false, true])
        XCTAssertTrue(model.list?.watches.isEmpty == true)
    }

    func testReadOnlyOrLostPairingCannotDispatchMutationsAndLateReadIsIgnored() async throws {
        let host = try WatchHost(list: list(), sources: sources())
        var current = true
        var write = true
        let model = AidenBotWatchModel(botID: bot, transport: host, isCurrent: { current }, mayWrite: { write })
        await model.load(); await newDraft(model)
        write = false
        XCTAssertFalse(model.canSave)
        await model.saveDraft(); await model.discover()
        XCTAssertEqual(model.draft?.name, "Mail reminder")
        write = true
        await host.holdRead()
        let read = Task { await model.load() }
        while await host.heldRead == nil { await Task.yield() }
        current = false
        await host.releaseRead(try list([])); await read.value
        XCTAssertEqual(model.list?.watches.count, 1)
        await model.run(try decode(AidenBotWatch.self, watchObject()))
        let saves = await host.saves; let actions = await host.actions
        XCTAssertTrue(saves.isEmpty); XCTAssertTrue(actions.isEmpty)
    }

    func testOldHostAndUngrantedCapabilityHideWatchManagement() throws {
        func server(support: [String]?, grants: [String]) throws -> AidenServer {
            var value: [String: Any] = ["protocolVersion": 1, "instanceId": "host-1", "name": "Host", "appVersion": "1",
                "capabilities": grants, "connectionMode": "lan", "serverTime": "2026-11-03T00:00:00Z"]
            if let support { value["serverCapabilities"] = support }
            return try decode(AidenServer.self, value)
        }
        XCTAssertFalse(try server(support: nil, grants: ["bot:read"]).supportsBotWatches)
        XCTAssertFalse(try server(support: ["bot:read", "bot:watches"], grants: ["bot:read"]).supportsBotWatches)
        XCTAssertFalse(try server(support: ["bot:read", "bot:watches"], grants: ["bot:watches"]).supportsBotWatches)
        XCTAssertTrue(try server(support: ["bot:read", "bot:watches"], grants: ["bot:read", "bot:watches"]).supportsBotWatches)
        XCTAssertTrue(AidenRemoteCoordinator.capabilitiesAskedForAlone.contains([.botWatches]))
    }

    func testUTF16BoundsMatchHostAndRepairReasonsStayBounded() throws {
        XCTAssertThrowsError(try decode(AidenBotWatch.self, watchObject(["name": String(repeating: "😀", count: 61)])))
        XCTAssertThrowsError(try decode(AidenBotWatchCondition.self, ["kind": "email", "unreadOnly": false, "subject": String(repeating: "😀", count: 101)]))
        XCTAssertThrowsError(try decode(AidenBotWatchSources.self, ["choices": [], "unavailableReasons": Array(repeating: "Unavailable", count: 17)]))
        XCTAssertThrowsError(try decode(AidenBotWatchSources.self, ["choices": [], "unavailableReasons": [String(repeating: "😀", count: 101)]]))
    }

    func testProtectedStoreRestoresFrozenAttemptAndScopesItToPairing() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "watch-retention-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotWatchDraftStore(root: root)
        let scope = AidenBotWatchDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: bot)
        let host = try WatchHost(list: list([]), sources: sources())
        let original = AidenBotWatchModel(botID: bot, transport: host, draftStore: store, draftScope: scope)
        await original.load(); await newDraft(original); await original.saveDraft()
        let sent = await host.saves
        let first = try XCTUnwrap(sent.first?.1)
        let restored = AidenBotWatchModel(botID: bot, transport: host, draftStore: store, draftScope: scope)
        XCTAssertTrue(restored.uncertain)
        XCTAssertEqual(restored.draft?.name, "Mail reminder")
        await restored.load(); await restored.retryPending()
        let replayed = await host.saves
        XCTAssertEqual(replayed.count, 2, "The restored request must actually reach the host")
        XCTAssertEqual(replayed.last?.1, first)
        XCTAssertNil(try store.load(.init(instanceID: "host-1", deviceID: "phone-2", botID: bot)))
        XCTAssertEqual(try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        let onDisk = store.fileURL(scope)
        XCTAssertFalse(onDisk.lastPathComponent.contains(bot))
        store.purge(instanceID: "host-1")
        XCTAssertNil(try store.load(scope))
    }

    func testLateMutationCannotResurrectAPurgedPairingOrReplaceItsDraft() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "watch-late-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotWatchDraftStore(root: root)
        let scope = AidenBotWatchDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: bot)
        let host = try WatchHost(list: list([]), sources: sources())
        var current = true
        let model = AidenBotWatchModel(botID: bot, transport: host, isCurrent: { current }, draftStore: store, draftScope: scope)
        await model.load(); await newDraft(model); await host.holdSave()
        let job = Task { await model.saveDraft() }
        while await host.heldSave == nil { await Task.yield() }
        current = false
        store.purge(instanceID: "host-1")
        await host.releaseSave(try decode(AidenBotWatch.self, watchObject()))
        await job.value
        XCTAssertEqual(model.draft?.name, "Mail reminder")
        XCTAssertNil(try store.load(scope))
        XCTAssertFalse(model.canWrite)
    }

    func testAnotherControllerCannotReplaceAnUnresolvedAttempt() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "watch-concurrent-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotWatchDraftStore(root: root)
        let scope = AidenBotWatchDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: bot)
        let host = try WatchHost(list: list([]), sources: sources())
        let first = AidenBotWatchModel(botID: bot, transport: host, draftStore: store, draftScope: scope)
        let second = AidenBotWatchModel(botID: bot, transport: host, draftStore: store, draftScope: scope)
        await first.load(); await second.load()
        await newDraft(first); await first.saveDraft()
        let before = try XCTUnwrap(try store.load(scope)?.pending)
        second.begin(); second.draft?.name = "Another draft"
        XCTAssertFalse(second.canWrite)
        XCTAssertEqual(try store.load(scope)?.pending, before)
        await second.saveDraft()
        let requests = await host.saves
        XCTAssertEqual(requests.count, 1)
    }

    func testRetainedAttemptReconcilesAfterRestartAndOnlyThenClearsDraft() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "watch-reconcile-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotWatchDraftStore(root: root)
        let scope = AidenBotWatchDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: bot)
        let host = try WatchHost(list: list([]), sources: sources())
        let model = AidenBotWatchModel(botID: bot, transport: host, draftStore: store, draftScope: scope)
        await model.load(); await newDraft(model); await model.saveDraft()
        let sent = await host.saves
        let request = try XCTUnwrap(sent.first?.1)
        await host.setList(try list([watchObject(["id": request.mutationId.uuidString])]))
        let restored = AidenBotWatchModel(botID: bot, transport: host, draftStore: store, draftScope: scope)
        await restored.load()
        XCTAssertFalse(restored.uncertain)
        XCTAssertNil(restored.draft)
        XCTAssertNil(try store.load(scope))
    }

    func testExpiredAttemptCannotBeReissuedAsANewRun() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "watch-expired-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotWatchDraftStore(root: root)
        let scope = AidenBotWatchDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: bot)
        try store.save(.init(draft: nil, baseline: nil,
            pending: .run(id: watchID, request: .init(expectedRevision: "1", mutationId: UUID())),
            pendingSince: Date().addingTimeInterval(-25 * 3600)), scope: scope)
        let host = try WatchHost(list: list(), sources: sources())
        let model = AidenBotWatchModel(botID: bot, transport: host, draftStore: store, draftScope: scope)
        await model.load(); await model.retryPending(); await model.run(try decode(AidenBotWatch.self, watchObject()))
        let actions = await host.actions
        XCTAssertTrue(actions.isEmpty)
        XCTAssertTrue(model.uncertain)
        XCTAssertTrue(model.message?.contains("Inspect") == true)
    }

    func testCorruptRetentionFailsClosedInsteadOfMintingAnotherMutation() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "watch-corrupt-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenBotWatchDraftStore(root: root)
        let scope = AidenBotWatchDraftStore.Scope(instanceID: "host-1", deviceID: "phone-1", botID: bot)
        var draft = AidenBotWatchDraft(); draft.name = "Keep me"
        try store.save(.init(draft: draft, baseline: nil, pending: nil, pendingSince: nil), scope: scope)
        try Data("corrupt".utf8).write(to: store.fileURL(scope))
        let host = try WatchHost(list: list(), sources: sources())
        let model = AidenBotWatchModel(botID: bot, transport: host, draftStore: store, draftScope: scope)
        await model.load(); await model.run(try decode(AidenBotWatch.self, watchObject()))
        XCTAssertFalse(model.canWrite)
        let actions = await host.actions
        XCTAssertTrue(actions.isEmpty)
    }

    func testNativeEditorMountsWithAccessibleFieldsAndKeepsDraftAcrossReconnectState() async throws {
        let (model, _) = try await setup()
        model.begin(); model.draft?.name = "Preserved name"
        let controller = UIHostingController(rootView: AidenBotWatchEditorView(model: model))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = controller; window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(200))
        func descendants(_ view: UIView) -> [UIView] { view.subviews + view.subviews.flatMap(descendants) }
        XCTAssertTrue(descendants(controller.view).contains { ($0 as? UITextField)?.text == "Preserved name" })
        XCTAssertEqual(model.draft?.name, "Preserved name")
        XCTAssertFalse(model.canSave, "A native form without a source and prompt cannot send")
        window.isHidden = true
    }
}
