import XCTest
@testable import AidenOnTheGo

/// Revision 48 (`chat:new-worktree`): when the phone offers New worktree.
final class AidenNewWorktreeTests: XCTestCase {
    private let site = AidenWorkspace(
        id: "workspace_site",
        name: "Site",
        permission: .ask,
        hasFolder: true,
        isManagedWorktree: false,
        branchName: nil,
        repositoryName: nil,
        git: nil,
        createdAt: Date(timeIntervalSince1970: 0),
        updatedAt: Date(timeIntervalSince1970: 0),
        revision: "workspace_revision_1"
    )

    private func chat(workspaceId: String = "workspace_site", botId: String? = nil, messages: [AidenChatMessage] = []) -> AidenChat {
        AidenChat(
            id: "chat_new",
            workspaceId: workspaceId,
            botId: botId,
            title: "New chat",
            providerId: nil,
            modelId: nil,
            messages: messages,
            createdAt: Date(timeIntervalSince1970: 0),
            updatedAt: Date(timeIntervalSince1970: 0),
            revision: "chat_revision_1"
        )
    }

    private func server(
        holds: [AidenRemoteCapability] = [.chatWrite, .gitWrite, .chatNewWorktree],
        offers: [AidenRemoteCapability] = [.chatNewWorktree]
    ) -> AidenServer {
        AidenServer(
            protocolVersion: 1,
            instanceId: "instance",
            name: "Mac",
            appVersion: "1.0",
            capabilities: [.serverRead, .chatRead] + holds,
            serverCapabilities: [.serverRead, .chatRead, .chatWrite, .gitWrite] + offers,
            connectionMode: .lan,
            minimumClientVersion: nil,
            serverTime: Date(),
            features: []
        )
    }

    private func offered(
        chat: AidenChat? = nil,
        workspace: AidenWorkspace? = nil,
        server: AidenServer? = nil,
        hasCommits: Bool? = nil
    ) -> Bool {
        AidenNewWorktreeAvailability.isOffered(
            chat: chat ?? self.chat(),
            workspace: workspace ?? site,
            server: server ?? self.server(),
            hasCommits: hasCommits
        )
    }

    func testOfferedForAnEmptyWorkspaceChatInARepositoryFolder() {
        XCTAssertTrue(offered())
        XCTAssertTrue(offered(hasCommits: true))
        XCTAssertTrue(offered(hasCommits: nil), "without git:read the Mac decides and says why it can't")
    }

    func testHiddenWhereTheMacWouldRefuseOrTheChatHasStarted() {
        let message = AidenChatMessage(id: "m1", role: .user, text: "Hi", attachments: [], createdAt: Date())
        let cases: [(String, Bool)] = [
            ("chat has a message", offered(chat: chat(messages: [message]))),
            ("Bot chat", offered(chat: chat(botId: "bot_1"))),
            ("no folder", offered(workspace: AidenWorkspace(
                id: site.id, name: site.name, permission: .ask, hasFolder: false, isManagedWorktree: false,
                branchName: nil, repositoryName: nil, git: nil, createdAt: site.createdAt, updatedAt: site.updatedAt,
                revision: site.revision
            ))),
            ("already a worktree", offered(workspace: AidenWorkspace(
                id: site.id, name: site.name, permission: .full, hasFolder: true, isManagedWorktree: true,
                branchName: "aiden/x", repositoryName: "site", git: nil, createdAt: site.createdAt,
                updatedAt: site.updatedAt, revision: site.revision
            ))),
            ("no folder access", offered(workspace: AidenWorkspace(
                id: site.id, name: site.name, permission: .none, hasFolder: true, isManagedWorktree: false,
                branchName: nil, repositoryName: nil, git: nil, createdAt: site.createdAt, updatedAt: site.updatedAt,
                revision: site.revision
            ))),
            ("another chat's workspace", offered(chat: chat(workspaceId: "workspace_other"))),
            ("not a repository, or no commits", offered(hasCommits: false)),
            ("Mac on an earlier revision", offered(server: server(holds: [.chatWrite, .gitWrite], offers: []))),
            ("offered but not granted", offered(server: server(holds: [.chatWrite, .gitWrite]))),
            ("no git:write", offered(server: server(holds: [.chatWrite, .chatNewWorktree]))),
            ("read-only chat grant", offered(server: server(holds: [.gitWrite, .chatNewWorktree]))),
        ]
        for (name, isOffered) in cases {
            XCTAssertFalse(isOffered, name)
        }
        XCTAssertFalse(AidenNewWorktreeAvailability.isOffered(chat: chat(), workspace: nil, server: server(), hasCommits: nil))
        XCTAssertFalse(AidenNewWorktreeAvailability.isOffered(chat: chat(), workspace: site, server: nil, hasCommits: nil))
    }

