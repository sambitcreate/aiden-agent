import SwiftUI

/// The empty Bots home on a host advertising `bot-presets-v1`: a paged
/// carousel of starter Bots, `Start Chat`, and `Create My Own`.
struct AidenBotMeetFirstBotView: View {
    let presets: [AidenBotPreset]
    let isBusy: Bool
    let canCreate: Bool
    let onStartChat: (AidenBotPreset) -> Void
    let onCreateOwn: () -> Void

    @Environment(\.aidenPalette) private var palette
    @State private var selection: String?

    private var current: AidenBotPreset? {
        presets.first { $0.id == selection } ?? presets.first
    }

    var body: some View {
        VStack(spacing: 18) {
            Text("Meet Your First Bot")
                .font(.title2.bold())
                .foregroundStyle(palette.foreground)
                .accessibilityAddTraits(.isHeader)
            ScrollView(.horizontal) {
                LazyHStack(spacing: 14) {
                    ForEach(presets) { preset in
                        card(preset)
                            .containerRelativeFrame(.horizontal, count: 1, spacing: 14)
                            .id(preset.id)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $selection)
            .scrollIndicators(.hidden)
            .contentMargins(.horizontal, 28, for: .scrollContent)
            .frame(height: 280)

            VStack(spacing: 10) {
                Button {
                    if let current { onStartChat(current) }
                } label: {
                    Text("Start Chat")
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(palette.accent)
                .foregroundStyle(palette.onAccent)
                .disabled(isBusy || !canCreate || current == nil)

                Button(action: onCreateOwn) {
                    Text("Create My Own")
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .disabled(isBusy || !canCreate)
            }
            .padding(.horizontal, 28)
        }
        .padding(.top, 28)
    }

    private func card(_ preset: AidenBotPreset) -> some View {
        VStack(spacing: 12) {
            AidenBotSemanticAvatarView(avatar: .recipe(preset.avatar), name: preset.name, size: 84)
            Text(preset.name)
                .font(.title3.weight(.semibold))
                .foregroundStyle(palette.foreground)
            Text(preset.subtitle)
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
            if !preset.suggestedConnections.isEmpty {
                HStack(spacing: 8) {
                    ForEach(preset.suggestedConnections) { chip in
                        Image(systemName: aidenBotConnectionSymbol(iconId: chip.iconId))
                            .font(.footnote)
                            .foregroundStyle(palette.foreground)
                            .frame(width: 30, height: 30)
                            .background(palette.canvas, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .accessibilityLabel(chip.name)
                    }
                }
            }
            if let routine = preset.suggestedRoutine {
                Label(routine.label, systemImage: "clock")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}
