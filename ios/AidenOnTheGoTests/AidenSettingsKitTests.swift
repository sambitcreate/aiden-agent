import SwiftUI
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenSettingsKitTests: XCTestCase {
    private let palette = AidenThemeCatalog.palette(preset: .slate, scheme: .light)

    private var everyPalette: [(String, AidenPalette)] {
        AidenThemePresetID.allCases.flatMap { preset in
            [ColorScheme.light, .dark].map { ("\(preset)/\($0)", AidenThemeCatalog.palette(preset: preset, scheme: $0)) }
        }
    }

    private typealias Box = (minX: Int, maxX: Int, minY: Int, maxY: Int)

    /// The drawn image as rows of RGBA bytes.
    private struct Bitmap {
        let width: Int
        let height: Int
        let bytes: [UInt8]

        func rgb(_ x: Int, _ y: Int) -> [Int] {
            let i = (y * width + x) * 4
            return [Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2])]
        }

        func matches(_ x: Int, _ y: Int, _ hex: String, tolerance: Int = 3) -> Bool {
            zip(rgb(x, y), Self.rgb(hex)).allSatisfy { abs($0 - $1) <= tolerance }
        }

        /// The bounds of the pixels that pass `test`, or nil if none do.
        func bounds(where test: (Int, Int) -> Bool) -> Box? {
            var box: Box?
            for y in 0..<height {
                for x in 0..<width where test(x, y) {
                    box = (min(box?.minX ?? x, x), max(box?.maxX ?? x, x), min(box?.minY ?? y, y), max(box?.maxY ?? y, y))
                }
            }
            return box
        }

        static func rgb(_ hex: String) -> [Int] {
            let value = Int(hex.dropFirst(), radix: 16) ?? 0
            return [(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]
        }
    }

    private func draw<V: View>(_ view: V, palette: AidenPalette? = nil, scale: CGFloat = 1) throws -> Bitmap {
        let renderer = ImageRenderer(content: view
            .environment(\.aidenPalette, palette ?? self.palette)
            .environment(\.displayScale, scale))
        renderer.scale = scale
        let image = try XCTUnwrap(renderer.cgImage, "drew nothing")
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let context = try XCTUnwrap(CGContext(
            data: &bytes, width: image.width, height: image.height, bitsPerComponent: 8,
            bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return Bitmap(width: image.width, height: image.height, bytes: bytes)
    }

    /// Draws `view` in an on-screen window at 1x, for views (a scroll view)
    /// that an `ImageRenderer` does not draw.
    private func drawInWindow<V: View>(_ view: V, size: CGSize) throws -> Bitmap {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "no window scene")
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.isHidden = false
        defer { window.isHidden = true }
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let cgImage = try XCTUnwrap(image.cgImage)
        var bytes = [UInt8](repeating: 0, count: cgImage.width * cgImage.height * 4)
        let context = try XCTUnwrap(CGContext(
            data: &bytes, width: cgImage.width, height: cgImage.height, bitsPerComponent: 8,
            bytesPerRow: cgImage.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
        return Bitmap(width: cgImage.width, height: cgImage.height, bytes: bytes)
    }

    // MARK: Type scale

    /// The in-app Text size moves every step with it, and the steps keep their
    /// order at every size.
    func testEveryTypeStepFollowsTheInAppTextSizeAndKeepsItsOrder() {
        for size in 12...18 {
            let sizes = Dictionary(uniqueKeysWithValues: AidenTypeScale.allCases.map { ($0, $0.pointSize(uiFontSize: size)) })
            XCTAssertEqual(sizes[.rowTitle], CGFloat(size), "a row title is the app's body text")
            XCTAssertGreaterThan(sizes[.statHero]!, sizes[.rowTitle]!)
            XCTAssertLessThan(sizes[.sectionCaption]!, sizes[.rowTitle]!)
            XCTAssertLessThan(sizes[.chipLabel]!, sizes[.rowTitle]!)
            XCTAssertLessThanOrEqual(sizes[.footnote]!, sizes[.rowValue]!)
            if size > 12 {
                for step in AidenTypeScale.allCases {
                    XCTAssertGreaterThanOrEqual(step.pointSize(uiFontSize: size), step.pointSize(uiFontSize: size - 1), "\(step)")
                }
            }
        }
    }

    /// A row title set with `.aidenType` grows with the phone's text size and
    /// with the in-app Text size.
    func testATypeStepDrawsLargerAtALargerTextSize() throws {
        func height(_ dynamicType: DynamicTypeSize, uiFontSize: Int) throws -> Int {
            try draw(
                Text("Settings").aidenType(.rowTitle)
                    .fixedSize()
                    .environment(\.dynamicTypeSize, dynamicType)
                    .environment(\.aidenUIFontSize, uiFontSize)
            ).height
        }
        let base = try height(.large, uiFontSize: 14)
        let largerType = try height(.accessibility3, uiFontSize: 14)
        let largerSetting = try height(.large, uiFontSize: 18)
        XCTAssertGreaterThan(largerType, base, "Dynamic Type")
        XCTAssertGreaterThan(largerSetting, base, "in-app Text size")
    }

    /// At the largest accessibility size the Humanist face grows as much as
    /// the system face, not twice over.
    func testTheHumanistFaceScalesOnceAtTheLargestTextSize() throws {
        func height(_ font: AidenUIFontID) throws -> Double {
            Double(try draw(
                Text("Settings").aidenType(.rowTitle)
                    .fixedSize()
                    .environment(\.dynamicTypeSize, .accessibility5)
                    .environment(\.aidenUIFont, font)
            ).height)
        }
        let system = try height(.system)
        let humanist = try height(.humanist)
        XCTAssertLessThan(humanist, system * 1.5, "Humanist \(humanist) against system \(system)")
        XCTAssertGreaterThan(humanist, system / 1.5, "Humanist \(humanist) against system \(system)")
    }

    /// A face at a given size draws at that size whatever the phone's text
    /// size: callers scale first, so the face must not scale again. This is
    /// the app-wide typography modifier's path as well as the kit's.
    func testAnInAppFaceDrawsAtExactlyTheSizeItIsGiven() throws {
        for font in AidenUIFontID.allCases {
            func height(_ dynamicType: DynamicTypeSize) throws -> Int {
                try draw(
                    Text("Hg").font(font.font(size: 20))
                        .fixedSize()
                        .environment(\.dynamicTypeSize, dynamicType)
                ).height
            }
            let large = try height(.large)
            let accessibility = try height(.accessibility5)
            XCTAssertLessThanOrEqual(abs(large - accessibility), 1, "\(font): \(large) at Large, \(accessibility) at AX5")
        }
    }

    // MARK: Page and card

    /// A card always reads as a surface on its page: one tonal step apart in
    /// every theme, with no outline to carry it.
    func testACardStandsOffItsPageInEveryTheme() {
        for (name, p) in everyPalette {
            let ratio = Color.contrastRatio(AidenSettingsTokens.cardFillHex(p), AidenSettingsTokens.pageBackgroundHex(p))
            XCTAssertGreaterThanOrEqual(ratio, AidenSettingsTokens.cardToPageContrast, name)
        }
    }

    /// The page draws its background around a card of the card fill, in the
    /// theme whose canvas is the card's own white.
    func testTheGroupedPageDrawsTheCardOnThePageBackground() throws {
        let p = AidenThemeCatalog.palette(preset: .monochrome, scheme: .light)
        // The page scrolls, which an ImageRenderer leaves blank, so this one
        // is drawn in a window.
        let bitmap = try drawInWindow(
            AidenLargeTitlePage("Usage") {
                AidenSettingsSection { Color.clear.frame(height: 60) }
            }
            .environment(\.aidenPalette, p),
            size: CGSize(width: 320, height: 200)
        )
        // Wherever the safe area puts it, some line holds the card in the
        // middle and the page at the edge, outside the page padding.
        let cardLines = (0..<bitmap.height).filter { bitmap.matches(160, $0, AidenSettingsTokens.cardFillHex(p)) }
        XCTAssertGreaterThanOrEqual(cardLines.count, 50, "a 60pt card; the middle column reads \(bitmap.rgb(160, bitmap.height / 2))")
        for y in cardLines {
            XCTAssertTrue(bitmap.matches(4, y, AidenSettingsTokens.pageBackgroundHex(p)), "page beside the card at \(y): \(bitmap.rgb(4, y))")
        }
    }

    /// The secondary ink, which draws chevrons and an empty heatmap day,
    /// holds 3:1 on a card in every theme.
    func testSecondaryMarksHoldThreeToOneOnACardInEveryTheme() {
        for (name, p) in everyPalette {
            XCTAssertGreaterThanOrEqual(Color.contrastRatio(p.secondaryHex, AidenSettingsTokens.cardFillHex(p)), 3, name)
        }
    }

    /// A card draws one separator between each pair of rows, none above the
    /// first or below the last, and no outline.
    func testAGroupedCardSeparatesItsRowsAndHasNoOutline() throws {
        let bitmap = try draw(
            AidenGroupedCard {
                Color.clear.frame(width: 200, height: 40)
                Color.clear.frame(width: 200, height: 40)
                Color.clear.frame(width: 200, height: 40)
            }
        )
        let x = bitmap.width / 2
        var runs = 0
        var inRun = false
        for y in 0..<bitmap.height {
            let isCard = bitmap.matches(x, y, palette.raisedHex, tolerance: 2)
            if !isCard && !inRun { runs += 1 }
            inRun = !isCard
        }
        XCTAssertEqual(runs, 2, "three rows, two separators")
        XCTAssertTrue(bitmap.matches(x, 0, palette.raisedHex), "an outline along the top")
        XCTAssertTrue(bitmap.matches(x, bitmap.height - 1, palette.raisedHex), "an outline along the bottom")
    }

    /// A one-row card draws no separator at all.
    func testAOneRowCardDrawsNoSeparator() throws {
        let bitmap = try draw(
            AidenGroupedCard { Color.clear.frame(width: 200, height: 40) }
        )
        let x = bitmap.width / 2
        XCTAssertTrue((0..<bitmap.height).allSatisfy { bitmap.matches(x, $0, palette.raisedHex, tolerance: 2) })
    }

    /// The separator under an icon row starts at its title, past the icon
    /// column; under a text-only row it starts at the row padding.
    func testEachSeparatorStartsAtItsOwnRowsTitle() throws {
        let bitmap = try draw(
            AidenGroupedCard {
                AidenSettingsRow(icon: "gearshape", title: "General")
                AidenSettingsRow(title: "Name")
                AidenSettingsRow(title: "Email")
            }
            .frame(width: 320)
        )
        // Probe mid-card: clear of the titles and of the rounded corners.
        let probe = bitmap.width / 2
        var separatorRows: [Int] = []
        var previous = -10
        for y in 0..<bitmap.height where !bitmap.matches(probe, y, palette.raisedHex, tolerance: 2) {
            if y > previous + 1 { separatorRows.append(y) }
            previous = y
        }
        XCTAssertEqual(separatorRows.count, 2, "three rows, two separators")
        guard separatorRows.count == 2 else { return }
        let starts = separatorRows.map { y in
            (0..<bitmap.width).first { !bitmap.matches($0, y, palette.raisedHex, tolerance: 2) } ?? -1
        }
        XCTAssertEqual(starts[0], Int(AidenSettingsTokens.separatorLeadingInset), accuracy: 1, "under the icon row")
        XCTAssertEqual(starts[1], Int(AidenSettingsTokens.textRowSeparatorInset), accuracy: 1, "under the text row")
    }

    // MARK: Rows

    /// At an accessibility text size a row's value moves under its title, so
    /// neither is cut short; at the default size they share a line.
    func testARowStacksItsValueUnderItsTitleAtAccessibilitySizes() throws {
        func boxes(_ dynamicType: DynamicTypeSize) throws -> (title: Box, value: Box) {
            func row(_ accessory: AidenSettingsAccessory) throws -> Bitmap {
                try draw(
                    AidenSettingsRow(title: "Theme", accessory: accessory)
                        .frame(width: 320)
                        .background(palette.raised)
                        .environment(\.dynamicTypeSize, dynamicType)
                )
            }
            let titleOnly = try row(.none)
            let withValue = try row(.value("Slate"))
            let title = try XCTUnwrap(titleOnly.bounds { !titleOnly.matches($0, $1, palette.raisedHex, tolerance: 8) })
            let value = try XCTUnwrap(withValue.bounds { x, y in
                !withValue.matches(x, y, palette.raisedHex, tolerance: 8)
                    && (y >= titleOnly.height || titleOnly.matches(x, y, palette.raisedHex, tolerance: 8))
            })
            return (title, value)
        }
        let large = try boxes(.large)
        XCTAssertGreaterThan(large.value.minX, large.title.maxX, "the value sits after the title")
        XCTAssertLessThan(large.value.minY, large.title.maxY, "on the title's line")

        let accessibility = try boxes(.accessibility5)
        XCTAssertGreaterThan(accessibility.value.minY, accessibility.title.maxY, "the value sits under the title")
    }

    // MARK: Status chip

    /// A chip's capsule is its tone at the chip opacity right out to its
    /// edge, in light and dark and dimmed: a soft fill, with no 1pt border.
    func testAStatusChipIsASoftFillWithNoBorder() throws {
        for scheme in [ColorScheme.light, .dark] {
            let p = AidenThemeCatalog.palette(preset: .slate, scheme: scheme)
            for tone in AidenStatusTone.allCases {
                for isDimmed in [false, true] {
                    // 10pt of ground on each side, drawn at 2x: the capsule
                    // starts at pixel 20 on the top and the left.
                    let bitmap = try draw(
                        AidenStatusChip("Paused", tone: tone, isDimmed: isDimmed)
                            .padding(10)
                            .background(p.canvas),
                        palette: p,
                        scale: 2
                    )
                    let tint = isDimmed ? p.secondaryHex : tone.fillHex(p)
                    let fill = Color.mixHex(p.canvasHex, tint, fraction: AidenPalette.statusChipFillOpacity)
                    let name = "\(scheme) \(tone)\(isDimmed ? " dimmed" : "")"
                    let midX = bitmap.width / 2
                    let midY = bitmap.height / 2
                    for y in [20, 21] {
                        XCTAssertTrue(bitmap.matches(midX, y, fill, tolerance: 4), "\(name): top edge row \(y) \(bitmap.rgb(midX, y)) vs \(fill)")
                    }
                    XCTAssertTrue(bitmap.matches(midX, 19, p.canvasHex, tolerance: 4), "\(name): just above the top edge")
                    XCTAssertTrue(bitmap.matches(21, midY, fill, tolerance: 4), "\(name): left end \(bitmap.rgb(21, midY)) vs \(fill)")
                    XCTAssertTrue(bitmap.matches(19, midY, p.canvasHex, tolerance: 4), "\(name): just left of the end")
                }
            }
        }
    }

    /// A neutral chip's words read at 4.5:1 on their own capsule, on the page
    /// and on a card, in every theme. (The coloured tones are covered by the
    /// palette's own text-tint tests.)
    func testANeutralChipLabelReadsOnItsFillInEveryTheme() {
        for (name, p) in everyPalette {
            for ground in [AidenSettingsTokens.pageBackgroundHex(p), AidenSettingsTokens.cardFillHex(p)] {
                let fill = Color.mixHex(ground, AidenStatusTone.neutral.fillHex(p), fraction: AidenPalette.statusChipFillOpacity)
                XCTAssertGreaterThanOrEqual(Color.contrastRatio(AidenStatusTone.neutral.textHex(p), fill), 4.5, "\(name) on \(ground)")
            }
        }
    }

    // MARK: Pill segmented control

    /// VoiceOver's swipe moves one option at a time and stops at the ends.
    func testThePillStepsOneOptionAtATimeAndStopsAtTheEnds() {
        let options = ["Daily", "Weekly", "Monthly"]
        typealias Pill = AidenPillSegmentedControl<String>
        XCTAssertEqual(Pill.step(from: "Daily", by: 1, in: options), "Weekly")
        XCTAssertEqual(Pill.step(from: "Monthly", by: 1, in: options), "Monthly")
        XCTAssertEqual(Pill.step(from: "Daily", by: -1, in: options), "Daily")
        XCTAssertEqual(Pill.step(from: "Weekly", by: -1, in: options), "Daily")
        XCTAssertEqual(Pill.step(from: "Yearly", by: 1, in: options), "Weekly", "an unknown choice starts from the first")
        XCTAssertNil(Pill.step(from: "Daily", by: 1, in: []))
    }

    /// The adjustable action writes the new choice through the binding, and
    /// writes nothing once it is at the end.
    func testThePillsAdjustableActionWritesTheBinding() {
        var stored = "Daily"
        var writes = 0
        let pill = AidenPillSegmentedControl(
            selection: Binding(get: { stored }, set: { stored = $0; writes += 1 }),
            options: ["Daily", "Weekly", "Monthly"],
            accessibilityLabel: "Period"
        ) { "\($0)" }
        pill.move(by: 1)
        XCTAssertEqual(stored, "Weekly")
        pill.move(by: 1)
        pill.move(by: 1)
        XCTAssertEqual(stored, "Monthly")
        XCTAssertEqual(writes, 2, "nothing to write past the last option")
        pill.move(by: -1)
        XCTAssertEqual(stored, "Weekly")
    }

    /// Every option is a 44pt target, and at accessibility sizes the options
    /// stack instead of squeezing their labels.
    func testThePillKeepsFullTargetsAndStacksAtAccessibilitySizes() throws {
        func height(_ dynamicType: DynamicTypeSize) throws -> Int {
            try draw(
                AidenPillSegmentedControl(
                    selection: .constant("Daily"),
                    options: ["Daily", "Weekly", "Monthly"],
                    accessibilityLabel: "Period"
                ) { "\($0)" }
                .frame(width: 320)
                .environment(\.dynamicTypeSize, dynamicType)
            ).height
        }
        let large = try height(.large)
        let accessibility = try height(.accessibility5)
        XCTAssertGreaterThanOrEqual(large, 44)
        XCTAssertGreaterThanOrEqual(accessibility, 3 * 44, "three options, one under another")
    }

    /// The chosen option's thumb stands out from the track in every theme.
    func testThePillThumbStandsOffItsTrackInEveryTheme() {
        for (name, p) in everyPalette {
            XCTAssertGreaterThanOrEqual(Color.contrastRatio(p.accentSolidFill.fillHex, p.sidebarHex), 3, name)
        }
    }

    // MARK: Heatmap

    /// An empty day stays untinted; any activity shows; the busiest day is full strength.
    func testHeatmapIntensityShowsEveryActiveDayAndPeaksAtTheBusiest() throws {
        typealias Map = AidenHeatmap<AidenUsageHeatmapDay>
        XCTAssertNil(Map.intensity(0, maximum: 100))
        XCTAssertNil(Map.intensity(5, maximum: 0))
        XCTAssertEqual(try XCTUnwrap(Map.intensity(100, maximum: 100)), 1, accuracy: 0.0001)
        let quiet = try XCTUnwrap(Map.intensity(1, maximum: 10_000))
        XCTAssertGreaterThanOrEqual(quiet, 0.2, "a quiet day next to a busy one still shows")
        let values = [1.0, 10, 100, 1000, 10_000].compactMap { Map.intensity($0, maximum: 10_000) }
        XCTAssertEqual(values, values.sorted())
        XCTAssertEqual(Set(values).count, values.count)
    }

    /// An empty day draws a dot of the secondary ink, where a faint square
    /// would vanish into the card.
    func testAnEmptyHeatmapDayDrawsAVisibleDot() throws {
        let days = (1...10).map { AidenUsageHeatmapDay(date: "2026-11-\($0)", tokens: 0) }
        let bitmap = try draw(
            AidenHeatmap(days: days, value: { Double($0.tokens) }, accessibilitySummary: "No activity")
                .frame(width: 300)
                .background(palette.raised),
            scale: 2
        )
        // The first square spans (300 - 9 * 4) / 10 = 26.4pt; its centre is 13.2pt in.
        let centre = Int(13.2 * 2)
        XCTAssertTrue(bitmap.matches(centre, centre, palette.secondaryHex, tolerance: 6), "\(bitmap.rgb(centre, centre))")
    }
}
