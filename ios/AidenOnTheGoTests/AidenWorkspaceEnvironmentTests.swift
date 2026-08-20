import Foundation
import XCTest
@testable import AidenOnTheGo

final class AidenWorkspaceEnvironmentTests: XCTestCase {
    override func tearDown() {
        EnvironmentMockURLProtocol.handler = nil
        super.tearDown()
    }

    func testFileAndGitDTOsRejectUnsafeOrUnboundServerData() throws {
        let fileID = "file_\(String(repeating: "f", count: 43))"
        let index = try AidenRemoteJSONDecoder.decode(
            AidenWorkspaceFileIndex.self,
            from: Data("""
            {"snapshotId":"files-1","entries":[{"id":"\(fileID)","displayPath":"Sources/App.swift","name":"App.swift","kind":"file","size":12,"language":"Swift"}],"truncated":false,"maxEntries":4000,"maxDepth":20}
            """.utf8)
        )
        XCTAssertNoThrow(try AidenWorkspaceEnvironmentValidation.validated(index))

        let escaped = AidenWorkspaceFileIndex(
            snapshotId: "files-2",
            entries: [.init(id: fileID, displayPath: "../Secret", name: "Secret", kind: .file, size: nil, language: nil)],
            truncated: false,
            maxEntries: 4_000,
            maxDepth: 20
        )
        XCTAssertThrowsError(try AidenWorkspaceEnvironmentValidation.validated(escaped))

        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
            AidenWorkspaceFileIndex.self,
            from: Data("""
            {"snapshotId":"files-1","entries":[],"truncated":false,"maxEntries":4000,"maxDepth":20,"repositoryPath":"/private/project"}
            """.utf8)
        ))
    }

    func testEnvironmentCacheIsInstallationAndWorkspaceScoped() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = AidenWorkspaceEnvironmentCache(directory: directory)
        let fileID = "file_\(String(repeating: "f", count: 43))"
        let index = AidenWorkspaceFileIndex(
            snapshotId: "files-1",
            entries: [.init(id: fileID, displayPath: "App.swift", name: "App.swift", kind: .file, size: 14, language: "Swift")],
            truncated: false,
            maxEntries: 4_000,
            maxDepth: 20
        )
        let document = AidenWorkspaceFileDocument(
            id: fileID,
            displayPath: "App.swift",
            content: "let value = 1\n",
            version: "version-1",
            truncated: false,
            warning: nil
        )
        try await cache.store(index: index, instanceId: "instance-1", workspaceId: "workspace-1")
        try await cache.store(document: document, instanceId: "instance-1", workspaceId: "workspace-1")
        let loaded = await cache.load(instanceId: "instance-1", workspaceId: "workspace-1")
        XCTAssertEqual(loaded?.index, index)
        XCTAssertEqual(loaded?.documents[fileID], document)
        let otherWorkspace = await cache.load(instanceId: "instance-1", workspaceId: "workspace-2")
        let otherInstallation = await cache.load(instanceId: "instance-2", workspaceId: "workspace-1")
        XCTAssertNil(otherWorkspace)
        XCTAssertNil(otherInstallation)
    }

    func testClientUsesOpaqueFileRoutesAndConfirmedGitMutationHeaders() async throws {
        let fileID = "file_\(String(repeating: "f", count: 43))"
        let snapshotID = "snap_\(String(repeating: "s", count: 43))"
        let recorder = EnvironmentRequestRecorder()
        EnvironmentMockURLProtocol.handler = { request in
            recorder.record(request)
            let path = request.url?.path ?? ""
            switch (request.httpMethod, path) {
            case ("GET", "/api/aiden/v1/workspaces/workspace-1/files"):
                return Self.response(request, 200, """
                {"snapshotId":"files-1","entries":[{"id":"\(fileID)","displayPath":"App.swift","name":"App.swift","kind":"file","size":14}],"truncated":false,"maxEntries":4000,"maxDepth":20}
                """)
            case ("GET", "/api/aiden/v1/workspaces/workspace-1/files/\(fileID)"):
                return Self.response(request, 200, """
                {"id":"\(fileID)","displayPath":"App.swift","content":"let value = 1\\n","version":"version-1","truncated":false}
                """)
            case ("PUT", "/api/aiden/v1/workspaces/workspace-1/files/\(fileID)"):
                return Self.response(request, 200, """
                {"id":"\(fileID)","displayPath":"App.swift","content":"let value = 2\\n","version":"version-2","truncated":false}
                """)
            case ("GET", "/api/aiden/v1/workspaces/workspace-1/git/review"):
                return Self.response(request, 200, """
                {"operationId":"op_review","status":"snapshot","snapshotId":"\(snapshotID)","result":{"kind":"review","branch":"main","uncommitted":1,"files":[{"id":"\(fileID)","displayPath":"App.swift","status":"modified","staged":false,"additions":1,"deletions":1}]}}
                """)
            case ("POST", "/api/aiden/v1/workspaces/workspace-1/git/worktrees"):
                return Self.response(request, 202, """
                {"operationId":"op_create","status":"succeeded","result":{"kind":"mutation","message":"Created managed worktree.","branch":"feature/mobile","workspaceId":"workspace-2"}}
                """)
            case ("DELETE", "/api/aiden/v1/workspaces/workspace-2/git/managed-worktree"):
                return Self.response(request, 202, """
                {"operationId":"op_delete","status":"succeeded","result":{"kind":"mutation","message":"Removed managed worktree.","workspaceId":"workspace-2"}}
                """)
            default:
                throw URLError(.unsupportedURL)
            }
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EnvironmentMockURLProtocol.self]
        let client = AidenRemoteClient(
            endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
            credential: "credential",
            session: URLSession(configuration: configuration)
        )

        _ = try await client.workspaceFiles(workspaceId: "workspace-1")
        let document = try await client.workspaceFile(workspaceId: "workspace-1", fileId: fileID)
        _ = try await client.writeWorkspaceFile(
            workspaceId: "workspace-1",
            fileId: fileID,
            content: "let value = 2\n",
            expectedVersion: document.version
        )
        _ = try await client.gitReview(workspaceId: "workspace-1")
        _ = try await client.createGitWorktree(
            workspaceId: "workspace-1",
            branch: "feature/mobile",
            name: "Mobile"
        )
        _ = try await client.deleteManagedGitWorktree(workspaceId: "workspace-2", revision: "revision-2")

        let requests = recorder.requests
        let write = try XCTUnwrap(requests.first { $0.httpMethod == "PUT" })
        XCTAssertEqual(try Self.jsonBody(write)["expectedVersion"] as? String, "version-1")
        let create = try XCTUnwrap(requests.first { $0.httpMethod == "POST" && $0.url?.path.hasSuffix("/git/worktrees") == true })
        XCTAssertNotNil(create.value(forHTTPHeaderField: "Idempotency-Key"))
        XCTAssertEqual(try Self.jsonBody(create)["confirmedForeground"] as? Bool, true)
        let remove = try XCTUnwrap(requests.first { $0.httpMethod == "DELETE" })
        XCTAssertEqual(remove.value(forHTTPHeaderField: "If-Match"), "revision-2")
        XCTAssertNotNil(remove.value(forHTTPHeaderField: "Idempotency-Key"))
        XCTAssertEqual(try Self.jsonBody(remove)["confirmedForeground"] as? Bool, true)
        XCTAssertFalse(requests.contains { ($0.url?.absoluteString ?? "").contains("private") })
    }

    @MainActor
    func testGitMutationReconnectReusesOriginalIdempotencyKey() async throws {
        let snapshotID = "snap_\(String(repeating: "s", count: 43))"
        let recorder = EnvironmentRequestRecorder()
        let attempts = EnvironmentAttemptCounter()
        EnvironmentMockURLProtocol.handler = { request in
            recorder.record(request)
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST", path.hasSuffix("/git/commit") {
                if attempts.increment() == 1 { throw URLError(.networkConnectionLost) }
                return Self.response(request, 202, """
                {"operationId":"op_commit","status":"succeeded","result":{"kind":"mutation","message":"Committed reviewed changes.","branch":"main","commitId":"abc"}}
                """)
            }
            if request.httpMethod == "GET", path.hasSuffix("/git/review") {
                return Self.response(request, 200, """
                {"operationId":"op_review","status":"snapshot","snapshotId":"\(snapshotID)","result":{"kind":"review","branch":"main","uncommitted":0,"files":[]}}
                """)
            }
            if request.httpMethod == "GET", path.hasSuffix("/git/branches") {
                return Self.response(request, 200, """
                {"operationId":"op_branches","status":"snapshot","snapshotId":"\(snapshotID)","result":{"kind":"branches","current":"main","branches":["main"]}}
                """)
            }
            if request.httpMethod == "GET", path.hasSuffix("/git/worktrees") {
                return Self.response(request, 200, """
                {"operationId":"op_worktrees","status":"snapshot","result":{"kind":"worktrees","worktrees":[]}}
                """)
            }
            throw URLError(.unsupportedURL)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EnvironmentMockURLProtocol.self]
        let client = AidenRemoteClient(
            endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
            credential: "credential",
            session: URLSession(configuration: configuration)
        )
        let model = AidenWorkspaceGitModel()
        model.reviewSnapshotId = snapshotID
        await model.commit(client: client, workspaceId: "workspace-1", message: "Update", stagedOnly: false)
        XCTAssertTrue(model.canRetryPendingMutation)
        await model.retryPendingMutation(client: client, workspaceId: "workspace-1")
        XCTAssertFalse(model.canRetryPendingMutation)
        XCTAssertEqual(model.lastMessage, "Committed reviewed changes.")

        let keys = recorder.requests
            .filter { $0.httpMethod == "POST" && $0.url?.path.hasSuffix("/git/commit") == true }
            .compactMap { $0.value(forHTTPHeaderField: "Idempotency-Key") }
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(Set(keys).count, 1)
    }

    private static func response(_ request: URLRequest, _ status: Int, _ json: String) -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data(json.utf8))
    }

    private static func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let body = request.httpBody {
            data = body
        } else {
            let stream = try XCTUnwrap(request.httpBodyStream)
            stream.open()
            defer { stream.close() }
            var value = Data()
            var buffer = [UInt8](repeating: 0, count: 4_096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                value.append(buffer, count: count)
            }
            data = value
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private final class EnvironmentRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [URLRequest] = []

    func record(_ request: URLRequest) {
        lock.lock()
        stored.append(request)
        lock.unlock()
    }

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

private final class EnvironmentAttemptCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }
}

private final class EnvironmentMockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let (response, data) = try Self.handler?(request) ?? { throw URLError(.badServerResponse) }()
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
