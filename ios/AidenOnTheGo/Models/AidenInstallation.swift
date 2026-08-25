import Foundation
import Observation

struct AidenInstallation: Codable, Identifiable, Equatable, Sendable {
    let instanceId: String
    let deviceId: String
    var name: String
    let endpoint: URL
    let serverSpkiSha256: String
    let pairingTrust: AidenRemoteContractFixture.PairingTrust?
    let credentialScope: String
    /// Grants issued to this authenticated device during pairing. This value
    /// can narrow after an authenticated server refresh, but never widen.
    var deviceCapabilities: [AidenRemoteCapability]
    /// Explicit server support inventory. `nil` is a legacy/ambiguous state
    /// and intentionally disables Bots even if a legacy list mentioned Bots.
    var serverCapabilities: [AidenRemoteCapability]?
    let createdAt: Date
    var lastConnectedAt: Date?

    var id: String { instanceId }

    var isBotsEligible: Bool {
        hasNegotiatedAccess(to: .botRead)
    }

    var canWriteBots: Bool {
        isBotsEligible && hasNegotiatedAccess(to: .botWrite)
    }

    func hasNegotiatedAccess(to capability: AidenRemoteCapability) -> Bool {
        deviceCapabilities.contains(capability)
            && serverCapabilities?.contains(capability) == true
    }

    init(
        exchange: AidenRemoteContractFixture.PairingExchange,
        pairingTrust: AidenRemoteContractFixture.PairingTrust,
        name: String,
        createdAt: Date = Date(),
        lastConnectedAt: Date? = nil
    ) {
        instanceId = exchange.instanceId
        deviceId = exchange.deviceId
        self.name = name
        endpoint = exchange.endpoint
        serverSpkiSha256 = exchange.serverSpkiSha256
        self.pairingTrust = pairingTrust
        credentialScope = Self.makeCredentialScope(
            instanceId: exchange.instanceId,
            deviceId: exchange.deviceId
        )
        deviceCapabilities = exchange.capabilities
        serverCapabilities = nil
        self.createdAt = createdAt
        self.lastConnectedAt = lastConnectedAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        instanceId = try values.decode(String.self, forKey: .instanceId)
        deviceId = try values.decode(String.self, forKey: .deviceId)
        name = try values.decode(String.self, forKey: .name)
        endpoint = try values.decode(URL.self, forKey: .endpoint)
        serverSpkiSha256 = try values.decode(String.self, forKey: .serverSpkiSha256)
        pairingTrust = try values.decodeIfPresent(
            AidenRemoteContractFixture.PairingTrust.self,
            forKey: .pairingTrust
        )
        credentialScope = try values.decodeIfPresent(String.self, forKey: .credentialScope)
            ?? instanceId
        let hasExplicitDeviceCapabilities = values.contains(.deviceCapabilities)
        if hasExplicitDeviceCapabilities {
            deviceCapabilities = try values.decode(
                [AidenRemoteCapability].self,
                forKey: .deviceCapabilities
            )
        } else {
            let legacyCapabilities = try values.decode(
                [AidenRemoteCapability].self,
                forKey: .capabilities
            )
            // Older builds used one list for both pairing grants and server
            // support, and `/server` could overwrite it. Never migrate an
            // ambiguous Bot entry into authenticated device authority.
            deviceCapabilities = legacyCapabilities.filter { capability in
                capability != .botRead && capability != .botWrite
            }
        }
        if hasExplicitDeviceCapabilities, values.contains(.serverCapabilities) {
            serverCapabilities = try values.decode(
                [AidenRemoteCapability].self,
                forKey: .serverCapabilities
            )
        } else {
            serverCapabilities = nil
        }
        createdAt = try values.decode(Date.self, forKey: .createdAt)
        lastConnectedAt = try values.decodeIfPresent(Date.self, forKey: .lastConnectedAt)

        try Self.requireIdentifier(instanceId, forKey: .instanceId, in: values)
        try Self.requireIdentifier(deviceId, forKey: .deviceId, in: values)
        try Self.requireUniqueCapabilities(
            deviceCapabilities,
            forKey: .deviceCapabilities,
            in: values
        )
        if let serverCapabilities {
            try Self.requireUniqueCapabilities(
                serverCapabilities,
                forKey: .serverCapabilities,
                in: values
            )
            guard Set(deviceCapabilities).isSubset(of: Set(serverCapabilities)) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .serverCapabilities,
                    in: values,
                    debugDescription: "Persisted device grants must be a subset of server-supported capabilities."
                )
            }
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(instanceId, forKey: .instanceId)
        try values.encode(deviceId, forKey: .deviceId)
        try values.encode(name, forKey: .name)
        try values.encode(endpoint, forKey: .endpoint)
        try values.encode(serverSpkiSha256, forKey: .serverSpkiSha256)
        try values.encodeIfPresent(pairingTrust, forKey: .pairingTrust)
        try values.encode(credentialScope, forKey: .credentialScope)
        // Preserve the legacy alias for rollback readers while the explicit
        // key records that the grant/support split is authoritative.
        try values.encode(deviceCapabilities, forKey: .capabilities)
        try values.encode(deviceCapabilities, forKey: .deviceCapabilities)
        try values.encodeIfPresent(serverCapabilities, forKey: .serverCapabilities)
        try values.encode(createdAt, forKey: .createdAt)
        try values.encodeIfPresent(lastConnectedAt, forKey: .lastConnectedAt)
    }

    private enum CodingKeys: String, CodingKey {
        case instanceId, deviceId, name, endpoint, serverSpkiSha256, pairingTrust, credentialScope
        case capabilities, deviceCapabilities, serverCapabilities, createdAt, lastConnectedAt
    }

    private static func makeCredentialScope(instanceId: String, deviceId: String) -> String {
        "\(instanceId):\(deviceId)"
    }

    private static func requireIdentifier(
        _ value: String,
        forKey key: CodingKeys,
        in values: KeyedDecodingContainer<CodingKeys>
    ) throws {
        guard !value.isEmpty,
              value.unicodeScalars.count <= AidenRemoteProtocol.maxIdentifierLength else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: values,
                debugDescription: "Expected a non-empty bounded installation identity."
            )
        }
    }

    private static func requireUniqueCapabilities(
        _ capabilities: [AidenRemoteCapability],
        forKey key: CodingKeys,
        in values: KeyedDecodingContainer<CodingKeys>
    ) throws {
        guard Set(capabilities).count == capabilities.count,
              !capabilities.contains(.botWrite) || capabilities.contains(.botRead) else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: values,
                debugDescription: "Capability grants must be unique and bot:write requires bot:read."
            )
        }
    }
}

