import UIKit

/// Routes Home Screen Quick Actions (`UIApplicationShortcutItem`) delivered by
/// SpringBoard into `AidenHomeActionDispatch`. Only recognized static shortcut
/// types are accepted; unknown items fail closed and return `false`.
@MainActor
enum AidenQuickActionHandler {
    @discardableResult
    static func handle(
        _ shortcutItem: UIApplicationShortcutItem,
        dispatch: @MainActor (AidenHomeAction) -> Void = { AidenHomeActionDispatch.dispatch($0) }
    ) -> Bool {
        guard let action = AidenHomeAction(shortcutItemType: shortcutItem.type) else {
            return false
        }
        dispatch(action)
        return true
    }
}

/// Bridges UIKit scene configuration into the SwiftUI app lifecycle so Home
/// Screen Quick Actions are received on both cold launch and warm resume.
final class AidenAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(
            name: nil,
            sessionRole: connectingSceneSession.role
        )
        if connectingSceneSession.role == .windowApplication {
            configuration.delegateClass = AidenSceneDelegate.self
        }
        return configuration
    }
}

final class AidenSceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        if let shortcutItem = connectionOptions.shortcutItem {
            _ = AidenQuickActionHandler.handle(shortcutItem)
        }
    }

    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(AidenQuickActionHandler.handle(shortcutItem))
    }
}
