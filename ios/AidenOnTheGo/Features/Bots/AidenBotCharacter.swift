import SwiftUI

// MARK: - Character

enum AidenBotCharacter {
    /// Matches the desktop's `DEFAULT_BOT_AVATAR` in renderer/shared/bots.ts.
    static let defaultRecipe = AidenBotAvatarRecipe(
        shape: .wisp,
        color: .lilac,
        eyes: .dots,
        detail: .sparkles
    )
}

/// Local edits to a Bot's colour and shape. The wire recipe still carries the
/// legacy eye and detail fields; they stay at their defaults and are not shown.
struct AidenBotCharacterDraft: Equatable {
    private(set) var recipe: AidenBotAvatarRecipe

    init(avatar: AidenBotSemanticAvatar) {
        switch avatar {
        case let .recipe(recipe):
            self.recipe = recipe
        case .legacy:
            let presentation = aidenBotAvatarPresentation(avatar)
            recipe = AidenBotAvatarRecipe(
                shape: presentation.shape,
                color: presentation.color,
                eyes: AidenBotCharacter.defaultRecipe.eyes,
                detail: AidenBotCharacter.defaultRecipe.detail
            )
        }
    }

    var color: AidenBotAvatarColor { recipe.color }
    var shape: AidenBotAvatarShape { recipe.shape }

    /// True when Reset would not change how the Bot looks.
    var isDefault: Bool {
        recipe.shape == AidenBotCharacter.defaultRecipe.shape
            && recipe.color == AidenBotCharacter.defaultRecipe.color
    }

    mutating func select(color: AidenBotAvatarColor) {
        recipe = AidenBotAvatarRecipe(shape: recipe.shape, color: color, eyes: recipe.eyes, detail: recipe.detail)
    }

    mutating func select(shape: AidenBotAvatarShape) {
        recipe = AidenBotAvatarRecipe(shape: shape, color: recipe.color, eyes: recipe.eyes, detail: recipe.detail)
    }

    mutating func reset() {
        recipe = AidenBotCharacter.defaultRecipe
    }

    /// The identity change to send, or nil when the Bot already looks like this.
    func identityPatch(comparedTo detail: AidenBotDetail) throws -> AidenBotIdentityPatch? {
        let next = AidenBotSemanticAvatar.recipe(recipe)
        guard next != detail.avatar.semantic else { return nil }
        return try AidenBotIdentityPatch(avatar: next)
    }
}

/// Colour swatches, shape choices, and Reset. Changes apply as soon as they
/// are tapped; `onChange` receives the updated draft.
struct AidenBotCharacterCard: View {
    let draft: AidenBotCharacterDraft
    let isEnabled: Bool
    let onChange: (AidenBotCharacterDraft) -> Void

    @Environment(\.aidenPalette) private var palette

    private let colorColumns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 6)
    private let shapeColumns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 8)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            LazyVGrid(columns: colorColumns, spacing: 14) {
                ForEach(AidenBotAvatarColor.allCases, id: \.self) { color in
                    Button {
                        var next = draft
                        next.select(color: color)
                        onChange(next)
                    } label: {
                        Circle()
                            .fill(color.swatch)
                            .frame(width: 34, height: 34)
                            .padding(4)
                            .background {
                                if draft.color == color {
                                    Circle().fill(palette.foreground.opacity(0.12))
                                }
                            }
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(color.displayName)
                    .accessibilityAddTraits(draft.color == color ? .isSelected : [])
                }
            }
            .padding(16)

            Divider().padding(.leading, 16)

            LazyVGrid(columns: shapeColumns, spacing: 8) {
                ForEach(AidenBotAvatarShape.allCases, id: \.self) { shape in
                    Button {
                        var next = draft
                        next.select(shape: shape)
                        onChange(next)
                    } label: {
                        AidenBotShapeSwatch(shape: shape, color: draft.color.swatch, size: 28)
                            .padding(6)
                            .background {
                                if draft.shape == shape {
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .fill(palette.foreground.opacity(0.12))
                                }
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(shape.displayName)
                    .accessibilityAddTraits(draft.shape == shape ? .isSelected : [])
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 14)

            Divider().padding(.leading, 16)

            Button("Reset to default") {
                var next = draft
                next.reset()
                onChange(next)
            }
            .disabled(draft.isDefault)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .disabled(!isEnabled)
    }
}

// MARK: - Delete

enum AidenBotDeletion {
    /// Hosts advertise this feature when `DELETE /bots/{id}` permanently
    /// deletes a Bot. Without it, phones do not offer Delete.
    static let hostFeature = "bot-delete-v1"

    static func isAvailable(
        hostFeatures: [String]?,
        canWriteBots: Bool,
        isConnected: Bool
    ) -> Bool {
        canWriteBots && isConnected && hostFeatures?.contains(hostFeature) == true
    }

    @MainActor
    static func isAvailable(coordinator: AidenRemoteCoordinator) -> Bool {
        isAvailable(
            hostFeatures: coordinator.server?.features,
            canWriteBots: coordinator.installationStore.activeInstallation?.canWriteBots == true,
            isConnected: coordinator.connectionState == .connected
        )
    }

    /// Deletes the Bot on the paired Mac and forgets its photo on this phone.
    /// Until the host's delete revision lands (Task 5.2), the route is the
    /// existing `DELETE /bots/{id}`; Delete stays hidden unless advertised.
    @MainActor
    static func delete(
        botID: String,
        revision: String,
        coordinator: AidenRemoteCoordinator
    ) async throws {
        let context = try coordinator.requestContext()
        let result: AidenBotDetail
        do {
            result = try await coordinator.remoteClient(for: context).archiveBot(id: botID, revision: revision)
        } catch {
            _ = await coordinator.handleCredentialRevocation(error, context: context)
            throw error
        }
        guard coordinator.isCurrent(context) else { return }
        _ = await coordinator.withRetainedInstallationData(for: context) {
            _ = try? await AidenBotCache.shared.upsertDetailAndStore(
                result,
                instanceId: context.instanceId,
                deviceId: context.deviceId
            )
            await AidenBotCache.shared.removeAvatars(
                instanceId: context.instanceId,
                deviceId: context.deviceId,
                botId: botID
            )
        }
    }
}

/// The exact confirmation copy shared with desktop and Android.
struct AidenBotDeleteConfirmation: Equatable {
    let title: String
    let message: String
    let confirmTitle = "Delete Bot"

    init(botName: String) {
        let name = botName.trimmingCharacters(in: .whitespacesAndNewlines)
        title = "Delete \(name)?"
        message = "This permanently erases \(name)'s chat, memory, instructions, routines, files, and photo. This can't be undone."
    }
}

extension View {
    /// Asks before deleting a Bot, using the shared confirmation copy.
    func aidenBotDeleteConfirmation(
        isPresented: Binding<Bool>,
        botName: String,
        onConfirm: @escaping () -> Void
    ) -> some View {
        let copy = AidenBotDeleteConfirmation(botName: botName)
        return alert(copy.title, isPresented: isPresented) {
            Button(copy.confirmTitle, role: .destructive, action: onConfirm)
            Button("Cancel", role: .cancel) { }
        } message: {
            Text(copy.message)
        }
    }
}
