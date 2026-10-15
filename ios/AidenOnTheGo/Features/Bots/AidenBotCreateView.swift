import Observation
import SwiftUI

/// What New Bot was asked for, kept so a failed create can be tried again as it was.
struct AidenBotCreateInput: Equatable {
    var name: String
    var purpose: String
    /// The model the person picked; nil uses the Mac's recommended one.
    var draft: AidenBotEditorDraft?
}

/// The requests one Bot create makes; the remote client provides them, tests a fake.
struct AidenBotCreateOperations {
    /// The pairing the create is for, so a retry matches only its own attempt.
    var scope: String
    var usesDurableSession: Bool
    var waitForConnection: @MainActor (Duration) async -> Bool
    var catalog: @MainActor () async throws -> AidenBotCapabilityCatalog
    var create: @MainActor (AidenBotCreateRequest, UUID) async throws -> AidenBotDetail
    /// Older Macs need the Bot chat created explicitly.
    var createChat: @MainActor (_ botID: String, AidenBotChatCreateRequest, UUID) async throws -> Void
    var readBot: @MainActor (_ botID: String) async throws -> AidenBotDetail
    /// The pairing the create started on is still the active one.
    var isCurrent: @MainActor () -> Bool = { true }
    /// True when the error revoked this phone; the create then stops quietly.
    var handleRevocation: @MainActor (Error) async -> Bool = { _ in false }
}

/// Bot creation that never waits on the sheet (R15). Create closes New Bot at
/// once and the Bot shows in Bots as on its way; it goes out after a short wait
/// for the Mac, and a failure takes the row away with an error and Try Again,
/// which reopens New Bot as it was. The same request keeps its Idempotency-Key
/// (and a Bot already made) across tries, so a retry never makes two Bots.
@MainActor
@Observable
final class AidenBotCreateFlow {
    struct Pending: Equatable, Identifiable {
        let id: UUID
        let name: String
        let purpose: String
    }

    struct Failure: Equatable {
        let message: String
        let input: AidenBotCreateInput
    }

    static let unreachable = "Aiden couldn’t reach your Mac, so the Bot wasn’t made. Try again."

    private(set) var pending: Pending?
    var failure: Failure?

    private struct Attempt {
        let scope: String
        /// What the person asked for; a retry is the same attempt while this is unchanged.
        let input: AidenBotCreateInput
        let request: AidenBotCreateRequest
        /// The model the request was built from, for the chat step.
        let draft: AidenBotEditorDraft?
        let key: UUID
        let chatKey: UUID
        var created: AidenBotDetail?
    }

    @ObservationIgnored private var retained: Attempt?
    @ObservationIgnored private let connectionHold: Duration
    @ObservationIgnored private let requestLimit: Duration

    init(connectionHold: Duration = .seconds(8), requestLimit: Duration = .seconds(12)) {
        self.connectionHold = connectionHold
        self.requestLimit = requestLimit
    }

