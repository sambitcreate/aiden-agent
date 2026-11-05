import Foundation
import Observation

/// SF Symbols a phone user can pick for a machine.
enum AidenMachineSymbol: String, Codable, CaseIterable, Sendable {
    case desktop = "desktopcomputer", laptop = "laptopcomputer", mini = "macmini", studio = "macstudio"
    case server = "server.rack", home = "house", work = "briefcase", bolt, flask, moon, star, cloud
    case game = "gamecontroller"

    var systemName: String { rawValue }
}

/// Machine accent colours, in the order the store hands them out.
enum AidenMachineColor: String, Codable, CaseIterable, Sendable {
    case blue, teal, green, amber, orange, red, pink, purple, slate

    var hex: String {
        switch self {
        case .blue: "2F6FDE"
        case .teal: "0E8F8F"
        case .green: "2E8B57"
        case .amber: "B9770E"
        case .orange: "D2601A"
        case .red: "C93C3C"
        case .pink: "C2337F"
        case .purple: "7B4FD0"
        case .slate: "5A6070"
        }
    }
}

/// Phone-local presentation choices for one machine. Never sent to the machine.
struct AidenMachinePreferences: Codable, Equatable, Sendable {
    var nameOverride: String?
    var symbol: AidenMachineSymbol = .desktop
    var color: AidenMachineColor
    var isHidden = false
}

/// Phone-local machine name, symbol and colour, keyed by instance ID.
@MainActor
@Observable
final class AidenMachinePreferencesStore {
    private static let storageKey = "aiden.machine-preferences.v1"

    @ObservationIgnored private let defaults: UserDefaults
    private var stored: [String: AidenMachinePreferences]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode([String: AidenMachinePreferences].self, from: data) {
            stored = decoded
        } else {
            // Missing or corrupt: start empty. The next write replaces the blob.
            stored = [:]
        }
    }

    /// Returns the stored preferences. A machine seen for the first time is
    /// assigned the first colour no stored machine uses, wrapping to blue when
    /// all are used, and that assignment is persisted so it stays stable.
    func preferences(for instanceId: String) -> AidenMachinePreferences {
        if let existing = stored[instanceId] { return existing }
        let used = Set(stored.values.map(\.color))
        let color = AidenMachineColor.allCases.first { !used.contains($0) } ?? .blue
        let created = AidenMachinePreferences(color: color)
        stored[instanceId] = created
        persist()
        return created
    }

    func update(_ instanceId: String, _ change: (inout AidenMachinePreferences) -> Void) {
        var value = preferences(for: instanceId)
        change(&value)
        let trimmed = value.nameOverride?.trimmingCharacters(in: .whitespacesAndNewlines)
        value.nameOverride = (trimmed?.isEmpty ?? true) ? nil : trimmed
        stored[instanceId] = value
        persist()
    }

    func remove(_ instanceId: String) {
        guard stored.removeValue(forKey: instanceId) != nil else { return }
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(stored) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }
}
