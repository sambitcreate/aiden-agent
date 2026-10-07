import PhotosUI
import SwiftUI

private struct AidenBotProfileSkeletonView: View {
    let reduceMotion: Bool

    var body: some View {
        VStack(spacing: 18) {
            AidenBotSkeletonBlock(width: 112, height: 112, radius: 56, reduceMotion: reduceMotion)
            AidenBotSkeletonBlock(width: nil, height: 110, radius: 20, reduceMotion: reduceMotion)
            AidenBotSkeletonBlock(width: nil, height: 210, radius: 20, reduceMotion: reduceMotion)
            AidenBotSkeletonBlock(width: nil, height: 56, radius: 20, reduceMotion: reduceMotion)
        }
        .padding(.horizontal, 20)
        .padding(.top, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading Bot")
    }
}

private enum AidenBotProfileField: Hashable {
    case name
    case subtitle
}

/// A Bot's one settings page: photo, name, subtitle, character, and
/// instructions. Everything else sits behind ••• → Advanced.
struct AidenBotProfileView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let initialSummary: AidenBotSummary
    var onChanged: () -> Void = { }
    /// Called after the Bot is deleted, so the caller can leave its chat.
    var onDeleted: () -> Void = { }
    var showsDismissButton = true

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @State private var detail: AidenBotDetail?
    @State private var capturedContext: AidenRemoteRequestContext?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var mutationError: String?
    @State private var isSaving = false
    @State private var isDeleting = false
    @State private var loadGeneration: UInt = 0
    @State private var nameText = ""
    @State private var subtitleText = ""
    @State private var character: AidenBotCharacterDraft?
    @State private var avatarModel: AidenBotGeneratedAvatarModel?
    @State private var photoItem: PhotosPickerItem?
    @State private var isShowingImagePlayground = false
    @State private var isConfirmingPhotoRemoval = false
    @State private var isConfirmingDelete = false
    @State private var isShowingAdvanced = false
    @FocusState private var focusedField: AidenBotProfileField?

    private var botID: String { initialSummary.id }

    private var sessionIdentity: AidenBotCustomAccessSessionIdentity {
        AidenBotCustomAccessSessionIdentity(coordinator: coordinator)
    }

    private var canWrite: Bool {
        capturedContext.map(coordinator.isCurrent) == true
            && coordinator.connectionState == .connected
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
            && !isSaving
            && !isDeleting
    }

    private var canDelete: Bool {
        AidenBotDeletion.isAvailable(coordinator: coordinator) && detail != nil && !isDeleting
    }

