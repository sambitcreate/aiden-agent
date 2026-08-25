import CryptoKit
import Foundation
import Security
import XCTest
@testable import AidenOnTheGo

final class AidenRemotePhase0Tests: XCTestCase {
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

        XCTAssertEqual(fixture.contractRevision, 9)
        XCTAssertEqual(fixture.protocolVersion, AidenRemoteProtocol.version)
        XCTAssertTrue(fixture.health.ok)
        XCTAssertEqual(fixture.health.protocolVersion, AidenRemoteProtocol.version)
        XCTAssertEqual(Set(fixture.capabilities), Set(AidenRemoteCapability.v1Known))
        XCTAssertEqual(Set(fixture.events.map(\.type)), Set(AidenRemoteEventType.v1Known))
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
        for event in fixture.events {
            XCTAssertFalse(terminalStreams.contains(event.streamId))
            XCTAssertEqual(event.sequence, (lastSequence[event.streamId] ?? 0) + 1)
            lastSequence[event.streamId] = event.sequence
            if event.terminal { terminalStreams.insert(event.streamId) }
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
        ])

        func inspect(_ value: Any) throws {
            if let dictionary = value as? [String: Any] {
                XCTAssertTrue(forbidden.isDisjoint(with: dictionary.keys))
                for child in dictionary.values { try inspect(child) }
            } else if let array = value as? [Any] {
                for child in array { try inspect(child) }
            } else if let string = value as? String {
                XCTAssertFalse(string.contains("/Users/"))
                XCTAssertFalse(string.contains("BEGIN PRIVATE KEY"))
            }
        }
        try inspect(object)
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
