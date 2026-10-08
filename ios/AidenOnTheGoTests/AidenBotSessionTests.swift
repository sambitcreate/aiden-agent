import XCTest
@testable import AidenOnTheGo

/// The Bot chat's quick-reply question: the snapshot and `question` events show
/// it, and answering posts once and clears it.
@MainActor
final class AidenBotSessionTests: XCTestCase {
    private let botID = "bot_fixture_01"
    private let waitID = "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c"
    private let questionJSON = """
    {"waitId":"5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c","toolCallId":"call_1","questions":[{"question":"Which colour should the banner use?","header":"Colour","multiSelect":false,"options":[{"label":"Blue","description":"Calm and cool."},{"label":"Red","description":"Loud and warm."}]}]}
    """

    private func session(question: String) throws -> AidenBotSession {
        let json = """
        {"botId":"bot_fixture_01","epoch":"epoch_1","seq":0,"state":"running","interrupted":false,"entries":[],"hasOlder":false,"question":\(question)}
        """
        return try JSONDecoder().decode(AidenBotSession.self, from: Data(json.utf8))
    }

    private func event(question: String, seq: Int) throws -> AidenBotSessionEvent {
        let json = """
        {"protocolVersion":1,"botId":"bot_fixture_01","epoch":"epoch_1","seq":\(seq),"type":"question","payload":{"question":\(question)}}
        """
        return try JSONDecoder().decode(AidenBotSessionEvent.self, from: Data(json.utf8))
    }

    func testSnapshotQuestionIsAnsweredOnceAndClearsWhenTheMacReceipts() async throws {
        let transport = QuestionTransport(snapshot: try session(question: questionJSON))
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        await model.load()
        XCTAssertEqual(model.question?.waitId, waitID)
        XCTAssertTrue(model.canAnswerQuestion)

        let answer = AidenQuestionRespondRequest(cancelled: false, answers: [.option(questionIndex: 0, answer: "Blue")])
        await model.answerQuestion(answer)

        XCTAssertEqual(transport.answers.map(\.waitId), [waitID])
        XCTAssertEqual(transport.answers.first?.request, answer)
        XCTAssertNil(model.question)
        XCTAssertFalse(model.canAnswerQuestion)
    }

    func testQuestionEventsShowAndSettleTheWaitingQuestion() async throws {
        let transport = QuestionTransport(snapshot: try session(question: "null"))
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        await model.load()
        XCTAssertNil(model.question)

        await model.apply(try event(question: questionJSON, seq: 1))
        XCTAssertEqual(model.question?.waitId, waitID)

        await model.apply(try event(question: "null", seq: 2))
        XCTAssertNil(model.question)
        XCTAssertTrue(transport.answers.isEmpty, "a settled question is not answered by the phone")
    }
}

/// A transport that serves one snapshot and records quick-reply answers.
private final class QuestionTransport: AidenBotSessionTransport, @unchecked Sendable {
    let snapshot: AidenBotSession
    private(set) var answers: [(waitId: String, key: UUID, request: AidenQuestionRespondRequest)] = []

    init(snapshot: AidenBotSession) {
        self.snapshot = snapshot
    }

    func botSession(botId: String) async throws -> AidenBotSession { snapshot }

    func botSessionEvents(botId: String) -> AsyncThrowingStream<AidenBotSessionEvent, Error> {
        AsyncThrowingStream { continuation in continuation.finish() }
    }

    func sendBotMessage(
        botId: String,
        request: AidenBotMessageRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotMessageReceipt {
        throw URLError(.unsupportedURL)
    }

    func resumeBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        throw URLError(.unsupportedURL)
    }

    func dismissBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        throw URLError(.unsupportedURL)
    }

    func stopBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        throw URLError(.unsupportedURL)
    }

    func answerBotQuestion(
        botId: String,
        waitId: String,
        request: AidenQuestionRespondRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotQuestionAnswerReceipt {
        answers.append((waitId, idempotencyKey, request))
        return try JSONDecoder().decode(
            AidenBotQuestionAnswerReceipt.self,
            from: Data("{\"waitId\":\"\(waitId)\"}".utf8)
        )
    }

    func requestBotConnection(
        botId: String,
        request: AidenBotConnectionRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotConnectionRequestReceipt {
        throw URLError(.unsupportedURL)
    }
}
