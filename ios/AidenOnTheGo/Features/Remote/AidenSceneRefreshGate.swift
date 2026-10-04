import SwiftUI

/// Decides when a scene-phase change should refetch remote state.
///
/// `.inactive` is transient and frequent: Control Center, Notification
/// Center, the app switcher, system alerts, and Face ID prompts all pass
/// through it while the app stays on screen and its streams stay open.
/// Refetching on every `.inactive` to `.active` bounce repeated the full
/// reconnect or chat reload for no new information. Only a return from
/// `.background`, where streams are suspended and state can go stale,
/// requires a refresh.
struct AidenSceneRefreshGate: Equatable {
    enum Action: Equatable {
        /// Refetch, then resume live observation.
        case refresh
        /// Resume live observation without refetching.
        case resume
        /// Suspend live observation; the next activation refreshes.
        case suspend
        /// Transient phase; leave everything running.
        case none
    }

    private(set) var needsRefresh: Bool

    /// `refreshOnFirstActivation` is false when the caller already loads on
    /// appear, and true when the first `.active` transition performs the load.
    init(refreshOnFirstActivation: Bool) {
        needsRefresh = refreshOnFirstActivation
    }

    mutating func transition(to phase: ScenePhase) -> Action {
        switch phase {
        case .background:
            needsRefresh = true
            return .suspend
        case .active:
            guard needsRefresh else { return .resume }
            needsRefresh = false
            return .refresh
        default:
            return .none
        }
    }
}
