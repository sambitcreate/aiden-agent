import ActivityKit
import Foundation
import XCTest
@testable import AidenOnTheGo

final class AidenNativeIntegrationTests: XCTestCase {
    @MainActor
    func testLiveActivityLookupScopesIdenticalStreamIDsToInstallation() {
        let attributes = AgentRunActivityAttributes(
            instanceID: "instance-a",
            sessionID: "chat-1",
            sessionTitle: "Chat",
            streamID: "stream-shared",
            startedAt: Date()
        )
        XCTAssertTrue(AidenRemoteLiveActivityManager.matches(
            attributes,
            instanceID: "instance-a",
            streamID: "stream-shared"
        ))
        XCTAssertFalse(AidenRemoteLiveActivityManager.matches(
            attributes,
            instanceID: "instance-b",
            streamID: "stream-shared"
        ))
    }

    func testIntentCatalogContainsOnlyBoundedDisplayNamesAndStableIDs() throws {
        let suiteName = "AidenNativeIntegrationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = AidenIntentCatalogStore(defaults: defaults)

        try store.update(
            installations: [.init(id: "instance-1", name: "Studio Mac")],
            activeInstallationId: "instance-1",
            workspaces: [.init(id: "workspace-1", instanceId: "instance-1", name: "Aiden")],
            for: "instance-1"
        )

        XCTAssertEqual(store.load(), AidenIntentCatalogSnapshot(
            installations: [.init(id: "instance-1", name: "Studio Mac")],
            workspaces: [.init(id: "workspace-1", instanceId: "instance-1", name: "Aiden")],
            activeInstallationId: "instance-1"
        ))
        let data = try XCTUnwrap(defaults.data(forKey: "aiden.intent-catalog.v1"))
        let serialized = try XCTUnwrap(String(data: data, encoding: .utf8)).lowercased()
        for forbidden in ["https://", "credential", "token", "pin", "/users/"] {
            XCTAssertFalse(serialized.contains(forbidden))
        }
    }

    func testIntentCatalogDropsUnsafeAndOrphanedRecords() throws {
        let suiteName = "AidenNativeIntegrationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = AidenIntentCatalogStore(defaults: defaults)
        try store.update(
            installations: [
                .init(id: "instance-1", name: "Studio"),
                .init(id: "instance-2", name: "Laptop"),
            ],
            activeInstallationId: "instance-1",
            workspaces: [
                .init(id: "../../secret", instanceId: "instance-1", name: "Unsafe"),
                .init(id: "workspace-2", instanceId: "missing", name: "Orphan"),
                .init(id: "shared-id", instanceId: "instance-1", name: "First"),
                .init(id: "shared-id", instanceId: "instance-2", name: "Second"),
            ],
            for: "instance-1"
        )
        XCTAssertEqual(store.load().workspaces.map(\.name).sorted(), ["First", "Second"])
        XCTAssertNotEqual(
            AidenWorkspaceIntentEntity(workspaceId: "shared-id", instanceId: "instance-1", name: "First").id,
            AidenWorkspaceIntentEntity(workspaceId: "shared-id", instanceId: "instance-2", name: "Second").id
        )
        let serialized = try XCTUnwrap(String(
            data: try XCTUnwrap(defaults.data(forKey: "aiden.intent-catalog.v1")),
            encoding: .utf8
        ))
        XCTAssertFalse(serialized.contains("../../secret"))
        XCTAssertFalse(serialized.contains("Orphan"))
    }

