import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

private func peerDecode<T: Decodable>(_ type: T.Type, _ raw: Any) throws -> T { try AidenRemoteJSONDecoder.decode(type, from: JSONSerialization.data(withJSONObject: raw)) }
private func peerObject<T: Encodable>(_ value: T) throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any]) }
private func peerFixture() throws -> [String: Any] {
    let url = try XCTUnwrap(Bundle(for: AidenBotPeersTests.self).url(forResource: "bot-peers", withExtension: "json"))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
}

/// A tiny independent host ledger: before-effect errors don't publish; lost replies
/// can publish, and replay consults the original UUID before current CAS.
private actor PeerHost: AidenBotPeersTransport {
    var settings: AidenPeerSettings; var catalog: AidenPeerCatalog; var detail: AidenPeerExchangeDetail
    var mutations: [AidenPeerMutation] = []; var stops: [AidenPeerStopMutation] = []
    var receipts: [UUID: AidenPeerMutationResult] = [:]
    var mutationErrors: [Error] = []; var stopErrors: [Error] = []
    var publishThenLose = false; var stopThenLose = false
    var overrideMutation: AidenPeerMutationResult?; var overrideStop: AidenPeerStopResult?
    var catalogReads = 0; var exchangeReads = 0; var settingsReads = 0; var evidenceReads = 0
    var evidence: AidenPeerEvidence
    var readError: Error?
    var holdMutation = false; var heldMutation: CheckedContinuation<AidenPeerMutationResult, Error>?
    var holdSettings = false; var heldSettings: CheckedContinuation<AidenPeerSettings, Error>?
    init() throws {
        let f = try peerFixture()
        settings = try peerDecode(AidenPeerSettings.self, f["settings"]!); catalog = try peerDecode(AidenPeerCatalog.self, f["catalog"]!)
        var raw = f["detail"] as! [String: Any]; raw["canStop"] = true; raw["state"] = "running"; raw.removeValue(forKey: "result")
        detail = try peerDecode(AidenPeerExchangeDetail.self, raw); evidence = try peerDecode(AidenPeerEvidence.self, f["evidence"]!)
    }
    func setSettings(_ value: AidenPeerSettings) { settings = value }
    func setCatalog(_ value: AidenPeerCatalog) { catalog = value }
    func setDetail(_ value: AidenPeerExchangeDetail) { detail = value }
    func setEvidence(_ value: AidenPeerEvidence) { evidence = value }
    func failMutation(_ error: Error) { mutationErrors.append(error) }
    func failStop(_ error: Error) { stopErrors.append(error) }
    func setReadError(_ error: Error?) { readError = error }
    func losePublishedMutation() { publishThenLose = true }
    func losePublishedStop() { stopThenLose = true }
    func setMutationReply(_ reply: AidenPeerMutationResult?) { overrideMutation = reply }
    func setStopReply(_ reply: AidenPeerStopResult?) { overrideStop = reply }
    func holdNextMutation() { holdMutation = true }
    func releaseMutation(_ value: AidenPeerMutationResult) { heldMutation?.resume(returning: value); heldMutation = nil }
    func holdNextSettings() { holdSettings = true }
    func releaseSettings() { heldSettings?.resume(returning: settings); heldSettings = nil }
    func botPeerSettings(botId: String) async throws -> AidenPeerSettings {
        settingsReads += 1
        if holdSettings { holdSettings = false; return try await withCheckedThrowingContinuation { heldSettings = $0 } }
        if let readError { throw readError }; return settings
    }
    func botPeerCatalog(botId: String) async throws -> AidenPeerCatalog { catalogReads += 1; return catalog }
    func botPeerExchanges(botId: String) async throws -> AidenPeerExchangeList {
        exchangeReads += 1
        return try peerDecode(AidenPeerExchangeList.self, ["botId": botId, "revision": "list_v1", "exchanges": []])
    }
    func botPeerExchange(botId: String, exchangeId: String) async throws -> AidenPeerExchangeDetail { exchangeReads += 1; if let readError { throw readError }; return detail }
    func botPeerEvidence(botId: String, exchangeId: String, kind: AidenOpenWorkEvidenceKind) async throws -> AidenPeerEvidence { evidenceReads += 1; if let readError { throw readError }; return evidence }
    func mutateBotPeers(_ request: AidenPeerMutation) async throws -> AidenPeerMutationResult {
        mutations.append(request)
        if !mutationErrors.isEmpty { throw mutationErrors.removeFirst() }
        if holdMutation { holdMutation = false; return try await withCheckedThrowingContinuation { heldMutation = $0 } }
        if let overrideMutation { return overrideMutation }
        if let receipt = receipts[request.mutationId] { return receipt }
        guard request.expectedRevision == settings.revision else { return .rejected(code: .conflict, error: "Changed", snapshot: settings) }
        var raw = try peerObject(settings)
        switch request.action {
        case .describe: raw["routingDescription"] = request.routingDescription
        case .approve:
            guard request.catalogRevision == catalog.revision, let bot = catalog.bots.first(where: { $0.botId == request.peerBotId && $0.available }) else { return .rejected(code: .conflict, error: "Review catalog", snapshot: settings) }
            var pairs = raw["pairs"] as! [[String: Any]]
            pairs.append(["id": "pair_new", "revision": "pair_generation_one", "peer": ["botId": bot.botId, "name": bot.name], "approvedAt": 4000]); raw["pairs"] = pairs
        case .revoke:
            raw["pairs"] = (raw["pairs"] as! [[String: Any]]).filter { $0["id"] as? String != request.pairId }
        }
        raw["revision"] = settings.revision + "x"; raw["updatedAt"] = 4000; raw["lastMutationId"] = request.mutationId.uuidString
        settings = try peerDecode(AidenPeerSettings.self, raw)
        let result = AidenPeerMutationResult.accepted(snapshot: settings, mutationId: request.mutationId, replayed: false); receipts[request.mutationId] = result
        if publishThenLose { publishThenLose = false; throw URLError(.networkConnectionLost) }; return result
    }
    func stopBotPeerExchange(_ request: AidenPeerStopMutation) async throws -> AidenPeerStopResult {
        stops.append(request)
        if !stopErrors.isEmpty { throw stopErrors.removeFirst() }
        if let overrideStop { return overrideStop }
        // The logical Stop retains its nonce while the linked work acknowledges it.
        let f = try peerFixture(); var raw = f["waiting"] as! [String: Any]
        raw["lastStop"] = ["mutationId": request.mutationId.uuidString, "state": "requested", "at": 2000]
        detail = try peerDecode(AidenPeerExchangeDetail.self, raw)
        if stopThenLose { stopThenLose = false; throw URLError(.networkConnectionLost) }
        return .accepted(exchange: detail, mutationId: request.mutationId, replayed: stops.count > 1)
    }
}

