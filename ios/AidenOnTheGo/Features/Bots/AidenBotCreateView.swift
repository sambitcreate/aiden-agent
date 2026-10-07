import SwiftUI

private struct AidenBotCreateAttempt: Equatable {
    let context: AidenRemoteRequestContext
    let request: AidenBotCreateRequest
    let idempotencyKey: UUID
    let chatIdempotencyKey: UUID
}

/// Two questions: a name, and what the Bot should help with. The answer
/// becomes its subtitle and first instructions; everything else uses
/// sensible defaults that can be changed later in the Profile.
struct AidenBotCreateView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    var onCreated: (AidenBotDetail) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var catalog: AidenBotCapabilityCatalog?
    @State private var draft: AidenBotEditorDraft?
    @State private var capturedContext: AidenRemoteRequestContext?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var saveError: String?
    @State private var activeAttempt: AidenBotCreateAttempt?
    @State private var retainedAttempt: AidenBotCreateAttempt?
    @State private var retainedCreatedBot: AidenBotDetail?
    @FocusState private var nameIsFocused: Bool

    private var sessionIdentity: AidenBotCustomAccessSessionIdentity {
        AidenBotCustomAccessSessionIdentity(coordinator: coordinator)
    }

    private var isSaving: Bool { activeAttempt != nil }

    private var canCreate: Bool {
        guard capturedContext.map(coordinator.isCurrent) == true,
              coordinator.connectionState == .connected,
              coordinator.installationStore.activeInstallation?.canWriteBots == true,
              !isSaving, let catalog, let draft else { return false }
        return draft.isSaveable(catalog: catalog)
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("New Bot")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                            .disabled(isSaving)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(isSaving ? "Creating…" : "Create") {
                            Task { await create() }
                        }
                        .disabled(!canCreate)
                    }
                }
        }
        .interactiveDismissDisabled(isSaving)
        .task(id: sessionIdentity) {
            await load()
        }
        .alert(
            "Couldn’t Create Bot",
            isPresented: Binding(
                get: { saveError != nil },
                set: { if !$0 { saveError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { saveError = nil }
        } message: {
            Text(saveError ?? "Please try again.")
        }
    }

    @ViewBuilder
    private var content: some View {
        if draft != nil {
            Form {
                Section {
                    TextField("Name", text: binding(\.name))
                        .textContentType(.name)
                        .submitLabel(.next)
                        .focused($nameIsFocused)
                    TextField("What should it help with?", text: binding(\.purpose), axis: .vertical)
                        .lineLimit(2...5)
                } footer: {
                    Text(accessNote)
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas)
            .disabled(isSaving)
            .onAppear { nameIsFocused = true }
        } else if isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(palette.canvas)
        } else {
            ContentUnavailableView {
                Label("Can’t Create a Bot Yet", systemImage: "exclamationmark.bubble")
            } description: {
                Text(loadError ?? "Connect to your Mac, then try again.")
            } actions: {
                Button("Try Again") { Task { await load() } }
            }
        }
    }

    private var accessNote: String {
        guard let catalog, AidenBotEditorDraft.fullAccessAccepted(in: catalog) else {
            return "You can choose what it can use later in Advanced."
        }
        return "It can use everything your Mac allows. You can change this later in Advanced."
    }

    private func binding(_ keyPath: WritableKeyPath<AidenBotEditorDraft, String>) -> Binding<String> {
        Binding(
            get: { draft?[keyPath: keyPath] ?? "" },
            set: { value in
                guard var next = draft else { return }
                next[keyPath: keyPath] = value
                if keyPath == \AidenBotEditorDraft.purpose {
                    next.instructions = AidenBotEditorDraft.seededInstructions(helpWith: value)
                }
                draft = next
                retainedAttempt = nil
                retainedCreatedBot = nil
            }
        )
    }

    @MainActor
    private func load() async {
        let expectedSession = sessionIdentity
        isLoading = true
        loadError = nil
        var requestContext: AidenRemoteRequestContext?
        do {
            let context = try coordinator.requestContext()
            requestContext = context
            let loadedCatalog = try await coordinator.remoteClient(for: context).botCapabilityCatalog()
            guard coordinator.isCurrent(context), sessionIdentity == expectedSession,
                  !Task.isCancelled else { return }
            let loadedDraft = try aidenBotEditorResolvedDraft(
                mode: .create(defaultAccess: .recommended),
                catalog: loadedCatalog,
                bot: nil
            )
            capturedContext = context
            catalog = loadedCatalog
            if draft == nil {
                draft = loadedDraft
            }
            isLoading = false
        } catch is CancellationError {
            return
        } catch {
            if let context = requestContext,
               await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard sessionIdentity == expectedSession else { return }
            capturedContext = nil
            loadError = aidenBotFriendlyLoadError(error)
            isLoading = false
        }
    }

    @MainActor
    private func create() async {
        guard canCreate, let context = capturedContext, let catalog, let draft else { return }
        var sentAttempt: AidenBotCreateAttempt?
        do {
            let request = try draft.createRequest(catalog: catalog)
            let attempt: AidenBotCreateAttempt
            if let retainedAttempt, retainedAttempt.context == context, retainedAttempt.request == request {
                attempt = retainedAttempt
            } else {
                attempt = AidenBotCreateAttempt(
                    context: context,
                    request: request,
                    idempotencyKey: UUID(),
                    chatIdempotencyKey: UUID()
                )
            }
            retainedAttempt = attempt
            activeAttempt = attempt
            sentAttempt = attempt
            defer { if activeAttempt == attempt { activeAttempt = nil } }
            let client = try coordinator.remoteClient(for: attempt.context)
            let created: AidenBotDetail
            if let retainedCreatedBot {
                created = retainedCreatedBot
            } else {
                created = try await client.createBot(attempt.request, idempotencyKey: attempt.idempotencyKey)
                guard isCurrent(attempt) else { return }
                retainedCreatedBot = created
            }
            _ = try await client.createBotChat(
                botId: created.id,
                request: try AidenBotChatCreateRequest(
                    providerId: draft.customAccess.providerID,
                    modelId: draft.customAccess.modelID
                ),
                idempotencyKey: attempt.chatIdempotencyKey
            )
            guard isCurrent(attempt) else { return }
            let authoritative = try await client.bot(id: created.id)
            guard isCurrent(attempt) else { return }
            retainedAttempt = nil
            retainedCreatedBot = nil
            onCreated(authoritative)
            dismiss()
        } catch is CancellationError {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) {
                if retainedAttempt == sentAttempt { retainedAttempt = nil }
                return
            }
            guard coordinator.isCurrent(context), capturedContext == context else { return }
            if retainedCreatedBot == nil, let sentAttempt, retainedAttempt == sentAttempt,
               !aidenBotEditorCreateFailureIsAmbiguous(error) {
                retainedAttempt = nil
            }
            saveError = error.localizedDescription
        }
    }

    @MainActor
    private func isCurrent(_ attempt: AidenBotCreateAttempt) -> Bool {
        coordinator.isCurrent(attempt.context)
            && capturedContext == attempt.context
            && activeAttempt == attempt
    }
}
