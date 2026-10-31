import Observation
import SwiftUI

/// Revision 48 (`chat:jobs`): what the agent left running for a chat on the
/// Mac (a dev server, a watcher, a long test run). The words match the Mac
/// and Android.
enum AidenBackgroundJobCopy {
    /// "45s", "2m", "1h 5m".
    static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int((now.timeIntervalSince(start)).rounded()))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    static func status(_ job: AidenBackgroundJob, now: Date) -> String {
        switch job.state {
        case .running:
            return "Running for \(elapsed(from: job.startedAt, to: now))"
        case .stopped:
            return job.endReason == "output-limit" ? "Stopped: too much output" : "Stopped"
        case .exited, .failed:
            if job.fromCommand { return "Ended" }
            guard let exitCode = job.exitCode else { return job.state == .failed ? "Failed" : "Ended" }
            return exitCode == 0 ? "Finished" : "Failed with code \(exitCode)"
        }
    }

    /// The addresses a running job serves. They are on the Mac, so the phone
    /// shows them as text rather than opening them.
    static func addresses(_ job: AidenBackgroundJob) -> String? {
        guard job.state == .running, !job.ports.isEmpty else { return nil }
        return job.ports.map { "localhost:\($0)" }.joined(separator: ", ") + " on your Mac"
    }

    /// The chip above the composer: shown only while something runs.
    static func chip(running: Int) -> String? {
        running > 0 ? "\(running) in background" : nil
    }

    static func chipAccessibilityLabel(running: Int) -> String {
        running == 1 ? "1 background job running" : "\(running) background jobs running"
    }
}

/// The job routes, so the model can be driven without a Mac.
protocol AidenBackgroundJobTransport: Sendable {
    func backgroundJobs(chatId: String) async throws -> AidenBackgroundJobs
    func stopBackgroundJob(chatId: String, jobId: String) async throws -> AidenBackgroundJobs
}

extension AidenRemoteClient: AidenBackgroundJobTransport {}

@MainActor
@Observable
final class AidenBackgroundJobsModel {
    private(set) var jobs: [AidenBackgroundJob] = []
    private(set) var stoppingJobIds: Set<String> = []
    private(set) var errorMessage: String?
    @ObservationIgnored private var chatId: String?

    var runningCount: Int { jobs.filter { $0.state == .running }.count }

    /// Reads the chat's jobs again. A Mac without `chat:jobs`, or a failed
    /// read, shows nothing: the list is a convenience, never the only way to
    /// stop a job (the Mac shows it too).
    func refresh(chatId: String, transport: AidenBackgroundJobTransport?) async {
        if self.chatId != chatId {
            self.chatId = chatId
            jobs = []
            stoppingJobIds = []
            errorMessage = nil
        }
        guard let transport else {
            jobs = []
            return
        }
        guard let list = try? await transport.backgroundJobs(chatId: chatId), self.chatId == chatId else { return }
        jobs = list.jobs
    }

    /// Stops one job; the Mac answers once it has ended. A job the Mac no
    /// longer has (it ended, or the Mac restarted) re-reads the list.
    func stop(_ jobId: String, transport: AidenBackgroundJobTransport?) async {
        guard let chatId, let transport, !stoppingJobIds.contains(jobId) else { return }
        stoppingJobIds.insert(jobId)
        errorMessage = nil
        defer { stoppingJobIds.remove(jobId) }
        do {
            let list = try await transport.stopBackgroundJob(chatId: chatId, jobId: jobId)
            if self.chatId == chatId { jobs = list.jobs }
        } catch AidenRemoteClientError.server(let statusCode, _) where statusCode == 404 {
            await refresh(chatId: chatId, transport: transport)
        } catch {
            if self.chatId == chatId { errorMessage = error.localizedDescription }
        }
    }
}

/// "2 in background" beside the composer's other chips; opens the list.
struct AidenBackgroundJobsChip: View {
    let running: Int
    let action: () -> Void

    var body: some View {
        if let title = AidenBackgroundJobCopy.chip(running: running) {
            Button(action: action) {
                AidenProgressChipLabel(systemImage: "terminal", title: title, stale: false)
            }
            .buttonStyle(.plain)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .accessibilityLabel(Text(AidenBackgroundJobCopy.chipAccessibilityLabel(running: running)))
            .accessibilityHint(Text("Opens background jobs"))
        }
    }
}

struct AidenBackgroundJobsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette

    let model: AidenBackgroundJobsModel
    let canStop: Bool
    let onStop: (String) -> Void

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                List {
                    ForEach(model.jobs) { job in
                        row(job, now: context.date)
                    }
                }
                .overlay {
                    if model.jobs.isEmpty {
                        ContentUnavailableView("Nothing in the background", systemImage: "terminal")
                    }
                }
                // Pinned under the rows, so a failed Stop's message is seen however long the list is.
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let errorMessage = model.errorMessage {
                            Text(errorMessage).foregroundStyle(palette.danger)
                        }
                        Text("These run on your Mac. Open an address in a browser there.")
                            .foregroundStyle(palette.secondary)
                    }
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                    .background(.bar)
                }
            }
            .navigationTitle("Background jobs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(_ job: AidenBackgroundJob, now: Date) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: job.state == .running ? "terminal" : "terminal.fill")
                .foregroundStyle(job.state == .running ? palette.accent : palette.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(job.label)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(2)
                Text(AidenBackgroundJobCopy.status(job, now: now))
                    .font(.footnote)
                    .foregroundStyle(job.state == .failed && !job.fromCommand ? palette.danger : palette.secondary)
                if let addresses = AidenBackgroundJobCopy.addresses(job) {
                    Text(addresses)
                        .font(.footnote.monospaced())
                        .foregroundStyle(palette.secondary)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 8)
            if job.state == .running, canStop {
                Button("Stop", role: .destructive) { onStop(job.id) }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .disabled(model.stoppingJobIds.contains(job.id))
                    .accessibilityLabel(Text("Stop \(job.label)"))
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }
}