@MainActor final class AidenBotPeersTests: XCTestCase {
    private let bot = "bot_planner"
    private func store() -> AidenBotPeerControlStore { AidenBotPeerControlStore(root: FileManager.default.temporaryDirectory.appending(path: "peer-test-\(UUID())")) }
    private func scope(_ exchange: String? = nil, bot: String = "bot_planner", host: String = "host", device: String = "phone") -> AidenBotPeerControlStore.Scope { .init(instanceID: host, deviceID: device, botID: bot, exchangeID: exchange) }
    private func settings(_ mutate: (inout [String: Any]) -> Void = { _ in }) throws -> AidenPeerSettings { var raw = try peerFixture()["settings"] as! [String: Any]; mutate(&raw); return try peerDecode(AidenPeerSettings.self, raw) }
    private func exchange(_ key: String = "waiting", _ mutate: (inout [String: Any]) -> Void = { _ in }) throws -> AidenPeerExchangeDetail { var raw = try peerFixture()[key] as! [String: Any]; mutate(&raw); return try peerDecode(AidenPeerExchangeDetail.self, raw) }
    private func model(_ host: PeerHost, _ store: AidenBotPeerControlStore? = nil) -> AidenBotPeersModel { .init(botID: bot, transport: host, store: store, scope: store == nil ? nil : scope()) }
    private func exchangeModel(_ host: PeerHost, _ store: AidenBotPeerControlStore? = nil) -> AidenBotPeerExchangeModel { .init(botID: bot, exchangeID: "exchange_one", transport: host, store: store, scope: store == nil ? nil : scope("exchange_one")) }
    private func error(_ code: String, status: Int = 409) throws -> AidenRemoteClientError {
        .server(statusCode: status, body: try peerDecode(AidenRemoteErrorEnvelope.Body.self, ["code": code, "message": "Request refused", "requestId": "peer-test", "retryable": false]))
    }
    func testNormativeRevision57AllPublicPeerShapesDecode() throws {
        let f = try peerFixture(); XCTAssertEqual(f["contractRevision"] as? Int, 58); XCTAssertEqual(f["capability"] as? String, "bot:peers")
        let s = try peerDecode(AidenPeerSettings.self, f["settings"]!); XCTAssertEqual(s.pairs.first?.peer.name, "Researcher")
        XCTAssertEqual(try peerDecode(AidenPeerCatalog.self, f["catalog"]!).bots.count, 1)
        for key in ["approve", "describe", "revoke"] { try peerDecode(AidenPeerMutation.self, f[key]!).validate() }
        guard case .accepted = try peerDecode(AidenPeerMutationResult.self, f["accepted"]!) else { return XCTFail() }
        guard case .rejected(.conflict, _, _) = try peerDecode(AidenPeerMutationResult.self, f["conflict"]!) else { return XCTFail() }
        XCTAssertEqual(try peerDecode(AidenPeerExchangeList.self, f["exchanges"]!).exchanges.first?.state, .completed)
        XCTAssertEqual(try peerDecode(AidenPeerExchangeDetail.self, f["detail"]!).result?.outcome, .completed)
        XCTAssertEqual(try peerDecode(AidenPeerExchangeDetail.self, f["waiting"]!).summary.lastStop?.state, .requested)
        guard case .accepted(_, _, true) = try peerDecode(AidenPeerStopResult.self, f["stopped"]!) else { return XCTFail() }
        let evidence = try peerDecode(AidenPeerEvidence.self, f["evidence"]!); XCTAssertEqual(evidence.submissionId, "9007199254740993"); XCTAssertEqual(evidence.entryId, "9007199254740995")
    }
    func testStrictSettingsRejectSelfDuplicateMissingAndUnknownAuthorityFields() throws {
        let base = try peerFixture()["settings"] as! [String: Any]
        for key in ["botId", "revision", "pairs", "updatedAt", "routingDescription"] { var raw = base; raw.removeValue(forKey: key); XCTAssertThrowsError(try peerDecode(AidenPeerSettings.self, raw), key) }
        var raw = base; raw["permissions"] = ["full": true]; XCTAssertThrowsError(try peerDecode(AidenPeerSettings.self, raw))
        raw = base; raw["lastMutationId"] = NSNull(); XCTAssertThrowsError(try peerDecode(AidenPeerSettings.self, raw))
        let pair = (base["pairs"] as! [[String: Any]])[0]
        raw = base; raw["pairs"] = [pair, pair]; XCTAssertThrowsError(try peerDecode(AidenPeerSettings.self, raw))
        var selfPair = pair; selfPair["peer"] = ["botId": bot, "name": "Self"]; raw["pairs"] = [selfPair]; XCTAssertThrowsError(try peerDecode(AidenPeerSettings.self, raw))
    }
    func testTextLimitsUseScalarsAndUTF8AndSafeEpochAndPathIDs() throws {
        XCTAssertNoThrow(try settings { $0["routingDescription"] = String(repeating: "é", count: 1000) })
        XCTAssertThrowsError(try settings { $0["routingDescription"] = String(repeating: "😀", count: 513) })
        XCTAssertThrowsError(try settings { $0["routingDescription"] = String(repeating: "a", count: 1001) })
        XCTAssertThrowsError(try settings { $0["routingDescription"] = "hello\0world" })
        XCTAssertThrowsError(try settings { $0["updatedAt"] = 9007199254740992 })
        XCTAssertThrowsError(try settings { $0["revision"] = "../other" })
        XCTAssertNoThrow(try settings { $0["revision"] = String(repeating: "r", count: 160) })
        XCTAssertThrowsError(try settings { $0["revision"] = String(repeating: "r", count: 161) })
    }
    func testClosedMutationUnionsCannotCarryExtraApprovalsOrPartialRevocation() throws {
        let f = try peerFixture()
        var raw = f["describe"] as! [String: Any]; raw["peerBotId"] = "bot_researcher"; XCTAssertThrowsError(try peerDecode(AidenPeerMutation.self, raw))
        raw = f["approve"] as! [String: Any]; raw.removeValue(forKey: "catalogRevision"); XCTAssertThrowsError(try peerDecode(AidenPeerMutation.self, raw))
        raw = f["revoke"] as! [String: Any]; raw.removeValue(forKey: "pairRevision"); XCTAssertThrowsError(try peerDecode(AidenPeerMutation.self, raw))
        raw = f["stop"] as! [String: Any]; raw["scope"] = "all"; XCTAssertThrowsError(try peerDecode(AidenPeerStopMutation.self, raw))
    }
    func testSummaryDetailAndEvidenceRefusePartialCrossBotAndOversizeInputs() throws {
        let f = try peerFixture(); let raw = f["detail"] as! [String: Any]
        XCTAssertThrowsError(try peerDecode(AidenPeerExchangeSummary.self, raw), "summary must never accidentally include request text")
        var detail = raw; detail.removeValue(forKey: "request"); XCTAssertThrowsError(try peerDecode(AidenPeerExchangeDetail.self, detail))
        detail = raw; detail["request"] = ["text": String(repeating: "a", count: 8193)]; XCTAssertThrowsError(try peerDecode(AidenPeerExchangeDetail.self, detail))
        detail = raw; detail["result"] = NSNull(); XCTAssertThrowsError(try peerDecode(AidenPeerExchangeDetail.self, detail))
        var list = f["exchanges"] as! [String: Any]; list["botId"] = "other"; XCTAssertThrowsError(try peerDecode(AidenPeerExchangeList.self, list))
        var evidence = f["evidence"] as! [String: Any]; evidence["entryId"] = 9007199254740993 as Int; XCTAssertThrowsError(try peerDecode(AidenPeerEvidence.self, evidence))
        evidence = f["evidence"] as! [String: Any]; evidence["text"] = String(repeating: "😀", count: 8193); XCTAssertThrowsError(try peerDecode(AidenPeerEvidence.self, evidence))
        var waiting = f["waiting"] as! [String: Any]; waiting["lastStop"] = ["mutationId": UUID().uuidString, "state": "completed", "at": 1]; XCTAssertThrowsError(try peerDecode(AidenPeerExchangeDetail.self, waiting))
    }
    func testCatalogRetainsUnavailableChoicesAndRejectsDuplicatesAndSelf() throws {
        let f = try peerFixture(); var raw = f["catalog"] as! [String: Any]
        raw["bots"] = [["botId": "bot_other", "name": "Other", "available": false]]
        XCTAssertFalse(try peerDecode(AidenPeerCatalog.self, raw).bots[0].available)
        raw["bots"] = [["botId": bot, "name": "Self", "available": true]]; XCTAssertThrowsError(try peerDecode(AidenPeerCatalog.self, raw))
        raw["bots"] = Array(repeating: ["botId": "bot_other", "name": "Other", "available": true], count: 129); XCTAssertThrowsError(try peerDecode(AidenPeerCatalog.self, raw))
    }
    func testDescriptionSaveIsMetadataOnlyAndSurvivesRestartBeforeSending() async throws {
        let host = try PeerHost(); let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let first = model(host, journal); await first.load(); first.draft = "  Ask me to review accessibility.  "
        let restored = model(host, journal); XCTAssertEqual(restored.draft, first.draft)
        await restored.load(); await restored.describe()
        let calls = await host.mutations; XCTAssertEqual(calls.count, 1); XCTAssertEqual(calls[0].action, .describe); XCTAssertEqual(calls[0].routingDescription, "Ask me to review accessibility.")
        XCTAssertNil(calls[0].peerBotId); XCTAssertNil(restored.pending); XCTAssertEqual(restored.settings?.routingDescription, "Ask me to review accessibility.")
        let stops = await host.stops; XCTAssertTrue(stops.isEmpty, "metadata edits never stop/start a run")
    }
    func testApproveNamesAndCatalogIdentityMustRemainCurrentAndRevokeUsesPairGeneration() async throws {
        let host = try PeerHost(); await host.setSettings(try settings { $0["pairs"] = [] }); let m = model(host); await m.load()
        let choice = try XCTUnwrap(m.catalog?.bots.first); let revision = try XCTUnwrap(m.catalog?.revision); let visit = m.visitToken
        await m.approve(choice, catalogRevision: revision, visit: visit)
        XCTAssertEqual(m.settings?.pairs.first?.peer.name, "Researcher")
        let pair = try XCTUnwrap(m.settings?.pairs.first); await m.revoke(pair, visit: m.visitToken)
        let calls = await host.mutations; XCTAssertEqual(calls.map(\.action), [.approve, .revoke]); XCTAssertEqual(calls[0].peerBotId, "bot_researcher"); XCTAssertEqual(calls[1].pairId, "pair_new"); XCTAssertEqual(calls[1].pairRevision, "pair_generation_one")
        XCTAssertTrue(m.settings?.pairs.isEmpty == true)
    }
    func testPairApprovalAndRevocationKeepUnsavedDescriptionAndPersistNewBaseline() async throws {
        let host = try PeerHost(); await host.setSettings(try settings { $0["pairs"] = [] })
        let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let m = model(host, journal); await m.load(); let originalDescription = m.settings?.routingDescription
        m.draft = "Unsaved routing notes for this Bot"
        let choice = try XCTUnwrap(m.catalog?.bots.first)
        await m.approve(choice, catalogRevision: m.catalog!.revision, visit: m.visitToken)
        XCTAssertNil(m.pending); XCTAssertEqual(m.settings?.pairs.first?.peer.botId, "bot_researcher")
        XCTAssertEqual(m.draft, "Unsaved routing notes for this Bot"); XCTAssertEqual(m.settings?.routingDescription, originalDescription)
        XCTAssertTrue(m.canSaveDescription); XCTAssertEqual(m.baseline?.revision, m.settings?.revision)
        let pair = try XCTUnwrap(m.settings?.pairs.first)
        await m.revoke(pair, visit: m.visitToken)
        XCTAssertTrue(m.settings?.pairs.isEmpty == true); XCTAssertEqual(m.draft, "Unsaved routing notes for this Bot")
        XCTAssertTrue(m.canSaveDescription); XCTAssertEqual(m.baseline?.revision, m.settings?.revision)
        let restored = model(host, journal); await restored.load()
        XCTAssertEqual(restored.draft, "Unsaved routing notes for this Bot"); XCTAssertTrue(restored.canSaveDescription)
        let writes = await host.mutations; XCTAssertEqual(writes.map(\.action), [.approve, .revoke]); XCTAssertTrue(writes.allSatisfy { $0.routingDescription == nil })
    }
    func testPairChangeGETReceiptRecoveryRetainsDurableUnsavedDescription() async throws {
        for approve in [true, false] {
            let host = try PeerHost()
            if approve { await host.setSettings(try settings { $0["pairs"] = [] }) }
            let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
            let m = model(host, journal); await m.load(); m.draft = "Keep my unsaved description"
            await host.losePublishedMutation()
            if approve {
                await m.approve(m.catalog!.bots[0], catalogRevision: m.catalog!.revision, visit: m.visitToken)
            } else { await m.revoke(m.settings!.pairs[0], visit: m.visitToken) }
            let nonce = try XCTUnwrap(m.pending?.nonce, m.message ?? "Pair change must be retained after a published lost response")
            let restored = model(host, journal); XCTAssertEqual(restored.pending?.nonce, nonce)
            await restored.load()
            XCTAssertNil(restored.pending); XCTAssertEqual(restored.settings?.lastMutationId, nonce)
            XCTAssertEqual(restored.draft, "Keep my unsaved description"); XCTAssertTrue(restored.canSaveDescription)
            XCTAssertEqual(restored.baseline?.revision, restored.settings?.revision)
            XCTAssertEqual(try journal.load(scope())?.draft, "Keep my unsaved description")
            XCTAssertNil(try journal.load(scope())?.attempt)
            let calls = await host.mutations; XCTAssertEqual(calls.count, 1, "Passive reconciliation must not send another mutation")
        }
    }
    func testPairRetryCannotSilentlyRebaseDraftOverAnotherDevicesDescription() async throws {
        let host = try PeerHost(); await host.setSettings(try settings { $0["pairs"] = [] })
        let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let m = model(host, journal); await m.load(); m.draft = "My local draft"
        await host.losePublishedMutation()
        await m.approve(m.catalog!.bots[0], catalogRevision: m.catalog!.revision, visit: m.visitToken)
        let nonce = try XCTUnwrap(m.pending?.nonce)
        var raw = try peerObject(await host.settings)
        raw["revision"] = "phone_description"; raw["routingDescription"] = "Description from another phone"
        raw["lastMutationId"] = UUID().uuidString
        let latest = try peerDecode(AidenPeerSettings.self, raw)
        await host.setSettings(latest)
        await host.setMutationReply(.accepted(snapshot: latest, mutationId: nonce, replayed: true))
        await m.retry()
        XCTAssertNil(m.pending); XCTAssertEqual(m.draft, "My local draft")
        XCTAssertTrue(m.needsReview); XCTAssertFalse(m.canSaveDescription)
        await m.describe(); var calls = await host.mutations; XCTAssertEqual(calls.count, 2)
        let restored = model(host, journal); await restored.load()
        XCTAssertTrue(restored.needsReview); XCTAssertFalse(restored.canSaveDescription)
        XCTAssertEqual(restored.draft, "My local draft")
        restored.keepDraft(); await host.setMutationReply(nil); await restored.describe()
        calls = await host.mutations; XCTAssertEqual(calls.last?.expectedRevision, "phone_description")
        XCTAssertEqual(restored.settings?.routingDescription, "My local draft")
    }
    func testOldConfirmationCannotRetargetRenamedCatalogOrAnotherForegroundVisit() async throws {
        let host = try PeerHost(); await host.setSettings(try settings { $0["pairs"] = [] }); let m = model(host); await m.load()
        let choice = try XCTUnwrap(m.catalog?.bots.first); let rev = m.catalog!.revision; let visit = m.visitToken
        m.setActive(false); m.setActive(true); await m.approve(choice, catalogRevision: rev, visit: visit)
        var raw = try peerFixture()["catalog"] as! [String: Any]; raw["bots"] = [["botId": choice.botId, "name": "Renamed", "available": true]]
        await host.setCatalog(try peerDecode(AidenPeerCatalog.self, raw)); await m.load()
        await m.approve(choice, catalogRevision: rev, visit: m.visitToken)
        let calls = await host.mutations; XCTAssertTrue(calls.isEmpty)
    }
    func testReadOnlyLoadsMetadataCatalogButNoExchangesWithoutChatGrant() async throws {
        let host = try PeerHost(); let m = AidenBotPeersModel(botID: bot, transport: host, mayWrite: { false }, mayReadExchanges: { false }); await m.load()
        XCTAssertNotNil(m.settings); XCTAssertNotNil(m.catalog); XCTAssertFalse(m.canEdit); XCTAssertFalse(m.canReadExchanges)
        let reads = await (host.catalogReads, host.exchangeReads); XCTAssertEqual(reads.0, 1); XCTAssertEqual(reads.1, 0)
    }
    func testUnavailableCatalogChoiceNeverApprovedAndUnknownSavedPairNeverRebound() async throws {
        let host = try PeerHost(); var raw = try peerFixture()["catalog"] as! [String: Any]
        raw["bots"] = [["botId": "new_identity", "name": "Researcher", "available": false]]; await host.setCatalog(try peerDecode(AidenPeerCatalog.self, raw))
        let m = model(host); await m.load(); let candidate = m.catalog!.bots[0]; await m.approve(candidate, catalogRevision: m.catalog!.revision, visit: m.visitToken)
        m.draft = "New description"; await m.describe()
        XCTAssertEqual(m.settings?.pairs.first?.peer.botId, "bot_researcher"); let calls = await host.mutations; XCTAssertEqual(calls.count, 1); XCTAssertEqual(calls[0].action, .describe)
    }
    func testConflictKeepsDraftRequiresReviewAndDoesNotBlindlyReplaceRevision() async throws {
        let host = try PeerHost(); let m = model(host); await m.load(); m.draft = "My draft"
        await host.setSettings(try settings { $0["revision"] = "new_revision"; $0["routingDescription"] = "Other owner window" })
        await m.describe(); XCTAssertNil(m.pending); XCTAssertTrue(m.needsReview); XCTAssertEqual(m.draft, "My draft"); XCTAssertFalse(m.canSaveDescription)
        await m.load(); m.keepDraft(); await m.describe(); XCTAssertEqual(m.settings?.routingDescription, "My draft")
        let calls = await host.mutations; XCTAssertEqual(calls.map(\.expectedRevision), ["peers_v2", "new_revision"]); XCTAssertNotEqual(calls[0].mutationId, calls[1].mutationId)
    }
    func testPublishedLostResponseRestartSameBodyReplayWithoutNewApproval() async throws {
        let host = try PeerHost(); let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let m = model(host, journal); await m.load(); m.draft = "Independent review"; await host.losePublishedMutation(); XCTAssertTrue(m.canSaveDescription, m.message ?? "No save authority before admission"); await m.describe()
        let firstWrites = await host.mutations; XCTAssertEqual(firstWrites.count, 1, m.message ?? "No POST reached host")
        let pending = try XCTUnwrap(m.pending, "\(m.message ?? "No pending request") [storage=\(m.persistenceFailure ?? "none"), canWrite=\(m.canWrite)]"); let restored = model(host, journal); XCTAssertEqual(restored.pending, pending)
        await restored.retry(); XCTAssertNil(restored.pending); let calls = await host.mutations; XCTAssertEqual(calls.count, 2); XCTAssertEqual(calls[0], calls[1]); XCTAssertEqual(restored.settings?.routingDescription, "Independent review")
    }
    func testMatchingGETReceiptOnlySettlesExactNonceNeverMatchingDescription() async throws {
        let host = try PeerHost(); let m = model(host); await m.load(); m.draft = "Same words"; await host.failMutation(URLError(.networkConnectionLost)); await m.describe(); let nonce = m.pending!.nonce!
        await host.setSettings(try settings { $0["routingDescription"] = "Same words"; $0["revision"] = "new" }); await m.load(); XCTAssertNotNil(m.pending)
        await host.setSettings(try settings { $0["lastMutationId"] = nonce.uuidString; $0["routingDescription"] = "Saved" }); await m.load(); XCTAssertNil(m.pending); XCTAssertEqual(m.draft, "Saved")
    }
    func testFirstInFlightAndUnavailableThenDeniedRetriesRetainExactFrozenIdentity() async throws {
        for firstError in [try error("idempotency_in_flight"), try error("internal_error", status: 500)] {
            let host = try PeerHost(); let m = model(host); await m.load(); m.draft = "Keep identity"; await host.failMutation(firstError); await m.describe(); let frozen = try XCTUnwrap(m.pending)
            await host.failMutation(try error("capability_denied", status: 403)); await m.retry(); XCTAssertEqual(m.pending, frozen)
            let calls = await host.mutations; XCTAssertEqual(calls[0], calls[1])
        }
        let host = try PeerHost(); let m = model(host); await m.load(); m.draft = "Keep unavailable"; await host.setMutationReply(.rejected(code: .unavailable, error: "Host recovering", snapshot: nil)); await m.describe(); XCTAssertNotNil(m.pending)
    }
    func testPriorUnknownSurvivesLaterDefinitiveConflictNotFoundAndReadAccessLoss() async throws {
        let host = try PeerHost(); var access = true; let m = AidenBotPeersModel(botID: bot, transport: host, isCurrent: { access }); await m.load(); m.draft = "Retained"; await host.failMutation(URLError(.networkConnectionLost)); await m.describe(); let frozen = m.pending
        access = false; await m.retry(); access = true
        await host.setMutationReply(.rejected(code: .notFound, error: "Missing", snapshot: nil)); await m.retry(); XCTAssertEqual(m.pending, frozen)
        await host.setMutationReply(.rejected(code: .conflict, error: "Changed", snapshot: try settings { $0["revision"] = "new" })); await m.retry(); XCTAssertEqual(m.pending, frozen)
        let calls = await host.mutations; XCTAssertEqual(calls.count, 3); XCTAssertTrue(calls.allSatisfy { $0.mutationId == frozen?.nonce })
    }
    func testCapabilityLossAndBackgroundBlockNewOrRetriedPOSTButPreserveFrozenJournal() async throws {
        let host = try PeerHost(); var capability = true; var online = true
        let m = AidenBotPeersModel(botID: bot, transport: host, isCurrent: { capability && online }); await m.load(); m.draft = "Pending"; await host.failMutation(URLError(.networkConnectionLost)); await m.describe(); let frozen = m.pending
        capability = false; await m.retry(); capability = true; online = false; await m.retry(); online = true
        m.setActive(false); await m.retry(); m.setActive(true); await m.retry()
        let calls = await host.mutations; XCTAssertEqual(calls.count, 2); XCTAssertEqual(calls[0], calls[1]); XCTAssertNil(m.pending); XCTAssertNotNil(frozen)
    }
    func testStaleReadAndSentReplyAfterLeavingCannotAdoptOrDropPending() async throws {
        let host = try PeerHost(); let m = model(host); await host.holdNextSettings()
        let read = Task { await m.load() }; while await host.heldSettings == nil { await Task.yield() }
        m.setActive(false); m.setActive(true); await host.releaseSettings(); await read.value; XCTAssertNil(m.settings)
        await m.load(); m.draft = "Sent"; await host.holdNextMutation(); let write = Task { await m.describe() }
        while await host.heldMutation == nil { await Task.yield() }; let nonce = try XCTUnwrap(m.pending?.nonce)
        m.setActive(false); m.setActive(true); await host.releaseMutation(.accepted(snapshot: try settings { $0["lastMutationId"] = nonce.uuidString }, mutationId: nonce, replayed: false)); await write.value
        XCTAssertEqual(m.pending?.nonce, nonce, "a stale visit can't clear the already dispatched identity")
    }
    func testOrdinaryUnknownAfter23HoursNeverPostsFreshOrExpiredKey() async throws {
        let host = try PeerHost(); let m = model(host); await m.load(); m.draft = "Pending"; await host.failMutation(URLError(.networkConnectionLost)); await m.describe(); let frozen = m.pending!
        await m.retry(now: frozen.createdAt.addingTimeInterval(23 * 3600)); let calls = await host.mutations; XCTAssertEqual(calls.count, 1); XCTAssertEqual(m.pending, frozen)
    }
    func testJournalBeforeTransportAndCrossWindowCannotOverwriteUnknownOrSendAnotherChange() async throws {
        let host = try PeerHost(); let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let first = model(host, journal); let other = model(host, journal); await first.load(); await other.load()
        first.draft = "First"; await host.holdNextMutation(); let write = Task { await first.describe() }
        while await host.heldMutation == nil { await Task.yield() }
        let saved = try XCTUnwrap(journal.load(scope())?.attempt); XCTAssertEqual(saved, first.pending)
        other.draft = "Second"; await other.describe(); let calls = await host.mutations; XCTAssertEqual(calls.count, 1)
        await host.releaseMutation(.rejected(code: .unavailable, error: "Unknown", snapshot: nil)); await write.value
        XCTAssertEqual(try journal.load(scope())?.attempt, saved)
    }
    func testUnreadableJournalAndUnwritableStorageFailClosedBeforePOST() async throws {
        let host = try PeerHost(); let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let m = model(host, journal); await m.load(); m.draft = "Draft"
        try FileManager.default.removeItem(at: journal.root); try Data("blocked".utf8).write(to: journal.root)
        await m.describe(); let calls = await host.mutations; XCTAssertTrue(calls.isEmpty); XCTAssertNotNil(m.persistenceFailure)
        let restored = model(host, journal); await restored.load(); restored.draft = "New"; await restored.describe(); XCTAssertFalse(restored.canWrite)
    }
    func testAcceptedBotPurgeInvalidatesLiveControllersAndOnlyRemovesMatchingScope() async throws {
        let host = try PeerHost(); let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let m = model(host, journal); await m.load(); m.draft = "Pending"; await host.failMutation(URLError(.networkConnectionLost)); await m.describe()
        let otherScope = scope(bot: "unrelated"); let other = try settings { $0["botId"] = "unrelated" }
        try journal.save(.init(baseline: other, draft: other.routingDescription), scope: otherScope)
        journal.purge(instanceID: "host", deviceID: "phone", botID: bot); await m.retry(); m.draft = "late"; await m.describe()
        XCTAssertNil(try journal.load(scope())); XCTAssertNotNil(try journal.load(otherScope)); XCTAssertFalse(m.canWrite)
        let calls = await host.mutations; XCTAssertEqual(calls.count, 1)
    }
    func testJournalExcludesBackupAndHashesHostDeviceBotResourceScopes() throws {
        let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let state = AidenBotPeerControlStore.State(baseline: try settings(), draft: "private description")
        try journal.save(state, scope: scope())
        let url = journal.fileURL(scope()); XCTAssertFalse(url.path.contains("bot_planner")); XCTAssertFalse(url.path.contains("private description"))
        XCTAssertEqual(try journal.root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        for other in [scope(host: "elsewhere"), scope(device: "other"), scope(bot: "other"), scope("exchange_one"), scope("__settings")] { XCTAssertNil(try journal.load(other)) }
    }
    func testPeerJournalDataProtectionWhenPlatformReportsIt() throws {
        let journal = store(); let control = FileManager.default.temporaryDirectory.appending(path: "peer-protection-control-\(UUID())")
        defer { try? FileManager.default.removeItem(at: journal.root); try? FileManager.default.removeItem(at: control) }
        try Data("control".utf8).write(to: control, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        func protection(_ url: URL) throws -> String? {
            let value = try FileManager.default.attributesOfItem(atPath: url.path)[.protectionKey]
            return (value as? FileProtectionType)?.rawValue ?? value as? String
        }
        guard try protection(control) != nil else {
#if targetEnvironment(simulator)
            throw XCTSkip("Simulator omits protection metadata even for an independently protected control; signed physical verification remains required.")
#else
            return XCTFail("Physical iOS must expose the independent control’s Data Protection")
#endif
        }
        try journal.save(.init(baseline: try settings(), draft: "Private routing description"), scope: scope())
        XCTAssertEqual(try protection(journal.fileURL(scope())), FileProtectionType.completeUntilFirstUserAuthentication.rawValue)
    }
    func testStopAcceptedRequestedKeepsOriginalBodyUntilMatchingTerminalAcknowledgement() async throws {
        let host = try PeerHost(); let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let m = exchangeModel(host, journal); await m.load(); XCTAssertTrue(m.canStop, m.message ?? "No Stop authority"); await m.stop()
        let firstStops = await host.stops; XCTAssertEqual(firstStops.count, 1, m.message ?? "Stop never reached host")
        let pending = try XCTUnwrap(m.pending, "\(m.message ?? "No pending Stop") [storage=\(m.persistenceFailure ?? "none")]")
        XCTAssertEqual(m.detail?.summary.lastStop?.state, .requested); XCTAssertFalse(m.canStop)
        let restored = exchangeModel(host, journal); await restored.load(); await restored.retry(); XCTAssertEqual(restored.pending, pending)
        let stopped = try exchange("detail") { raw in raw["lastStop"] = ["mutationId": pending.nonce!.uuidString, "state": "stopped", "at": 3000]; raw["state"] = "cancelled" }
        await host.setDetail(stopped); await restored.load(); XCTAssertNil(restored.pending); XCTAssertEqual(restored.detail?.summary.state, .cancelled)
        let calls = await host.stops; XCTAssertEqual(calls.count, 2); XCTAssertEqual(calls[0], calls[1])
    }
    func testHostPendingStopWithoutLocalJournalOnlyAllowsPassiveRefresh() async throws {
        let requested = try exchange()
        let uncertain = try exchange { raw in
            raw["state"] = "running"; raw["lastStop"] = ["mutationId": UUID().uuidString, "state": "uncertain", "at": 3000]
        }
        let runningRequested = try exchange { $0["state"] = "running" }
        let stoppingWithoutReceipt = try exchange { $0.removeValue(forKey: "lastStop") }
        for pendingOnHost in [requested, uncertain, runningRequested, stoppingWithoutReceipt] {
            let host = try PeerHost(); await host.setDetail(pendingOnHost)
            let m = exchangeModel(host); await m.load()
            XCTAssertNil(m.pending); XCTAssertFalse(m.canStop)
            await m.stop(); await m.load()
            let calls = await host.stops; XCTAssertTrue(calls.isEmpty, "A host pending Stop cannot be replaced with a fresh local UUID")
            XCTAssertEqual(m.detail?.summary.state, pendingOnHost.summary.state)
        }
    }
    func testOldStopReplayUsesOriginalReceiptWithoutReportingLaterStopAsCancelled() async throws {
        let host = try PeerHost(); let m = exchangeModel(host); await m.load()
        await host.failStop(URLError(.networkConnectionLost)); await m.stop(); let original = try XCTUnwrap(m.pending?.stop)
        let laterNonce = UUID()
        await host.setDetail(try exchange { raw in
            raw["revision"] = "later_stop"; raw["lastStop"] = ["mutationId": laterNonce.uuidString, "state": "requested", "at": 4000]
        })
        await m.load(); XCTAssertEqual(m.pending?.stop, original)
        let replay = try exchange { raw in
            raw["revision"] = "fresh_later_exchange"; raw["lastStop"] = ["mutationId": original.mutationId.uuidString, "state": "stopped", "at": 3000]
        }
        await host.setStopReply(.accepted(exchange: replay, mutationId: original.mutationId, replayed: true))
        await m.retry()
        XCTAssertNil(m.pending); XCTAssertEqual(m.detail?.summary.state, .stopping); XCTAssertEqual(m.detail?.summary.revision, "fresh_later_exchange")
        XCTAssertFalse(m.canStop, "Settling the original receipt must not authorize a fresh Stop while newer linked work is stopping")
        await m.stop(); let calls = await host.stops; XCTAssertEqual(calls.count, 2); XCTAssertEqual(calls[0], calls[1])
    }
    func testStopLostReplyRestartSameRequestAndBlockedReceiptDoesNotClaimCancelled() async throws {
        let host = try PeerHost(); let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let m = exchangeModel(host, journal); await m.load(); XCTAssertTrue(m.canStop, m.message ?? "No Stop authority"); await host.losePublishedStop(); await m.stop()
        let firstStops = await host.stops; XCTAssertEqual(firstStops.count, 1, m.message ?? "Stop never reached host")
        let pending = try XCTUnwrap(m.pending, "\(m.message ?? "No pending Stop") [storage=\(m.persistenceFailure ?? "none")]")
        let restored = exchangeModel(host, journal); await restored.load(); XCTAssertEqual(restored.pending, pending)
        await host.setDetail(try exchange { raw in raw["state"] = "running"; raw["lastStop"] = ["mutationId": pending.nonce!.uuidString, "state": "blocked", "at": 3000, "reason": "mixed_inputs"] })
        await restored.load(); XCTAssertNil(restored.pending); XCTAssertEqual(restored.detail?.summary.state, .running); XCTAssertTrue(restored.message?.contains("blocked") == true)
    }
    func testStopUnknownNeverSettlesFromTerminalStateOrUnrelatedReceiptAlone() async throws {
        let host = try PeerHost(); let m = exchangeModel(host); await m.load(); await host.failStop(URLError(.networkConnectionLost)); await m.stop(); let pending = m.pending
        await host.setDetail(try exchange("detail")); await m.load(); XCTAssertEqual(m.pending, pending)
        await host.setDetail(try exchange("detail") { $0["lastStop"] = ["mutationId": UUID().uuidString, "state": "stopped", "at": 3000] }); await m.load(); XCTAssertEqual(m.pending, pending)
    }
    func testExpiredStopNoMatchingPendingGETNeverPostsButMatchingProtectedReceiptReplaysOriginalRevision() async throws {
        let host = try PeerHost(); let m = exchangeModel(host); await m.load(); await host.failStop(URLError(.networkConnectionLost)); await m.stop(); let pending = m.pending!
        let later = pending.createdAt.addingTimeInterval(25 * 3600); await m.retry(now: later)
        var calls = await host.stops; XCTAssertEqual(calls.count, 1); XCTAssertEqual(m.pending, pending)
        await host.setDetail(try exchange { $0["revision"] = "advanced"; $0["lastStop"] = ["mutationId": pending.nonce!.uuidString, "state": "uncertain", "at": 3000] }); await m.retry(now: later)
        calls = await host.stops; XCTAssertEqual(calls.count, 2); XCTAssertEqual(calls[0], calls[1]); XCTAssertEqual(calls[1].expectedRevision, "exchange_v3"); XCTAssertNotNil(m.pending)
    }
    func testExpiredStopFreshGETFailureCannotReuseEarlierProtectionProof() async throws {
        let host = try PeerHost(); let m = exchangeModel(host); await m.load(); await m.stop(); let pending = m.pending!; await m.load()
        await host.setReadError(URLError(.notConnectedToInternet)); await m.retry(now: pending.createdAt.addingTimeInterval(25 * 3600))
        let calls = await host.stops; XCTAssertEqual(calls.count, 1); XCTAssertEqual(m.pending, pending)
    }
    func testStopPriorUncertaintySurvivesDeniedRetryAndCapabilityLoss() async throws {
        let host = try PeerHost(); var cap = true; let m = AidenBotPeerExchangeModel(botID: bot, exchangeID: "exchange_one", transport: host, isCurrent: { cap })
        await m.load(); await host.failStop(try error("idempotency_in_flight")); await m.stop(); let frozen = m.pending
        cap = false; await m.retry(); cap = true; await host.failStop(try error("not_found", status: 404)); await m.retry(); XCTAssertEqual(m.pending, frozen)
        let calls = await host.stops; XCTAssertEqual(calls.count, 2); XCTAssertEqual(calls[0], calls[1])
    }
    func testEvidenceUsesHostTextExactRoleAndPreservesExchangeWhenMissing() async throws {
        let host = try PeerHost(); let m = exchangeModel(host); await m.load(); await m.loadEvidence(.source)
        XCTAssertEqual(m.evidence?.submissionId, "9007199254740993"); XCTAssertTrue(m.evidence?.text.contains("Summarize") == true)
        m.clearEvidence(); await host.setReadError(try error("not_found", status: 404)); await m.loadEvidence(.result); XCTAssertNil(m.evidence); XCTAssertNotNil(m.detail)
        await host.setReadError(nil); var raw = try peerFixture()["evidence"] as! [String: Any]; raw["botId"] = "unrelated"; await host.setEvidence(try peerDecode(AidenPeerEvidence.self, raw)); await m.loadEvidence(.source); XCTAssertNil(m.evidence)
    }
    func testPeerTranscriptMetadataRoundTripAndStrictPartialRejection() throws {
        let raw: [String: Any] = ["id": "901", "type": "peer", "exchangeId": "exchange_one", "direction": "received", "peerBotId": "bot_researcher", "peerName": "Researcher", "messageKind": "result", "createdAt": "2026-11-03T12:00:00.000Z"]
        let entry = try peerDecode(AidenBotSessionEntry.self, raw)
        guard case let .peer(peer) = entry else { return XCTFail() }; XCTAssertEqual(peer.caption, "Message from Researcher")
        XCTAssertEqual(try AidenRemoteJSONDecoder.decode(AidenBotSessionEntry.self, from: JSONEncoder().encode(entry)), entry)
        for key in ["exchangeId", "direction", "peerBotId", "peerName", "messageKind"] { var partial = raw; partial.removeValue(forKey: key); XCTAssertThrowsError(try peerDecode(AidenBotSessionEntry.self, partial)) }
        var injected = raw; injected["text"] = "Unrelated history"; XCTAssertThrowsError(try peerDecode(AidenBotSessionEntry.self, injected))
        injected = raw; injected["createdAt"] = NSNull(); XCTAssertThrowsError(try peerDecode(AidenBotSessionEntry.self, injected))
    }
    func testNormativePeerFinalFlagIsResultOnlyTrueAndNeverCarriesAuthorityOrContent() throws {
        let f = try peerFixture()
        let request = try peerDecode(AidenBotSessionEntry.self, f["peerEntry"]!)
        let final = try peerDecode(AidenBotSessionEntry.self, f["peerFinalEntry"]!)
        guard case let .peer(base) = request, case let .peer(result) = final else { return XCTFail() }
        XCTAssertFalse(base.isFinal); XCTAssertTrue(result.isFinal); XCTAssertEqual(result.messageKind, .result)
        XCTAssertEqual(result.createdAt?.rawValue, "2026-11-03T12:01:00.000Z")
        XCTAssertEqual(try AidenRemoteJSONDecoder.decode(AidenBotSessionEntry.self, from: JSONEncoder().encode(final)), final)
        var raw = f["peerFinalEntry"] as! [String: Any]; raw["final"] = false; XCTAssertThrowsError(try peerDecode(AidenBotSessionEntry.self, raw))
        raw = f["peerEntry"] as! [String: Any]; raw["final"] = true; XCTAssertThrowsError(try peerDecode(AidenBotSessionEntry.self, raw))
        raw = f["peerFinalEntry"] as! [String: Any]; raw["final"] = NSNull(); XCTAssertThrowsError(try peerDecode(AidenBotSessionEntry.self, raw))
        raw = f["peerFinalEntry"] as! [String: Any]; raw["text"] = "Private unrelated history"; XCTAssertThrowsError(try peerDecode(AidenBotSessionEntry.self, raw))
        let notification = try peerDecode(AidenBotRoutineNotification.self, f["peerNotification"]!); XCTAssertEqual(notification.kind, .peer); XCTAssertNil(notification.status)
    }
    func testPeerOpenWorkSourceAndLinksRemainClosedAndKeepLargeEvidenceIDs() throws {
        let source: [String: Any] = ["kind": "peer", "exchangeId": "exchange_one", "role": "incoming", "peerBotId": "bot_researcher", "submissionId": "9007199254740993", "entryId": "9007199254740995"]
        let parsed = try peerDecode(AidenOpenWorkSource.self, source); XCTAssertEqual(parsed.role, .incoming); XCTAssertEqual(parsed.submissionId, "9007199254740993")
        var partial = source; partial.removeValue(forKey: "entryId"); XCTAssertThrowsError(try peerDecode(AidenOpenWorkSource.self, partial))
        partial = source; partial["routineId"] = "other"; XCTAssertThrowsError(try peerDecode(AidenOpenWorkSource.self, partial))
        let link: [String: Any] = ["kind": "peer", "exchangeId": "exchange_one", "peerBotId": "bot_researcher"]
        XCTAssertEqual(try peerDecode(AidenOpenWorkLink.self, link).exchangeId, "exchange_one")
        var extra = link; extra["submissionId"] = "123"; XCTAssertThrowsError(try peerDecode(AidenOpenWorkLink.self, extra))
    }
    func testNativePeerFormAddsUnknownOutcomeControlsAndRetainsReadOnlyUnavailableChoices() async throws {
        let host = try PeerHost(); let m = model(host); await m.load()
        let controller = UIHostingController(rootView: NavigationStack { AidenBotPeersForm(model: m, botName: "Planner") { _ in Text("Exchange") } })
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844)); window.rootViewController = controller; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        func rows(_ view: UIView) -> Int {
            if let list = view as? UICollectionView { return (0..<list.numberOfSections).reduce(0) { $0 + list.numberOfItems(inSection: $1) } }
            return view.subviews.reduce(0) { $0 + rows($1) }
        }
        controller.view.layoutIfNeeded(); try await Task.sleep(for: .milliseconds(80)); let ready = rows(controller.view); XCTAssertGreaterThan(ready, 6)
        m.draft = "Review planning"; await host.failMutation(URLError(.networkConnectionLost)); await m.describe()
        try await Task.sleep(for: .milliseconds(80)); controller.view.layoutIfNeeded()
        XCTAssertGreaterThan(rows(controller.view), ready, "Unknown outcome adds explanation, refresh and exact-retry controls to the real native Form")
        XCTAssertFalse(m.canEdit); XCTAssertNotNil(m.catalog?.bots.first)
    }
    func testExchangeScopePurgeAndBackgroundNeverSendStopOrReturnOldEvidence() async throws {
        let host = try PeerHost(); let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let m = exchangeModel(host, journal); await m.load(); m.setActive(false); await m.stop(); await m.loadEvidence(.source)
        var calls = await host.stops; XCTAssertTrue(calls.isEmpty); XCTAssertNil(m.evidence)
        m.setActive(true); await host.failStop(URLError(.networkConnectionLost)); await m.stop(); XCTAssertNotNil(m.pending)
        journal.purge(instanceID: "host"); await m.retry(); await m.loadEvidence(.source); calls = await host.stops
        XCTAssertEqual(calls.count, 1); XCTAssertFalse(m.canWrite); XCTAssertNil(try journal.load(scope("exchange_one")))
    }

    func testWrongJournalScopeAndResourceNamespaceFailClosedBeforeMutation() async throws {
        let host = try PeerHost(); let journal = store(); defer { try? FileManager.default.removeItem(at: journal.root) }
        let m = AidenBotPeersModel(botID: bot, transport: host, store: journal, scope: scope(bot: "another_bot"))
        await m.load(); m.draft = "An owner description"; await m.describe()
        let calls = await host.mutations; XCTAssertTrue(calls.isEmpty); XCTAssertFalse(m.canWrite); XCTAssertNotNil(m.persistenceFailure)
        XCTAssertNotEqual(journal.fileURL(scope()), journal.fileURL(scope("__settings")), "Opaque exchange IDs cannot collide with the settings journal namespace")
    }
    func testCapabilityNegotiatesAloneAndNeverAppearsInInitialPairingVocabulary() {
        XCTAssertFalse(AidenRemoteCapability.v1Known.contains(.botPeers)); XCTAssertTrue(AidenRemoteCapability.phoneNegotiable.contains(.botPeers)); XCTAssertTrue(AidenRemoteCoordinator.capabilitiesAskedForAlone.contains([.botPeers]))
    }
}
