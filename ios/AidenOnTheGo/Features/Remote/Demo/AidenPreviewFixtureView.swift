#if DEBUG
import SwiftUI

/// `-AidenPreviewFixture`: one sandboxed HTML preview, so UI tests can tap and
/// scroll a real one before any screen shows previews. A tap on a link asks
/// "Open link?" the way the visual viewer does; the page also fires scripted
/// link clicks while it scrolls, which must never ask.
struct AidenPreviewFixtureView: View {
    @State private var pendingLink: URL?
    @State private var failed = false

    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains("-AidenPreviewFixture")
    }

    init() {
        // Only a tap may open the link gate here, whatever keyboard the
        // simulator reports.
        AidenSandboxedHTMLCoordinator.touchlessActivationOverride = false
    }

    var body: some View {
        AidenSandboxedHTMLView(
            html: Self.page,
            allowsScripts: true,
            themeCSS: nil,
            scrolls: true,
            onLinkOffer: { pendingLink = $0 },
            onFailure: { failed = true }
        )
        .overlay {
            if failed { Text("Preview failed") }
        }
        .alert(
            "Open link?",
            isPresented: Binding(
                get: { pendingLink != nil },
                set: { if !$0 { pendingLink = nil } }
            ),
            presenting: pendingLink
        ) { _ in
            Button("Cancel", role: .cancel) { pendingLink = nil }
        } message: { link in
            Text(link.absoluteString)
        }
    }

    private static let page = """
    <!doctype html><html><head>
    <style>body { font: 20px -apple-system; margin: 16px; } .gap { height: 2400px; }</style>
    </head><body>
    <p><a href="https://example.com/top">Top link</a></p>
    <div class="gap"></div>
    <p><a href="https://example.com/bottom">Bottom link</a></p>
    <a id="scripted" href="https://example.com/scrolled" style="display: none">Scripted</a>
    <script>
    addEventListener('scroll', () => document.getElementById('scripted').click());
    </script>
    </body></html>
    """
}

/// `-AidenSVGFixture`: a reply with an `svg` code block, then an SVG block just
/// under the 1 MiB View cap, so the drawing sheet can be checked by hand. The
/// big block is drawn directly, because a reply that long is shown as plain
/// text; its code is too long for the block to draw, so only View matters.
struct AidenSVGFixtureView: View {
    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains("-AidenSVGFixture")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                AidenMarkdownView(content: Self.reply)
                Text(verbatim: "Just under 1 MiB:")
                    .font(.headline)
                Text(verbatim: "Drawn outside a reply; its code is too long to show here, so the block below looks empty. Use View.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                AidenCodeBlockView(source: Self.bigSource, language: "svg")
                ForEach(0..<20, id: \.self) { index in
                    Text(verbatim: "Filler line \(index + 1)")
                }
            }
            .padding(16)
        }
    }

    private static let reply = """
    Here is the logo:

    ```svg
    <svg viewBox="0 0 120 80"><rect x="4" y="4" width="112" height="72" rx="12" fill="none" stroke="black" stroke-width="4"/><circle cx="40" cy="40" r="20" fill="#2a6df4"/><path d="M70 60 L90 20 L110 60 Z" fill="#f4a72a"/></svg>
    ```

    It has no namespace, so the preview adds one.
    """

    private static let bigSource: String = {
        let line = "<path d=\"M0 0 L120 80 L0 80 Z\" fill=\"none\" stroke=\"#2a6df4\" stroke-opacity=\"0.02\"/>\n"
        let head = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 80\">\n"
        let tail = "</svg>"
        let count = (AidenSVGPreview.maximumSourceBytes - head.utf8.count - tail.utf8.count) / line.utf8.count
        return head + String(repeating: line, count: count) + tail
    }()
}

/// `-AidenWorkspaceHTMLFixture`: the workspace file editor holding a cached
/// `.html` document with no paired computer, the way an offline document
/// opens. `-AidenWorkspaceHTMLFixtureRemoteImage` holds a page that names a
/// remote image instead, which must not load, and
/// `-AidenWorkspaceHTMLFixtureTruncated` one cut short by the size cap.
struct AidenWorkspaceHTMLFixtureView: View {
    let coordinator: AidenRemoteCoordinator
    @State private var model: AidenWorkspaceFilesModel
    @State private var isShowing = !Self.startsFromActivity

