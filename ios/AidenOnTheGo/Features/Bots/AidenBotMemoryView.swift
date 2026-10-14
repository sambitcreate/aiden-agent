import Observation
import SwiftUI

/// The copy shared with desktop and Android for Profile → Memory.
enum AidenBotMemoryCopy {
    static let title = "Memory"
    static let aboutYou = "About you"
    static let eraseMemory = "Erase memory"
    static let cantBeUndone = "This can’t be undone."
    static let unreadableTitle = "Memory couldn’t be read"
    static let blocked = "This can’t be saved because it looks like a password or an instruction to the Bot."
    static let entryChanged = "This memory changed since you opened it. Close this and try again."
    static let notSaved = "That change wasn’t saved. Please try again."
    static let notErased = "Memory wasn’t erased. Please try again."
    static let couldNotLoad = "Memory couldn’t be loaded."
    static let nothingYetCount = "Nothing yet"
    static let unreadableCount = "Couldn’t be read"
    static let edit = "Edit"
    static let delete = "Delete"
    static let save = "Save"

    static func notesTitle(botName: String) -> String { "\(botName)’s notes" }

    static func description(botName: String) -> String {
        "What \(botName) remembers about you and its work. It’s stored on this Mac, and \(botName) uses it in every chat."
    }

    static func aboutYouEmpty(botName: String) -> String {
        "Nothing yet. Tell \(botName) something to remember, like “I’m vegetarian.”"
    }

    static func notesEmpty(botName: String) -> String {
        "Nothing yet. \(botName) keeps notes here as it helps you."
    }

    static func eraseConfirmation(botName: String) -> String {
        "Erase everything \(botName) remembers?"
    }

    static func unreadableDetail(botName: String) -> String {
        "Its files may be damaged. Erasing starts \(botName)’s memory fresh."
    }

    static func overBudget(group: String) -> String {
        "That would make “\(group)” too long. Shorten it, or delete something else first."
    }

    static func usage(used: Int, limit: Int, locale: Locale = .current) -> String {
        let format = IntegerFormatStyle<Int>.number.locale(locale)
        return "\(used.formatted(format)) of \(limit.formatted(format)) characters"
    }

    /// The quiet count on the Profile row.
    static func count(_ memory: AidenBotMemory) -> String {
        guard memory.readable else { return unreadableCount }
        switch memory.entryCount {
        case 0: return nothingYetCount
        case 1: return "1 thing"
        case let count: return "\(count) things"
        }
    }

    static func groupTitle(_ target: AidenBotMemoryTarget, botName: String) -> String {
        switch target {
        case .user: aboutYou
        case .memory: notesTitle(botName: botName)
        }
    }
}

/// The network surface Memory needs. `AidenRemoteClient` provides it; tests
/// substitute a fake.
protocol AidenBotMemoryTransport: Sendable {
    func botMemory(botId: String) async throws -> AidenBotMemory
    func editBotMemory(
        botId: String,
        request: AidenBotMemoryEditRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotMemory
}

extension AidenRemoteClient: AidenBotMemoryTransport {}

/// Loads a Bot's memory and applies the person's edits. Each edit shows at
/// once and goes to the Mac in order (R15); a failed one refetches the view,
/// because the Mac's error bodies carry none, or, if that fails too, goes
/// back to what showed before it.
@MainActor
@Observable
final class AidenBotMemoryModel {
    let botID: String
    private(set) var botName: String
    private let transport: any AidenBotMemoryTransport

    private(set) var memory: AidenBotMemory?
    private(set) var isLoading = false
    /// Edits on their way to the Mac.
    private(set) var editsInFlight = 0
    var isMutating: Bool { editsInFlight > 0 }
    /// A load failure, shown in place of the page.
    private(set) var loadError: String?
    /// A failed delete or erase, shown as an alert on the page.
    var errorMessage: String?

    @ObservationIgnored private var retainedEdit: (edit: AidenBotMemoryEdit, key: UUID)?
    /// The edit going to the Mac now; the next one waits for it.
    @ObservationIgnored private var lane: Task<Void, Never>?

