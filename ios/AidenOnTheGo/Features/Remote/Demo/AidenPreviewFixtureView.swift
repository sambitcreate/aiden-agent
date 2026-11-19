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
/// big block is drawn directly: a reply that long is shown as plain text.
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
#endif