    func testDeepLinksCarryOnlyStableIdentifiersAndRejectAmbiguousInput() throws {
        let newChat = try XCTUnwrap(AidenDeepLink.newChatURL(
            instanceId: "instance-1",
            workspaceId: "workspace-1",
            startsVoice: true
        ))
        XCTAssertEqual(
            AidenDeepLink.request(from: newChat),
            AidenNavigationRequest(
                destination: .newChat,
                instanceId: "instance-1",
                workspaceId: "workspace-1",
                startsVoice: true
            )
        )
        XCTAssertFalse(newChat.absoluteString.lowercased().contains("prompt"))
        XCTAssertFalse(newChat.absoluteString.lowercased().contains("token"))
        XCTAssertFalse(newChat.absoluteString.contains("/Users/"))

        let chat = try XCTUnwrap(AidenDeepLink.chatURL(instanceId: "instance-1", chatId: "chat-1"))
        XCTAssertEqual(AidenDeepLink.request(from: chat)?.destination, .chat("chat-1"))
        XCTAssertNil(AidenDeepLink.request(from: URL(string: "aiden-otg://chat?instance=a&instance=b&chat=c")!))
        XCTAssertNil(AidenDeepLink.request(from: URL(string: "aiden-otg://chat?instance=a&chat=../../secret")!))
        XCTAssertNil(AidenDeepLink.request(from: URL(string: "aiden-otg://chat/path?instance=a&chat=c")!))
        XCTAssertNil(AidenDeepLink.request(from: URL(string: "aiden-otg://chat?instance=a&chat=c&prompt=hello")!))
    }

    @MainActor
    func testLiveActivityStateIsBoundedAndResponseExcerptDefaultsOff() throws {
        let longTitle = String(repeating: "Title ", count: 30)
        let longText = String(repeating: "private response ", count: 30)
        let initial = AgentRunActivityStateReducer.initialState(
            sessionID: "chat-1",
            sessionTitle: longTitle
        )
        let updated = AgentRunActivityStateReducer.appendingToken(longText, to: initial)
        XCTAssertLessThanOrEqual(updated.sessionTitle.count, AgentRunActivitySanitizer.maximumSessionTitleCharacters)
        XCTAssertLessThanOrEqual(updated.responseExcerpt.count, AgentRunActivitySanitizer.maximumExcerptCharacters)

        let suiteName = "AidenNativeIntegrationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let manager = AidenRemoteLiveActivityManager(defaults: defaults)
        XCTAssertFalse(manager.includesResponseExcerpts)
        XCTAssertEqual(initial.responseExcerpt, "")
    }

