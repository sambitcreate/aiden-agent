import Foundation
import SwiftUI

/// Draws a finished `svg` code block as a picture. The drawing is an `<img>`
/// of the source, so it runs no script and fetches nothing; the sandboxed
/// preview's script switch and network block are belts and braces.
enum AidenSVGPreview {
    /// Bigger sources get no View button, so megabytes of path data never
    /// reach the parser or the web view.
    static let maximumSourceBytes = 1_048_576

    private static let svgNamespace = "http://www.w3.org/2000/svg"

    /// A closed fence (its source is final, even mid-reply) whose language is
    /// `svg` and whose source is not blank and at most 1 MiB of UTF-8.
    static func offersView(language: String?, source: String, isOpen: Bool) -> Bool {
        guard !isOpen, language?.lowercased() == "svg" else { return false }
        guard source.utf8.count <= maximumSourceBytes else { return false }
        return source.contains { !$0.isWhitespace }
    }

    /// The preview page for `source`, or nil when it is not a well-formed SVG
    /// document. Parses the whole source, so call it off the main actor.
    static func document(for source: String) -> String? {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let root = rootElement(of: trimmed), root.name == "svg" else { return nil }
        let svg: String
        switch root.namespace {
        case svgNamespace:
            svg = trimmed
        case nil:
            // A standalone `image/svg+xml` image draws blank without it. An
            // explicit `xmlns=""` is not SVG's, and a second one is malformed.
            guard let insertion = rootTagNameEnd(in: trimmed),
                  !declaresDefaultNamespace(trimmed[insertion...]) else { return nil }
            svg = String(trimmed[..<insertion]) + " xmlns=\"\(svgNamespace)\"" + String(trimmed[insertion...])
        default:
            return nil
        }
        let encoded = Data(svg.utf8).base64EncodedString()
        // `#fff` is content paper in light and dark: agent SVGs usually draw
        // black on a transparent background.
        return """
        <!doctype html><html><head>\
        <meta name="viewport" content="width=device-width, initial-scale=1">\
        <style>\
        html,body{margin:0;background:transparent}\
        body{padding:16px}\
        .paper{background:#fff;border-radius:12px;padding:12px}\
        img{display:block;max-width:100%;height:auto;margin:0 auto}\
        </style></head><body>\
        <div class="paper"><img src="data:image/svg+xml;base64,\(encoded)" alt="Drawing"></div>\
        </body></html>
        """
    }

    private struct Root {
        let name: String
        let namespace: String?
    }

    private static func rootElement(of source: String) -> Root? {
        guard !source.isEmpty else { return nil }
        let parser = XMLParser(data: Data(source.utf8))
        parser.shouldProcessNamespaces = true
        parser.shouldResolveExternalEntities = false
        let reader = RootReader()
        parser.delegate = reader
        guard parser.parse(), let name = reader.name else { return nil }
        return Root(name: name, namespace: reader.namespace)
    }

    /// Where the root's `<svg` ends: past any prolog, comments, processing
    /// instructions and doctype. Only called once the parser has accepted the
    /// source and found an unprefixed `svg` root.
    private static func rootTagNameEnd(in source: String) -> String.Index? {
        var index = source.startIndex
        while let open = source[index...].firstIndex(of: "<") {
            let rest = source[open...]
            let skipTo: String?
            if rest.hasPrefix("<!--") {
                skipTo = "-->"
            } else if rest.hasPrefix("<?") {
                skipTo = "?>"
            } else if rest.hasPrefix("<!") {
                skipTo = ">"
            } else {
                skipTo = nil
            }
            if let skipTo {
                guard let end = rest.range(of: skipTo) else { return nil }
                index = end.upperBound
                continue
            }
            guard rest.hasPrefix("<svg") else { return nil }
            let nameEnd = source.index(open, offsetBy: 4)
            guard nameEnd < source.endIndex else { return nil }
            let next = source[nameEnd]
            return next.isWhitespace || next == ">" || next == "/" ? nameEnd : nil
        }
        return nil
    }

    /// Whether the root start tag that begins at `attributes` (just past
    /// `<svg`) has an `xmlns` attribute of its own.
    private static func declaresDefaultNamespace(_ attributes: Substring) -> Bool {
        var quote: Character?
        var tag = ""
        for character in attributes {
            if let open = quote {
                if character == open { quote = nil }
                tag.append(" ")
                continue
            }
            if character == ">" { break }
            if character == "\"" || character == "'" { quote = character }
            tag.append(character)
        }
        return tag.range(of: #"(^|\s)xmlns\s*="#, options: .regularExpression) != nil
    }

    /// Reads the root element and, while the rest parses, stops as soon as
    /// the task that called it is cancelled.
    private final class RootReader: NSObject, XMLParserDelegate {
        var name: String?
        var namespace: String?

        func parser(
            _ parser: XMLParser,
            didEndElement elementName: String,
            namespaceURI: String?,
            qualifiedName: String?
        ) {
            if Task.isCancelled { parser.abortParsing() }
        }

        func parser(
            _ parser: XMLParser,
            didStartElement elementName: String,
            namespaceURI: String?,
            qualifiedName: String?,
            attributes: [String: String] = [:]
        ) {
            if Task.isCancelled { parser.abortParsing() }
            guard name == nil else { return }
            name = elementName
            namespace = namespaceURI.flatMap { $0.isEmpty ? nil : $0 }
        }
    }
}

/// The sheet behind a code block's View button: the drawing on white paper,
/// pinch-zoomable, or a plain failure note. The code block stays as it was.
struct AidenSVGDrawingSheet: View {
    let source: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var phase = Phase.loading

    private enum Phase: Equatable {
        case loading
        case drawing(String)
        case failed
    }

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(palette.canvas.ignoresSafeArea())
                .navigationTitle("Drawing")
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(palette.canvas, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .task {
            let source = source
            // A detached task doesn't inherit cancellation, so closing the
            // sheet cancels the parse by hand.
            let parse = Task.detached(priority: .userInitiated) {
                AidenSVGPreview.document(for: source)
            }
            let page = await withTaskCancellationHandler {
                await parse.value
            } onCancel: {
                parse.cancel()
            }
            guard !Task.isCancelled else { return }
            phase = page.map(Phase.drawing) ?? .failed
        }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            ProgressView()
                .tint(palette.secondary)
                .accessibilityLabel("Loading drawing")
        case .drawing(let page):
            AidenSandboxedHTMLView(
                html: page,
                allowsScripts: false,
                themeCSS: nil,
                scrolls: true,
                onLinkOffer: { _ in },
                onFailure: { phase = .failed }
            )
            .ignoresSafeArea(edges: .bottom)
        case .failed:
            VStack(spacing: 14) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.title2)
                    .foregroundStyle(palette.warning)
                    .accessibilityHidden(true)
                Text("Couldn't draw this SVG.")
                    .font(.callout)
                    .foregroundStyle(palette.foreground)
                    .multilineTextAlignment(.center)
            }
            .padding(24)
        }
    }
}
