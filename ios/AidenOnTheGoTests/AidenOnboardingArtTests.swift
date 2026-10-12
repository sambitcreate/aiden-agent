import SwiftUI
import XCTest
@testable import AidenOnTheGo

final class AidenOnboardingArtTests: XCTestCase {
    func testEachOnboardingPageHasItsOwnBotTint() {
        let tints = AidenMobileOnboardingPhase.allCases.map(\.artTint)
        XCTAssertEqual(Set(tints).count, tints.count, "neighbouring pages must not share a tint")
        XCTAssertFalse(tints.contains(.graphite), "graphite is neutral and would read as untinted")
    }

    func testArtFollowsEveryThemePresetAndStaysLegible() {
        for preset in AidenThemePresetID.allCases {
            for scheme in [ColorScheme.light, .dark] {
                let palette = AidenThemeCatalog.palette(preset: preset, scheme: scheme)
                for phase in AidenMobileOnboardingPhase.allCases {
                    let colors = AidenOnboardingArtColors(palette: palette, tint: phase.artTint)
                    let context = "\(preset) \(scheme) \(phase)"

                    XCTAssertEqual(colors.isDark, scheme == .dark, context)
                    XCTAssertEqual(Self.luminance(colors.tileHex) < 0.18, scheme == .dark, context)
                    // The tile is tinted, but stays nearer the theme's own surface than the tint.
                    XCTAssertNotEqual(colors.tileHex, palette.raisedHex, context)
                    XCTAssertLessThan(
                        Self.distance(colors.tileHex, palette.raisedHex),
                        Self.distance(colors.tileHex, colors.tintHex),
                        context
                    )
                    // Title skeletons read as graphics (WCAG 3:1) on the tile and on surfaces.
                    XCTAssertGreaterThanOrEqual(Self.contrast(colors.inkHex, colors.tileHex), 3, context)
                    XCTAssertGreaterThanOrEqual(Self.contrast(colors.inkHex, colors.surfaceHex), 3, context)
                }
            }
        }
    }

    func testReduceMotionLowPowerAndHiddenPagesHoldTheStillPose() {
        for elapsed in [0, 0.4, 3, 6.5, 30] as [TimeInterval] {
            XCTAssertEqual(
                AidenOnboardingArtMotion.pose(elapsed: elapsed, isActive: true, reduceMotion: true, lowPowerMode: false),
                .still
            )
            XCTAssertEqual(
                AidenOnboardingArtMotion.pose(elapsed: elapsed, isActive: true, reduceMotion: false, lowPowerMode: true),
                .still
            )
            XCTAssertEqual(
                AidenOnboardingArtMotion.pose(elapsed: elapsed, isActive: false, reduceMotion: false, lowPowerMode: false),
                .still
            )
        }

        let still = AidenOnboardingArtMotion.still
        XCTAssertEqual(still.reveal(delay: 1.5), .shown)
        XCTAssertEqual(still.float, 0)
        XCTAssertEqual(still.press(delay: 0.6), 1)
        XCTAssertEqual(still.pulse, 1)
    }

    func testAPageArrivesCompleteAndTheLoopRestsOnTheStillPose() {
        let still = AidenOnboardingArtMotion.still
        let delays: [TimeInterval] = [0, 0.18, 0.36, 0.5, 0.9, 1.5, 1.68]

        // Swiping onto a page continues from the still pose: nothing collapses or jumps.
        let arriving = AidenOnboardingArtMotion.pose(elapsed: 0, isActive: true, reduceMotion: false, lowPowerMode: false)
        XCTAssertTrue(arriving.isAnimated)
        for delay in delays {
            XCTAssertEqual(arriving.reveal(delay: delay), still.reveal(delay: delay))
        }
        XCTAssertEqual(arriving.press(delay: 0.6), still.press(delay: 0.6))
        XCTAssertEqual(arriving.float, still.float)
        XCTAssertEqual(arriving.pulse, still.pulse)

        // Mid-cycle every element sits exactly where Reduce Motion draws it, so the
        // still pose is the composition the animation holds, not a frozen frame.
        let holding = AidenOnboardingArtMotion(time: 4)
        for delay in delays {
            XCTAssertEqual(holding.reveal(delay: delay), still.reveal(delay: delay))
        }
        XCTAssertEqual(holding.press(delay: 0.6), 1)

        // After the hold the loop fades and types the reply again.
        let fading = AidenOnboardingArtMotion(time: AidenOnboardingArtMotion.cycle - 0.2)
        XCTAssertLessThan(fading.reveal().opacity, 1)
        let retyping = AidenOnboardingArtMotion.pose(
            elapsed: AidenOnboardingArtMotion.cycle - AidenOnboardingArtMotion.entry + 0.1,
            isActive: true,
            reduceMotion: false,
            lowPowerMode: false
        )
        XCTAssertLessThan(retyping.reveal().amount, 1, "the first reply line is typing again")

        for time in stride(from: 0, through: 20, by: 0.25) {
            let motion = AidenOnboardingArtMotion(time: time)
            XCTAssertTrue((-3...0).contains(motion.float))
            XCTAssertTrue((0.94...1).contains(motion.press(delay: 0.6)))
            XCTAssertTrue((0...1).contains(motion.pulse))
        }
    }

