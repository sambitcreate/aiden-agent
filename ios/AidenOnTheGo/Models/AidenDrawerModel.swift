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
    /// A pinned Bot's own avatar, drawn as the Bots list draws it. Nil for a workspace.
    var botAvatar: AidenBotAvatarView? = nil
    /// A pinned Bot that needs the person, by the Inbox's rule (`AidenBotAttention`).
    var needsYou = false

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

    /// Forgets a pin whose Bot or workspace was deleted.
    func remove(_ pin: AidenDrawerPin) {
        guard let index = pins.firstIndex(of: pin) else { return }
        pins.remove(at: index)
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
            switch pin.kind {
            case .bot:
                guard let bot = snapshot.bots.first(where: { $0.id == pin.id.objectId }) else { return nil }
                return AidenDrawerPinnedItem(
                    pin: pin,
                    name: bot.name,
                    isOnline: snapshot.isOnline,
                    botAvatar: bot.avatar,
                    needsYou: AidenBotAttention.needsYou(bot)
                )
            case .workspace:
                guard let name = snapshot.workspaceNames[pin.id.objectId] else { return nil }
                return AidenDrawerPinnedItem(pin: pin, name: name, isOnline: snapshot.isOnline)
            }
        }
    }
}

/// Where the drawer and the screen it pushes aside sit while it opens. At
/// compact width the drawer lies under the screen at the leading edge and the
/// screen slides toward the trailing edge, keeping a slice in view; beside the
/// list it lays over the content instead. `progress` runs from 0 (shut) to 1
/// (open). Pure numbers, so a swipe, the menu button and Reduce Motion share them.
enum AidenDrawerGeometry {
    /// Concept 03: a 330pt column on a 402pt screen.
    static let conceptRatio: CGFloat = 330.0 / 402.0
    /// Wider than this and the column is mostly empty space (a large phone in landscape).
    static let maximumWidth: CGFloat = 360
    /// The pushed screen's slice: room enough to see it and to tap it closed.
    static let minimumSlice: CGFloat = 56

    /// The drawer's column in a window `container` points wide, in whole
    /// points. Its leading `leadingInset` points (a phone held sideways, the
    /// camera's side) are outside the column: the drawer's colour fills them
    /// but nothing sits there.
    static func width(in container: CGFloat, leadingInset: CGFloat = 0) -> CGFloat {
        let usable = container - max(0, leadingInset)
        guard usable > 0 else { return 0 }
        let proportional = (usable * conceptRatio).rounded()
        return max(0, min(proportional, maximumWidth, usable - minimumSlice))
    }

    /// How far the pushed screen travels to show the whole drawer: the column
    /// and the inset before it, measured from the window's leading edge.
    static func travel(in container: CGFloat, leadingInset: CGFloat = 0) -> CGFloat {
        let column = width(in: container, leadingInset: leadingInset)
        return column > 0 ? column + max(0, leadingInset) : 0
    }

    /// How open a drag leaves the drawer: `start` plus its horizontal travel on
    /// the screen, `translation` points, toward the trailing edge. On a
    /// right-to-left screen the drawer sits at the right, so opening is a drag
    /// to the left.
    static func progress(start: CGFloat, translation: CGFloat, width: CGFloat, rightToLeft: Bool) -> CGFloat {
        guard width > 0 else { return start > 0.5 ? 1 : 0 }
        let towardTrailing = rightToLeft ? -translation : translation
        return min(1, max(0, start + towardTrailing / width))
    }

    /// Whether a drag let go at `progress`, moving `velocity` points a second
    /// on the screen, settles open. A flick decides by its direction; a slow
    /// release by where the drawer would coast to.
    static func settlesOpen(progress: CGFloat, velocity: CGFloat, width: CGFloat, rightToLeft: Bool) -> Bool {
        let towardTrailing = rightToLeft ? -velocity : velocity
        if abs(towardTrailing) >= flickVelocity { return towardTrailing > 0 }
        guard width > 0 else { return progress >= 0.5 }
        let coasted = progress + towardTrailing * coastTime / width
        return coasted >= 0.5
    }

    /// Points a second past which a release is a flick.
    static let flickVelocity: CGFloat = 600
    /// How far ahead a slow release is projected, in seconds.
    static let coastTime: CGFloat = 0.15

    /// How far the pushed screen has moved toward the trailing edge, in layout
    /// coordinates (SwiftUI mirrors them on a right-to-left screen), for a full
    /// `travel`. Reduce Motion keeps it in place: the drawer fades in over it instead.
    static func contentOffset(progress: CGFloat, travel: CGFloat, reduceMotion: Bool) -> CGFloat {
        reduceMotion ? 0 : travel * min(1, max(0, progress))
    }

    /// The drawer's own lag behind the screen as it slides: it starts a little
    /// under the leading edge and catches up, so it reads as lying beneath.
    static func drawerOffset(progress: CGFloat, width: CGFloat, reduceMotion: Bool) -> CGFloat {
        reduceMotion ? 0 : -(1 - min(1, max(0, progress))) * width * parallax
    }

    /// The share of the column the drawer trails by when shut.
    static let parallax: CGFloat = 0.25
}
