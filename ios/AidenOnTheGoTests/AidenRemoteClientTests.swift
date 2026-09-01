import Foundation
import ImageIO
import UIKit
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

    func testClientDeviceIdentityPrefersSpecificUserAssignedName() {
        XCTAssertEqual(
            AidenClientDeviceIdentity.displayName(
                userAssignedName: "  Sambit’s   iPhone ",
                hostName: "fallback-phone.local",
                deviceType: .iphone,
                vendorIdentifier: nil
            ),
            "Sambit’s iPhone"
        )
    }

    func testClientDeviceIdentityUsesHostnameWhenUIKitNameIsGeneric() {
        XCTAssertEqual(
            AidenClientDeviceIdentity.displayName(
                userAssignedName: "iPhone",
                hostName: "Sambits-iPhone.local.",
                deviceType: .iphone,
                vendorIdentifier: nil
            ),
            "Sambits-iPhone"
        )
    }

    func testClientDeviceIdentityUsesStableTypedFallbackWhenNamesAreGeneric() {
        let identifier = UUID(uuidString: "12345678-90AB-CDEF-1234-567890ABCDEF")
        XCTAssertEqual(
            AidenClientDeviceIdentity.displayName(
                userAssignedName: "iPad",
                hostName: "localhost",
                deviceType: .ipad,
                vendorIdentifier: identifier
            ),
            "iPad · 123456"
        )
        XCTAssertEqual(
            AidenClientDeviceIdentity.displayName(
                userAssignedName: "Aiden On The Go",
                hostName: "iPhone.local",
                deviceType: .iphone,
                vendorIdentifier: nil
            ),
            "iPhone for Aiden"
        )
    }

    func testClientDeviceIdentityRejectsInvisibleNamesAndBoundsVisibleNames() {
        XCTAssertEqual(
            AidenClientDeviceIdentity.displayName(
                userAssignedName: "Unsafe\u{0000}Name",
                hostName: String(repeating: "A", count: 100),
                deviceType: .iphone,
                vendorIdentifier: nil
            ).count,
            80
        )
    }

    func testAuthenticatedDeviceIdentityRefreshUsesBoundedRoute() async throws {
        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            XCTAssertEqual(
                request.url?.absoluteString,
                "https://aiden.test/api/aiden/v1/device/identity"
            )
            XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(String(repeating: "C", count: 43))")
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Self.bodyData(request)) as? [String: Any]
            )
            XCTAssertEqual(object as NSDictionary, ["name": "Sambit’s iPhone"] as NSDictionary)
            return Self.response(
                for: request,
                status: 200,
                json: #"{"name":"Sambit’s iPhone"}"#
            )
        }
        let client = AidenRemoteClient(
            endpoint: try XCTUnwrap(URL(string: "https://aiden.test/api/aiden/v1")),
            credential: String(repeating: "C", count: 43),
            session: session
        )
        try await client.updateDeviceIdentity(name: "Sambit’s iPhone")
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
            XCTAssertEqual(object["acceptsDisplayName"] as? Bool, true)
            XCTAssertEqual(object["acceptsBotCapabilities"] as? Bool, true)
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
                  "serverSpkiSha256": "\(bootstrap.serverSpkiSha256)",
                  "futurePairingMetadata": {"safe": true}
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

    func testPairingOmitsBotCapabilityOptInWhenMobileRolloutIsDisabled() async throws {
        let now = Date(timeIntervalSince1970: 1_787_100_000)
        let bootstrap = makeBootstrap(now: now)
        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            let body = try Self.bodyData(request)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(object["acceptsBotCapabilities"] as? Bool, false)
            return Self.response(
                for: request,
                status: 200,
                json: """
                {
                  "protocolVersion": 1,
                  "instanceId": "instance-1",
                  "deviceId": "device-1",
                  "credential": "\(String(repeating: "C", count: 43))",
                  "capabilities": ["server:read", "workspace:read"],
                  "endpoint": "https://aiden.test/api/aiden/v1",
                  "serverSpkiSha256": "\(bootstrap.serverSpkiSha256)"
                }
                """
            )
        }

        _ = try await AidenRemoteClient.pair(
            payload: makePairingPayload(bootstrap: bootstrap),
            deviceName: "iPhone",
            deviceType: .iphone,
            clientVersion: "1.0",
            acceptsBotCapabilities: false,
            session: session,
            now: now
        )
    }

    func testManualPairingDecryptsSharedNodeVectorAndBindsSelectedEndpoint() async throws {
        let vectorURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "manual-pairing-vector", withExtension: "json")
        )
        let vectorData = try Data(contentsOf: vectorURL)
        let vector = try XCTUnwrap(
            JSONSerialization.jsonObject(with: vectorData) as? [String: Any]
        )
        let code = try XCTUnwrap(vector["code"] as? String)
        _ = try XCTUnwrap(vector["payload"] as? String)
        let bootstrap = try XCTUnwrap(vector["bootstrap"] as? [String: Any])
        let bootstrapData = try JSONSerialization.data(withJSONObject: bootstrap, options: [.sortedKeys])
        let endpoint = try XCTUnwrap(URL(string: "https://aiden-fixture.example.test/api/aiden/v1"))
        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            XCTAssertEqual(
                request.url?.absoluteString,
                "https://aiden-fixture.example.test/api/aiden/v1/pairing/manual-bootstrap"
            )
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(try Self.bodyData(request), Data("{}".utf8))
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": "application/json",
                    "Aiden-Protocol-Version": "1",
                ]
            ))
            return (response, bootstrapData)
        }

        let payload = try await AidenRemoteClient.manualPairingPayload(
            code: code.lowercased(),
            endpoint: endpoint,
            session: session,
            now: Date(timeIntervalSince1970: 1_787_331_600)
        )
        XCTAssertEqual(payload.kind, AidenRemoteContractFixture.PairingPayload.kindValue)
        XCTAssertEqual(payload.bootstrap.instanceId, "instance_fixture_01")
        XCTAssertEqual(payload.bootstrap.endpoint, endpoint)
        XCTAssertEqual(payload.bootstrap.secret, "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE")
        XCTAssertEqual(payload.trust.mode, .system)

        do {
            _ = try await AidenRemoteClient.manualPairingPayload(
                code: "1123-4567-89AB-CDEF-GHJK",
                endpoint: endpoint,
                session: session,
                now: Date(timeIntervalSince1970: 1_787_331_600)
            )
            XCTFail("Wrong setup code unexpectedly decrypted the pairing payload.")
        } catch {
            XCTAssertEqual(error as? AidenManualPairingError, .decryptionFailed)
        }

        let otherEndpoint = try XCTUnwrap(URL(string: "https://other-aiden.example.test/api/aiden/v1"))
        AidenRemoteMockURLProtocol.handler = { request in
            XCTAssertEqual(
                request.url?.absoluteString,
                "https://other-aiden.example.test/api/aiden/v1/pairing/manual-bootstrap"
            )
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": "application/json",
                    "Aiden-Protocol-Version": "1",
                ]
            ))
            return (response, bootstrapData)
        }
        do {
            _ = try await AidenRemoteClient.manualPairingPayload(
                code: code,
                endpoint: otherEndpoint,
                session: session,
                now: Date(timeIntervalSince1970: 1_787_331_600)
            )
            XCTFail("A setup envelope for another Mac endpoint was accepted.")
        } catch {
            XCTAssertEqual(error as? AidenManualPairingError, .endpointMismatch)
        }
    }

    func testManualPairingCodeRejectsAmbiguousUnicodeAndInvalidLength() throws {
        XCTAssertEqual(
            try AidenRemoteClient.normalizeManualPairingCode("0123-4567-89ab-cdef-ghjk"),
            "0123456789ABCDEFGHJK"
        )
        for invalid in [
            "0123-4567-89AB-CDEF-GHJI",
            "0123-4567-89AB-CDEF-GHJＫ",
            "ß123-4567-89AB-CDEF-GHJK",
            "ﬀ23-4567-89AB-CDEF-GHJK",
            "ſ123-4567-89AB-CDEF-GHJK",
            "0123-4567-89AB-CDEF",
            "0123-4567-89AB-CDEF-GHJK-X",
        ] {
            XCTAssertThrowsError(try AidenRemoteClient.normalizeManualPairingCode(invalid)) {
                XCTAssertEqual($0 as? AidenManualPairingError, .invalidCode)
            }
        }
    }

    func testManualPairingBootstrapRequiresCanonicalUnpaddedBase64URL() throws {
        let vectorURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "manual-pairing-vector", withExtension: "json")
        )
        let vector = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: vectorURL)) as? [String: Any]
        )
        let original = try XCTUnwrap(vector["bootstrap"] as? [String: Any])
        XCTAssertNoThrow(try AidenRemoteJSONDecoder.decodeManualPairingBootstrap(
            from: JSONSerialization.data(withJSONObject: original)
        ))

        var padded = original
        padded["salt"] = try XCTUnwrap(original["salt"] as? String) + "=="
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeManualPairingBootstrap(
            from: JSONSerialization.data(withJSONObject: padded)
        ))

        var standardAlphabet = original
        standardAlphabet["ciphertext"] = try XCTUnwrap(original["ciphertext"] as? String)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeManualPairingBootstrap(
            from: JSONSerialization.data(withJSONObject: standardAlphabet)
        ))
    }

    func testManualPairingBootstrapStopsAtTheTransportByteLimit() async throws {
        let endpoint = try XCTUnwrap(URL(string: "https://bounded-aiden.example.test/api/aiden/v1"))
        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": "application/json",
                    "Content-Length": "20000",
                    "Aiden-Protocol-Version": "1",
                ]
            ))
            return (response, Data(repeating: 0x41, count: 20_000))
        }
        do {
            _ = try await AidenRemoteClient.manualPairingPayload(
                code: "0123-4567-89AB-CDEF-GHJK",
                endpoint: endpoint,
                session: session
            )
            XCTFail("An oversized unauthenticated bootstrap response was buffered.")
        } catch {
            XCTAssertEqual(error as? AidenRemoteContractError, .payloadTooLarge)
        }
    }

    func testPairingRetriesFrozenFourFieldShapeForStrictEarlyV1Server() async throws {
        let now = Date(timeIntervalSince1970: 1_787_100_000)
        let bootstrap = makeBootstrap(now: now)
        let payload = makePairingPayload(bootstrap: bootstrap)
        let session = makeSession()
        var attempts = 0
        AidenRemoteMockURLProtocol.handler = { request in
            attempts += 1
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Self.bodyData(request)) as? [String: Any]
            )
            if attempts == 1 {
                XCTAssertEqual(object["acceptsDisplayName"] as? Bool, true)
                XCTAssertEqual(object["acceptsBotCapabilities"] as? Bool, true)
                return Self.response(
                    for: request,
                    status: 400,
                    json: #"{"error":{"code":"invalid_request","message":"Pairing details are invalid.","requestId":"request-legacy","retryable":false}}"#
                )
            }
            XCTAssertEqual(Set(object.keys), ["secret", "deviceName", "deviceType", "clientVersion"])
            return Self.response(
                for: request,
                status: 200,
                json: """
                {
                  "protocolVersion": 1,
                  "instanceId": "instance-1",
                  "deviceId": "device-1",
                  "credential": "\(String(repeating: "C", count: 43))",
                  "capabilities": ["server:read"],
                  "endpoint": "https://aiden.test/api/aiden/v1",
                  "serverSpkiSha256": "\(bootstrap.serverSpkiSha256)"
                }
                """
            )
        }

        let exchange = try await AidenRemoteClient.pair(
            payload: payload,
            deviceName: "Legacy Test Phone",
            deviceType: .iphone,
            clientVersion: "1.0",
            session: session,
            now: now
        )
        XCTAssertEqual(attempts, 2)
        XCTAssertNil(exchange.displayName)
    }

    func testServerSeparatesDeviceGrantsFromSupportAndIgnoresAdditiveFields() async throws {
        let client = makeClient()
        AidenRemoteMockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://aiden.test/api/aiden/v1/server")
            return Self.response(
                for: request,
                status: 200,
                json: """
                {
                  "protocolVersion": 1,
                  "instanceId": "instance-1",
                  "name": "Home Mac",
                  "appVersion": "1.0",
                  "capabilities": ["server:read", "bot:read"],
                  "serverCapabilities": ["server:read", "bot:read", "bot:write"],
                  "deviceName": "Sambit’s iPhone",
                  "connectionMode": "lan",
                  "serverTime": "2026-08-19T07:00:00.000Z",
                  "futurePresentation": {"safe": true}
                }
                """
            )
        }

        let server = try await client.server()
        XCTAssertEqual(server.capabilities, [.serverRead, .botRead])
        XCTAssertEqual(server.serverCapabilities, [.serverRead, .botRead, .botWrite])
        XCTAssertEqual(server.deviceName, "Sambit’s iPhone")
    }

    func testServerRequiresValidIdentityAndDeviceGrantFields() throws {
        let missingIdentity = Data("""
        {"protocolVersion":1,"name":"Mac","appVersion":"1.0",
        "capabilities":["server:read"],"connectionMode":"lan",
        "serverTime":"2026-08-19T07:00:00.000Z"}
        """.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenServer.self, from: missingIdentity))

        let missingGrants = Data("""
        {"protocolVersion":1,"instanceId":"instance-1","name":"Mac","appVersion":"1.0",
        "connectionMode":"lan","serverTime":"2026-08-19T07:00:00.000Z"}
        """.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenServer.self, from: missingGrants))

        let nullSupport = Data("""
        {"protocolVersion":1,"instanceId":"instance-1","name":"Mac","appVersion":"1.0",
        "capabilities":["server:read"],"serverCapabilities":null,"connectionMode":"lan",
        "serverTime":"2026-08-19T07:00:00.000Z"}
        """.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenServer.self, from: nullSupport))
    }

    func testCanonicalChatSummaryFixtureAndServerFeatureAdvertisementDecode() throws {
        let fixture: AidenRemoteContractFixture = try botFixtureValue(at: [])
        let server = fixture.server
        XCTAssertTrue(server.supportsChatSummaries)
        XCTAssertEqual(server.features, [AidenServer.chatSummariesFeature])

        let page = fixture.chatSummaries
        XCTAssertEqual(page.summaries.map(\.id), [
            "chat_fixture_summary_02",
            "chat_fixture_summary_01",
        ])
        XCTAssertEqual(page.summaries.map(\.activity), [.active, .idle])
        XCTAssertEqual(page.summaries.map(\.titlePending), [true, false])
        XCTAssertNotNil(page.nextCursor)
    }

    func testChatSummaryDecoderToleratesAdditiveFieldsButRejectsMissingRequiredFields() throws {
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: botFixtureData(at: ["chatSummaries"])) as? [String: Any]
        )
        var summaries = try XCTUnwrap(object["summaries"] as? [[String: Any]])
        summaries[0]["futurePresentation"] = ["badge": "safe"]
        object["summaries"] = summaries
        object["futurePageMetadata"] = true
        let additive = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        XCTAssertNoThrow(try AidenRemoteJSONDecoder.decode(AidenChatSummaryPage.self, from: additive))

        for field in [
            "id", "workspaceId", "title", "titlePending", "createdAt", "updatedAt", "revision", "activity",
        ] {
            var invalid = summaries[0]
            invalid.removeValue(forKey: field)
            let data = try JSONSerialization.data(
                withJSONObject: ["summaries": [invalid]],
                options: [.sortedKeys]
            )
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decode(AidenChatSummaryPage.self, from: data),
                "Missing required field \(field) must fail closed."
            )
        }

        object["nextCursor"] = NSNull()
        let nullCursor = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenChatSummaryPage.self, from: nullCursor))
    }

    func testChatSummaryDecoderRecursivelyRejectsPrivateProjectionFields() throws {
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: botFixtureData(at: ["chatSummaries"])) as? [String: Any]
        )
        var summaries = try XCTUnwrap(object["summaries"] as? [[String: Any]])
        summaries[0]["futurePresentation"] = [
            "nested": ["subagentProjectionNotices": ["private Mac-only context"]],
        ]
        object["summaries"] = summaries
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])

        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenChatSummaryPage.self, from: data)) {
            guard case AidenRemoteContractError.unsafePayloadField("subagentProjectionNotices") = $0 else {
                return XCTFail("Expected the recursive private-field denial, got \($0)")
            }
        }

        var fixtureRoot = try XCTUnwrap(
            JSONSerialization.jsonObject(with: botFixtureData(at: [])) as? [String: Any]
        )
        fixtureRoot["chatSummaries"] = object
        let fixtureData = try JSONSerialization.data(withJSONObject: fixtureRoot, options: [.sortedKeys])
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenRemoteContractFixture.self, from: fixtureData)
        )

        for forbiddenField in [
            "messages", "attachments", "htmlArtifacts", "outcome", "timeline", "reasoning",
            "botId", "providerId", "modelId", "preview",
        ] {
            var forbiddenObject = try XCTUnwrap(
                JSONSerialization.jsonObject(with: botFixtureData(at: ["chatSummaries"])) as? [String: Any]
            )
            var forbiddenSummaries = try XCTUnwrap(forbiddenObject["summaries"] as? [[String: Any]])
            forbiddenSummaries[0]["futurePresentation"] = [
                "nested": [forbiddenField: "private detail"],
            ]
            forbiddenObject["summaries"] = forbiddenSummaries
            let forbiddenData = try JSONSerialization.data(
                withJSONObject: forbiddenObject,
                options: [.sortedKeys]
            )
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decode(AidenChatSummaryPage.self, from: forbiddenData),
                "Summary payload field \(forbiddenField) must fail closed."
            )
        }

        for privateAlias in [
            "childParentRunId",
            "children_latest_messages",
            "subagentProjectionNotices",
            "subagent-run-history",
            "childTimedOut",
        ] {
            var aliasObject = try XCTUnwrap(
                JSONSerialization.jsonObject(with: botFixtureData(at: ["chatSummaries"])) as? [String: Any]
            )
            var aliasSummaries = try XCTUnwrap(aliasObject["summaries"] as? [[String: Any]])
            aliasSummaries[0]["futurePresentation"] = [
                "nested": [[privateAlias: "private child state"]],
            ]
            aliasObject["summaries"] = aliasSummaries
            let aliasData = try JSONSerialization.data(withJSONObject: aliasObject, options: [.sortedKeys])
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decode(AidenChatSummaryPage.self, from: aliasData),
                "Segmented private alias \(privateAlias) must fail closed."
            )
        }

        var harmlessObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: botFixtureData(at: ["chatSummaries"])) as? [String: Any]
        )
        var harmlessSummaries = try XCTUnwrap(harmlessObject["summaries"] as? [[String: Any]])
        harmlessSummaries[0]["futurePresentation"] = [
            "nested": ["agentStatus": "safe", "childhood": "safe", "childrenPlayground": "safe"],
        ]
        harmlessObject["summaries"] = harmlessSummaries
        XCTAssertNoThrow(try AidenRemoteJSONDecoder.decode(
            AidenChatSummaryPage.self,
            from: JSONSerialization.data(withJSONObject: harmlessObject, options: [.sortedKeys])
        ))
    }

    func testRegularChatDecoderRejectsNestedPrivateChildAliases() throws {
        let chat = Data("""
        {"id":"chat-regular","workspaceId":"workspace-regular","title":"Regular",
        "messages":[],"createdAt":"2026-08-19T07:00:00.000Z",
        "updatedAt":"2026-08-19T07:01:00.000Z","revision":"legacy-revision",
        "futurePresentation":{"nested":[{"childParentRunId":"private-run"}]}}
        """.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenChat.self, from: chat)) {
            guard case AidenRemoteContractError.unsafePayloadField("childParentRunId") = $0 else {
                return XCTFail("Expected private child alias rejection, got \($0)")
            }
        }
    }

    func testLegacyChatListFallbackRejectsNestedPrivateChildAliases() async throws {
        let client = makeClient()
        AidenRemoteMockURLProtocol.handler = { request in
            Self.response(
                for: request,
                status: 200,
                json: """
                {"chats":[{"id":"chat-regular","workspaceId":"workspace-regular","title":"Regular",
                "messages":[],"createdAt":"2026-08-19T07:00:00.000Z",
                "updatedAt":"2026-08-19T07:01:00.000Z","revision":"legacy-revision",
                "futurePresentation":{"nested":{"childrenLatestMessages":[]}}}]}
                """
            )
        }

        do {
            _ = try await client.preferredChatSummaries(advertised: false)
            XCTFail("Legacy chat lists must reject private child projections.")
        } catch AidenRemoteContractError.unsafePayloadField("childrenLatestMessages") {
            // Expected.
        }
    }

    func testChatSummaryDecoderRejectsInvalidActivityOrderingDuplicatesAndBounds() throws {
        let valid = try XCTUnwrap(
            JSONSerialization.jsonObject(with: botFixtureData(at: ["chatSummaries"])) as? [String: Any]
        )
        let summaries = try XCTUnwrap(valid["summaries"] as? [[String: Any]])

        var unknownActivity = summaries[0]
        unknownActivity["activity"] = "working"
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
            AidenChatSummaryPage.self,
            from: JSONSerialization.data(withJSONObject: ["summaries": [unknownActivity]])
        ))

        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
            AidenChatSummaryPage.self,
            from: JSONSerialization.data(withJSONObject: ["summaries": summaries.reversed()])
        ))
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
            AidenChatSummaryPage.self,
            from: JSONSerialization.data(withJSONObject: ["summaries": [summaries[0], summaries[0]]])
        ))

        var oversizedTitle = summaries[0]
        oversizedTitle["title"] = String(repeating: "x", count: 1_025)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
            AidenChatSummaryPage.self,
            from: JSONSerialization.data(withJSONObject: ["summaries": [oversizedTitle]])
        ))

        for (field, value) in [
            ("id", "unsafe/id"),
            ("workspaceId", "unsafe workspace"),
            ("revision", "legacy-revision"),
        ] {
            var invalid = summaries[0]
            invalid[field] = value
            XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
                AidenChatSummaryPage.self,
                from: JSONSerialization.data(withJSONObject: ["summaries": [invalid]])
            ))
        }

        var invalidCursorPage = valid
        invalidCursorPage["nextCursor"] = "cur_missing-signature"
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
            AidenChatSummaryPage.self,
            from: JSONSerialization.data(withJSONObject: invalidCursorPage)
        ))
    }

    func testServerFeaturesTolerateUnknownBoundedTokensAndRejectInvalidSets() throws {
        var serverObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: botFixtureData(at: ["server"])) as? [String: Any]
        )
        serverObject["features"] = ["chat-summaries-v1", "future-safe-feature"]
        let additive = try JSONSerialization.data(withJSONObject: serverObject, options: [.sortedKeys])
        let server = try AidenRemoteJSONDecoder.decode(AidenServer.self, from: additive)
        XCTAssertTrue(server.supportsChatSummaries)
        XCTAssertEqual(server.features.last, "future-safe-feature")

        serverObject["features"] = (0..<32).map { "feature-\($0)" }
        XCTAssertNoThrow(try AidenRemoteJSONDecoder.decode(
            AidenServer.self,
            from: JSONSerialization.data(withJSONObject: serverObject, options: [.sortedKeys])
        ))

        let invalidFeatureSets: [Any] = [
            ["chat-summaries-v1", "chat-summaries-v1"],
            ["Uppercase"],
            [String(repeating: "x", count: 65)],
            (0..<33).map { "feature-\($0)" },
            NSNull(),
        ]
        for invalidFeatures in invalidFeatureSets {
            serverObject["features"] = invalidFeatures
            let data = try JSONSerialization.data(withJSONObject: serverObject, options: [.sortedKeys])
            XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenServer.self, from: data))
        }
    }

    func testPreferredChatSummariesUsesAdvertisedEndpointAndFallsBackForOldMacs() async throws {
        let client = makeClient()
        let fixture = try botFixtureData(at: ["chatSummaries"])
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            switch step {
            case 1:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chat-summaries")
                XCTAssertEqual(
                    URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems,
                    [URLQueryItem(name: "limit", value: "200")]
                )
                return Self.response(for: request, status: 200, data: fixture)
            case 2:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats")
                return Self.response(for: request, status: 200, json: #"{"chats":[]}"#)
            default:
                XCTFail("Unexpected summary fallback request")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let preferred = try await client.preferredChatSummaries(advertised: true, limit: 200)
        XCTAssertEqual(preferred.summaries.count, 2)
        let oldMac = try await client.preferredChatSummaries(advertised: false)
        XCTAssertEqual(oldMac.summaries, [])
        XCTAssertEqual(step, 2)
    }

    func testAdvertisedChatSummaryFailureSurfacesWithoutLegacyDowngrade() async throws {
        let client = makeClient()
        var requests = 0
        AidenRemoteMockURLProtocol.handler = { request in
            requests += 1
            XCTAssertEqual(request.url?.path, "/api/aiden/v1/chat-summaries")
            return Self.response(
                for: request,
                status: 404,
                json: #"{"error":{"code":"not_found","message":"Unavailable","requestId":"request-1","retryable":false}}"#
            )
        }

        do {
            _ = try await client.preferredChatSummaries(advertised: true)
            XCTFail("An advertised endpoint failure must not be hidden by legacy fallback.")
        } catch let AidenRemoteClientError.server(statusCode, _) {
            XCTAssertEqual(statusCode, 404)
        }
        XCTAssertEqual(requests, 1)
    }

    func testLegacyChatFallbackPreservesRevisionForMutationIfMatch() async throws {
        let client = makeClient()
        let legacyRevision = "legacy-chat-revision-7"
        let legacyChat = """
        {"id":"chat-legacy","workspaceId":"workspace-legacy","title":"Legacy",
        "messages":[],"createdAt":"2026-08-19T07:00:00.000Z",
        "updatedAt":"2026-08-19T07:01:00.000Z","revision":"\(legacyRevision)"}
        """
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            switch step {
            case 1:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats")
                return Self.response(for: request, status: 200, json: "{\"chats\":[\(legacyChat)]}")
            case 2:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats/chat-legacy")
                XCTAssertEqual(request.httpMethod, "PATCH")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), legacyRevision)
                return Self.response(for: request, status: 200, json: legacyChat)
            default:
                XCTFail("Unexpected legacy mutation request")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let page = try await client.preferredChatSummaries(advertised: false)
        let summary = try XCTUnwrap(page.summaries.first)
        XCTAssertEqual(summary.revision, legacyRevision)
        _ = try await client.updateChat(id: summary.id, revision: summary.revision, title: "Renamed")
        XCTAssertEqual(step, 2)
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

    func testBotDetailRoutesCarryMutationHeadersAndAcceptOnlyCanonicalStatuses() async throws {
        let client = makeClient()
        let botID = "bot_fixture_01"
        let detail = try botFixtureData(at: ["botDetail"])
        let identity = try botFixtureData(at: ["botIdentity", "response"])
        let archive = try botFixtureData(at: ["botArchive"])
        let restore = try botFixtureData(at: ["botRestore"])
        let avatarDeleted = try botFixtureData(at: ["botCreate", "response"])
        let idempotencyKey = UUID(uuidString: "67494088-35C0-4204-84CB-BDF2E04C31FC")!
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-credential")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Aiden-Protocol-Version"), "1")
            switch step {
            case 1:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots/\(botID)")
                return Self.response(for: request, status: 200, data: detail)
            case 2:
                XCTAssertEqual(request.httpMethod, "PATCH")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots/\(botID)")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "bot_revision_7")
                XCTAssertEqual(try Self.jsonBody(request)["purpose"] as? String, "Updated purpose")
                return Self.response(for: request, status: 200, data: identity)
            case 3:
                XCTAssertEqual(request.httpMethod, "DELETE")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots/\(botID)")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "bot_revision_8")
                return Self.response(for: request, status: 200, data: archive)
            case 4:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots/\(botID)/restore")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "bot_revision_9")
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "Idempotency-Key"),
                    idempotencyKey.uuidString.lowercased()
                )
                return Self.response(for: request, status: 200, data: restore)
            case 5:
                XCTAssertEqual(request.httpMethod, "DELETE")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots/\(botID)/avatar")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "bot_revision_10")
                return Self.response(for: request, status: 200, data: avatarDeleted)
            case 6:
                return Self.response(for: request, status: 201, data: detail)
            default:
                XCTFail("Unexpected Bot detail request")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let fetched = try await client.bot(id: botID)
        XCTAssertEqual(fetched.id, botID)
        let updated = try await client.updateBotIdentity(
            id: botID,
            revision: "bot_revision_7",
            patch: AidenBotIdentityPatch(purpose: "Updated purpose")
        )
        XCTAssertEqual(updated.id, botID)
        let archived = try await client.archiveBot(id: botID, revision: "bot_revision_8")
        XCTAssertEqual(archived.health, .archived)
        let restored = try await client.restoreBot(
            id: botID,
            revision: "bot_revision_9",
            idempotencyKey: idempotencyKey
        )
        XCTAssertEqual(restored.health, .ready)
        let avatarRemoved = try await client.deleteBotAvatar(
            botId: botID,
            revision: "bot_revision_10"
        )
        XCTAssertNil(avatarRemoved.avatar.asset)
        await assertUnexpectedStatus(201) {
            try await client.bot(id: botID)
        }
        XCTAssertEqual(step, 6)
    }

    func testBotDetailRoutesRejectCrossBotResponseIdentity() async throws {
        let client = makeClient()
        let expectedID = "bot_expected_01"
        let responses = [
            try botFixtureData(at: ["botDetail"]),
            try botFixtureData(at: ["botIdentity", "response"]),
            try botFixtureData(at: ["botArchive"]),
            try botFixtureData(at: ["botRestore"]),
            try botFixtureData(at: ["botCreate", "response"]),
        ]
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            defer { step += 1 }
            return Self.response(for: request, status: 200, data: responses[step])
        }

        await assertInvalidResponse { try await client.bot(id: expectedID) }
        await assertInvalidResponse {
            try await client.updateBotIdentity(
                id: expectedID,
                revision: "bot_revision_1",
                patch: AidenBotIdentityPatch(name: "Expected")
            )
        }
        await assertInvalidResponse {
            try await client.archiveBot(id: expectedID, revision: "bot_revision_2")
        }
        await assertInvalidResponse {
            try await client.restoreBot(id: expectedID, revision: "bot_revision_3")
        }
        await assertInvalidResponse {
            try await client.deleteBotAvatar(botId: expectedID, revision: "bot_revision_4")
        }
        XCTAssertEqual(step, 5)
    }

    @MainActor
    func testBotProfileDeleteFetchesAuthoritativeChatAndUsesItsRevision() async throws {
        let client = makeClient()
        let projection: AidenBotConversationItem = try botFixtureValue(at: ["botConversation"])
        var chatObject = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: botFixtureData(at: ["botChatCreate", "response"])
            ) as? [String: Any]
        )
        chatObject["id"] = projection.id
        chatObject["revision"] = "authoritative_chat_revision_42"
        let authoritativeChat = try JSONSerialization.data(
            withJSONObject: chatObject,
            options: [.sortedKeys]
        )
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            switch step {
            case 1:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats/\(projection.id)")
                return Self.response(for: request, status: 200, data: authoritativeChat)
            case 2:
                XCTAssertEqual(request.httpMethod, "DELETE")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats/\(projection.id)")
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "If-Match"),
                    "authoritative_chat_revision_42"
                )
                XCTAssertNotEqual(
                    request.value(forHTTPHeaderField: "If-Match"),
                    projection.revision
                )
                return Self.response(for: request, status: 204, data: Data())
            default:
                XCTFail("Unexpected Bot profile delete request")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let deleted = try await aidenBotProfileDeleteConversation(
            client: client,
            projection: projection,
            expectedBotID: projection.botId,
            isCurrent: { true }
        )

        XCTAssertEqual(deleted.id, projection.id)
        XCTAssertEqual(deleted.revision, "authoritative_chat_revision_42")
        XCTAssertEqual(step, 2)
    }

    @MainActor
    func testBotProfileLifecycleRefreshesFavoritesAfterArchive() async throws {
        let client = makeClient()
        let botID = "bot_fixture_01"
        let archive = try botFixtureData(at: ["botArchive"])
        let favorites = try botFixtureData(at: ["botFavorites"])
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            switch step {
            case 1:
                XCTAssertEqual(request.httpMethod, "DELETE")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots/\(botID)")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "bot_revision_8")
                return Self.response(for: request, status: 200, data: archive)
            case 2:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bot-favorites")
                return Self.response(for: request, status: 200, data: favorites)
            default:
                XCTFail("Unexpected Bot profile lifecycle request")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let result = try await aidenBotProfileLifecycleUpdate(
            client: client,
            botID: botID,
            revision: "bot_revision_8",
            action: .archive,
            isCurrent: { true }
        )

        XCTAssertEqual(result.detail.health, .archived)
        XCTAssertEqual(result.favorites.revision, "bot_favorites_revision_2")
        XCTAssertEqual(step, 2)
    }

    @MainActor
    func testLostBotChatCreateResponseRetainsTheExactAttemptKey() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            makeExchange(
                instanceId: "instance-create",
                deviceId: "device-create",
                credential: "credential-create",
                capabilities: [.serverRead, .botRead, .botWrite]
            ),
            trust: makeSystemTrust(),
            name: "Create Mac"
        )
        let coordinator = AidenRemoteCoordinator(installationStore: store)
        let context = try coordinator.requestContext()
        let request = try AidenBotChatCreateRequest()
        let key = UUID(uuidString: "E677979B-C361-4F0A-8C25-C9C2A628314F")!
        let first = aidenBotConversationCreateAttempt(
            retaining: nil,
            context: context,
            botID: "bot-a",
            request: request,
            makeKey: { key }
        )
        XCTAssertTrue(aidenBotConversationCreateFailureIsAmbiguous(URLError(.networkConnectionLost)))
        let retry = aidenBotConversationCreateAttempt(
            retaining: first,
            context: context,
            botID: "bot-a",
            request: request,
            makeKey: { XCTFail("Exact retry must reuse its key"); return UUID() }
        )
        XCTAssertEqual(retry, first)
        XCTAssertNotEqual(
            aidenBotConversationCreateAttempt(
                retaining: first,
                context: context,
                botID: "bot-b",
                request: request
            ).idempotencyKey,
            key
        )
        XCTAssertTrue(aidenBotConversationCreateFailureIsAmbiguous(AidenRemoteClientError.invalidResponse))
        XCTAssertFalse(aidenBotConversationCreateFailureIsAmbiguous(AidenRemoteClientError.unexpectedStatus(409)))
    }

    func testRemainingBotAPIsUseCanonicalRoutesQueriesPreconditionsAndResponseAffinity() async throws {
        let client = makeClient()
        let botID = "bot_fixture_01"
        let chatID = "chat_bot_fixture_01"
        let createBot: AidenBotCreateRequest = try botFixtureValue(at: ["botCreate", "request"])
        let query: AidenBotConversationQuery = try botFixtureValue(at: ["botConversationQuery"])
        let createChat: AidenBotChatCreateRequest = try botFixtureValue(at: ["botChatCreate", "request"])
        let botAccessUpdate: AidenBotAccessUpdate = try botFixtureValue(at: ["botPolicyUpdate", "request"])
        let chatAccessUpdate: AidenBotChatAccessUpdate = try botFixtureValue(
            at: ["botChatSubsetUpdate", "request"]
        )
        let favoritesUpdate: AidenBotFavoritesUpdateRequest = try botFixtureValue(
            at: ["botFavoritesUpdate", "request"]
        )
        let noticeAcknowledgement: AidenBotNoticeAcknowledgement = try botFixtureValue(
            at: ["botNoticeAcknowledgement", "request"]
        )
        let botCreationKey = UUID(uuidString: "76ED0E79-2DFC-43BE-92D5-98DCC3D83707")!
        let chatCreationKey = UUID(uuidString: "09EB5E53-A869-4363-9DC6-F305E2AE1E8A")!
        let noticeKey = UUID(uuidString: "3C3A5A71-4F21-4E02-A7EA-4AA33EE5EF60")!
        let responses = [
            try botFixtureData(at: ["botList"]),
            try botFixtureData(at: ["botCreate", "response"]),
            try botFixtureData(at: ["botConversations"]),
            try botFixtureData(at: ["botChatCreate", "response"]),
            try botFixtureData(at: ["botCapabilityCatalog"]),
            try botFixtureData(at: ["botPolicyUpdate", "response"]),
            try botFixtureData(at: ["botChatSubset"]),
            try botFixtureData(at: ["botChatSubsetUpdate", "response"]),
            try botFixtureData(at: ["botFavorites"]),
            try botFixtureData(at: ["botFavoritesUpdate", "response"]),
            try botFixtureData(at: ["botNotice"]),
            try botFixtureData(at: ["botNoticeAcknowledgement", "response"]),
        ]
        var mismatchedPage = try XCTUnwrap(
            JSONSerialization.jsonObject(with: responses[2]) as? [String: Any]
        )
        var mismatchedConversations = try XCTUnwrap(
            mismatchedPage["conversations"] as? [[String: Any]]
        )
        mismatchedConversations[0]["botId"] = "bot_other_01"
        mismatchedPage["conversations"] = mismatchedConversations
        let mismatchData = try JSONSerialization.data(withJSONObject: mismatchedPage)

        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-credential")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Aiden-Protocol-Version"), "1")
            switch step {
            case 1:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots")
                XCTAssertEqual(
                    URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems,
                    [URLQueryItem(name: "includeArchived", value: "true")]
                )
            case 2:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots")
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "Idempotency-Key"),
                    botCreationKey.uuidString.lowercased()
                )
                XCTAssertEqual(try Self.jsonBody(request)["name"] as? String, "Scout")
            case 3, 13:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bot-conversations")
                XCTAssertEqual(
                    URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems,
                    [
                        URLQueryItem(name: "cursor", value: "bot_cursor_fixture_01"),
                        URLQueryItem(name: "query", value: "week"),
                        URLQueryItem(name: "botId", value: botID),
                        URLQueryItem(name: "limit", value: "30"),
                    ]
                )
                if step == 13 {
                    return Self.response(for: request, status: 200, data: mismatchData)
                }
            case 4:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots/\(botID)/chats")
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "Idempotency-Key"),
                    chatCreationKey.uuidString.lowercased()
                )
                XCTAssertEqual(try Self.jsonBody(request)["modelId"] as? String, "model_fixture")
            case 5:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bot-capabilities")
            case 6:
                XCTAssertEqual(request.httpMethod, "PATCH")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots/\(botID)/capabilities")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "bot_policy_revision_4")
                XCTAssertEqual(try Self.jsonBody(request)["accessMode"] as? String, "custom")
            case 7:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats/\(chatID)/capabilities")
            case 8:
                XCTAssertEqual(request.httpMethod, "PATCH")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats/\(chatID)/capabilities")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "chat_policy_revision_2")
                XCTAssertEqual(try Self.jsonBody(request)["mode"] as? String, "custom")
            case 9:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bot-favorites")
            case 10:
                XCTAssertEqual(request.httpMethod, "PATCH")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bot-favorites")
                XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "bot_favorites_revision_1")
                XCTAssertEqual(try Self.jsonBody(request)["botIds"] as? [String], [botID])
            case 11:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bot-access-notice")
            case 12:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(
                    request.url?.path,
                    "/api/aiden/v1/bot-access-notice/acknowledgement"
                )
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "Idempotency-Key"),
                    noticeKey.uuidString.lowercased()
                )
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["decision"] as? String, "continue_full")
                XCTAssertEqual(body["confirmedForeground"] as? Bool, true)
            default:
                XCTFail("Unexpected Bot API request")
            }
            return Self.response(for: request, status: step == 2 || step == 4 ? 201 : 200, data: responses[step - 1])
        }

        let bots = try await client.bots(includeArchived: true)
        XCTAssertEqual(bots.bots.first?.id, botID)
        let createdBot = try await client.createBot(createBot, idempotencyKey: botCreationKey)
        XCTAssertEqual(createdBot.id, botID)
        let conversations = try await client.botConversations(query: query)
        XCTAssertEqual(conversations.conversations.first?.botId, botID)
        let createdChat = try await client.createBotChat(
            botId: botID,
            request: createChat,
            idempotencyKey: chatCreationKey
        )
        XCTAssertEqual(createdChat.botId, botID)
        let catalog = try await client.botCapabilityCatalog()
        XCTAssertEqual(catalog.revision, "bot_catalog_revision_3")
        let updatedBotAccess = try await client.updateBotAccess(
            botId: botID,
            revision: "bot_policy_revision_4",
            update: botAccessUpdate
        )
        XCTAssertEqual(updatedBotAccess.botId, botID)
        let chatAccess = try await client.botChatAccess(chatId: chatID)
        XCTAssertEqual(chatAccess.chatId, chatID)
        let updatedChatAccess = try await client.updateBotChatAccess(
            chatId: chatID,
            revision: "chat_policy_revision_2",
            update: chatAccessUpdate
        )
        XCTAssertEqual(updatedChatAccess.chatId, chatID)
        let favorites = try await client.botFavorites()
        XCTAssertEqual(favorites.botIds, [botID])
        let updatedFavorites = try await client.updateBotFavorites(
            favoritesUpdate,
            revision: "bot_favorites_revision_1"
        )
        XCTAssertEqual(updatedFavorites.botIds, [botID])
        let notice = try await client.botAccessNotice()
        XCTAssertTrue(notice.requiresAcknowledgement)
        let acknowledgedNotice = try await client.acknowledgeBotAccessNotice(
            noticeAcknowledgement,
            idempotencyKey: noticeKey
        )
        XCTAssertFalse(acknowledgedNotice.requiresAcknowledgement)
        await assertInvalidResponse { try await client.botConversations(query: query) }
        XCTAssertEqual(step, 13)
    }

    func testBotFileRoutesUseBoundedFilePayloadsAndValidateCanonicalResponses() async throws {
        let client = makeClient()
        let fileID = "file_\(String(repeating: "F", count: 43))"
        let content = String(repeating: "x", count: AidenRemoteProtocol.maxJSONBodyBytes + 16_384)
        let index = Data("""
        {"snapshotId":"snapshot_1","entries":[{"id":"\(fileID)","displayPath":"notes.md",
        "name":"notes.md","kind":"file","size":\(content.count),"language":"markdown"}],
        "truncated":false,"maxEntries":4000,"maxDepth":20}
        """.utf8)
        let document = try JSONSerialization.data(withJSONObject: [
            "id": fileID,
            "displayPath": "notes.md",
            "content": content,
            "version": "file_revision_1",
            "truncated": false,
        ])
        let unsafeIndex = Data("""
        {"snapshotId":"snapshot_2","entries":[{"id":"\(fileID)","displayPath":"../private.txt",
        "name":"private.txt","kind":"file","size":1}],"truncated":false,"maxEntries":4000,"maxDepth":20}
        """.utf8)
        let wrongDocument = try JSONSerialization.data(withJSONObject: [
            "id": "file_\(String(repeating: "W", count: 43))",
            "displayPath": "notes.md",
            "content": "wrong identity",
            "version": "file_revision_2",
            "truncated": false,
        ])
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            switch step {
            case 1:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/bot-conversations/chat_bot_01/files")
                return Self.response(for: request, status: 200, data: index)
            case 2:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(
                    request.url?.path,
                    "/api/aiden/v1/bot-conversations/chat_bot_01/files/\(fileID)"
                )
                return Self.response(for: request, status: 200, data: document)
            case 3:
                XCTAssertEqual(request.httpMethod, "PUT")
                XCTAssertEqual(
                    request.url?.path,
                    "/api/aiden/v1/bot-conversations/chat_bot_01/files/\(fileID)"
                )
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["content"] as? String, "Saved")
                XCTAssertEqual(body["expectedVersion"] as? String, "file_revision_1")
                return Self.response(for: request, status: 200, data: document)
            case 4:
                return Self.response(for: request, status: 200, data: unsafeIndex)
            case 5:
                return Self.response(for: request, status: 200, data: wrongDocument)
            default:
                XCTFail("Unexpected Bot file request")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let files = try await client.botConversationFiles(chatId: "chat_bot_01")
        XCTAssertEqual(files.entries.first?.id, fileID)
        let loaded = try await client.botConversationFile(chatId: "chat_bot_01", fileId: fileID)
        XCTAssertEqual(
            loaded.content.count,
            content.count,
            "Bot files must use the larger bounded file JSON limit, not the ordinary JSON limit."
        )
        let saved = try await client.writeBotConversationFile(
            chatId: "chat_bot_01",
            fileId: fileID,
            content: "Saved",
            expectedVersion: "file_revision_1"
        )
        XCTAssertEqual(saved.id, fileID)
        await assertInvalidResponse {
            try await client.botConversationFiles(chatId: "chat_bot_01")
        }
        await assertInvalidResponse {
            try await client.botConversationFile(chatId: "chat_bot_01", fileId: fileID)
        }
        XCTAssertEqual(step, 5)
    }

    func testBotAvatarRequiresCompleteSingleFrameDecodableCanonicalPNG() async throws {
        let client = makeClient()
        let revision = "avatar_revision_\(String(repeating: "a", count: 32))"
        let canonicalPNG = Self.pngData(width: 512, height: 512, color: .systemIndigo)
        let wrongSizePNG = Self.pngData(width: 256, height: 256, color: .systemIndigo)
        let animatedPNG = try Self.animatedPNGData()
        var trailingPNG = canonicalPNG
        trailingPNG.append(contentsOf: [0x41, 0x49, 0x44, 0x45, 0x4E])
        var forgedHeader = Data([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
        forgedHeader.append(contentsOf: [0, 0, 2, 0, 0, 0, 2, 0])
        let invalidPayloads = [wrongSizePNG, forgedHeader, animatedPNG, trailingPNG]
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(
                request.url?.path,
                "/api/aiden/v1/bots/bot_fixture_01/avatar/\(revision)"
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "image/png")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-credential")
            if step == 1 {
                return Self.imageResponse(for: request, status: 200, data: canonicalPNG)
            }
            if step == 6 {
                return Self.imageResponse(
                    for: request,
                    status: 200,
                    data: canonicalPNG,
                    headers: ["Cache-Control": "no-store"]
                )
            }
            if step == 7 {
                return Self.imageResponse(for: request, status: 201, data: canonicalPNG)
            }
            return Self.imageResponse(for: request, status: 200, data: invalidPayloads[step - 2])
        }

        let content = try await client.botAvatar(botId: "bot_fixture_01", assetRevision: revision)
        XCTAssertEqual(content.data, canonicalPNG)
        XCTAssertEqual(content.assetRevision, revision)
        for _ in 0..<5 {
            await assertInvalidResponse {
                try await client.botAvatar(botId: "bot_fixture_01", assetRevision: revision)
            }
        }
        await assertUnexpectedStatus(201) {
            try await client.botAvatar(botId: "bot_fixture_01", assetRevision: revision)
        }
        XCTAssertEqual(step, 7)
    }

    func testBotAvatarUploadCarriesRevisionIdempotencyAndCanonicalStatus() async throws {
        let client = makeClient()
        let uploadData = Self.pngData(width: 32, height: 32, color: .systemTeal)
        let upload = try AidenBotAvatarUpload(
            mimeType: .png,
            data: uploadData.base64EncodedString()
        )
        let responseData = try botFixtureData(at: ["botAvatarUpload", "response"])
        let idempotencyKey = UUID(uuidString: "0595896D-875D-4561-8BDA-9A19B1D81FE2")!
        var step = 0
        AidenRemoteMockURLProtocol.handler = { request in
            step += 1
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots/bot_fixture_01/avatar")
            XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "bot_revision_10")
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Idempotency-Key"),
                idempotencyKey.uuidString.lowercased()
            )
            let body = try Self.jsonBody(request)
            XCTAssertEqual(body["mimeType"] as? String, "image/png")
            XCTAssertEqual(body["data"] as? String, uploadData.base64EncodedString())
            return Self.response(
                for: request,
                status: step == 1 ? 200 : 201,
                data: responseData
            )
        }

        let asset = try await client.putBotAvatar(
            botId: "bot_fixture_01",
            revision: "bot_revision_10",
            upload: upload,
            idempotencyKey: idempotencyKey
        )
        XCTAssertEqual(asset.width, 512)
        XCTAssertEqual(asset.height, 512)
        await assertUnexpectedStatus(201) {
            try await client.putBotAvatar(
                botId: "bot_fixture_01",
                revision: "bot_revision_10",
                upload: upload,
                idempotencyKey: idempotencyKey
            )
        }
        XCTAssertEqual(step, 2)
    }

    @MainActor
    func testBotChatToolsNarrowAccessReconcileFilesAndRevokeWithinExactGrant() async throws {
        let cacheRoot = FileManager.default.temporaryDirectory
            .appending(path: "aiden-bot-chat-tools-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: cacheRoot) }
        let botCache = AidenBotCache(root: cacheRoot)
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let exchange = makeExchange(
            instanceId: "instance-bot-tools",
            deviceId: "device-bot-tools",
            credential: String(repeating: "T", count: 43),
            capabilities: [.serverRead, .workspaceRead, .botRead, .botWrite]
        )
        _ = try store.savePairing(exchange, trust: makeSystemTrust(), name: "Bot Mac")
        let session = makeSession()
        let botID = "bot_fixture_01"
        let chatID = "chat_bot_fixture_01"
        let fileID = "file_\(String(repeating: "F", count: 43))"
        let botDetail = try botFixtureData(at: ["botDetail"])
        let catalog = try botFixtureData(at: ["botCapabilityCatalog"])
        let inheritedAccess = try botFixtureData(at: ["botChatSubset"])
        let index = Data("""
        {"snapshotId":"files_snapshot_1","entries":[{"id":"\(fileID)","displayPath":"notes.md",
        "name":"notes.md","kind":"file","size":12,"language":"markdown"}],
        "truncated":false,"maxEntries":4000,"maxDepth":20}
        """.utf8)
        var document = Data("""
        {"id":"\(fileID)","displayPath":"notes.md","content":"first","version":"file_revision_1","truncated":false}
        """.utf8)
        var authoritativeAccess = inheritedAccess
        var currentBotDetail = botDetail
        var ambiguousPatch = false
        var failBotLoad = false
        var revokeCredential = false
        var patchCount = 0
        var writeCount = 0

        func customAccessData(body: [String: Any], revision: Int) throws -> Data {
            try JSONSerialization.data(withJSONObject: [
                "chatId": chatID,
                "botId": botID,
                "mode": "custom",
                "revision": "chat_policy_revision_\(revision)",
                "botPolicyRevision": "bot_policy_revision_4",
                "summary": "Custom · reduced for this chat",
                "custom": body["custom"] as Any,
            ])
        }

        AidenRemoteMockURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            switch (request.httpMethod, path) {
            case ("GET", "/api/aiden/v1/server"):
                return Self.response(for: request, status: 200, json: """
                {"protocolVersion":1,"instanceId":"instance-bot-tools","name":"Bot Mac",
                "appVersion":"1.0.0","capabilities":["server:read","workspace:read","bot:read","bot:write"],
                "serverCapabilities":["server:read","workspace:read","bot:read","bot:write"],
                "connectionMode":"lan","serverTime":"2026-08-23T12:00:00.000Z"}
                """)
            case ("GET", "/api/aiden/v1/workspaces"):
                return Self.response(for: request, status: 200, json: "{\"workspaces\":[]}")
            case ("GET", "/api/aiden/v1/bots/\(botID)"):
                if failBotLoad { throw URLError(.cannotConnectToHost) }
                if revokeCredential {
                    return Self.response(
                        for: request,
                        status: 403,
                        json: """
                        {"error":{"code":"credential_revoked","message":"Pair again.",
                        "requestId":"request-bot-tools-revoked","retryable":false}}
                        """
                    )
                }
                return Self.response(for: request, status: 200, data: currentBotDetail)
            case ("GET", "/api/aiden/v1/chats/\(chatID)/capabilities"):
                return Self.response(for: request, status: 200, data: authoritativeAccess)
            case ("GET", "/api/aiden/v1/bot-capabilities"):
                return Self.response(for: request, status: 200, data: catalog)
            case ("PATCH", "/api/aiden/v1/chats/\(chatID)/capabilities"):
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "If-Match"),
                    patchCount == 0 ? "chat_policy_revision_2" : "chat_policy_revision_3"
                )
                patchCount += 1
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["catalogRevision"] as? String, "bot_catalog_revision_3")
                XCTAssertEqual(body["expectedBotPolicyRevision"] as? String, "bot_policy_revision_4")
                let custom = try XCTUnwrap(body["custom"] as? [String: Any])
                XCTAssertEqual(custom["providerId"] as? String, "provider_fixture")
                XCTAssertEqual(custom["modelId"] as? String, "model_fixture")
                authoritativeAccess = try customAccessData(body: body, revision: patchCount + 2)
                if ambiguousPatch {
                    ambiguousPatch = false
                    throw URLError(.networkConnectionLost)
                }
                return Self.response(for: request, status: 200, data: authoritativeAccess)
            case ("GET", "/api/aiden/v1/bot-conversations/\(chatID)/files"):
                return Self.response(for: request, status: 200, data: index)
            case ("GET", "/api/aiden/v1/bot-conversations/\(chatID)/files/\(fileID)"):
                return Self.response(for: request, status: 200, data: document)
            case ("PUT", "/api/aiden/v1/bot-conversations/\(chatID)/files/\(fileID)"):
                writeCount += 1
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["expectedVersion"] as? String, "file_revision_1")
                document = try JSONSerialization.data(withJSONObject: [
                    "id": fileID,
                    "displayPath": "notes.md",
                    "content": body["content"] as? String ?? "",
                    "version": "file_revision_2",
                    "truncated": false,
                ])
                return Self.response(for: request, status: 200, data: document)
            default:
                XCTFail("Unexpected Bot tools request: \(request.httpMethod ?? "nil") \(path)")
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

        let tools = AidenBotChatToolsModel(chatID: chatID, botID: botID, cache: botCache)
        await tools.load(coordinator: coordinator)
        XCTAssertEqual(tools.access?.mode, .inherit)
        XCTAssertFalse(tools.isDirty)
        XCTAssertTrue(tools.hasFiles)
        let cachedAfterRefresh = await botCache.load(
            instanceId: "instance-bot-tools",
            deviceId: "device-bot-tools"
        )
        XCTAssertEqual(cachedAfterRefresh?.details.first?.visionModelSelection,
                       tools.bot?.visionModelSelection)
        XCTAssertEqual(cachedAfterRefresh?.catalog, tools.catalog)

        tools.draft?.mode = .custom
        tools.draft?.skillIDs.removeAll()
        XCTAssertTrue(tools.isDirty, "A changed Access sheet must require save or discard confirmation.")
        XCTAssertTrue(tools.canEdit(coordinator: coordinator, hostAllowsMutations: true))
        let savedAccess = await tools.save(coordinator: coordinator, hostAllowsMutations: true)
        XCTAssertTrue(savedAccess)
        XCTAssertEqual(patchCount, 1)
        XCTAssertFalse(tools.isDirty)

        tools.draft?.connectionIDs.removeAll()
        ambiguousPatch = true
        let reconciledAccess = await tools.save(coordinator: coordinator, hostAllowsMutations: true)
        XCTAssertTrue(
            reconciledAccess,
            "An ambiguous PATCH committed on the Mac must reconcile as success without replaying."
        )
        XCTAssertEqual(patchCount, 2)
        XCTAssertFalse(tools.isDirty)

        let grant = try XCTUnwrap(tools.fileGrant(
            coordinator: coordinator,
            hostAllowsMutations: true
        ))
        XCTAssertEqual(grant.chatID, chatID)
        XCTAssertEqual(grant.botID, botID)
        XCTAssertEqual(grant.chatAccessRevision, "chat_policy_revision_4")
        XCTAssertEqual(grant.botPolicyRevision, "bot_policy_revision_4")
        XCTAssertEqual(grant.catalogRevision, "bot_catalog_revision_3")

        let files = AidenBotConversationFilesModel(grant: grant)
        await files.load(coordinator: coordinator)
        let entry = try XCTUnwrap(files.index?.entries.first)
        let openedFile = await files.open(entry, coordinator: coordinator)
        XCTAssertTrue(openedFile)
        files.draft = "second"
        let savedFile = await files.save(coordinator: coordinator)
        XCTAssertTrue(savedFile)
        XCTAssertEqual(writeCount, 1)

        var staleObject = try XCTUnwrap(JSONSerialization.jsonObject(with: authoritativeAccess) as? [String: Any])
        staleObject["revision"] = "chat_policy_revision_5"
        authoritativeAccess = try JSONSerialization.data(withJSONObject: staleObject)
        let openedWithStaleGrant = await files.open(entry, coordinator: coordinator)
        XCTAssertFalse(openedWithStaleGrant)
        XCTAssertEqual(writeCount, 1, "A stale access grant must fail before any file write.")

        await tools.load(coordinator: coordinator)
        let freshGrant = try XCTUnwrap(tools.fileGrant(
            coordinator: coordinator,
            hostAllowsMutations: true
        ))
        let archivedFiles = AidenBotConversationFilesModel(grant: freshGrant)
        await archivedFiles.load(coordinator: coordinator)
        let openedBeforeArchive = await archivedFiles.open(entry, coordinator: coordinator)
        XCTAssertTrue(openedBeforeArchive)
        var archivedObject = try XCTUnwrap(JSONSerialization.jsonObject(with: botDetail) as? [String: Any])
        archivedObject["health"] = "archived"
        archivedObject["archivedAt"] = "2026-08-23T12:30:00.000Z"
        currentBotDetail = try JSONSerialization.data(withJSONObject: archivedObject)
        archivedFiles.draft = "must not write"
        let savedAfterArchive = await archivedFiles.save(coordinator: coordinator)
        XCTAssertFalse(savedAfterArchive)
        XCTAssertEqual(writeCount, 1, "Archiving after Files opened must invalidate write authority.")

        let readOnlyGrant = AidenBotConversationFileGrant(
            context: freshGrant.context,
            chatID: freshGrant.chatID,
            botID: freshGrant.botID,
            chatAccessRevision: freshGrant.chatAccessRevision,
            botPolicyRevision: freshGrant.botPolicyRevision,
            catalogRevision: freshGrant.catalogRevision,
            allowsWrites: false
        )
        let readOnlyFiles = AidenBotConversationFilesModel(grant: readOnlyGrant)
        let readOnlySaved = await readOnlyFiles.save(coordinator: coordinator)
        XCTAssertFalse(readOnlySaved)
        XCTAssertEqual(writeCount, 1)

        currentBotDetail = botDetail
        failBotLoad = true
        let refreshedAfterOrdinaryFailure = await tools.refresh(coordinator: coordinator)
        XCTAssertFalse(refreshedAfterOrdinaryFailure)
        XCTAssertNil(tools.access, "A failed authoritative refresh must not keep displaying stale Access.")
        XCTAssertNotNil(tools.bot, "A failed refresh should retain device-scoped cached Bot capability state.")
        XCTAssertNotNil(tools.catalog, "A failed refresh should retain the cached model capability catalog.")
        XCTAssertNotNil(store.activeInstallation)
        failBotLoad = false
        await tools.load(coordinator: coordinator)
        XCTAssertNotNil(tools.access)
        revokeCredential = true
        let refreshedAfterRevocation = await tools.refresh(coordinator: coordinator)
        XCTAssertFalse(refreshedAfterRevocation)
        XCTAssertNil(tools.access)
        XCTAssertNil(store.activeInstallation, "Credential revocation must use the coordinator purge bridge.")
    }

    func testBotChatAccessDraftCannotExceedCustomBotCeilingAndFilesFollowEffectiveSelection() throws {
        let botAccess: AidenBotAccessView = try botFixtureValue(at: ["botPolicyUpdate", "response"])
        let chatAccess: AidenBotChatAccessView = try botFixtureValue(at: ["botChatSubsetUpdate", "response"])
        let catalog: AidenBotCapabilityCatalog = try botFixtureValue(at: ["botCapabilityCatalog"])
        var draft = try XCTUnwrap(AidenBotChatAccessDraft(
            botAccess: botAccess,
            chatAccess: chatAccess,
            catalog: catalog
        ))
        XCTAssertTrue(draft.isSaveable(botAccess: botAccess, catalog: catalog))
        XCTAssertTrue(AidenBotChatAccessPresentation.hasFiles(
            botAccess: botAccess,
            chatAccess: chatAccess,
            catalog: catalog
        ))

        draft.connectionIDs.insert("connection.outside-bot-ceiling")
        XCTAssertFalse(draft.isSaveable(botAccess: botAccess, catalog: catalog))
        draft.connectionIDs.remove("connection.outside-bot-ceiling")
        draft.providerID = "provider-outside-bot-ceiling"
        XCTAssertFalse(draft.isSaveable(botAccess: botAccess, catalog: catalog))
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
                  "days":[{
                    "date":"2026-08-19","requests":4,"reportedTokenRequests":3,"unmeteredRequests":1,
                    "tokens":{"input":40,"output":20,"cacheRead":4,"cacheWrite":1,"cacheWrite1h":0,"reasoning":3,"total":67},
                    "hostedCostUsd":0.45
                  }],
                  "models":[{
                    "providerId":"openai","providerLabel":"OpenAI","modelId":"gpt-5.6",
                    "modelLabel":"GPT-5.6","local":false,"requests":8,"reportedTokenRequests":7,
                    "unmeteredRequests":1,
                    "tokens":{"input":80,"output":40,"cacheRead":8,"cacheWrite":2,"cacheWrite1h":1,"reasoning":6,"total":136},
                    "hostedCostUsd":1.05
                  }]
                }
                """
            )
        }

        let usage = try await client.usage()
        XCTAssertEqual(usage.range, "30d")
        XCTAssertEqual(usage.totals.requests, 12)
        XCTAssertEqual(usage.totals.tokens.total, 170)
        XCTAssertEqual(usage.totals.hostedCostUsd, 1.25)
        XCTAssertEqual(usage.days.first?.date, "2026-08-19")
        XCTAssertEqual(usage.days.first?.tokens.total, 67)
        XCTAssertEqual(usage.models.first?.modelLabel, "GPT-5.6")
        XCTAssertEqual(usage.models.first?.requests, 8)

        let heatmap = AidenUsagePresentation.heatmapDays(for: usage)
        XCTAssertEqual(heatmap.count, 30)
        XCTAssertEqual(heatmap.first?.date, "2026-07-21")
        XCTAssertEqual(heatmap.first?.tokens, 0)
        XCTAssertEqual(heatmap.last?.date, "2026-08-19")
        XCTAssertEqual(heatmap.last?.tokens, 67)
        XCTAssertEqual(AidenUsagePresentation.ratio(3, of: 12), 0.25)
        XCTAssertEqual(AidenUsagePresentation.ratio(1, of: 0), 0)
        XCTAssertEqual(
            AidenUsagePresentation.tokenCount(
                1_234_567_890_123,
                locale: Locale(identifier: "en_US")
            ),
            "1,234,567,890,123"
        )
        XCTAssertEqual(
            AidenUsagePresentation.tokenCount(
                Int.max,
                locale: Locale(identifier: "en_US")
            ),
            "9,223,372,036,854,775,807"
        )
    }

    func testSpeechSetupAndTranscriptionUseCanonicalBoundedRoutes() async throws {
        let client = makeClient()
        let statusJSON = """
        {
          "engine":{"ready":true,"error":null},
          "selectedModelId":"parakeet-v3",
          "models":[{
            "id":"parakeet-v3","name":"Parakeet","description":"Local speech",
            "sizeLabel":"620 MB","quant":"int8","languagesLabel":"25 languages",
            "accuracy":0.8,"speed":0.85,"recommended":true,"installed":true
          }],
          "input":{"encoding":"pcm_s16le","sampleRate":16000,"channels":1,"maximumSeconds":60,"partialResults":false}
        }
        """
        AidenRemoteMockURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-credential")
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/api/aiden/v1/speech"):
                return Self.response(for: request, status: 200, json: statusJSON)
            case ("POST", "/api/aiden/v1/speech/models/parakeet-v3/download"):
                return Self.response(for: request, status: 202, json: statusJSON)
            case ("POST", "/api/aiden/v1/speech/transcriptions"):
                let body = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: Self.bodyData(request)) as? [String: Any]
                )
                XCTAssertEqual(body["encoding"] as? String, "pcm_s16le")
                XCTAssertEqual(body["sampleRate"] as? Int, 16_000)
                XCTAssertEqual(body["channels"] as? Int, 1)
                XCTAssertEqual(body["modelId"] as? String, "parakeet-v3")
                XCTAssertEqual(body["pcmBase64"] as? String, "AAA=")
                return Self.response(
                    for: request,
                    status: 200,
                    json: #"{"text":"Hello from the Mac","modelId":"parakeet-v3"}"#
                )
            default:
                XCTFail("Unexpected speech request \(request.httpMethod ?? "") \(request.url?.path ?? "")")
                return Self.response(for: request, status: 404, json: #"{"error":{"code":"not_found","message":"Unexpected route."}}"#)
            }
        }

        let status = try await client.speechStatus()
        XCTAssertTrue(status.engine.ready)
        XCTAssertFalse(status.input.partialResults)
        let downloadStatus = try await client.downloadSpeechModel("parakeet-v3")
        XCTAssertEqual(downloadStatus.selectedModelId, "parakeet-v3")
        let transcript = try await client.transcribeSpeech(pcm16: Data([0, 0]), modelId: "parakeet-v3")
        XCTAssertEqual(transcript.text, "Hello from the Mac")
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

    func testChatDetailRejectsMismatchedResponseIdentity() async throws {
        let client = makeClient()
        AidenRemoteMockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/aiden/v1/chats/chat-requested")
            return Self.chatResponse(
                for: request,
                status: 200,
                revision: "revision-1",
                id: "chat-returned"
            )
        }

        do {
            _ = try await client.chat(id: "chat-requested")
            XCTFail("A chat response for another identity must be rejected.")
        } catch let error as AidenRemoteClientError {
            guard case .invalidResponse = error else {
                return XCTFail("Expected invalidResponse, got \(error).")
            }
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
                    {"id":"gpt-5.6","label":"GPT-5.6","thinkingLevels":["high","max"],
                    "defaultThinkingLevel":"max","thinkingCanDisable":false}]}],
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
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"streamId":"stream-1","chatId":"chat-1","turnId":"turn-1",
                    "state":"waiting_for_approval","lastSequence":3,
                    "updatedAt":"2026-08-19T07:00:01.000Z"}
                    """
                )
            case 7:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/streams/stream-1/approval")
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"approval":{
                    "approvalId":"approval-1","streamId":"stream-1","chatId":"chat-1",
                    "summary":"Allow this command?","toolCallId":"tool-1","toolName":"run_command",
                    "expiresAt":"2026-08-19T07:05:01.000Z","canAllow":true}}
                    """
                )
            case 8:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/streams/stream-1/cancel")
                XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
                return Self.streamStatusResponse(for: request, state: "cancelled")
            case 9:
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/approvals/approval-1/respond")
                XCTAssertEqual(try Self.jsonBody(request)["decision"] as? String, "allow")
                return Self.response(
                    for: request,
                    status: 200,
                    json: "{\"approvalId\":\"approval-1\",\"decision\":\"allow\",\"resolvedAt\":\"2026-08-19T07:00:00.000Z\"}"
                )
            case 10:
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
        XCTAssertEqual(catalog.providers.first?.models.first?.effectiveThinkingLevel, "max")
        XCTAssertEqual(catalog.providers.first?.models.first?.thinkingCanDisable, false)
        let turn = try await client.startTurn(
            chatId: updated.id,
            request: .init(text: "Work on this", providerId: "openai", modelId: "gpt-5.6", thinkingLevel: "max")
        )
        let runningStatus = try await client.streamStatus(id: turn.streamId)
        let pendingApproval = try await client.streamApproval(id: turn.streamId)
        let cancelledStatus = try await client.cancelStream(id: turn.streamId)
        let approval = try await client.respondToApproval(id: "approval-1", decision: .allow)
        XCTAssertEqual(runningStatus.state, .waitingForApproval)
        XCTAssertEqual(pendingApproval.approval?.approvalId, "approval-1")
        XCTAssertEqual(pendingApproval.approval?.toolName, "run_command")
        XCTAssertEqual(pendingApproval.approval?.canAllow, true)
        XCTAssertEqual(cancelledStatus.state, .cancelled)
        XCTAssertEqual(approval.decision, .allow)
        try await client.removeChat(id: updated.id, revision: updated.revision)
        XCTAssertEqual(step, 10)
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

    func testAttachmentContentUsesAuthenticatedBoundedRawImageRoute() async throws {
        let client = makeClient()
        let attachmentID = "att_\(String(repeating: "I", count: 43))"
        let imageData = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).pngData { context in
            UIColor.systemPurple.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        AidenRemoteMockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(
                request.url?.path,
                "/api/aiden/v1/chats/chat-1/attachments/\(attachmentID)/content"
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-credential")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "image/jpeg, image/png")
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "image/png", "Content-Length": "\(imageData.count)"]
                )!,
                imageData
            )
        }

        let content = try await client.attachmentContent(chatId: "chat-1", attachmentId: attachmentID)
        XCTAssertEqual(content.mimeType, "image/png")
        XCTAssertEqual(content.data, imageData)
    }

    func testAttachmentContentRejectsNonImageResponses() async {
        let client = makeClient()
        AidenRemoteMockURLProtocol.handler = { request in
            Self.response(for: request, status: 200, json: "{}")
        }

        do {
            _ = try await client.attachmentContent(chatId: "chat-1", attachmentId: "attachment-1")
            XCTFail("Expected a non-image content type to fail closed.")
        } catch {
            XCTAssertTrue(error is AidenRemoteClientError)
        }
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
            keychain.scoped[KeychainStore.scopedKey(.remoteCredential, scope: second.credentialScope)],
            repaired.credential
        )
        XCTAssertFalse(keychain.scoped.values.contains(initial.credential))
    }

    @MainActor
    func testRePairingSnapshotFailureKeepsPreviousVersionedCredentialCoherentAfterRestart() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let initial = makeExchange(
            instanceId: "instance-atomic",
            deviceId: "device-before",
            credential: String(repeating: "A", count: 43)
        )
        let repaired = makeExchange(
            instanceId: "instance-atomic",
            deviceId: "device-after",
            credential: String(repeating: "B", count: 43)
        )
        let previous = try store.savePairing(initial, trust: makeSystemTrust(), name: "Aiden Mac")
        keychain.failingSaveKeys.insert(.remoteInstallations)
        keychain.failingScopedDeleteScopes.insert("instance-atomic:device-after")

        XCTAssertThrowsError(
            try store.savePairing(repaired, trust: makeSystemTrust(), name: "Aiden Mac")
        )
        keychain.failingSaveKeys.remove(.remoteInstallations)
        let restarted = AidenInstallationStore(keychain: keychain)
        let active = try XCTUnwrap(restarted.activeInstallation)
        XCTAssertEqual(active.deviceId, previous.deviceId)
        XCTAssertEqual(active.credentialScope, previous.credentialScope)
        XCTAssertEqual(try restarted.credential(for: active), initial.credential)
        XCTAssertNotEqual(try restarted.credential(for: active), repaired.credential)
    }

    @MainActor
    func testSameInstallationDeviceReplacementInvalidatesRetainedRequestContext() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let initial = makeExchange(
            instanceId: "instance-repair-context",
            deviceId: "device-before",
            credential: String(repeating: "A", count: 43)
        )
        let repaired = makeExchange(
            instanceId: "instance-repair-context",
            deviceId: "device-after",
            credential: String(repeating: "B", count: 43)
        )
        _ = try store.savePairing(initial, trust: makeSystemTrust(), name: "Aiden Mac")
        let coordinator = AidenRemoteCoordinator(installationStore: store)
        let admittedContext = try coordinator.requestContext()

        _ = try store.savePairing(repaired, trust: makeSystemTrust(), name: "Aiden Mac")

        XCTAssertFalse(coordinator.isRetained(admittedContext))
        XCTAssertFalse(coordinator.isCurrent(admittedContext))
        XCTAssertThrowsError(try coordinator.remoteClient(for: admittedContext)) { error in
            guard case AidenRemoteClientError.installationChanged = error else {
                return XCTFail("Expected the replaced device context to fail closed.")
            }
        }
    }

    @MainActor
    func testCoordinatorReusesOneRemoteClientWithinAnActivation() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            makeExchange(
                instanceId: "instance-client-cache",
                deviceId: "device-client-cache",
                credential: String(repeating: "C", count: 43)
            ),
            trust: makeSystemTrust(),
            name: "Cached Mac"
        )
        let session = makeSession()
        var factoryCalls = 0
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { installation, credential in
                factoryCalls += 1
                return AidenRemoteClient(
                    endpoint: installation.endpoint,
                    credential: credential,
                    session: session
                )
            }
        )

        let context = try coordinator.requestContext()
        let first = try coordinator.remoteClient(for: context)
        let second = try coordinator.remoteClient(for: context)

        XCTAssertTrue(first === second)
        XCTAssertEqual(factoryCalls, 1)
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
        XCTAssertNil(keychain.scoped[KeychainStore.scopedKey(.remoteCredential, scope: firstInstallation.credentialScope)])
        XCTAssertEqual(
            keychain.scoped[KeychainStore.scopedKey(.remoteCredential, scope: secondInstallation.credentialScope)],
            second.credential
        )
    }

    @MainActor
    func testRepeatedLANAndTailscaleMacSwitchingKeepsEndpointAndCredentialIdentityScoped() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let lan = makeExchange(
            instanceId: "instance-lan",
            deviceId: "device-lan",
            credential: String(repeating: "L", count: 43),
            endpoint: URL(string: "https://home.local:49220/api/aiden/v1")!
        )
        let tailscale = makeExchange(
            instanceId: "instance-tailscale",
            deviceId: "device-tailscale",
            credential: String(repeating: "T", count: 43),
            endpoint: URL(string: "https://studio.tailnet.ts.net/api/aiden/v1")!
        )
        _ = try store.savePairing(lan, trust: makeSystemTrust(), name: "Mac")
        let tailscaleInstallation = try store.savePairing(tailscale, trust: makeSystemTrust(), name: "Mac")

        for installationID in ["instance-lan", "instance-tailscale", "instance-lan", "instance-tailscale"] {
            try store.setActive(installationID)
            let active = try XCTUnwrap(store.activeInstallation)
            XCTAssertEqual(active.id, installationID)
            if installationID == "instance-lan" {
                XCTAssertEqual(active.endpoint, lan.endpoint)
                XCTAssertEqual(try store.credential(for: active), lan.credential)
                XCTAssertEqual(AidenInstallationPresentation.endpointType(active.endpoint), "Local Network")
            } else {
                XCTAssertEqual(active.endpoint, tailscale.endpoint)
                XCTAssertEqual(try store.credential(for: active), tailscale.credential)
                XCTAssertEqual(AidenInstallationPresentation.endpointType(active.endpoint), "Tailscale")
            }
        }

        try store.remove("instance-tailscale")
        let remaining = try XCTUnwrap(store.activeInstallation)
        XCTAssertEqual(remaining.id, "instance-lan")
        XCTAssertEqual(remaining.endpoint, lan.endpoint)
        XCTAssertEqual(try store.credential(for: remaining), lan.credential)
        XCTAssertNil(keychain.scoped[
            KeychainStore.scopedKey(.remoteCredential, scope: tailscaleInstallation.credentialScope)
        ])
    }

    @MainActor
    func testSameNamedInstallationsRemainDistinctAndServerRenamePreservesIdentity() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let first = makeExchange(
            instanceId: "instance-a",
            deviceId: "device-a",
            credential: String(repeating: "A", count: 43)
        )
        let second = makeExchange(
            instanceId: "instance-b",
            deviceId: "device-b",
            credential: String(repeating: "B", count: 43)
        )
        let firstInstallation = try store.savePairing(first, trust: makeSystemTrust(), name: "Studio Mac")
        let secondInstallation = try store.savePairing(second, trust: makeSystemTrust(), name: "Studio Mac")

        XCTAssertNil(firstInstallation.lastConnectedAt, "Credential exchange is not an authenticated server read.")
        XCTAssertNil(secondInstallation.lastConnectedAt, "Credential exchange is not an authenticated server read.")
        XCTAssertEqual(store.installations.map(\.id), ["instance-a", "instance-b"])
        XCTAssertEqual(Set(store.installations.map(\.name)), ["Studio Mac"])
        XCTAssertEqual(try store.credential(for: firstInstallation), first.credential)
        XCTAssertEqual(try store.credential(for: secondInstallation), second.credential)

        try store.updateServer(AidenServer(
            protocolVersion: 1,
            instanceId: "instance-a",
            name: "Home Mac",
            appVersion: "1.0",
            capabilities: [.serverRead],
            connectionMode: .lan,
            minimumClientVersion: nil,
            serverTime: Date()
        ))
        XCTAssertEqual(store.installations.first(where: { $0.id == "instance-a" })?.name, "Home Mac")
        XCTAssertNotNil(store.installations.first(where: { $0.id == "instance-a" })?.lastConnectedAt)
        XCTAssertEqual(try store.credential(for: firstInstallation), first.credential)
        XCTAssertEqual(try store.credential(for: secondInstallation), second.credential)
    }

    @MainActor
    func testInstallationPersistsExplicitDeviceGrantsAndServerSupportSeparately() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let exchange = makeExchange(
            instanceId: "instance-bot",
            deviceId: "device-bot",
            credential: String(repeating: "B", count: 43),
            capabilities: [.serverRead, .botRead, .botWrite]
        )
        let paired = try store.savePairing(
            exchange,
            trust: makeSystemTrust(),
            name: "Bot Mac"
        )

        XCTAssertEqual(paired.deviceCapabilities, [.serverRead, .botRead, .botWrite])
        XCTAssertNil(paired.serverCapabilities)
        XCTAssertFalse(paired.isBotsEligible)

        try store.updateServer(AidenServer(
            protocolVersion: 1,
            instanceId: "instance-bot",
            name: "Bot Mac",
            appVersion: "1.0",
            capabilities: [.serverRead, .botRead, .botWrite],
            serverCapabilities: [.serverRead, .workspaceRead, .botRead, .botWrite],
            connectionMode: .lan,
            minimumClientVersion: nil,
            serverTime: Date()
        ))

        let refreshed = try XCTUnwrap(store.activeInstallation)
        XCTAssertEqual(refreshed.deviceCapabilities, [.serverRead, .botRead, .botWrite])
        XCTAssertEqual(
            refreshed.serverCapabilities,
            [.serverRead, .workspaceRead, .botRead, .botWrite]
        )
        XCTAssertTrue(refreshed.isBotsEligible)
        XCTAssertTrue(refreshed.canWriteBots)

        let restored = try XCTUnwrap(AidenInstallationStore(keychain: keychain).activeInstallation)
        XCTAssertEqual(restored.deviceCapabilities, refreshed.deviceCapabilities)
        XCTAssertEqual(restored.serverCapabilities, refreshed.serverCapabilities)
        XCTAssertTrue(restored.isBotsEligible)
    }

    @MainActor
    func testServerRefreshCanNarrowButNeverWidenDeviceGrants() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            makeExchange(
                instanceId: "instance-limited",
                deviceId: "device-limited",
                credential: String(repeating: "L", count: 43)
            ),
            trust: makeSystemTrust(),
            name: "Limited Mac"
        )

        let server = AidenServer(
            protocolVersion: 1,
            instanceId: "instance-limited",
            name: "Limited Mac",
            appVersion: "1.0",
            capabilities: [.serverRead, .workspaceRead, .botRead, .botWrite],
            serverCapabilities: [.serverRead, .workspaceRead, .botRead, .botWrite],
            connectionMode: .lan,
            minimumClientVersion: nil,
            serverTime: Date()
        )
        try store.updateServer(server)

        let refreshed = try XCTUnwrap(store.activeInstallation)
        XCTAssertEqual(refreshed.deviceCapabilities, [.serverRead, .workspaceRead])
        XCTAssertEqual(refreshed.serverCapabilities, server.serverCapabilities)
        XCTAssertFalse(refreshed.isBotsEligible)
        XCTAssertFalse(refreshed.canWriteBots)
    }

    @MainActor
    func testServerRenamePersistenceFailureRestoresEntireSortedRegistry() throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            makeExchange(instanceId: "instance-a", deviceId: "device-a", credential: "credential-a"),
            trust: makeSystemTrust(),
            name: "Alpha"
        )
        _ = try store.savePairing(
            makeExchange(instanceId: "instance-z", deviceId: "device-z", credential: "credential-z"),
            trust: makeSystemTrust(),
            name: "Zulu"
        )
        let before = store.installations
        keychain.failingSaveKeys = [.remoteInstallations]

        XCTAssertThrowsError(try store.updateServer(AidenServer(
            protocolVersion: 1,
            instanceId: "instance-a",
            name: "ZZ Top",
            appVersion: "1.0",
            capabilities: [.serverRead],
            connectionMode: .lan,
            minimumClientVersion: nil,
            serverTime: Date()
        )))
        XCTAssertEqual(store.installations, before)
    }

    func testDiscoveryAndInstallationPresentationUsePublicIdentityWithoutEndpointConfusion() throws {
        let txt = NetService.data(fromTXTRecord: [
            "v": Data("1".utf8),
            "instance": Data("instance_studio_1".utf8),
        ])
        XCTAssertEqual(
            AidenDiscoveryIdentity.instanceID(fromTXTRecord: txt),
            "instance_studio_1"
        )
        XCTAssertNil(AidenDiscoveryIdentity.instanceID(fromTXTRecord: NetService.data(
            fromTXTRecord: ["instance": Data("bad instance".utf8)]
        )))
        XCTAssertEqual(
            AidenInstallationPresentation.endpointType(
                URL(string: "https://studio.tailnet.ts.net/api/aiden/v1")!
            ),
            "Tailscale"
        )
        XCTAssertEqual(
            AidenInstallationPresentation.endpointType(
                URL(string: "https://studio.local:49220/api/aiden/v1")!
            ),
            "Local Network"
        )
        XCTAssertEqual(
            AidenInstallationPresentation.reachability(
                installationID: "instance-a",
                activeInstallationID: "instance-b",
                connectionState: .connected
            ),
            "Not checked"
        )
        XCTAssertEqual(AidenInstallationPresentation.identitySuffix("instance_studio_abcdef"), "abcdef")
        XCTAssertEqual(
            AidenInstallationPresentation.accessibilityValue(
                installationID: "instance-a",
                activeInstallationID: "instance-a",
                connectionState: .connected,
                endpoint: URL(string: "https://studio.local:49220/api/aiden/v1")!,
                lastConnectedAt: nil
            ),
            "Selected, Connected, Local Network, Never connected"
        )
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
        "capabilities":["server:read","bot:read","bot:write"],
        "serverCapabilities":["server:read","bot:read","bot:write"],"createdAt":0}],
        "activeInstallationId":"legacy-instance"}
        """
        keychain.values[.remoteInstallations] = legacySnapshot
        let legacyStore = AidenInstallationStore(keychain: keychain)
        let legacyInstallation = try XCTUnwrap(legacyStore.activeInstallation)
        XCTAssertNil(legacyInstallation.pairingTrust)
        XCTAssertEqual(legacyInstallation.deviceCapabilities, [.serverRead])
        XCTAssertNil(legacyInstallation.serverCapabilities)
        XCTAssertFalse(legacyInstallation.isBotsEligible)
        XCTAssertFalse(legacyInstallation.canWriteBots)
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
        var workspaceListRequests = 0
        var identityRefreshRequests = 0
        AidenRemoteMockURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/api/aiden/v1/server"):
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"protocolVersion":1,"instanceId":"instance-1","name":"Home Mac",
                    "appVersion":"1.0.0","capabilities":["server:read","workspace:read","workspace:manage"],
                    "deviceName":"iPhone",
                    "connectionMode":"lan","serverTime":"2026-08-19T07:00:00.000Z"}
                    """
                )
            case ("PATCH", "/api/aiden/v1/device/identity"):
                identityRefreshRequests += 1
                let body = try Self.jsonBody(request)
                let name = try XCTUnwrap(body["name"] as? String)
                XCTAssertFalse(name.isEmpty)
                XCTAssertNotEqual(name, "iPhone")
                let data = try JSONSerialization.data(withJSONObject: ["name": name])
                return Self.response(for: request, status: 200, data: data)
            case ("GET", "/api/aiden/v1/workspaces"):
                workspaceListRequests += 1
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
        XCTAssertEqual(identityRefreshRequests, 1)

        let createdResult = await coordinator.createWorkspace(.folderless(name: "New Workspace"))
        let created = try XCTUnwrap(createdResult)
        XCTAssertTrue(coordinator.workspaces.contains(where: { $0.id == created.id }))
        let updatedResult = await coordinator.updateWorkspace(created, permission: .full)
        let updated = try XCTUnwrap(updatedResult)
        XCTAssertEqual(updated.revision, "rev-updated")
        let removed = await coordinator.removeWorkspace(updated)
        XCTAssertTrue(removed)
        XCTAssertFalse(coordinator.workspaces.contains(where: { $0.id == updated.id }))
        XCTAssertEqual(workspaceListRequests, 2, "Confirmed removal should reload the canonical registry in case the Mac seeded a default workspace")
    }

    @MainActor
    func testSuccessfulStagedPairingPersistsNegotiatedBotSupportBeforeConnecting() async throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let exchange = makeExchange(
            instanceId: "instance-1",
            deviceId: "device-bot-aware",
            credential: String(repeating: "B", count: 43),
            capabilities: [.serverRead, .workspaceRead, .botRead, .botWrite]
        )
        let payload = makePairingPayload(
            bootstrap: makeBootstrap(now: Date(timeIntervalSince1970: 1_787_100_000))
        )
        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/aiden/v1/server":
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"protocolVersion":1,"instanceId":"instance-1","name":"Bot Mac",
                    "appVersion":"1.0.0",
                    "capabilities":["server:read","workspace:read","bot:read","bot:write"],
                    "serverCapabilities":["server:read","workspace:read","bot:read","bot:write"],
                    "connectionMode":"lan","serverTime":"2026-08-19T07:00:00.000Z"}
                    """
                )
            case "/api/aiden/v1/workspaces":
                return Self.response(for: request, status: 200, json: "{\"workspaces\":[]}")
            default:
                XCTFail("Unexpected staged-pairing request: \(request.url?.path ?? "nil")")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { installation, credential in
                AidenRemoteClient(
                    endpoint: installation.endpoint,
                    credential: credential,
                    session: session
                )
            }
        )

        try await coordinator.activatePairing(payload: payload, exchange: exchange)

        XCTAssertEqual(coordinator.connectionState, .connected)
        let active = try XCTUnwrap(store.activeInstallation)
        XCTAssertEqual(active.deviceCapabilities, exchange.capabilities)
        XCTAssertEqual(active.serverCapabilities, exchange.capabilities)
        XCTAssertTrue(active.isBotsEligible)
        XCTAssertTrue(active.canWriteBots)

        let restored = try XCTUnwrap(AidenInstallationStore(keychain: keychain).activeInstallation)
        XCTAssertEqual(restored.deviceCapabilities, exchange.capabilities)
        XCTAssertEqual(restored.serverCapabilities, exchange.capabilities)
        XCTAssertTrue(restored.isBotsEligible)
    }

    @MainActor
    func testFailedStagedPairingCannotReplaceTheWorkingInstallation() async throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let previousExchange = makeExchange(
            instanceId: "instance-1",
            deviceId: "device-working",
            credential: "credential-working"
        )
        let previousInstallation = try store.savePairing(
            previousExchange,
            trust: makeSystemTrust(),
            name: "Working Mac"
        )
        let stagedExchange = makeExchange(
            instanceId: "instance-1",
            deviceId: "device-staged",
            credential: "credential-staged"
        )
        let payload = makePairingPayload(
            bootstrap: makeBootstrap(now: Date(timeIntervalSince1970: 1_787_100_000))
        )
        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/aiden/v1/server":
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"protocolVersion":1,"instanceId":"instance-impostor","name":"Wrong Mac",
                    "appVersion":"1.0.0","capabilities":["server:read","workspace:read"],
                    "connectionMode":"lan","serverTime":"2026-08-19T07:00:00.000Z"}
                    """
                )
            case "/api/aiden/v1/workspaces":
                return Self.response(for: request, status: 200, json: "{\"workspaces\":[]}")
            default:
                XCTFail("Unexpected staged-pairing request: \(request.url?.path ?? "nil")")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { installation, credential in
                AidenRemoteClient(endpoint: installation.endpoint, credential: credential, session: session)
            }
        )

        do {
            try await coordinator.activatePairing(payload: payload, exchange: stagedExchange)
            XCTFail("A staged Mac with a mismatched authenticated identity was promoted.")
        } catch {
            XCTAssertEqual(error as? AidenRemoteContractError, .invalidPairingExchange)
        }

        let active = try XCTUnwrap(store.activeInstallation)
        XCTAssertEqual(active.deviceId, previousInstallation.deviceId)
        XCTAssertEqual(active.credentialScope, previousInstallation.credentialScope)
        XCTAssertEqual(try store.credential(for: active), previousExchange.credential)
        XCTAssertFalse(keychain.scoped.values.contains(stagedExchange.credential))
    }

    @MainActor
    func testRejectedWorkspaceRemovalReconcilesWithoutLosingDeviceArchiveState() async throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            makeExchange(instanceId: "instance-1", deviceId: "device-1", credential: "credential-one"),
            trust: makeSystemTrust(),
            name: "Home Mac"
        )
        let suiteName = "AidenRejectedRemovalArchiveTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let archiveStore = AidenWorkspaceArchiveStore(defaults: defaults)
        archiveStore.archive(workspaceID: "workspace-a", instanceID: "instance-1")

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
                    {"id":"workspace-a","name":"Archive Me","permission":"ask","hasFolder":true,
                    "isManagedWorktree":false,"createdAt":"2026-08-19T07:00:00.000Z",
                    "updatedAt":"2026-08-19T07:01:00.000Z","revision":"rev-current"},
                    {"id":"workspace-b","name":"Keep Me","permission":"ask","hasFolder":true,
                    "isManagedWorktree":false,"createdAt":"2026-08-19T07:00:00.000Z",
                    "updatedAt":"2026-08-19T07:01:00.000Z","revision":"rev-b"}]}
                    """
                )
            case ("DELETE", "/api/aiden/v1/workspaces/workspace-a"):
                return Self.response(
                    for: request,
                    status: 409,
                    json: """
                    {"error":{"code":"revision_conflict","message":"The workspace changed.",
                    "requestId":"request-conflict","retryable":false}}
                    """
                )
            default:
                XCTFail("Unexpected rejected-removal request: \(request.httpMethod ?? "nil") \(request.url?.path ?? "nil")")
                return Self.response(for: request, status: 500, json: "{}")
            }
        }

        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            workspaceArchiveStore: archiveStore,
            clientFactory: { installation, credential in
                AidenRemoteClient(endpoint: installation.endpoint, credential: credential, session: session)
            }
        )
        await coordinator.start()
        let workspace = try XCTUnwrap(coordinator.workspaces.first(where: { $0.id == "workspace-a" }))

        let removalOutcome = await coordinator.removeWorkspaceOutcome(workspace)
        XCTAssertTrue(removalOutcome.isDefinitiveFailure)
        XCTAssertNil(removalOutcome.value)
        XCTAssertTrue(coordinator.workspaces.contains(where: { $0.id == workspace.id }))
        XCTAssertTrue(archiveStore.isArchived(workspaceID: workspace.id, instanceID: "instance-1"))
        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertEqual(coordinator.workspaceSnapshotRevision, 2)
        XCTAssertEqual(coordinator.presentedError, "The workspace changed.")
    }

    @MainActor
    func testAuthoritativeEmptyWorkspaceSnapshotPrunesStaleDeviceArchives() async throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            makeExchange(instanceId: "instance-empty", deviceId: "device-empty", credential: "credential-empty"),
            trust: makeSystemTrust(),
            name: "Empty Mac"
        )
        let suiteName = "AidenEmptySnapshotArchiveTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let archiveStore = AidenWorkspaceArchiveStore(defaults: defaults)
        archiveStore.archive(workspaceID: "stale", instanceID: "instance-empty")

        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            if request.url?.path == "/api/aiden/v1/server" {
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"protocolVersion":1,"instanceId":"instance-empty","name":"Empty Mac",
                    "appVersion":"1.0.0","capabilities":["server:read","workspace:read"],
                    "connectionMode":"lan","serverTime":"2026-08-19T07:00:00.000Z"}
                    """
                )
            }
            return Self.response(for: request, status: 200, json: "{\"workspaces\":[]}")
        }
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            workspaceArchiveStore: archiveStore,
            clientFactory: { installation, credential in
                AidenRemoteClient(endpoint: installation.endpoint, credential: credential, session: session)
            }
        )

        await coordinator.start()

        XCTAssertEqual(coordinator.workspaceSnapshotRevision, 1)
        XCTAssertEqual(archiveStore.archivedWorkspaceIDs(for: "instance-empty"), [])
    }

    @MainActor
    func testSlowerPreviousInstallationLoadCannotOverwriteNewActiveMac() async throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            makeExchange(instanceId: "instance-1", deviceId: "device-1", credential: "credential-one"),
            trust: makeSystemTrust(),
            name: "Slow Mac"
        )
        _ = try store.savePairing(
            makeExchange(instanceId: "instance-2", deviceId: "device-2", credential: "credential-two"),
            trust: makeSystemTrust(),
            name: "Fast Mac"
        )
        try store.setActive("instance-1")

        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            let isSlowMac = request.value(forHTTPHeaderField: "Authorization") == "Bearer credential-one"
            let instanceID = isSlowMac ? "instance-1" : "instance-2"
            if request.url?.path == "/api/aiden/v1/server" {
                return Self.response(
                    for: request,
                    status: 200,
                    json: """
                    {"protocolVersion":1,"instanceId":"\(instanceID)","name":"\(isSlowMac ? "Slow Mac" : "Fast Mac")",
                    "appVersion":"1.0.0","capabilities":["server:read","workspace:read"],
                    "connectionMode":"lan","serverTime":"2026-08-19T07:00:00.000Z"}
                    """
                )
            }
            if isSlowMac { Thread.sleep(forTimeInterval: 0.2) }
            return Self.response(
                for: request,
                status: 200,
                json: """
                {"workspaces":[{"id":"workspace-\(instanceID)","name":"Workspace \(instanceID)",
                "permission":"ask","hasFolder":false,"isManagedWorktree":false,
                "createdAt":"2026-08-19T07:00:00.000Z","updatedAt":"2026-08-19T07:00:00.000Z",
                "revision":"rev-\(instanceID)"}]}
                """
            )
        }
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { installation, credential in
                AidenRemoteClient(endpoint: installation.endpoint, credential: credential, session: session)
            }
        )
        let slowLoad = Task { await coordinator.connectActiveInstallation() }
        try await Task.sleep(for: .milliseconds(25))
        let firstActivation = try coordinator.requestContext()
        await coordinator.switchInstallation(to: "instance-2")
        await slowLoad.value

        XCTAssertEqual(coordinator.activeInstanceId, "instance-2")
        XCTAssertEqual(coordinator.server?.instanceId, "instance-2")
        XCTAssertEqual(coordinator.workspaces.map(\.id), ["workspace-instance-2"])
        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertThrowsError(try coordinator.requestContext(for: "instance-1")) { error in
            guard case AidenRemoteClientError.installationChanged = error else {
                return XCTFail("A stale feature must not borrow the newly active Mac client.")
            }
        }

        await coordinator.switchInstallation(to: "instance-1")
        XCTAssertFalse(coordinator.isCurrent(firstActivation), "A -> B -> A must invalidate the first A activation lease.")
        XCTAssertThrowsError(try coordinator.remoteClient(for: firstActivation)) { error in
            guard case AidenRemoteClientError.installationChanged = error else {
                return XCTFail("An ABA-stale feature must not regain access to the current Mac client.")
            }
        }
    }

    @MainActor
    func testStaleFolderBrowserLeaseNeverSendsOpaqueLocationToAnotherMacOrABAActivation() async throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            makeExchange(instanceId: "instance-1", deviceId: "device-1", credential: "credential-one"),
            trust: makeSystemTrust(),
            name: "First Mac"
        )
        _ = try store.savePairing(
            makeExchange(instanceId: "instance-2", deviceId: "device-2", credential: "credential-two"),
            trust: makeSystemTrust(),
            name: "Second Mac"
        )
        try store.setActive("instance-1")
        let session = makeSession()
        var browserRequests = 0
        var scheduledRequests = 0
        AidenRemoteMockURLProtocol.handler = { request in
            let instanceID = request.value(forHTTPHeaderField: "Authorization") == "Bearer credential-one"
                ? "instance-1" : "instance-2"
            if request.url?.path.contains("/browser/") == true {
                browserRequests += 1
                return Self.response(for: request, status: 500, json: "{}")
            }
            if request.url?.path.contains("/scheduled-tasks") == true {
                scheduledRequests += 1
                return Self.response(for: request, status: 500, json: "{}")
            }
            if request.url?.path == "/api/aiden/v1/server" {
                return Self.response(for: request, status: 200, json: """
                {"protocolVersion":1,"instanceId":"\(instanceID)","name":"Mac",
                "appVersion":"1.0","capabilities":["server:read","workspace:read","workspace:browse","workspace:manage"],
                "connectionMode":"lan","serverTime":"2026-08-19T07:00:00.000Z"}
                """)
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
        let firstLease = try coordinator.requestContext()
        let retainedScheduledModel = AidenScheduledTasksModel(coordinator: coordinator)
        var staleDraft = AidenScheduledTaskDraft()
        staleDraft.name = "Must stay on First Mac"
        staleDraft.schedule = "0 9 * * *"
        staleDraft.prompt = "Run the stale draft"
        await coordinator.switchInstallation(to: "instance-2")
        XCTAssertFalse(retainedScheduledModel.isConnected)
        await retainedScheduledModel.loadScripts(workspaceId: nil)
        let savedOnSecondMac = await retainedScheduledModel.save(staleDraft, replacing: nil)
        XCTAssertFalse(savedOnSecondMac)
        let afterSwitch = await coordinator.createSelectedFolderWorkspace(
            context: firstLease,
            location: "loc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            name: nil
        )
        XCTAssertNil(afterSwitch)
        await coordinator.switchInstallation(to: "instance-1")
        XCTAssertFalse(retainedScheduledModel.isConnected)
        await retainedScheduledModel.loadScripts(workspaceId: nil)
        let savedAfterABA = await retainedScheduledModel.save(staleDraft, replacing: nil)
        XCTAssertFalse(savedAfterABA)
        let afterABA = await coordinator.createSelectedFolderWorkspace(
            context: firstLease,
            location: "loc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            name: nil
        )
        XCTAssertNil(afterABA)
        XCTAssertEqual(browserRequests, 0)
        XCTAssertEqual(scheduledRequests, 0)
    }

    @MainActor
    func testCoordinatorRevocationRemovesOnlyAffectedInstallationAndConnectsNextMac() async throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let cacheRoot = FileManager.default.temporaryDirectory
            .appending(path: "aiden-revocation-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: cacheRoot) }
        let chatCache = AidenChatCache(root: cacheRoot.appending(path: "chats"))
        let scheduledCache = AidenScheduledTaskCache(root: cacheRoot.appending(path: "schedules"))
        let environmentCache = AidenWorkspaceEnvironmentCache(
            directory: cacheRoot.appending(path: "environment")
        )
        let suiteName = "AidenRevocationArchiveTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let archiveStore = AidenWorkspaceArchiveStore(defaults: defaults)
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
        let firstInstallation = try store.savePairing(first, trust: makeSystemTrust(), name: "Revoked Mac")
        let secondInstallation = try store.savePairing(second, trust: makeSystemTrust(), name: "Backup Mac")
        try store.setActive("instance-1")
        try await chatCache.saveActiveStream(
            .init(deviceId: "device-1", streamId: "stream-1", turnId: "turn-1", lastSequence: 2),
            instanceId: "instance-1",
            chatId: "chat-1"
        )
        try await chatCache.saveActiveStream(
            .init(deviceId: "device-2", streamId: "stream-2", turnId: "turn-2", lastSequence: 4),
            instanceId: "instance-2",
            chatId: "chat-2"
        )
        try await scheduledCache.store(instanceId: "instance-1", tasks: [], settings: nil)
        try await scheduledCache.store(instanceId: "instance-2", tasks: [], settings: nil)
        archiveStore.archive(workspaceID: "workspace-1", instanceID: "instance-1")
        archiveStore.archive(workspaceID: "workspace-2", instanceID: "instance-2")

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
            return Self.response(
                for: request,
                status: 200,
                json: """
                {"workspaces":[{"id":"workspace-2","name":"Backup Workspace",
                "permission":"ask","hasFolder":false,"isManagedWorktree":false,
                "createdAt":"2026-08-19T07:00:00.000Z","updatedAt":"2026-08-19T07:00:00.000Z",
                "revision":"rev-workspace-2"}]}
                """
            )
        }

        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            workspaceArchiveStore: archiveStore,
            chatCache: chatCache,
            scheduledTaskCache: scheduledCache,
            workspaceEnvironmentCache: environmentCache,
            clientFactory: { installation, credential in
                AidenRemoteClient(endpoint: installation.endpoint, credential: credential, session: session)
            }
        )
        await coordinator.start()

        XCTAssertEqual(coordinator.connectionState, .connected)
        XCTAssertEqual(store.activeInstallationId, "instance-2")
        XCTAssertNil(keychain.scoped[KeychainStore.scopedKey(.remoteCredential, scope: firstInstallation.credentialScope)])
        XCTAssertEqual(
            keychain.scoped[KeychainStore.scopedKey(.remoteCredential, scope: secondInstallation.credentialScope)],
            "credential-two"
        )
        XCTAssertTrue(coordinator.presentedError?.contains("revoked") == true)
        let removedStream = await chatCache.loadActiveStream(instanceId: "instance-1", chatId: "chat-1")
        let retainedStream = await chatCache.loadActiveStream(instanceId: "instance-2", chatId: "chat-2")
        let removedSchedule = await scheduledCache.load(instanceId: "instance-1")
        let retainedSchedule = await scheduledCache.load(instanceId: "instance-2")
        XCTAssertNil(removedStream)
        XCTAssertNotNil(retainedStream)
        XCTAssertNil(removedSchedule)
        XCTAssertNotNil(retainedSchedule)
        XCTAssertEqual(archiveStore.archivedWorkspaceIDs(for: "instance-1"), [])
        XCTAssertEqual(archiveStore.archivedWorkspaceIDs(for: "instance-2"), ["workspace-2"])
    }

    @MainActor
    func testBotRequestCredentialRevocationImmediatelyRemovesThePairing() async throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let exchange = makeExchange(
            instanceId: "instance-bot-revoked",
            deviceId: "device-bot-revoked",
            credential: "credential-bot-revoked"
        )
        let installation = try store.savePairing(
            exchange,
            trust: makeSystemTrust(),
            name: "Revoked Bot Mac"
        )
        let session = makeSession()
        AidenRemoteMockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/aiden/v1/bots")
            return Self.response(
                for: request,
                status: 401,
                json: """
                {"error":{"code":"credential_revoked","message":"Pair this device again.",
                "requestId":"request-bot-revoked","retryable":false}}
                """
            )
        }
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { installation, credential in
                AidenRemoteClient(endpoint: installation.endpoint, credential: credential, session: session)
            }
        )
        let context = try coordinator.requestContext()

        do {
            _ = try await coordinator.remoteClient(for: context).bots()
            XCTFail("Expected the Bot request to report credential revocation.")
        } catch {
            let handled = await coordinator.handleCredentialRevocation(error, context: context)
            XCTAssertTrue(handled)
        }

        XCTAssertNil(store.activeInstallation)
        XCTAssertEqual(coordinator.connectionState, .needsPairing)
        XCTAssertNil(
            keychain.scoped[
                KeychainStore.scopedKey(.remoteCredential, scope: installation.credentialScope)
            ]
        )
        XCTAssertTrue(coordinator.presentedError?.contains("revoked") == true)
    }

    @MainActor
    func testRemovalSerializesAgainstAcceptedTurnWritesAndPurgesTheLateCommit() async throws {
        let keychain = AidenRemoteMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let exchange = makeExchange(
            instanceId: "instance-race",
            deviceId: "device-race",
            credential: String(repeating: "R", count: 43)
        )
        _ = try store.savePairing(exchange, trust: makeSystemTrust(), name: "Race Mac")
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-removal-race-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let coordinator = AidenRemoteCoordinator(installationStore: store, chatCache: cache)
        let context = try coordinator.requestContext()
        let probe = AidenInstallationDataRaceProbe()

        let acceptedCommit = Task { @MainActor in
            await coordinator.withRetainedInstallationData(for: context) {
                await probe.markEntered()
                await probe.waitForRelease()
                try? await cache.saveActiveStream(
                    .init(
                        deviceId: "device-race",
                        streamId: "stream-race",
                        turnId: "turn-race",
                        lastSequence: 0
                    ),
                    instanceId: "instance-race",
                    chatId: "chat-race"
                )
            }
        }
        await probe.waitUntilEntered()
        let removal = Task { @MainActor in
            await coordinator.removeInstallation("instance-race")
        }
        for _ in 0..<20 where !store.installations.isEmpty {
            await Task.yield()
        }
        XCTAssertTrue(store.installations.isEmpty)
        XCTAssertTrue(coordinator.isMutating)
        let overlappingSwitch = await coordinator.switchInstallationOutcome(to: "another-instance")
        guard case .busy = overlappingSwitch else {
            return XCTFail("An installation switch must not overlap removal and cache purging.")
        }
        await probe.release()
        _ = await acceptedCommit.value
        await removal.value
        XCTAssertFalse(coordinator.isMutating)

        let restored = await cache.loadActiveStream(
            instanceId: "instance-race",
            chatId: "chat-race"
        )
        XCTAssertNil(restored)
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

    private func botFixtureData(at keyPath: [String]) throws -> Data {
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "contract", withExtension: "json")
        )
        var value: Any = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL))
        for key in keyPath {
            value = try XCTUnwrap((value as? [String: Any])?[key])
        }
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }

    private func botFixtureValue<Value: Decodable>(at keyPath: [String]) throws -> Value {
        try AidenRemoteJSONDecoder.decode(Value.self, from: botFixtureData(at: keyPath))
    }

    private func assertInvalidResponse<Value>(
        file: StaticString = #filePath,
        line: UInt = #line,
        _ operation: () async throws -> Value
    ) async {
        do {
            _ = try await operation()
            XCTFail("Expected an invalid response.", file: file, line: line)
        } catch let error as AidenRemoteClientError {
            guard case .invalidResponse = error else {
                XCTFail("Expected invalidResponse, got \(error).", file: file, line: line)
                return
            }
        } catch {
            XCTFail("Expected AidenRemoteClientError, got \(error).", file: file, line: line)
        }
    }

    private func assertUnexpectedStatus<Value>(
        _ expectedStatus: Int,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ operation: () async throws -> Value
    ) async {
        do {
            _ = try await operation()
            XCTFail("Expected an unexpected HTTP status.", file: file, line: line)
        } catch let error as AidenRemoteClientError {
            guard case .unexpectedStatus(let status) = error, status == expectedStatus else {
                XCTFail("Expected status \(expectedStatus), got \(error).", file: file, line: line)
                return
            }
        } catch {
            XCTFail("Expected AidenRemoteClientError, got \(error).", file: file, line: line)
        }
    }

    private static func pngData(width: Int, height: Int, color: UIColor) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(
            size: CGSize(width: width, height: height),
            format: format
        ).pngData { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    private static func animatedPNGData() throws -> Data {
        let mutableData = NSMutableData()
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithData(mutableData, "public.png" as CFString, 2, nil)
        )
        CGImageDestinationSetProperties(
            destination,
            [kCGImagePropertyPNGDictionary: [kCGImagePropertyAPNGLoopCount: 0]] as CFDictionary
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        for color in [UIColor.systemIndigo, UIColor.systemOrange] {
            let image = try XCTUnwrap(
                UIGraphicsImageRenderer(
                    size: CGSize(width: 512, height: 512),
                    format: format
                ).image { context in
                    color.setFill()
                    context.fill(CGRect(x: 0, y: 0, width: 512, height: 512))
                }.cgImage
            )
            CGImageDestinationAddImage(
                destination,
                image,
                [
                    kCGImagePropertyPNGDictionary: [
                        kCGImagePropertyAPNGDelayTime: 0.1,
                        kCGImagePropertyAPNGUnclampedDelayTime: 0.1,
                    ],
                ] as CFDictionary
            )
        }
        guard CGImageDestinationFinalize(destination) else {
            throw CocoaError(.fileWriteUnknown)
        }
        return mutableData as Data
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
        credential: String,
        endpoint: URL = URL(string: "https://aiden.test/api/aiden/v1")!,
        capabilities: [AidenRemoteCapability] = [.serverRead, .workspaceRead]
    ) -> AidenRemoteContractFixture.PairingExchange {
        AidenRemoteContractFixture.PairingExchange(
            protocolVersion: 1,
            instanceId: instanceId,
            deviceId: deviceId,
            credential: credential,
            capabilities: capabilities,
            endpoint: endpoint,
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
        title: String = "New Chat",
        id: String = "chat-1"
    ) -> (HTTPURLResponse, Data) {
        response(
            for: request,
            status: status,
            json: """
            {"id":"\(id)","workspaceId":"workspace-1","title":"\(title)","messages":[],
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

    private static func response(
        for request: URLRequest,
        status: Int,
        data: Data
    ) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, data)
    }

    private static func imageResponse(
        for request: URLRequest,
        status: Int,
        data: Data,
        headers: [String: String] = [
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        ]
    ) -> (HTTPURLResponse, Data) {
        var responseHeaders = headers
        responseHeaders["Content-Type"] = "image/png"
        responseHeaders["Content-Length"] = String(data.count)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: responseHeaders
        )!
        return (response, data)
    }
}

