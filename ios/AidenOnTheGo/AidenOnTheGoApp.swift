import SwiftUI

@main
struct AidenOnTheGoApp: App {
    @State private var haptics: AidenHapticCenter
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
        aidenBotImagePlaygroundCleanupAfterProcessLaunch()
        let haptics = AidenHapticCenter()
        let configuration = AidenBotFirstPrototypeConfiguration.current
        prototypeConfiguration = configuration
        _haptics = State(initialValue: haptics)
        _remoteCoordinator = State(
            initialValue: configuration == nil ? AidenRemoteCoordinator(haptics: haptics) : nil
        )
        _appearance = State(
            initialValue: configuration == nil ? AidenAppearanceStore() : nil
        )
    }
#else
    init() {
        aidenBotImagePlaygroundCleanupAfterProcessLaunch()
        let haptics = AidenHapticCenter()
        _haptics = State(initialValue: haptics)
        _remoteCoordinator = State(initialValue: AidenRemoteCoordinator(haptics: haptics))
    }
#endif

    var body: some Scene {
        WindowGroup {
            Group {
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
            .environment(haptics)
            .aidenHapticHost(haptics)
        }
    }
}
