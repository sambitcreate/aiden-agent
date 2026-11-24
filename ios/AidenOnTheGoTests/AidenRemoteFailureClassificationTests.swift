import Foundation
import XCTest
@testable import AidenOnTheGo

private struct ClassificationUnexpectedError: Error {}

private func classificationServerError(_ status: Int, _ code: String, retryable: Bool = false) throws -> AidenRemoteClientError {
    let body = try AidenRemoteJSONDecoder.decode(
        AidenRemoteErrorEnvelope.Body.self,
        from: Data(#"{"code":"\#(code)","message":"Refused.","requestId":"req_cls_1","retryable":\#(retryable)}"#.utf8)
    )
    return .server(statusCode: status, body: body)
}

private func classificationDecode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
    try AidenRemoteJSONDecoder.decode(type, from: JSONSerialization.data(withJSONObject: value))
}

private actor ClassificationOpenWorkHost: AidenBotOpenWorkTransport {
    let snapshot: AidenOpenWorkSnapshot
    var writes: [AidenOpenWorkMutation] = []
    var reply: Result<AidenOpenWorkResult, Error>
    init(snapshot: AidenOpenWorkSnapshot, reply: Result<AidenOpenWorkResult, Error>) {
        self.snapshot = snapshot
        self.reply = reply
    }
    func botOpenWork(botId: String) async throws -> AidenOpenWorkSnapshot { snapshot }
    func mutateBotOpenWork(botId: String, mutation: AidenOpenWorkMutation) async throws -> AidenOpenWorkResult {
        writes.append(mutation)
        return try reply.get()
    }
    func botOpenWorkEvidence(botId: String, itemId: String, kind: AidenOpenWorkEvidenceKind) async throws -> AidenOpenWorkEvidence {
        throw URLError(.resourceUnavailable)
    }
}

private actor ClassificationWatchHost: AidenBotWatchTransport {
    let list: AidenBotWatchList
    let sources: AidenBotWatchSources
    var saves: [(String?, AidenBotWatchSaveRequest)] = []
    var saveResult: Result<AidenBotWatch, Error>
    init(list: AidenBotWatchList, sources: AidenBotWatchSources, saveResult: Result<AidenBotWatch, Error>) {
        self.list = list
        self.sources = sources
        self.saveResult = saveResult
    }
    func botWatches(botId: String) async throws -> AidenBotWatchList { list }
    func discoverBotWatchSources(botId: String) async throws -> AidenBotWatchSources { sources }
    func saveBotWatch(botId: String, id: String?, request: AidenBotWatchSaveRequest) async throws -> AidenBotWatch {
        saves.append((id, request))
        return try saveResult.get()
    }
    func setBotWatchEnabled(botId: String, id: String, request: AidenBotWatchActionRequest) async throws -> AidenBotWatch {
        throw URLError(.networkConnectionLost)
    }
    func removeBotWatch(botId: String, id: String, request: AidenBotWatchActionRequest) async throws -> AidenBotWatchRemoval {
        throw URLError(.networkConnectionLost)
    }
    func testBotWatch(botId: String, request: AidenBotWatchTestRequest) async throws -> AidenBotWatchTestResult {
        throw URLError(.networkConnectionLost)
    }
    func runBotWatch(botId: String, id: String, request: AidenBotWatchActionRequest) async throws -> AidenBotWatchRunResult {
        throw URLError(.networkConnectionLost)
    }
}