@MainActor
@Observable
final class AidenInstallationStore {
    private struct Snapshot: Codable {
        var installations: [AidenInstallation]
        var activeInstallationId: String?
    }

    private let keychain: any KeychainStoring
    private(set) var installations: [AidenInstallation]
    private(set) var activeInstallationId: String?

    var activeInstallation: AidenInstallation? {
        guard let activeInstallationId else { return nil }
        return installations.first { $0.id == activeInstallationId }
    }

    init(keychain: any KeychainStoring = KeychainStore()) {
        self.keychain = keychain
        let snapshot = Self.loadSnapshot(from: keychain)
        installations = snapshot.installations
        activeInstallationId = snapshot.activeInstallationId.flatMap { candidate in
            snapshot.installations.contains(where: { $0.id == candidate }) ? candidate : nil
        }
    }

    func credential(for installation: AidenInstallation) throws -> String? {
        try keychain.load(.remoteCredential, scope: installation.credentialScope)
    }

    func savePairing(
        _ exchange: AidenRemoteContractFixture.PairingExchange,
        trust: AidenRemoteContractFixture.PairingTrust,
        name: String,
        validatedServer: AidenServer? = nil,
        now: Date = Date(),
        connectedAt: Date? = nil
    ) throws -> AidenInstallation {
        let existing = installations.first { $0.id == exchange.instanceId }
        var installation = AidenInstallation(
            exchange: exchange,
            pairingTrust: trust,
            name: name,
            createdAt: existing?.createdAt ?? now,
            lastConnectedAt: connectedAt ?? existing?.lastConnectedAt
        )
        if let validatedServer {
            guard validatedServer.instanceId == exchange.instanceId else {
                throw AidenRemoteContractError.invalidPairingExchange
            }
            let refreshedDeviceGrants = Set(validatedServer.capabilities)
            installation.deviceCapabilities.removeAll {
                !refreshedDeviceGrants.contains($0)
            }
            installation.serverCapabilities = validatedServer.serverCapabilities
        }

        // The scoped credential write must succeed before the installation is
        // advertised as usable in the registry.
        try keychain.save(
            exchange.credential,
            forKey: .remoteCredential,
            scope: installation.credentialScope
        )

        var updated = installations.filter { $0.id != installation.id }
        updated.append(installation)
        updated.sort(by: Self.sortInstallations)

        let previousInstallations = installations
        let previousActiveId = activeInstallationId
        installations = updated
        activeInstallationId = installation.id
        do {
            try persist()
        } catch {
            installations = previousInstallations
            activeInstallationId = previousActiveId
            try? keychain.delete(.remoteCredential, scope: installation.credentialScope)
            throw error
        }
        if let existing, existing.credentialScope != installation.credentialScope {
            try? keychain.delete(.remoteCredential, scope: existing.credentialScope)
        }
        return installation
    }