    func testABranchListTellsWhetherTheRepositoryHasCommits() throws {
        func result(_ json: String) throws -> AidenGitResult {
            try AidenRemoteJSONDecoder.decode(AidenGitResult.self, from: Data(json.utf8))
        }
        XCTAssertEqual(AidenNewWorktreeAvailability.hasCommits(try result(
            #"{"operationId":"op_1","status":"snapshot","snapshotId":"s1","capability":{"allowed":true},"result":{"kind":"branches","current":"main","branches":["main","fix"]}}"#
        )), true)
        XCTAssertEqual(AidenNewWorktreeAvailability.hasCommits(try result(
            #"{"operationId":"op_2","status":"snapshot","snapshotId":"s2","capability":{"allowed":false,"reason":"This workspace is not a Git repository."},"result":{"kind":"branches","current":"HEAD","branches":[]}}"#
        )), false)
        XCTAssertNil(AidenNewWorktreeAvailability.hasCommits(try result(#"{"operationId":"op_3","status":"failed"}"#)))
    }

    /// The Mac counts code points, so a long first message is cut there: a
    /// letter with a combining accent is one character on the phone but two
    /// code points on the Mac.
    func testALongFirstMessageNamesTheBranchFromItsFirst4000CodePoints() {
        XCTAssertEqual(AidenChatNewWorktree.branchSeed(from: "  Fix the login bug \n"), "Fix the login bug")
        let accented = String(repeating: "e\u{301}", count: 3_000)
        XCTAssertEqual(accented.count, 3_000)
        let seed = AidenChatNewWorktree.branchSeed(from: "Fix " + accented)
        XCTAssertEqual(seed.unicodeScalars.count, AidenChatNewWorktree.maxTextLength)
        XCTAssertTrue(seed.hasPrefix("Fix e\u{301}"))
        let fits = String(repeating: "a", count: AidenChatNewWorktree.maxTextLength)
        XCTAssertEqual(AidenChatNewWorktree.branchSeed(from: fits), fits)
    }

    /// The Mac keeps every answer under its key, refusals included, so only a
    /// request that got no answer may be retried with the same key.
    func testOnlyARequestTheMacNeverAnsweredKeepsItsKey() throws {
        func refusal(_ status: Int, _ code: String) throws -> AidenRemoteClientError {
            let body = try AidenRemoteJSONDecoder.decode(
                AidenRemoteErrorEnvelope.Body.self,
                from: Data(#"{"code":"\#(code)","message":"Refused.","requestId":"req_test_1","retryable":false}"#.utf8)
            )
            return .server(statusCode: status, body: body)
        }
        XCTAssertTrue(AidenNewWorktreeRetry.spendsKey(try refusal(409, "git_capability_denied")))
        XCTAssertTrue(AidenNewWorktreeRetry.spendsKey(try refusal(500, "internal_error")))
        XCTAssertTrue(AidenNewWorktreeRetry.spendsKey(AidenRemoteClientError.unexpectedStatus(502)))
        XCTAssertFalse(AidenNewWorktreeRetry.spendsKey(try refusal(409, "idempotency_in_flight")), "the Mac is still on it")
        XCTAssertFalse(AidenNewWorktreeRetry.spendsKey(URLError(.timedOut)))
        XCTAssertFalse(AidenNewWorktreeRetry.spendsKey(CancellationError()))
    }
}