private actor ClassificationRoutineModelsHost: AidenBotRoutineModelsTransport {
    let settings: AidenRoutineModelSettings
    let catalog: AidenRoutineModelCatalog
    var saves: [AidenRoutineModelSave] = []
    var saveResult: Result<AidenRoutineModelResult, Error>
    init(settings: AidenRoutineModelSettings, catalog: AidenRoutineModelCatalog, saveResult: Result<AidenRoutineModelResult, Error>) {
        self.settings = settings
        self.catalog = catalog
        self.saveResult = saveResult
    }
    func routineModelSettings(botId: String, routineId: String) async throws -> AidenRoutineModelSettings { settings }
    func routineModelCatalog(botId: String, routineId: String) async throws -> AidenRoutineModelCatalog { catalog }
    func routineModelRuns(botId: String, routineId: String) async throws -> [AidenRoutineModelRun] { [] }
    func saveRoutineModel(_ request: AidenRoutineModelSave) async throws -> AidenRoutineModelResult {
        saves.append(request)
        return try saveResult.get()
    }
}

private actor ClassificationPeersHost: AidenBotPeersTransport {
    let settings: AidenPeerSettings
    let catalog: AidenPeerCatalog
    let detail: AidenPeerExchangeDetail
    var mutations: [AidenPeerMutation] = []
    var stops: [AidenPeerStopMutation] = []
    let error: Error
    init(settings: AidenPeerSettings, catalog: AidenPeerCatalog, detail: AidenPeerExchangeDetail, error: Error) {
        self.settings = settings
        self.catalog = catalog
        self.detail = detail
        self.error = error
    }
    func botPeerSettings(botId: String) async throws -> AidenPeerSettings { settings }
    func botPeerCatalog(botId: String) async throws -> AidenPeerCatalog { catalog }
    func mutateBotPeers(_ request: AidenPeerMutation) async throws -> AidenPeerMutationResult {
        mutations.append(request)
        throw error
    }
    func botPeerExchanges(botId: String) async throws -> AidenPeerExchangeList {
        try classificationDecode(AidenPeerExchangeList.self, ["botId": botId, "revision": "list_v1", "exchanges": []])
    }
    func botPeerExchange(botId: String, exchangeId: String) async throws -> AidenPeerExchangeDetail { detail }
    func stopBotPeerExchange(_ request: AidenPeerStopMutation) async throws -> AidenPeerStopResult {
        stops.append(request)
        throw error
    }
    func botPeerEvidence(botId: String, exchangeId: String, kind: AidenOpenWorkEvidenceKind) async throws -> AidenPeerEvidence {
        throw URLError(.resourceUnavailable)
    }
}

