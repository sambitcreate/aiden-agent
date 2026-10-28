import CryptoKit
import Foundation
import Security
import XCTest
@testable import AidenOnTheGo

final class AidenRemotePhase0Tests: XCTestCase {
    func testBotSearchQueryReachesTheMacAsTypedAndPlainWordsStayLiteral() throws {
        // The Mac decodes a query value as `URLSearchParams` does: `+` is a space, then escapes.
        func macReads(_ value: String) -> String? {
            value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding
        }
        for search in ["plan week", "release notes & more", "café ☕ 100% done+", "it's #1 = best", "a/b:c@d"] {
            let encoded = AidenHostQuery.value(search)
            XCTAssertEqual(macReads(encoded), search, search)
            XCTAssertFalse(encoded.contains("&") || encoded.contains("#") || encoded.contains(" "), search)
        }
        // Macs before revision 41 refuse any `%`; spaces and the separators ids, dates and cursors use never need one.
        for value in ["plan week", "team: ops/weekly", "2026-10-27T12:00:00.000Z", "cur_abc=="] {
            XCTAssertFalse(AidenHostQuery.value(value).contains("%"), value)
        }
        var components = try XCTUnwrap(URLComponents(string: "https://studio.example.ts.net/api/aiden/v1/bot-conversations"))
        components.percentEncodedQuery = AidenHostQuery.encode([
            URLQueryItem(name: "query", value: "café & bar"),
            URLQueryItem(name: "limit", value: "20"),
        ])
        let url = try XCTUnwrap(components.url)
        XCTAssertEqual(url.query(percentEncoded: true), "query=caf%C3%A9+%26+bar&limit=20")
    }

    func testConnectionRecoveryDistinguishesOfflineTrustAndVersionFailures() {
        let offline = AidenConnectionIssue.classify(URLError(.notConnectedToInternet))
        XCTAssertEqual(offline.title, "Waiting for network")
        XCTAssertTrue(offline.canRetry)
        let trust = AidenConnectionIssue.classify(AidenServerTrustError.publicKeyPinMismatch)
        XCTAssertEqual(trust.title, "Verify this computer")
        XCTAssertFalse(trust.canRetry, "reconnecting must not imply bypassing a changed identity")
        let version = AidenConnectionIssue.classify(AidenRemoteContractError.invalidProtocolVersion)
        XCTAssertEqual(version.title, "Update required")
        XCTAssertTrue(version.message.contains("both devices"))
    }

    private let approvedKeychainService = "sbtbiswas.AidenOnTheGo.pairing"
    private let caCertificateDER = "MIIBpzCCAU6gAwIBAgIUIHmU6u43BGrkVPj4FQ5phcJ7K8EwCgYIKoZIzj0EAwIwIDEeMBwGA1UEAwwVQWlkZW4tUGhhc2UwLUxvY2FsLUNBMB4XDTI2MDgxODIwNTgwM1oXDTM2MDgxNTIwNTgwM1owIDEeMBwGA1UEAwwVQWlkZW4tUGhhc2UwLUxvY2FsLUNBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZwqoZbvPSf8paC937p5+TnciNpAxHE/4fwll/5YlUGW6xkSUmvFj7CpD3IPvY0PRgN+sZl/CzBFzn+wv9atnkaNmMGQwHQYDVR0OBBYEFK2vesnPv0ymHuSE6yQ9EoM+B7EYMB8GA1UdIwQYMBaAFK2vesnPv0ymHuSE6yQ9EoM+B7EYMBIGA1UdEwEB/wQIMAYBAf8CAQAwDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0cAMEQCIHawuTBf/AOiSWTY+XpLIUzSxxFdKmTZl1Vol4HRJQ5VAiBpYlpHpxEzMd2j/VK8fUfZ8DU6y7XKme2iJFS8M7d1lw=="
    private let originalCertificateDER = "MIIB4jCCAYmgAwIBAgIULA5eC0u0KgewVf5FJD89CeRl5icwCgYIKoZIzj0EAwIwIDEeMBwGA1UEAwwVQWlkZW4tUGhhc2UwLUxvY2FsLUNBMB4XDTI2MDgxODIwNTgwM1oXDTI2MDkxNzIwNTgwM1owJDEiMCAGA1UEAwwZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABI5u4+Ne8MXXQeyVvmFDduB1soFoJQvIv296OVjGuty9Z0VyUpKn2+oBKTSuD0GNooaSlIHqptxLFT/cpEYxrRqjgZwwgZkwJAYDVR0RBB0wG4IZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAdBgNVHQ4EFgQUnnUkXuqHkoGw2LKXeyU7bjyCVYcwHwYDVR0jBBgwFoAUra96yc+/TKYe5ITrJD0Sgz4HsRgwCgYIKoZIzj0EAwIDRwAwRAIgd2WNDX68uxSxGQYJsDiUXohxKlBeEjXESlgHx6WRrJgCIFJN5ineCyCIYL17DW2sJ/9h2qA3GdOo/aiUWc+e6FCV"
    private let renewedCertificateDER = "MIIB9TCCAZugAwIBAgIULA5eC0u0KgewVf5FJD89CeRl5igwCgYIKoZIzj0EAwIwIDEeMBwGA1UEAwwVQWlkZW4tUGhhc2UwLUxvY2FsLUNBMB4XDTI2MDgxODIwNTgwM1oXDTI2MDkxNzIwNTgwM1owNjEiMCAGA1UEAwwZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDEQMA4GA1UECwwHcmVuZXdlZDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABI5u4+Ne8MXXQeyVvmFDduB1soFoJQvIv296OVjGuty9Z0VyUpKn2+oBKTSuD0GNooaSlIHqptxLFT/cpEYxrRqjgZwwgZkwJAYDVR0RBB0wG4IZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAdBgNVHQ4EFgQUnnUkXuqHkoGw2LKXeyU7bjyCVYcwHwYDVR0jBBgwFoAUra96yc+/TKYe5ITrJD0Sgz4HsRgwCgYIKoZIzj0EAwIDSAAwRQIhANjQ3dAkNt/zT66IhAfodEWh75Ig5XmAju3MYn2sLSicAiBUomVIhfwnYjxs54zSiHzuyGpPmRKVCBHjzadb+U9MTw=="
    private let rotatedCertificateDER = "MIIB9TCCAZugAwIBAgIULA5eC0u0KgewVf5FJD89CeRl5ikwCgYIKoZIzj0EAwIwIDEeMBwGA1UEAwwVQWlkZW4tUGhhc2UwLUxvY2FsLUNBMB4XDTI2MDgxODIwNTgwM1oXDTI2MDkxNzIwNTgwM1owNjEiMCAGA1UEAwwZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDEQMA4GA1UECwwHcm90YXRlZDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABMFeD3fbzVvwD6XsOV0zTS9/afPUm0BzWjsDlPoPKR+s5dlo3aAIe1B0tsMvEOgdHb0BV8D9RQcOg3H+/qqKYLKjgZwwgZkwJAYDVR0RBB0wG4IZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAdBgNVHQ4EFgQU6Vpq2GlIaP7m9AHtEE+fve8bWDYwHwYDVR0jBBgwFoAUra96yc+/TKYe5ITrJD0Sgz4HsRgwCgYIKoZIzj0EAwIDSAAwRQIhAKdQOzcQ+qJZP/gpVvT8uDz+DvRx9JAEWTLmuUqoJ9ujAiABuU2rRJ/ivMhm5lGDDFrunkN9Kk04oUPjJ1w8CplkQg=="

    private func trust(for certificate: SecCertificate, ca: SecCertificate, host: String) throws -> SecTrust {
        var value: SecTrust?
        let status = SecTrustCreateWithCertificates(
            [certificate, ca] as CFArray,
            SecPolicyCreateSSL(true, host as CFString),
            &value
        )
        XCTAssertEqual(status, errSecSuccess)
        return try XCTUnwrap(value)
    }

    private func assertTransportLifecycleFixtures() throws {
        let original = try XCTUnwrap(SecCertificateCreateWithData(nil, try XCTUnwrap(Data(base64Encoded: originalCertificateDER)) as CFData))
        let renewed = try XCTUnwrap(SecCertificateCreateWithData(nil, try XCTUnwrap(Data(base64Encoded: renewedCertificateDER)) as CFData))
        let rotated = try XCTUnwrap(SecCertificateCreateWithData(nil, try XCTUnwrap(Data(base64Encoded: rotatedCertificateDER)) as CFData))
        let ca = try XCTUnwrap(SecCertificateCreateWithData(nil, try XCTUnwrap(Data(base64Encoded: caCertificateDER)) as CFData))
        let privateCAPolicy = AidenServerTrustPolicy.privateCA(SecCertificateCopyData(ca) as Data)
        let originalPin = try AidenServerTrust.spkiSHA256(certificate: original)
        XCTAssertEqual(try AidenServerTrust.spkiSHA256(certificate: renewed), originalPin)
        XCTAssertNotEqual(try AidenServerTrust.spkiSHA256(certificate: rotated), originalPin)
        let validDate = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-08-19T00:00:00Z"))
        XCTAssertNoThrow(try AidenServerTrust.evaluate(serverTrust: trust(for: original, ca: ca, host: "aiden-phase0.example.test"), expectedHost: "aiden-phase0.example.test", expectedFingerprint: originalPin, policy: privateCAPolicy, verificationDate: validDate))
        XCTAssertNoThrow(try AidenServerTrust.evaluate(serverTrust: trust(for: renewed, ca: ca, host: "aiden-phase0.example.test"), expectedHost: "aiden-phase0.example.test", expectedFingerprint: originalPin, policy: privateCAPolicy, verificationDate: validDate))
        XCTAssertThrowsError(try AidenServerTrust.evaluate(serverTrust: trust(for: original, ca: ca, host: "aiden-phase0.example.test"), expectedHost: "aiden-phase0.example.test", expectedFingerprint: originalPin, policy: .system, verificationDate: validDate))
        XCTAssertThrowsError(try AidenServerTrust.evaluate(serverTrust: trust(for: original, ca: ca, host: "aiden-phase0.example.test"), expectedHost: "aiden-phase0.example.test", expectedFingerprint: originalPin, policy: .privateCA(SecCertificateCopyData(rotated) as Data), verificationDate: validDate))
        XCTAssertThrowsError(try AidenServerTrust.evaluate(serverTrust: trust(for: rotated, ca: ca, host: "aiden-phase0.example.test"), expectedHost: "aiden-phase0.example.test", expectedFingerprint: originalPin, policy: privateCAPolicy, verificationDate: validDate))
        XCTAssertThrowsError(try AidenServerTrust.evaluate(serverTrust: trust(for: original, ca: ca, host: "wrong.example.test"), expectedHost: "wrong.example.test", expectedFingerprint: originalPin, policy: privateCAPolicy, verificationDate: validDate))
        let expiredDate = try XCTUnwrap(ISO8601DateFormatter().date(from: "2040-01-01T00:00:00Z"))
        XCTAssertThrowsError(try AidenServerTrust.evaluate(serverTrust: trust(for: original, ca: ca, host: "aiden-phase0.example.test"), expectedHost: "aiden-phase0.example.test", expectedFingerprint: originalPin, policy: privateCAPolicy, verificationDate: expiredDate))
    }
    private var sharedContractFixtureURL: URL? {
        Bundle(for: Self.self).url(forResource: "contract", withExtension: "json")
    }

