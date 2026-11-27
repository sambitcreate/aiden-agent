import Foundation
import XCTest
@testable import AidenOnTheGo

private actor ResumeUnitHost: AidenBotResumeTransport {
    var requiresUnknownCost = false
    var interruptedSubmissionId = "9007199254740993"
    var costReceiptId = "cost_" + String(repeating: "a", count: 64)
    var statusReads = 0
    var resumes: [(UUID, Bool, String?, String?)] = []
    var replies: [Result<AidenBotSessionStateView, Error>] = []
    var holdStatus = false
    var heldStatus: CheckedContinuation<AidenBotResumeStatus, Error>?

    func setRequiresUnknownCost(_ value: Bool, submissionId: String = "9007199254740993", receiptId: String = "cost_" + String(repeating: "a", count: 64)) {
        requiresUnknownCost = value
        interruptedSubmissionId = submissionId
        costReceiptId = receiptId
    }

    func queue(_ reply: Result<AidenBotSessionStateView, Error>) {
        replies.append(reply)
    }

    func holdNextStatus() { holdStatus = true }
    func releaseStatus() throws {
        heldStatus?.resume(returning: try buildStatus())
        heldStatus = nil
    }

    private func buildStatus() throws -> AidenBotResumeStatus {
        var raw: [String: Any] = ["requiresUnknownCostAcknowledgement": requiresUnknownCost]
        if requiresUnknownCost {
            raw["interruptedSubmissionId"] = interruptedSubmissionId
            raw["costReceiptId"] = costReceiptId
        }
        return try JSONDecoder().decode(
            AidenBotResumeStatus.self,
            from: JSONSerialization.data(withJSONObject: raw)
        )
    }

    func botRoutineResumeStatus(botId: String) async throws -> AidenBotResumeStatus {
        statusReads += 1
        if holdStatus {
            holdStatus = false
            return try await withCheckedThrowingContinuation { heldStatus = $0 }
        }
        return try buildStatus()
    }

    func resumeBotSession(
        botId: String,
        idempotencyKey: UUID,
        acknowledgeUnknownCost: Bool,
        expectedSubmissionId: String?,
        expectedCostReceiptId: String?
    ) async throws -> AidenBotSessionStateView {
        resumes.append((idempotencyKey, acknowledgeUnknownCost, expectedSubmissionId, expectedCostReceiptId))
        guard !replies.isEmpty else { throw URLError(.networkConnectionLost) }
        return try replies.removeFirst().get()
    }
}

@MainActor
final class AidenBotResumeModelTests: XCTestCase {
    private let botID = "bot_resume_unit"

    private func makeStore() -> AidenBotRoutineControlStore {
        AidenBotRoutineControlStore(
            root: FileManager.default.temporaryDirectory
                .appending(path: "resume-model-unit-\(UUID().uuidString)", directoryHint: .isDirectory)
        )
    }

    private func makeScope() -> AidenBotRoutineControlStore.Scope {
        .init(instanceID: "host-1", deviceID: "phone-1", botID: botID)
    }

    private func serverError(_ status: Int, _ code: String) throws -> AidenRemoteClientError {
        let body = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: Data(#"{"code":"\#(code)","message":"Refused.","requestId":"req_resume_1","retryable":false}"#.utf8)
        )
        return .server(statusCode: status, body: body)
    }

    func testUnreadableJournalFailsClosedAndPreventsLegacyResume() async throws {
        let store = makeStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let scope = makeScope()
        let url = store.fileURL(scope)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not-valid-json".utf8).write(to: url)

        let host = ResumeUnitHost()
        let model = AidenBotResumeModel(botID: botID, transport: host, store: store, scope: scope)

        XCTAssertTrue(model.preventsLegacyResume)
        XCTAssertNil(model.pending)
        XCTAssertNotNil(model.message)

        let outcome = await model.request()
        XCTAssertNil(outcome)
        let statusReads = await host.statusReads
        let resumes = await host.resumes
        XCTAssertEqual(statusReads, 0)
        XCTAssertEqual(resumes.count, 0)
    }

    func testUnwritableStorageBlocksResumeBeforeSendingToTransport() async throws {
        let store = makeStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let scope = makeScope()
        let host = ResumeUnitHost()
        let model = AidenBotResumeModel(botID: botID, transport: host, store: store, scope: scope)

        // Block writes by placing a regular file where the store directory should be.
        try? FileManager.default.removeItem(at: store.root)
        try Data("blocked".utf8).write(to: store.root)

        let outcome = await model.request()
        XCTAssertNil(outcome)
        XCTAssertTrue(model.preventsLegacyResume)
        let resumes = await host.resumes
        XCTAssertEqual(resumes.count, 0, "Persist-before-send must block transport when storage fails")
        XCTAssertNotNil(model.message)
    }

    func testStorageGenerationDriftInvalidatesLiveResumeModel() async throws {
        let store = makeStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let scope = makeScope()
        let host = ResumeUnitHost()
        let model = AidenBotResumeModel(botID: botID, transport: host, store: store, scope: scope)

        store.purge(instanceID: scope.instanceID, deviceID: scope.deviceID, botID: scope.botID)
        let outcome = await model.request()
        XCTAssertNil(outcome)
        let statusReads = await host.statusReads
        let resumes = await host.resumes
        XCTAssertEqual(statusReads, 0)
        XCTAssertEqual(resumes.count, 0)
    }

