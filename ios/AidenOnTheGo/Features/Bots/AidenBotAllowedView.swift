import Observation
import SwiftUI

protocol AidenBotAllowedTransport: Sendable {
    func botAllowed(botId: String, cursor: String?) async throws -> AidenBotAllowedList
    func removeBotAllowed(botId: String, entryId: String) async throws -> AidenBotAllowedList
}
extension AidenRemoteClient: AidenBotAllowedTransport {}

@MainActor @Observable
final class AidenBotAllowedModel {
    let botID: String
    private let transport: any AidenBotAllowedTransport
    private let isCurrent: @MainActor () -> Bool
    private(set) var entries: [AidenBotAllowedEntry] = []
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var removing: String?
    private(set) var error: String?
    @ObservationIgnored private var generation = 0
    init(botID: String, transport: any AidenBotAllowedTransport, isCurrent: @escaping @MainActor () -> Bool = { true }) {
        self.botID = botID; self.transport = transport; self.isCurrent = isCurrent
    }
    var countSummary: String? { hasLoaded ? (entries.isEmpty ? "Nothing yet" : "\(entries.count)") : nil }
    func invalidate() { generation += 1; entries = []; hasLoaded = false; isLoading = false; removing = nil; error = nil }
    private func current(_ mark: Int) -> Bool { mark == generation && isCurrent() && !Task.isCancelled }
    /// Publish only a complete immutable cursor view, never a partial count.
    private func collect(_ first: AidenBotAllowedList, mark: Int) async throws -> [AidenBotAllowedEntry] {
        var page = first; var rows: [AidenBotAllowedEntry] = []; var ids = Set<String>(); var cursors = Set<String>()
        while true {
            guard current(mark), page.botId == botID else { throw CancellationError() }
            for row in page.entries {
                guard ids.insert(row.id).inserted else { throw AidenRemoteClientError.invalidResponse }
                rows.append(row)
            }
            guard let cursor = page.nextCursor else { return rows }
            guard cursors.insert(cursor).inserted, cursors.count <= 128 else { throw AidenRemoteClientError.invalidResponse }
            page = try await transport.botAllowed(botId: botID, cursor: cursor)
        }
    }
    func load() async {
        guard isCurrent() else { invalidate(); return }
        generation += 1; let mark = generation; isLoading = true; removing = nil; error = nil
        defer { if current(mark) { isLoading = false } }
        do {
            let first = try await transport.botAllowed(botId: botID, cursor: nil)
            let rows: [AidenBotAllowedEntry]
            do { rows = try await collect(first, mark: mark) }
            catch let AidenRemoteClientError.server(status, _) where status == 400 && current(mark) {
                // A stale/foreign snapshot is retried once from a fresh first page.
                rows = try await collect(try await transport.botAllowed(botId: botID, cursor: nil), mark: mark)
            }
            guard current(mark) else { return }; entries = rows; hasLoaded = true
        } catch { if current(mark) { self.error = "Allowed without asking couldn’t be loaded. Please try again." } }
    }
    func remove(_ id: String) async {
        guard isCurrent(), removing == nil, !isLoading, entries.contains(where: { $0.id == id }) else { return }
        generation += 1; let mark = generation; removing = id; error = nil
        defer { if current(mark) { removing = nil } }
        do {
            let first = try await transport.removeBotAllowed(botId: botID, entryId: id)
            let rows: [AidenBotAllowedEntry]
            do { rows = try await collect(first, mark: mark) }
            catch let AidenRemoteClientError.server(status, _) where status == 400 && current(mark) {
                rows = try await collect(try await transport.botAllowed(botId: botID, cursor: nil), mark: mark)
            }
            guard current(mark) else { return }; entries = rows; hasLoaded = true
        } catch { if current(mark) { self.error = "That entry wasn’t removed. Please try again." } }
    }
}

struct AidenBotAllowedView: View {
    @Bindable var model: AidenBotAllowedModel
    let botName: String
    let canWrite: Bool
    @Environment(\.aidenPalette) private var palette
    var body: some View {
        List {
            if let error = model.error {
                Section { Text(error).foregroundStyle(palette.danger); Button("Try Again") { Task { await model.load() } } }
            }
            if !model.hasLoaded {
                Text("Loading allowed actions…").foregroundStyle(palette.secondary)
            } else if model.entries.isEmpty {
                Text("\(botName) asks before changes in your apps and on websites. Choose Always allow for \(botName) on a card to stop a question you keep answering.")
                    .foregroundStyle(palette.secondary)
            }
            ForEach(model.entries) { entry in
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: entry.what).foregroundStyle(palette.foreground).textSelection(.enabled)
                    Text("Added \(entry.addedAt.date.formatted(date: .abbreviated, time: .omitted))").font(.footnote).foregroundStyle(palette.secondary)
                    if let uses = entry.uses { Text(uses == 0 ? "Not used yet" : "Used \(uses) \(uses == 1 ? "time" : "times")").font(.footnote).foregroundStyle(palette.secondary) }
                    if model.removing == entry.id { Text("Removing…").font(.footnote).foregroundStyle(palette.secondary) }
                }
                .listRowBackground(palette.raised)
                .swipeActions(allowsFullSwipe: false) {
                    Button("Remove", role: .destructive) { Task { await model.remove(entry.id) } }
                        .disabled(!canWrite || model.removing != nil || model.isLoading)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAction(named: "Remove") { if canWrite { Task { await model.remove(entry.id) } } }
            }
        }
        .scrollContentBackground(.hidden).background(palette.canvas.ignoresSafeArea())
        .navigationTitle("Allowed without asking").navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }.refreshable { await model.load() }
    }
}
