import SwiftUI

/// Settings → Agent Slider: the paired computer's stops, read-only. The
/// slider is edited on the computer (Settings → Models & Context → Agent
/// Slider); here each stop shows its model and effort, why it can't run, and
/// which one is home.
struct AidenAgentSliderSettingsView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Environment(\.aidenPalette) private var palette
    @State private var catalog: AidenModelCatalog?
    @State private var errorMessage: String?
    /// Each Try again reloads once; a newer one cancels the one before.
    @State private var attempt = 0

    private struct LoadKey: Hashable {
        let instanceId: String?
        let attempt: Int
    }

    var body: some View {
        List {
            if let catalog, let slider = catalog.agentSlider {
                let views = AidenAgentSliderResolver.views(for: slider, catalog: catalog)
                let home = AidenAgentSliderResolver.homeStopIndex(slider)
                Section {
                    ForEach(Array(views.enumerated()), id: \.element.id) { index, view in
                        // Read-only: home is marked with its glyph, and no
                        // row is the chat's stop here.
                        AidenAgentSliderStopRow(
                            view: view,
                            index: index,
                            count: views.count,
                            isCurrent: false,
                            isHome: index == home
                        )
                        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 12))
                        .listRowBackground(palette.raised)
                        .accessibilityIdentifier("aiden.settings.agentSlider.stop.\(view.id)")
                    }
                } footer: {
                    Text("New chats start on the stop you last chose on this phone, or else on the model you last used on your computer. Reset to home returns a chat to the home stop. Change the stops on your computer in Settings → Models & Context → Agent Slider.")
                        .foregroundStyle(palette.secondary)
                }
            } else if let catalog {
                Section {
                    Text(catalog.agentSliderUnreadable
                        ? "This version of Aiden can't read your computer's Agent Slider. Update Aiden on this phone to use it."
                        : "Your computer hasn't set up the Agent Slider. Set it up there in Settings → Models & Context → Agent Slider.")
                        .foregroundStyle(palette.secondary)
                        .listRowBackground(palette.raised)
                }
            } else if errorMessage == nil {
                Section {
                    ProgressView("Loading the Agent Slider")
                        .listRowBackground(palette.raised)
                }
            }
            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(palette.danger)
                    Button("Try again", systemImage: "arrow.clockwise") { attempt += 1 }
                        .foregroundStyle(palette.foreground)
                }
                .listRowBackground(palette.raised)
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas.ignoresSafeArea())
        .navigationTitle("Agent Slider")
        .task(id: LoadKey(instanceId: coordinator.server?.instanceId, attempt: attempt)) {
            catalog = nil
            errorMessage = nil
            await load()
        }
    }

    private func load() async {
        guard let context = try? coordinator.requestContext() else {
            errorMessage = String(localized: "Connect to your paired computer.")
            return
        }
        do {
            let value = try await coordinator.remoteClient(for: context).modelCatalog()
            guard coordinator.isCurrent(context), !Task.isCancelled else { return }
            catalog = value
            errorMessage = nil
        } catch {
            guard coordinator.isCurrent(context), !Task.isCancelled else { return }
            errorMessage = String(localized: "Couldn't load the Agent Slider from your computer.")
        }
    }
}
