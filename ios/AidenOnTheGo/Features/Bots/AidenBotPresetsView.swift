import SwiftUI

/// The empty Bots home on a host advertising `bot-presets-v1`: a paged
/// carousel of starter Bots, `Start Chat`, and `Create My Own`.
struct AidenBotMeetFirstBotView: View {
    let presets: [AidenBotPreset]
    let isBusy: Bool
    let canCreate: Bool
    let onStartChat: (AidenBotPreset) -> Void
    /// Revision 61: Open for a template that already made a Bot.
    var onOpen: (String) -> Void = { _ in }
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
                    if let existing = current?.template?.existingBotId {
                        onOpen(existing)
                    } else if let current {
                        onStartChat(current)
                    }
                } label: {
                    Text(current?.template?.existingBotId == nil ? "Start Chat" : "Open")
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .aidenSolidFillTint()
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
            if let template = preset.template {
                Text("Version \(template.version)")
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Revision 61 (`bot:templates`): the Mac's templates as a list, each with its
/// version and a sample of what it says. A template that already made a Bot
/// opens that Bot instead of making another.
struct AidenBotTemplatesView: View {
    let presets: [AidenBotPreset]
    let isBusy: Bool
    let canCreate: Bool
    let onUse: (AidenBotPreset) -> Void
    let onOpen: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette

    var body: some View {
        NavigationStack {
            List(presets) { preset in
                row(preset)
                    .listRowBackground(palette.raised)
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas)
            .navigationTitle("Templates")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private func row(_ preset: AidenBotPreset) -> some View {
        HStack(alignment: .top, spacing: 12) {
            AidenBotSemanticAvatarView(avatar: .recipe(preset.avatar), name: preset.name, size: 44)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(preset.name)
                        .font(.headline)
                        .foregroundStyle(palette.foreground)
                    if let template = preset.template {
                        Text("Version \(template.version)")
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                    }
                }
                Text(preset.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let sample = preset.template?.sample.first {
                    Text("“\(sample)”")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(2)
                }
                if let existing = preset.template?.existingBotId {
                    Button("Open") { onOpen(existing) }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .padding(.top, 4)
                } else {
                    Button("Use Template") { onUse(preset) }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .aidenSolidFillTint()
                        .disabled(isBusy || !canCreate)
                        .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
    }
}
