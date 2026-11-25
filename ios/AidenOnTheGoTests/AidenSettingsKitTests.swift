import SwiftUI
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenSettingsKitTests: XCTestCase {
    private let palette = AidenThemeCatalog.palette(preset: .slate, scheme: .light)

    /// The drawn image as rows of RGBA bytes, at one pixel per point.
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

        static func rgb(_ hex: String) -> [Int] {
            let value = Int(hex.dropFirst(), radix: 16) ?? 0
            return [(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]
        }
    }

    private func draw<V: View>(_ view: V) throws -> Bitmap {
        let renderer = ImageRenderer(content: view.environment(\.aidenPalette, palette))
        renderer.scale = 1
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

    // MARK: Type scale

    /// The in-app Text size moves every step with it, and the steps keep their
    /// order at every size: a page title never shrinks under a row title.
    func testEveryTypeStepFollowsTheInAppTextSizeAndKeepsItsOrder() {
        for size in 12...18 {
            let sizes = Dictionary(uniqueKeysWithValues: AidenTypeScale.allCases.map { ($0, $0.pointSize(uiFontSize: size)) })
            XCTAssertEqual(sizes[.rowTitle], CGFloat(size), "a row title is the app's body text")
            XCTAssertGreaterThan(sizes[.pageTitle]!, sizes[.rowTitle]!)
            XCTAssertGreaterThan(sizes[.statHero]!, sizes[.rowTitle]!)
            XCTAssertLessThan(sizes[.sectionCaption]!, sizes[.rowTitle]!)
            XCTAssertLessThanOrEqual(sizes[.footnote]!, sizes[.rowValue]!)
            if size > 12 {
                for step in AidenTypeScale.allCases {
                    XCTAssertGreaterThanOrEqual(step.pointSize(uiFontSize: size), step.pointSize(uiFontSize: size - 1), "\(step)")
                }
            }
        }
        XCTAssertGreaterThan(AidenTypeScale.rowTitle.pointSize(uiFontSize: 18), AidenTypeScale.rowTitle.pointSize(uiFontSize: 12))
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
        XCTAssertGreaterThan(try height(.accessibility3, uiFontSize: 14), base, "Dynamic Type")
        XCTAssertGreaterThan(try height(.large, uiFontSize: 18), base, "in-app Text size")
    }

    // MARK: Status chip

    /// Each chip's capsule is its tone at the chip opacity over the ground, out
    /// to its edge: a soft fill, with no coloured border.
    func testAStatusChipIsASoftFillWithNoBorder() throws {
        for tone in AidenStatusTone.allCases {
            let bitmap = try draw(
                AidenStatusChip("Paused", tone: tone)
                    .padding(10)
                    .background(palette.canvas)
            )
            let expected = Color.mixHex(palette.canvasHex, tone.fillHex(palette), fraction: AidenPalette.statusChipFillOpacity)
            let midX = bitmap.width / 2
            // The capsule's flat top edge, its first full row, and a point at
            // its rounded end, clear of the label.
            XCTAssertTrue(bitmap.matches(midX, 11, expected), "\(tone): top edge \(bitmap.rgb(midX, 11)) vs \(expected)")
            XCTAssertTrue(bitmap.matches(14, bitmap.height / 2, expected), "\(tone): end \(bitmap.rgb(14, bitmap.height / 2))")
            XCTAssertTrue(bitmap.matches(midX, 4, palette.canvasHex), "\(tone): ground outside the chip")
        }
    }

    /// The label reads at 4.5:1 on its own tinted capsule, on the canvas and
    /// on a raised card, in every theme.
    func testAStatusChipLabelReadsOnItsFillInEveryTheme() {
        for preset in AidenThemePresetID.allCases {
            for scheme in [ColorScheme.light, .dark] {
                let p = AidenThemeCatalog.palette(preset: preset, scheme: scheme)
                for tone in AidenStatusTone.allCases {
                    for ground in [p.canvasHex, p.raisedHex] {
                        let fill = Color.mixHex(ground, tone.fillHex(p), fraction: AidenPalette.statusChipFillOpacity)
                        XCTAssertGreaterThanOrEqual(
                            Color.contrastRatio(tone.textHex(p), fill), 4.5,
                            "\(preset)/\(scheme) \(tone) on \(ground)"
                        )
                    }
                }
            }
        }
    }

    // MARK: Grouped card

    /// A card draws one separator between each pair of rows, none above the
    /// first or below the last, and no outline.
    func testAGroupedCardSeparatesItsRowsAndHasNoOutline() throws {
        let bitmap = try draw(
            AidenGroupedCard(separatorInset: 0) {
                Color.clear.frame(width: 200, height: 40)
                Color.clear.frame(width: 200, height: 40)
                Color.clear.frame(width: 200, height: 40)
            }
            .environment(\.displayScale, 1)
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
}
