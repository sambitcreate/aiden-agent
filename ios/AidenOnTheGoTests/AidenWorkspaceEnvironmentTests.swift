import CryptoKit
import Foundation
import XCTest
import UIKit
@testable import AidenOnTheGo

final class AidenWorkspaceEnvironmentTests: XCTestCase {
    func testFilesTreeExpandsFoldersAndSearchFindsCollapsedDescendants() {
        let entries = [
            AidenWorkspaceFileEntry(id: "root", displayPath: "README.md", name: "README.md", kind: .file, size: 10, language: nil),
            AidenWorkspaceFileEntry(id: "src", displayPath: "src", name: "src", kind: .directory, size: nil, language: nil),
            AidenWorkspaceFileEntry(id: "nested", displayPath: "src/views", name: "views", kind: .directory, size: nil, language: nil),
            AidenWorkspaceFileEntry(id: "file", displayPath: "src/views/page.swift", name: "page.swift", kind: .file, size: 20, language: "swift")
        ]
        XCTAssertEqual(Set(AidenWorkspaceFileTree.visible(entries, search: "", expanded: []).map(\.id)), ["root", "src"])
        XCTAssertEqual(Set(AidenWorkspaceFileTree.visible(entries, search: "", expanded: ["src"]).map(\.id)), ["root", "src", "nested"])
        XCTAssertEqual(AidenWorkspaceFileTree.visible(entries, search: "", expanded: ["src", "src/views"]).count, 4)
        XCTAssertEqual(AidenWorkspaceFileTree.visible(entries, search: "PAGE", expanded: []).map(\.id), ["file"])
        XCTAssertEqual(Set(AidenWorkspaceFileTree.visible(entries, search: "  ", expanded: []).map(\.id)), ["root", "src"])
    }

    override func tearDown() {
        EnvironmentMockURLProtocol.handler = nil
        super.tearDown()
    }

    func testNativeBrowserAddressRejectsPrivilegedSchemesCredentialsAndBadPorts() {
        for text in ["file:///etc/passwd", "javascript:alert(1)", "aiden-otg://open", "https://u:p@example.com", "http://example.com:0", "http://example.com:65536", "http://example.com\\evil"] {
            XCTAssertNil(AidenNativeBrowserAddress.url(text), text)
        }
        XCTAssertNotNil(AidenNativeBrowserAddress.url("http://100.64.1.2:3000/path?q=1#section"))
        XCTAssertNotNil(AidenNativeBrowserAddress.url("https://example.com"))
    }

    func testNativeBrowserHintRequiresBareTailscaleHostAndValidPort() {
        for host in ["localhost", "127.0.0.1", "100.63.1.2", "100.128.1.2", "100.064.1.2", "https://mac.ts.net", "mac.ts.net.evil", "mac.ts.net:3000", "-mac.ts.net"] {
            XCTAssertNil(AidenNativeBrowserAddress.developmentHost(host), host)
        }
        XCTAssertEqual(AidenNativeBrowserAddress.developmentHost("mac.tail.ts.net"), "mac.tail.ts.net")
        XCTAssertEqual(AidenNativeBrowserAddress.developmentURL(host: "100.64.1.2", port: "3000")?.absoluteString, "http://100.64.1.2:3000/")
        XCTAssertNil(AidenNativeBrowserAddress.developmentURL(host: "100.64.1.2", port: "65536"))
    }

    func testOnlyTappedHTTPDevelopmentLinksAreEligibleForWorkspaceRouting() {
        for text in ["http://100.100.10.20:3000/", "http://mac.tail.ts.net:3000/page"] {
            XCTAssertTrue(AidenNativeBrowserAddress.isDevelopmentLink(URL(string: text)!))
        }
        for text in ["https://example.com", "http://example.com", "https://mac.tail.ts.net", "http://mac.tail.ts.net.evil", "http://u:p@mac.tail.ts.net", "http://127.0.0.1:3000", "file:///tmp/page.html"] {
            XCTAssertFalse(AidenNativeBrowserAddress.isDevelopmentLink(URL(string: text)!))
        }
    }

