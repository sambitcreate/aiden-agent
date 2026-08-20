import SwiftUI

@main
struct AidenOnTheGoApp: App {
    @State private var remoteCoordinator = AidenRemoteCoordinator()
    @State private var appearance = AidenAppearanceStore()

    var body: some Scene {
        WindowGroup {
            AidenAppearanceRoot(appearance: appearance) {
                ContentView(coordinator: remoteCoordinator)
            }
            .environment(appearance)
        }
    }
}
