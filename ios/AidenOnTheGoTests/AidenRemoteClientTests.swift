import Foundation
import XCTest
@testable import AidenOnTheGo

final class AidenRemoteClientTests: XCTestCase {
    override func setUp() {
        super.setUp()
        AidenRemoteMockURLProtocol.handler = nil
    }

    override func tearDown() {
        AidenRemoteMockURLProtocol.handler = nil
        super.tearDown()
    }

    func testPairingUsesBootstrapSecretWithoutBearerAndValidatesExchange() async throws {
        let now = Date(timeIntervalSince1970: 1_787_100_000)
        let bootstrap = makeBootstrap(now: now)
        let payload = makePairingPayload(bootstrap: bootstrap)
        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://aiden.test/api/aiden/v1/pairing/exchange")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Aiden-Protocol-Version"), "1")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let body = try Self.bodyData(request)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(object["secret"] as? String, String(repeating: "B", count: 43))
            XCTAssertEqual(object["deviceName"] as? String, "Sambit's iPhone")
            XCTAssertEqual(object["deviceType"] as? String, "iphone")
            XCTAssertEqual(object["clientVersion"] as? String, "1.0")
            return Self.response(
                for: request,
                status: 200,
                json: """
                {
                  "protocolVersion": 1,
                  "instanceId": "instance-1",
                  "deviceId": "device-1",
                  "credential": "\(String(repeating: "C", count: 43))",
                  "capabilities": ["server:read", "workspace:read", "workspace:manage"],
                  "endpoint": "https://aiden.test/api/aiden/v1",
                  "serverSpkiSha256": "\(bootstrap.serverSpkiSha256)"
                }
                """
            )
        }

        let exchange = try await AidenRemoteClient.pair(
            payload: payload,
            deviceName: "Sambit's iPhone",
            deviceType: .iphone,
            clientVersion: "1.0",
            session: session,
            now: now
        )