    /// `-AidenWorkspaceHTMLFixtureFromActivity`: starts on two "File written"
    /// lines, one in a workspace chat and one in a Bot chat. Tapping the
    /// workspace one goes through the chat's `./relative` link routing.
    private static var startsFromActivity: Bool {
        ProcessInfo.processInfo.arguments.contains("-AidenWorkspaceHTMLFixtureFromActivity")
    }

    static var isRequested: Bool {
        startsFromActivity
            || ProcessInfo.processInfo.arguments.contains("-AidenWorkspaceHTMLFixture")
            || ProcessInfo.processInfo.arguments.contains("-AidenWorkspaceHTMLFixtureRemoteImage")
            || ProcessInfo.processInfo.arguments.contains("-AidenWorkspaceHTMLFixtureTruncated")
    }

    init(coordinator: AidenRemoteCoordinator) {
        self.coordinator = coordinator
        AidenSandboxedHTMLCoordinator.touchlessActivationOverride = false
        let arguments = ProcessInfo.processInfo.arguments
        let remoteImage = arguments.contains("-AidenWorkspaceHTMLFixtureRemoteImage")
        let truncated = arguments.contains("-AidenWorkspaceHTMLFixtureTruncated")
        let model = AidenWorkspaceFilesModel(
            workspace: AidenWorkspace(
                id: "fixture", name: "Fixture", permission: .ask, hasFolder: true,
                isManagedWorktree: false, branchName: nil, repositoryName: nil, git: nil,
                createdAt: .now, updatedAt: .now, revision: "r1"
            ),
            owner: AidenRemoteRequestContext(instanceId: "fixture", deviceId: "phone", generation: 1, scope: .owner)
        )
        let path = remoteImage ? "site/remote.html" : truncated ? "site/big.html" : "site/report.html"
        let page = remoteImage ? Self.remoteImagePage : Self.inlinePage
        model.document = AidenWorkspaceFileDocument(
            id: path, displayPath: path, content: page, version: "1", truncated: truncated, warning: nil
        )
        model.draft = page
        model.isOfflineDocument = true
        _model = State(initialValue: model)
    }

    var body: some View {
        Group {
            if Self.startsFromActivity {
                activityLines
            } else {
                Color.clear
            }
        }
        .sheet(isPresented: $isShowing) {
            AidenWorkspaceFileEditorFixtureHost(coordinator: coordinator, model: model)
        }
    }

    private var activityLines: some View {
        let step = AidenAgentStep(
            id: "write", order: 0, kind: .tool, toolName: "write_file", label: "write_file",
            status: .completed, startedAt: 1, updatedAt: 2, finishedAt: 2, contentOffset: 0,
            durationMs: nil, target: nil, detail: "site/report.html", lineChanges: nil,
            producedFile: AidenProducedFile(relativePath: "site/report.html", operation: "written", bytes: 420)
        )
        return VStack(alignment: .leading, spacing: 16) {
            Text("Workspace chat").font(.headline)
            AidenActivityStepLine(step: step, shimmer: false)
                .environment(\.aidenOpensWorkspaceFileLinks, true)
            Text("Bot chat").font(.headline)
            AidenActivityStepLine(step: step, shimmer: false)
                .environment(\.aidenOpensWorkspaceFileLinks, false)
            Spacer()
        }
        .padding()
        .environment(\.openURL, OpenURLAction { url in
            guard AidenWorkspaceFileLink.path(url.relativeString) == model.document?.displayPath else { return .discarded }
            isShowing = true
            return .handled
        })
    }

    private static let inlinePage = """
    <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>.card { border-radius: 12px; padding: 12px; background: rgb(42, 109, 244); color: white; }</style>
    </head><body>
    <h1>Report</h1>
    <p class="card" id="status">Scripts off</p>
    <p>Plain text in the theme's colors. <a href="https://example.com/details">Details</a></p>
    <script>document.getElementById('status').textContent = 'Scripts ran';</script>
    </body></html>
    """

    private static let remoteImagePage = """
    <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
    <h1>Remote image</h1>
    <p>The picture below names https://example.com/photo.png and must not load.</p>
    <img src="https://example.com/photo.png" alt="Remote photo" width="200" height="120">
    <p>Text after the image.</p>
    </body></html>
    """
}
#endif
