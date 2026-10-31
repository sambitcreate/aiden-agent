import Foundation
import XCTest
@testable import AidenOnTheGo

/// Revision 48 (`chat:jobs`): a chat's background jobs on the phone, against
/// a transport that behaves like the Mac's job registry.
@MainActor
final class AidenBackgroundJobsTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func job(
        _ id: String,
        state: AidenBackgroundJob.State = .running,
        exitCode: Int? = nil,
        endReason: String? = nil,
        fromCommand: Bool = false,
        ports: [Int] = []
    ) -> AidenBackgroundJob {
        AidenBackgroundJob(
            id: id,
            label: "Run the dev server",
            state: state,
            startedAt: start,
            endedAt: state == .running ? nil : start.addingTimeInterval(60),
            exitCode: exitCode,
            endReason: endReason,
            fromCommand: fromCommand,
            ports: ports
        )
    }

    func testTheWordsMatchTheMac() {
        let now = start.addingTimeInterval(125)
        XCTAssertEqual(AidenBackgroundJobCopy.status(job("job_00000001"), now: now), "Running for 2m")
        XCTAssertEqual(AidenBackgroundJobCopy.status(job("job_00000001"), now: start.addingTimeInterval(3_900)), "Running for 1h 5m")
        XCTAssertEqual(AidenBackgroundJobCopy.status(job("job_00000001", state: .failed, exitCode: 1), now: now), "Failed with code 1")
        XCTAssertEqual(AidenBackgroundJobCopy.status(job("job_00000001", state: .exited, exitCode: 0), now: now), "Finished")
        XCTAssertEqual(AidenBackgroundJobCopy.status(job("job_00000001", state: .exited, fromCommand: true), now: now), "Ended")
        XCTAssertEqual(AidenBackgroundJobCopy.status(job("job_00000001", state: .stopped, endReason: "person"), now: now), "Stopped")
        XCTAssertEqual(
            AidenBackgroundJobCopy.status(job("job_00000001", state: .stopped, endReason: "output-limit"), now: now),
            "Stopped: too much output"
        )
        XCTAssertEqual(
            AidenBackgroundJobCopy.addresses(job("job_00000001", ports: [5173, 24678])),
            "localhost:5173, localhost:24678 on your Mac"
        )
        XCTAssertNil(AidenBackgroundJobCopy.addresses(job("job_00000001")))
        XCTAssertNil(AidenBackgroundJobCopy.chip(running: 0), "nothing shows while nothing runs")
        XCTAssertEqual(AidenBackgroundJobCopy.chip(running: 2), "2 in background")
        XCTAssertEqual(AidenBackgroundJobCopy.chipAccessibilityLabel(running: 1), "1 background job running")
    }

    func testStopEndsTheJobAndAJobTheMacNoLongerHasRereadsTheList() async {
        let mac = FakeJobsMac(jobs: [job("job_1a2b3c4d", ports: [5173]), job("job_00000001", state: .failed, exitCode: 1)])
        let model = AidenBackgroundJobsModel()
        await model.refresh(chatId: "chat-1", transport: mac)
        XCTAssertEqual(model.runningCount, 1)

        await model.stop("job_1a2b3c4d", transport: mac)
        XCTAssertEqual(model.runningCount, 0)
        XCTAssertEqual(model.jobs.first?.state, .stopped)
        XCTAssertEqual(model.jobs.first?.ports, [], "a stopped job serves nothing")
        XCTAssertTrue(model.stoppingJobIds.isEmpty)

        // The Mac restarted and forgot a job this phone still shows.
        await mac.forget()
        await model.stop("job_00000001", transport: mac)
        XCTAssertEqual(model.jobs, [])
        XCTAssertNil(model.errorMessage, "a job that is already gone is not an error")
    }

    func testAPhoneWithoutTheGrantOrAnotherChatShowsNothingStale() async {
        let mac = FakeJobsMac(jobs: [job("job_1a2b3c4d")])
        let model = AidenBackgroundJobsModel()
        await model.refresh(chatId: "chat-1", transport: mac)
        XCTAssertEqual(model.jobs.count, 1)
        await model.refresh(chatId: "chat-1", transport: nil)
        XCTAssertEqual(model.jobs, [])
        await model.refresh(chatId: "chat-1", transport: mac)
        await model.refresh(chatId: "chat-2", transport: FailingJobsMac())
        XCTAssertEqual(model.jobs, [], "another chat never shows this chat's jobs")
    }
}

private actor FakeJobsMac: AidenBackgroundJobTransport {
    private var jobs: [AidenBackgroundJob]

    init(jobs: [AidenBackgroundJob]) {
        self.jobs = jobs
    }

    func forget() {
        jobs = []
    }

    func backgroundJobs(chatId: String) async throws -> AidenBackgroundJobs {
        AidenBackgroundJobs(jobs: chatId == "chat-1" ? jobs : [])
    }

    func stopBackgroundJob(chatId: String, jobId: String) async throws -> AidenBackgroundJobs {
        guard let index = jobs.firstIndex(where: { $0.id == jobId }) else {
            throw AidenRemoteClientError.server(
                statusCode: 404,
                body: try AidenRemoteJSONDecoder.decode(
                    AidenRemoteErrorEnvelope.self,
                    from: Data(#"{"error":{"code":"not_found","message":"This chat has no such background job.","requestId":"request_1","retryable":false}}"#.utf8)
                ).error
            )
        }
        let job = jobs[index]
        jobs[index] = AidenBackgroundJob(
            id: job.id,
            label: job.label,
            state: .stopped,
            startedAt: job.startedAt,
            endedAt: job.startedAt.addingTimeInterval(300),
            endReason: "person"
        )
        return AidenBackgroundJobs(jobs: jobs)
    }
}

private struct FailingJobsMac: AidenBackgroundJobTransport {
    func backgroundJobs(chatId: String) async throws -> AidenBackgroundJobs {
        throw URLError(.timedOut)
    }

    func stopBackgroundJob(chatId: String, jobId: String) async throws -> AidenBackgroundJobs {
        throw URLError(.timedOut)
    }
}