    var body: some View {
        NavigationStack {
            content
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if showsDismissButton {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { dismiss() }
                                .disabled(isSaving || isDeleting)
                        }
                    }
                    if detail != nil {
                        ToolbarItem(placement: .primaryAction) {
                            moreMenu
                        }
                    }
                }
                .navigationDestination(isPresented: $isShowingAdvanced) {
                    AidenBotAdvancedView(coordinator: coordinator, botID: botID) { updated in
                        apply(updated)
                        onChanged()
                    }
                }
        }
        .interactiveDismissDisabled(isSaving || isDeleting || avatarModel?.isBusy == true)
        .task(id: sessionIdentity) {
            let expectedSession = sessionIdentity
            reset(for: expectedSession)
            await load(for: expectedSession)
        }
        .task(id: avatarModel?.sessionIdentity) {
            await avatarModel?.sessionDidChangeAndRefresh()
        }
        .onChange(of: sessionIdentity) { oldValue, newValue in
            if showsDismissButton, capturedContext != nil, oldValue != newValue { dismiss() }
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            photoItem = nil
            Task { await ingestPhoto(item) }
        }
        .onChange(of: focusedField) { oldValue, _ in
            if let oldValue { Task { await commit(oldValue) } }
        }
        .aidenBotImagePlaygroundSheet(
            isPresented: $isShowingImagePlayground,
            identity: .init(name: detail?.name ?? initialSummary.name, purpose: detail?.purpose ?? "")
        ) { copiedURL in
            Task { await avatarModel?.ingestCopiedCandidate(at: copiedURL) }
        } onCopyFailed: {
            mutationError = AidenBotImagePlaygroundFallbackReason.candidateCopyFailed.message
        }
        .aidenBotDeleteConfirmation(
            isPresented: $isConfirmingDelete,
            botName: detail?.name ?? initialSummary.name
        ) {
            Task { await deleteBot() }
        }
        .confirmationDialog("Remove photo?", isPresented: $isConfirmingPhotoRemoval, titleVisibility: .visible) {
            Button("Remove Photo", role: .destructive) {
                Task { await avatarModel?.revertToSemanticAvatar() }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("The Bot goes back to its character.")
        }
        .alert(
            "Something Went Wrong",
            isPresented: Binding(
                get: { mutationError != nil },
                set: { if !$0 { mutationError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { mutationError = nil }
        } message: {
            Text(mutationError ?? "Please try again.")
        }
    }

    @ViewBuilder
    private var content: some View {
        if let detail {
            profile(detail)
        } else if isLoading {
            AidenBotProfileSkeletonView(reduceMotion: reduceMotion)
        } else {
            ContentUnavailableView {
                Label("Couldn’t Load Bot", systemImage: "exclamationmark.bubble")
            } description: {
                Text(loadError ?? "Connect to your Mac, then try again.")
            } actions: {
                Button("Try Again") {
                    let expectedSession = sessionIdentity
                    Task { await load(for: expectedSession) }
                }
            }
        }
    }

    private var moreMenu: some View {
        Menu {
            Button("Advanced", systemImage: "slider.horizontal.3") {
                isShowingAdvanced = true
            }
            if canDelete {
                Button("Delete Bot", systemImage: "trash", role: .destructive) {
                    isConfirmingDelete = true
                }
            }
        } label: {
            Image(systemName: AidenChromeSymbols.overflowMenu)
        }
        .disabled(isDeleting)
        .accessibilityLabel("More")
    }

    private func profile(_ detail: AidenBotDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let loadError {
                    Label(loadError, systemImage: "wifi.slash")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                        .padding(.horizontal, 4)
                }
                avatarHeader(detail)
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, 12)
                identityCard
                    .padding(.bottom, 16)

                sectionLabel("Character")
                if let character {
                    AidenBotCharacterCard(draft: character, isEnabled: canWrite) { next in
                        Task { await saveCharacter(next) }
                    }
                }
                Text("How this Bot looks everywhere")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)

                instructionsRow(detail)

                if AidenBotHostFeature.isAdvertised(AidenBotHostFeature.routines, coordinator: coordinator) {
                    AidenBotRoutinesSection(coordinator: coordinator, botID: detail.id, canWrite: canWrite)
                        .padding(.top, 16)
                }
            }
            .frame(maxWidth: 640)
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.canvas.ignoresSafeArea())
        .refreshable {
            let expectedSession = sessionIdentity
            await load(for: expectedSession)
        }
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title)
            .font(.subheadline)
            .foregroundStyle(palette.secondary)
            .padding(.horizontal, 16)
    }

    private func avatarHeader(_ detail: AidenBotDetail) -> some View {
        VStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                if let image = avatarModel?.candidateImage {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 112, height: 112)
                        .clipShape(Circle())
                        .accessibilityLabel("New photo preview")
                } else {
                    AidenBotCanonicalAvatarView(
                        coordinator: coordinator,
                        botID: detail.id,
                        avatar: detail.avatar,
                        name: detail.name,
                        size: 112,
                        isDecorative: false
                    )
                }
                photoMenu(detail)
            }
            if avatarModel?.isBusy == true {
                ProgressView()
            }
            if avatarModel?.hasCandidate == true {
                HStack(spacing: 12) {
                    Button("Cancel") { avatarModel?.cancelCandidate() }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                    Button("Use This Photo") {
                        Task { await avatarModel?.useCandidate() }
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(palette.accent)
                    .foregroundStyle(palette.onAccent)
                    .disabled(avatarModel?.canUseCandidate != true)
                }
            }
            if let message = avatarModel?.errorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(palette.danger)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private func photoMenu(_ detail: AidenBotDetail) -> some View {
        AidenBotImagePlaygroundSupportReader { canGenerate in
            Menu {
                PhotosPicker(selection: $photoItem, matching: .images, photoLibrary: .shared()) {
                    Label("Choose Photo", systemImage: "photo.on.rectangle")
                }
                if canGenerate {
                    Button("Generate", systemImage: "sparkles") {
                        isShowingImagePlayground = true
                    }
                }
                if detail.avatar.asset != nil {
                    Button("Remove Photo", systemImage: "trash", role: .destructive) {
                        isConfirmingPhotoRemoval = true
                    }
                }
            } label: {
                Image(systemName: AidenChromeSymbols.overflowMenu)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.foreground)
                    .frame(width: 36, height: 36)
                    .background(palette.raised, in: Circle())
                    .contentShape(Circle())
            }
            .disabled(!canWrite || avatarModel == nil || avatarModel?.isBusy == true)
            .accessibilityLabel("Photo options")
        }
    }

    private var identityCard: some View {
        VStack(spacing: 0) {
            TextField("Name", text: $nameText)
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
                .focused($focusedField, equals: .name)
                .submitLabel(.done)
                .onSubmit { focusedField = nil }
                .padding(.vertical, 16)
                .padding(.horizontal, 16)
                .accessibilityLabel("Name")
            Divider().padding(.leading, 16)
            TextField("What it helps with", text: $subtitleText)
                .multilineTextAlignment(.center)
                .foregroundStyle(palette.secondary)
                .focused($focusedField, equals: .subtitle)
                .submitLabel(.done)
                .onSubmit { focusedField = nil }
                .padding(.vertical, 14)
                .padding(.horizontal, 16)
                .accessibilityLabel("Subtitle")
        }
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .disabled(!canWrite)
    }

    private func instructionsRow(_ detail: AidenBotDetail) -> some View {
        NavigationLink {
            AidenBotInstructionsEditorView(initialText: detail.instructions, canSave: canWrite) { text in
                await saveInstructions(text)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "doc.text")
                    .foregroundStyle(palette.secondary)
                    .accessibilityHidden(true)
                Text("Instructions")
                    .foregroundStyle(palette.foreground)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .accessibilityHidden(true)
            }
            .padding(16)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Loading

    @MainActor
    private func reset(for expectedSession: AidenBotCustomAccessSessionIdentity) {
        guard sessionIdentity == expectedSession else { return }
        loadGeneration &+= 1
        detail = nil
        capturedContext = nil
        isLoading = true
        loadError = nil
        mutationError = nil
        isSaving = false
        character = nil
        avatarModel?.clearForDismissal()
        avatarModel = nil
    }

    @MainActor
    private func apply(_ loaded: AidenBotDetail) {
        detail = loaded
        if focusedField != .name { nameText = loaded.name }
        if focusedField != .subtitle { subtitleText = loaded.purpose }
        character = AidenBotCharacterDraft(avatar: loaded.avatar.semantic)
    }

    @MainActor
    private func load(for expectedSession: AidenBotCustomAccessSessionIdentity) async {
        guard sessionIdentity == expectedSession, !isSaving else { return }
        loadGeneration &+= 1
        let generation = loadGeneration
        isLoading = true
        var requestContext: AidenRemoteRequestContext?
        do {
            let context = try coordinator.requestContext()
            requestContext = context
            guard isCurrentLoad(generation, session: expectedSession, context: context) else { return }
            if detail == nil,
               let cached = await AidenBotCache.shared.load(instanceId: context.instanceId, deviceId: context.deviceId),
               let cachedDetail = cached.details.first(where: { $0.id == botID }),
               isCurrentLoad(generation, session: expectedSession, context: context) {
                apply(cachedDetail)
                isLoading = false
            }
            let loaded = try await coordinator.remoteClient(for: context).bot(id: botID)
            guard isCurrentLoad(generation, session: expectedSession, context: context),
                  loaded.id == botID, !Task.isCancelled else { return }
            apply(loaded)
            capturedContext = context
            loadError = nil
            if avatarModel == nil {
                avatarModel = AidenBotGeneratedAvatarModel(coordinator: coordinator, botID: botID) { updated in
                    apply(updated)
                    onChanged()
                }
            }
            _ = await coordinator.withRetainedInstallationData(for: context) {
                _ = try? await AidenBotCache.shared.upsertDetailAndStore(
                    loaded,
                    instanceId: context.instanceId,
                    deviceId: context.deviceId
                )
            }
            isLoading = false
        } catch is CancellationError {
            return
        } catch {
            if let context = requestContext,
               await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard loadGeneration == generation, sessionIdentity == expectedSession else { return }
            capturedContext = nil
            loadError = detail == nil ? error.localizedDescription : "Offline — showing saved details"
            isLoading = false
        }
    }

    @MainActor
    private func isCurrentLoad(
        _ generation: UInt,
        session: AidenBotCustomAccessSessionIdentity,
        context: AidenRemoteRequestContext
    ) -> Bool {
        loadGeneration == generation && sessionIdentity == session && coordinator.isCurrent(context)
    }

    // MARK: Saving

    @MainActor
    private func commit(_ field: AidenBotProfileField) async {
        guard let detail else { return }
        let patch: AidenBotIdentityPatch?
        switch field {
        case .name:
            let next = nameText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !next.isEmpty else {
                nameText = detail.name
                return
            }
            patch = next == detail.name ? nil : try? AidenBotIdentityPatch(name: next)
        case .subtitle:
            let next = subtitleText.trimmingCharacters(in: .whitespacesAndNewlines)
            patch = next == detail.purpose ? nil : try? AidenBotIdentityPatch(purpose: next)
        }
        guard let patch else { return }
        _ = await saveIdentity(patch)
    }

    @MainActor
    private func saveCharacter(_ next: AidenBotCharacterDraft) async {
        guard let detail, let patch = try? next.identityPatch(comparedTo: detail) else { return }
        let previous = character
        character = next
        if await !saveIdentity(patch) { character = previous }
    }

    @MainActor
    private func saveInstructions(_ text: String) async -> Bool {
        guard let detail else { return false }
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard next != detail.instructions else { return true }
        guard !next.isEmpty else {
            mutationError = "Instructions can’t be empty."
            return false
        }
        guard let patch = try? AidenBotIdentityPatch(instructions: next) else {
            mutationError = "Those instructions are too long."
            return false
        }
        return await saveIdentity(patch)
    }

    /// Sends one identity change. A lost response is reconciled by re-reading
    /// the Bot, so a retry never repeats a change the Mac already saved.
    @MainActor
    private func saveIdentity(_ patch: AidenBotIdentityPatch) async -> Bool {
        guard canWrite, let context = capturedContext, coordinator.isCurrent(context),
              let detail else { return false }
        isSaving = true
        defer { isSaving = false }
        do {
            let updated = try await coordinator.remoteClient(for: context).updateBotIdentity(
                id: botID,
                revision: detail.revision,
                patch: patch
            )
            guard coordinator.isCurrent(context), updated.id == botID else { return false }
            apply(updated)
            _ = await coordinator.withRetainedInstallationData(for: context) {
                _ = try? await AidenBotCache.shared.upsertDetailAndStore(
                    updated,
                    instanceId: context.instanceId,
                    deviceId: context.deviceId
                )
            }
            onChanged()
            return true
        } catch is CancellationError {
            return false
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return false }
            guard coordinator.isCurrent(context) else { return false }
            if let authoritative = try? await coordinator.remoteClient(for: context).bot(id: botID),
               coordinator.isCurrent(context) {
                apply(authoritative)
            }
            mutationError = "That change wasn’t saved. Please try again."
            return false
        }
    }

    @MainActor
    private func ingestPhoto(_ item: PhotosPickerItem) async {
        guard let avatarModel else { return }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            await avatarModel.ingestCopiedCandidate(data: data)
        } catch {
            mutationError = "That photo couldn’t be opened. Try another one."
        }
    }

    @MainActor
    private func deleteBot() async {
        guard canDelete, let detail else { return }
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await AidenBotDeletion.delete(botID: detail.id, revision: detail.revision, coordinator: coordinator)
            onChanged()
            onDeleted()
            if showsDismissButton { dismiss() }
        } catch is CancellationError {
            return
        } catch {
            mutationError = "\(detail.name) wasn’t deleted. Please try again."
        }
    }
}

/// Full-screen instructions editor. Back without saving discards.
struct AidenBotInstructionsEditorView: View {
    let initialText: String
    let canSave: Bool
    let onSave: (String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var text: String
    @State private var isSaving = false

    init(initialText: String, canSave: Bool, onSave: @escaping (String) async -> Bool) {
        self.initialText = initialText
        self.canSave = canSave
        self.onSave = onSave
        _text = State(initialValue: initialText)
    }

    var body: some View {
        TextEditor(text: $text)
            .scrollContentBackground(.hidden)
            .padding(12)
            .frame(minHeight: 220, alignment: .top)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle("Instructions")
            .navigationBarTitleDisplayMode(.inline)
            .accessibilityLabel("Instructions")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        Task {
                            isSaving = true
                            let saved = await onSave(text)
                            isSaving = false
                            if saved { dismiss() }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(palette.accent)
                    .foregroundStyle(palette.onAccent)
                    .disabled(!canSave || isSaving || text == initialText)
                }
            }
    }
}