    func testNativeBrowserLocalhostMapsOnlyWithExplicitMacHint() {
        XCTAssertNil(AidenNativeBrowserAddress.resolvedURL("http://localhost:3000/", developmentHost: nil))
        XCTAssertEqual(AidenNativeBrowserAddress.resolvedURL("http://127.0.0.1:3000/page?q=1", developmentHost: "100.100.10.20")?.absoluteString,
                       "http://100.100.10.20:3000/page?q=1")
    }

    @MainActor func testNativeBrowserHintDoesNotCreatePageAndTabsRetainWebViews() {
        let model = AidenWorkspaceBrowserModel()
        model.updateHint(serverHost: "invalid", endpoint: URL(string: "https://mac.tail.ts.net:4317"))
        XCTAssertEqual(model.developmentHost, "mac.tail.ts.net")
        XCTAssertTrue(model.tabs.isEmpty)
        model.addTab()
        let first = model.selectedTab!
        XCTAssertNil(first.webView.url)
        XCTAssertFalse(first.webView.configuration.websiteDataStore.isPersistent)
        XCTAssertTrue(first.webView.configuration.userContentController.userScripts.isEmpty)
        model.addTab()
        model.select(first)
        XCTAssertTrue(model.selectedTab?.webView === first.webView)
        model.close(first)
        XCTAssertEqual(model.tabs.count, 1)
        model.clearUnless(context: nil)
        XCTAssertTrue(model.tabs.isEmpty)
        XCTAssertNil(model.selectedTabID)
        XCTAssertTrue(model.addressInput.isEmpty)
    }

