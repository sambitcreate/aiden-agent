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

/// Saves Profile's identity edits (R15). Each edit already shows on the page; it
/// goes to the Mac after the ones before it, on the newest revision, waiting
/// briefly for a connection. A lost answer is settled by re-reading the Bot, so
/// a retry never repeats a change the Mac saved; anything else hands back the
/// Mac's Bot (when it could be read) for the page to roll back to, with an error.
@MainActor
final class AidenBotIdentitySaver {
    enum Outcome: Equatable {
        case saved(AidenBotDetail)
        case failed(authoritative: AidenBotDetail?)
    }

    static let failedMessage = "That change wasn’t saved. Please try again."

    private(set) var inFlight = 0
    private var revision: String?
    private var lane: Task<Void, Never>?
    private let send: AidenBotMainActorCall<@MainActor (AidenBotIdentityPatch, String) async throws -> AidenBotDetail>
    private let refresh: AidenBotMainActorCall<@MainActor () async throws -> AidenBotDetail>
    private let waitForConnection: (@MainActor (Duration) async -> Bool)?
    private let connectionHold: Duration
    private let requestLimit: Duration

    init(
        send: @escaping @MainActor (AidenBotIdentityPatch, String) async throws -> AidenBotDetail,
        refresh: @escaping @MainActor () async throws -> AidenBotDetail,
        waitForConnection: (@MainActor (Duration) async -> Bool)? = nil,
        connectionHold: Duration = .seconds(8),
        requestLimit: Duration = .seconds(12)
    ) {
        self.send = AidenBotMainActorCall(send)
        self.refresh = AidenBotMainActorCall(refresh)
        self.waitForConnection = waitForConnection
        self.connectionHold = connectionHold
        self.requestLimit = requestLimit
    }

    /// The Bot as last read. A read never moves the revision under a save in flight.
    func adopt(_ detail: AidenBotDetail) {
        if inFlight == 0 { revision = detail.revision }
    }

    func save(_ patch: AidenBotIdentityPatch) async -> Outcome {
        inFlight += 1
        defer { inFlight -= 1 }
        let previous = lane
        let job = Task { @MainActor [weak self] () -> Outcome in
            await previous?.value
            guard let self else { return .failed(authoritative: nil) }
            return await self.run(patch)
        }
        lane = Task { _ = await job.value }
        return await job.value
    }

    private func run(_ patch: AidenBotIdentityPatch) async -> Outcome {
        do {
            if let waitForConnection, await waitForConnection(connectionHold) == false {
                throw URLError(.notConnectedToInternet)
            }
            guard let revision else { throw URLError(.resourceUnavailable) }
            let send = send
            let detail = try await aidenBotWithin(requestLimit) { try await send.call(patch, revision) }
            self.revision = detail.revision
            return .saved(detail)
        } catch {
            let refresh = refresh
            guard let fresh = try? await aidenBotWithin(requestLimit, { try await refresh.call() }) else {
                return .failed(authoritative: nil)
            }
            revision = fresh.revision
            return patch.isSatisfied(by: fresh) ? .saved(fresh) : .failed(authoritative: fresh)
        }
    }
}