private actor ClassificationResumeHost: AidenBotResumeTransport {
    var resumes: [UUID] = []
    let error: Error
    init(error: Error) { self.error = error }
    func botRoutineResumeStatus(botId: String) async throws -> AidenBotResumeStatus {
        try JSONDecoder().decode(
            AidenBotResumeStatus.self,
            from: Data(#"{"requiresUnknownCostAcknowledgement":false}"#.utf8)
        )
    }
    func resumeBotSession(
        botId: String,
        idempotencyKey: UUID,
        acknowledgeUnknownCost: Bool,
        expectedSubmissionId: String?,
        expectedCostReceiptId: String?
    ) async throws -> AidenBotSessionStateView {
        resumes.append(idempotencyKey)
        throw error
    }
}

@MainActor
final class AidenRemoteFailureClassificationTests: XCTestCase {
    func testTier1BeforeEffectRefusalSitesAgreeOnAmbiguityAnd409InFlight() throws {
        let tier1Sites: [(String, (Error) -> Bool)] = [
            ("beforeEffectRefusal", { AidenRemoteFailureClassification.isAmbiguous($0, policy: .beforeEffectRefusal()) }),
            ("aidenBotResumeFailureIsAmbiguous", aidenBotResumeFailureIsAmbiguous),
            ("aidenPeerFailureIsAmbiguous", aidenPeerFailureIsAmbiguous),
            ("aidenBotSessionFailureIsAmbiguous", aidenBotSessionFailureIsAmbiguous),
            ("aidenBotEditorCreateFailureIsAmbiguous", aidenBotEditorCreateFailureIsAmbiguous),
            ("aidenBotAvatarMutationFailureIsAmbiguous", aidenBotAvatarMutationFailureIsAmbiguous),
            ("aidenBotConversationCreateFailureIsAmbiguous", aidenBotConversationCreateFailureIsAmbiguous),
        ]

        let mustBeAmbiguous: [(String, Error)] = [
            ("409 idempotency_in_flight", try classificationServerError(409, "idempotency_in_flight")),
            ("400 operation_in_progress", try classificationServerError(400, "operation_in_progress")),
            ("403 internal_error", try classificationServerError(403, "internal_error")),
            ("409 internal_error", try classificationServerError(409, "internal_error")),
            ("409 server_interrupted", try classificationServerError(409, "server_interrupted")),
            ("500 internal_error", try classificationServerError(500, "internal_error")),
            ("503 internal_error", try classificationServerError(503, "internal_error")),
            ("408 internal_error", try classificationServerError(408, "internal_error")),
            ("429 rate_limited", try classificationServerError(429, "rate_limited", retryable: true)),
            ("200 invalid_request", try classificationServerError(200, "invalid_request")),
            ("CancellationError", CancellationError()),
            ("URLError(.timedOut)", URLError(.timedOut)),
            ("non-AidenRemoteClientError", ClassificationUnexpectedError()),
            ("invalidResponse", AidenRemoteClientError.invalidResponse),
            ("unexpectedStatus(400)", AidenRemoteClientError.unexpectedStatus(400)),
            ("unexpectedStatus(409)", AidenRemoteClientError.unexpectedStatus(409)),
            ("unexpectedStatus(502)", AidenRemoteClientError.unexpectedStatus(502)),
        ]

        let mustBeDefinite: [(String, Error)] = [
            ("400 invalid_request", try classificationServerError(400, "invalid_request")),
            ("401 authentication_required", try classificationServerError(401, "authentication_required")),
            ("401 credential_revoked", try classificationServerError(401, "credential_revoked")),
            ("403 capability_denied", try classificationServerError(403, "capability_denied")),
            ("404 not_found", try classificationServerError(404, "not_found")),
            ("409 operation_stale", try classificationServerError(409, "operation_stale")),
            ("409 revision_conflict", try classificationServerError(409, "revision_conflict")),
            ("409 bot_paused", try classificationServerError(409, "bot_paused")),
            ("409 idempotency_conflict", try classificationServerError(409, "idempotency_conflict")),
            ("409 handle_invalid", try classificationServerError(409, "handle_invalid")),
            ("409 approval_already_resolved", try classificationServerError(409, "approval_already_resolved")),
            ("422 memory_blocked", try classificationServerError(422, "memory_blocked")),
            ("invalidEndpoint", AidenRemoteClientError.invalidEndpoint),
            ("missingCredential", AidenRemoteClientError.missingCredential),
            ("missingTrustConfiguration", AidenRemoteClientError.missingTrustConfiguration),
            ("installationChanged", AidenRemoteClientError.installationChanged),
        ]

        for (siteName, classifier) in tier1Sites {
            for (label, error) in mustBeAmbiguous {
                XCTAssertTrue(classifier(error), "\(siteName) must treat \(label) as ambiguous")
            }
            for (label, error) in mustBeDefinite {
                XCTAssertFalse(classifier(error), "\(siteName) must treat \(label) as non-ambiguous")
            }
        }
    }

    func testBotSessionMessageFailureTreats409InFlightAsAmbiguousAndReplayed409InternalErrorAsSettled() throws {
        XCTAssertTrue(AidenBotSessionModel.messageFailureIsAmbiguous(try classificationServerError(409, "idempotency_in_flight")))
        XCTAssertTrue(AidenBotSessionModel.messageFailureIsAmbiguous(try classificationServerError(500, "internal_error")))
        XCTAssertTrue(AidenBotSessionModel.messageFailureIsAmbiguous(try classificationServerError(503, "internal_error")))
        XCTAssertTrue(AidenBotSessionModel.messageFailureIsAmbiguous(try classificationServerError(408, "internal_error")))
        XCTAssertTrue(AidenBotSessionModel.messageFailureIsAmbiguous(try classificationServerError(429, "rate_limited")))
        XCTAssertTrue(AidenBotSessionModel.messageFailureIsAmbiguous(CancellationError()))
        XCTAssertTrue(AidenBotSessionModel.messageFailureIsAmbiguous(URLError(.networkConnectionLost)))
        XCTAssertTrue(AidenBotSessionModel.messageFailureIsAmbiguous(AidenRemoteClientError.invalidResponse))
        XCTAssertTrue(AidenBotSessionModel.messageFailureIsAmbiguous(AidenRemoteClientError.unexpectedStatus(409)))

        // Per protocol/aiden-remote/v1/fixtures/bot-outbox-delivery.json ("a settled rejection replayed").
        XCTAssertFalse(AidenBotSessionModel.messageFailureIsAmbiguous(try classificationServerError(409, "internal_error")))
        XCTAssertFalse(AidenBotSessionModel.messageFailureIsAmbiguous(try classificationServerError(409, "idempotency_conflict")))
        XCTAssertFalse(AidenBotSessionModel.messageFailureIsAmbiguous(try classificationServerError(409, "handle_invalid")))
        XCTAssertFalse(AidenBotSessionModel.messageFailureIsAmbiguous(try classificationServerError(400, "invalid_request")))
        XCTAssertFalse(AidenBotSessionModel.messageFailureIsAmbiguous(AidenRemoteClientError.installationChanged))
    }

    func testTier2CachedRejectionLedgerSitesAgreeAndNeverDropKeysOnCancellationOrInFlight() throws {
        let gitModel = AidenWorkspaceGitModel()
        let tier2Sites: [(String, @MainActor (Error) -> Bool)] = [
            ("cachedRejectionLedger", { AidenRemoteFailureClassification.isAmbiguous($0, policy: .cachedRejectionLedger) }),
            ("AidenRemoteCoordinator.isAmbiguousMutationError", { AidenRemoteCoordinator.isAmbiguousMutationError($0) }),
            ("AidenScheduledTasksModel.isAmbiguous", { AidenScheduledTasksModel.isAmbiguous($0) }),
            ("AidenWorkspaceGitModel.shouldRetainForReconciliation", { gitModel.shouldRetainForReconciliation($0) }),
            ("AidenChatForkAttempt.outcomeIsUnknown", { AidenChatForkAttempt.outcomeIsUnknown(after: $0) }),
        ]

        let mustRetain: [(String, Error)] = [
            ("CancellationError", CancellationError()),
            ("URLError(.timedOut)", URLError(.timedOut)),
            ("non-AidenRemoteClientError", ClassificationUnexpectedError()),
            ("invalidResponse", AidenRemoteClientError.invalidResponse),
            ("unexpectedStatus(502)", AidenRemoteClientError.unexpectedStatus(502)),
            ("unexpectedStatus(409)", AidenRemoteClientError.unexpectedStatus(409)),
            ("409 idempotency_in_flight", try classificationServerError(409, "idempotency_in_flight")),
        ]

        let mustNotRetain: [(String, Error)] = [
            ("400 invalid_request", try classificationServerError(400, "invalid_request")),
            ("403 capability_denied", try classificationServerError(403, "capability_denied")),
            ("404 not_found", try classificationServerError(404, "not_found")),
            ("409 revision_conflict", try classificationServerError(409, "revision_conflict")),
            ("409 operation_in_progress", try classificationServerError(409, "operation_in_progress")),
            ("409 git_capability_denied", try classificationServerError(409, "git_capability_denied")),
            ("409 schedule_disabled", try classificationServerError(409, "schedule_disabled")),
            ("500 internal_error", try classificationServerError(500, "internal_error")),
            ("invalidEndpoint", AidenRemoteClientError.invalidEndpoint),
            ("missingCredential", AidenRemoteClientError.missingCredential),
            ("missingTrustConfiguration", AidenRemoteClientError.missingTrustConfiguration),
            ("installationChanged", AidenRemoteClientError.installationChanged),
        ]

        for (siteName, classifier) in tier2Sites {
            for (label, error) in mustRetain {
                XCTAssertTrue(classifier(error), "\(siteName) must retain key for \(label)")
            }
            for (label, error) in mustNotRetain {
                XCTAssertFalse(classifier(error), "\(siteName) must release key for \(label)")
            }
        }

        // Site 12: AidenNewWorktreeRetry.spendsKey(_:) spends only structured non-in-flight server refusals.
        for (label, error) in mustRetain {
            XCTAssertFalse(AidenNewWorktreeRetry.spendsKey(error), "spendsKey must keep key for \(label)")
        }
        XCTAssertTrue(AidenNewWorktreeRetry.spendsKey(try classificationServerError(409, "git_capability_denied")))
        XCTAssertTrue(AidenNewWorktreeRetry.spendsKey(try classificationServerError(500, "internal_error")))
        XCTAssertTrue(AidenNewWorktreeRetry.spendsKey(try classificationServerError(400, "invalid_request")))
        XCTAssertFalse(AidenNewWorktreeRetry.spendsKey(AidenRemoteClientError.missingCredential))
        XCTAssertFalse(AidenNewWorktreeRetry.spendsKey(AidenRemoteClientError.installationChanged))
    }

    func testOpenWorkRetainsPendingStateOn409IdempotencyInFlight() async throws {
        let botID = "bot_openwork_409"
        let item: [String: Any] = [
            "id": "item.one", "revision": "item-1", "title": "Review brief", "note": "Check details",
            "state": "open", "createdAt": 1000, "updatedAt": 1000,
            "source": ["kind": "person", "submissionId": "9007199254740993", "entryId": "9007199254740995"],
            "links": [["kind": "source", "submissionId": "9007199254740993", "entryId": "9007199254740995"]],
            "execution": ["state": "idle", "canStop": false],
        ]
        let snapshot = try classificationDecode(
            AidenOpenWorkSnapshot.self,
            ["botId": botID, "revision": "snapshot-1", "items": [item], "undo": []]
        )
        let host = ClassificationOpenWorkHost(
            snapshot: snapshot,
            reply: .failure(try classificationServerError(409, "idempotency_in_flight"))
        )
        let model = AidenBotOpenWorkModel(botID: botID, transport: host)
        await model.load()
        model.begin()
        model.draft?.title = "Follow up on launch"
        await model.saveDraft()

        XCTAssertTrue(model.uncertain, "409 idempotency_in_flight from POST /open-work must retain pending state")
        await model.retryPending()
        let writes = await host.writes
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes[0], writes[1], "Retry must replay the exact mutation identity")
    }

    func testWatchRetainsPendingStateOn409IdempotencyInFlight() async throws {
        let botID = "bot_watch_409"
        let sourceID = "22222222-2222-4222-8222-222222222222"
        let templates: [[String: Any]] = [
            ["id": "mail_messages", "kind": "email", "title": "Mail", "description": "Watch mail.",
             "available": true, "intervals": [15, 30, 60]],
        ]
        let list = try classificationDecode(
            AidenBotWatchList.self,
            ["supported": true, "templates": templates, "watches": []]
        )
        let sources = try classificationDecode(
            AidenBotWatchSources.self,
            ["choices": [["id": sourceID, "templateId": "mail_messages", "providerLabel": "Mail",
                          "accountLabel": "Work", "resourceLabel": "Inbox", "available": true]],
             "unavailableReasons": []]
        )
        let host = ClassificationWatchHost(
            list: list,
            sources: sources,
            saveResult: .failure(try classificationServerError(409, "idempotency_in_flight"))
        )
        let model = AidenBotWatchModel(botID: botID, transport: host)
        await model.load()
        model.begin()
        model.draft?.name = "Urgent mail"
        model.draft?.prompt = "Alert me"
        await model.discover()
        model.draft?.sourceChoiceID = sourceID
        await model.saveDraft()

        XCTAssertTrue(model.uncertain, "409 idempotency_in_flight on watch mutation must retain pending state")
        await model.retryPending()
        let saves = await host.saves
        XCTAssertEqual(saves.count, 2)
        XCTAssertEqual(saves[0].1, saves[1].1)
    }

    func testRoutineModelsRetainsPendingStateOn409IdempotencyInFlight() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bot-routine-models", withExtension: "json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var rawSettings = try XCTUnwrap(fixture["inherit"] as? [String: Any])
        rawSettings.removeValue(forKey: "lastMutationId")
        let settings = try classificationDecode(AidenRoutineModelSettings.self, rawSettings)
        let catalog = try classificationDecode(AidenRoutineModelCatalog.self, try XCTUnwrap(fixture["catalog"]))
        let host = ClassificationRoutineModelsHost(
            settings: settings,
            catalog: catalog,
            saveResult: .failure(try classificationServerError(409, "idempotency_in_flight"))
        )
        let model = AidenBotRoutineModelsModel(botID: settings.botId, routineID: settings.routineId, transport: host)
        await model.load()
        model.select(AidenRoutineModelChoice(providerId: "provider_1", modelId: "model_a", thinkingLevel: .high), fallback: false)
        await model.save()

        let frozen = try XCTUnwrap(model.pending, "409 idempotency_in_flight must retain pending routine model mutation")
        await model.retry()
        let saves = await host.saves
        XCTAssertEqual(saves.count, 2)
        XCTAssertEqual(saves[0], frozen.request)
        XCTAssertEqual(saves[1], frozen.request)
    }

    func testPeersAndResumeRetainPendingStateOn409IdempotencyInFlight() async throws {
        let peerURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bot-peers", withExtension: "json"))
        let peerFixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: peerURL)) as? [String: Any])
        let peerSettings = try classificationDecode(AidenPeerSettings.self, try XCTUnwrap(peerFixture["settings"]))
        let peerCatalog = try classificationDecode(AidenPeerCatalog.self, try XCTUnwrap(peerFixture["catalog"]))
        var rawDetail = try XCTUnwrap(peerFixture["detail"] as? [String: Any])
        rawDetail["canStop"] = true
        rawDetail["state"] = "running"
        rawDetail.removeValue(forKey: "result")
        let peerDetail = try classificationDecode(AidenPeerExchangeDetail.self, rawDetail)
        let inFlight = try classificationServerError(409, "idempotency_in_flight")

        let peersHost = ClassificationPeersHost(settings: peerSettings, catalog: peerCatalog, detail: peerDetail, error: inFlight)
        let peersModel = AidenBotPeersModel(botID: peerSettings.botId, transport: peersHost)
        await peersModel.load()
        peersModel.draft = "Updated routing"
        await peersModel.describe()
        XCTAssertNotNil(peersModel.pending)

        let exchangeModel = AidenBotPeerExchangeModel(botID: peerSettings.botId, exchangeID: peerDetail.id, transport: peersHost)
        await exchangeModel.load()
        await exchangeModel.stop()
        XCTAssertNotNil(exchangeModel.pending)

        let resumeHost = ClassificationResumeHost(error: inFlight)
        let resumeModel = AidenBotResumeModel(botID: "bot_resume_409", transport: resumeHost)
        _ = await resumeModel.request()
        let frozenResume = try XCTUnwrap(resumeModel.pending)
        _ = await resumeModel.request()
        let resumeKeys = await resumeHost.resumes
        XCTAssertEqual(resumeKeys, [frozenResume.key, frozenResume.key])
    }
}
