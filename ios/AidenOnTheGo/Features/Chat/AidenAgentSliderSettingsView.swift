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
    /// The computer `catalog` came from.
    @State private var loadedInstanceId: String?

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
                    Text("New chats start on the stop or model you last chose in a new chat on this phone, or else on the model you last used on your computer. Reset to home returns a chat to the home stop. Change the stops on your computer in Settings → Models & Context → Agent Slider.")
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
                // Skeleton stops while the computer answers, not a spinner.
                Section {
                    ForEach(0..<3, id: \.self) { _ in
                        AidenAgentSliderSkeletonRow()
                            .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 12))
                            .listRowBackground(palette.raised)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Loading the Agent Slider")
                .accessibilityIdentifier("aiden.settings.agentSlider.loading")
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
            // Try again keeps the stops on screen while it reloads; only
            // another computer's slider starts from the skeleton.
            let instanceId = coordinator.server?.instanceId
            if loadedInstanceId != instanceId { catalog = nil }
            loadedInstanceId = instanceId
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

/// A stop row's shape while the stops load: the place glyph, the name and
/// the detail line, as soft bars.
private struct AidenAgentSliderSkeletonRow: View {
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            Capsule()
                .fill(palette.foreground.opacity(0.08))
                .frame(width: AidenAgentSliderPlaceGlyph.width, height: 8)
            VStack(alignment: .leading, spacing: 6) {
                Capsule().fill(palette.foreground.opacity(0.1)).frame(width: 96, height: 12)
                Capsule().fill(palette.foreground.opacity(0.06)).frame(width: 168, height: 10)
            }
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 52)
    }
}
