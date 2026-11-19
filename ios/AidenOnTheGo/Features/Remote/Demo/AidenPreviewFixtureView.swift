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
#endif
