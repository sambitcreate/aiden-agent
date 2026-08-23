import SwiftUI

@main
struct AidenOnTheGoApp: App {
#if DEBUG
    @State private var remoteCoordinator: AidenRemoteCoordinator?
    @State private var appearance: AidenAppearanceStore?
    private let prototypeConfiguration: AidenBotFirstPrototypeConfiguration?
#else
    @State private var remoteCoordinator = AidenRemoteCoordinator()
    @State private var appearance = AidenAppearanceStore()
#endif

#if DEBUG
    init() {
        let configuration = AidenBotFirstPrototypeConfiguration.current
        prototypeConfiguration = configuration
        _remoteCoordinator = State(
            initialValue: configuration == nil ? AidenRemoteCoordinator() : nil
        )
        _appearance = State(
            initialValue: configuration == nil ? AidenAppearanceStore() : nil
        )
    }
#endif

    var body: some Scene {
        WindowGroup {
#if DEBUG
            if let prototypeConfiguration {
                AidenBotFirstPrototypeLaunchView(configuration: prototypeConfiguration)
            } else if let remoteCoordinator, let appearance {
                AidenAppearanceRoot(appearance: appearance) {
                    ContentView(coordinator: remoteCoordinator)
                }
                .environment(appearance)
            }
#else
            AidenAppearanceRoot(appearance: appearance) {
                ContentView(coordinator: remoteCoordinator)
            }
            .environment(appearance)
#endif
        }
    }
}
