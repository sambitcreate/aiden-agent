import SwiftUI

struct AidenMacTranscriptionSettingsView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @State private var status: AidenSpeechStatus?
    @State private var errorMessage: String?
    @State private var isLoading = false

    private var downloadPollKey: String {
        status?.models.compactMap { model in
            model.download?.status == "downloading" ? "\(model.id):\(model.download?.percentage ?? 0)" : nil
        }.joined(separator: ",") ?? ""
    }

    var body: some View {
        List {
            if let status {
                Section {
                    LabeledContent("Engine", value: status.engine.ready ? "Ready" : "Unavailable")
                    if let engineError = status.engine.error {
                        Text(engineError).font(.caption).foregroundStyle(.red)
                    }
                }
                Section("Models") {
                    ForEach(status.models) { model in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .firstTextBaseline) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(model.name).font(.body.weight(.semibold))
                                    Text("\(model.sizeLabel) · \(model.languagesLabel)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                modelAction(model, status: status)
                            }
                            if let download = model.download, download.status == "downloading" {
                                ProgressView(value: Double(download.percentage), total: 100)
                                Text(download.phase == "extract" ? "Installing…" : "Downloading… \(download.percentage)%")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Text(model.description).font(.caption).foregroundStyle(.secondary)
                            if let failure = model.download?.error {
                                Text(failure).font(.caption).foregroundStyle(.red)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            } else if isLoading {
                ProgressView("Loading computer speech models…")
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Computer Transcription")
        .navigationBarTitleDisplayMode(.inline)
        .task { await refresh() }
        .task(id: downloadPollKey) {
            guard !downloadPollKey.isEmpty else { return }
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            await refresh()
        }
        .refreshable { await refresh() }
    }

    @ViewBuilder
    private func modelAction(_ model: AidenSpeechModel, status: AidenSpeechStatus) -> some View {
        if model.download?.status == "downloading" {
            Button("Cancel") { Task { await cancel(model.id) } }
        } else if model.installed && status.selectedModelId == model.id {
            Text("Selected").font(.caption.weight(.semibold)).foregroundStyle(.tint)
        } else if model.installed {
            Button("Use") { Task { await select(model.id) } }
        } else {
            Button("Download") { Task { await download(model.id) } }
        }
    }

    private func client() throws -> AidenRemoteClient {
        let context = try coordinator.requestContext()
        return try coordinator.remoteClient(for: context)
    }

    @MainActor
    private func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            status = try await client().speechStatus()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor private func download(_ id: String) async {
        do { status = try await client().downloadSpeechModel(id); errorMessage = nil }
        catch { errorMessage = error.localizedDescription }
    }

    @MainActor private func cancel(_ id: String) async {
        do { status = try await client().cancelSpeechModelDownload(id); errorMessage = nil }
        catch { errorMessage = error.localizedDescription }
    }

    @MainActor private func select(_ id: String) async {
        do { status = try await client().selectSpeechModel(id); errorMessage = nil }
        catch { errorMessage = error.localizedDescription }
    }
}