    @MainActor
    func testArtworkRendersAThemedTileInLightAndDark() throws {
        for scheme in [ColorScheme.light, .dark] {
            let palette = AidenThemeCatalog.palette(preset: .aiden, scheme: scheme)
            for phase in AidenMobileOnboardingPhase.allCases {
                let colors = AidenOnboardingArtColors(palette: palette, tint: phase.artTint)
                let renderer = ImageRenderer(
                    content: AidenOnboardingArtwork(phase: phase, isActive: false)
                        .frame(width: 300, height: 220)
                        .environment(\.aidenPalette, palette)
                        .environment(\.colorScheme, scheme)
                )
                renderer.scale = 1
                let image = try XCTUnwrap(renderer.cgImage, "\(phase) \(scheme)")
                let pixels = try Self.pixels(of: image)
                let context = "\(phase) \(scheme)"

                XCTAssertEqual(pixels.width, 300, context)
                XCTAssertEqual(pixels.height, 220, context)
                // Rounded tile corners are cut away.
                XCTAssertEqual(pixels.rgba(x: 0, y: 0)[3], 0, context)
                // An empty stretch of tile shows the theme surface mixed with the page's tint.
                let tile = pixels.rgba(x: 4, y: 110)
                let expected = Self.rgb(colors.tileHex)
                for channel in 0..<3 {
                    XCTAssertEqual(Int(tile[channel]), expected[channel], accuracy: 3, context)
                }
                XCTAssertEqual(tile[3], 255, context)
                // The vignette draws a composition over the tile, not a flat card.
                XCTAssertGreaterThan(pixels.distinctColours, 60, context)
            }
        }
    }

    // MARK: - Independent colour maths (WCAG 2.x)

    private static func rgb(_ hex: String) -> [Int] {
        let value = Int(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0
        return [(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]
    }

    private static func luminance(_ hex: String) -> Double {
        let linear = rgb(hex).map { channel -> Double in
            let value = Double(channel) / 255
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }

    private static func contrast(_ first: String, _ second: String) -> Double {
        let values = [luminance(first), luminance(second)].sorted()
        return (values[1] + 0.05) / (values[0] + 0.05)
    }

    private static func distance(_ first: String, _ second: String) -> Double {
        zip(rgb(first), rgb(second)).reduce(0) { total, pair in
            let delta = Double(pair.0 - pair.1)
            return total + delta * delta
        }.squareRoot()
    }

    private struct Pixels {
        let width: Int
        let height: Int
        let bytes: [UInt8]

        func rgba(x: Int, y: Int) -> [UInt8] {
            let offset = (y * width + x) * 4
            return Array(bytes[offset..<offset + 4])
        }

        var distinctColours: Int {
            var seen = Set<UInt32>()
            for offset in stride(from: 0, to: bytes.count, by: 4) {
                seen.insert(
                    UInt32(bytes[offset]) << 24 | UInt32(bytes[offset + 1]) << 16
                        | UInt32(bytes[offset + 2]) << 8 | UInt32(bytes[offset + 3])
                )
            }
            return seen.count
        }
    }

    /// Redraws the render into straight sRGB bytes so samples compare with hex values.
    private static func pixels(of image: CGImage) throws -> Pixels {
        let width = image.width
        let height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let colorSpace = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        XCTAssertTrue(drawn)
        // A bitmap context's buffer is stored top row first.
        return Pixels(width: width, height: height, bytes: bytes)
    }
}
