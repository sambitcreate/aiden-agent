import Foundation
import Observation

/// One long-lived connection per paired machine, whether or not it is the
/// selected one. Entries only appear and leave through `sync(with:)`, so the
/// saved installations stay the single record of who is paired.
@MainActor
@Observable
final class AidenHostRegistry {
    private(set) var connections: [String: AidenHostConnection] = [:]
    /// Given to every connection, so none of them is left unable to persist.
    @ObservationIgnored weak var delegate: (any AidenHostConnectionDelegate)? {
        didSet { connections.values.forEach { $0.delegate = delegate } }
    }

    @ObservationIgnored private let loadCredential: (String) throws -> String
    @ObservationIgnored private let clientFactory: AidenRemoteCoordinator.ClientFactory
    // Where the next connection's counters start. They stay above every
    // connection that has left, so a machine forgotten and paired again can't
    // reissue an old context or accept an answer from an old attempt.
    @ObservationIgnored private var firstGeneration = 0
    @ObservationIgnored private var firstHostGeneration = 0
    @ObservationIgnored private var firstConnectionGeneration = 0

    var ordered: [AidenHostConnection] {
        connections.values.sorted {
            ($0.installation.createdAt, $0.instanceId) < ($1.installation.createdAt, $1.instanceId)
        }
    }

    /// `credential` takes an instance ID and reads the saved record's credential.
    init(
        credential: @escaping (String) throws -> String,
        clientFactory: @escaping AidenRemoteCoordinator.ClientFactory
    ) {
        loadCredential = credential
        self.clientFactory = clientFactory
    }

    func connection(for instanceId: String) -> AidenHostConnection? {
        connections[instanceId]
    }

    /// Matches the entries to `installations`. A machine still paired keeps its
    /// connection, so nothing here touches its state or starts a connection.
    func sync(with installations: [AidenInstallation]) {
        for connection in connections.values
        where !installations.contains(where: { $0.id == connection.instanceId }) {
            retire(connection)
        }
        for installation in installations {
            if let connection = connections[installation.id] {
                connection.adopt(installation: installation)
            } else {
                connections[installation.id] = makeConnection(for: installation)
            }
        }
    }

    private func makeConnection(for installation: AidenInstallation) -> AidenHostConnection {
        let instanceId = installation.id
        let loadCredential = loadCredential
        let connection = AidenHostConnection(
            installation: installation,
            credential: { try loadCredential(instanceId) },
            clientFactory: clientFactory,
            generation: firstGeneration,
            hostGeneration: firstHostGeneration,
            connectionGeneration: firstConnectionGeneration
        )
        connection.delegate = delegate
        return connection
    }

    private func retire(_ connection: AidenHostConnection) {
        connections[connection.instanceId] = nil
        connection.disconnect()
        firstGeneration = max(firstGeneration, connection.generation &+ 1)
        firstHostGeneration = max(firstHostGeneration, connection.hostGeneration &+ 1)
        firstConnectionGeneration = max(firstConnectionGeneration, connection.connectionGeneration &+ 1)
    }
}
