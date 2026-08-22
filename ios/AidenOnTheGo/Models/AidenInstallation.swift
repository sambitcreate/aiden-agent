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
    var capabilities: [AidenRemoteCapability]
    let createdAt: Date
    var lastConnectedAt: Date?

    var id: String { instanceId }

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
        capabilities = exchange.capabilities
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
        capabilities = try values.decode([AidenRemoteCapability].self, forKey: .capabilities)
        createdAt = try values.decode(Date.self, forKey: .createdAt)
        lastConnectedAt = try values.decodeIfPresent(Date.self, forKey: .lastConnectedAt)
    }

    private enum CodingKeys: String, CodingKey {
        case instanceId, deviceId, name, endpoint, serverSpkiSha256, pairingTrust, credentialScope
        case capabilities, createdAt, lastConnectedAt
    }

    private static func makeCredentialScope(instanceId: String, deviceId: String) -> String {
        "\(instanceId):\(deviceId)"
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
        now: Date = Date(),
        connectedAt: Date? = nil
    ) throws -> AidenInstallation {
        let existing = installations.first { $0.id == exchange.instanceId }
        let installation = AidenInstallation(
            exchange: exchange,
            pairingTrust: trust,
            name: name,
            createdAt: existing?.createdAt ?? now,
            lastConnectedAt: connectedAt ?? existing?.lastConnectedAt
        )

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
        installations[index].capabilities = server.capabilities
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
