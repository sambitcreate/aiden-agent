import SwiftUI

private struct AidenFolderLocation: Hashable {
    let label: String
    let location: String
    let context: AidenRemoteRequestContext
}

struct AidenFolderBrowserView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var coordinator: AidenRemoteCoordinator
    let onCreated: (AidenWorkspace) -> Void

    @State private var roots: [AidenBrowserRoot] = []
    @State private var context: AidenRemoteRequestContext?
    @State private var path: [AidenFolderLocation] = []
    @State private var errorMessage: String?
    @State private var isLoading = true

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if isLoading {
                    ProgressView("Loading approved folders…")
                } else if roots.isEmpty {
                    ContentUnavailableView(
                        "No Approved Folders",
                        systemImage: "folder.badge.questionmark",
                        description: Text("Add an approved root in Aiden Agent → Settings → Connections, then try again.")
                    )
                } else {
                    List(roots) { root in
                        if let context {
                            NavigationLink(value: AidenFolderLocation(
                                label: root.label,
                                location: root.location,
                                context: context
                            )) {
                                Label(root.label, systemImage: "folder.fill")
                            }
                        }
                    }
                }
            }
            .navigationTitle("Add Desktop Folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .navigationDestination(for: AidenFolderLocation.self) { location in
                AidenFolderPageView(
                    coordinator: coordinator,
                    location: location,
                    onCreated: onCreated
                )
            }
            .task { await loadRoots() }
            .alert("Couldn’t Browse Folders", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("Retry") { Task { await loadRoots() } }
                Button("Cancel", role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "Try again.")
            }
        }
    }

    private func loadRoots() async {
        isLoading = true
        defer { isLoading = false }
        let requestContext: AidenRemoteRequestContext
        do {
            requestContext = try coordinator.requestContext()
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        do {
            let loadedRoots = try await coordinator.browserRoots(context: requestContext)
            guard coordinator.isCurrent(requestContext) else { return }
            context = requestContext
            path = []
            roots = loadedRoots
        } catch {
            guard coordinator.isCurrent(requestContext) else { return }
            errorMessage = error.localizedDescription
        }
    }
}

private struct AidenFolderPageView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let location: AidenFolderLocation
    let onCreated: (AidenWorkspace) -> Void

    @State private var page: AidenBrowserPage?
    @State private var isLoading = true
    @State private var isLoadingMore = false
    @State private var errorMessage: String?
    @State private var hapticScope = UUID()

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading folders…")
            } else if let page {
                List {
                    if !page.breadcrumbs.isEmpty {
                        Section {
                            Text(page.breadcrumbs.map(\.label).joined(separator: " › "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Section("Folders") {
                        ForEach(page.entries) { entry in
                            NavigationLink(value: AidenFolderLocation(
                                label: entry.name,
                                location: entry.location,
                                context: location.context
                            )) {
                                Label(entry.name, systemImage: "folder")
                            }
                        }
                        if let nextCursor = page.nextCursor {
                            Button {
                                Task { await loadMore(cursor: nextCursor) }
                            } label: {
                                if isLoadingMore { ProgressView() } else { Text("Load More") }
                            }
                            .disabled(isLoadingMore)
                        }
                    }
                }
            } else {
                ContentUnavailableView("Folder Unavailable", systemImage: "exclamationmark.folder")
            }
        }
        .navigationTitle(location.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Add This Folder") {
                    Task {
                        let outcome = await coordinator.createSelectedFolderWorkspaceOutcome(
                            context: location.context,
                            location: location.location,
                            name: nil
                        )
                        if case .success(let workspace) = outcome {
                            onCreated(workspace)
                        } else if outcome.isDefinitiveFailure, coordinator.isCurrent(location.context) {
                            errorMessage = coordinator.presentedError
                            coordinator.haptics.play(.error, scope: hapticScope)
                        }
                    }
                }
                .disabled(coordinator.isMutating || !coordinator.isCurrent(location.context))
            }
        }
        .onAppear { coordinator.haptics.activate(scope: hapticScope) }
        .onDisappear { coordinator.haptics.deactivate(scope: hapticScope) }
        .task(id: location.location) { await load() }
        .alert("Couldn’t Add Folder", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("Retry") { Task { await load() } }
            Button("Cancel", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "The selection may have expired. Browse the folder again and retry.")
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let loadedPage = try await coordinator.browserChildren(
                context: location.context,
                location: location.location
            )
            guard coordinator.isCurrent(location.context) else { return }
            page = loadedPage
        } catch {
            guard coordinator.isCurrent(location.context) else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func loadMore(cursor: String) async {
        guard let page else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let next = try await coordinator.browserChildren(
                context: location.context,
                location: location.location,
                cursor: cursor
            )
            guard coordinator.isCurrent(location.context) else { return }
            self.page = AidenBrowserPage(
                rootId: page.rootId,
                label: page.label,
                breadcrumbs: page.breadcrumbs,
                entries: page.entries + next.entries,
                nextCursor: next.nextCursor
            )
        } catch {
            guard coordinator.isCurrent(location.context) else { return }
            errorMessage = error.localizedDescription
        }
    }
}
