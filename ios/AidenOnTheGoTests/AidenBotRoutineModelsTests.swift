import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

private actor RoutineModelsHost: AidenBotRoutineModelsTransport, AidenBotResumeTransport {
    var settings: AidenRoutineModelSettings
    var catalog: AidenRoutineModelCatalog
    var runs: [AidenRoutineModelRun] = []
    var saves: [AidenRoutineModelSave] = []
    var replies: [Result<AidenRoutineModelResult, Error>] = []
    var status = false
    var interruptedSubmissionId = "9007199254740993"
    var costReceiptId = "cost_" + String(repeating: "a", count: 64)
    var enforceCurrentCostReceipt = false
    var acknowledgedReceipts: [String] = []
    var settledResumeReceipts: [UUID: AidenBotSessionStateView] = [:]
    func settleResume(_ key: UUID, _ view: AidenBotSessionStateView) { settledResumeReceipts[key] = view }
    func enforceReceiptCAS() { enforceCurrentCostReceipt = true }
    var statusReads = 0
    var catalogReads = 0
    var resumes: [(UUID, Bool, String?, String?)] = []
    var resumeReplies: [Result<AidenBotSessionStateView, Error>] = []
    var holdResume = false
    var heldResume: CheckedContinuation<AidenBotSessionStateView, Error>?
    func holdResumeWrite() { holdResume = true }
    func releaseResumeWrite(_ view: AidenBotSessionStateView) { heldResume?.resume(returning: view); heldResume = nil }
    var holdStatus = false
    var heldStatus: CheckedContinuation<AidenBotResumeStatus, Error>?
    func holdStatusRead() { holdStatus = true }
    func releaseStatusRead() throws { heldStatus?.resume(returning: try statusValue()); heldStatus = nil }
    private func statusValue() throws -> AidenBotResumeStatus {
        var object: [String: Any] = ["requiresUnknownCostAcknowledgement": status]
        if status { object["interruptedSubmissionId"] = interruptedSubmissionId; object["costReceiptId"] = costReceiptId }
        return try JSONDecoder().decode(AidenBotResumeStatus.self, from: JSONSerialization.data(withJSONObject: object))
    }
    var holdSave = false
    var held: CheckedContinuation<AidenRoutineModelResult, Error>?
    init(settings: AidenRoutineModelSettings, catalog: AidenRoutineModelCatalog) { self.settings = settings; self.catalog = catalog }
    func set(_ settings: AidenRoutineModelSettings) { self.settings = settings }
    func setCatalog(_ catalog: AidenRoutineModelCatalog) { self.catalog = catalog }
    func queue(_ reply: Result<AidenRoutineModelResult, Error>) { replies.append(reply) }
    func queueResume(_ reply: Result<AidenBotSessionStateView, Error>) { resumeReplies.append(reply) }
    func setStatus(_ value: Bool, submissionId: String = "9007199254740993", receiptId: String = "cost_" + String(repeating: "a", count: 64)) { status = value; interruptedSubmissionId = submissionId; costReceiptId = receiptId }
    func hold() { holdSave = true }
    func release(_ reply: AidenRoutineModelResult) { held?.resume(returning: reply); held = nil }
    func routineModelSettings(botId: String, routineId: String) async throws -> AidenRoutineModelSettings { settings }
    func routineModelCatalog(botId: String, routineId: String) async throws -> AidenRoutineModelCatalog { catalogReads += 1; return catalog }
    func routineModelRuns(botId: String, routineId: String) async throws -> [AidenRoutineModelRun] { runs }
    func saveRoutineModel(_ request: AidenRoutineModelSave) async throws -> AidenRoutineModelResult {
        saves.append(request)
        if holdSave { holdSave = false; return try await withCheckedThrowingContinuation { held = $0 } }
        guard !replies.isEmpty else { throw URLError(.networkConnectionLost) }
        return try replies.removeFirst().get()
    }
    func botRoutineResumeStatus(botId: String) async throws -> AidenBotResumeStatus {
        statusReads += 1
        if holdStatus { holdStatus = false; return try await withCheckedThrowingContinuation { heldStatus = $0 } }
        return try statusValue()
    }
    func resumeBotSession(botId: String, idempotencyKey: UUID, acknowledgeUnknownCost: Bool, expectedSubmissionId: String?, expectedCostReceiptId: String?) async throws -> AidenBotSessionStateView {
        resumes.append((idempotencyKey, acknowledgeUnknownCost, expectedSubmissionId, expectedCostReceiptId))
        if let settled = settledResumeReceipts[idempotencyKey] { return settled }
        if enforceCurrentCostReceipt, acknowledgeUnknownCost {
            guard expectedCostReceiptId == costReceiptId else {
                throw AidenRemoteClientError.server(statusCode: 409, body: try JSONDecoder().decode(AidenRemoteErrorEnvelope.Body.self,
                    from: Data(#"{"code":"invalid_request","message":"The unconfirmed cost changed.","requestId":"cost-cas","retryable":false}"#.utf8)))
            }
            acknowledgedReceipts.append(costReceiptId)
        }
        if holdResume { holdResume = false; return try await withCheckedThrowingContinuation { heldResume = $0 } }
        guard !resumeReplies.isEmpty else { throw URLError(.networkConnectionLost) }
        return try resumeReplies.removeFirst().get()
    }
}

@MainActor
final class AidenBotRoutineModelsTests: XCTestCase {
    private func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) { XCTAssertEqual(actual, expected, message, file: file, line: line) }
    private func expectNil<T>(_ actual: T?, file: StaticString = #filePath, line: UInt = #line) { XCTAssertNil(actual, file: file, line: line) }
    private func expectNotNil<T>(_ actual: T?, file: StaticString = #filePath, line: UInt = #line) { XCTAssertNotNil(actual, file: file, line: line) }
    private func fixture() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bot-routine-models", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    private func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T { try AidenRemoteJSONDecoder.decode(type, from: JSONSerialization.data(withJSONObject: value)) }
    private func settings(_ revision: String = "model_settings_1", selection: AidenRoutineModelSelection = .inherit, nonce: UUID? = nil) throws -> AidenRoutineModelSettings {
        var object = try XCTUnwrap(fixture()["inherit"] as? [String: Any]); object["revision"] = revision; object.removeValue(forKey: "lastMutationId")
        object["selection"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(selection))
        if let nonce { object["lastMutationId"] = nonce.uuidString }
        return try decode(AidenRoutineModelSettings.self, object)
    }
    private func host() throws -> RoutineModelsHost { try RoutineModelsHost(settings: settings(), catalog: decode(AidenRoutineModelCatalog.self, XCTUnwrap(fixture()["catalog"]))) }
    private let choice = AidenRoutineModelChoice(providerId: "provider_1", modelId: "model_a", thinkingLevel: .high)
    private let fallback = AidenRoutineModelChoice(providerId: "provider_2", modelId: "model_b", thinkingLevel: .off)
    private func model(_ host: RoutineModelsHost, store: AidenBotRoutineControlStore? = nil) -> AidenBotRoutineModelsModel {
        AidenBotRoutineModelsModel(botID: "bot_model", routineID: "routine_model", transport: host, store: store,
            scope: .init(instanceID: "host", deviceID: "phone", botID: "bot_model", routineID: "routine_model"))
    }
    private func serverError(_ status: Int, code: String? = nil) throws -> AidenRemoteClientError {
        .server(statusCode: status, body: try decode(AidenRemoteErrorEnvelope.Body.self, ["code": code ?? (status == 403 ? "capability_denied" : "not_found"), "message": "Refused", "requestId": "request-1", "retryable": false]))
    }
    private func store() -> AidenBotRoutineControlStore { AidenBotRoutineControlStore(root: FileManager.default.temporaryDirectory.appending(path: "routine-model-test-\(UUID())")) }

    func testNormativeRevision56FixturesDecodeFullModelContractAndLargeSubmission() throws {
        let f = try fixture(); XCTAssertEqual(f["contractRevision"] as? Int, 59)
        let directory = try decode(AidenRoutineModelDirectory.self, XCTUnwrap(f["directory"]))
        XCTAssertEqual(directory.routines.map(\.kind), [.scheduled, .event, .watch])
        let saved = try decode(AidenRoutineModelSettings.self, XCTUnwrap(f["settings"]))
        XCTAssertEqual(saved.selection.primary?.thinkingLevel, .high)
        XCTAssertEqual(saved.selection.fallback?.modelId, "model_b")
        let catalog = try decode(AidenRoutineModelCatalog.self, XCTUnwrap(f["catalog"]))
        XCTAssertEqual(catalog.providers.first?.models.first?.thinkingLevels, [.low, .high])
        let save = try decode(AidenRoutineModelSave.self, XCTUnwrap(f["save"])); try save.validate()
        XCTAssertEqual(save.catalogRevision, "catalog_1")
        guard case .accepted = try decode(AidenRoutineModelResult.self, XCTUnwrap(f["result"])) else { return XCTFail("Accepted") }
        guard case .rejected(.conflict, _) = try decode(AidenRoutineModelResult.self, XCTUnwrap(f["conflict"])) else { return XCTFail("Conflict") }
        let runs = try decode([AidenRoutineModelRun].self, XCTUnwrap(f["runs"]))
        XCTAssertEqual(runs.first?.submissionId, "9007199254740993")
        XCTAssertEqual(runs.first?.model.actual.modelId, "model_b")
        XCTAssertEqual(runs.first?.model.fallbackReason, .modelUnavailable)
        XCTAssertTrue(try decode(AidenBotResumeStatus.self, XCTUnwrap(f["resumeStatus"])).requiresUnknownCostAcknowledgement)
        XCTAssertEqual(try decode(AidenBotResumeStatus.self, XCTUnwrap(f["resumeStatus"])).costReceiptId, "cost_" + String(repeating: "a", count: 64))
    }
    func testStrictPartialAndPrivatePayloadsFailClosed() throws {
        let f = try fixture()
        for field in ["botId", "routineId", "revision", "selection", "updatedAt"] {
            var row = try XCTUnwrap(f["settings"] as? [String: Any]); row.removeValue(forKey: field)
            XCTAssertThrowsError(try decode(AidenRoutineModelSettings.self, row))
        }
        var row = try XCTUnwrap(f["settings"] as? [String: Any]); row["credential"] = "forbidden"
        XCTAssertThrowsError(try decode(AidenRoutineModelSettings.self, row))
        for selection: [String: Any] in [["mode": "inherit", "primary": ["providerId": "provider", "modelId": "m", "thinkingLevel": "high"]], ["mode": "selected"], ["mode": "selected", "primary": ["providerId": "p", "modelId": "m", "thinkingLevel": "invented"]]] {
            XCTAssertThrowsError(try decode(AidenRoutineModelSelection.self, selection))
        }
        var save = try XCTUnwrap(f["save"] as? [String: Any]); save["providerSecret"] = "private"
        XCTAssertThrowsError(try decode(AidenRoutineModelSave.self, save))
        var partial = try XCTUnwrap(f["settings"] as? [String: Any]); partial["lastMutationId"] = NSNull()
        XCTAssertThrowsError(try decode(AidenRoutineModelSettings.self, partial))
        XCTAssertThrowsError(try decode(AidenRoutineModelSelection.self, ["mode": "selected", "primary": ["providerId": "p", "modelId": "m", "thinkingLevel": "high"], "fallback": NSNull()]))
        XCTAssertThrowsError(try decode(AidenBotResumeStatus.self, ["requiresUnknownCostAcknowledgement": true]))
        XCTAssertThrowsError(try decode(AidenBotResumeStatus.self, ["requiresUnknownCostAcknowledgement": true, "interruptedSubmissionId": 9007199254740993 as Int64]))
        XCTAssertThrowsError(try decode(AidenBotResumeStatus.self, ["requiresUnknownCostAcknowledgement": true, "interruptedSubmissionId": "01"]))
        XCTAssertThrowsError(try decode(AidenBotResumeStatus.self, [:]))
        XCTAssertThrowsError(try decode(AidenBotResumeStatus.self, ["requiresUnknownCostAcknowledgement": true, "extra": true]))
    }
    func testResumeReceiptIdentityIsRequiredForCostAndForbiddenForOrdinaryStatus() throws {
        let token = "cost_" + String(repeating: "a", count: 64)
        let base: [String: Any] = ["requiresUnknownCostAcknowledgement": true, "interruptedSubmissionId": "9007199254740993"]
        XCTAssertThrowsError(try decode(AidenBotResumeStatus.self, base))
        for malformed: Any in [NSNull(), "", "cost_" + String(repeating: "A", count: 64), "cost_" + String(repeating: "g", count: 64), "cost_" + String(repeating: "a", count: 63), "other_" + String(repeating: "a", count: 64), 42] {
            var row = base; row["costReceiptId"] = malformed
            XCTAssertThrowsError(try decode(AidenBotResumeStatus.self, row))
        }
        XCTAssertThrowsError(try decode(AidenBotResumeStatus.self, ["requiresUnknownCostAcknowledgement": false, "costReceiptId": token]))
        XCTAssertThrowsError(try decode(AidenBotResumeStatus.self, ["requiresUnknownCostAcknowledgement": false, "costReceiptId": NSNull()]))
        var valid = base; valid["costReceiptId"] = token
        XCTAssertEqual(try decode(AidenBotResumeStatus.self, valid).costReceiptId, token)
        XCTAssertNil(try decode(AidenBotResumeStatus.self, ["requiresUnknownCostAcknowledgement": false]).costReceiptId)
        XCTAssertThrowsError(try JSONEncoder().encode(AidenBotResumeRequest(acknowledgeUnknownCost: true, expectedSubmissionId: "1")))
        XCTAssertThrowsError(try JSONEncoder().encode(AidenBotResumeRequest(acknowledgeUnknownCost: true, expectedSubmissionId: "1", expectedCostReceiptId: "cost_" + String(repeating: "A", count: 64))))
        XCTAssertThrowsError(try JSONEncoder().encode(AidenBotResumeRequest(acknowledgeUnknownCost: false, expectedCostReceiptId: token)))
    }

    func testIdentityTimestampAndUnicodeBoundsDoNotNormalizeOrTruncate() throws {
        for identity in ["../other", "a/b", "é", String(repeating: "a", count: 161)] { XCTAssertThrowsError(try AidenRoutineModelWire.id(identity)) }
        try AidenRoutineModelWire.label(String(repeating: "😀", count: 160))
        XCTAssertThrowsError(try AidenRoutineModelWire.label(String(repeating: "😀", count: 161)))
        XCTAssertThrowsError(try AidenRoutineModelWire.label("a\0b"))
        var row = try XCTUnwrap(fixture()["settings"] as? [String: Any]); row["updatedAt"] = 9007199254740992 as Int64
        XCTAssertThrowsError(try decode(AidenRoutineModelSettings.self, row))
        let raw = Data(#"{"providerId":"p","modelId":"\ud83d","thinkingLevel":"high"}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenRoutineModelChoice.self, from: raw))
    }
    func testCatalogRejectsDuplicateModelsUnsupportedThinkingAndCapacityOverflow() throws {
        var catalog = try XCTUnwrap(fixture()["catalog"] as? [String: Any])
        var providers = try XCTUnwrap(catalog["providers"] as? [[String: Any]])
        let options = try XCTUnwrap(providers[0]["models"] as? [[String: Any]])
        providers[0]["models"] = [options[0], options[0]]; catalog["providers"] = providers
        XCTAssertThrowsError(try decode(AidenRoutineModelCatalog.self, catalog))
        var option = options[0]; option["thinkingLevels"] = ["high", "high"]
        providers[0]["models"] = [option]; catalog["providers"] = providers
        XCTAssertThrowsError(try decode(AidenRoutineModelCatalog.self, catalog))
        providers[0]["models"] = options; catalog["providers"] = (0..<65).map { i in var p = providers[0]; p["id"] = "p\(i)"; return p }
        XCTAssertThrowsError(try decode(AidenRoutineModelCatalog.self, catalog))
    }
    func testRunTimeRequiresTimezoneAndExactDecimalIdentity() throws {
        var row = try XCTUnwrap((fixture()["runs"] as? [[String: Any]])?.first)
        row.removeValue(forKey: "timezone"); XCTAssertThrowsError(try decode(AidenRoutineModelRun.self, row))
        row["timezone"] = "Bad/Zone"; XCTAssertThrowsError(try decode(AidenRoutineModelRun.self, row))
        row["timezone"] = "UTC"; row["submissionId"] = 9007199254740993 as Int64
        XCTAssertThrowsError(try decode(AidenRoutineModelRun.self, row))
    }
    func testExplicitPrimaryThinkingAndFallbackThenClearToInherit() async throws {
        let h = try host(); let m = model(h); await m.load()
        XCTAssertEqual(m.draft, .inherit); XCTAssertFalse(m.canSave)
        m.select(choice, fallback: false); m.select(fallback, fallback: true)
        XCTAssertEqual(m.draft?.fallback, fallback); XCTAssertTrue(m.canSave)
        m.clearFallback(); XCTAssertNil(m.draft?.fallback)
        m.inherit(); XCTAssertEqual(m.draft, .inherit)
        expectEqual(await h.saves.count, 0, "Draft choices do not mutate the routine or run a model")
    }
    func testFullSavedPrimaryFallbackThinkingAndClearJourney() async throws {
        let h = try host(); let m = model(h); await m.load()
        func accept(_ revision: String, selection: AidenRoutineModelSelection) async throws {
            await h.hold(); let task = Task { await m.save() }
            while m.pending == nil { await Task.yield() }
            let request = try XCTUnwrap(m.pending?.request)
            // Wait for actual host admission before releasing the explicit receipt.
            while await h.held == nil { await Task.yield() }
            await h.release(.accepted(settings: try settings(revision, selection: selection, nonce: request.mutationId), mutationId: request.mutationId, replayed: false))
            await task.value
            XCTAssertNil(m.pending); XCTAssertEqual(m.settings?.selection, selection)
        }
        m.select(choice, fallback: false); m.select(fallback, fallback: true)
        try await accept("saved2", selection: .selected(primary: choice, fallback: fallback))
        let low = AidenRoutineModelChoice(providerId: "provider_1", modelId: "model_a", thinkingLevel: .low)
        m.select(low, fallback: false); m.clearFallback()
        try await accept("saved3", selection: .selected(primary: low, fallback: nil))
        m.inherit(); try await accept("saved4", selection: .inherit)
        let writes = await h.saves
        XCTAssertEqual(writes.map(\.expectedRevision), ["model_settings_1", "saved2", "saved3"])
        XCTAssertEqual(writes[0].selection.fallback, fallback)
        XCTAssertEqual(writes[1].selection.primary?.thinkingLevel, .low)
        XCTAssertEqual(writes[2].selection, .inherit)
    }
    func testModelDirectoryCoversScheduledGenericEventAndConnectorWatchWithoutConfiguration() throws {
        let directory = try decode(AidenRoutineModelDirectory.self, ["botId": "bot_model", "routines": [
            ["id": "scheduled.one", "name": "Brief", "kind": "scheduled"],
            ["id": "event.one", "name": "Script signal", "kind": "event"],
            ["id": "watch.one", "name": "New mail", "kind": "watch"]]])
        XCTAssertEqual(directory.routines.map(\.kind), [.scheduled, .event, .watch])
        XCTAssertEqual(directory.routines.map(\.id), ["scheduled.one", "event.one", "watch.one"])
        XCTAssertThrowsError(try decode(AidenRoutineModelDirectory.self, ["botId": "bot_model", "routines": [["id": "e", "name": "Event", "kind": "event", "script": "private"]]]))
    }
    func testJournalAlreadyContainsExactSaveBeforeHostReceivesIt() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let h = try host(); let m = model(h, store: s); await m.load(); m.select(choice, fallback: false)
        await h.hold(); let task = Task { await m.save() }
        while await h.saves.isEmpty { await Task.yield() }
        let stored = try s.load(.init(instanceID: "host", deviceID: "phone", botID: "bot_model", routineID: "routine_model"))
        let nonce = try XCTUnwrap(stored?.attempt?.request.mutationId)
        XCTAssertEqual(stored?.attempt?.request.selection.primary, choice)
        let admitted = await h.saves.first
        XCTAssertEqual(stored?.attempt?.request, admitted)
        await h.release(.accepted(settings: try settings("done", selection: .selected(primary: choice, fallback: nil), nonce: nonce), mutationId: nonce, replayed: false)); await task.value
        XCTAssertNil(m.pending); XCTAssertTrue(m.canEdit)
    }
    func testWriteFailureBeforeTransportKeepsDraftAndSendsNothing() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let h = try host(); let m = model(h, store: s); await m.load(); m.select(choice, fallback: false)
        try FileManager.default.removeItem(at: s.root)
        try Data("not a directory".utf8).write(to: s.root)
        await m.save(); expectEqual(await h.saves.count, 0); XCTAssertEqual(m.draft?.primary, choice); XCTAssertFalse(m.canSave)
    }
    func testNativeCapabilityFallbackRequiresBothReadGrantsAndIsNeverPairingGrant() throws {
        XCTAssertFalse(AidenRemoteCapability.v1Known.contains(.botRoutineModels))
        XCTAssertTrue(AidenRemoteCapability.phoneNegotiable.contains(.botRoutineModels))
        XCTAssertTrue(AidenRemoteCoordinator.capabilitiesAskedForAlone.contains([.botRoutineModels]))
        func server(_ caps: [String], offered: [String]) throws -> AidenServer {
            try decode(AidenServer.self, ["protocolVersion": 1, "instanceId": "host", "name": "Host", "appVersion": "1", "capabilities": caps, "serverCapabilities": offered, "connectionMode": "lan", "serverTime": "2026-11-03T00:00:00Z"])
        }
        let all = ["bot:read", "chat:read", "bot:routine-models"]
        XCTAssertTrue(try server(all, offered: all).supportsBotRoutineModels)
        XCTAssertFalse(try server(["bot:read", "bot:routine-models"], offered: all).supportsBotRoutineModels)
        XCTAssertFalse(try server(["bot:read", "chat:read"], offered: ["bot:read", "chat:read"]).supportsBotRoutineModels)
    }

    func testUnavailableSavedChoiceIsRetainedAndNeverReboundByLabel() async throws {
        let h = try host()
        let missing = AidenRoutineModelChoice(providerId: "old", modelId: "old", thinkingLevel: .max)
        await h.set(try settings(selection: .selected(primary: missing, fallback: nil)))
        let m = model(h); await m.load()
        XCTAssertEqual(m.draft?.primary, missing); XCTAssertFalse(m.canSave)
        m.select(.init(providerId: "provider_1", modelId: "model_a", thinkingLevel: .max), fallback: false)
        XCTAssertEqual(m.draft?.primary, missing, "Unsupported thinking cannot silently choose another level")
        m.select(choice, fallback: false); XCTAssertEqual(m.draft?.primary, choice); XCTAssertTrue(m.canSave)
    }
    func testConflictKeepsDraftAndRequiresExplicitRevisionReview() async throws {
        let h = try host(); let m = model(h); await m.load(); m.select(choice, fallback: false)
        let updated = try settings("remote_2")
        await h.queue(.success(.rejected(code: .conflict, settings: updated))); await m.save()
        XCTAssertNil(m.pending); XCTAssertTrue(m.needsReview); XCTAssertFalse(m.canSave); XCTAssertEqual(m.draft?.primary, choice)
        m.keepDraft(); XCTAssertTrue(m.canSave); await m.save()
        expectEqual(await h.saves.last?.expectedRevision, "remote_2")
    }
    func testParsedUnavailableAndLaterPermissionRefusalKeepExactFrozenSave() async throws {
        let h = try host(); let m = model(h); await m.load(); m.select(choice, fallback: false)
        await h.queue(.success(.rejected(code: .unavailable, settings: nil))); await m.save()
        let frozen = try XCTUnwrap(m.pending); XCTAssertFalse(m.canEdit)
        await h.queue(.failure(try serverError(403))); await m.retry()
        XCTAssertEqual(m.pending, frozen); expectEqual(await h.saves, [frozen.request, frozen.request])
        await h.queue(.success(.rejected(code: .conflict, settings: try settings("newer")))); await m.retry()
        XCTAssertEqual(m.pending, frozen)
    }
    func testMatchingLastMutationSettlesButSameSelectionAndRevisionNeverProveReceipt() async throws {
        let h = try host(); let m = model(h); await m.load(); m.select(choice, fallback: false); await m.save()
        let frozen = try XCTUnwrap(m.pending)
        await h.set(try settings("newer", selection: frozen.request.selection)); await m.load(); XCTAssertNotNil(m.pending)
        await h.set(try settings("newer", selection: .inherit, nonce: frozen.request.mutationId)); await m.load()
        XCTAssertNil(m.pending); XCTAssertEqual(m.draft, .inherit, "Current host state can follow a later edit")
    }
    func testRestartRestoresFrozenRequestAndDispatchesSameUUID() async throws {
        let store = store(); defer { try? FileManager.default.removeItem(at: store.root) }
        let h = try host(); var first: AidenBotRoutineModelsModel? = model(h, store: store)
        await first?.load(); first?.select(choice, fallback: false); await first?.save()
        let frozen = try XCTUnwrap(first?.pending); first = nil
        let restored = model(h, store: store); await restored.load(); XCTAssertEqual(restored.pending, frozen)
        await restored.retry(); expectEqual(await h.saves, [frozen.request, frozen.request])
        let accepted = try settings("accepted", selection: frozen.request.selection, nonce: frozen.request.mutationId)
        await h.set(accepted); await restored.load(); XCTAssertNil(restored.pending)
        XCTAssertNil(try store.load(.init(instanceID: "host", deviceID: "phone", botID: "bot_model", routineID: "routine_model"))?.attempt)
        XCTAssertTrue(restored.canEdit)
    }
    func testExpiredUncertainSaveNeverCreatesNewIdentity() async throws {
        let h = try host(); let m = model(h); await m.load(); m.select(choice, fallback: false); await m.save()
        let frozen = try XCTUnwrap(m.pending); await m.retry(now: frozen.createdAt.addingTimeInterval(23 * 3600))
        expectEqual(await h.saves.count, 1); XCTAssertEqual(m.pending, frozen)
    }
    func testCrossWindowJournalCannotReplaceOrClearAnotherPendingSave() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let h = try host(); let one = model(h, store: s); let two = model(h, store: s)
        await one.load(); await two.load(); one.select(choice, fallback: false); two.select(fallback, fallback: false)
        await one.save(); await two.save()
        expectEqual(await h.saves.count, 1)
        let restored = model(h, store: s); XCTAssertEqual(restored.pending, one.pending)
    }
    func testProtectedScopeExcludesBackupAndPairingPurgeRemovesRequests() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let h = try host(); let m = model(h, store: s); await m.load(); m.select(choice, fallback: false); await m.save()
        XCTAssertEqual(try s.root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        XCTAssertNil(try s.load(.init(instanceID: "host", deviceID: "other-phone", botID: "bot_model", routineID: "routine_model")))
        s.purge(instanceID: "host")
        XCTAssertNil(try s.load(.init(instanceID: "host", deviceID: "phone", botID: "bot_model", routineID: "routine_model")))
    }
    func testReadOnlyLoadsSettingsAndRunsWithoutCatalogOrWrites() async throws {
        let h = try host(); let m = AidenBotRoutineModelsModel(botID: "bot_model", routineID: "routine_model", transport: h, mayWrite: { false })
        await m.load(); XCTAssertNotNil(m.settings); XCTAssertNil(m.catalog); expectEqual(await h.catalogReads, 0)
        m.select(choice, fallback: false); await m.save(); expectEqual(await h.saves.count, 0)
    }
    func testLateSaveAfterPairingChangeCannotRepublishPurgedDraft() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let h = try host(); var current = true
        let scope = AidenBotRoutineControlStore.Scope(instanceID: "host", deviceID: "phone", botID: "bot_model", routineID: "routine_model")
        let m = AidenBotRoutineModelsModel(botID: "bot_model", routineID: "routine_model", transport: h, isCurrent: { current }, store: s, scope: scope)
        await m.load(); m.select(choice, fallback: false); await h.hold(); let task = Task { await m.save() }
        while await h.saves.isEmpty { await Task.yield() }
        let nonce = try XCTUnwrap(m.pending?.request.mutationId); current = false; s.purge(instanceID: "host")
        await h.release(.accepted(settings: try settings("done", nonce: nonce), mutationId: nonce, replayed: false)); await task.value
        XCTAssertNil(try s.load(scope))
    }
    func testResumePreflightDoesNotSendUntilExplicitConsentAndCancelSendsNothing() async throws {
        let h = try host(); await h.setStatus(true); let flow = AidenBotResumeModel(botID: "bot_model", transport: h)
        expectNil(await flow.request()); XCTAssertTrue(flow.needsConsent); expectEqual(await h.resumes.count, 0)
        flow.cancelConsent(); expectNil(await flow.confirm()); expectEqual(await h.resumes.count, 0)
        _ = await flow.request(); _ = await flow.confirm()
        let sent = await h.resumes; XCTAssertEqual(sent.count, 1); XCTAssertTrue(sent[0].1); XCTAssertEqual(sent[0].2, "9007199254740993"); XCTAssertEqual(sent[0].3, "cost_" + String(repeating: "a", count: 64))
        XCTAssertEqual(flow.pending?.key, sent[0].0)
    }
    func testPreflightResponseCannotResumeOrPromptAfterBackgroundAndReturn() async throws {
        for requiresCost in [false, true] {
            let h = try host(); await h.setStatus(requiresCost); await h.holdStatusRead()
            let flow = AidenBotResumeModel(botID: "bot_model", transport: h)
            let task = Task { await flow.request() }
            let deadline = Date().addingTimeInterval(2)
            while await h.heldStatus == nil, Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
            expectEqual(await h.statusReads, 1)
            flow.setForegroundVisit(active: false)
            flow.setForegroundVisit(active: true)
            try await h.releaseStatusRead(); expectNil(await task.value)
            expectEqual(await h.resumes.count, 0)
            XCTAssertFalse(flow.needsConsent)
            XCTAssertNil(flow.pending)
        }
    }
    func testOrdinaryPreflightCannotResumeChangedInterruptedInput() async throws {
        let h = try host(); await h.holdStatusRead(); var version = "original"
        let flow = AidenBotResumeModel(botID: "bot_model", transport: h, version: { version })
        let task = Task { await flow.request() }
        let deadline = Date().addingTimeInterval(2)
        while await h.heldStatus == nil, Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        version = "replacement"
        try await h.releaseStatusRead(); expectNil(await task.value)
        expectEqual(await h.resumes.count, 0); XCTAssertNil(flow.pending)
    }
    func testBackgroundClearsConsentAndReturningRequiresFreshOwnerReview() async throws {
        let h = try host(); await h.setStatus(true)
        let flow = AidenBotResumeModel(botID: "bot_model", transport: h)
        _ = await flow.request(); XCTAssertTrue(flow.needsConsent)
        flow.setForegroundVisit(active: false)
        expectNil(await flow.confirm()); expectNil(await flow.request())
        flow.setForegroundVisit(active: true)
        expectNil(await flow.confirm()); expectEqual(await h.resumes.count, 0)
        XCTAssertFalse(flow.needsConsent); XCTAssertNil(flow.pending)
        _ = await flow.request(); XCTAssertTrue(flow.needsConsent)
        _ = await flow.confirm(); expectEqual(await h.resumes.count, 1)
        expectEqual(await h.statusReads, 2)
    }
    func testBackgroundPreservesAlreadyDispatchedUnknownAndOnlyExplicitForegroundRetrySends() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let scope = AidenBotRoutineControlStore.Scope(instanceID: "host", deviceID: "phone", botID: "bot_model")
        let h = try host(); await h.setStatus(true)
        let flow = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        _ = await flow.request(); _ = await flow.confirm()
        let original = try XCTUnwrap(flow.pending)
        flow.setForegroundVisit(active: false)
        _ = await flow.request(); _ = await flow.confirm()
        expectEqual(await h.resumes.count, 1); XCTAssertEqual(flow.pending, original)
        XCTAssertEqual(try s.load(scope)?.resume, original)
        flow.setForegroundVisit(active: true)
        expectEqual(await h.resumes.count, 1, "Returning never dispatches on its own")
        _ = await flow.request()
        let writes = await h.resumes
        XCTAssertEqual(writes.map { $0.0 }, [original.key, original.key])
        XCTAssertEqual(writes.map { $0.1 }, [true, true])
        XCTAssertEqual(writes.map { $0.2 }, [original.expectedSubmissionId, original.expectedSubmissionId])
        XCTAssertEqual(writes.map { $0.3 }, [original.expectedCostReceiptId, original.expectedCostReceiptId])
    }
    func testLateResumeResponseFromOldVisitKeepsFrozenRequestForExplicitReplay() async throws {
        let h = try host(); await h.setStatus(true)
        let flow = AidenBotResumeModel(botID: "bot_model", transport: h)
        _ = await flow.request(); await h.holdResumeWrite()
        let task = Task { await flow.confirm() }
        let deadline = Date().addingTimeInterval(2)
        while await h.heldResume == nil, Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        let original = try XCTUnwrap(flow.pending)
        flow.setForegroundVisit(active: false); flow.setForegroundVisit(active: true)
        await h.releaseResumeWrite(try AidenBotSessionStateView(state: .running))
        expectNil(await task.value)
        XCTAssertEqual(flow.pending, original, "A late response cannot publish into a different visit")
        await h.queueResume(.success(try AidenBotSessionStateView(state: .running)))
        expectNotNil(await flow.request()); XCTAssertNil(flow.pending)
        let writes = await h.resumes
        XCTAssertEqual(writes.map { $0.0 }, [original.key, original.key])
        XCTAssertEqual(writes.map { $0.2 }, [original.expectedSubmissionId, original.expectedSubmissionId])
        XCTAssertEqual(writes.map { $0.3 }, [original.expectedCostReceiptId, original.expectedCostReceiptId])
    }
    func testConsentNeverRetargetsAnotherCostOnTheSameInterruptedSubmission() async throws {
        let h = try host(); await h.setStatus(true); await h.enforceReceiptCAS()
        let flow = AidenBotResumeModel(botID: "bot_model", transport: h)
        _ = await flow.request(); XCTAssertTrue(flow.needsConsent)
        let tokenA = "cost_" + String(repeating: "a", count: 64)
        let tokenB = "cost_" + String(repeating: "b", count: 64)
        await h.setStatus(true, receiptId: tokenB) // The submission stays exactly the same.
        expectNil(await flow.confirm())
        let refused = await h.resumes
        XCTAssertEqual(refused.count, 1)
        XCTAssertEqual(refused[0].2, "9007199254740993")
        XCTAssertEqual(refused[0].3, tokenA)
        expectEqual(await h.acknowledgedReceipts, [])
        XCTAssertNil(flow.pending, "The first definitive stale receipt rejection cannot silently issue a replacement")
        _ = await flow.request(); await h.queueResume(.success(try AidenBotSessionStateView(state: .running)))
        expectNotNil(await flow.confirm())
        let reviewed = await h.resumes
        XCTAssertEqual(reviewed[1].2, reviewed[0].2)
        XCTAssertEqual(reviewed[1].3, tokenB)
        XCTAssertNotEqual(reviewed[1].0, reviewed[0].0, "Only a fresh owner review creates the replacement request")
        expectEqual(await h.acknowledgedReceipts, [tokenB])
    }
    func testUnknownReceiptRequestKeepsTokenAfterSameSourceCostChangesAndRestart() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let scope = AidenBotRoutineControlStore.Scope(instanceID: "host", deviceID: "phone", botID: "bot_model")
        let h = try host(); await h.setStatus(true)
        var originalFlow: AidenBotResumeModel? = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        _ = await originalFlow?.request(); _ = await originalFlow?.confirm()
        let frozen = try XCTUnwrap(originalFlow?.pending); originalFlow = nil
        await h.setStatus(true, receiptId: "cost_" + String(repeating: "b", count: 64)); await h.enforceReceiptCAS()
        let restored = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        _ = await restored.request()
        XCTAssertEqual(restored.pending, frozen)
        XCTAssertEqual(try s.load(scope)?.resume?.expectedCostReceiptId, "cost_" + String(repeating: "a", count: 64))
        let writes = await h.resumes
        XCTAssertEqual(writes.map { $0.0 }, [frozen.key, frozen.key])
        XCTAssertEqual(writes.map { $0.2 }, [frozen.expectedSubmissionId, frozen.expectedSubmissionId])
        XCTAssertEqual(writes.map { $0.3 }, [frozen.expectedCostReceiptId, frozen.expectedCostReceiptId])
        expectEqual(await h.acknowledgedReceipts, [])
    }
    func testConfirmedJournalWithoutReceiptFailsClosedWithoutUpgradingOrSending() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let scope = AidenBotRoutineControlStore.Scope(instanceID: "host", deviceID: "phone", botID: "bot_model")
        let h = try host(); await h.setStatus(true)
        var flow: AidenBotResumeModel? = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        _ = await flow?.request(); _ = await flow?.confirm()
        let frozen = try XCTUnwrap(flow?.pending); flow = nil
        let url = s.fileURL(scope)
        var envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var state = try XCTUnwrap(envelope["state"] as? [String: Any])
        var resume = try XCTUnwrap(state["resume"] as? [String: Any]); resume.removeValue(forKey: "expectedCostReceiptId")
        state["resume"] = resume; envelope["state"] = state
        let priorBytes = try JSONSerialization.data(withJSONObject: envelope); try priorBytes.write(to: url)
        XCTAssertThrowsError(try s.load(scope))
        let restored = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        XCTAssertTrue(restored.preventsLegacyResume)
        _ = await restored.request(); _ = await restored.confirm()
        expectEqual(await h.resumes.count, 1)
        XCTAssertEqual(try Data(contentsOf: url), priorBytes, "The missing token is never filled with a later host token")
        XCTAssertEqual(resume["key"] as? String, frozen.key.uuidString)
    }
    func testOrdinaryJournalWithoutReceiptStillReplaysTheOriginalEmptyRequest() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let scope = AidenBotRoutineControlStore.Scope(instanceID: "host", deviceID: "phone", botID: "bot_model")
        let h = try host()
        var flow: AidenBotResumeModel? = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        _ = await flow?.request(); let frozen = try XCTUnwrap(flow?.pending); flow = nil
        let restored = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        XCTAssertEqual(restored.pending, frozen)
        XCTAssertNil(frozen.expectedCostReceiptId)
        await h.queueResume(.success(try AidenBotSessionStateView(state: .running))); expectNotNil(await restored.request())
        let writes = await h.resumes
        XCTAssertEqual(writes.map { $0.0 }, [frozen.key, frozen.key]); XCTAssertEqual(writes.map { $0.1 }, [false, false])
        XCTAssertEqual(writes.map { $0.3 }, [nil, nil])
    }
    func testFirstInFlightOutcomeSurvivesRestartAndKeepsOriginalReceiptUntilHostSettlement() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let scope = AidenBotRoutineControlStore.Scope(instanceID: "host", deviceID: "phone", botID: "bot_model")
        let h = try host(); await h.setStatus(true)
        await h.queueResume(.failure(try serverError(409, code: "idempotency_in_flight")))
        var flow: AidenBotResumeModel? = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        _ = await flow?.request(); _ = await flow?.confirm()
        let frozen = try XCTUnwrap(flow?.pending); flow = nil
        XCTAssertEqual(frozen.expectedCostReceiptId, "cost_" + String(repeating: "a", count: 64))
        await h.setStatus(true, receiptId: "cost_" + String(repeating: "b", count: 64)); await h.enforceReceiptCAS()
        let restored = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        _ = await restored.request()
        XCTAssertEqual(restored.pending, frozen, "A later stale-token refusal cannot settle the original uncertain effect")
        expectEqual(await h.statusReads, 1)
        expectEqual(await h.acknowledgedReceipts, [])
        await h.settleResume(frozen.key, try AidenBotSessionStateView(state: .running))
        expectNotNil(await restored.request()); XCTAssertNil(restored.pending); XCTAssertNil(try s.load(scope))
        let writes = await h.resumes
        XCTAssertEqual(writes.map { $0.0 }, [frozen.key, frozen.key, frozen.key])
        XCTAssertEqual(writes.map { $0.2 }, [frozen.expectedSubmissionId, frozen.expectedSubmissionId, frozen.expectedSubmissionId])
        XCTAssertEqual(writes.map { $0.3 }, [frozen.expectedCostReceiptId, frozen.expectedCostReceiptId, frozen.expectedCostReceiptId])
        expectEqual(await h.statusReads, 1, "Recovery never preflights a replacement cost or creates a fresh request")
        expectEqual(await h.acknowledgedReceipts, [])
    }
    func testTypedUnknownResumeOutcomesKeepFirstRequestRegardlessOfStatusOrRetryableFlag() async throws {
        for (code, status) in [("idempotency_in_flight", 409), ("operation_in_progress", 400), ("internal_error", 403), ("server_interrupted", 409)] {
            let h = try host(); await h.queueResume(.failure(try serverError(status, code: code)))
            let flow = AidenBotResumeModel(botID: "bot_model", transport: h)
            _ = await flow.request()
            let original = try XCTUnwrap(flow.pending, code)
            XCTAssertFalse(original.acknowledgeUnknownCost)
            await h.queueResume(.success(try AidenBotSessionStateView(state: .running)))
            expectNotNil(await flow.request())
            let writes = await h.resumes
            XCTAssertEqual(writes.map { $0.0 }, [original.key, original.key], code)
            expectEqual(await h.statusReads, 1)
        }
    }
    func testKnownBeforeEffectResumeRefusalsReleaseOnlyTheFirstRequest() async throws {
        for (code, status) in [("operation_stale", 409), ("invalid_request", 400), ("capability_denied", 403), ("not_found", 404)] {
            let h = try host(); await h.queueResume(.failure(try serverError(status, code: code)))
            let flow = AidenBotResumeModel(botID: "bot_model", transport: h)
            _ = await flow.request(); XCTAssertNil(flow.pending, code)
            await h.queueResume(.success(try AidenBotSessionStateView(state: .running)))
            expectNotNil(await flow.request())
            let writes = await h.resumes
            XCTAssertEqual(writes.count, 2); XCTAssertNotEqual(writes[0].0, writes[1].0, code)
            expectEqual(await h.statusReads, 2)
        }
    }
    func testResumeFalseStatusSendsEmptyBodyAndPriorUnknownNeverUpgradesConsent() async throws {
        let h = try host(); let flow = AidenBotResumeModel(botID: "bot_model", transport: h)
        _ = await flow.request(); let original = try XCTUnwrap(flow.pending); XCTAssertFalse(original.acknowledgeUnknownCost)
        await h.setStatus(true); await h.queueResume(.failure(try serverError(403))); _ = await flow.request()
        XCTAssertEqual(flow.pending, original); expectEqual(await h.statusReads, 1)
        let sent = await h.resumes; XCTAssertEqual(sent.map { $0.0 }, [original.key, original.key]); XCTAssertEqual(sent.map { $0.1 }, [false, false])
    }
    func testResumeConfirmationRejectsStaleInputOrLostWriteAccess() async throws {
        let h = try host(); await h.setStatus(true); var version = "before"; var mayResume = true
        let flow = AidenBotResumeModel(botID: "bot_model", transport: h, mayResume: { mayResume }, version: { version })
        _ = await flow.request(); version = "after"; _ = await flow.confirm(); expectEqual(await h.resumes.count, 0)
        _ = await flow.request(); mayResume = false; _ = await flow.confirm(); expectEqual(await h.resumes.count, 0)
    }
    func testConfirmedResumePersistsTrueAcrossRestartAndSettlesOnlyResponse() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let scope = AidenBotRoutineControlStore.Scope(instanceID: "host", deviceID: "phone", botID: "bot_model")
        let h = try host(); await h.setStatus(true)
        var flow: AidenBotResumeModel? = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        _ = await flow?.request(); _ = await flow?.confirm(); let original = try XCTUnwrap(flow?.pending); flow = nil
        let restored = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        await h.setStatus(true, submissionId: "9007199254740997", receiptId: "cost_" + String(repeating: "b", count: 64))
        await h.queueResume(.success(try AidenBotSessionStateView(state: .running)))
        expectNotNil(await restored.request()); XCTAssertNil(restored.pending); XCTAssertNil(try s.load(scope))
        let sent = await h.resumes; XCTAssertEqual(sent.map { $0.0 }, [original.key, original.key]); XCTAssertEqual(sent.map { $0.1 }, [true, true]); XCTAssertEqual(sent.map { $0.2 }, ["9007199254740993", "9007199254740993"]); XCTAssertEqual(sent.map { $0.3 }, [original.expectedCostReceiptId, original.expectedCostReceiptId])
    }
    func testBotDeletionInvalidatesOpenModelAndResumeControllersBeforeFurtherNetwork() async throws {
        let s = store(); defer { try? FileManager.default.removeItem(at: s.root) }
        let h = try host(); let m = model(h, store: s); await m.load(); m.select(choice, fallback: false)
        let scope = AidenBotRoutineControlStore.Scope(instanceID: "host", deviceID: "phone", botID: "bot_model")
        let flow = AidenBotResumeModel(botID: "bot_model", transport: h, store: s, scope: scope)
        s.purge(instanceID: "host", deviceID: "phone", botID: "bot_model")
        await m.save(); _ = await flow.request()
        expectEqual(await h.saves.count, 0); expectEqual(await h.statusReads, 0); expectEqual(await h.resumes.count, 0)
        XCTAssertFalse(m.canWrite)
    }
    func testAdoptedOrdinaryResumeKeepsOriginalIdentityBodyAndAge() async throws {
        let h = try host(); await h.setStatus(true)
        let flow = AidenBotResumeModel(botID: "bot_model", transport: h)
        let key = UUID(); flow.adoptOrdinaryPending(key: key, createdAt: Date())
        _ = await flow.request()
        let sent = await h.resumes; XCTAssertEqual(sent.first?.0, key); XCTAssertEqual(sent.first?.1, false)
        expectEqual(await h.statusReads, 0)
        let expired = AidenBotResumeModel(botID: "bot_model", transport: h)
        expired.adoptOrdinaryPending(key: UUID(), createdAt: Date().addingTimeInterval(-24 * 3600)); _ = await expired.request()
        expectEqual(await h.resumes.count, 1)
        XCTAssertNotNil(expired.pending)
    }
    func testResumeEncodingOmitsFalseAndOnlyExplicitConfirmationSendsTrue() throws {
        let ordinary = try JSONSerialization.jsonObject(with: JSONEncoder().encode(AidenBotResumeRequest(acknowledgeUnknownCost: false))) as? [String: Any]
        XCTAssertEqual(ordinary?.count, 0)
        XCTAssertThrowsError(try JSONEncoder().encode(AidenBotResumeRequest(acknowledgeUnknownCost: true)))
        XCTAssertThrowsError(try JSONEncoder().encode(AidenBotResumeRequest(acknowledgeUnknownCost: false, expectedSubmissionId: "1")))
        let consent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(AidenBotResumeRequest(acknowledgeUnknownCost: true, expectedSubmissionId: "9007199254740993", expectedCostReceiptId: "cost_" + String(repeating: "a", count: 64)))) as? [String: Any]
        XCTAssertEqual(consent?["expectedSubmissionId"] as? String, "9007199254740993")
        XCTAssertEqual(consent?["expectedCostReceiptId"] as? String, "cost_" + String(repeating: "a", count: 64))
        XCTAssertEqual(consent?.count, 3); XCTAssertEqual(consent?["acknowledgeUnknownCost"] as? Bool, true)
    }
    func testNativeModelFormAddsAndRemovesExplicitFallbackControls() async throws {
        let h = try host(); let m = model(h); await m.load()
        let controller = UIHostingController(rootView: NavigationStack { AidenRoutineModelForm(model: m) })
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 430, height: 1800)); window.rootViewController = controller; window.makeKeyAndVisible()
        defer { window.isHidden = true }
        controller.view.layoutIfNeeded(); try await Task.sleep(for: .milliseconds(200))
        func descendants(_ view: UIView) -> [UIView] { view.subviews + view.subviews.flatMap(descendants) }
        func rows() -> Int {
            descendants(controller.view).compactMap { $0 as? UICollectionView }.reduce(0) { total, collection in
                total + (0..<collection.numberOfSections).reduce(0) { $0 + collection.numberOfItems(inSection: $1) }
            }
        }
        let inheritedRows = rows(); XCTAssertGreaterThan(inheritedRows, 3)
        m.select(choice, fallback: false); m.select(fallback, fallback: true)
        controller.view.setNeedsLayout(); controller.view.layoutIfNeeded(); try await Task.sleep(for: .milliseconds(200))
        XCTAssertGreaterThan(rows(), inheritedRows, "An explicit fallback exposes its own model, thinking and removal controls")
        XCTAssertTrue(m.canSave)
        m.inherit(); controller.view.setNeedsLayout(); controller.view.layoutIfNeeded(); try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(rows(), inheritedRows, "Inherit removes the explicit primary/fallback controls")
        XCTAssertFalse(m.canSave)
    }
}
