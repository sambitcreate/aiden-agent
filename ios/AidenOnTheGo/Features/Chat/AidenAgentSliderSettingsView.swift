import SwiftUI

/// Settings → Agent Slider: the paired computer's stops, read-only. The
/// slider is edited on the computer (Settings → Models & Context → Agent
/// Slider); here each stop shows its model and effort, why it can't run, and
/// which one is home.
struct AidenAgentSliderSettingsView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @State private var catalog: AidenModelCatalog?
    @State private var errorMessage: String?

    var body: some View {
        List {
            if let catalog, let slider = catalog.agentSlider {
                let views = AidenAgentSliderResolver.views(for: slider, catalog: catalog)
                let home = AidenAgentSliderResolver.homeStopIndex(slider)
                Section {
                    ForEach(Array(views.enumerated()), id: \.element.id) { index, view in
                        AidenAgentSliderStopRow(
                            view: view,
                            index: index,
                            count: views.count,
                            isCurrent: index == home,
                            isHome: index == home
                        )
                        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 12))
                        .accessibilityIdentifier("aiden.settings.agentSlider.stop.\(view.id)")
                    }
                } footer: {
                    Text("New chats start on the home stop. Change the stops on your paired computer in Settings → Models & Context → Agent Slider.")
                }
            } else if catalog != nil {
                Section {
                    Text("Your paired computer hasn't set up the Agent Slider. Set it up there in Settings → Models & Context → Agent Slider.")
                        .foregroundStyle(.secondary)
                }
            } else if errorMessage == nil {
                Section { ProgressView("Loading the Agent Slider") }
            }
            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                    Button("Try again", systemImage: "arrow.clockwise") { Task { await load() } }
                }
            }
        }
        .navigationTitle("Agent Slider")
        .task(id: coordinator.server?.instanceId) { catalog = nil; errorMessage = nil; await load() }
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
            errorMessage = String(localized: "The Agent Slider is unavailable. Try again.")
        }
    }
}
