import Foundation
import Observation

/// A Bot or workspace the person pinned to the drawer. Device-local: pins are
/// never sent to a machine, and they are not the Inbox's chat pins.
struct AidenDrawerPin: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable {
        case bot
        case workspace
    }

    let kind: Kind
    /// Host-scoped, because two machines can hold the same Bot or workspace id.
    let id: AidenHostObjectID

    var route: AidenAppRoute {
        switch kind {
        case .bot: .bot(id)
        case .workspace: .workspace(id)
        }
    }
}

/// A pin the drawer can show right now, named from its own machine.
struct AidenDrawerPinnedItem: Identifiable, Equatable, Sendable {
    let pin: AidenDrawerPin
    let name: String
    /// False for a machine that is offline; the pin stays, marked offline.
    let isOnline: Bool

    var id: AidenDrawerPin { pin }
}

/// The drawer's pins, in the order they were pinned, kept in this device's
/// preferences. A pin whose Bot or workspace isn't listed right now is kept
/// and hidden (`AidenDrawerPinned.items`), so a machine that is offline or
/// still loading doesn't lose its pins. Unpairing a machine purges them.
@MainActor @Observable
final class AidenDrawerPinsStore {
    static let shared = AidenDrawerPinsStore()
    static let key = "aiden.drawer-pins.v1"

    private(set) var pins: [AidenDrawerPin]
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.key),
           let saved = try? JSONDecoder().decode([AidenDrawerPin].self, from: data) {
            var seen = Set<AidenDrawerPin>()
            pins = saved.filter { seen.insert($0).inserted }
        } else {
            pins = []
        }
    }

    func isPinned(_ pin: AidenDrawerPin) -> Bool {
        pins.contains(pin)
    }

    /// Pins at the end, or unpins.
    func toggle(_ pin: AidenDrawerPin) {
        if let index = pins.firstIndex(of: pin) {
            pins.remove(at: index)
        } else {
            pins.append(pin)
        }
        save()
    }

    /// Forgets every pin on a machine that was unpaired.
    func purge(instanceID: String) {
        let kept = pins.filter { $0.id.instanceId != instanceID }
        guard kept != pins else { return }
        pins = kept
        save()
    }

    private func save() {
        if pins.isEmpty {
            defaults.removeObject(forKey: Self.key)
        } else if let data = try? JSONEncoder().encode(pins) {
            defaults.set(data, forKey: Self.key)
        }
    }
}

enum AidenDrawerPinned {
    /// The pins to show, in pin order, each named from its own machine's
    /// snapshot. A pin on a machine that is blocked, hidden or not listed, or
    /// whose Bot or workspace that machine doesn't list, is left out.
    static func items(
        pins: [AidenDrawerPin],
        snapshots: [AidenHostInboxSnapshot],
        hiddenMachines: Set<String>
    ) -> [AidenDrawerPinnedItem] {
        pins.compactMap { pin in
            guard !hiddenMachines.contains(pin.id.instanceId),
                  let snapshot = snapshots.first(where: {
                      $0.instanceId == pin.id.instanceId && $0.deviceId == pin.id.deviceId
                  }),
                  !snapshot.isBlocked
            else { return nil }
            let name: String?
            switch pin.kind {
            case .bot: name = snapshot.bots.first { $0.id == pin.id.objectId }?.name
            case .workspace: name = snapshot.workspaceNames[pin.id.objectId]
            }
            guard let name else { return nil }
            return AidenDrawerPinnedItem(pin: pin, name: name, isOnline: snapshot.isOnline)
        }
    }
}
