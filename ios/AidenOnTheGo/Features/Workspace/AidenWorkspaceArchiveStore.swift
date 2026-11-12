import SwiftUI

@MainActor
@Observable
final class AidenWorkspaceArchiveStore {
    private struct Snapshot: Codable {
        var workspaceIDsByInstance: [String: [String]]
    }

    private static let snapshotKey = "aiden.deviceArchivedWorkspaces.v1"
    private static let disclosureKey = "aiden.deviceArchivedWorkspaces.disclosureSeen.v1"

    @ObservationIgnored private let defaults: UserDefaults
    private var workspaceIDsByInstance: [String: Set<String>]
    private(set) var hasAcknowledgedDeviceOnlyArchive: Bool

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        hasAcknowledgedDeviceOnlyArchive = defaults.bool(forKey: Self.disclosureKey)

        if let data = defaults.data(forKey: Self.snapshotKey),
           let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) {
            workspaceIDsByInstance = snapshot.workspaceIDsByInstance.reduce(into: [:]) { result, entry in
                result[entry.key] = Set(entry.value.filter { !$0.isEmpty })
            }
        } else {
            workspaceIDsByInstance = [:]
        }
    }

    func archivedWorkspaceIDs(for instanceID: String?) -> Set<String> {
        guard let instanceID, !instanceID.isEmpty else { return [] }
        return workspaceIDsByInstance[instanceID] ?? []
    }

    func isArchived(workspaceID: String, instanceID: String?) -> Bool {
        archivedWorkspaceIDs(for: instanceID).contains(workspaceID)
    }

    func acknowledgeDeviceOnlyArchive() {
        guard !hasAcknowledgedDeviceOnlyArchive else { return }
        hasAcknowledgedDeviceOnlyArchive = true
        defaults.set(true, forKey: Self.disclosureKey)
    }

    func archive(workspaceID: String, instanceID: String?) {
        guard let instanceID, !instanceID.isEmpty, !workspaceID.isEmpty else { return }
        var workspaceIDs = workspaceIDsByInstance[instanceID] ?? []
        guard workspaceIDs.insert(workspaceID).inserted else { return }
        workspaceIDsByInstance[instanceID] = workspaceIDs
        persist()
    }

    func unarchive(workspaceID: String, instanceID: String?) {
        guard let instanceID, !instanceID.isEmpty,
              var workspaceIDs = workspaceIDsByInstance[instanceID],
              workspaceIDs.remove(workspaceID) != nil else { return }
        if workspaceIDs.isEmpty {
            workspaceIDsByInstance.removeValue(forKey: instanceID)
        } else {
            workspaceIDsByInstance[instanceID] = workspaceIDs
        }
        persist()
    }

    func forget(workspaceID: String, instanceID: String?) {
        unarchive(workspaceID: workspaceID, instanceID: instanceID)
    }

    func purge(instanceID: String) {
        guard workspaceIDsByInstance.removeValue(forKey: instanceID) != nil else { return }
        persist()
    }

    func prune(instanceID: String?, validWorkspaceIDs: Set<String>) {
        guard let instanceID, !instanceID.isEmpty,
              let current = workspaceIDsByInstance[instanceID] else { return }
        let pruned = current.intersection(validWorkspaceIDs)
        guard pruned != current else { return }
        if pruned.isEmpty {
            workspaceIDsByInstance.removeValue(forKey: instanceID)
        } else {
            workspaceIDsByInstance[instanceID] = pruned
        }
        persist()
    }

    private func persist() {
        let snapshot = Snapshot(
            workspaceIDsByInstance: workspaceIDsByInstance.mapValues { $0.sorted() }
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: Self.snapshotKey)
    }
}