    /// Makes the Bot; returns once it exists on the Mac (and `onCreated` ran) or failed.
    func submit(
        _ input: AidenBotCreateInput,
        operations: AidenBotCreateOperations,
        onCreated: @MainActor (AidenBotDetail) async -> Void
    ) async {
        guard pending == nil else { return }
        failure = nil
        pending = Pending(
            id: UUID(),
            name: input.name.trimmingCharacters(in: .whitespacesAndNewlines),
            purpose: input.purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        defer { pending = nil }
        var sent = false
        do {
            guard await operations.waitForConnection(connectionHold) else {
                failure = Failure(message: Self.unreachable, input: input)
                return
            }
            guard operations.isCurrent() else { return }
            var attempt: Attempt
            if let retained, retained.scope == operations.scope, Self.isSameAsk(retained, input) {
                // The same ask as a failed try: its frozen request and key, whatever the catalog says now.
                attempt = retained
            } else {
                let (request, draft) = try await resolve(input, operations: operations)
                attempt = Attempt(
                    scope: operations.scope,
                    input: input,
                    request: request,
                    draft: draft,
                    key: UUID(),
                    chatKey: UUID()
                )
            }
            retained = attempt
            sent = true
            let created: AidenBotDetail
            if let made = attempt.created {
                created = made
            } else {
                created = try await bounded { try await operations.create(attempt.request, attempt.key) }
                attempt.created = created
                retained = attempt
            }
            guard operations.isCurrent() else { return }
            if !operations.usesDurableSession, let draft = attempt.draft {
                let chat = try AidenBotChatCreateRequest(
                    providerId: draft.customAccess.providerID,
                    modelId: draft.customAccess.modelID
                )
                try await bounded { try await operations.createChat(created.id, chat, attempt.chatKey) }
                guard operations.isCurrent() else { return }
            }
            let authoritative = try await bounded { try await operations.readBot(created.id) }
            guard operations.isCurrent() else { return }
            retained = nil
            await onCreated(authoritative)
        } catch is CancellationError {
            return
        } catch {
            if await operations.handleRevocation(error) {
                retained = nil
                return
            }
            guard operations.isCurrent() else { return }
            // A Bot already made, or a request that may have arrived, is tried again as it was.
            if sent, retained?.created == nil, !aidenBotEditorCreateFailureIsAmbiguous(error) {
                retained = nil
            }
            failure = Failure(message: aidenBotFriendlyLoadError(error), input: input)
        }
    }

    /// The request for `input`: its picked model, or the Mac's recommended one,
    /// or none on a Mac that lets a Bot start without one.
    private func resolve(
        _ input: AidenBotCreateInput,
        operations: AidenBotCreateOperations
    ) async throws -> (AidenBotCreateRequest, AidenBotEditorDraft?) {
        let name = input.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let purpose = input.purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        let catalog = try await bounded { try await operations.catalog() }
        var draft = input.draft
        if draft == nil {
            do {
                draft = try aidenBotEditorResolvedDraft(mode: .create(defaultAccess: .recommended), catalog: catalog, bot: nil)
            } catch AidenBotContractError.invalidCombination("no available provider and model") where operations.usesDurableSession {
                let request = try AidenBotCreateRequest(
                    name: name,
                    purpose: purpose,
                    instructions: AidenBotEditorDraft.seededInstructions(helpWith: purpose),
                    avatar: .recipe(AidenBotEditorDraft.defaultAvatar),
                    access: nil
                )
                return (request, nil)
            }
        }
        guard var draft else { throw AidenBotContractError.invalidCombination("no available provider and model") }
        draft.name = name
        draft.purpose = purpose
        draft.instructions = AidenBotEditorDraft.seededInstructions(helpWith: purpose)
        return (try draft.createRequest(catalog: catalog), draft)
    }

    /// The same ask as `attempt`, decided before any catalog is read: the same answers, or, when the
    /// first try went out before the Mac's models arrived, the model it was made with. A catalog that
    /// moved on since is not a change the person made.
    private static func isSameAsk(_ attempt: Attempt, _ input: AidenBotCreateInput) -> Bool {
        if attempt.input == input { return true }
        guard attempt.input.name == input.name, attempt.input.purpose == input.purpose,
              attempt.input.draft == nil, let made = attempt.draft, let draft = input.draft else { return false }
        return made.customAccess.providerID == draft.customAccess.providerID
            && made.customAccess.modelID == draft.customAccess.modelID
            && made.visionProviderID == draft.visionProviderID
            && made.visionModelID == draft.visionModelID
    }

    private func bounded<T: Sendable>(_ operation: @escaping @MainActor () async throws -> T) async throws -> T {
        let call = AidenBotMainActorCall(operation)
        return try await aidenBotWithin(requestLimit) { try await call.call() }
    }
}

/// Two questions: a name, and what the Bot should help with. The answer
/// becomes its subtitle and first instructions; everything else uses
/// sensible defaults that can be changed later in the Profile.
///
/// It opens at once (R15): the questions are there before the Mac answers, the
/// AI model row is a skeleton until the Mac's models arrive (from the cache
/// first), and Create works while connecting. Create hands the Bot to `onCreate`
/// and closes; the Bot is made after, without holding the sheet.
struct AidenBotCreateView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    /// What a Try Again brings back.
    var initial: AidenBotCreateInput?
    var onCreate: (AidenBotCreateInput) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @State private var catalog: AidenBotCapabilityCatalog?
    @State private var draft: AidenBotEditorDraft?
    @State private var name = ""
    @State private var purpose = ""
    @State private var didPrefill = false
    @State private var loadError: String?
    /// A durable-session host lets a Bot start without an AI model; it then
    /// reports `needs_model` until one is chosen on the Mac.
    @State private var allowsModellessCreate = false
    @FocusState private var nameIsFocused: Bool

