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

    func testStatusTextKeepsAStatusHexThatAlreadyPasses() {
        for (name, p) in allPalettes() {
            let pairs = [
                (p.successHex, p.successTextHex),
                (p.warningHex, p.warningTextHex),
                (p.dangerHex, p.dangerTextHex),
            ]
            for (fill, text) in pairs {
                let passes = [p.canvasHex, p.raisedHex].allSatisfy {
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