        XCTAssertEqual(exchange.instanceId, "instance-1")
        XCTAssertEqual(exchange.deviceId, "device-1")
        XCTAssertEqual(exchange.capabilities, [.serverRead, .workspaceRead, .workspaceManage])
    }

    func testWorkspaceListUsesBearerAndStrictAidenProtocolHeader() async throws {
        let client = makeClient()
        AidenRemoteMockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://aiden.test/api/aiden/v1/workspaces")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-credential")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Aiden-Protocol-Version"), "1")
            return Self.response(
                for: request,
                status: 200,
                json: """
                {"workspaces":[{
                  "id":"workspace-1","name":"Aiden Agent","permission":"ask",
                  "hasFolder":true,"isManagedWorktree":false,
                  "repositoryName":"aiden-agent",
                  "git":{"isRepo":true,"branch":"main","uncommitted":2},
                  "createdAt":"2026-08-19T07:00:00.000Z",
                  "updatedAt":"2026-08-19T07:01:00.000Z","revision":"rev-1"
                }]}
                """
            )
        }

        let workspaces = try await client.workspaces()
        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0].permission, .ask)
        XCTAssertEqual(workspaces[0].git?.uncommitted, 2)
    }

    func testUsageReadsPrivacySafeMacAggregate() async throws {
        let client = makeClient()
        AidenRemoteMockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://aiden.test/api/aiden/v1/usage?range=30d")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-credential")
            return Self.response(
                for: request,
                status: 200,
                json: """
                {
                  "range":"30d","startDate":"2026-07-21","endDate":"2026-08-19",
                  "totals":{
                    "requests":12,"completedRequests":11,"failedRequests":1,"cancelledRequests":0,
                    "reportedTokenRequests":10,"unmeteredRequests":2,"localRequests":3,
                    "costedRequests":8,"unpricedHostedRequests":1,"hostedCostUsd":1.25,
                    "activeDays":4,"currentStreak":2,"longestStreak":3,
                    "tokens":{"input":100,"output":50,"cacheRead":10,"cacheWrite":2,"cacheWrite1h":1,"reasoning":8,"total":170}
                  },
                  "days":[],"models":[]
                }
                """
            )
        }

        let usage = try await client.usage()
        XCTAssertEqual(usage.range, "30d")
        XCTAssertEqual(usage.totals.requests, 12)
        XCTAssertEqual(usage.totals.tokens.total, 170)
        XCTAssertEqual(usage.totals.hostedCostUsd, 1.25)
    }

    func testWorkspaceCreateUpdateAndDeleteCarryMutationPreconditions() async throws {
        let client = makeClient()
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            switch step {
            case 1:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
                let object = try Self.jsonBody(request)
                XCTAssertEqual(object["mode"] as? String, "folderless")
                XCTAssertEqual(object["name"] as? String, "New Workspace")
                return Self.workspaceResponse(for: request, status: 201, revision: "rev-1")
            case 2:
                XCTAssertEqual(request.httpMethod, "PATCH")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "rev-1")
                let object = try Self.jsonBody(request)
                XCTAssertEqual(object["permission"] as? String, "full")
                XCTAssertEqual(object["confirmedForeground"] as? Bool, true)
                return Self.workspaceResponse(for: request, status: 200, revision: "rev-2")
            case 3:
                XCTAssertEqual(request.httpMethod, "DELETE")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "rev-2")
                return (HTTPURLResponse(url: request.url!, statusCode: 204, httpVersion: nil, headerFields: nil)!, Data())
            default:
                XCTFail("Unexpected request")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let created = try await client.createWorkspace(.folderless(name: "New Workspace"))
        let updated = try await client.updateWorkspace(
            id: created.id,
            revision: created.revision,
            patch: AidenWorkspacePatch(permission: .full)
        )
        try await client.removeWorkspace(id: updated.id, revision: updated.revision)
        XCTAssertEqual(step, 3)
    }

    func testApprovedFolderBrowserUsesOpaqueLocationsAndSelection() async throws {
        let client = makeClient()
        var step = 0
        let location = "loc_\(String(repeating: "L", count: 43))"
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            switch step {
            case 1:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/workspace-browser/children")
                let components = try XCTUnwrap(URLComponents(url: request.url!, resolvingAgainstBaseURL: false))
                XCTAssertEqual(components.queryItems, [URLQueryItem(name: "location", value: location)])
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"rootId":"root-1","label":"Projects","breadcrumbs":[],
                    "entries":[{"id":"entry-1","name":"aiden-agent","location":"\(location)"}]}
                    """
                )
            case 2:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/workspace-browser/selections")
                XCTAssertEqual(try Self.jsonBody(request)["location"] as? String, location)
                return Self.response(
                    for: request,
                    status: 201,
                    json: """
                    {"selection":"sel_\(String(repeating: "S", count: 43))",
                    "displayName":"aiden-agent","expiresAt":"2026-08-19T07:05:00.000Z"}
                    """
                )
            default:
                XCTFail("Unexpected request")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let page = try await client.browserChildren(location: location)
        XCTAssertEqual(page.entries.first?.name, "aiden-agent")
        let selection = try await client.createWorkspaceSelection(location: location)
        XCTAssertTrue(selection.selection.hasPrefix("sel_"))
    }

    func testCredentialRevocationIsTypedAndNeverEchoesCredential() async throws {
        let client = makeClient()
        AidenRemoteMockURLProtocol.handler = { request in
            Self.response(
                for: request,
                status: 401,
                json: """
                {"error":{"code":"credential_revoked","message":"Pair this device again.",
                "requestId":"request-1","retryable":false}}
                """
            )
        }

        do {
            _ = try await client.workspaces()
            XCTFail("Expected credential revocation")
        } catch let error as AidenRemoteClientError {
            XCTAssertTrue(error.isCredentialRevoked)
            XCTAssertFalse(error.localizedDescription.contains("device-credential"))
        }
    }

    func testChatCRUDModelsTurnCancelAndApprovalUseCanonicalRoutes() async throws {
        let client = makeClient()
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            switch step {
            case 1:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats")
                XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems,
                               [URLQueryItem(name: "workspaceId", value: "workspace-1")])
                return Self.response(for: request, status: 200, json: "{\"chats\":[]}")
            case 2:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
                XCTAssertEqual(try Self.jsonBody(request)["workspaceId"] as? String, "workspace-1")
                return Self.chatResponse(for: request, status: 201, revision: "revision-1")
            case 3:
                XCTAssertEqual(request.httpMethod, "PATCH")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "revision-1")
                XCTAssertEqual(try Self.jsonBody(request)["title"] as? String, "Renamed")
                return Self.chatResponse(for: request, status: 200, revision: "revision-2", title: "Renamed")
            case 4:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/models")
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"providers":[{"id":"openai","label":"OpenAI","models":[
                    {"id":"gpt-5.6","label":"GPT-5.6","thinkingLevels":["high","max"]}]}],
                    "defaults":{"providerId":"openai","modelId":"gpt-5.6"}}
                    """
                )
            case 5:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats/chat-1/turns")
                XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["text"] as? String, "Work on this")
                XCTAssertEqual(body["thinkingLevel"] as? String, "max")
                return Self.response(
                    for: request,
                    status: 202,
                    json: """
                    {"turnId":"turn-1","streamId":"stream-1","status":"accepted",
                    "message":{"id":"message-1","role":"user","text":"Work on this",
                    "createdAt":"2026-08-19T07:00:00.000Z"}}
                    """
                )
            case 6:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/streams/stream-1")
                return Self.streamStatusResponse(for: request, state: "running")
            case 7:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/streams/stream-1/cancel")
                XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
                return Self.streamStatusResponse(for: request, state: "cancelled")
            case 8:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/approvals/approval-1/respond")
                XCTAssertEqual(try Self.jsonBody(request)["decision"] as? String, "allow")
                return Self.response(
                    for: request,
                    status: 200,
                    json: "{\"approvalId\":\"approval-1\",\"decision\":\"allow\",\"resolvedAt\":\"2026-08-19T07:00:00.000Z\"}"
                )
            case 9:
                XCTAssertEqual(request.httpMethod, "DELETE")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "revision-2")
                return (HTTPURLResponse(url: request.url!, statusCode: 204, httpVersion: nil, headerFields: nil)!, Data())
            default:
                XCTFail("Unexpected chat request")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let initialChats = try await client.chats(workspaceId: "workspace-1")
        XCTAssertEqual(initialChats, [])
        let created = try await client.createChat(workspaceId: "workspace-1")
        let updated = try await client.updateChat(id: created.id, revision: created.revision, title: "Renamed")
        let catalog = try await client.modelCatalog()
        XCTAssertEqual(catalog.providers.first?.models.first?.thinkingLevels, ["high", "max"])
        let turn = try await client.startTurn(
            chatId: updated.id,
            request: .init(text: "Work on this", providerId: "openai", modelId: "gpt-5.6", thinkingLevel: "max")
        )
        let runningStatus = try await client.streamStatus(id: turn.streamId)
        let cancelledStatus = try await client.cancelStream(id: turn.streamId)
        let approval = try await client.respondToApproval(id: "approval-1", decision: .allow)
        XCTAssertEqual(runningStatus.state, .running)
        XCTAssertEqual(cancelledStatus.state, .cancelled)
        XCTAssertEqual(approval.decision, .allow)
        try await client.removeChat(id: updated.id, revision: updated.revision)
        XCTAssertEqual(step, 9)
    }

    func testAttachmentUploadTurnProjectionAndRemovalUseBoundedCanonicalRoutes() async throws {
        let client = makeClient()
        let attachmentID = "att_\(String(repeating: "A", count: 43))"
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            switch step {
            case 1:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats/chat-1/attachments")
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["name"] as? String, "notes.md")
                XCTAssertEqual(body["mimeType"] as? String, "text/markdown")
                XCTAssertEqual(body["kind"] as? String, "text")
                XCTAssertEqual(body["text"] as? String, "# Notes")
                XCTAssertNil(body["path"])
                return Self.response(
                    for: request,
                    status: 201,
                    json: """
                    {"id":"\(attachmentID)","name":"notes.md","mimeType":"text/markdown",
                    "kind":"text","size":7,"expiresAt":"2026-08-19T07:10:00.000Z"}
                    """
                )
            case 2:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats/chat-1/turns")
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["text"] as? String, "")
                XCTAssertEqual(body["attachmentIds"] as? [String], [attachmentID])
                return Self.response(
                    for: request,
                    status: 202,
                    json: """
                    {"turnId":"turn-1","streamId":"stream-1","status":"accepted",
                    "message":{"id":"message-1","role":"user","text":"",
                    "attachments":[{"id":"\(attachmentID)","name":"notes.md",
                    "mimeType":"text/markdown","kind":"text","size":7}],
                    "createdAt":"2026-08-19T07:00:00.000Z"}}
                    """
                )
            case 3:
                XCTAssertEqual(request.httpMethod, "DELETE")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats/chat-1/attachments/\(attachmentID)")
                return (HTTPURLResponse(url: request.url!, statusCode: 204, httpVersion: nil, headerFields: nil)!, Data())
            default:
                XCTFail("Unexpected attachment request")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let reference = try await client.uploadAttachment(
            chatId: "chat-1",
            upload: .text(name: "notes.md", mimeType: "text/markdown", text: "# Notes")
        )
        let turn = try await client.startTurn(
            chatId: "chat-1",
            request: .init(text: "", attachmentIds: [reference.id])
        )
        XCTAssertEqual(turn.message.attachments?.first?.id, attachmentID)
        XCTAssertEqual(turn.message.attachments?.first?.size, 7)
        try await client.removeAttachment(chatId: "chat-1", attachmentId: attachmentID)
        XCTAssertEqual(step, 3)
    }

    func testPhysicalDevicePairingAndWorkspaceCRUDWhenConfigured() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let payloadValue = environment["AIDEN_PHASE6_PAIRING_PAYLOAD"] else {
            throw XCTSkip("Set the Phase 6 pairing payload in the physical-device xctestrun file.")
        }
        let payload = try AidenRemoteJSONDecoder.decodePairingPayload(
            from: Data(payloadValue.utf8)
        ).validated()
        let exchange = try await AidenRemoteClient.pair(
            payload: payload,
            deviceName: "Physical iPhone 13 Pro",
            deviceType: .iphone,
            clientVersion: "1.0"
        )
        let installation = AidenInstallation(
            exchange: exchange,
            pairingTrust: payload.trust,
            name: "Physical Aiden Agent"
        )
        let client = try AidenRemoteClient(
            installation: installation,
            credential: exchange.credential
        )

        let server = try await client.server()
        XCTAssertEqual(server.instanceId, exchange.instanceId)
        let expectedConnectionMode = environment["AIDEN_PHASE6_EXPECTED_CONNECTION_MODE"]
            .flatMap(AidenConnectionMode.init(rawValue:)) ?? .lan
        XCTAssertEqual(server.connectionMode, expectedConnectionMode)
        let initialWorkspaces = try await client.workspaces()
        XCTAssertEqual(initialWorkspaces, [])

        let folderless = try await client.createWorkspace(.folderless(name: "Phone Context"))
        XCTAssertFalse(folderless.hasFolder)
        XCTAssertEqual(folderless.permission, .ask)
        let updated = try await client.updateWorkspace(
            id: folderless.id,
            revision: folderless.revision,
            patch: AidenWorkspacePatch(name: "Renamed Context", permission: .full)
        )
        XCTAssertEqual(updated.name, "Renamed Context")
        XCTAssertEqual(updated.permission, .full)
        try await client.removeWorkspace(id: updated.id, revision: updated.revision)

        let scratch = try await client.createWorkspace(.scratch)
        XCTAssertTrue(scratch.hasFolder)
        try await client.removeWorkspace(id: scratch.id, revision: scratch.revision)

        let roots = try await client.browserRoots()
        let root = try XCTUnwrap(roots.first)
        let page = try await client.browserChildren(location: root.location)
        let approvedFolder = try XCTUnwrap(page.entries.first)
        XCTAssertEqual(approvedFolder.name, "aiden-agent")
        let selection = try await client.createWorkspaceSelection(location: approvedFolder.location)
        let selected = try await client.createWorkspace(
            .selectedFolder(selection: selection.selection, name: "Selected Project")
        )
        XCTAssertTrue(selected.hasFolder)
        XCTAssertEqual(selected.name, "Selected Project")
        do {
            _ = try await client.createWorkspace(
                .selectedFolder(selection: selection.selection, name: "Replay")
            )
            XCTFail("A selected-folder nonce must be single use.")
        } catch let error as AidenRemoteClientError {
            guard case .server(let statusCode, let body) = error else {
                return XCTFail("Expected a typed server error for selection replay.")
            }
            XCTAssertEqual(statusCode, 409)
            XCTAssertEqual(body.code.rawValue, "handle_invalid")
        }
        try await client.removeWorkspace(id: selected.id, revision: selected.revision)
        let finalWorkspaces = try await client.workspaces()
        XCTAssertEqual(finalWorkspaces, [])
    }

    func testPhysicalDeviceChatStreamingWhenConfigured() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let payloadValue = environment["AIDEN_PHASE7_PAIRING_PAYLOAD"] else {
            throw XCTSkip("Set the Phase 7 pairing payload in the physical-device xctestrun file.")
        }
        let payload = try AidenRemoteJSONDecoder.decodePairingPayload(from: Data(payloadValue.utf8)).validated()
        let exchange = try await AidenRemoteClient.pair(
            payload: payload,
            deviceName: "Physical iPhone 13 Pro",
            deviceType: .iphone,
            clientVersion: "1.0"
        )
        let client = try AidenRemoteClient(
            installation: AidenInstallation(
                exchange: exchange,
                pairingTrust: payload.trust,
                name: "Physical Aiden Agent"
            ),
            credential: exchange.credential
        )

        print("AIDEN_PHASE7_PHYSICAL checkpoint=workspace")
        let workspace = try await client.createWorkspace(.folderless(name: "Phase 7 Chat"))
        let created = try await client.createChat(workspaceId: workspace.id)
        let renamed = try await client.updateChat(
            id: created.id,
            revision: created.revision,
            title: "Physical Stream Proof"
        )
        print("AIDEN_PHASE7_PHYSICAL checkpoint=models")
        let catalog = try await client.modelCatalog()
        XCTAssertEqual(catalog.defaults["modelId"], "gpt-5.6")

        print("AIDEN_PHASE7_PHYSICAL checkpoint=attachment-upload")
        let attachment = try await client.uploadAttachment(
            chatId: renamed.id,
            upload: .text(
                name: "physical-proof.md",
                mimeType: "text/markdown",
                text: "# Physical attachment"
            )
        )
        XCTAssertTrue(attachment.isValid())
        let discardedAttachment = try await client.uploadAttachment(
            chatId: renamed.id,
            upload: .text(name: "discard.txt", mimeType: "text/plain", text: "discard")
        )
        try await client.removeAttachment(chatId: renamed.id, attachmentId: discardedAttachment.id)

        let turn = try await client.startTurn(
            chatId: renamed.id,
            request: .init(
                text: "Prove reconnect and approval",
                providerId: "openai",
                modelId: "gpt-5.6",
                thinkingLevel: "max",
                attachmentIds: [attachment.id]
            )
        )
        XCTAssertEqual(turn.message.attachments?.first?.id, attachment.id)
        XCTAssertEqual(turn.message.attachments?.first?.name, "physical-proof.md")
        XCTAssertEqual(turn.message.attachments?.first?.mimeType, "text/markdown")
        do {
            _ = try await client.startTurn(
                chatId: renamed.id,
                request: .init(text: "Replay consumed attachment", attachmentIds: [attachment.id])
            )
            XCTFail("An attachment reference must be single use.")
        } catch let error as AidenRemoteClientError {
            guard case .server(let statusCode, let body) = error else {
                return XCTFail("Expected a typed server error for attachment replay.")
            }
            XCTAssertEqual(statusCode, 409)
            XCTAssertEqual(body.code.rawValue, "handle_invalid")
        }
        print("AIDEN_PHASE7_PHYSICAL checkpoint=first-stream")
        var firstConnection: [AidenRemoteStreamEvent] = []
        for try await event in client.streamEvents(id: turn.streamId, after: 0) {
            firstConnection.append(event)
        }
        XCTAssertEqual(firstConnection.map(\.sequence), [1, 2])
        XCTAssertEqual(firstConnection.last?.payload?.text, "Hello ")

        print("AIDEN_PHASE7_PHYSICAL checkpoint=replay-stream")
        var replayConnection: [AidenRemoteStreamEvent] = []
        for try await event in client.streamEvents(id: turn.streamId, after: 2) {
            replayConnection.append(event)
        }
        XCTAssertEqual(replayConnection.map(\.sequence), [3, 4, 5, 6, 7])
        let approval = try XCTUnwrap(replayConnection.last?.payload?.approvalId)
        let waitingStatus = try await client.streamStatus(id: turn.streamId)
        XCTAssertEqual(waitingStatus.state, .waitingForApproval)
        _ = try await client.respondToApproval(id: approval, decision: .allow)
        do {
            _ = try await client.respondToApproval(id: approval, decision: .allow)
            XCTFail("A resolved approval must reject duplicate decisions.")
        } catch let error as AidenRemoteClientError {
            guard case .server(let statusCode, let body) = error else {
                return XCTFail("Expected a typed server error for duplicate approval.")
            }
            XCTAssertEqual(statusCode, 409)
            XCTAssertEqual(body.code.rawValue, "approval_expired")
        }

        print("AIDEN_PHASE7_PHYSICAL checkpoint=terminal-stream")
        var terminalConnection: [AidenRemoteStreamEvent] = []
        for try await event in client.streamEvents(id: turn.streamId, after: 7) {
            terminalConnection.append(event)
        }
        XCTAssertEqual(terminalConnection.map(\.sequence), [8, 9, 10])
        XCTAssertEqual(terminalConnection.last?.type, .done)
        let authoritative = try await client.chat(id: renamed.id)
        XCTAssertEqual(authoritative.messages.last?.role, .assistant)
        XCTAssertEqual(authoritative.messages.last?.text, "Hello from Aiden.")
        let authoritativeUserMessage = try XCTUnwrap(
            authoritative.messages.first(where: { $0.role == .user })
        )
        XCTAssertEqual(authoritativeUserMessage.attachments?.first?.id, attachment.id)
        XCTAssertEqual(authoritativeUserMessage.attachments?.first?.kind, .text)

        print("AIDEN_PHASE7_PHYSICAL checkpoint=cancel")
        let cancelledTurn = try await client.startTurn(
            chatId: authoritative.id,
            request: .init(text: "Please cancel this turn")
        )
        let cancelled = try await client.cancelStream(id: cancelledTurn.streamId)
        XCTAssertEqual(cancelled.state, .cancelled)
        var cancellationEvents: [AidenRemoteStreamEvent] = []
        for try await event in client.streamEvents(id: cancelledTurn.streamId, after: 0) {
            cancellationEvents.append(event)
        }
        XCTAssertEqual(cancellationEvents.last?.type, .cancelled)

        let finalChat = try await client.chat(id: authoritative.id)
        try await client.removeChat(id: finalChat.id, revision: finalChat.revision)
        try await client.removeWorkspace(id: workspace.id, revision: workspace.revision)
        let finalChats = try await client.chats(workspaceId: workspace.id)
        XCTAssertEqual(finalChats, [])
    }

    func testPhysicalDeviceServerRestartWhenConfigured() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let payloadValue = environment["AIDEN_PHASE12_RESTART_PAIRING_PAYLOAD"],
              let repairPayloadValue = environment["AIDEN_PHASE12_REPAIR_PAIRING_PAYLOAD"] else {
            throw XCTSkip("Set both Phase 12 pairing payloads in the physical-device xctestrun file.")
        }
        let payload = try AidenRemoteJSONDecoder.decodePairingPayload(
            from: Data(payloadValue.utf8)
        ).validated()
        let repairPayload = try AidenRemoteJSONDecoder.decodePairingPayload(
            from: Data(repairPayloadValue.utf8)
        ).validated()
        XCTAssertEqual(repairPayload.bootstrap.instanceId, payload.bootstrap.instanceId)
        XCTAssertEqual(repairPayload.bootstrap.endpoint, payload.bootstrap.endpoint)
        XCTAssertEqual(repairPayload.bootstrap.serverSpkiSha256, payload.bootstrap.serverSpkiSha256)
        XCTAssertEqual(repairPayload.trust, payload.trust)
        XCTAssertNotEqual(repairPayload.bootstrap.secret, payload.bootstrap.secret)
        let exchange = try await AidenRemoteClient.pair(
            payload: payload,
            deviceName: "Physical iPhone 13 Pro Restart Proof",
            deviceType: .iphone,
            clientVersion: "1.0"
        )
        let installation = AidenInstallation(
            exchange: exchange,
            pairingTrust: payload.trust,
            name: "Physical Aiden Agent Restart Proof"
        )
        let client = try AidenRemoteClient(installation: installation, credential: exchange.credential)

        let beforeRestart = try await client.server()
        XCTAssertEqual(beforeRestart.instanceId, "phase7-physical-device-spike")
        print("AIDEN_PHASE12_PHYSICAL checkpoint=restart-ready")
        try await Task.sleep(for: .seconds(10))

        var lastError: Error?
        for _ in 0..<20 {
            do {
                let reconnectedClient = try AidenRemoteClient(
                    installation: installation,
                    credential: exchange.credential,
                    waitsForConnectivity: false,
                    requestTimeout: 2
                )
                let afterRestart = try await reconnectedClient.server()
                XCTAssertEqual(afterRestart.instanceId, beforeRestart.instanceId)
                lastError = nil
                print("AIDEN_PHASE12_PHYSICAL checkpoint=reconnected")
                break
            } catch {
                lastError = error
                try await Task.sleep(for: .milliseconds(500))
            }
        }
        if lastError != nil {
            throw try XCTUnwrap(lastError)
        }

        print("AIDEN_PHASE12_PHYSICAL checkpoint=revocation-ready")
        try await Task.sleep(for: .seconds(30))
        do {
            let revokedClient = try AidenRemoteClient(
                installation: installation,
                credential: exchange.credential,
                waitsForConnectivity: false,
                requestTimeout: 2
            )
            _ = try await revokedClient.server()
            XCTFail("The revoked credential must stop authenticating immediately.")
        } catch let error as AidenRemoteClientError {
            guard case .server(let statusCode, let body) = error else {
                return XCTFail("Expected a typed server error after credential revocation.")
            }
            XCTAssertEqual(statusCode, 403)
            XCTAssertEqual(body.code.rawValue, "credential_revoked")
            print("AIDEN_PHASE12_PHYSICAL checkpoint=revoked")
        }

        print("AIDEN_PHASE12_PHYSICAL checkpoint=repair-ready")
        try await Task.sleep(for: .seconds(30))
        let repairExchange = try await AidenRemoteClient.pair(
            payload: repairPayload,
            deviceName: "Physical iPhone 13 Pro Re-pair Proof",
            deviceType: .iphone,
            clientVersion: "1.0"
        )
        XCTAssertEqual(repairExchange.instanceId, exchange.instanceId)
        XCTAssertNotEqual(repairExchange.deviceId, exchange.deviceId)
        XCTAssertNotEqual(repairExchange.credential, exchange.credential)
        let repairedInstallation = AidenInstallation(
            exchange: repairExchange,
            pairingTrust: repairPayload.trust,
            name: "Physical Aiden Agent Re-pair Proof"
        )
        let repairedClient = try AidenRemoteClient(
            installation: repairedInstallation,
            credential: repairExchange.credential,
            waitsForConnectivity: false,
            requestTimeout: 2
        )
        let repairedServer = try await repairedClient.server()
        XCTAssertEqual(repairedServer.instanceId, beforeRestart.instanceId)
        do {
            _ = try await AidenRemoteClient.pair(
                payload: repairPayload,
                deviceName: "Physical iPhone 13 Pro Re-pair Replay",
                deviceType: .iphone,
                clientVersion: "1.0"
            )
            XCTFail("The repair pairing secret must be one-use.")
        } catch let error as AidenRemoteClientError {
            guard case .server(let statusCode, let body) = error else {
                return XCTFail("Expected a typed server error after repair pairing replay.")
            }
            XCTAssertEqual(statusCode, 401)
            XCTAssertEqual(body.code.rawValue, "pairing_closed")
        }
        print("AIDEN_PHASE12_PHYSICAL checkpoint=repaired")

        print("AIDEN_PHASE12_PHYSICAL checkpoint=repair-restart-ready")
        try await Task.sleep(for: .seconds(30))
        let repairedAfterRestart = try AidenRemoteClient(
            installation: repairedInstallation,
            credential: repairExchange.credential,
            waitsForConnectivity: false,
            requestTimeout: 2
        )
        let serverAfterRepairRestart = try await repairedAfterRestart.server()
        XCTAssertEqual(serverAfterRepairRestart.instanceId, beforeRestart.instanceId)
        do {
            let oldAfterRepair = try AidenRemoteClient(
                installation: installation,
                credential: exchange.credential,
                waitsForConnectivity: false,
                requestTimeout: 2
            )
            _ = try await oldAfterRepair.server()
            XCTFail("The replaced credential must remain invalid after re-pair and restart.")
        } catch let error as AidenRemoteClientError {
            guard case .server(let statusCode, let body) = error else {
                return XCTFail("Expected a typed server error for the replaced credential.")
            }
            XCTAssertEqual(statusCode, 403)
            XCTAssertEqual(body.code.rawValue, "credential_revoked")
        }
        print("AIDEN_PHASE12_PHYSICAL checkpoint=repair-restarted")
    }

    @MainActor
    func testRePairingAtomicallyReplacesInstallationScopedCredential() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let initial = makeExchange(
            instanceId: "instance-repair",
            deviceId: "device-before",
            credential: String(repeating: "A", count: 43)
        )
        let repaired = makeExchange(
            instanceId: "instance-repair",
            deviceId: "device-after",
            credential: String(repeating: "B", count: 43)
        )
        let createdAt = Date(timeIntervalSince1970: 1_787_100_000)
        let first = try store.savePairing(initial, trust: makeSystemTrust(), name: "Aiden Mac", now: createdAt)
        let second = try store.savePairing(
            repaired,
            trust: makeSystemTrust(),
            name: "Aiden Mac",
            now: createdAt.addingTimeInterval(60)
        )

        XCTAssertEqual(store.installations.count, 1)
        XCTAssertEqual(store.activeInstallationId, "instance-repair")
        XCTAssertEqual(second.createdAt, first.createdAt)
        XCTAssertEqual(second.deviceId, "device-after")
        XCTAssertEqual(try store.credential(for: second), repaired.credential)
        XCTAssertEqual(
            keychain.scoped[KeychainStore.scopedKey(.remoteCredential, scope: "instance-repair")],
            repaired.credential
        )
        XCTAssertFalse(keychain.scoped.values.contains(initial.credential))
    }

    @MainActor
    func testInstallationStoreKeepsCredentialsScopedAndSwitchesWithoutLeakage() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let now = Date(timeIntervalSince1970: 1_787_100_000)
        let first = makeExchange(instanceId: "instance-1", deviceId: "device-1", credential: String(repeating: "A", count: 43))
        let second = makeExchange(instanceId: "instance-2", deviceId: "device-2", credential: String(repeating: "B", count: 43))

        let firstInstallation = try store.savePairing(first, trust: makeSystemTrust(), name: "Home Mac", now: now)
        let secondInstallation = try store.savePairing(second, trust: makeSystemTrust(), name: "Studio Mac", now: now)
        XCTAssertEqual(store.activeInstallationId, "instance-2")
        XCTAssertEqual(try store.credential(for: firstInstallation), first.credential)
        XCTAssertEqual(try store.credential(for: secondInstallation), second.credential)

        try store.setActive("instance-1")
        XCTAssertEqual(store.activeInstallationId, "instance-1")
        XCTAssertEqual(try store.credential(for: store.activeInstallation!), first.credential)

        try store.remove("instance-1")
        XCTAssertNil(keychain.scoped[KeychainStore.scopedKey(.remoteCredential, scope: "instance-1")])
        XCTAssertEqual(keychain.scoped[KeychainStore.scopedKey(.remoteCredential, scope: "instance-2")], second.credential)
    }

    @MainActor
    func testInstallationTrustPersistsAndLegacyMetadataFailsClosed() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let firstStore = AidenInstallationStore(keychain: keychain)
        let exchange = makeExchange(
            instanceId: "instance-trusted",
            deviceId: "device-trusted",
            credential: "credential-trusted"
        )
        _ = try firstStore.savePairing(
            exchange,
            trust: makeSystemTrust(),
            name: "Trusted Mac"
        )
        let restoredStore = AidenInstallationStore(keychain: keychain)
        XCTAssertEqual(restoredStore.activeInstallation?.pairingTrust, makeSystemTrust())

        let legacySnapshot = """
        {"installations":[{"instanceId":"legacy-instance","deviceId":"legacy-device",
        "name":"Legacy Mac","endpoint":"https://aiden.test/api/aiden/v1",
        "serverSpkiSha256":"sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "capabilities":["server:read"],"createdAt":0}],
        "activeInstallationId":"legacy-instance"}
        """
        keychain.values[.remoteInstallations] = legacySnapshot
        let legacyStore = AidenInstallationStore(keychain: keychain)
        let legacyInstallation = try XCTUnwrap(legacyStore.activeInstallation)
        XCTAssertNil(legacyInstallation.pairingTrust)
        XCTAssertThrowsError(try AidenRemoteClient(
            installation: legacyInstallation,
            credential: "legacy-credential"
        )) { error in
            guard let clientError = error as? AidenRemoteClientError,
                  case .missingTrustConfiguration = clientError else {
                return XCTFail("Legacy metadata must require secure re-pairing.")
            }
        }
    }

    @MainActor
    func testCoordinatorConnectsAndAppliesWorkspaceCRUDWithoutLosingAuthoritativeState() async throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let exchange = makeExchange(
            instanceId: "instance-1",
            deviceId: "device-1",
            credential: "credential-one"
        )
        _ = try store.savePairing(exchange, trust: makeSystemTrust(), name: "Unverified Mac")

        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/api/aiden/v1/server"):
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"protocolVersion":1,"instanceId":"instance-1","name":"Home Mac",
                    "appVersion":"1.0.0","capabilities":["server:read","workspace:read","workspace:manage"],
                    "connectionMode":"lan","serverTime":"2026-08-19T07:00:00.000Z"}
                    """
                )
            case ("GET", "/api/aiden/v1/workspaces"):
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"workspaces":[
                    {"id":"workspace-z","name":"Zulu","permission":"ask","hasFolder":false,
                    "isManagedWorktree":false,"createdAt":"2026-08-19T07:00:00.000Z",
                    "updatedAt":"2026-08-19T07:00:00.000Z","revision":"rev-z"},
                    {"id":"workspace-a","name":"Alpha","permission":"ask","hasFolder":false,
                    "isManagedWorktree":false,"createdAt":"2026-08-19T07:00:00.000Z",
                    "updatedAt":"2026-08-19T07:00:00.000Z","revision":"rev-a"}]}
                    """
                )
            case ("POST", "/api/aiden/v1/workspaces"):
                return Self.workspaceResponse(for: request, status: 201, revision: "rev-created")
            case ("PATCH", "/api/aiden/v1/workspaces/workspace-1"):
                return Self.workspaceResponse(for: request, status: 200, revision: "rev-updated")
            case ("DELETE", "/api/aiden/v1/workspaces/workspace-1"):
                return (
                    HTTPURLResponse(url: request.url!, statusCode: 204, httpVersion: nil, headerFields: nil)!,
                    Data()
                )
            default:
                XCTFail("Unexpected coordinator request: \(request.httpMethod ?? "nil") \(request.url?.path ?? "nil")")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { installation, credential in
                AidenRemoteClient(endpoint: installation.endpoint, credential: credential, session: session)
            }
        )
        await coordinator.start()

        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertEqual(coordinator.server?.name, "Home Mac")
        XCTAssertEqual(store.activeInstallation?.name, "Home Mac")
        XCTAssertEqual(coordinator.workspaces.map(\.name), ["Zulu", "Alpha"])

        let createdResult = await coordinator.createWorkspace(.folderless(name: "New Workspace"))
        let created = try XCTUnwrap(createdResult)
        XCTAssertTrue(coordinator.workspaces.contains(where: { $0.id == created.id }))
        let updatedResult = await coordinator.updateWorkspace(created, permission: .full)
        let updated = try XCTUnwrap(updatedResult)
        XCTAssertEqual(updated.revision, "rev-updated")
        let removed = await coordinator.removeWorkspace(updated)
        XCTAssertTrue(removed)
        XCTAssertFalse(coordinator.workspaces.contains(where: { $0.id == updated.id }))
    }

    @MainActor
    func testCoordinatorRevocationRemovesOnlyAffectedInstallationAndConnectsNextMac() async throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let first = makeExchange(
            instanceId: "instance-1",
            deviceId: "device-1",
            credential: "credential-one"
        )
        let second = makeExchange(
            instanceId: "instance-2",
            deviceId: "device-2",
            credential: "credential-two"
        )
        _ = try store.savePairing(first, trust: makeSystemTrust(), name: "Revoked Mac")
        _ = try store.savePairing(second, trust: makeSystemTrust(), name: "Backup Mac")
        try store.setActive("instance-1")

        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer credential-one" {
                return Self.response(
                    for: request,
                    status: 401,
                    json: """
                    {"error":{"code":"credential_revoked","message":"Pair this device again.",
                    "requestId":"request-revoked","retryable":false}}
                    """
                )
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer credential-two")
            if request.url?.path == "/api/aiden/v1/server" {
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"protocolVersion":1,"instanceId":"instance-2","name":"Backup Mac",
                    "appVersion":"1.0.0","capabilities":["server:read","workspace:read"],
                    "connectionMode":"lan","serverTime":"2026-08-19T07:00:00.000Z"}
                    """
                )
            }
            return Self.response(for: request, status: 200, json: "{\"workspaces\":[]}")
        }

        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { installation, credential in
                AidenRemoteClient(endpoint: installation.endpoint, credential: credential, session: session)
            }
        )
        await coordinator.start()

        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertEqual(store.activeInstallationId, "instance-2")
        XCTAssertNil(keychain.scoped[KeychainStore.scopedKey(.remoteCredential, scope: "instance-1")])
        XCTAssertEqual(
            keychain.scoped[KeychainStore.scopedKey(.remoteCredential, scope: "instance-2")],
            "credential-two"
        )
        XCTAssertTrue(coordinator.presentedError?.contains("revoked") == true)
    }

    private func makeClient() -> AidenRemoteClient {
        AidenRemoteClient(
            endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
            credential: "device-credential",
            session: makeSession()
        )
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AidenRemoteMockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private func makeBootstrap(now: Date) -> AidenRemoteContractFixture.PairingBootstrap {
        AidenRemoteContractFixture.PairingBootstrap(
            protocolVersion: 1,
            instanceId: "instance-1",
            endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
            serverSpkiSha256: "sha256/\(Data(repeating: 7, count: 32).base64EncodedString())",
            secret: String(repeating: "B", count: 43),
            expiresAt: now.addingTimeInterval(120)
        )
    }

    private func makeSystemTrust() -> AidenRemoteContractFixture.PairingTrust {
        AidenRemoteContractFixture.PairingTrust(mode: .system)
    }

    private func makePairingPayload(
        bootstrap: AidenRemoteContractFixture.PairingBootstrap
    ) -> AidenRemoteContractFixture.PairingPayload {
        AidenRemoteContractFixture.PairingPayload(
            bootstrap: bootstrap,
            trust: makeSystemTrust()
        )
    }

    private func makeExchange(
        instanceId: String,
        deviceId: String,
        credential: String
    ) -> AidenRemoteContractFixture.PairingExchange {
        AidenRemoteContractFixture.PairingExchange(
            protocolVersion: 1,
            instanceId: instanceId,
            deviceId: deviceId,
            credential: credential,
            capabilities: [.serverRead, .workspaceRead],
            endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
            serverSpkiSha256: "sha256/\(Data(repeating: 7, count: 32).base64EncodedString())"
        )
    }

    private static func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        let data = try bodyData(request)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func bodyData(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    private static func workspaceResponse(
        for request: URLRequest,
        status: Int,
        revision: String
    ) -> (HTTPURLResponse, Data) {
        response(
            for: request,
            status: status,
            json: """
            {"id":"workspace-1","name":"New Workspace","permission":"full",
            "hasFolder":false,"isManagedWorktree":false,
            "createdAt":"2026-08-19T07:00:00.000Z",
            "updatedAt":"2026-08-19T07:01:00.000Z","revision":"\(revision)"}
            """
        )
    }

    private static func chatResponse(
        for request: URLRequest,
        status: Int,
        revision: String,
        title: String = "New Chat"
    ) -> (HTTPURLResponse, Data) {
        response(
            for: request,
            status: status,
            json: """
            {"id":"chat-1","workspaceId":"workspace-1","title":"\(title)","messages":[],
            "createdAt":"2026-08-19T07:00:00.000Z","updatedAt":"2026-08-19T07:00:01.000Z",
            "revision":"\(revision)"}
            """
        )
    }

    private static func streamStatusResponse(
        for request: URLRequest,
        state: String
    ) -> (HTTPURLResponse, Data) {
        response(
            for: request,
            status: state == "cancelled" ? 202 : 200,
            json: """
            {"streamId":"stream-1","chatId":"chat-1","turnId":"turn-1","state":"\(state)",
            "lastSequence":3,"updatedAt":"2026-08-19T07:00:01.000Z"}
            """
        )
    }

    private static func response(
        for request: URLRequest,
        status: Int,
        json: String
    ) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, Data(json.utf8))
    }
}

private final class AidenRemoteMockURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class AidenRemoteMemoryKeychain: KeychainStoring {
    var values: [KeychainStore.Key: String] = [:]
    var scoped: [String: String] = [:]

    func save(_ value: String, forKey key: KeychainStore.Key) throws { values[key] = value }
    func load(_ key: KeychainStore.Key) throws -> String? { values[key] }
    func delete(_ key: KeychainStore.Key) throws { values[key] = nil }

    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        scoped[KeychainStore.scopedKey(key, scope: scope)] = value
    }

    func load(_ key: KeychainStore.Key, scope: String) throws -> String? {
        scoped[KeychainStore.scopedKey(key, scope: scope)]
    }

    func delete(_ key: KeychainStore.Key, scope: String) throws {
        scoped[KeychainStore.scopedKey(key, scope: scope)] = nil
    }
}
