import Foundation
import XCTest
@testable import AidenOnTheGo

final class AidenScheduledTaskTests: XCTestCase {
    override func tearDown() {
        ScheduledMockURLProtocol.handler = nil
        super.tearDown()
    }

    func testScheduledDTORejectsInternalMetadataAndInvalidScriptHandle() throws {
        let valid = try AidenRemoteJSONDecoder.decode(
            AidenScheduledTask.self,
            from: Data(Self.taskJSON.utf8)
        )
        XCTAssertEqual(try AidenScheduledTaskValidation.tasks([valid]).first?.name, "Daily")

        let contaminatedJSON = String(Self.taskJSON.dropLast()) + #", "providerFingerprint":"private"}"#
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
            AidenScheduledTask.self,
            from: Data(contaminatedJSON.utf8)
        ))
        let invalid = AidenScheduledTask(
            id: valid.id, revision: valid.revision, name: valid.name, enabled: valid.enabled,
            schedule: valid.schedule, timezone: valid.timezone, mode: .script, permission: .full,
            workspaceId: nil, providerId: nil, modelId: nil, mcpServerIds: nil,
            scriptId: "../../unsafe.sh", prompt: nil, notify: true, running: false,
            nextRunAt: nil, lastRunAt: nil, lastResult: nil,
            createdAt: valid.createdAt, updatedAt: valid.updatedAt
        )
        XCTAssertThrowsError(try AidenScheduledTaskValidation.tasks([invalid]))
    }

    func testScheduledOfflineCacheIsInstallationScopedAndRetainsBoundedHistory() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "AidenScheduledTaskTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenScheduledTaskCache(root: root)
        let task = try AidenRemoteJSONDecoder.decode(AidenScheduledTask.self, from: Data(Self.taskJSON.utf8))
        let settings = AidenScheduledSettings(
            revision: "rev_settings", enabled: true, defaultMode: .llm,
            defaultPermission: .readOnly, defaultMcpEnabled: false,
            defaultNotify: true, defaultTimezone: "UTC"
        )
        try await cache.store(instanceId: "instance-1", tasks: [task], settings: settings)
        let runs = (0..<60).map { index in
            AidenScheduledRun(
                id: "run-\(index)", taskId: task.id, status: "succeeded",
                startedAt: Date(timeIntervalSince1970: TimeInterval(index)), finishedAt: nil,
                summary: nil, errorCode: nil
            )
        }
        try await cache.store(runs: runs, taskId: task.id, instanceId: "instance-1")

        let loaded = await cache.load(instanceId: "instance-1")
        let restored = try XCTUnwrap(loaded)
        XCTAssertEqual(restored.tasks, [task])
        XCTAssertEqual(restored.settings, settings)
        XCTAssertEqual(restored.runs[task.id]?.count, 50)
        let other = await cache.load(instanceId: "instance-2")
        XCTAssertNil(other)
    }

    func testScheduledClientUsesCanonicalRoutesRevisionsConfirmationAndStableRunKey() async throws {
        let recorder = ScheduledRequestRecorder()
        ScheduledMockURLProtocol.handler = { request in
            recorder.record(request)
            let path = request.url?.path ?? ""
            switch (request.httpMethod, path) {
            case ("GET", "/api/aiden/v1/scheduled-tasks"):
                return Self.response(request, 200, #"{"tasks":["# + Self.taskJSON + "]}")
            case ("POST", "/api/aiden/v1/scheduled-tasks"):
                return Self.response(request, 201, Self.taskJSON)
            case ("PATCH", "/api/aiden/v1/scheduled-tasks/task-1"):
                return Self.response(request, 200, Self.taskJSON)
            case ("POST", "/api/aiden/v1/scheduled-tasks/task-1/pause"):
                return Self.response(request, 202, Self.taskJSON.replacingOccurrences(of: #""enabled":true"#, with: #""enabled":false"#))
            case ("POST", "/api/aiden/v1/scheduled-tasks/task-1/run"):
                return Self.response(request, 202, #"{"taskId":"task-1","runId":"run-1","status":"accepted","acceptedAt":"2026-08-19T12:00:00.000Z"}"#)
            case ("GET", "/api/aiden/v1/scheduled-tasks/task-1/runs"):
                return Self.response(request, 200, #"{"runs":[{"id":"run-1","taskId":"task-1","status":"succeeded","startedAt":"2026-08-19T12:00:00.000Z","finishedAt":"2026-08-19T12:00:01.000Z","summary":"Done"}]}"#)
            case ("GET", "/api/aiden/v1/scheduled-tasks/scripts"):
                return Self.response(request, 200, #"{"scripts":[{"id":"script_sssssssssssssssssssssssssssssssssssssssssss","name":"daily.sh"}]}"#)
            case ("GET", "/api/aiden/v1/scheduled-tasks/mcp-servers"):
                return Self.response(request, 200, #"{"servers":[{"id":"mcp-1","name":"GitHub"}]}"#)
            case ("GET", "/api/aiden/v1/scheduled-tasks/settings"):
                return Self.response(request, 200, #"{"revision":"rev-settings","enabled":true,"defaultMode":"llm","defaultPermission":"read-only","defaultMcpEnabled":false,"defaultNotify":true,"defaultTimezone":"UTC"}"#)
            default:
                throw URLError(.unsupportedURL)
            }
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ScheduledMockURLProtocol.self]
        let client = AidenRemoteClient(
            endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
            credential: "credential",
            session: URLSession(configuration: configuration)
        )
        let mutation = AidenScheduledTaskMutation(
            name: "Daily", schedule: "0 8 * * *", timezone: "UTC", mode: .llm,
            permission: .readOnly, workspaceId: nil, providerId: "provider-1", modelId: "model-1",
            mcpServerIds: nil, scriptId: nil, prompt: "Summarize", notify: true
        )
        _ = try await client.scheduledTasks()
        _ = try await client.createScheduledTask(mutation)
        _ = try await client.updateScheduledTask(id: "task-1", revision: "rev_task_1", mutation: mutation)
        _ = try await client.pauseScheduledTask(id: "task-1", revision: "rev_task_1")
        let key = UUID()
        _ = try await client.runScheduledTask(id: "task-1", idempotencyKey: key)
        _ = try await client.runScheduledTask(id: "task-1", idempotencyKey: key)
        _ = try await client.scheduledRuns(taskId: "task-1")
        _ = try await client.scheduledScripts(workspaceId: "workspace-1")
        let mcpServers = try await client.scheduledMcpServers()
        XCTAssertEqual(mcpServers, [
            AidenScheduledMcpServer(id: "mcp-1", name: "GitHub")
        ])
        _ = try await client.scheduledSettings()

        let requests = recorder.requests
        let create = try XCTUnwrap(requests.first { $0.httpMethod == "POST" && $0.url?.path == "/api/aiden/v1/scheduled-tasks" })
        XCTAssertEqual(try Self.body(create)["confirmedForeground"] as? Bool, true)
        let update = try XCTUnwrap(requests.first { $0.httpMethod == "PATCH" && $0.url?.path.hasSuffix("/task-1") == true })
        XCTAssertEqual(update.value(forHTTPHeaderField: "If-Match"), "rev_task_1")
        let pause = try XCTUnwrap(requests.first { $0.url?.path.hasSuffix("/pause") == true })
        XCTAssertEqual(pause.value(forHTTPHeaderField: "If-Match"), "rev_task_1")
        XCTAssertNotNil(pause.value(forHTTPHeaderField: "Idempotency-Key"))
        let runKeys = requests.filter { $0.url?.path.hasSuffix("/run") == true }
            .compactMap { $0.value(forHTTPHeaderField: "Idempotency-Key") }
        XCTAssertEqual(runKeys, [key.uuidString.lowercased(), key.uuidString.lowercased()])
        let scripts = try XCTUnwrap(requests.first { $0.url?.path.hasSuffix("/scripts") == true })
        XCTAssertEqual(URLComponents(url: scripts.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "workspace-1")
        XCTAssertFalse(requests.contains { ($0.url?.absoluteString ?? "").contains("/Users/") })
    }

    private static let taskJSON = #"{"id":"task-1","revision":"rev_task_1","name":"Daily","enabled":true,"schedule":"0 8 * * *","timezone":"UTC","mode":"llm","permission":"read-only","providerId":"provider-1","modelId":"model-1","prompt":"Summarize","notify":true,"running":false,"createdAt":"2026-08-19T12:00:00.000Z","updatedAt":"2026-08-19T12:00:00.000Z"}"#

    private static func response(_ request: URLRequest, _ status: Int, _ json: String) -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data(json.utf8))
    }

    private static func body(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let body = request.httpBody {
            data = body
        } else {
            let stream = try XCTUnwrap(request.httpBodyStream)
            stream.open()
            defer { stream.close() }
            var received = Data()
            var buffer = [UInt8](repeating: 0, count: 4_096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count >= 0 else { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
                if count == 0 { break }
                received.append(buffer, count: count)
            }
            data = received
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private final class ScheduledRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [URLRequest] = []
    func record(_ request: URLRequest) { lock.lock(); stored.append(request); lock.unlock() }
    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return stored }
}

private final class ScheduledMockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (response, data) = try Self.handler?(request) ?? { throw URLError(.badServerResponse) }()
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
