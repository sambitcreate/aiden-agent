import SwiftUI
import UIKit
import UserNotifications

/// Settings → Notifications: the iOS permission, which run alerts this iPhone
/// posts, and how much of a chat's words reach the Lock Screen.
struct AidenNotificationSettingsView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AidenNotificationPreferences.defaultsKey) private var stored = Data()
    @State private var permission: AidenNotificationPermissionRow?

    private var preferences: AidenNotificationPreferences {
        (try? JSONDecoder().decode(AidenNotificationPreferences.self, from: stored)) ?? AidenNotificationPreferences()
    }

    private func binding(_ keyPath: WritableKeyPath<AidenNotificationPreferences, Bool>) -> Binding<Bool> {
        Binding(
            get: { preferences[keyPath: keyPath] },
            set: { newValue in
                var updated = preferences
                updated[keyPath: keyPath] = newValue
                if let data = try? JSONEncoder().encode(updated) { stored = data }
            }
        )
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Allow notifications") {
                    switch permission {
                    case .on:
                        Text("On")
                    case .off(canAsk: true):
                        Button("Turn on") { Task { await turnOn() } }
                    case .off(canAsk: false):
                        Button("Open Settings") { openSettings() }
                    case nil:
                        ProgressView()
                    }
                }
            } footer: {
                if case .off = permission {
                    Text("Aiden can’t alert you about chats until notifications are on for this iPhone.")
                }
            }

            Section {
                Toggle("Needs my approval or answer", isOn: binding(\.needsAnswer))
                Toggle("A response is ready", isOn: binding(\.responseReady))
                Toggle("A response fails", isOn: binding(\.runFailed))
                Toggle("A Bot hands me a step", isOn: binding(\.botNeedsMe))
            } header: {
                Text("Tell me when")
            } footer: {
                Text("Alerts come while you’re away from a chat and the app is still connected to your computer.")
            }

            Section {
                Toggle("Show message text in alerts", isOn: binding(\.showMessageText))
                Toggle("Show reply text on Lock Screen", isOn: binding(\.replyTextOnLockScreen))
                Toggle("Quiet for the open chat", isOn: binding(\.quietInOpenChat))
            } header: {
                Text("Privacy")
            } footer: {
                Text("Message text shows the approval or question in an alert. Reply text adds the end of a reply to the Live Activity. Quiet for the open chat skips alerts for the chat you’re looking at. Message text and replies stay on this iPhone.")
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: scenePhase) {
            if scenePhase == .active { await refreshPermission() }
        }
    }

    private func refreshPermission() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        permission = AidenNotificationPermissionRow.state(for: status)
    }

    private func turnOn() async {
        UserDefaults.standard.set(true, forKey: AidenRunAlertNotifier.permissionRequestedKey)
        _ = await UNUserNotificationCenter.current().requestAlertAuthorization()
        await refreshPermission()
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        openURL(url)
    }
}