    func testServerDevelopmentHintIsOptionalAndInvalidHintDoesNotBreakConnection() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var server = try XCTUnwrap(root["server"] as? [String: Any])
        func decode() throws -> AidenServer {
            try AidenRemoteJSONDecoder.decode(AidenServer.self, from: JSONSerialization.data(withJSONObject: server))
        }
        XCTAssertEqual(try decode().developmentHost, "100.100.10.20")
        server.removeValue(forKey: "developmentHost")
        XCTAssertNil(try decode().developmentHost)
        server["developmentHost"] = ["invalid": true]
        XCTAssertNil(try decode().developmentHost)
        server["developmentHost"] = "https://evil.example"
        XCTAssertNil(try decode().developmentHost)
    }

    private func subagentFixture() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try XCTUnwrap(root["workspaceSubagents"] as? [String: Any])
    }

    private func decodeSubagents(_ value: [String: Any]) throws -> AidenWorkspaceSubagentPage {
        try AidenRemoteJSONDecoder.decode(AidenWorkspaceSubagentPage.self, from: JSONSerialization.data(withJSONObject: value))
    }

    func testSharedSubagentResourceRejectsPrivateFieldsForeignIdentityAndInvalidRuns() throws {
        let fixture = try subagentFixture()
        let page = try decodeSubagents(fixture)
        XCTAssertEqual(page.version, 1)
        XCTAssertEqual(page.runs.first?.role, .reviewer)
        XCTAssertEqual(page.runs.first?.state, .completed)
        XCTAssertNoThrow(try page.validated(workspaceID: "workspace_fixture_01", chatID: "chat_fixture_01"))
        XCTAssertThrowsError(try page.validated(workspaceID: "foreign", chatID: page.chatId))
        XCTAssertThrowsError(try page.validated(workspaceID: page.workspaceId, chatID: "foreign"))
        var invalid = fixture
        invalid["privateJournal"] = "must never cross this resource"
        XCTAssertThrowsError(try decodeSubagents(invalid))
        let run = try XCTUnwrap((fixture["runs"] as? [[String: Any]])?.first)
        for (key, badValue): (String, Any) in [
            ("id", "private-child-id"), ("label", String(repeating: "a", count: 81)),
            ("label", "Bad\nlabel"), ("role", "admin"), ("state", "invented"),
            ("revision", 0), ("startedAt", -1), ("updatedAt", 0),
            ("task", "private task instructions")
        ] {
            var badRun = run
            badRun[key] = badValue
            invalid = fixture
            invalid["runs"] = [badRun]
            XCTAssertThrowsError(try decodeSubagents(invalid), "Rejected \(key)")
        }
        invalid = fixture
        invalid["runs"] = [run, run]
        XCTAssertThrowsError(try decodeSubagents(invalid))
        invalid["runs"] = Array(repeating: run, count: 101)
        XCTAssertThrowsError(try decodeSubagents(invalid))
    }

    @MainActor
    func testLateSubagentResponseCannotRepopulateClearedSession() throws {
        let page = try decodeSubagents(subagentFixture())
        let model = AidenWorkspaceSubagentsModel(installationID: "mac-a", workspaceID: page.workspaceId, chatID: page.chatId)
        let first = model.beginLoading()
        model.clear()
        try model.accept(page, generation: first)
        XCTAssertNil(model.page)
        XCTAssertEqual(model.status, .idle)
        let current = model.beginLoading()
        try model.accept(page, generation: current)
        XCTAssertEqual(model.page, page)
        model.selectedID = page.runs.first?.id
        model.clear()
        XCTAssertNil(model.selectedID)
        XCTAssertNil(model.page)
    }

    @MainActor
    func testSubagentsRejectRunRevisionRegressionAndDuplicateJSONKeys() throws {
        let fixture = try subagentFixture()
        let page = try decodeSubagents(fixture)
        let model = AidenWorkspaceSubagentsModel(installationID: "mac-a", workspaceID: page.workspaceId, chatID: page.chatId)
        try model.accept(page, generation: model.beginLoading())
        var stale = fixture
        var run = try XCTUnwrap((fixture["runs"] as? [[String: Any]])?.first)
        run["revision"] = 1
        stale["runs"] = [run]
        XCTAssertThrowsError(try model.accept(decodeSubagents(stale), generation: model.beginLoading()))
        XCTAssertEqual(model.page?.runs.first?.revision, 2)
        let duplicate = Data("{\"version\":1,\"version\":1,\"workspaceId\":\"workspace-1\",\"chatId\":\"chat-1\",\"runs\":[],\"truncated\":false}".utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenWorkspaceSubagentPage.self, from: duplicate))
    }

    func testSubagentClientUsesBoundParentRoute() async throws {
        let fixture = try subagentFixture()
        let json = String(decoding: try JSONSerialization.data(withJSONObject: fixture), as: UTF8.self)
        EnvironmentMockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/aiden/v1/workspaces/workspace_fixture_01/chats/chat_fixture_01/subagents")
            return Self.response(request, 200, json)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EnvironmentMockURLProtocol.self]
        let client = AidenRemoteClient(endpoint: URL(string: "https://aiden.test/api/aiden/v1")!, credential: "credential",
                                       session: URLSession(configuration: configuration))
        let page = try await client.workspaceSubagents(workspaceId: "workspace_fixture_01", chatId: "chat_fixture_01")
        XCTAssertEqual(page.runs.count, 1)
    }

    func testFileRecoveryBoundAccountsForJSONExpansion() {
        XCTAssertNotNil(AidenWorkspaceFileRecovery(draft: String(repeating: "a", count: 80_000), expectedVersion: "v1").recoveryText)
        XCTAssertNil(AidenWorkspaceFileRecovery(draft: String(repeating: "\"", count: 80_000), expectedVersion: "v1").recoveryText)
        XCTAssertNil(AidenWorkspaceFileRecovery(draft: String(repeating: "a", count: 100_000), expectedVersion: "v1").recoveryText)
    }

    @MainActor
    func testRetainedGitModelRejectsAnotherInstallation() {
        let model = AidenWorkspaceGitModel(installationID: "mac-a")
        XCTAssertTrue(model.accepts(installationID: "mac-a"))
        XCTAssertFalse(model.accepts(installationID: "mac-b"))
    }

    func testFileRecoverySurvivesRelaunchWithoutCrossChatOrHostInvalidation() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AidenChatDraftStore(root: root)
        let keyA = AidenWorkspaceFileRecovery.key(workspaceID: "workspace-1", displayPath: "App.swift", chatID: "chat-a")
        let keyB = AidenWorkspaceFileRecovery.key(workspaceID: "workspace-1", displayPath: "App.swift", chatID: "chat-b")
        XCTAssertNotEqual(keyA, keyB)
        let sessionA = await store.beginSession(instanceId: "mac-a", chatId: keyA)
        let sessionB = await store.beginSession(instanceId: "mac-a", chatId: keyB)
        let record = AidenWorkspaceFileRecovery(draft: "Unsaved change", expectedVersion: "original-version")
        let encoded = String(decoding: try JSONEncoder().encode(record), as: UTF8.self)
        let savedA = try await store.save(encoded, session: sessionA)
        let savedB = try await store.save("Other chat's edit", session: sessionB)
        XCTAssertTrue(savedA, "Opening the same file in another chat must not invalidate this recovery writer")
        XCTAssertTrue(savedB)
        let relaunched = AidenChatDraftStore(root: root)
        let recoveredSession = await relaunched.beginSession(instanceId: "mac-a", chatId: keyA)
        let recovered = await relaunched.load(session: recoveredSession)
        XCTAssertEqual(try JSONDecoder().decode(AidenWorkspaceFileRecovery.self, from: Data(try XCTUnwrap(recovered).utf8)), record)
        let otherHostSession = await relaunched.beginSession(instanceId: "mac-b", chatId: keyA)
        let otherHost = await relaunched.load(session: otherHostSession)
        XCTAssertNil(otherHost)
        XCTAssertEqual(Set(try XCTUnwrap(JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: Any]).keys),
                       ["draft", "expectedVersion"], "Recovery must not persist a reusable file handle")
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
        try await cache.store(index: index, instanceId: "instance-2", workspaceId: "workspace-1")
        let loaded = await cache.load(instanceId: "instance-1", workspaceId: "workspace-1")
        XCTAssertEqual(loaded?.index, index)
        XCTAssertEqual(loaded?.documents[fileID], document)
        let otherWorkspace = await cache.load(instanceId: "instance-1", workspaceId: "workspace-2")
        let otherInstallation = await cache.load(instanceId: "instance-2", workspaceId: "workspace-1")
        XCTAssertNil(otherWorkspace)
        XCTAssertEqual(otherInstallation?.index, index)

        let legacySnapshot = AidenWorkspaceEnvironmentCache.Snapshot(
            index: index,
            documents: [:],
            updatedAt: Date(timeIntervalSince1970: 1_000)
        )
        let legacyData = try JSONEncoder().encode(legacySnapshot)
        func legacyURL(instanceId: String, workspaceId: String) -> URL {
            let digest = SHA256.hash(data: Data("\(instanceId)\u{0}\(workspaceId)".utf8))
                .map { String(format: "%02x", $0) }
                .joined()
            return directory.appending(path: "\(digest).json")
        }
        let legacyA = legacyURL(instanceId: "instance-1", workspaceId: "legacy-a")
        let legacyB = legacyURL(instanceId: "instance-2", workspaceId: "legacy-b")
        try legacyData.write(to: legacyA, options: .atomic)
        try legacyData.write(to: legacyB, options: .atomic)

        await cache.purge(instanceId: "instance-1", knownWorkspaceIds: ["legacy-a"])
        let purged = await cache.load(instanceId: "instance-1", workspaceId: "workspace-1")
        let retained = await cache.load(instanceId: "instance-2", workspaceId: "workspace-1")
        XCTAssertNil(purged)
        XCTAssertEqual(retained?.index, index)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyA.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyB.path))
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
        await model.commit(
            client: client,
            workspaceId: "workspace-1",
            message: "Update",
            stagedOnly: false,
            isCurrent: { true }
        )
        XCTAssertTrue(model.canRetryPendingMutation)
        await model.retryPendingMutation(
            client: client,
            workspaceId: "workspace-1",
            isCurrent: { true }
        )
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