    func testSetForegroundVisitInvalidatesConsentWithoutDroppingPersistedAttempt() async throws {
        let store = makeStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let scope = makeScope()
        let host = ResumeUnitHost()
        await host.setRequiresUnknownCost(true)
        let model = AidenBotResumeModel(botID: botID, transport: host, store: store, scope: scope)

        // Preflight prompts for consent; backgrounding invalidates consent.
        let firstOutcome = await model.request()
        XCTAssertNil(firstOutcome)
        XCTAssertTrue(model.needsConsent)
        XCTAssertTrue(model.preventsLegacyResume)
        model.setForegroundVisit(active: false)
        XCTAssertFalse(model.needsConsent)
        XCTAssertFalse(model.preventsLegacyResume)
        model.setForegroundVisit(active: true)
        let staleConfirm = await model.confirm()
        XCTAssertNil(staleConfirm)
        let resumesAfterStale = await host.resumes
        XCTAssertEqual(resumesAfterStale.count, 0)

        // Fresh consent dispatches and hits 409 idempotency_in_flight -> persisted.
        await host.queue(.failure(try serverError(409, "idempotency_in_flight")))
        _ = await model.request()
        _ = await model.confirm()
        let persisted = try XCTUnwrap(model.pending)
        XCTAssertEqual(try store.load(scope)?.resume, persisted)

        // Backgrounding and returning preserves the persisted attempt.
        model.setForegroundVisit(active: false)
        XCTAssertEqual(model.pending, persisted)
        XCTAssertTrue(model.preventsLegacyResume)
        model.setForegroundVisit(active: true)
        XCTAssertEqual(model.pending, persisted)
        XCTAssertEqual(try store.load(scope)?.resume, persisted)

        // Explicit retry settles with the exact original key and receipt.
        await host.queue(.success(try AidenBotSessionStateView(state: .running)))
        let settled = await model.request()
        XCTAssertNotNil(settled)
        XCTAssertNil(model.pending)
        XCTAssertNil(try store.load(scope))
        let sent = await host.resumes
        XCTAssertEqual(sent.map { $0.0 }, [persisted.key, persisted.key])
        XCTAssertEqual(sent.map { $0.3 }, [persisted.expectedCostReceiptId, persisted.expectedCostReceiptId])
    }

    func testPreviouslyUnknownStickinessAndExpiredAgeCap() async throws {
        let host = ResumeUnitHost()
        await host.queue(.failure(try serverError(409, "idempotency_in_flight")))
        let model = AidenBotResumeModel(botID: botID, transport: host)

        _ = await model.request()
        let frozen = try XCTUnwrap(model.pending)

        // Subsequent definite refusal must NOT clear an already-unknown attempt.
        await host.queue(.failure(try serverError(403, "capability_denied")))
        _ = await model.request()
        XCTAssertEqual(model.pending, frozen)
        let sent = await host.resumes
        XCTAssertEqual(sent.map { $0.0 }, [frozen.key, frozen.key])

        // An adopted attempt >= 23h old is refused for replay without sending.
        let expiredModel = AidenBotResumeModel(botID: botID, transport: host)
        let oldKey = UUID()
        expiredModel.adoptOrdinaryPending(key: oldKey, createdAt: Date().addingTimeInterval(-(23 * 3600 + 60)))
        XCTAssertTrue(expiredModel.preventsLegacyResume)
        let expiredResult = await expiredModel.request()
        XCTAssertNil(expiredResult)
        XCTAssertEqual(expiredModel.pending?.key, oldKey)
        let sentAfterExpired = await host.resumes
        XCTAssertEqual(sentAfterExpired.count, 2)
    }

    func testAdoptOrdinaryPendingDoesNotOverwriteExistingPendingAndPreventsLegacyResume() async throws {
        let store = makeStore()
        defer { try? FileManager.default.removeItem(at: store.root) }
        let scope = makeScope()
        let host = ResumeUnitHost()
        let model = AidenBotResumeModel(botID: botID, transport: host, store: store, scope: scope)

        XCTAssertFalse(model.preventsLegacyResume)
        let firstKey = UUID()
        let secondKey = UUID()
        model.adoptOrdinaryPending(key: firstKey, createdAt: Date())
        XCTAssertEqual(model.pending?.key, firstKey)
        XCTAssertTrue(model.preventsLegacyResume)
        XCTAssertEqual(try store.load(scope)?.resume?.key, firstKey)

        // Second adoption is ignored while a pending attempt already exists.
        model.adoptOrdinaryPending(key: secondKey, createdAt: Date())
        XCTAssertEqual(model.pending?.key, firstKey)
        XCTAssertEqual(try store.load(scope)?.resume?.key, firstKey)

        // In-flight preflight also prevents legacy resume.
        let freshModel = AidenBotResumeModel(botID: botID, transport: host)
        await host.holdNextStatus()
        let task = Task { await freshModel.request() }
        let deadline = Date().addingTimeInterval(2)
        while await host.heldStatus == nil, Date() < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(freshModel.preventsLegacyResume)
        try await host.releaseStatus()
        _ = await task.value
    }
}
