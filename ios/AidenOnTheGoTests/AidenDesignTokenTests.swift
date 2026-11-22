import SwiftUI
import XCTest
@testable import AidenOnTheGo

final class AidenDesignTokenTests: XCTestCase {
    private func allPalettes() -> [(name: String, palette: AidenPalette)] {
        AidenThemePresetID.allCases.flatMap { preset in
            [ColorScheme.light, .dark].map { scheme in
                ("\(preset)/\(scheme == .dark ? "dark" : "light")", AidenThemeCatalog.palette(preset: preset, scheme: scheme))
            }
        }
    }

    /// The row the detail beside a list shows stands out from its card and
    /// from the canvas in every theme, the ink accent's included.
    func testTheSelectedRowFillStandsOutOnItsCardAndOnTheCanvas() {
        for (name, p) in allPalettes() {
            let opacity = AidenListRowBackground.selectedFillOpacity(p)
            for ground in [p.raisedHex, p.canvasHex] {
                let selected = Color.mixHex(ground, p.foregroundHex, fraction: opacity)
                XCTAssertGreaterThanOrEqual(
                    Color.contrastRatio(selected, ground), 1.2,
                    "\(name): selected \(selected) on \(ground)"
                )
            }
        }
    }

    /// The Inbox section headers and their counts are footnote text in
    /// `secondary`, on the canvas in both widths, and secondary text also sits on
    /// raised rows. Weight doesn't change contrast, so the colour has to pass.
    func testSecondaryTextMeetsFourPointFiveToOneOnTheListGrounds() {
        for (name, p) in allPalettes() {
            for ground in [p.canvasHex, p.raisedHex] {
                XCTAssertGreaterThanOrEqual(
                    p.contrastRatio(foregroundHex: p.secondaryHex, backgroundHex: ground),
                    4.5,
                    "\(name): \(p.secondaryHex) on \(ground)"
                )
            }
        }
    }

    /// The accent is text too: the machine pill's count, toolbar glyphs, the
    /// Catch Up icon, unread dots. It reads on every ground a list puts it on.
    func testAccentMeetsFourPointFiveToOneOnCanvasSidebarAndRaised() {
        for (name, p) in allPalettes() {
            for ground in [p.canvasHex, p.sidebarHex, p.raisedHex] {
                XCTAssertGreaterThanOrEqual(
                    p.contrastRatio(foregroundHex: p.accentHex, backgroundHex: ground),
                    4.5,
                    "\(name): accent \(p.accentHex) on \(ground)"
                )
            }
        }
    }

    /// A prominent button's label on its solid fill, near-black and near-white
    /// accents included.
    func testSolidFillContentMeetsFourPointFiveToOneOnItsFill() {
        for (name, p) in allPalettes() {
            for tone in [AidenSolidFillTone.accent, .danger] {
                let fill = p.solidFill(tone)
                XCTAssertGreaterThanOrEqual(
                    p.contrastRatio(foregroundHex: fill.contentHex, backgroundHex: fill.fillHex),
                    4.5,
                    "\(name) \(tone): \(fill.contentHex) on \(fill.fillHex)"
                )
                XCTAssertNotEqual(fill.pressedHex, fill.fillHex, "\(name) \(tone): a press shows no change")
            }
        }
    }

    /// The default theme's accent is ink, not a hue: dark on light, light on
    /// dark, and its channels within a few steps of one another. Status
    /// colours keep their hue.
    func testTheDefaultAccentIsMutedInkThatFollowsTheScheme() {
        func channels(_ hex: String) -> [Int] {
            let digits = Array(hex.dropFirst())
            return stride(from: 0, to: 6, by: 2).map { Int(String(digits[$0..<$0 + 2]), radix: 16)! }
        }
        for scheme in [ColorScheme.light, .dark] {
            let p = AidenThemeCatalog.palette(preset: .aiden, scheme: scheme)
            let accent = channels(p.accentHex)
            XCTAssertLessThanOrEqual(accent.max()! - accent.min()!, 12, "\(scheme): \(p.accentHex) has a hue")
            let canvasIsLight = Color.relativeLuminance(p.canvasHex) > 0.5
            XCTAssertEqual(Color.relativeLuminance(p.accentHex) < 0.2, canvasIsLight, "\(scheme): \(p.accentHex) on \(p.canvasHex)")
            for status in [p.successHex, p.warningHex, p.dangerHex] {
                let c = channels(status)
                XCTAssertGreaterThan(c.max()! - c.min()!, 60, "\(scheme): \(status) lost its hue")
            }
        }
    }