    func testLocalNetworkPrivacyAndBonjourContractIsDeclared() throws {
        let bundle = Bundle.main
        let usageDescription = try XCTUnwrap(
            bundle.object(forInfoDictionaryKey: "NSLocalNetworkUsageDescription") as? String
        )
        XCTAssertFalse(usageDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        let services = try XCTUnwrap(bundle.object(forInfoDictionaryKey: "NSBonjourServices") as? [String])
        XCTAssertEqual(services, ["_aiden-agent._tcp"])
    }

    func testBuiltAppHasNoInsecureHTTPOrArbitraryLoadATSException() throws {
        let bundle = Bundle.main
        guard let transportSecurity = bundle.object(
            forInfoDictionaryKey: "NSAppTransportSecurity"
        ) as? [String: Any] else {
            return
        }

        XCTAssertNotEqual(transportSecurity["NSAllowsArbitraryLoads"] as? Bool, true)
        XCTAssertNotEqual(transportSecurity["NSAllowsArbitraryLoadsForMedia"] as? Bool, true)
        XCTAssertNotEqual(transportSecurity["NSAllowsArbitraryLoadsInWebContent"] as? Bool, true)
        XCTAssertNotEqual(transportSecurity["NSAllowsLocalNetworking"] as? Bool, true)
        XCTAssertNil(transportSecurity["NSExceptionDomains"])
    }

    func testAidenKeychainServiceResolvesToApprovedIdentity() throws {
        XCTAssertEqual(
            Bundle.main.object(forInfoDictionaryKey: "AidenKeychainService") as? String,
            approvedKeychainService
        )
    }

    func testBuiltAppUsesOnlyApprovedAidenProductIdentity() throws {
        let bundle = Bundle.main
        XCTAssertEqual(bundle.bundleIdentifier, "sbtbiswas.AidenOnTheGo")
        XCTAssertEqual(
            bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String,
            "Aiden On The Go"
        )
        XCTAssertEqual(
            bundle.object(forInfoDictionaryKey: "AidenAppGroupIdentifier") as? String,
            "group.sbtbiswas.AidenOnTheGo"
        )
        XCTAssertEqual(
            bundle.object(forInfoDictionaryKey: "AidenURLScheme") as? String,
            "aiden-otg"
        )

        let urlTypes = try XCTUnwrap(
            bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]]
        )
        let schemes = urlTypes.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertEqual(schemes, ["aiden-otg"])
        XCTAssertFalse(
            schemes.contains { scheme in
                let value = scheme.lowercased()
                return value.contains("hermes") || value.contains("hermex")
            }
        )
    }

    func testSignedDeviceAidenKeychainIsolationWhenConfigured() throws {
        guard ProcessInfo.processInfo.environment["AIDEN_PHASE0_KEYCHAIN_PROOF"] == "1" else {
            throw XCTSkip("Set AIDEN_PHASE0_KEYCHAIN_PROOF=1 only for a normally signed device run.")
        }

        let scope = "aiden-phase0-\(UUID().uuidString)"
        let probe = UUID().uuidString
        let store = KeychainStore()
        let otherStore = KeychainStore(service: "\(approvedKeychainService).phase0-isolation")
        defer {
            try? store.delete(.remoteCredential, scope: scope)
            try? otherStore.delete(.remoteCredential, scope: scope)
        }

        XCTAssertNil(try store.load(.remoteCredential, scope: scope))
        try store.save(probe, forKey: .remoteCredential, scope: scope)
        XCTAssertEqual(try store.load(.remoteCredential, scope: scope), probe)
        XCTAssertNil(try otherStore.load(.remoteCredential, scope: scope))
        try store.delete(.remoteCredential, scope: scope)
        XCTAssertNil(try store.load(.remoteCredential, scope: scope))
    }

    func testSharedContractFixtureDecodesAndSequencesAreTerminalSafe() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let data = try Data(contentsOf: fixtureURL)
        let fixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: data
        )

        XCTAssertEqual(fixture.contractRevision, 41)
        XCTAssertEqual(fixture.scheduleCards?.capability, .scheduleCards)
        // Revision 19 run-control losers learn the winning decision; phones keep
        // their mobile-only grants, so the fixture never offers host capabilities.
        let runControlError = try XCTUnwrap(fixture.runControlError?.error)
        XCTAssertEqual(runControlError.code, AidenRemoteErrorCode(rawValue: "approval_resolved"))
        XCTAssertEqual(runControlError.details?.decision, "deny")
        XCTAssertNotNil(runControlError.details?.resolvedAt)
        XCTAssertEqual(fixture.protocolVersion, AidenRemoteProtocol.version)
        XCTAssertTrue(fixture.health.ok)
        XCTAssertEqual(fixture.health.protocolVersion, AidenRemoteProtocol.version)
        XCTAssertEqual(Set(fixture.capabilities), Set(AidenRemoteCapability.v1Known))
        let allEvents = fixture.events + fixture.chatProgressEvents
        XCTAssertEqual(Set(allEvents.map(\.type)), Set(AidenRemoteEventType.v1Known))
        // Revision 29: the host's answered questionnaire survives the stream decode.
        let recap = try XCTUnwrap(
            fixture.events.lazy.compactMap(\.payload?.timeline).flatMap(\.steps)
                .first { $0.toolName == AidenQuestionnaireRecap.toolName }?.questionnaire
        )
        XCTAssertEqual(recap.outcome, .answered)
        XCTAssertEqual(recap.items.map(\.kind), [.option, .skipped])
        XCTAssertEqual(recap.items.map { $0.answer(for: recap.outcome) }, [.chosen("Plain text"), .unanswered("Skipped")])
        // Revision 38: values a page read in extract mode survive the stream decode.
        let extraction = try XCTUnwrap(
            fixture.events.lazy.compactMap(\.payload?.timeline).flatMap(\.steps)
                .first { $0.toolName == AidenWebExtractRecap.toolName }?.extraction
        )
        XCTAssertEqual(extraction.host, "acme.example")
        XCTAssertEqual(extraction.fields.map(\.status), [.extracted, .uncertain, .absent])
        XCTAssertEqual(extraction.fields.first?.sourceLine, "Pro is $20 per month, billed monthly.")
        XCTAssertEqual(fixture.taskProgress?.chatId, fixture.chat.id)
        XCTAssertEqual(fixture.taskProgress?.tasks.count, 3)
        XCTAssertEqual(fixture.agentRoster?.chatId, fixture.chat.id)
        XCTAssertEqual(fixture.agentRoster?.agents.count, 2)
        XCTAssertEqual(fixture.agentRoster?.agents.first?.role, .implementer)
        XCTAssertTrue(fixture.server.supportsChatAgentInterrupt)
        let interrupt = try XCTUnwrap(fixture.agentInterrupt)
        XCTAssertEqual(interrupt.response.chatId, fixture.chat.id)
        XCTAssertEqual(interrupt.response.turnId, fixture.agentRoster?.turnId)
        XCTAssertEqual(
            interrupt.response.agents.first { $0.agentId == interrupt.agentId }?.state,
            .stopped
        )
        XCTAssertEqual(fixture.agentRoster?.previousTurns.map(\.turnId), [
            "turn_fixture_previous_02",
            "turn_fixture_previous_01",
        ])
        XCTAssertEqual(
            fixture.deviceCapabilitiesUpdate?.request.accepts,
            [.tasksRead, .agentsRead, .questionsRespond, .skillsInvoke]
        )
        XCTAssertTrue(fixture.server.supportsChatTasks)
        XCTAssertTrue(fixture.server.supportsChatAgents)
        XCTAssertTrue(fixture.server.supportsChatRunInput)
        XCTAssertTrue(fixture.server.supportsQuestionPrompts)
        XCTAssertTrue(fixture.server.supportsChatSkills)
        XCTAssertEqual(fixture.chatSkills?.skills.count, 3)
        XCTAssertEqual(fixture.chatSkills?.skills.first?.name, "review-code")
        XCTAssertEqual(fixture.chatSkills?.skills.first?.available, true)
        XCTAssertNil(fixture.chatSkills?.skills.first?.unavailableReason)
        XCTAssertEqual(fixture.chatSkills?.skills[1].available, false)
        XCTAssertEqual(
            fixture.chatSkills?.skills[1].unavailableReason,
            "Shadowed by workspace skill \"release-notes\"."
        )
        // A description-less skill is valid wire data; the strict decoder must
        // accept the empty string rather than failing the whole catalog.
        XCTAssertEqual(fixture.chatSkills?.skills.last?.name, "triage")
        XCTAssertEqual(fixture.chatSkills?.skills.last?.description, "")
        XCTAssertEqual(fixture.chatSkills?.skills.last?.available, true)
        XCTAssertEqual(fixture.question?.pending.promptId, "q-fixture-01")
        XCTAssertEqual(fixture.question?.pending.streamId, fixture.streamStatus.streamId)
        XCTAssertEqual(fixture.question?.pending.chatId, fixture.chat.id)
        XCTAssertEqual(fixture.question?.pending.questions.count, 1)
        XCTAssertEqual(fixture.question?.pending.questions.first?.options.count, 2)
        XCTAssertEqual(fixture.question?.respondRequest.cancelled, false)
        XCTAssertEqual(
            fixture.question?.respondRequest.answers,
            [.option(questionIndex: 0, answer: "0.5 mm")]
        )
        XCTAssertEqual(
            fixture.question?.respondResponse.promptId,
            fixture.question?.pending.promptId
        )
        let questionEvent = fixture.events.first { $0.type == .questionRequired }
        XCTAssertEqual(
            questionEvent?.questionPrompt?.promptId,
            fixture.question?.pending.promptId
        )
        XCTAssertEqual(
            questionEvent?.questionPrompt?.questions,
            fixture.question?.pending.questions
        )
        XCTAssertEqual(fixture.streamInput?.request.mode, .queue)
        XCTAssertEqual(fixture.streamInput?.response.status, .admitted)
        XCTAssertEqual(fixture.streamInput?.response.queue, .followUp)
        XCTAssertEqual(fixture.streamInput?.response.committed, true)
        XCTAssertEqual(fixture.streamInput?.response.streamId, fixture.streamStatus.streamId)
        XCTAssertTrue(fixture.botCapabilityCatalog.fileScopes.contains { $0.kind == .fullMac })
        XCTAssertEqual(fixture.speechStatus.selectedModelId, "parakeet-v3")
        XCTAssertEqual(fixture.speechStatus.input.sampleRate, 16_000)
        XCTAssertFalse(fixture.speechStatus.input.partialResults)
        XCTAssertEqual(fixture.speechTranscription.modelId, "parakeet-v3")
        XCTAssertEqual(fixture.pairingBootstrap.protocolVersion, AidenRemoteProtocol.version)
        XCTAssertEqual(fixture.pairingBootstrap.endpoint.scheme, "https")
        XCTAssertGreaterThanOrEqual(fixture.pairingBootstrap.secret.count, 32)
        XCTAssertTrue(fixture.pairingBootstrap.serverSpkiSha256.hasPrefix("sha256/"))
        let fixtureReferenceDate = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-08-18T19:00:00Z")
        )
        XCTAssertNoThrow(try fixture.pairingBootstrap.validated(at: fixtureReferenceDate))
        XCTAssertNoThrow(try fixture.pairingExchange.validated(against: fixture.pairingBootstrap))
        XCTAssertEqual(fixture.pairingExchange.displayName, "Fixture Aiden")
        XCTAssertEqual(fixture.chat.botId, "bot_fixture_01")
        XCTAssertTrue(fixture.server.capabilities.contains(.botRead))
        XCTAssertEqual(
            Set(try XCTUnwrap(fixture.server.serverCapabilities)),
            Set(fixture.capabilities)
        )
        XCTAssertEqual(fixture.streamStatus.state, .waitingForApproval)
        XCTAssertNil(Mirror(reflecting: fixture.streamStatus).children.first { $0.label == "approval" })
        XCTAssertEqual(fixture.streamApproval.approval?.approvalId, "approval_fixture_01")
        XCTAssertEqual(fixture.streamApproval.approval?.canAllow, true)

        var lastSequence: [String: Int] = [:]
        var terminalStreams = Set<String>()
        for event in allEvents {
            XCTAssertFalse(terminalStreams.contains(event.streamId))
            XCTAssertEqual(event.sequence, (lastSequence[event.streamId] ?? 0) + 1)
            lastSequence[event.streamId] = event.sequence
            if event.terminal { terminalStreams.insert(event.streamId) }
        }
    }

    func testProgressSnapshotsRejectPrivateOrMalformedProjectionFields() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any]
        )
        let progress = try XCTUnwrap(root["taskProgress"])
        let valid = try JSONSerialization.data(withJSONObject: progress)
        XCTAssertNoThrow(try AidenRemoteJSONDecoder.decode(AidenRemoteChatTaskProgress.self, from: valid))

        var privateField = try XCTUnwrap(progress as? [String: Any])
        privateField["subagents"] = ["runId": "private-child-run"]
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteChatTaskProgress.self,
                from: JSONSerialization.data(withJSONObject: privateField)
            )
        )

        var malformedTask = try XCTUnwrap(progress as? [String: Any])
        var tasks = try XCTUnwrap(malformedTask["tasks"] as? [[String: Any]])
        tasks[1]["blockedBy"] = [999]
        malformedTask["tasks"] = tasks
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteChatTaskProgress.self,
                from: JSONSerialization.data(withJSONObject: malformedTask)
            )
        )

        var multipleActiveTasks = try XCTUnwrap(progress as? [String: Any])
        var activeTasks = try XCTUnwrap(multipleActiveTasks["tasks"] as? [[String: Any]])
        activeTasks[2]["status"] = "in_progress"
        multipleActiveTasks["tasks"] = activeTasks
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteChatTaskProgress.self,
                from: JSONSerialization.data(withJSONObject: multipleActiveTasks)
            )
        )

        var cyclicTasks = try XCTUnwrap(progress as? [String: Any])
        var cycle = try XCTUnwrap(cyclicTasks["tasks"] as? [[String: Any]])
        cycle[1]["blockedBy"] = [3]
        cycle[2]["blockedBy"] = [2]
        cyclicTasks["tasks"] = cycle
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteChatTaskProgress.self,
                from: JSONSerialization.data(withJSONObject: cyclicTasks)
            )
        )

        let roster = try XCTUnwrap(root["agentRoster"] as? [String: Any])
        var malformedAgent = roster
        var agents = try XCTUnwrap(malformedAgent["agents"] as? [[String: Any]])
        agents[0]["parentAgentId"] = "agent_fixture_01"
        malformedAgent["agents"] = agents
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteChatAgentRoster.self,
                from: JSONSerialization.data(withJSONObject: malformedAgent)
            )
        )
    }

    func testImplementerRoleDecodesFromMacRoster() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let data = try Data(contentsOf: fixtureURL)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var roster = try XCTUnwrap(root["agentRoster"] as? [String: Any])
        var agents = try XCTUnwrap(roster["agents"] as? [[String: Any]])
        agents[0]["role"] = "implementer"
        roster["agents"] = agents
        let decoded = try AidenRemoteJSONDecoder.decode(
            AidenRemoteChatAgentRoster.self,
            from: JSONSerialization.data(withJSONObject: roster)
        )
        XCTAssertEqual(decoded.agents.first?.role, .implementer)
    }

    func testAgentRosterPreviousTurnsEnforceNewestFirstButAcceptTies() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any]
        )
        let roster = try XCTUnwrap(root["agentRoster"] as? [String: Any])

        var oldestFirst = roster
        oldestFirst["previousTurns"] = [
            ["turnId": "turn_fixture_older", "startedAt": "2026-08-18T18:00:00Z"],
            ["turnId": "turn_fixture_newer", "startedAt": "2026-08-18T19:00:00Z"],
        ]
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteChatAgentRoster.self,
                from: JSONSerialization.data(withJSONObject: oldestFirst)
            )
        )

        var tied = roster
        tied["previousTurns"] = [
            ["turnId": "turn_fixture_a", "startedAt": "2026-08-18T19:00:00Z"],
            ["turnId": "turn_fixture_b", "startedAt": "2026-08-18T19:00:00Z"],
        ]
        let decoded = try AidenRemoteJSONDecoder.decode(
            AidenRemoteChatAgentRoster.self,
            from: JSONSerialization.data(withJSONObject: tied)
        )
        XCTAssertEqual(decoded.previousTurns.count, 2)
    }

    func testParentVisibleMessageTextPreservesExactSemanticContent() throws {
        let samples = [
            "NFC café | NFD cafe\u{301} | हिन्दी | 日本語 | العربية",
            "Emoji 👩🏽‍💻 👨‍👩‍👧‍👦 🇺🇳 1️⃣ 🚀",
            "/Users/example/Aiden Projects/π.swift | C:\\Users\\example\\Aiden Projects\\pi.swift",
            "/api/aiden/v1/chats/chat_01?after=42 | https://example.test/a%2Fb?q=hello%20world#résumé",
            "UUID 123e4567-e89b-12d3-a456-426614174000 | base64 SGVsbG8sIFdvcmxkIQ== | hex deadbeef0123456789ABCDEF",
            "Benign prose: token=session_token, secret=example-secret, api_key=example_api_key, Authorization: Bearer visible-placeholder",
        ]

        for (index, expected) in samples.enumerated() {
            let wireObject: [String: Any] = [
                "id": "message-\(index)",
                "role": "assistant",
                "text": expected,
                "createdAt": "2026-08-25T18:00:00.000Z",
            ]
            let wireData = try JSONSerialization.data(withJSONObject: wireObject)
            let decoded = try AidenRemoteJSONDecoder.decode(AidenChatMessage.self, from: wireData)

            XCTAssertEqual(Array(decoded.text.utf8), Array(expected.utf8), "UTF-8 changed for sample \(index)")
            XCTAssertEqual(Array(decoded.text.utf16), Array(expected.utf16), "UTF-16 changed for sample \(index)")
            XCTAssertEqual(
                decoded.text.unicodeScalars.map(\.value),
                expected.unicodeScalars.map(\.value),
                "Unicode scalars changed for sample \(index)"
            )

            let projectedData = try JSONEncoder().encode(decoded)
            let projectedObject = try XCTUnwrap(
                JSONSerialization.jsonObject(with: projectedData) as? [String: Any]
            )
            let projectedText = try XCTUnwrap(projectedObject["text"] as? String)
            XCTAssertEqual(
                Array(projectedText.utf8),
                Array(expected.utf8),
                "Encoded UTF-8 changed for sample \(index)"
            )
            XCTAssertEqual(
                projectedText.unicodeScalars.map(\.value),
                expected.unicodeScalars.map(\.value),
                "Encoded Unicode scalars changed for sample \(index)"
            )
        }
    }

    func testEncodedMessageAndModelCatalogExposeOnlyPublicProjectionKeys() throws {
        let message = AidenChatMessage(
            id: "message-public",
            role: .assistant,
            text: "Parent-visible result and report back",
            createdAt: Date(timeIntervalSince1970: 1_777_000_000)
        )
        let messageObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any]
        )
        XCTAssertEqual(Set(messageObject.keys), Set(["id", "role", "text", "createdAt"]))

        let catalog = AidenModelCatalog(
            providers: [
                AidenProvider(
                    id: "provider-public",
                    label: "Public provider",
                    models: [
                        AidenModel(
                            id: "model-public",
                            label: "Public model",
                            supportsImages: nil,
                            thinkingLevels: nil,
                            defaultThinkingLevel: nil,
                            thinkingCanDisable: nil,
                            hidden: nil
                        ),
                    ]
                ),
            ],
            defaults: ["providerId": "provider-public", "modelId": "model-public"]
        )
        let catalogObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(catalog)) as? [String: Any]
        )
        XCTAssertEqual(Set(catalogObject.keys), Set(["providers", "defaults"]))
        let defaults = try XCTUnwrap(catalogObject["defaults"] as? [String: Any])
        XCTAssertEqual(Set(defaults.keys), Set(["providerId", "modelId"]))
        let provider = try XCTUnwrap((catalogObject["providers"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(provider.keys), Set(["id", "label", "models"]))
        let model = try XCTUnwrap((provider["models"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(model.keys), Set(["id", "label"]))

        let forbiddenChildOrPrivateKeys = Set([
            "childId", "childRunId", "task", "result", "privateHistory", "systemPrompt",
            "absolutePath", "providerCredential", "authorizationHeader", "providerApiKey",
        ])
        func assertNoPrivateKeys(_ value: Any) {
            if let dictionary = value as? [String: Any] {
                XCTAssertTrue(forbiddenChildOrPrivateKeys.isDisjoint(with: dictionary.keys))
                dictionary.values.forEach(assertNoPrivateKeys)
            } else if let array = value as? [Any] {
                array.forEach(assertNoPrivateKeys)
            }
        }
        assertNoPrivateKeys(messageObject)
        assertNoPrivateKeys(catalogObject)
    }

    func testAdditiveChildFieldsDecodeButDoNotEnterTheParentProjection() throws {
        let input: [String: Any] = [
            "id": "message-parent",
            "role": "assistant",
            "text": "Visible parent answer.",
            "createdAt": "2026-08-25T18:00:00.000Z",
            "outcome": [
                "status": "failed",
                "category": "interrupted",
                "attempts": 1,
                "retryExhausted": false,
            ],
            "timeline": [
                "version": 3,
                "generationId": "parent-generation",
                "status": "failed",
                "startedAt": 1_000,
                "finishedAt": 2_000,
                "steps": [],
            ],
            "subagents": [
                "version": 1,
                "generationId": "parent-generation",
                "runIds": ["private-child-run-1", "private-child-run-2"],
                "items": [[
                    "runId": "private-child-run-1",
                    "label": "Private scout",
                    "role": "scout",
                    "state": "completed",
                ], [
                    "runId": "private-child-run-2",
                    "label": "Private reviewer",
                    "role": "reviewer",
                    "state": "failed",
                ]],
                "total": 2,
                "completed": 1,
                "failed": 1,
                "timedOut": 0,
                "interrupted": 0,
            ],
            "subagentLifecycle": ["state": "completed"],
            "subagentControl": ["canStop": false],
        ]
        let decoded = try AidenRemoteJSONDecoder.decode(
            AidenChatMessage.self,
            from: JSONSerialization.data(withJSONObject: input)
        )

        XCTAssertEqual(decoded.text, "Visible parent answer.")
        XCTAssertEqual(decoded.outcome?.status, .failed)
        XCTAssertEqual(decoded.outcome?.category, "interrupted")
        XCTAssertEqual(decoded.timeline?.generationId, "parent-generation")
        XCTAssertEqual(decoded.timeline?.status, .failed)

        let encoded = try JSONEncoder().encode(decoded)
        let output = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        XCTAssertEqual(
            Set(output.keys),
            Set(["id", "role", "text", "createdAt", "outcome", "timeline"])
        )
        XCTAssertNil(output["subagents"])
        let serialized = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        for privateValue in [
            "private-child-run-1", "private-child-run-2", "Private scout",
            "Private reviewer", "scout", "reviewer",
        ] {
            XCTAssertFalse(serialized.contains(privateValue), privateValue)
        }
        for privateKey in [
            "subagents", "runIds", "items", "total", "completed", "failed",
            "timedOut", "interrupted", "subagentLifecycle", "subagentControl",
        ] {
            XCTAssertFalse(serialized.contains("\"\(privateKey)\":"), privateKey)
        }
    }

    func testHealthResponseRequiresExactSuccessfulV1Contract() throws {
        let valid = Data(#"{"ok":true,"protocolVersion":1}"#.utf8)
        XCTAssertNoThrow(try AidenRemoteJSONDecoder.decode(AidenRemoteContractFixture.Health.self, from: valid))

        let invalidResponses = [
            Data(#"{"ok":true,"protocolVersion":1,"unexpected":true}"#.utf8),
            Data(#"{"protocolVersion":1}"#.utf8),
            Data(#"{"ok":true}"#.utf8),
            Data(#"{"ok":false,"protocolVersion":1}"#.utf8),
            Data(#"{"ok":true,"protocolVersion":2}"#.utf8),
        ]
        for response in invalidResponses {
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decode(AidenRemoteContractFixture.Health.self, from: response)
            )
        }
    }

    func testSharedFixtureContainsNoForbiddenWireFieldsOrMachinePaths() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let data = try Data(contentsOf: fixtureURL)
        let object = try JSONSerialization.jsonObject(with: data)
        let forbidden = Set([
            "authorization", "credentialDigest", "providerFingerprint",
            "mcpServerBindings", "folderPath", "repositoryPath", "worktreePath",
            "worktreeGitDir", "ownershipToken", "worktreeDevice", "worktreeInode",
            "createdFromHead", "canonicalPath", "absolutePath", "scriptPath",
            "environment", "stdout", "stderr",
            "subagents", "subagentId", "subagentIds", "childId", "childIds",
            "childRunId", "childRunIds", "privateHistory",
        ])

        func isVisibleMessageText(_ path: [String]) -> Bool {
            path == ["chat", "messages", "[]", "text"]
                || path == ["botChatCreate", "response", "messages", "[]", "text"]
        }
        func hasForbiddenAppearance(_ string: String, at path: [String]) -> Bool {
            !isVisibleMessageText(path)
                && (string.contains("/Users/") || string.contains("BEGIN PRIVATE KEY"))
        }
        func inspect(_ value: Any, path: [String] = []) throws {
            if let dictionary = value as? [String: Any] {
                XCTAssertTrue(forbidden.isDisjoint(with: dictionary.keys))
                for (key, child) in dictionary { try inspect(child, path: path + [key]) }
            } else if let array = value as? [Any] {
                for child in array { try inspect(child, path: path + ["[]"]) }
            } else if let string = value as? String {
                XCTAssertFalse(hasForbiddenAppearance(string, at: path), path.joined(separator: "."))
            }
        }
        try inspect(object)
        XCTAssertFalse(
            hasForbiddenAppearance(
                "/Users/example/visible prose mentioning BEGIN PRIVATE KEY",
                at: ["chat", "messages", "[]", "text"]
            )
        )
        XCTAssertFalse(
            hasForbiddenAppearance(
                "/Users/example/visible Bot prose mentioning BEGIN PRIVATE KEY",
                at: ["botChatCreate", "response", "messages", "[]", "text"]
            )
        )
        XCTAssertTrue(
            hasForbiddenAppearance(
                "/Users/example/private metadata",
                at: ["chat", "messages", "[]", "timeline", "target"]
            )
        )
        XCTAssertTrue(
            hasForbiddenAppearance(
                "/Users/example/private nested transcript lookalike",
                at: ["chat", "privateHistory", "messages", "[]", "text"]
            )
        )
        XCTAssertTrue(forbidden.contains("privateHistory"))
    }

    func testP256SPKIFingerprintMatchesIndependentFixture() throws {
        let rawKey = Data([0x04] + Array(repeating: UInt8(0), count: 64))
        XCTAssertEqual(
            try AidenServerTrust.spkiSHA256(p256ExternalRepresentation: rawKey),
            "sha256/FhPubfxu6YoU7IG0Hq45pUOLUPvLv4oAgUflVyabRMs="
        )
    }

    func testCertificateRenewalRotationWrongHostAndExpiryFailClosed() throws {
        try assertTransportLifecycleFixtures()
    }

    func testP256SPKIFingerprintRejectsMalformedOrWrongCurveRepresentations() {
        XCTAssertThrowsError(
            try AidenServerTrust.spkiSHA256(p256ExternalRepresentation: Data(repeating: 0, count: 65))
        )
        XCTAssertThrowsError(
            try AidenServerTrust.spkiSHA256(p256ExternalRepresentation: Data([0x04]))
        )
    }

    func testPairingBootstrapValidationFailsClosed() throws {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let valid = AidenRemoteContractFixture.PairingBootstrap(
            protocolVersion: 1,
            instanceId: "instance_fixture",
            endpoint: try XCTUnwrap(URL(string: "https://aiden.example.test/api/aiden/v1")),
            serverSpkiSha256: "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            expiresAt: now.addingTimeInterval(60)
        )
        XCTAssertNoThrow(try valid.validated(at: now))
        let validWithExplicitPort = AidenRemoteContractFixture.PairingBootstrap(
            protocolVersion: valid.protocolVersion,
            instanceId: valid.instanceId,
            endpoint: try XCTUnwrap(URL(string: "https://aiden.example.test:7443/api/aiden/v1")),
            serverSpkiSha256: valid.serverSpkiSha256,
            secret: valid.secret,
            expiresAt: valid.expiresAt
        )
        XCTAssertNoThrow(try validWithExplicitPort.validated(at: now))
        for encodedPath in [
            "/api/aiden%2Fv1",
            "/api/aiden%2fv1",
            "/%61pi/aiden/v1",
        ] {
            let encodedEndpoint = AidenRemoteContractFixture.PairingBootstrap(
                protocolVersion: valid.protocolVersion,
                instanceId: valid.instanceId,
                endpoint: try XCTUnwrap(URL(string: "https://aiden.example.test\(encodedPath)")),
                serverSpkiSha256: valid.serverSpkiSha256,
                secret: valid.secret,
                expiresAt: valid.expiresAt
            )
            XCTAssertThrowsError(try encodedEndpoint.validated(at: now))
        }
        for invalidEndpoint in [
            "https://:443/api/aiden/v1",
            "https://:65536/api/aiden/v1",
            "https://aiden.example.test:0/api/aiden/v1",
            "https://aiden.example.test:65536/api/aiden/v1",
            "https://aiden.example.test/api/aiden/v1?",
            "https://aiden.example.test/api/aiden/v1#",
        ] {
            let endpoint = AidenRemoteContractFixture.PairingBootstrap(
                protocolVersion: valid.protocolVersion,
                instanceId: valid.instanceId,
                endpoint: try XCTUnwrap(URL(string: invalidEndpoint)),
                serverSpkiSha256: valid.serverSpkiSha256,
                secret: valid.secret,
                expiresAt: valid.expiresAt
            )
            XCTAssertThrowsError(try endpoint.validated(at: now), invalidEndpoint)
        }
        XCTAssertThrowsError(try AidenRemoteContractFixture.PairingBootstrap(
            protocolVersion: valid.protocolVersion,
            instanceId: String(repeating: "i", count: 129),
            endpoint: valid.endpoint,
            serverSpkiSha256: valid.serverSpkiSha256,
            secret: valid.secret,
            expiresAt: valid.expiresAt
        ).validated(at: now))
        XCTAssertThrowsError(try AidenRemoteContractFixture.PairingBootstrap(
            protocolVersion: 1,
            instanceId: valid.instanceId,
            endpoint: try XCTUnwrap(URL(string: "http://aiden.example.test/api/aiden/v1")),
            serverSpkiSha256: valid.serverSpkiSha256,
            secret: valid.secret,
            expiresAt: valid.expiresAt
        ).validated(at: now))
        XCTAssertThrowsError(try AidenRemoteContractFixture.PairingBootstrap(
            protocolVersion: 1,
            instanceId: valid.instanceId,
            endpoint: valid.endpoint,
            serverSpkiSha256: "sha256/not-a-digest",
            secret: valid.secret,
            expiresAt: valid.expiresAt
        ).validated(at: now))
        XCTAssertThrowsError(try AidenRemoteContractFixture.PairingBootstrap(
            protocolVersion: 1,
            instanceId: valid.instanceId,
            endpoint: valid.endpoint,
            serverSpkiSha256: valid.serverSpkiSha256,
            secret: "too-short",
            expiresAt: valid.expiresAt
        ).validated(at: now))
        XCTAssertThrowsError(try AidenRemoteContractFixture.PairingBootstrap(
            protocolVersion: 1,
            instanceId: valid.instanceId,
            endpoint: valid.endpoint,
            serverSpkiSha256: valid.serverSpkiSha256,
            secret: valid.secret,
            expiresAt: now
        ).validated(at: now))
        XCTAssertThrowsError(try AidenRemoteContractFixture.PairingBootstrap(
            protocolVersion: 1,
            instanceId: valid.instanceId,
            endpoint: valid.endpoint,
            serverSpkiSha256: valid.serverSpkiSha256,
            secret: valid.secret,
            expiresAt: now.addingTimeInterval(301)
        ).validated(at: now))
    }

    func testEndpointAuthorityGrammarMatchesDesktopVectors() throws {
        // Keep this authority vector byte-for-byte aligned with
        // main/services/aiden-remote-protocol.test.ts.
        let endpointAuthorityVectors: [(String, Bool)] = [
            ("aiden.example.test", true),
            ("localhost", true),
            ("aiden-lan.local", true),
            ("192.168.1.42", true),
            ("192.0.2.1:443", true),
            ("aiden.0", false),
            ("aiden.123", false),
            ("aiden.example.test:1", true),
            ("aiden.example.test:65535", true),
            ("[::]", true),
            ("[::1]", true),
            ("[2001:db8::1]:443", true),
            ("[::ffff:192.0.2.1]", true),
            ("aiden.example.test:0443", false),
            ("aiden.example.test:00001", false),
            ("aiden.example.test:0", false),
            ("aiden.example.test:65536", false),
            ("aiden.example.test:abc", false),
            ("aiden.example.test:", false),
            (":443", false),
            ("aiden.example.test:1:2", false),
            ("aiden.example.test%2eexample.test", false),
            ("aiden.example.test%25", false),
            ("aiden．example.test", false),
            ("aiden\u{0301}.example.test", false),
            ("aiden.example.test\u{0009}", false),
            ("aiden.example.test\u{001f}", false),
            ("aiden.example.test\u{007f}", false),
            ("aiden..example.test", false),
            ("-aiden.example.test", false),
            ("aiden-.example.test", false),
            ("aiden_example.test", false),
            ("123", false),
            ("192.168.001.1", false),
            ("256.1.1.1", false),
            ("[fe80::1%25en0]", false),
            ("[v1.fe]", false),
            ("[::1", false),
            ("[::1]x", false),
            ("::1", false),
            ("[::1]:00001", false),
            ("[::1]:65536", false),
            ("[2001:db8::1::2]", false),
            ("[192.0.2.1::]", false),
            ("[::ffff:192.000.2.1]", false),
            ("[2001:db8:0:0:0:0:0]", false),
        ]
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expiry = formatter.string(from: now.addingTimeInterval(60))

        for (authority, valid) in endpointAuthorityVectors {
            let fields: [String: Any] = [
                "protocolVersion": 1,
                "instanceId": "instance_fixture",
                "endpoint": "https://\(authority)/api/aiden/v1",
                "serverSpkiSha256": "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "secret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "expiresAt": expiry,
            ]
            let data = try JSONSerialization.data(withJSONObject: fields)
            if valid {
                let bootstrap = try AidenRemoteJSONDecoder.decodePairingBootstrap(from: data)
                XCTAssertNoThrow(try bootstrap.validated(at: now), authority)
            } else {
                XCTAssertThrowsError(
                    try AidenRemoteJSONDecoder.decodePairingBootstrap(from: data),
                    authority
                )
            }
        }
    }

    func testStrictRFC3339DatesRejectPermissivePairingAndEventForms() throws {
        let pairingFields: [String: Any] = [
            "protocolVersion": 1,
            "instanceId": "instance_fixture",
            "endpoint": "https://aiden.example.test/api/aiden/v1",
            "serverSpkiSha256": "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "secret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "expiresAt": "2026-08-18T19:05:00.000Z",
        ]
        let eventFields: [String: Any] = [
            "protocolVersion": 1,
            "streamId": "stream-1",
            "sequence": 1,
            "timestamp": "2026-08-18T19:01:01.000Z",
            "type": "heartbeat",
            "terminal": false,
            "payload": [:],
        ]
        let malformedDates = [
            "2026-08-18",
            "2026-08-18T19:05:00.000+0000",
            "2026-02-30T19:05:00.000Z",
        ]

        for date in malformedDates {
            var pairing = pairingFields
            pairing["expiresAt"] = date
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decodePairingBootstrap(
                    from: JSONSerialization.data(withJSONObject: pairing)
                )
            )

            var event = eventFields
            event["timestamp"] = date
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decodeSSEEvent(
                    from: JSONSerialization.data(withJSONObject: event)
                )
            )
        }
    }

    func testCanonicalPairingPayloadRequiresExactKindAndTrustShape() throws {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let bootstrap: [String: Any] = [
            "protocolVersion": 1,
            "instanceId": "instance_fixture",
            "endpoint": "https://aiden.example.test/api/aiden/v1",
            "serverSpkiSha256": "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "secret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "expiresAt": formatter.string(from: now.addingTimeInterval(60)),
        ]
        let valid: [String: Any] = [
            "kind": "aiden-pairing-v1",
            "bootstrap": bootstrap,
            "trust": [
                "mode": "private-ca",
                "caCertificateDerBase64": caCertificateDER,
            ],
        ]
        let payload = try AidenRemoteJSONDecoder.decodePairingPayload(
            from: JSONSerialization.data(withJSONObject: valid)
        )
        XCTAssertNoThrow(try payload.validated(at: now))
        XCTAssertEqual(payload.trust.caCertificateDER?.base64EncodedString(), caCertificateDER)

        var wrongKind = valid
        wrongKind["kind"] = "future-pairing"
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodePairingPayload(
            from: JSONSerialization.data(withJSONObject: wrongKind)
        ))

        var unknownOuterKey = valid
        unknownOuterKey["endpoint"] = "https://attacker.invalid"
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodePairingPayload(
            from: JSONSerialization.data(withJSONObject: unknownOuterKey)
        ))

        for invalidTrust in [
            ["mode": "system", "caCertificateDerBase64": caCertificateDER],
            ["mode": "private-ca"],
            ["mode": "private-ca", "caCertificateDerBase64": "not-base64"],
            ["mode": "system", "future": "field"],
        ] {
            var invalid = valid
            invalid["trust"] = invalidTrust
            XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodePairingPayload(
                from: JSONSerialization.data(withJSONObject: invalid)
            ))
        }

        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodePairingPayload(
            from: Data(repeating: 0x20, count: AidenRemoteProtocol.maxPairingPayloadBytes + 1)
        )) { error in
            XCTAssertEqual(error as? AidenRemoteContractError, .payloadTooLarge)
        }
    }

    func testStrictRFC3339DatePreservesFractionAndUTCOffsetInstant() throws {
        let utcEvent = try AidenRemoteJSONDecoder.decodeSSEEvent(
            from: JSONSerialization.data(withJSONObject: [
                "protocolVersion": 1,
                "streamId": "stream-utc",
                "sequence": 1,
                "timestamp": "2026-08-18T13:31:01.250Z",
                "type": "heartbeat",
                "terminal": false,
                "payload": [:],
            ])
        )
        let offsetEvent = try AidenRemoteJSONDecoder.decodeSSEEvent(
            from: JSONSerialization.data(withJSONObject: [
                "protocolVersion": 1,
                "streamId": "stream-offset",
                "sequence": 1,
                "timestamp": "2026-08-18T19:01:01.25+05:30",
                "type": "heartbeat",
                "terminal": false,
                "payload": [:],
            ])
        )
        XCTAssertEqual(offsetEvent.timestamp, utcEvent.timestamp)
    }

    func testErrorEnvelopeRejectsUnknownFieldsCodesAndBounds() throws {
        let unknownField = Data(#"{"error":{"code":"internal_error","message":"safe","requestId":"request-1","retryable":false,"unexpected":true}}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.self, from: unknownField))

        let unknownCode = Data(#"{"error":{"code":"future_error","message":"safe","requestId":"request-1","retryable":false}}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.self, from: unknownCode))

        let oversizedRequestID = try JSONSerialization.data(withJSONObject: [
            "error": [
                "code": "internal_error",
                "message": "safe",
                "requestId": String(repeating: "r", count: 129),
                "retryable": false,
            ],
        ])
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.self, from: oversizedRequestID))

        let invalidDetails = try JSONSerialization.data(withJSONObject: [
            "error": [
                "code": "internal_error",
                "message": "safe",
                "requestId": "request-1",
                "retryable": false,
                "details": ["retryAfterSeconds": 86_401],
            ],
        ])
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.self, from: invalidDetails))

        let unknownDecision = Data(#"{"error":{"code":"approval_resolved","message":"safe","requestId":"request-1","retryable":false,"details":{"decision":"maybe"}}}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.self, from: unknownDecision))
    }

    func testNullMembersAreNotTreatedAsAbsent() throws {
        let nullEventPayloads = [
            Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"heartbeat","terminal":false,"payload":{"text":null}}"#.utf8),
            Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"status","terminal":false,"payload":{"state":null}}"#.utf8),
            Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"snapshot","terminal":false,"payload":{"chatId":"chat-1","turnId":"turn-1","nextSequence":null}}"#.utf8),
            Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"heartbeat","terminal":false,"payload":{"future":null}}"#.utf8),
        ]
        for event in nullEventPayloads {
            XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: event))
        }

        let nullErrorMembers = [
            Data(#"{"error":{"code":"internal_error","message":"safe","requestId":"request-1","retryable":false,"details":null}}"#.utf8),
            Data(#"{"error":{"code":"internal_error","message":"safe","requestId":"request-1","retryable":false,"details":{"retryAfterSeconds":null}}}"#.utf8),
            Data(#"{"error":{"code":"internal_error","message":"safe","requestId":"request-1","retryable":false,"details":{"currentRevision":null}}}"#.utf8),
            Data(#"{"error":{"code":"internal_error","message":null,"requestId":"request-1","retryable":false}}"#.utf8),
            Data(#"{"error":{"code":"internal_error","message":"safe","requestId":null,"retryable":false}}"#.utf8),
            Data(#"{"error":{"code":"internal_error","message":"safe","requestId":"request-1","retryable":null}}"#.utf8),
        ]
        for envelope in nullErrorMembers {
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.self, from: envelope)
            )
        }
    }

    func testUnknownCapabilitiesAndEventsRemainForwardCompatibleButErrorsAreStrict() throws {
        let capability = try AidenRemoteJSONDecoder.decode(
            AidenRemoteCapability.self,
            from: Data("\"future:read\"".utf8)
        )
        let event = try AidenRemoteJSONDecoder.decode(
            AidenRemoteEventType.self,
            from: Data("\"future_event\"".utf8)
        )
        XCTAssertEqual(capability.rawValue, "future:read")
        XCTAssertEqual(event.rawValue, "future_event")
        XCTAssertEqual(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteErrorCode.self,
                from: Data("\"bot_archived\"".utf8)
            ).rawValue,
            "bot_archived"
        )
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorCode.self,
            from: Data("\"future_error\"".utf8)
        ))

        let futureNonterminal = Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"future_progress","terminal":false,"payload":{"future":"ignored"}}"#.utf8)
        let ignored = try AidenRemoteJSONDecoder.decodeSSEEvent(from: futureNonterminal)
        XCTAssertFalse(ignored.shouldApply)
        XCTAssertNil(ignored.payload)

        let futureNonterminalWithoutPayload = Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"future_progress","terminal":false}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: futureNonterminalWithoutPayload))

        let unsafeUnknown = Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"future_progress","terminal":false,"payload":{"absolutePath":"/private/secret"}}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: unsafeUnknown))

        var oversizedUnknownPayload: [String: Any] = [:]
        for index in 0...32 {
            oversizedUnknownPayload["future_\(index)"] = true
        }
        let oversizedUnknown = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1,
            "streamId": "stream-1",
            "sequence": 1,
            "timestamp": "2026-08-18T19:00:00Z",
            "type": "future_progress",
            "terminal": false,
            "payload": oversizedUnknownPayload,
        ])
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: oversizedUnknown))

        let futureTerminal = Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"future_terminal","terminal":true,"payload":{}}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: futureTerminal))

        let unknownErrorCode = Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"error","terminal":true,"payload":{"code":"future_error","message":"safe"}}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: unknownErrorCode))

        let oversizedErrorMessage = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1,
            "streamId": "stream-1",
            "sequence": 1,
            "timestamp": "2026-08-18T19:00:00Z",
            "type": "error",
            "terminal": true,
            "payload": [
                "code": "internal_error",
                "message": String(repeating: "x", count: 2_001),
            ],
        ])
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: oversizedErrorMessage))

        let unsafeKnown = Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"heartbeat","terminal":false,"payload":{"absolutePath":"/private/secret"}}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: unsafeKnown))
    }

    func testPinnedSessionRedirectPolicyRejectsDowngradeAndAuthorityChanges() throws {
        let delegate = AidenPinnedServerSessionDelegate(
            expectedHost: "aiden.example.test",
            expectedPort: 7443,
            expectedFingerprint: "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            trustPolicy: .system
        )
        XCTAssertTrue(delegate.allowsRedirect(to: try XCTUnwrap(URL(string: "https://aiden.example.test:7443/api/aiden/v1/health"))))
        XCTAssertFalse(delegate.allowsRedirect(to: try XCTUnwrap(URL(string: "http://aiden.example.test:7443/api/aiden/v1/health"))))
        XCTAssertFalse(delegate.allowsRedirect(to: try XCTUnwrap(URL(string: "https://other.example.test:7443/api/aiden/v1/health"))))
        XCTAssertFalse(delegate.allowsRedirect(to: try XCTUnwrap(URL(string: "https://aiden.example.test:8443/api/aiden/v1/health"))))

        let defaultPortDelegate = AidenPinnedServerSessionDelegate(
            expectedHost: "aiden.example.test",
            expectedFingerprint: "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            trustPolicy: .system
        )
        XCTAssertTrue(defaultPortDelegate.allowsRedirect(to: try XCTUnwrap(URL(string: "https://aiden.example.test/api/aiden/v1/health"))))
        XCTAssertTrue(defaultPortDelegate.allowsRedirect(to: try XCTUnwrap(URL(string: "https://aiden.example.test:443/api/aiden/v1/health"))))
        XCTAssertFalse(defaultPortDelegate.allowsRedirect(to: try XCTUnwrap(URL(string: "https://aiden.example.test:7443/api/aiden/v1/health"))))
        XCTAssertTrue(delegate.responds(to: #selector(URLSessionTaskDelegate.urlSession(_:task:willPerformHTTPRedirection:newRequest:completionHandler:))))
    }

    func testStreamEnvelopeRejectsInvalidIdentityAndSequence() throws {
        let invalidEvents = [
            #"{"protocolVersion":2,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"heartbeat","terminal":false,"payload":{}}"#,
            #"{"protocolVersion":1,"streamId":"","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"heartbeat","terminal":false,"payload":{}}"#,
            #"{"protocolVersion":1,"streamId":"stream-1","sequence":0,"timestamp":"2026-08-18T19:00:00Z","type":"heartbeat","terminal":false,"payload":{}}"#,
            #"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"status","terminal":false,"payload":{"state":"done"}}"#,
        ]
        for event in invalidEvents {
            XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: Data(event.utf8)))
        }

        let reconciling = #"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"status","terminal":false,"payload":{"state":"reconciling"}}"#
        XCTAssertNoThrow(try AidenRemoteJSONDecoder.decodeSSEEvent(from: Data(reconciling.utf8)))

        let additiveEnvelope = #"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"heartbeat","terminal":false,"payload":{},"futureEnvelopeMetadata":{"ignored":true}}"#
        XCTAssertNoThrow(try AidenRemoteJSONDecoder.decodeSSEEvent(from: Data(additiveEnvelope.utf8)))

        var additiveEnvelopeFields: [String: Any] = [
            "protocolVersion": 1,
            "streamId": "stream-additive",
            "sequence": 1,
            "timestamp": "2026-08-18T19:00:00Z",
            "type": "heartbeat",
            "terminal": false,
            "payload": [:],
        ]
        for index in 0..<33 {
            additiveEnvelopeFields["futureEnvelope_\(index)"] = true
        }
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decodeSSEEvent(
                from: JSONSerialization.data(withJSONObject: additiveEnvelopeFields)
            )
        )

        var wideNestedMetadata: [String: Any] = [:]
        for index in 0..<33 {
            wideNestedMetadata["futureNested_\(index)"] = true
        }
        var nestedMetadataEvent = additiveEnvelopeFields
        nestedMetadataEvent["futureMetadata"] = wideNestedMetadata
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decodeSSEEvent(
                from: JSONSerialization.data(withJSONObject: nestedMetadataEvent)
            )
        )

        func nestedMetadata(depth: Int) -> [String: Any] {
            var value: [String: Any] = ["leaf": true]
            for index in 0..<depth {
                value = ["nested_\(index)": value]
            }
            return value
        }
        var depthBoundedEvent = additiveEnvelopeFields
        depthBoundedEvent["futureDeepMetadata"] = nestedMetadata(depth: 126)
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decodeSSEEvent(
                from: JSONSerialization.data(withJSONObject: depthBoundedEvent)
            )
        )
        var tooDeepEvent = additiveEnvelopeFields
        // The event envelope consumes depth 0 and its metadata value starts at
        // depth 1; 126 wrappers reach the allowed depth-128 scalar, while one
        // more wrapper must be rejected by the shared depth ceiling.
        tooDeepEvent["futureDeepMetadata"] = nestedMetadata(depth: 127)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decodeSSEEvent(
                from: JSONSerialization.data(withJSONObject: tooDeepEvent)
            )
        )

        let oversizedStreamID = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1,
            "streamId": String(repeating: "s", count: 129),
            "sequence": 1,
            "timestamp": "2026-08-18T19:00:00Z",
            "type": "heartbeat",
            "terminal": false,
            "payload": [:],
        ])
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: oversizedStreamID))

        let oversizedType = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1,
            "streamId": "stream-1",
            "sequence": 1,
            "timestamp": "2026-08-18T19:00:00Z",
            "type": String(repeating: "t", count: 81),
            "terminal": false,
            "payload": [:],
        ])
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: oversizedType))

        let oversizedText = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1,
            "streamId": "stream-1",
            "sequence": 1,
            "timestamp": "2026-08-18T19:00:00Z",
            "type": "text_delta",
            "terminal": false,
            "payload": ["text": String(repeating: "x", count: 200_001)],
        ])
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: oversizedText))

        let combiningText = String(repeating: "e\u{301}", count: 100_000) + "x"
        XCTAssertEqual(combiningText.count, 100_001)
        XCTAssertEqual(combiningText.unicodeScalars.count, 200_001)
        let combiningTextEvent = try JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1,
            "streamId": "stream-1",
            "sequence": 1,
            "timestamp": "2026-08-18T19:00:00Z",
            "type": "text_delta",
            "terminal": false,
            "payload": ["text": combiningText],
        ])
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: combiningTextEvent))
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decodeSSEEvent(
                from: Data(repeating: 0x20, count: AidenRemoteProtocol.maxSSEFrameBytes + 1)
            )
        )
    }

    func testStreamSequencesUsePositiveSafeIntegers() throws {
        let maxSafeSequence = #"{"protocolVersion":1,"streamId":"stream-1","sequence":9007199254740991,"timestamp":"2026-08-18T19:00:00Z","type":"heartbeat","terminal":false,"payload":{}}"#
        XCTAssertNoThrow(try AidenRemoteJSONDecoder.decodeSSEEvent(from: Data(maxSafeSequence.utf8)))

        let tooLargeSequence = #"{"protocolVersion":1,"streamId":"stream-1","sequence":9007199254740992,"timestamp":"2026-08-18T19:00:00Z","type":"heartbeat","terminal":false,"payload":{}}"#
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: Data(tooLargeSequence.utf8)))

        let maxSafeNextSequence = #"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"snapshot","terminal":false,"payload":{"chatId":"chat-1","turnId":"turn-1","nextSequence":9007199254740991}}"#
        XCTAssertNoThrow(try AidenRemoteJSONDecoder.decodeSSEEvent(from: Data(maxSafeNextSequence.utf8)))

        let tooLargeNextSequence = #"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"snapshot","terminal":false,"payload":{"chatId":"chat-1","turnId":"turn-1","nextSequence":9007199254740992}}"#
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: Data(tooLargeNextSequence.utf8)))
    }

    // MARK: Contract revision 24: phone observation and control of foreign runs

    func testPhoneRunFixtureDrivesForeignRunProjectionThroughFirstResponderOutcomes() throws {
        let fixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: XCTUnwrap(sharedContractFixtureURL))
        )
        let events = fixture.phoneRunEvents
        XCTAssertEqual(events.count, 13)
        XCTAssertTrue(events.allSatisfy { $0.runId == "run_fixture_02" })
        // `run.ended` repeats the content terminal's sequence and is the only
        // run-level terminal frame.
        XCTAssertEqual(events.suffix(2).map(\.sequence), [12, 12])
        XCTAssertEqual(events.last?.kind, .ended(chatId: "chat_fixture_01", state: .done))

        var projection = AidenForeignRunProjection(runId: "run_fixture_02")
        var effects: [[AidenForeignRunProjection.Effect]] = []
        for event in events.prefix(6) { effects.append(projection.apply(event)) }
        // Attaching mid-run surfaces status, text and tool rows like an owned run.
        XCTAssertEqual(projection.liveText, "Checking the build.")
        XCTAssertEqual(projection.tools.map(\.name), ["run_command"])
        XCTAssertEqual(projection.tools.first?.status, "succeeded")
        XCTAssertEqual(projection.state, .waitingForApproval)
        let allowable = try XCTUnwrap(projection.pendingApproval)
        XCTAssertEqual(allowable.approvalId, "approval_fixture_02")
        XCTAssertTrue(allowable.canAllow)
        XCTAssertEqual(allowable.scopes, [.once, .chat])
        XCTAssertEqual(effects.last, [.approvalRequired("approval_fixture_02")])

        // The Mac answered first: the phone learns the winning decision.
        let lost = projection.apply(events[6])
        XCTAssertEqual(lost, [.answeredElsewhere(AidenForeignRunResolution(
            prompt: .approval(.allow), resolvedAt: events[6].timestamp
        ))])
        XCTAssertNil(projection.pendingApproval)
        XCTAssertEqual(projection.state, .running)
        if case let .answeredElsewhere(resolution) = lost.first {
            XCTAssertEqual(resolution.notice, "Answered on Mac: allowed")
        }

        // A host-only approval reaches the phone as deny-only, without scopes.
        _ = projection.apply(events[7])
        let hostOnly = try XCTUnwrap(projection.pendingApproval)
        XCTAssertFalse(hostOnly.canAllow)
        XCTAssertNil(hostOnly.scopes)
        // This phone answered it, so its resolution is not "answered elsewhere".
        projection.markAnsweredLocally(hostOnly.approvalId)
        XCTAssertEqual(projection.apply(events[8]), [])

        XCTAssertEqual(projection.apply(events[9]), [.questionRequired("q-fixture-02")])
        XCTAssertEqual(projection.pendingQuestion?.questions.first?.header, "Chamfer")
        XCTAssertEqual(projection.apply(events[10]), [.answeredElsewhere(AidenForeignRunResolution(
            prompt: .question("answered"), resolvedAt: events[10].timestamp
        ))])

        // A replayed frame is ignored; the content terminal and run.ended share
        // a sequence and only run.ended closes the projection.
        XCTAssertEqual(projection.apply(events[3]), [])
        XCTAssertEqual(projection.apply(events[11]), [])
        XCTAssertFalse(projection.isEnded)
        XCTAssertEqual(projection.apply(events[12]), [.ended(.done)])
        XCTAssertTrue(projection.isEnded)
        XCTAssertEqual(projection.state, .done)
        XCTAssertEqual(projection.apply(events[12]), [], "An ended run accepts nothing further.")
    }

    func testForeignTimelineReplayCannotRollbackAndGapClearsIt() throws {
        func frame(_ sequence: Int, _ type: String, _ payload: String) throws -> AidenRemoteRunEvent {
            let json = "{\"protocolVersion\":1,\"streamId\":\"run-1\",\"sequence\":\(sequence),\"timestamp\":\"2026-10-05T10:00:00Z\",\"type\":\"\(type)\",\"terminal\":false,\"payload\":\(payload)}"
            return try XCTUnwrap(AidenRunSSEParser().consumeAll(["id: \(sequence)", "event: \(type)", "data: \(json)", ""]).first)
        }
        var projection = AidenForeignRunProjection(runId: "run-1")
        let first = try frame(2, "timeline", #"{"timeline":{"version":3,"generationId":"g","status":"running","startedAt":1000,"steps":[]}}"#)
        _ = projection.apply(first)
        XCTAssertEqual(projection.timeline?.status, .running)
        _ = projection.apply(try frame(3, "timeline", #"{"timeline":{"version":3,"generationId":"g","status":"completed","startedAt":1000,"finishedAt":2000,"steps":[]}}"#))
        _ = projection.apply(first)
        XCTAssertEqual(projection.timeline?.status, .completed)
        _ = projection.apply(try frame(0, "snapshot", #"{"runId":"run-1","chatId":"chat-1","reason":"gap","epoch":"e1","state":"running","pendingApprovalIds":[],"pendingQuestionIds":[],"approvals":[],"questions":[],"nextSequence":1}"#))
        XCTAssertNil(projection.timeline)
    }

    func testRunStreamGapSnapshotAtSequenceZeroRestatesPendingPrompts() throws {
        let snapshot = #"{"protocolVersion":1,"streamId":"run-1","sequence":0,"timestamp":"2026-10-05T10:00:00Z","type":"snapshot","terminal":false,"payload":{"runId":"run-1","chatId":"chat-1","reason":"gap","epoch":"e1","state":"running","pendingApprovalIds":["approval-1"],"pendingQuestionIds":[],"approvals":[{"approvalId":"approval-1","summary":"Run the tests?","toolName":"run_command","canAllow":true,"scopes":["once"]}],"questions":[],"nextSequence":1}}"#
        let text = #"{"protocolVersion":1,"streamId":"run-1","sequence":1,"timestamp":"2026-10-05T10:00:01Z","type":"text_delta","terminal":false,"payload":{"text":"Still going"}}"#
        var parser = AidenRunSSEParser()
        var events: [AidenRemoteRunEvent] = []
        for line in ["id: 0", "event: snapshot", "data: \(snapshot)", "", ": keep-alive", "id: 1", "event: text_delta", "data: \(text)", ""] {
            if let event = try parser.consume(line: line) { events.append(event) }
        }
        XCTAssertEqual(events.map(\.sequence), [0, 1])

        var projection = AidenForeignRunProjection(runId: "run-1")
        XCTAssertEqual(projection.apply(events[0]), [.reconcile])
        XCTAssertEqual(projection.pendingApproval?.approvalId, "approval-1")
        XCTAssertEqual(projection.state, .waitingForApproval)
        XCTAssertEqual(projection.apply(events[1]), [.textAppended("Still going")])
        XCTAssertEqual(projection.lastSequence, 1)
        // This phone's answer hides the prompt from the next snapshot, but an
        // answer whose write was not confirmed comes back when the Mac still
        // lists the prompt as pending.
        var answered = AidenForeignRunProjection(runId: "run-1")
        _ = answered.apply(events[0])
        answered.markAnsweredLocally("approval-1")
        XCTAssertNil(answered.pendingApproval)
        XCTAssertEqual(answered.apply(events[0]), [.reconcile])
        XCTAssertNil(answered.pendingApproval, "An answer in flight from this phone is not restated.")
        answered.answerUnconfirmed("approval-1")
        XCTAssertEqual(answered.apply(events[0]), [.reconcile])
        XCTAssertEqual(answered.pendingApproval?.approvalId, "approval-1")
        XCTAssertEqual(answered.state, .waitingForApproval)

        // The projection of a different run never absorbs these frames.
        var other = AidenForeignRunProjection(runId: "run-2")
        XCTAssertEqual(other.apply(events[1]), [])
        XCTAssertEqual(other.liveText, "")

        // Turn streams keep their sequence floor of 1, and run frames must
        // agree with their SSE id and event name.
        var turnParser = AidenSSEParser()
        XCTAssertThrowsError(try ["id: 0", "data: \(text)", ""].compactMap { try turnParser.consume(line: $0) }) {
            XCTAssertEqual($0 as? AidenSSEParserError, .invalidEventID)
        }
        XCTAssertThrowsError(try AidenRunSSEParser().consumeAll(["id: 2", "data: \(text)", ""])) {
            XCTAssertEqual($0 as? AidenSSEParserError, .eventIDMismatch)
        }
        XCTAssertThrowsError(try AidenRunSSEParser().consumeAll(["id: 1", "event: snapshot", "data: \(text)", ""])) {
            XCTAssertEqual($0 as? AidenSSEParserError, .eventNameMismatch)
        }
    }

    func testRunApprovalProjectionRejectsToolDetailsAndUnearnedScopes() throws {
        func frame(_ payload: String, type: String = "approval_required", terminal: Bool = false) -> Data {
            Data(#"{"protocolVersion":1,"streamId":"run-1","sequence":3,"timestamp":"2026-10-05T10:00:00Z","type":"\#(type)","terminal":\#(terminal),"payload":\#(payload)}"#.utf8)
        }
        XCTAssertNoThrow(try AidenRemoteJSONDecoder.decodeRunSSEEvent(from: frame(
            #"{"approvalId":"a1","summary":"Write?","toolName":"write_file","canAllow":false}"#
        )))
        // Tool arguments and host previews stay on the Mac.
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeRunSSEEvent(from: frame(
            #"{"approvalId":"a1","summary":"Write?","toolName":"write_file","canAllow":true,"details":{"path":"/etc/hosts"}}"#
        )))
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeRunSSEEvent(from: frame(
            #"{"approvalId":"a1","summary":"Write?","toolName":"write_file","canAllow":false,"scopes":["once"]}"#
        )))
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeRunSSEEvent(from: frame(
            #"{"runId":"run-1","chatId":"chat-1","state":"done"}"#, type: "run.ended", terminal: false
        )))
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeRunSSEEvent(from: frame(
            #"{"runId":"run-other","chatId":"chat-1","state":"done"}"#, type: "run.ended", terminal: true
        )))
        // Progress snapshots belong to the chat progress channel, never a run.
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeRunSSEEvent(from: frame(
            #"{"tasks":[]}"#, type: "task_update"
        )))
    }

    func testFirstResponderLoserEnvelopeNamesTheWinningAnswer() throws {
        func loser(status: Int, _ json: String) throws -> AidenForeignRunResolution? {
            let envelope = try AidenRemoteJSONDecoder.decode(AidenRemoteErrorEnvelope.self, from: Data(json.utf8))
            return AidenForeignRunResolution.loser(from: AidenRemoteClientError.server(statusCode: status, body: envelope.error))
        }
        let fixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: XCTUnwrap(sharedContractFixtureURL))
        )
        let fixtureError = try XCTUnwrap(fixture.runControlError?.error)
        let denied = try XCTUnwrap(AidenForeignRunResolution.loser(
            from: AidenRemoteClientError.server(statusCode: 409, body: fixtureError)
        ))
        XCTAssertEqual(denied.prompt, .approval(.deny))
        XCTAssertEqual(denied.notice, "Answered on Mac: denied")
        XCTAssertNotNil(denied.resolvedAt)

        let expired = try XCTUnwrap(loser(status: 409, #"{"error":{"code":"question_already_resolved","message":"Resolved.","requestId":"r1","retryable":false,"details":{"outcome":"expired","resolvedAt":"2026-10-05T10:00:00.000Z"}}}"#))
        XCTAssertEqual(expired.notice, "Question expired on Mac")
        XCTAssertNil(try loser(status: 403, #"{"error":{"code":"capability_denied","message":"No.","requestId":"r2","retryable":false}}"#))
        XCTAssertNil(AidenForeignRunResolution.loser(from: AidenRemoteClientError.invalidResponse))
    }

    // MARK: Contract revision 39: scheduled-task approval cards (`schedule:cards`)

    private func decodedSharedFixture() throws -> AidenRemoteContractFixture {
        try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: XCTUnwrap(sharedContractFixtureURL))
        )
    }

    private func scheduleCardsSection() throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(sharedContractFixtureURL)))
        return try XCTUnwrap((object as? [String: Any])?["scheduleCards"] as? [String: Any])
    }

    private func milliseconds(_ date: Date?) -> Int? {
        date.map { Int(($0.timeIntervalSince1970 * 1_000).rounded()) }
    }

    func testRevision39FixtureCardsDecodeAndRoundTripExactly() throws {
        let section = try XCTUnwrap(try decodedSharedFixture().scheduleCards)
        XCTAssertEqual(section.capability, .scheduleCards)
        let raw = try XCTUnwrap(try scheduleCardsSection()["cards"] as? [[String: Any]])
        XCTAssertFalse(raw.isEmpty)
        XCTAssertEqual(section.cards.map(\.label), raw.map { $0["label"] as? String })

        for (card, object) in zip(section.cards, raw) {
            let encoded = try JSONEncoder().encode(card.schedule)
            let reread = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? NSDictionary)
            XCTAssertEqual(reread, try XCTUnwrap(object["schedule"] as? NSDictionary), "\(card.label) keeps every key and value")
            XCTAssertEqual(
                try AidenRemoteJSONDecoder.decode(AidenApprovalSchedule.self, from: encoded),
                card.schedule,
                card.label
            )
        }

        let cards = Dictionary(uniqueKeysWithValues: section.cards.map { ($0.label, $0.schedule) })
        let briefing = try XCTUnwrap(cards["create-read-only-project"])
        XCTAssertEqual(briefing.action, .create)
        XCTAssertEqual(briefing.permission, .readOnly)
        XCTAssertEqual(briefing.workspaceName, "Aiden Agent")
        XCTAssertEqual(milliseconds(briefing.nextRun), 1_792_771_200_000, "2026-10-23T16:00:00.000Z")
        XCTAssertFalse(briefing.truncated)

        let audit = try XCTUnwrap(cards["scheduling-off"])
        XCTAssertEqual(audit.mode, .script)
        XCTAssertNil(audit.nextRunAt)
        XCTAssertNil(audit.prompt)
        XCTAssertNotNil(audit.script)
        XCTAssertFalse(audit.schedulerEnabled)

        let digest = try XCTUnwrap(cards["truncated-prompt"])
        XCTAssertTrue(digest.truncated)
        XCTAssertLessThanOrEqual(try XCTUnwrap(digest.prompt).utf16.count, 2_000)
    }

    /// Every card the host's validator rejects is dropped, and the approval it
    /// rides on still arrives with the same answer rights.
    func testRevision39RejectedCardsDropTheCardButNeverTheApproval() throws {
        let section = try scheduleCardsSection()
        let rejected = try XCTUnwrap(section["rejected"] as? [[String: Any]])
        XCTAssertFalse(rejected.isEmpty)
        let valid = try XCTUnwrap((section["cards"] as? [[String: Any]])?.first?["schedule"])
        let streamObject = try XCTUnwrap((section["streamApproval"] as? [String: Any])?["approval"] as? [String: Any])
        let runFrame = try XCTUnwrap((section["phoneRunEvents"] as? [[String: Any]])?.first {
            ($0["payload"] as? [String: Any])?["schedule"] != nil
        })
        let runPayload = try XCTUnwrap(runFrame["payload"] as? [String: Any])

        func streamApproval(carrying schedule: Any) throws -> AidenStreamPendingApproval {
            var approval = streamObject
            approval["schedule"] = schedule
            let data = try JSONSerialization.data(withJSONObject: ["approval": approval])
            return try XCTUnwrap(AidenRemoteJSONDecoder.decode(AidenStreamApprovalSnapshot.self, from: data).approval)
        }
        func runApproval(carrying schedule: Any) throws -> AidenRemoteRunApproval {
            var payload = runPayload
            payload["schedule"] = schedule
            var frame = runFrame
            frame["payload"] = payload
            let event = try AidenRemoteJSONDecoder.decodeRunSSEEvent(from: JSONSerialization.data(withJSONObject: frame))
            guard case let .approvalRequired(approval) = event.kind else {
                throw AidenRemoteContractError.unsafePayloadField("not an approval")
            }
            return approval
        }

        // The wrappers carry a valid card through.
        XCTAssertNotNil(try streamApproval(carrying: valid).schedule)
        XCTAssertNotNil(try runApproval(carrying: valid).schedule)

        for entry in rejected {
            let label = entry["label"] as? String ?? "unlabelled"
            let schedule = try XCTUnwrap(entry["schedule"], label)
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decode(
                    AidenApprovalSchedule.self,
                    from: JSONSerialization.data(withJSONObject: schedule)
                ),
                "\(label) is refused on its own"
            )

            let streamed = try streamApproval(carrying: schedule)
            XCTAssertNil(streamed.schedule, label)
            XCTAssertEqual(streamed.approvalId, streamObject["approvalId"] as? String, label)
            XCTAssertEqual(streamed.canAllow, streamObject["canAllow"] as? Bool, label)
            XCTAssertEqual(streamed.scopes, streamObject["scopes"] as? [String], label)

            let run = try runApproval(carrying: schedule)
            XCTAssertNil(run.schedule, label)
            XCTAssertEqual(run.approvalId, runPayload["approvalId"] as? String, label)
            XCTAssertEqual(run.canAllow, runPayload["canAllow"] as? Bool, label)
            XCTAssertEqual(run.scopes?.map(\.rawValue), runPayload["scopes"] as? [String], label)
        }
    }

    /// The phone reads a card exactly as the host's `parseAidenRemoteApprovalSchedule`
    /// does: lengths in UTF-16 units, JavaScript `trim()`, and `Date.parse`.
    func testRevision39CardValidationMirrorsTheHostValidator() throws {
        let section = try scheduleCardsSection()
        let base = try XCTUnwrap((section["cards"] as? [[String: Any]])?.first?["schedule"] as? [String: Any])
        func decodes(_ object: [String: Any]) -> Bool {
            guard let data = try? JSONSerialization.data(withJSONObject: object) else { return false }
            return (try? AidenRemoteJSONDecoder.decode(AidenApprovalSchedule.self, from: data)) != nil
        }
        func with(_ changes: [String: Any], dropping dropped: Set<String> = []) -> [String: Any] {
            base.merging(changes) { $1 }.filter { !dropped.contains($0.key) }
        }
        let calendarGlyph = "\u{1F4C5}" // two UTF-16 code units

        let accepted: [(String, [String: Any])] = [
            ("the fixture card", base),
            ("a 2,000-unit prompt", with(["prompt": String(repeating: "p", count: 2_000)])),
            ("a name of 60 two-unit characters", with(["name": String(repeating: calendarGlyph, count: 60)])),
            ("tabs and line breaks in a prompt", with(["prompt": "Step one\tthen\r\nstep two"])),
            ("only the required keys", with([:], dropping: ["nextRunAt", "workspaceName", "providerName", "modelName", "prompt"])),
            ("a script", with(["mode": "script", "script": "npm test"], dropping: ["prompt", "providerName", "modelName"])),
            ("a run now", with(["action": "run_now"])),
            ("a next run at 24:00", with(["nextRunAt": "2026-10-23T24:00:00Z"])),
            ("a next run with nine fraction digits", with(["nextRunAt": "2026-10-23T16:00:00.123456789Z"])),
            ("a truncated prompt", with(["truncated": true])),
        ]
        for (reason, object) in accepted {
            XCTAssertTrue(decodes(object), reason)
        }

        let refused: [(String, [String: Any])] = [
            ("a 2,001-unit prompt", with(["prompt": String(repeating: "p", count: 2_001)])),
            ("a name of 61 two-unit characters", with(["name": String(repeating: calendarGlyph, count: 61)])),
            ("a tab in a name", with(["name": "Morning\tbriefing"])),
            ("a leading no-break space", with(["name": "\u{00A0}Morning briefing"])),
            ("a trailing byte-order mark", with(["cadence": "Weekdays at 9:00 AM\u{FEFF}"])),
            ("a C1 control", with(["name": "Morning\u{0085}briefing"])),
            ("a bidirectional isolate", with(["name": "Morning \u{2066}briefing"])),
            ("a line separator in a prompt", with(["prompt": "One\u{2028}two"])),
            ("a blank time zone", with(["timezone": " "])),
            ("a null workspace", with(["workspaceName": NSNull()])),
            ("a null prompt", with(["prompt": NSNull()])),
            ("a numeric flag", with(["notify": 1])),
            ("a missing scheduler flag", with([:], dropping: ["schedulerEnabled"])),
            ("a missing connector list", with([:], dropping: ["connectors"])),
            ("a connector that is not text", with(["connectors": [1]])),
            ("an unknown action", with(["action": "archive"])),
            ("an unknown mode", with(["mode": "agent"])),
            ("a model on a script", with(["mode": "script", "script": "npm test"], dropping: ["prompt"])),
            ("truncated without content", with(["truncated": true], dropping: ["prompt"])),
            ("a next run on day 32", with(["nextRunAt": "2026-10-32T00:00:00Z"])),
            ("a next run in month 13", with(["nextRunAt": "2026-13-01T00:00:00Z"])),
            ("a next run at 24:00:01", with(["nextRunAt": "2026-10-23T24:00:01Z"])),
            ("a next run at 24:00 with a fraction", with(["nextRunAt": "2026-10-23T24:00:00.0001Z"])),
            ("a next run with ten fraction digits", with(["nextRunAt": "2026-10-23T16:00:00.1234567891Z"])),
            ("a next run without seconds", with(["nextRunAt": "2026-10-23T16:00Z"])),
        ]
        for (reason, object) in refused {
            XCTAssertFalse(decodes(object), reason)
        }

        // Instants read as JavaScript's `Date.parse` reads them.
        XCTAssertEqual(milliseconds(AidenApprovalSchedule.utcInstant("2026-02-30T00:00:00Z")), 1_772_409_600_000, "rolls into March 2")
        XCTAssertEqual(milliseconds(AidenApprovalSchedule.utcInstant("2026-10-23T24:00:00Z")), 1_792_800_000_000, "the next midnight")
        XCTAssertEqual(milliseconds(AidenApprovalSchedule.utcInstant("2026-10-23T16:00:00.123456789Z")), 1_792_771_200_123, "milliseconds kept, finer digits dropped")
        XCTAssertEqual(milliseconds(AidenApprovalSchedule.utcInstant("2026-02-29T12:00:00.5Z")), 1_772_366_400_500)
        XCTAssertEqual(milliseconds(AidenApprovalSchedule.utcInstant("0000-01-01T00:00:00Z")), -62_167_219_200_000)
        XCTAssertNil(AidenApprovalSchedule.utcInstant("2026-10-23T09:00:00+02:00"))
    }

    /// Only the `schedule_task` approval in the phone run carries a card; the
    /// automation approval keeps the summary card, and gap snapshots restate it.
    func testRevision39PhoneRunGivesACardToScheduledTaskApprovalsOnly() throws {
        let section = try XCTUnwrap(try decodedSharedFixture().scheduleCards)
        let events = section.phoneRunEvents
        let approvals = events.compactMap { event -> AidenRemoteRunApproval? in
            guard case let .approvalRequired(approval) = event.kind else { return nil }
            return approval
        }
        XCTAssertEqual(approvals.map(\.toolName), ["schedule_task", "edit_automation"])
        XCTAssertEqual(approvals.map { $0.schedule != nil }, [true, false])

        let runId = try XCTUnwrap(events.first?.runId)
        var projection = AidenForeignRunProjection(runId: runId)
        for event in events.prefix(2) { _ = projection.apply(event) }
        let scheduled = try XCTUnwrap(projection.pendingApproval)
        let card = try XCTUnwrap(scheduled.schedule)
        XCTAssertEqual(card.name, "Inbox triage")
        XCTAssertEqual(card.permission, .full)
        XCTAssertEqual(card.connectors, ["Gmail", "Linear"])
        XCTAssertTrue(scheduled.canAllow)
        XCTAssertEqual(scheduled.scopes, [.once, .chat])

        for event in events[2...3] { _ = projection.apply(event) }
        let automation = try XCTUnwrap(projection.pendingApproval)
        XCTAssertEqual(automation.toolName, "edit_automation")
        XCTAssertNil(automation.schedule)
        XCTAssertFalse(automation.canAllow)
        XCTAssertNil(automation.scopes)
        // Even a card on another tool is never shown.
        XCTAssertNil(AidenApprovalSchedule.card(card, toolName: "edit_automation"))
        XCTAssertEqual(AidenApprovalSchedule.card(card, toolName: "schedule_task"), card)

        // A gap snapshot restates the pending approval with its card.
        let cardJSON = try XCTUnwrap(String(data: JSONEncoder().encode(card), encoding: .utf8))
        let snapshot = #"{"protocolVersion":1,"streamId":"run-1","sequence":0,"timestamp":"2026-10-22T19:10:00Z","type":"snapshot","terminal":false,"payload":{"runId":"run-1","chatId":"chat-1","reason":"gap","epoch":"e1","state":"running","pendingApprovalIds":["approval-1"],"pendingQuestionIds":[],"approvals":[{"approvalId":"approval-1","summary":"Create scheduled task","toolName":"schedule_task","canAllow":true,"scopes":["once"],"schedule":\#(cardJSON)}],"questions":[],"nextSequence":1}}"#
        let frame = try AidenRemoteJSONDecoder.decodeRunSSEEvent(from: Data(snapshot.utf8))
        var restated = AidenForeignRunProjection(runId: "run-1")
        XCTAssertEqual(restated.apply(frame), [.reconcile])
        XCTAssertEqual(restated.pendingApproval?.schedule, card)
    }

    /// The stream approval's card reaches the pending approval the card renders,
    /// and never changes what the phone may allow.
    func testRevision39StreamApprovalCardReachesThePendingApprovalOnly() throws {
        let section = try XCTUnwrap(try decodedSharedFixture().scheduleCards)
        let wire = try XCTUnwrap(section.streamApproval.approval)
        let card = try XCTUnwrap(wire.schedule)
        XCTAssertEqual(card, section.cards.first { $0.label == "create-read-only-project" }?.schedule)

        let now = wire.expiresAt.addingTimeInterval(-60)
        func resolve(_ approval: AidenStreamPendingApproval) -> AidenPendingApproval? {
            AidenPendingApprovalResolution.resolve(approval, streamId: wire.streamId, chatId: wire.chatId, now: now)
        }
        let withCard = try XCTUnwrap(resolve(wire))
        XCTAssertEqual(withCard.kind, .scheduledTask)
        XCTAssertEqual(withCard.schedule, card)

        var bare = wire
        bare.schedule = nil
        let summaryOnly = try XCTUnwrap(resolve(bare))
        XCTAssertNil(summaryOnly.schedule)
        XCTAssertEqual(summaryOnly.summary, withCard.summary)
        XCTAssertEqual(summaryOnly.canAllow, withCard.canAllow)
        XCTAssertEqual(summaryOnly.scopes, withCard.scopes)

        let automation = AidenStreamPendingApproval(
            approvalId: wire.approvalId,
            streamId: wire.streamId,
            chatId: wire.chatId,
            summary: wire.summary,
            toolCallId: wire.toolCallId,
            toolName: "edit_automation",
            expiresAt: wire.expiresAt,
            canAllow: wire.canAllow,
            scopes: wire.scopes,
            schedule: card
        )
        XCTAssertNil(resolve(automation)?.schedule, "only schedule_task approvals show a card")
    }

    func testGenericAidenJSONDecodeHasOneMiBBodyCeiling() throws {
        let oversized = Data(repeating: 0x20, count: AidenRemoteProtocol.maxJSONBodyBytes + 1)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenRemoteContractFixture.Health.self, from: oversized)
        ) { error in
            XCTAssertEqual(error as? AidenRemoteContractError, .payloadTooLarge)
        }
    }

    func testSafeAidenDecoderRejectsDuplicateTerminalAndNestedEscapedKeys() throws {
        let duplicateTerminal = Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"heartbeat","terminal":false,"terminal":false,"payload":{}}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: duplicateTerminal))

        let escapedEquivalentPayloadKey = Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"text_delta","terminal":false,"payload":{"text":"first","\u0074ext":"second"}}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: escapedEquivalentPayloadKey))

        let escapedEquivalentNestedKey = Data(#"{"protocolVersion":1,"streamId":"stream-1","sequence":1,"timestamp":"2026-08-18T19:00:00Z","type":"future_progress","terminal":false,"payload":{"nested":{"key":1,"\u006Bey":2}}}"#.utf8)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decodeSSEEvent(from: escapedEquivalentNestedKey))
    }

    func testPhysicalDevicePinnedURLSessionWhenConfigured() async throws {
        try assertTransportLifecycleFixtures()
        let environment = ProcessInfo.processInfo.environment
        guard let bootstrapValue = environment["AIDEN_PHASE0_PAIRING_BOOTSTRAP"] else {
            throw XCTSkip("Set the Phase 0 pairing bootstrap JSON in the physical-device xctestrun file.")
        }
        let pairingPayload = try AidenRemoteJSONDecoder.decodePairingPayload(
            from: Data(bootstrapValue.utf8)
        ).validated()
        let bootstrap = pairingPayload.bootstrap
        let trustPolicy = try AidenServerTrustPolicy(pairingTrust: pairingPayload.trust)
        let endpoint = bootstrap.endpoint
        let host = try XCTUnwrap(endpoint.host)
        let healthEndpoint = endpoint.appendingPathComponent("health")
        XCTAssertEqual(bootstrap.protocolVersion, AidenRemoteProtocol.version)
        XCTAssertGreaterThanOrEqual(bootstrap.secret.count, 32)

        let delegate = AidenPinnedServerSessionDelegate(
            expectedHost: host,
            expectedPort: endpoint.port,
            expectedFingerprint: bootstrap.serverSpkiSha256,
            trustPolicy: trustPolicy
        )
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }

        if let expectedFailure = environment["AIDEN_PHASE0_EXPECTED_TRUST_FAILURE"] {
            XCTAssertEqual(expectedFailure, "hostname_or_certificate_invalid")
            do {
                _ = try await session.data(from: healthEndpoint)
                XCTFail("A URLSession connection with invalid hostname or certificate validity must fail.")
            } catch {
                XCTAssertEqual(delegate.lastTrustError, .hostnameOrCertificateInvalid)
            }
            return
        }

        let (data, response) = try await session.data(from: healthEndpoint)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let health = try AidenRemoteJSONDecoder.decode(AidenRemoteContractFixture.Health.self, from: data)
        XCTAssertTrue(health.ok)
        XCTAssertEqual(health.protocolVersion, AidenRemoteProtocol.version)

        let wrongPinDelegate = AidenPinnedServerSessionDelegate(
            expectedHost: host,
            expectedPort: endpoint.port,
            expectedFingerprint: environment["AIDEN_PHASE0_REJECTED_PIN"]
                ?? "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            trustPolicy: trustPolicy
        )
        let wrongPinSession = URLSession(
            configuration: .ephemeral,
            delegate: wrongPinDelegate,
            delegateQueue: nil
        )
        defer { wrongPinSession.invalidateAndCancel() }
        do {
            _ = try await wrongPinSession.data(from: healthEndpoint)
            XCTFail("A URLSession connection with a mismatched SPKI pin must fail.")
        } catch {
            XCTAssertEqual(wrongPinDelegate.lastTrustError, .publicKeyPinMismatch)
        }
    }
}

private extension AidenRunSSEParser {
    func consumeAll(_ lines: [String]) throws -> [AidenRemoteRunEvent] {
        var parser = self
        return try lines.compactMap { try parser.consume(line: $0) }
    }
}