    func setActive(_ installationId: String) throws {
        guard installations.contains(where: { $0.id == installationId }) else { return }
        guard activeInstallationId != installationId else { return }
        let previous = activeInstallationId
        activeInstallationId = installationId
        do {
            try persist()
        } catch {
            activeInstallationId = previous
            throw error
        }
    }

    func updateServer(_ server: AidenServer, connectedAt: Date = Date()) throws {
        guard let index = installations.firstIndex(where: { $0.id == server.instanceId }) else { return }
        let previousInstallations = installations
        installations[index].name = server.name
        let refreshedDeviceGrants = Set(server.capabilities)
        installations[index].deviceCapabilities.removeAll {
            !refreshedDeviceGrants.contains($0)
        }
        installations[index].serverCapabilities = server.serverCapabilities
        installations[index].lastConnectedAt = connectedAt
        installations.sort(by: Self.sortInstallations)
        do {
            try persist()
        } catch {
            installations = previousInstallations
            throw error
        }
    }

    private static func sortInstallations(
        _ lhs: AidenInstallation,
        _ rhs: AidenInstallation
    ) -> Bool {
        if lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedSame {
            return lhs.id < rhs.id
        }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }

    func remove(_ installationId: String) throws {
        guard installations.contains(where: { $0.id == installationId }) else { return }
        let previousInstallations = installations
        let previousActiveId = activeInstallationId
        installations.removeAll { $0.id == installationId }
        if activeInstallationId == installationId {
            activeInstallationId = installations.first?.id
        }
        do {
            try persist()
        } catch {
            installations = previousInstallations
            activeInstallationId = previousActiveId
            throw error
        }
        if let removed = previousInstallations.first(where: { $0.id == installationId }) {
            try? keychain.delete(.remoteCredential, scope: removed.credentialScope)
        }
    }

    private func persist() throws {
        let snapshot = Snapshot(
            installations: installations,
            activeInstallationId: activeInstallationId
        )
        let data = try JSONEncoder().encode(snapshot)
        guard let value = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileWriteInapplicableStringEncoding)
        }
        try keychain.save(value, forKey: .remoteInstallations)
    }

    private static func loadSnapshot(from keychain: any KeychainStoring) -> Snapshot {
        guard let value = try? keychain.load(.remoteInstallations),
              let data = value.data(using: .utf8),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            return Snapshot(installations: [], activeInstallationId: nil)
        }

        var seen = Set<String>()
        let installations = snapshot.installations.filter { installation in
            !installation.instanceId.isEmpty && seen.insert(installation.instanceId).inserted
        }
        return Snapshot(
            installations: installations,
            activeInstallationId: snapshot.activeInstallationId
        )
    }
}
