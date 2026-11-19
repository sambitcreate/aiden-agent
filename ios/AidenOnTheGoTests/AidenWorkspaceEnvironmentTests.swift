import CryptoKit
import Foundation
import XCTest
@testable import AidenOnTheGo

final class AidenWorkspaceEnvironmentTests: XCTestCase {
    @MainActor
    func testCommitAvailabilityRetainsTheHostReviewPermission() async throws {
        let snapshotID = "snap_\(String(repeating: "s", count: 43))"
        for capability in [#""capability":{"allowed":false,"reason":"A file could not be shown."},"#,
                           #""capability":{"allowed":true},"#, ""] {
            let recorder = EnvironmentRequestRecorder()
            EnvironmentMockURLProtocol.handler = { request in
                recorder.record(request)
                let path = request.url?.path ?? ""
                if path.hasSuffix("/git/review") {
                    return Self.response(request, 200, """
                    {"operationId":"op_review","status":"snapshot","snapshotId":"\(snapshotID)",\(capability)
                     "result":{"kind":"review","branch":"main","uncommitted":2,"files":[{"id":"file_\(String(repeating: "f", count: 43))","displayPath":"README.md","status":"modified"}]}}
                    """)
                }
                if path.hasSuffix("/git/branches") {
                    return Self.response(request, 200, """
                    {"operationId":"op_branches","status":"snapshot","snapshotId":"\(snapshotID)","result":{"kind":"branches","current":"main","branches":["main"]}}
                    """)
                }
                if path.hasSuffix("/git/worktrees") {
                    return Self.response(request, 200, #"{"operationId":"op_worktrees","status":"snapshot","result":{"kind":"worktrees","worktrees":[]}}"#)
                }
                throw URLError(.unsupportedURL)
            }
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [EnvironmentMockURLProtocol.self]
            let client = AidenRemoteClient(endpoint: URL(string: "https://aiden.test/api/aiden/v1")!, credential: "credential", session: URLSession(configuration: configuration))
            let model = AidenWorkspaceGitModel()
            await model.refresh(client: client, workspaceId: "workspace-1", isCurrent: { true })
            XCTAssertNil(model.errorMessage)
            if capability.contains("true") {
                XCTAssertTrue(model.canCommitReviewedChanges)
                XCTAssertNil(model.commitUnavailableReason)
                model.isLoading = true
                XCTAssertFalse(model.canCommitReviewedChanges)
                model.isLoading = false
                model.reviewSnapshotId = nil
                XCTAssertFalse(model.canCommitReviewedChanges)
            } else {
                XCTAssertFalse(model.canCommitReviewedChanges)
                XCTAssertEqual(model.commitUnavailableReason, capability.isEmpty ? "Commit is unavailable for this review." : "A file could not be shown.")
                await model.commit(client: client, workspaceId: "workspace-1", message: "Update", stagedOnly: false, isCurrent: { true })
                XCTAssertFalse(recorder.requests.contains { $0.httpMethod == "POST" })
            }
        }
    }

    @MainActor
    func testHiddenChangesAreNeitherCleanNorCommittable() throws {
        let model = AidenWorkspaceGitModel()
        model.review = try AidenRemoteJSONDecoder.decode(
            AidenGitReview.self,
            from: Data(#"{"kind":"review","branch":"main","uncommitted":2,"files":[]}"#.utf8)
        )
        model.reviewSnapshotId = "snapshot-1"
        model.commitCapability = AidenGitCapability(allowed: false, reason: "A file could not be shown.")

        XCTAssertEqual(model.hiddenChangeCount, 2)
        XCTAssertFalse(model.canCommitReviewedChanges)
        XCTAssertEqual(model.commitUnavailableReason, "Commit is unavailable because these changes are hidden. A file could not be shown.")

        model.commitCapability = AidenGitCapability(allowed: true, reason: nil)
        XCTAssertFalse(model.canCommitReviewedChanges)
        XCTAssertEqual(model.commitUnavailableReason, "Commit is unavailable because these changes are hidden.")

        model.review = try AidenRemoteJSONDecoder.decode(
            AidenGitReview.self,
            from: Data(#"{"kind":"review","branch":"main","uncommitted":0,"files":[]}"#.utf8)
        )
        XCTAssertNil(model.hiddenChangeCount)
        XCTAssertNil(model.commitUnavailableReason)
    }

    func testGitReviewPreservesUnavailableLineCounts() throws {
        let data = Data(#"{"kind":"review","branch":"main","uncommitted":2,"files":[{"id":"known","displayPath":"small.txt","status":"untracked","additions":3,"deletions":0},{"id":"unknown","displayPath":"budgeted.txt","status":"untracked"}]}"#.utf8)
        let review = try AidenRemoteJSONDecoder.decode(AidenGitReview.self, from: data)
        XCTAssertEqual(review.files[0].additions, 3)
        XCTAssertEqual(review.files[0].deletions, 0)
        XCTAssertNil(review.files[1].additions)
        XCTAssertNil(review.files[1].deletions)
    }

    @MainActor
    func testCachedDocumentDoesNotDisableLiveTreePaging() {
        let model = AidenWorkspaceFilesModel(workspace: AidenWorkspace(
            id: "workspace", name: "Workspace", permission: .ask, hasFolder: true,
            isManagedWorktree: false, branchName: nil, repositoryName: nil, git: nil,
            createdAt: .now, updatedAt: .now, revision: "r1"
        ), owner: AidenRemoteRequestContext(instanceId: "mac", deviceId: "phone", generation: 1, scope: .owner))
        model.isOfflineIndex = false
        model.isOfflineDocument = true
        XCTAssertTrue(model.canLoadPage)
        XCTAssertFalse(model.canEditDocument)
        model.isOfflineIndex = true
        model.isOfflineDocument = false
        XCTAssertFalse(model.canLoadPage)
        XCTAssertTrue(model.canEditDocument)
    }

    func testLazyTreeVisibilitySearchAndBoundedPreview() {
        let entries: [AidenWorkspaceFileEntry] = [
            .init(id: "dir", displayPath: "src", name: "src", kind: .directory, size: nil, language: nil),
            .init(id: "file", displayPath: "src/main.swift", name: "main.swift", kind: .file, size: nil, language: nil)
        ]
        XCTAssertEqual(AidenWorkspaceFileTree.visible(entries, expanded: [], search: "").map(\.id), ["dir"])
        XCTAssertEqual(AidenWorkspaceFileTree.visible(entries, expanded: ["src"], search: "").count, 2)
        XCTAssertEqual(AidenWorkspaceFileTree.visible(entries, expanded: [], search: "main").count, 2)
        XCTAssertTrue(AidenWorkspaceFileTree.visible(entries, expanded: [], search: "missing").isEmpty)
        XCTAssertEqual(AidenWorkspaceSourcePreview.lines(String(repeating: "line\n", count: 10_000)).count, 2_001)
        XCTAssertTrue(AidenWorkspaceSourcePreview.lines(String(repeating: "x", count: 10_000))[0].hasSuffix("[line clipped]"))
    }

    func testWorkspaceLinksNeverAcceptOutsidePathsOrSchemes() {
        XCTAssertEqual(AidenWorkspaceFileLink.path("./src/hello%20world.swift"), "src/hello world.swift")
        for value in ["../secret", "./../secret", "./%2e%2e/secret", "./%2Fsecret", "file:///secret", "/secret", "~/secret", "https://example.com", "./a%00b", "./a\\b", "./a#L2", "./a?x=y", "./a//b"] {
            XCTAssertNil(AidenWorkspaceFileLink.path(value), value)
        }
    }

    func testLazyPageContractRejectsForeignChildrenAndBadCursors() throws {
        var page = AidenWorkspaceFileIndex(snapshotId: "page", entries: [], truncated: false, maxEntries: 4_000, maxDepth: 20, directoryPath: "")
        XCTAssertNoThrow(try AidenWorkspaceEnvironmentValidation.validatedPage(page))
        page.nextCursor = "../secret"
        XCTAssertThrowsError(try AidenWorkspaceEnvironmentValidation.validatedPage(page))
        page.nextCursor = nil
        page.directoryPath = "../secret"
        XCTAssertThrowsError(try AidenWorkspaceEnvironmentValidation.validatedPage(page))
    }

    func testSharedLazyPageFixtureDecodes() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let data = try JSONSerialization.data(withJSONObject: XCTUnwrap(root["filePage"]))
        let page = try AidenRemoteJSONDecoder.decode(AidenWorkspaceFileIndex.self, from: data)
        XCTAssertNoThrow(try AidenWorkspaceEnvironmentValidation.validatedPage(page))
        XCTAssertEqual(page.entries.first?.kind, .directory)
    }

    func testRelativeLinksCacheWithoutIndexAndSurvivePartialRefresh() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = AidenWorkspaceEnvironmentCache(directory: directory)
        let document = AidenWorkspaceFileDocument(id: "file_" + String(repeating: "a", count: 43), displayPath: "src/App.swift", content: "cached", version: "v1", truncated: false, warning: nil)
        try await cache.store(document: document, instanceId: "mac", workspaceId: "workspace")
        try await cache.store(index: AidenWorkspaceFileIndex(snapshotId: "fresh", entries: [], truncated: false, maxEntries: 4_000, maxDepth: 20, directoryPath: ""), instanceId: "mac", workspaceId: "workspace")
        let cached = await cache.document(reference: "./src/App.swift", instanceId: "mac", workspaceId: "workspace")
        XCTAssertEqual(cached, document)
        let other = await cache.document(reference: "./src/App.swift", instanceId: "other", workspaceId: "workspace")
        XCTAssertNil(other)
        let escape = await cache.document(reference: "./../src/App.swift", instanceId: "mac", workspaceId: "workspace")
        XCTAssertNil(escape)
    }

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

    func testLazySaveAcceptsRotatedHandleAndRebindsTreeEntry() throws {
        let oldID = "file_\(String(repeating: "a", count: 43))"
        let newID = "file_\(String(repeating: "b", count: 43))"
        let otherID = "file_\(String(repeating: "c", count: 43))"
        let saved = AidenWorkspaceFileDocument(
            id: newID, displayPath: "Sources/App.swift", content: "x", version: "v2", truncated: false, warning: nil
        )
        XCTAssertEqual(try AidenWorkspaceEnvironmentValidation.validatedSave(saved, expectedDisplayPath: "Sources/App.swift"), saved)
        XCTAssertThrowsError(try AidenWorkspaceEnvironmentValidation.validatedSave(saved, expectedDisplayPath: "Sources/Other.swift"))
        let unsafe = AidenWorkspaceFileDocument(
            id: "../escape", displayPath: "Sources/App.swift", content: "x", version: "v2", truncated: false, warning: nil
        )
        XCTAssertThrowsError(try AidenWorkspaceEnvironmentValidation.validatedSave(unsafe, expectedDisplayPath: "Sources/App.swift"))

        var index = AidenWorkspaceFileIndex(
            snapshotId: "files-1",
            entries: [
                .init(id: oldID, displayPath: "Sources/App.swift", name: "App.swift", kind: .file, size: 1, language: "Swift"),
                .init(id: otherID, displayPath: "Sources/Other.swift", name: "Other.swift", kind: .file, size: nil, language: nil),
            ],
            truncated: false, maxEntries: 4_000, maxDepth: 20
        )
        index.directoryPath = ""
        let rebound = index.rebinding(fileID: oldID, to: newID)
        XCTAssertEqual(rebound.entries.map(\.id), [newID, otherID])
        XCTAssertEqual(rebound.entries[0].displayPath, "Sources/App.swift")
        XCTAssertEqual(rebound.entries[0].language, "Swift")
        XCTAssertEqual(rebound.directoryPath, "")
        XCTAssertEqual(index.rebinding(fileID: oldID, to: oldID), index)
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
        let savedFileID = "file_\(String(repeating: "g", count: 43))"
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
                // Lazy saves install a new inode and return a fresh handle.
                return Self.response(request, 200, """
                {"id":"\(savedFileID)","displayPath":"App.swift","content":"let value = 2\\n","version":"version-2","truncated":false}
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
        let saved = try await client.writeWorkspaceFile(
            workspaceId: "workspace-1",
            fileId: fileID,
            displayPath: document.displayPath,
            content: "let value = 2\n",
            expectedVersion: document.version
        )
        XCTAssertEqual(saved.id, savedFileID)
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
        model.review = AidenGitReview(kind: "review", branch: "main", uncommitted: 1, files: [AidenGitFile(id: "visible", displayPath: "README.md", status: .modified, staged: false, additions: nil, deletions: nil)])
        model.commitCapability = AidenGitCapability(allowed: true, reason: nil)
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

    @MainActor
    func testStaleLazyHandlesRecoverOnceReplaceTreeIDsAndPreserveOpenDraftsAndCache() async throws {
        for (status, code) in [(400, "handle_invalid"), (410, "handle_expired")] {
            let directory = FileManager.default.temporaryDirectory
                .appending(path: "AidenStaleFiles-\(UUID().uuidString)", directoryHint: .isDirectory)
            defer { try? FileManager.default.removeItem(at: directory) }
            let cache = AidenWorkspaceEnvironmentCache(directory: directory)
            let responder = AidenDemoResponder()
            let installation = AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop")
            let coordinator = AidenDemoHosts.coordinator(
                installations: [installation],
                responder: responder,
                workspaceEnvironmentCache: cache,
                machinePreferences: AidenMachinePreferencesStore(defaults: AidenDemoHosts.isolatedDefaults())
            )
            let scheduler = AidenHostConnectScheduler(
                registry: coordinator.hosts,
                pathChanges: AsyncStream { _ in },
                maxConcurrentConnects: 2,
                probeTimeout: 30
            )
            await coordinator.start()
            await scheduler.foregrounded()
            for _ in 0..<50 where coordinator.hosts.connection(for: "laptop")?.connectionState != .connected {
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertEqual(coordinator.hosts.connection(for: "laptop")?.connectionState, .connected)

            let staleDirID = "file_\(String(repeating: "a", count: 43))"
            let freshDirID = "file_\(String(repeating: "b", count: 43))"
            let staleFileID = "file_\(String(repeating: "c", count: 43))"
            let freshFileID = "file_\(String(repeating: "d", count: 43))"
            let openDocID = "file_\(String(repeating: "e", count: 43))"
            let staleCursor = "cur_\(String(repeating: "f", count: 43))"
            let staleErrorJSON = Data("""
            {"error":{"code":"\(code)","message":"Stale handle.","requestId":"req_stale","retryable":false}}
            """.utf8)

            let putCalls = EnvironmentAttemptCounter()
            responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1", status: 200, json: Data("""
            {"snapshotId":"root-1","entries":[
              {"id":"\(staleDirID)","displayPath":"src","name":"src","kind":"directory"},
              {"id":"\(staleFileID)","displayPath":"README.md","name":"README.md","kind":"file"},
              {"id":"\(openDocID)","displayPath":"Notes.md","name":"Notes.md","kind":"file"}
            ],"truncated":false,"maxEntries":4000,"maxDepth":20,"directoryPath":""}
            """.utf8))
            responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files/\(openDocID)", status: 200, json: Data("""
            {"id":"\(openDocID)","displayPath":"Notes.md","content":"original\\n","version":"\(String(repeating: "1", count: 64))","truncated":false}
            """.utf8))
            responder.reply(instanceId: "laptop", method: "PUT", path: "/workspaces/ws-1/files/\(openDocID)", status: status, json: { _ in
                _ = putCalls.increment()
                return staleErrorJSON
            })

            let workspace = AidenWorkspace(
                id: "ws-1", name: "Workspace", permission: .ask, hasFolder: true,
                isManagedWorktree: false, branchName: nil, repositoryName: nil, git: nil,
                createdAt: .now, updatedAt: .now, revision: "r1"
            )
            let owner = try coordinator.ownerContext(for: "laptop")
            let model = AidenWorkspaceFilesModel(workspace: workspace, owner: owner, cache: cache)

            await model.load(coordinator: coordinator)
            let notesEntry = try XCTUnwrap(model.index?.entries.first { $0.displayPath == "Notes.md" })
            let openedNotes = await model.open(notesEntry, coordinator: coordinator)
            XCTAssertTrue(openedNotes)
            model.draft = "unsaved draft\n"

            // 1. Stale folder expansion refreshes root once, replaces stale IDs, prompts reopen, and preserves open draft + cache.
            let filesRequestsBefore = responder.requests(instanceId: "laptop").filter { $0 == "GET /workspaces/ws-1/files" }.count
            responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1&directory=\(staleDirID)", status: status, json: staleErrorJSON)
            responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1", status: 200, json: Data("""
            {"snapshotId":"root-2","entries":[
              {"id":"\(freshDirID)","displayPath":"src","name":"src","kind":"directory"},
              {"id":"\(staleFileID)","displayPath":"README.md","name":"README.md","kind":"file"},
              {"id":"\(openDocID)","displayPath":"Notes.md","name":"Notes.md","kind":"file"}
            ],"truncated":false,"maxEntries":4000,"maxDepth":20,"directoryPath":""}
            """.utf8))
            let staleSrc = try XCTUnwrap(model.index?.entries.first { $0.displayPath == "src" })
            await model.toggle(staleSrc, coordinator: coordinator)
            // 1 failed directory page GET + 1 root refresh GET = +2 GET /workspaces/ws-1/files requests.
            XCTAssertEqual(responder.requests(instanceId: "laptop").filter { $0 == "GET /workspaces/ws-1/files" }.count, filesRequestsBefore + 2)
            XCTAssertFalse(model.expanded.contains("src"))
            XCTAssertEqual(model.errorMessage, AidenWorkspaceFilesModel.staleFolderRecoveryMessage)
            XCTAssertEqual(model.index?.entries.first(where: { $0.displayPath == "src" })?.id, freshDirID)
            XCTAssertEqual(model.document?.id, openDocID)
            XCTAssertEqual(model.draft, "unsaved draft\n")

            // Reopening src with the refreshed handle succeeds and yields a continuation cursor.
            let childStaleID = "file_\(String(repeating: "g", count: 43))"
            responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1&directory=\(freshDirID)", status: 200, json: Data("""
            {"snapshotId":"src-1","entries":[{"id":"\(childStaleID)","displayPath":"src/App.swift","name":"App.swift","kind":"file"}],
             "truncated":false,"maxEntries":4000,"maxDepth":20,"directoryPath":"src","nextCursor":"\(staleCursor)"}
            """.utf8))
            let freshSrc = try XCTUnwrap(model.index?.entries.first { $0.displayPath == "src" })
            await model.toggle(freshSrc, coordinator: coordinator)
            XCTAssertTrue(model.expanded.contains("src"))
            XCTAssertEqual(model.cursors["src"], staleCursor)

            // 2. Stale continuation cursor drops stale src/App.swift ID instead of merging duplicate paths, refreshes root once.
            let filesRequestsBeforeCursor = responder.requests(instanceId: "laptop").filter { $0 == "GET /workspaces/ws-1/files" }.count
            responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1&directory=\(freshDirID)&cursor=\(staleCursor)", status: status, json: staleErrorJSON)
            await model.loadPage(directory: freshSrc, coordinator: coordinator)
            XCTAssertEqual(responder.requests(instanceId: "laptop").filter { $0 == "GET /workspaces/ws-1/files" }.count, filesRequestsBeforeCursor + 2)
            XCTAssertTrue(model.cursors.isEmpty)
            XCTAssertFalse(model.index?.entries.contains(where: { $0.id == childStaleID }) ?? true)
            XCTAssertEqual(model.errorMessage, AidenWorkspaceFilesModel.staleFolderRecoveryMessage)

            // 3. Stale unopened file open refreshes root once, returns false, preserves open document + draft + cached Notes.md.
            let filesRequestsBeforeOpen = responder.requests(instanceId: "laptop").filter { $0 == "GET /workspaces/ws-1/files" }.count
            responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files/\(staleFileID)", status: status, json: staleErrorJSON)
            responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1", status: 200, json: Data("""
            {"snapshotId":"root-3","entries":[
              {"id":"\(freshDirID)","displayPath":"src","name":"src","kind":"directory"},
              {"id":"\(freshFileID)","displayPath":"README.md","name":"README.md","kind":"file"},
              {"id":"\(openDocID)","displayPath":"Notes.md","name":"Notes.md","kind":"file"}
            ],"truncated":false,"maxEntries":4000,"maxDepth":20,"directoryPath":""}
            """.utf8))
            let staleReadme = try XCTUnwrap(model.index?.entries.first { $0.displayPath == "README.md" })
            let openedStale = await model.open(staleReadme, coordinator: coordinator)
            XCTAssertFalse(openedStale)
            // 1 root refresh GET (the file GET was to /files/{staleFileID}).
            XCTAssertEqual(responder.requests(instanceId: "laptop").filter { $0 == "GET /workspaces/ws-1/files" }.count, filesRequestsBeforeOpen + 1)
            XCTAssertEqual(model.errorMessage, AidenWorkspaceFilesModel.staleFileRecoveryMessage)
            XCTAssertEqual(model.index?.entries.first(where: { $0.displayPath == "README.md" })?.id, freshFileID)
            XCTAssertEqual(model.document?.id, openDocID)
            XCTAssertEqual(model.draft, "unsaved draft\n")
            let cachedSnapshot = await cache.load(instanceId: "laptop", workspaceId: "ws-1")
            XCTAssertEqual(cachedSnapshot?.documents[openDocID]?.content, "original\n")

            // 4. Stale save never auto-replays PUT and keeps draft intact.
            let savedStale = await model.save(coordinator: coordinator)
            XCTAssertFalse(savedStale)
            XCTAssertEqual(putCalls.count, 1)
            XCTAssertEqual(model.draft, "unsaved draft\n")
            XCTAssertEqual(model.errorMessage, "Stale handle.")
        }
    }

    @MainActor
    func testConcurrentStalePagesRefreshRootOnceAndRespectOwnershipFence() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "AidenStaleFence-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = AidenWorkspaceEnvironmentCache(directory: directory)
        let responder = AidenDemoResponder()
        let coordinator = AidenDemoHosts.coordinator(
            installations: [AidenDemoHosts.installation(instanceId: "laptop", name: "Laptop")],
            responder: responder,
            workspaceEnvironmentCache: cache,
            machinePreferences: AidenMachinePreferencesStore(defaults: AidenDemoHosts.isolatedDefaults())
        )
        let scheduler = AidenHostConnectScheduler(
            registry: coordinator.hosts,
            pathChanges: AsyncStream { _ in },
            maxConcurrentConnects: 2,
            probeTimeout: 30
        )
        await coordinator.start()
        await scheduler.foregrounded()
        for _ in 0..<50 where coordinator.hosts.connection(for: "laptop")?.connectionState != .connected {
            try await Task.sleep(for: .milliseconds(10))
        }

        let dirAID = "file_\(String(repeating: "a", count: 43))"
        let dirBID = "file_\(String(repeating: "b", count: 43))"
        let freshDirAID = "file_\(String(repeating: "c", count: 43))"
        let staleJSON = Data(#"{"error":{"code":"handle_invalid","message":"Stale.","requestId":"req_1","retryable":false}}"#.utf8)

        responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1", status: 200, json: Data("""
        {"snapshotId":"root-1","entries":[
          {"id":"\(dirAID)","displayPath":"a","name":"a","kind":"directory"},
          {"id":"\(dirBID)","displayPath":"b","name":"b","kind":"directory"}
        ],"truncated":false,"maxEntries":4000,"maxDepth":20,"directoryPath":""}
        """.utf8))
        let workspace = AidenWorkspace(
            id: "ws-1", name: "Workspace", permission: .ask, hasFolder: true,
            isManagedWorktree: false, branchName: nil, repositoryName: nil, git: nil,
            createdAt: .now, updatedAt: .now, revision: "r1"
        )
        let owner = try coordinator.ownerContext(for: "laptop")
        let model = AidenWorkspaceFilesModel(workspace: workspace, owner: owner, cache: cache)
        await model.load(coordinator: coordinator)

        let dirA = try XCTUnwrap(model.index?.entries.first { $0.displayPath == "a" })
        let dirB = try XCTUnwrap(model.index?.entries.first { $0.displayPath == "b" })
        let filesBefore = responder.requests(instanceId: "laptop").filter { $0 == "GET /workspaces/ws-1/files" }.count
        responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1&directory=\(dirAID)", status: 400, json: staleJSON)
        responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1&directory=\(dirBID)", status: 400, json: staleJSON)
        let releaseB = responder.hold(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1&directory=\(dirBID)")
        let releaseRoot = responder.hold(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1")
        responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1", status: 200, json: Data("""
        {"snapshotId":"root-2","entries":[{"id":"\(freshDirAID)","displayPath":"a","name":"a","kind":"directory"}],
         "truncated":false,"maxEntries":4000,"maxDepth":20,"directoryPath":""}
        """.utf8))

        async let expandA: Void = model.toggle(dirA, coordinator: coordinator)
        async let expandB: Void = model.toggle(dirB, coordinator: coordinator)
        try await Task.sleep(for: .milliseconds(20))
        releaseB()
        releaseRoot()
        _ = await (expandA, expandB)
        // dirA GET + dirB GET + exactly 1 root refresh GET = +3 GET /workspaces/ws-1/files requests.
        XCTAssertEqual(responder.requests(instanceId: "laptop").filter { $0 == "GET /workspaces/ws-1/files" }.count, filesBefore + 3)
        XCTAssertEqual(model.index?.entries.map(\.id), [freshDirAID])

        // Removing the installation while a stale recovery is parked prevents late publication.
        responder.reply(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1&directory=\(freshDirAID)", status: 400, json: staleJSON)
        let releaseRemovedRoot = responder.hold(instanceId: "laptop", path: "/workspaces/ws-1/files", query: "tree=1")
        let freshA = try XCTUnwrap(model.index?.entries.first)
        let task = Task { await model.toggle(freshA, coordinator: coordinator) }
        try await Task.sleep(for: .milliseconds(20))
        await coordinator.removeInstallation("laptop")
        releaseRemovedRoot()
        await task.value
        XCTAssertNil(model.index)
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

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
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