private actor AidenInstallationDataRaceProbe {
    private var entered = false
    private var released = false
    private var enteredWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func markEntered() {
        entered = true
        let waiters = enteredWaiters
        enteredWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    func waitUntilEntered() async {
        guard !entered else { return }
        await withCheckedContinuation { enteredWaiters.append($0) }
    }

    func waitForRelease() async {
        guard !released else { return }
        await withCheckedContinuation { releaseWaiters.append($0) }
    }

    func release() {
        released = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
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
    var failingSaveKeys: Set<KeychainStore.Key> = []
    var failingScopedSaveScopes: Set<String> = []
    var failingScopedDeleteScopes: Set<String> = []

    func save(_ value: String, forKey key: KeychainStore.Key) throws {
        if failingSaveKeys.contains(key) { throw CocoaError(.fileWriteUnknown) }
        values[key] = value
    }
    func load(_ key: KeychainStore.Key) throws -> String? { values[key] }
    func delete(_ key: KeychainStore.Key) throws { values[key] = nil }

    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        if failingScopedSaveScopes.contains(scope) { throw CocoaError(.fileWriteUnknown) }
        scoped[KeychainStore.scopedKey(key, scope: scope)] = value
    }

    func load(_ key: KeychainStore.Key, scope: String) throws -> String? {
        scoped[KeychainStore.scopedKey(key, scope: scope)]
    }

    func delete(_ key: KeychainStore.Key, scope: String) throws {
        if failingScopedDeleteScopes.contains(scope) { throw CocoaError(.fileWriteUnknown) }
        scoped[KeychainStore.scopedKey(key, scope: scope)] = nil
    }
}
