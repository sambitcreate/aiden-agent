import SwiftUI

@main
struct AidenOnTheGoApp: App {
    @State private var remoteCoordinator: AidenRemoteCoordinator
    @State private var appearance = AidenAppearanceStore()
    @State private var haptics: AidenHapticCenter

    init() {
        let haptics = AidenHapticCenter()
        _haptics = State(initialValue: haptics)
        _remoteCoordinator = State(initialValue: AidenRemoteCoordinator(haptics: haptics))
    }

    var body: some Scene {
        WindowGroup {
            AidenAppearanceRoot(appearance: appearance) {
                ContentView(coordinator: remoteCoordinator)
            }
            .environment(appearance)
            .environment(haptics)
            .aidenHapticHost(haptics)
        }
    }
}