extension AidenBotIdentityPatch {
    /// The Bot already holds every field this patch sets.
    func isSatisfied(by detail: AidenBotDetail) -> Bool {
        (name == nil || name == detail.name)
            && (purpose == nil || purpose == detail.purpose)
            && (instructions == nil || instructions == detail.instructions)
            && (avatar == nil || avatar == detail.avatar.semantic)
            && (chatActivity == nil || chatActivity == detail.chatActivity)
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
    /// Opens Profile → Memory once it is ready (the chat's "Memory updated").
    var opensMemory = false
    /// Opens Profile → Advanced once the Bot has loaded (a Bots row's menu).
    var opensAdvanced = false

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @State private var detail: AidenBotDetail?
    @State private var capturedContext: AidenRemoteRequestContext?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var mutationError: String?
    @State private var saver: AidenBotIdentitySaver?
    @State private var isDeleting = false
    @State private var loadGeneration: UInt = 0
    @State private var nameText = ""
    @State private var subtitleText = ""
    @State private var character: AidenBotCharacterDraft?
    @State private var avatarModel: AidenBotGeneratedAvatarModel?
    @State private var photoItem: PhotosPickerItem?
    @State private var isShowingImagePlayground = false
    @State private var isConfirmingImagePlaygroundPrivacy = false
    @State private var isConfirmingPhotoRemoval = false
    @State private var isConfirmingDelete = false
    @State private var isShowingAdvanced = false
    @State private var memoryModel: AidenBotMemoryModel?
    @State private var isShowingMemory = false
    @State private var hasOpenedMemory = false
    @State private var hasOpenedAdvanced = false
    @FocusState private var focusedField: AidenBotProfileField?

    private var botID: String { initialSummary.id }

    private var sessionIdentity: AidenBotCustomAccessSessionIdentity {
        AidenBotCustomAccessSessionIdentity(coordinator: coordinator)
    }

    /// Edits apply at once, cached or fresh, connected or not (R15); each waits
    /// briefly for the Mac and rolls back with an error if it doesn't reach it.
    private var canWrite: Bool {
        capturedContext.map(coordinator.isCurrent) == true
            && saver != nil
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
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
                                .disabled(isDeleting)
                        }
                    }
                    if detail != nil {
                        ToolbarItem(placement: .primaryAction) {
                            moreMenu
                        }
                    }
                }
                .navigationDestination(isPresented: $isShowingAdvanced) {
                    AidenBotAdvancedView(
                        coordinator: coordinator,
                        botID: botID,
                        onSaved: { updated in
                            apply(updated)
                            onChanged()
                        },
                        onSaveFailed: { mutationError = $0 }
                    )
                }
                .navigationDestination(isPresented: $isShowingMemory) {
                    if let memoryModel {
                        AidenBotMemoryView(model: memoryModel, canWrite: canWrite)
                    }
                }
        }
        .interactiveDismissDisabled(isDeleting || avatarModel?.isBusy == true)
        // A new pairing starts over; a connection coming up only re-reads, keeping edits.
        .task(id: sessionIdentity.pairing) {
            let expectedSession = sessionIdentity
            reset(for: expectedSession)
            await load(for: expectedSession)
        }
        .onChange(of: coordinator.connectionState == .connected) { _, connected in
            guard connected, detail != nil else { return }
            let expectedSession = sessionIdentity
            Task { await load(for: expectedSession) }
        }
        .task(id: avatarModel?.sessionIdentity) {
            await avatarModel?.sessionDidChangeAndRefresh()
        }
        .onChange(of: sessionIdentity.pairing) { oldValue, newValue in
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
        .confirmationDialog(
            "Create with Apple Intelligence",
            isPresented: $isConfirmingImagePlaygroundPrivacy,
            titleVisibility: .visible
        ) {
            Button("Open Image Playground") { isShowingImagePlayground = true }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text(AidenBotImagePlaygroundCopy.privacyNote)
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

                if let memoryModel {
                    Button {
                        isShowingMemory = true
                    } label: {
                        AidenBotMemoryRow(summary: memoryModel.countSummary)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 8)
                }

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
                // The photo is on its way: a shimmer, never a spinner (R15).
                AidenBotSkeletonBlock(width: 112, height: 6, radius: 3, reduceMotion: reduceMotion)
                    .accessibilityElement()
                    .accessibilityLabel("Saving photo")
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
                    .aidenSolidFillTint()
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
                    Button("Create with Apple Intelligence", systemImage: "apple.intelligence") {
                        isConfirmingImagePlaygroundPrivacy = true
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
                startInstructionsSave(text)
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
        saver = nil
        character = nil
        memoryModel = nil
        isShowingMemory = false
        avatarModel?.clearForDismissal()
        avatarModel = nil
    }

    @MainActor
    private func apply(_ loaded: AidenBotDetail) {
        saver?.adopt(loaded)
        detail = loaded
        if focusedField != .name { nameText = loaded.name }
        if focusedField != .subtitle { subtitleText = loaded.purpose }
        character = AidenBotCharacterDraft(avatar: loaded.avatar.semantic)
        memoryModel?.rename(loaded.name)
    }

    /// Profile → Memory, only on a Mac that serves `bot-memory-v1`.
    @MainActor
    private func prepareMemory(context: AidenRemoteRequestContext, botName: String) async {
        guard memoryModel == nil,
              AidenBotHostFeature.isAdvertised(AidenBotHostFeature.memory, coordinator: coordinator),
              let client = try? coordinator.remoteClient(for: context) else { return }
        let model = AidenBotMemoryModel(botID: botID, botName: botName, transport: client)
        memoryModel = model
        if opensMemory, !hasOpenedMemory {
            hasOpenedMemory = true
            isShowingMemory = true
        }
        await model.load()
    }

    /// The saver for this pairing, made once the page has a Bot to edit.
    @MainActor
    private func prepareSaver(context: AidenRemoteRequestContext) {
        guard saver == nil else { return }
        let botID = botID
        saver = AidenBotIdentitySaver(
            send: { patch, revision in
                try await coordinator.remoteClient(for: context).updateBotIdentity(id: botID, revision: revision, patch: patch)
            },
            refresh: { try await coordinator.remoteClient(for: context).bot(id: botID) },
            waitForConnection: { hold in await aidenBotWaitForConnection(coordinator, hold: hold) }
        )
        if let detail { saver?.adopt(detail) }
    }

    @MainActor
    private func load(for expectedSession: AidenBotCustomAccessSessionIdentity) async {
        // An edit on its way keeps what the page shows until the Mac answers it.
        guard sessionIdentity.pairing == expectedSession.pairing, saver?.inFlight ?? 0 == 0 else { return }
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
                // The saved details are editable at once; edits wait for the Mac (R15).
                capturedContext = context
                prepareSaver(context: context)
                isLoading = false
            }
            let loaded = try await coordinator.remoteClient(for: context).bot(id: botID)
            guard isCurrentLoad(generation, session: expectedSession, context: context),
                  loaded.id == botID, !Task.isCancelled, saver?.inFlight ?? 0 == 0 else { return }
            apply(loaded)
            capturedContext = context
            prepareSaver(context: context)
            loadError = nil
            if opensAdvanced, !hasOpenedAdvanced {
                hasOpenedAdvanced = true
                isShowingAdvanced = true
            }
            if memoryModel == nil {
                Task { await prepareMemory(context: context, botName: loaded.name) }
            } else {
                Task { await memoryModel?.load() }
            }
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
            guard loadGeneration == generation, sessionIdentity.pairing == expectedSession.pairing else { return }
            // Saved details stay editable offline; with none, there is nothing to edit.
            if detail == nil { capturedContext = nil }
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
        loadGeneration == generation && sessionIdentity.pairing == session.pairing && coordinator.isCurrent(context)
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
        // Shown at once; a failed save puts back the Mac's character.
        character = next
        _ = await saveIdentity(patch)
    }

    /// The editor closes at once and the change goes out (R15). Returns why it
    /// can't be saved, for the editor to show, or nil once it is on its way.
    @MainActor
    private func startInstructionsSave(_ text: String) -> String? {
        guard let detail else { return AidenBotIdentitySaver.failedMessage }
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard next != detail.instructions else { return nil }
        guard !next.isEmpty else { return "Instructions can’t be empty." }
        guard let patch = try? AidenBotIdentityPatch(instructions: next) else { return "Those instructions are too long." }
        Task { _ = await saveIdentity(patch) }
        return nil
    }

    /// Sends one identity change the page already shows. On failure the page
    /// rolls back to the Mac's Bot, or to what it showed before, with an error.
    @MainActor
    private func saveIdentity(_ patch: AidenBotIdentityPatch) async -> Bool {
        guard canWrite, let context = capturedContext, coordinator.isCurrent(context),
              let saver, let before = detail else { return false }
        switch await saver.save(patch) {
        case let .saved(updated):
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
        case let .failed(authoritative):
            guard coordinator.isCurrent(context) else { return false }
            let restored = authoritative ?? before
            detail = restored
            if focusedField != .name { nameText = restored.name }
            if focusedField != .subtitle { subtitleText = restored.purpose }
            character = AidenBotCharacterDraft(avatar: restored.avatar.semantic)
            mutationError = AidenBotIdentitySaver.failedMessage
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
    /// Starts the save and returns nil, or says why it can't be saved.
    let onSave: (String) -> String?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var text: String
    @State private var problem: String?

    init(initialText: String, canSave: Bool, onSave: @escaping (String) -> String?) {
        self.initialText = initialText
        self.canSave = canSave
        self.onSave = onSave
        _text = State(initialValue: initialText)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextEditor(text: $text)
                .scrollContentBackground(.hidden)
                .padding(12)
                .frame(minHeight: 220, alignment: .top)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .accessibilityLabel("Instructions")
            if let problem {
                Label(problem, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(palette.danger)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(palette.canvas.ignoresSafeArea())
        .navigationTitle("Instructions")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: text) { _, _ in problem = nil }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                // Saves as it closes; a failure comes back on the Profile (R15).
                Button("Save") {
                    if let reason = onSave(text) {
                        problem = reason
                    } else {
                        dismiss()
                    }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .aidenSolidFillTint()
                .disabled(!canSave || text == initialText)
            }
        }
    }
}