    func testStatusTextMeetsFourPointFiveToOneInEveryTheme() {
        for preset in AidenThemePresetID.allCases { for scheme in [ColorScheme.light, .dark] {
            let p = AidenThemeCatalog.palette(preset: preset, scheme: scheme)
            for hex in [p.successTextHex, p.warningTextHex, p.dangerTextHex] {
                for ground in [p.canvasHex, p.raisedHex] {
                    XCTAssertGreaterThanOrEqual(
                        p.contrastRatio(foregroundHex: hex, backgroundHex: ground),
                        4.5,
                        "\(preset) \(scheme): \(hex) on \(ground)"
                    )
                }
            }
        } }
    }

    /// "Approval" and "Failed" sit on a 12% tint of their own colour, over the
    /// canvas or a raised row. The text holds 4.5:1 there too.
    func testStatusTextMeetsFourPointFiveToOneOnItsOwnChip() {
        for (name, p) in allPalettes() {
            for (fill, text) in [(p.warningHex, p.warningTextHex), (p.dangerHex, p.dangerTextHex)] {
                for ground in [p.canvasHex, p.raisedHex] {
                    let chip = Color.mixHex(ground, fill, fraction: AidenPalette.statusChipFillOpacity)
                    XCTAssertGreaterThanOrEqual(
                        p.contrastRatio(foregroundHex: text, backgroundHex: chip),
                        4.5,
                        "\(name): \(text) on its chip over \(ground)"
                    )
                }
            }
        }
    }

    func testStatusTextKeepsAStatusHexThatAlreadyPasses() {
        for (name, p) in allPalettes() {
            let pairs = [
                (p.successHex, p.successTextHex),
                (p.warningHex, p.warningTextHex),
                (p.dangerHex, p.dangerTextHex),
            ]
            for (fill, text) in pairs {
                let passes = AidenPalette.statusTextGrounds(fill, canvasHex: p.canvasHex, raisedHex: p.raisedHex).allSatisfy {
                    p.contrastRatio(foregroundHex: fill, backgroundHex: $0) >= 4.5
                }
                if passes {
                    XCTAssertEqual(text, fill, "\(name): a passing status hex must not move")
                }
            }
        }
    }

    func testStatusTextMovesAwayFromTheGroundNotTowardIt() {
        for (name, p) in allPalettes() {
            let pairs = [
                (p.successHex, p.successTextHex),
                (p.warningHex, p.warningTextHex),
                (p.dangerHex, p.dangerTextHex),
            ]
            for (fill, text) in pairs {
                for ground in [p.canvasHex, p.raisedHex] {
                    XCTAssertGreaterThanOrEqual(
                        p.contrastRatio(foregroundHex: text, backgroundHex: ground),
                        p.contrastRatio(foregroundHex: fill, backgroundHex: ground),
                        "\(name): \(text) reads worse than the fill hex \(fill) on \(ground)"
                    )
                }
            }
        }
    }

    func testStatusFillHexesAreLeftAlone() {
        let light = AidenThemeCatalog.palette(preset: .aiden, scheme: .light)
        XCTAssertEqual(light.successHex, "#30D158")
        XCTAssertEqual(light.warningHex, "#FF9F0A")
        XCTAssertEqual(light.dangerHex, "#FF453A")
        XCTAssertNotEqual(light.warningTextHex, light.warningHex, "light warning needs darkening for text")
    }

    func testStatusTextIsResolvedWhenThePaletteIsMadeNotOnEachRead() {
        // A contrast setting makes a new palette, as the app does for every scene.
        let palette = AidenThemeCatalog.palette(preset: .aiden, scheme: .light).applyingContrast(80, baseline: 45)
        let before = AidenPalette.statusTextResolutionCount
        for _ in 0..<50 {
            _ = palette.successTextHex
            _ = palette.warningText
            _ = palette.dangerTextHex
        }
        XCTAssertEqual(AidenPalette.statusTextResolutionCount, before, "Rows read colours the palette already holds")
        for ground in [palette.canvasHex, palette.raisedHex] {
            XCTAssertGreaterThanOrEqual(palette.contrastRatio(foregroundHex: palette.warningTextHex, backgroundHex: ground), 4.5)
        }
    }

    func testContrastRatioMatchesWCAGReferenceValues() {
        let p = AidenThemeCatalog.palette(preset: .aiden, scheme: .light)
        XCTAssertEqual(p.contrastRatio(foregroundHex: "#000000", backgroundHex: "#FFFFFF"), 21, accuracy: 0.001)
        XCTAssertEqual(p.contrastRatio(foregroundHex: "#FFFFFF", backgroundHex: "#000000"), 21, accuracy: 0.001)
        XCTAssertEqual(p.contrastRatio(foregroundHex: "#777777", backgroundHex: "#777777"), 1, accuracy: 0.001)
    }
}