    private var sessionIdentity: AidenBotCustomAccessSessionIdentity {
        AidenBotCustomAccessSessionIdentity(coordinator: coordinator)
    }

    private var usesDurableSession: Bool {
        AidenBotHostFeature.isAdvertised(AidenBotHostFeature.durableSession, coordinator: coordinator)
    }

    private var input: AidenBotCreateInput {
        var picked = draft
        picked?.name = name
        picked?.purpose = purpose
        return AidenBotCreateInput(name: name, purpose: purpose, draft: picked)
    }

    /// Valid answers are enough: the model is the picked one, or the Mac's
    /// recommended one once it answers.
    private var canCreate: Bool {
        guard coordinator.installationStore.activeInstallation?.canWriteBots == true,
              (try? AidenBotCreateRequest(
                  name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                  purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines),
                  instructions: AidenBotEditorDraft.seededInstructions(helpWith: purpose),
                  avatar: .recipe(AidenBotEditorDraft.defaultAvatar),
                  access: nil
              )) != nil else { return false }
        if let catalog, let draft {
            var named = draft
            named.name = name
            named.purpose = purpose
            named.instructions = AidenBotEditorDraft.seededInstructions(helpWith: purpose)
            return named.isSaveable(catalog: catalog)
        }
        return true
    }

    var body: some View {
        NavigationStack {
            form
                .navigationTitle("New Bot")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Create") {
                            onCreate(input)
                            dismiss()
                        }
                        .disabled(!canCreate)
                    }
                }
        }
        .task(id: sessionIdentity.pairing) {
            prefill()
            await load()
        }
        .onChange(of: coordinator.connectionState == .connected) { _, connected in
            if connected, catalog == nil || loadError != nil { Task { await load() } }
        }
    }

    private var form: some View {
        Form {
            Section {
                TextField("Name", text: $name)
                    .textContentType(.name)
                    .submitLabel(.next)
                    .focused($nameIsFocused)
                TextField("What should it help with?", text: $purpose, axis: .vertical)
                    .lineLimit(2...5)
            } footer: {
                Text(accessNote)
            }
            modelSection
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .onAppear { nameIsFocused = true }
    }

    @ViewBuilder
    private var modelSection: some View {
        if let catalog, let current = draft {
            Section {
                AidenBotModelRow(
                    title: "Model",
                    catalog: catalog,
                    providerID: current.customAccess.providerID,
                    modelID: current.customAccess.modelID,
                    recommended: AidenBotCustomAccessDraft(catalog: catalog).map {
                        AidenBotModelSelection(providerId: $0.providerID, modelId: $0.modelID)
                    }
                ) { providerID, modelID in
                    draft?.selectModel(providerID: providerID, modelID: modelID, catalog: catalog)
                }
                switch current.photoModelNeed(catalog: catalog) {
                case .none:
                    EmptyView()
                case .unavailable:
                    Text(current.noImageModelNote(catalog: catalog))
                        .foregroundStyle(palette.secondary)
                case .choose:
                    AidenBotModelRow(
                        title: "Photos",
                        catalog: catalog,
                        providerID: current.visionProviderID,
                        modelID: current.visionModelID,
                        imagesOnly: true
                    ) { providerID, modelID in
                        draft?.selectVisionModel(providerID: providerID, modelID: modelID, catalog: catalog)
                    }
                }
            } header: {
                Text("AI model")
            } footer: {
                Text("You can change this later in Advanced.")
            }
        } else if !allowsModellessCreate {
            Section {
                if let loadError {
                    // Never a blocking screen: the Bot is made with the recommended model.
                    HStack(spacing: 8) {
                        Text(loadError)
                            .font(.footnote)
                            .foregroundStyle(palette.secondary)
                        Spacer(minLength: 8)
                        Button("Try Again") { Task { await load() } }
                            .font(.footnote.weight(.semibold))
                            .frame(minHeight: 44)
                    }
                } else {
                    // The Mac's models are on their way: a skeleton row, never a spinner.
                    HStack {
                        AidenBotSkeletonBlock(width: 64, height: 16, radius: 8, reduceMotion: reduceMotion)
                        Spacer()
                        AidenBotSkeletonBlock(width: 120, height: 16, radius: 8, reduceMotion: reduceMotion)
                    }
                    .frame(minHeight: 28)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Loading models")
                }
            } header: {
                Text("AI model")
            } footer: {
                Text("It uses the recommended model unless you pick one.")
            }
        }
    }

    private var accessNote: String {
        if allowsModellessCreate {
            return "It needs an AI model before it can reply. Choose one on your Mac."
        }
        return "It can use everything your Mac allows. You can change this later in Advanced."
    }

    private func prefill() {
        guard !didPrefill else { return }
        didPrefill = true
        guard let initial else { return }
        name = initial.name
        purpose = initial.purpose
        draft = initial.draft
    }

    /// The Mac's models, from the cache at once and then fresh. A picked model stays.
    @MainActor
    private func load() async {
        let expected = sessionIdentity.pairing
        guard let context = try? coordinator.requestContext() else { return }
        if catalog == nil,
           let cached = await AidenBotCache.shared.load(instanceId: context.instanceId, deviceId: context.deviceId)?.catalog,
           sessionIdentity.pairing == expected {
            adopt(cached)
        }
        do {
            let loaded = try await coordinator.remoteClient(for: context).botCapabilityCatalog()
            guard coordinator.isCurrent(context), sessionIdentity.pairing == expected, !Task.isCancelled else { return }
            loadError = nil
            adopt(loaded)
        } catch is CancellationError {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard sessionIdentity.pairing == expected else { return }
            if catalog == nil { loadError = aidenBotFriendlyLoadError(error) }
        }
    }

    private func adopt(_ loaded: AidenBotCapabilityCatalog) {
        let resolved: AidenBotEditorDraft?
        do {
            resolved = try aidenBotEditorResolvedDraft(mode: .create(defaultAccess: .recommended), catalog: loaded, bot: nil)
        } catch {
            resolved = nil
        }
        catalog = loaded
        allowsModellessCreate = resolved == nil && usesDurableSession
        // A model already picked stays while the Mac still offers it.
        if let draft, draft.isSaveable(catalog: loaded) { return }
        draft = resolved
    }
}

/// The Bots row for a Bot on its way to the Mac (R15): its name at once,
/// a skeleton face, and "Creating…".
struct AidenBotPendingCreateRow: View {
    let pending: AidenBotCreateFlow.Pending

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            AidenBotSkeletonBlock(width: 52, height: 52, radius: 26, reduceMotion: reduceMotion)
            VStack(alignment: .leading, spacing: 4) {
                Text(pending.name)
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                Text(AidenBotCreateCopy.creating)
                    .font(.body)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(pending.name), \(AidenBotCreateCopy.creating)")
    }
}

enum AidenBotCreateCopy {
    static let creating = "Creating…"
    static let failedTitle = "Couldn’t Create Bot"
}