    init(botID: String, botName: String, transport: any AidenBotMemoryTransport) {
        self.botID = botID
        self.botName = botName
        self.transport = transport
    }

    func rename(_ name: String) { botName = name }

    var countSummary: String? { memory.map(AidenBotMemoryCopy.count) }

    /// Returns true when the Mac's view replaced what showed.
    @discardableResult
    func load() async -> Bool {
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await transport.botMemory(botId: botID)
            guard loaded.botId == botID else { return false }
            memory = loaded
            loadError = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            loadError = AidenBotMemoryCopy.couldNotLoad
            return false
        }
    }

    /// Saves from the edit sheet, which closes at once: a failure shows on the page.
    func saveInBackground(target: AidenBotMemoryTarget, entryId: String, text: String) {
        guard let edit = try? AidenBotMemoryEdit.replacing(target: target, entryId: entryId, text: text) else {
            errorMessage = AidenBotMemoryCopy.notSaved
            return
        }
        Task { if let failure = await apply(edit) { errorMessage = failure } }
    }

    /// Replaces one entry's text. Returns nil when it was saved, or the
    /// person-facing reason it was not (the view is refetched either way on
    /// failure, so a stale entry disappears or shows its newer text).
    func save(target: AidenBotMemoryTarget, entryId: String, text: String) async -> String? {
        let edit: AidenBotMemoryEdit
        do {
            edit = try .replacing(target: target, entryId: entryId, text: text)
        } catch {
            return AidenBotMemoryCopy.notSaved
        }
        return await apply(edit)
    }

    /// Deletes one entry right away.
    func delete(target: AidenBotMemoryTarget, entryId: String) async {
        guard let edit = try? AidenBotMemoryEdit.removing(target: target, entryId: entryId) else { return }
        if let failure = await apply(edit) { errorMessage = failure }
    }

    /// Erases both groups. Returns true when the Mac confirmed it.
    @discardableResult
    func erase() async -> Bool {
        if await apply(.clear) != nil {
            errorMessage = AidenBotMemoryCopy.notErased
            return false
        }
        return true
    }

    /// Shows the edit at once, then sends it after the edits before it.
    private func apply(_ edit: AidenBotMemoryEdit) async -> String? {
        let before = memory
        if let optimistic = memory?.applying(edit) { memory = optimistic }
        editsInFlight += 1
        defer { editsInFlight -= 1 }
        let previous = lane
        let job = Task { @MainActor [weak self] () -> String? in
            await previous?.value
            guard let self else { return AidenBotMemoryCopy.notSaved }
            return await self.send(edit, restoring: before)
        }
        lane = Task { _ = await job.value }
        return await job.value
    }

    private func send(_ edit: AidenBotMemoryEdit, restoring before: AidenBotMemory?) async -> String? {
        let key: UUID
        if let retainedEdit, retainedEdit.edit == edit {
            key = retainedEdit.key
        } else {
            key = UUID()
            retainedEdit = (edit, key)
        }
        do {
            let updated = try await aidenBotWithin(.seconds(12)) { [transport, botID] in
                try await transport.editBotMemory(
                    botId: botID,
                    request: AidenBotMemoryEditRequest(edit: edit),
                    idempotencyKey: key
                )
            }
            retainedEdit = nil
            if updated.botId == botID { memory = updated }
            return nil
        } catch {
            if !aidenBotSessionFailureIsAmbiguous(error) { retainedEdit = nil }
            let message = error is CancellationError
                ? AidenBotMemoryCopy.notSaved
                : message(for: AidenBotMemoryEditFailure(error), edit: edit)
            // The Mac's view is the truth; without it, what showed before the edit.
            if await !load() { memory = before }
            return message
        }
    }

    private func message(for failure: AidenBotMemoryEditFailure, edit: AidenBotMemoryEdit) -> String {
        switch failure {
        case .blocked:
            return AidenBotMemoryCopy.blocked
        case .entryNotFound:
            return AidenBotMemoryCopy.entryChanged
        case .overBudget:
            let target: AidenBotMemoryTarget = switch edit {
            case let .replace(target, _, _), let .remove(target, _): target
            case .clear: .user
            }
            return AidenBotMemoryCopy.overBudget(group: AidenBotMemoryCopy.groupTitle(target, botName: botName))
        case .other:
            return AidenBotMemoryCopy.notSaved
        }
    }
}

