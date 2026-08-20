import Foundation
import Observation

struct AidenInstallation: Codable, Identifiable, Equatable, Sendable {
    let instanceId: String
    let deviceId: String
    var name: String
    let endpoint: URL
    let serverSpkiSha256: String
    let pairingTrust: AidenRemoteContractFixture.PairingTrust?
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
        capabilities = try values.decode([AidenRemoteCapability].self, forKey: .capabilities)
        createdAt = try values.decode(Date.self, forKey: .createdAt)
        lastConnectedAt = try values.decodeIfPresent(Date.self, forKey: .lastConnectedAt)
    }

    private enum CodingKeys: String, CodingKey {
        case instanceId, deviceId, name, endpoint, serverSpkiSha256, pairingTrust
        case capabilities, createdAt, lastConnectedAt
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
        try keychain.load(.remoteCredential, scope: installation.instanceId)
    }

    func savePairing(
        _ exchange: AidenRemoteContractFixture.PairingExchange,
        trust: AidenRemoteContractFixture.PairingTrust,
        name: String,
        now: Date = Date()
    ) throws -> AidenInstallation {
        let existing = installations.first { $0.id == exchange.instanceId }
        let installation = AidenInstallation(
            exchange: exchange,
            pairingTrust: trust,
            name: name,
            createdAt: existing?.createdAt ?? now,
            lastConnectedAt: now
        )

        // The scoped credential write must succeed before the installation is
        // advertised as usable in the registry.
        let previousCredential = try keychain.load(.remoteCredential, scope: exchange.instanceId)
        try keychain.save(exchange.credential, forKey: .remoteCredential, scope: exchange.instanceId)

        var updated = installations.filter { $0.id != installation.id }
        updated.append(installation)
        updated.sort { lhs, rhs in
            if lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedSame {
                return lhs.id < rhs.id
            }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }

        let previousInstallations = installations
        let previousActiveId = activeInstallationId
        installations = updated
        activeInstallationId = installation.id
        do {
            try persist()
        } catch {
            installations = previousInstallations
            activeInstallationId = previousActiveId
            if let previousCredential {
                try? keychain.save(previousCredential, forKey: .remoteCredential, scope: exchange.instanceId)
            } else {
                try? keychain.delete(.remoteCredential, scope: exchange.instanceId)
            }
            throw error
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
        let previous = installations[index]
        installations[index].name = server.name
        installations[index].capabilities = server.capabilities
        installations[index].lastConnectedAt = connectedAt
        do {
            try persist()
        } catch {
            installations[index] = previous
            throw error
        }
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
            try keychain.delete(.remoteCredential, scope: installationId)
        } catch {
            installations = previousInstallations
            activeInstallationId = previousActiveId
            try? persist()
            throw error
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
