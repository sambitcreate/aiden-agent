#if DEBUG
import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenBotPrototypeSnapshotTests: XCTestCase {
    private let canvasSize = CGSize(width: 1_024, height: 768)

    func testRegularWidthBotInboxRendersEveryAidenThemeAtReviewSize() async throws {
        XCTAssertEqual(AidenThemePresetID.allCases.count, 4)

        for theme in AidenThemePresetID.allCases {
            let image = try await renderRegularWidthInbox(theme: theme)
            let cgImage = try XCTUnwrap(image.cgImage, "Expected a CGImage for \(theme.title)")
            XCTAssertEqual(cgImage.width, Int(canvasSize.width), "Unexpected \(theme.title) width")
            XCTAssertEqual(cgImage.height, Int(canvasSize.height), "Unexpected \(theme.title) height")
            assertRenderedContent(in: cgImage, theme: theme)

            let pngData = try XCTUnwrap(image.pngData(), "Expected PNG data for \(theme.title)")
            let attachment = XCTAttachment(data: pngData, uniformTypeIdentifier: "public.png")
            attachment.name = "BotFirstPrototype-Regular-\(theme.rawValue)-1024x768"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    private func renderRegularWidthInbox(theme: AidenThemePresetID) async throws -> UIImage {
        let configuration = AidenBotFirstPrototypeConfiguration(
            theme: theme,
            state: .ready,
            screen: .inbox,
            noticeAcknowledged: true
        )
        let content = AidenBotFirstPrototypeLaunchView(configuration: configuration)
            .environment(\.horizontalSizeClass, .regular)
            .environment(\.verticalSizeClass, .regular)
            .preferredColorScheme(.light)
            .frame(width: canvasSize.width, height: canvasSize.height)

        let regularIPadTraits = UITraitCollection(traitsFrom: [
            UITraitCollection(userInterfaceIdiom: .pad),
            UITraitCollection(horizontalSizeClass: .regular),
            UITraitCollection(verticalSizeClass: .regular),
            UITraitCollection(displayScale: 1),
            UITraitCollection(userInterfaceStyle: .light),
        ])
        XCTAssertEqual(regularIPadTraits.userInterfaceIdiom, .pad)
        XCTAssertEqual(regularIPadTraits.horizontalSizeClass, .regular)
        XCTAssertEqual(regularIPadTraits.verticalSizeClass, .regular)

        let windowScene = try XCTUnwrap(
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first(where: { $0.activationState == .foregroundActive }),
            "Expected the app-hosted test to have an active window scene"
        )
        let previousKeyWindow = windowScene.windows.first(where: \.isKeyWindow)
        let hostingController = UIHostingController(rootView: content)
        hostingController.traitOverrides.userInterfaceIdiom = .pad
        hostingController.traitOverrides.horizontalSizeClass = .regular
        hostingController.traitOverrides.verticalSizeClass = .regular
        hostingController.traitOverrides.userInterfaceStyle = .light

        let captureWindow = UIWindow(windowScene: windowScene)
        captureWindow.frame = CGRect(origin: .zero, size: canvasSize)
        captureWindow.backgroundColor = .systemBackground
        captureWindow.rootViewController = hostingController

        defer {
            captureWindow.isHidden = true
            captureWindow.rootViewController = nil
            previousKeyWindow?.makeKey()
        }

        regularIPadTraits.performAsCurrent {
            captureWindow.makeKeyAndVisible()
            captureWindow.frame = CGRect(origin: .zero, size: canvasSize)
            hostingController.view.frame = captureWindow.bounds
            hostingController.view.setNeedsLayout()
            hostingController.view.layoutIfNeeded()
        }
        await Task.yield()
        await Task.yield()

        XCTAssertEqual(hostingController.traitCollection.userInterfaceIdiom, .pad)
        XCTAssertEqual(hostingController.traitCollection.horizontalSizeClass, .regular)
        XCTAssertEqual(hostingController.traitCollection.verticalSizeClass, .regular)
        XCTAssertEqual(captureWindow.bounds.size, canvasSize)

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: canvasSize, format: format)
        var renderedImage: UIImage?
        regularIPadTraits.performAsCurrent {
            hostingController.view.setNeedsLayout()
            hostingController.view.layoutIfNeeded()
            renderedImage = renderer.image { context in
                UIColor.systemBackground.setFill()
                context.fill(CGRect(origin: .zero, size: canvasSize))
                captureWindow.layer.render(in: context.cgContext)
            }
        }
        return try XCTUnwrap(renderedImage, "Expected hosted render output for \(theme.title)")
    }

    private func assertRenderedContent(in image: CGImage, theme: AidenThemePresetID) {
        guard
            let data = image.dataProvider?.data,
            let bytes = CFDataGetBytePtr(data)
        else {
            return XCTFail("Expected readable pixels for \(theme.title)")
        }

        let bytesPerPixel = max(image.bitsPerPixel / 8, 1)
        var sampledColors = Set<UInt32>()
        for y in stride(from: 0, to: image.height, by: 32) {
            for x in stride(from: 0, to: image.width, by: 32) {
                let offset = y * image.bytesPerRow + x * bytesPerPixel
                var sample: UInt32 = 0
                for component in 0..<min(bytesPerPixel, 4) {
                    sample = (sample << 8) | UInt32(bytes[offset + component])
                }
                sampledColors.insert(sample)
            }
        }
        XCTAssertGreaterThan(
            sampledColors.count,
            8,
            "Expected visible UI, not a blank \(theme.title) canvas"
        )
    }
}
#endif