    @MainActor
    func testPhysicalActivityKitLifecycleUsesPrivateBoundedStateAndImmediateCleanup() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this physical device.")
        }

        let proofID = "physical-proof-\(UUID().uuidString)"
        let suiteName = "AidenNativeIntegrationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let manager = AidenRemoteLiveActivityManager(defaults: defaults)

        await manager.start(
            instanceID: proofID,
            chatID: proofID,
            title: "Aiden verification",
            streamID: proofID
        )

        guard let activity = Activity<AgentRunActivityAttributes>.activities.first(where: {
            $0.attributes.instanceID == proofID && $0.attributes.streamID == proofID
        }) else {
            await manager.endAll(forInstanceID: proofID)
            XCTFail("ActivityKit did not create the requested Aiden Live Activity.")
            return
        }

        XCTAssertEqual(activity.content.state.status, .starting)
        XCTAssertEqual(activity.content.state.responseExcerpt, "")
        XCTAssertFalse(activity.content.state.isFinal)

        await manager.toolStarted(name: "read_file", instanceID: proofID, streamID: proofID)
        await manager.appendResponse("private response text", instanceID: proofID, streamID: proofID)
        await manager.markStale(instanceID: proofID, streamID: proofID)

        let staleDeadline = Date().addingTimeInterval(2)
        while !activity.content.state.isStale && Date() < staleDeadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertTrue(activity.content.state.isStale)
        XCTAssertEqual(activity.content.state.status, .responding)
        XCTAssertEqual(activity.content.state.responseExcerpt, "")

        await manager.endAll(forInstanceID: proofID)

        let endDeadline = Date().addingTimeInterval(2)
        while (activity.activityState == .active || activity.activityState == .stale),
              Date() < endDeadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertTrue(activity.activityState == .ended || activity.activityState == .dismissed)
        XCTAssertFalse(Activity<AgentRunActivityAttributes>.activities.contains(where: { $0.id == activity.id }))
    }

    @MainActor
    func testFreshManagerReconcilesPersistedActivityThroughAuthenticatedClient() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this physical device.")
        }

        let proofID = "relaunch-proof-\(UUID().uuidString)"
        let suiteName = "AidenNativeIntegrationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer {
            defaults.removePersistentDomain(forName: suiteName)
            AidenNativeActivityURLProtocol.handler = nil
        }

        var originalManager: AidenRemoteLiveActivityManager? = AidenRemoteLiveActivityManager(defaults: defaults)
        await originalManager?.start(
            instanceID: proofID,
            chatID: proofID,
            title: "Relaunch verification",
            streamID: proofID
        )

        guard let activity = Activity<AgentRunActivityAttributes>.activities.first(where: {
            $0.attributes.instanceID == proofID && $0.attributes.streamID == proofID
        }) else {
            await originalManager?.endAll(forInstanceID: proofID)
            XCTFail("ActivityKit did not persist the Aiden activity for adoption.")
            return
        }
        originalManager = nil

        AidenNativeActivityURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/aiden/v1/streams/\(proofID)")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer proof-credential")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Aiden-Protocol-Version"), "1")
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            ))
            return (response, Data("""
            {"streamId":"\(proofID)","chatId":"\(proofID)","turnId":"turn-1",
            "state":"running","lastSequence":3,"updatedAt":"2026-08-19T19:00:00.000Z"}
            """.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AidenNativeActivityURLProtocol.self]
        let client = AidenRemoteClient(
            endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
            credential: "proof-credential",
            session: URLSession(configuration: configuration)
        )
        let adoptingManager = AidenRemoteLiveActivityManager(defaults: defaults)

        await adoptingManager.reconcile(instanceID: proofID, client: client, isCurrent: { true })
        let reconcileDeadline = Date().addingTimeInterval(2)
        while activity.content.state.status != .responding && Date() < reconcileDeadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(activity.content.state.status, .responding)
        XCTAssertFalse(activity.content.state.isStale)
        XCTAssertEqual(activity.content.state.responseExcerpt, "")

        await adoptingManager.endAll(forInstanceID: proofID)
        let endDeadline = Date().addingTimeInterval(2)
        while (activity.activityState == .active || activity.activityState == .stale),
              Date() < endDeadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertTrue(activity.activityState == .ended || activity.activityState == .dismissed)
        XCTAssertFalse(Activity<AgentRunActivityAttributes>.activities.contains(where: { $0.id == activity.id }))
    }

    @MainActor
    func testOptInPhysicalActivityKitProcessBoundaryPhase() async throws {
        let environment = ProcessInfo.processInfo.environment
        let proofIDValue = environment["AIDEN_ACTIVITYKIT_PROCESS_PROOF_ID"]
        let phaseValue = environment["AIDEN_ACTIVITYKIT_PROCESS_PHASE"]

        guard proofIDValue != nil || phaseValue != nil else {
            XCTAssertNil(proofIDValue)
            XCTAssertNil(phaseValue)
            return
        }

        let proofID = try XCTUnwrap(proofIDValue)
        let phase = try XCTUnwrap(phaseValue)
        let permittedProofCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        XCTAssertFalse(proofID.isEmpty)
        XCTAssertLessThanOrEqual(proofID.utf8.count, 128)
        XCTAssertNil(proofID.unicodeScalars.first(where: { !permittedProofCharacters.contains($0) }))
        guard !proofID.isEmpty,
              proofID.utf8.count <= 128,
              proofID.unicodeScalars.allSatisfy(permittedProofCharacters.contains)
        else {
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw XCTSkip("Live Activities are disabled on this physical device.")
        }

        let suiteName = "AidenNativeIntegrationTests.ProcessBoundary.\(proofID)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        switch phase {
        case "start":
            let manager = AidenRemoteLiveActivityManager(defaults: defaults)
            await manager.endAll(forInstanceID: proofID)
            await manager.start(
                instanceID: proofID,
                chatID: proofID,
                title: "Process relaunch verification",
                streamID: proofID
            )
            let activity = try XCTUnwrap(Activity<AgentRunActivityAttributes>.activities.first(where: {
                $0.attributes.instanceID == proofID && $0.attributes.streamID == proofID
            }))
            XCTAssertTrue(activity.activityState == .active || activity.activityState == .stale)
            XCTAssertEqual(activity.content.state.status, .starting)
            XCTAssertEqual(activity.content.state.responseExcerpt, "")
            print("AIDEN_ACTIVITYKIT_PROCESS checkpoint=started proof=\(proofID)")

        case "reconcile":
            guard let activity = Activity<AgentRunActivityAttributes>.activities.first(where: {
                $0.attributes.instanceID == proofID && $0.attributes.streamID == proofID
            }) else {
                XCTFail("The system-persisted Aiden Live Activity was not available after process relaunch.")
                return
            }

            AidenNativeActivityURLProtocol.handler = { request in
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(request.url?.path, "/api/aiden/v1/streams/\(proofID)")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer process-proof-credential")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Aiden-Protocol-Version"), "1")
                let response = try XCTUnwrap(HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                ))
                return (response, Data("""
                {"streamId":"\(proofID)","chatId":"\(proofID)","turnId":"turn-process-proof",
                "state":"running","lastSequence":4,"updatedAt":"2026-08-19T19:00:00.000Z"}
                """.utf8))
            }
            defer { AidenNativeActivityURLProtocol.handler = nil }

            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [AidenNativeActivityURLProtocol.self]
            let client = AidenRemoteClient(
                endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
                credential: "process-proof-credential",
                session: URLSession(configuration: configuration)
            )
            let manager = AidenRemoteLiveActivityManager(defaults: defaults)
            await manager.reconcile(instanceID: proofID, client: client, isCurrent: { true })

            let reconcileDeadline = Date().addingTimeInterval(2)
            while activity.content.state.status != .responding && Date() < reconcileDeadline {
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            XCTAssertEqual(activity.content.state.status, .responding)
            XCTAssertFalse(activity.content.state.isStale)
            XCTAssertEqual(activity.content.state.responseExcerpt, "")

            await manager.endAll(forInstanceID: proofID)
            let endDeadline = Date().addingTimeInterval(2)
            while (activity.activityState == .active || activity.activityState == .stale),
                  Date() < endDeadline {
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            XCTAssertTrue(activity.activityState == .ended || activity.activityState == .dismissed)
            XCTAssertFalse(Activity<AgentRunActivityAttributes>.activities.contains(where: { $0.id == activity.id }))
            print("AIDEN_ACTIVITYKIT_PROCESS checkpoint=reconciled-and-ended proof=\(proofID)")

        case "cleanup":
            let manager = AidenRemoteLiveActivityManager(defaults: defaults)
            await manager.endAll(forInstanceID: proofID)
            XCTAssertFalse(Activity<AgentRunActivityAttributes>.activities.contains(where: {
                $0.attributes.instanceID == proofID
            }))
            print("AIDEN_ACTIVITYKIT_PROCESS checkpoint=cleanup proof=\(proofID)")

        default:
            XCTFail("AIDEN_ACTIVITYKIT_PROCESS_PHASE must be start, reconcile, or cleanup.")
        }
    }

    func testVoiceDraftIsLocalExplicitAndRejectsInvalidAudioInput() throws {
        XCTAssertEqual(
            ComposerVoiceDraftComposer.composedDraft(baseDraft: "Please", transcript: "summarize locally"),
            "Please summarize locally"
        )
        XCTAssertFalse(ComposerVoiceInputStartPolicy.canStart(appIsActive: false))
        XCTAssertThrowsError(try ComposerVoiceInputStartPolicy.validateAudioSessionInput(
            isInputAvailable: false,
            sampleRate: 44_100,
            inputNumberOfChannels: 1
        ))
    }

    func testHostedAppDeclaresVoiceAndLiveActivityPrivacyKeys() throws {
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription"))
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription"))
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription"))
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSLocalNetworkUsageDescription"))
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "NSSupportsLiveActivities") as? Bool, true)
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity"))

        let privacyManifestURL = try XCTUnwrap(Bundle.main.url(
            forResource: "PrivacyInfo",
            withExtension: "xcprivacy"
        ))
        let privacyManifest = try XCTUnwrap(
            PropertyListSerialization.propertyList(
                from: try Data(contentsOf: privacyManifestURL),
                format: nil
            ) as? [String: Any]
        )
        XCTAssertEqual(privacyManifest["NSPrivacyTracking"] as? Bool, false)
        XCTAssertTrue((privacyManifest["NSPrivacyCollectedDataTypes"] as? [Any])?.isEmpty == true)

        let noticeURL = try XCTUnwrap(Bundle.main.url(
            forResource: "NOTICE",
            withExtension: "txt",
            subdirectory: "ThirdPartyNotices"
        ))
        let notice = try String(contentsOf: noticeURL, encoding: .utf8)
        XCTAssertTrue(notice.contains("Hermex (adapted SwiftUI interaction and implementation foundation)"))
        XCTAssertTrue(notice.contains("KeychainAccess 4.2.2"))
        XCTAssertTrue(notice.contains("MarkdownUI 2.4.1"))
        XCTAssertTrue(notice.contains("NetworkImage 6.0.1"))
        XCTAssertTrue(notice.contains("swift-cmark 0.8.0"))
        XCTAssertFalse(notice.contains("swift-eventsource"))

        for licenseName in ["MarkdownUI-LICENSE", "NetworkImage-LICENSE", "swift-cmark-COPYING"] {
            let licenseURL = try XCTUnwrap(Bundle.main.url(
                forResource: licenseName,
                withExtension: "txt",
                subdirectory: "ThirdPartyNotices"
            ))
            XCTAssertFalse(try String(contentsOf: licenseURL, encoding: .utf8).isEmpty)
        }

        let hermexLicenseURL = try XCTUnwrap(Bundle.main.url(
            forResource: "Hermex-LICENSE",
            withExtension: "txt",
            subdirectory: "ThirdPartyNotices"
        ))
        let hermexLicense = try String(contentsOf: hermexLicenseURL, encoding: .utf8)
        XCTAssertTrue(hermexLicense.contains("MIT License"))
        XCTAssertTrue(hermexLicense.contains("Copyright (c) 2026 Uzair Ansar"))
    }

    func testPublicPolicyAndSupportLinksUseCanonicalHTTPSDestinations() {
        XCTAssertEqual(AppConfig.privacyPolicyURL.absoluteString, "https://chatwithaiden.com/privacy")
        XCTAssertEqual(
            AppConfig.supportURL.absoluteString,
            "https://chatwithaiden.com/"
        )
        XCTAssertEqual(AppConfig.privacyPolicyURL.scheme, "https")
        XCTAssertEqual(AppConfig.supportURL.scheme, "https")
    }

    func testUnpairedDeepLinkUsesGenericAidenErrorPresentation() {
        XCTAssertEqual(AidenPairingAlertCopy.title, "Aiden On The Go")
        XCTAssertEqual(
            AidenPairingAlertCopy.fallbackMessage,
            "Try again from Aiden Agent Remote Access settings."
        )
    }
}

private final class AidenNativeActivityURLProtocol: URLProtocol, @unchecked Sendable {
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