/// The SD-card symbol Memory uses everywhere.
enum AidenBotMemorySymbol {
    static let name = "sdcard"
}

private struct AidenBotMemoryEditTarget: Identifiable {
    let target: AidenBotMemoryTarget
    let entry: AidenBotMemoryEntry

    var id: String { "\(target.rawValue)|\(entry.id)" }
}

/// Profile → Memory: "About you" and "{name}'s notes", each with a neutral
/// usage meter, swipe Edit and Delete, and Erase memory at the foot.
struct AidenBotMemoryView: View {
    @Bindable var model: AidenBotMemoryModel
    let canWrite: Bool

    @Environment(\.aidenPalette) private var palette
    @State private var editing: AidenBotMemoryEditTarget?
    @State private var isConfirmingErase = false

    var body: some View {
        content
            .navigationTitle(AidenBotMemoryCopy.title)
            .navigationBarTitleDisplayMode(.inline)
            .task { if model.memory == nil { await model.load() } }
            .refreshable { await model.load() }
            .sheet(item: $editing) { target in
                AidenBotMemoryEditSheet(model: model, target: target.target, entry: target.entry)
            }
            .confirmationDialog(
                AidenBotMemoryCopy.eraseConfirmation(botName: model.botName),
                isPresented: $isConfirmingErase,
                titleVisibility: .visible
            ) {
                Button(AidenBotMemoryCopy.eraseMemory, role: .destructive) {
                    Task { await model.erase() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(AidenBotMemoryCopy.cantBeUndone)
            }
            .alert(
                "Something Went Wrong",
                isPresented: Binding(
                    get: { model.errorMessage != nil },
                    set: { if !$0 { model.errorMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) { model.errorMessage = nil }
            } message: {
                Text(model.errorMessage ?? AidenBotMemoryCopy.notSaved)
            }
    }

    @ViewBuilder
    private var content: some View {
        if let memory = model.memory {
            List {
                Section {
                    Text(AidenBotMemoryCopy.description(botName: model.botName))
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                        .listRowBackground(Color.clear)
                }
                if memory.readable {
                    group(.user, in: memory)
                    group(.memory, in: memory)
                } else {
                    unreadable
                }
                Section {
                    Button(AidenBotMemoryCopy.eraseMemory, role: .destructive) {
                        isConfirmingErase = true
                    }
                    .disabled(!canWrite)
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas.ignoresSafeArea())
        } else if let error = model.loadError {
            ContentUnavailableView {
                Label(error, systemImage: AidenBotMemorySymbol.name)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
            .background(palette.canvas.ignoresSafeArea())
        } else {
            AidenBotMemorySkeletonView()
        }
    }

    private var unreadable: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Label(AidenBotMemoryCopy.unreadableTitle, systemImage: "exclamationmark.triangle")
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                Text(AidenBotMemoryCopy.unreadableDetail(botName: model.botName))
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
            .padding(.vertical, 4)
            .listRowBackground(palette.danger.opacity(0.1))
            .accessibilityElement(children: .combine)
        }
    }

    private func group(_ target: AidenBotMemoryTarget, in memory: AidenBotMemory) -> some View {
        let group = memory.group(target)
        return Section {
            if group.entries.isEmpty {
                Text(target == .user
                     ? AidenBotMemoryCopy.aboutYouEmpty(botName: model.botName)
                     : AidenBotMemoryCopy.notesEmpty(botName: model.botName))
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .listRowBackground(palette.raised)
            }
            ForEach(group.entries) { entry in
                Label {
                    Text(entry.text)
                        .foregroundStyle(palette.foreground)
                        .textSelection(.enabled)
                } icon: {
                    Image(systemName: AidenBotMemorySymbol.name)
                        .foregroundStyle(palette.secondary)
                        .accessibilityHidden(true)
                }
                .listRowBackground(palette.raised)
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if canWrite {
                        Button(AidenBotMemoryCopy.delete, role: .destructive) {
                            Task { await model.delete(target: target, entryId: entry.id) }
                        }
                        Button(AidenBotMemoryCopy.edit) {
                            editing = AidenBotMemoryEditTarget(target: target, entry: entry)
                        }
                        .tint(palette.secondary)
                    }
                }
                .contextMenu {
                    if canWrite {
                        Button(AidenBotMemoryCopy.edit, systemImage: "pencil") {
                            editing = AidenBotMemoryEditTarget(target: target, entry: entry)
                        }
                        Button(AidenBotMemoryCopy.delete, systemImage: "trash", role: .destructive) {
                            Task { await model.delete(target: target, entryId: entry.id) }
                        }
                    }
                }
            }
        } header: {
            Text(AidenBotMemoryCopy.groupTitle(target, botName: model.botName))
        } footer: {
            AidenBotMemoryUsageMeter(group: group)
        }
    }
}

/// Skeleton rows while Memory loads (R15): its shape, never a spinner.
private struct AidenBotMemorySkeletonView: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AidenBotSkeletonBlock(width: nil, height: 44, radius: 12, reduceMotion: reduceMotion)
            AidenBotSkeletonBlock(width: 120, height: 14, radius: 7, reduceMotion: reduceMotion)
            AidenBotSkeletonBlock(width: nil, height: 104, radius: 18, reduceMotion: reduceMotion)
            AidenBotSkeletonBlock(width: 140, height: 14, radius: 7, reduceMotion: reduceMotion)
            AidenBotSkeletonBlock(width: nil, height: 64, radius: 18, reduceMotion: reduceMotion)
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(palette.canvas.ignoresSafeArea())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading memory")
    }
}

/// A slim neutral meter and its "563 of 1,375 characters" line.
private struct AidenBotMemoryUsageMeter: View {
    let group: AidenBotMemoryGroup

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        let label = AidenBotMemoryCopy.usage(used: group.usedChars, limit: group.limitChars)
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.secondary.opacity(0.18))
                    Capsule()
                        .fill(palette.secondary)
                        .frame(width: proxy.size.width * group.fraction)
                }
            }
            .frame(height: 4)
            Text(label)
                .font(.caption)
                .foregroundStyle(palette.secondary)
        }
        .padding(.top, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

/// Edit one memory: a text editor, a 500-character count and Save.
private struct AidenBotMemoryEditSheet: View {
    let model: AidenBotMemoryModel
    let target: AidenBotMemoryTarget
    let entry: AidenBotMemoryEntry

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var text: String

    init(model: AidenBotMemoryModel, target: AidenBotMemoryTarget, entry: AidenBotMemoryEntry) {
        self.model = model
        self.target = target
        self.entry = entry
        _text = State(initialValue: entry.text)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var count: Int { trimmed.unicodeScalars.count }
    private var canSave: Bool {
        !trimmed.isEmpty && count <= AidenBotMemoryWire.maxEntryLength && trimmed != entry.text
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                TextEditor(text: $text)
                    .scrollContentBackground(.hidden)
                    .padding(12)
                    .frame(minHeight: 160, alignment: .top)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .accessibilityLabel(AidenBotMemoryCopy.groupTitle(target, botName: model.botName))
                Text("\(count) / \(AidenBotMemoryWire.maxEntryLength)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(count > AidenBotMemoryWire.maxEntryLength ? palette.danger : palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                Spacer(minLength: 0)
            }
            .padding(16)
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle(AidenBotMemoryCopy.edit)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    // The change shows at once; a failure comes back on the Memory page (R15).
                    Button(AidenBotMemoryCopy.save) {
                        model.saveInBackground(target: target, entryId: entry.id, text: text)
                        dismiss()
                    }
                    .disabled(!canSave)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Profile's "Memory" row: the SD card, the title, and a quiet count.
struct AidenBotMemoryRow: View {
    let summary: String?

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: AidenBotMemorySymbol.name)
                .foregroundStyle(palette.secondary)
                .accessibilityHidden(true)
            Text(AidenBotMemoryCopy.title)
                .foregroundStyle(palette.foreground)
            Spacer()
            if let summary {
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(palette.secondary)
                .accessibilityHidden(true)
        }
        .padding(16)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
