import Foundation
import ImagePlayground
import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

final class AidenBotImagePlaygroundTests: XCTestCase {
    @MainActor
    func testOptInPhysicalDeviceReportsImagePlaygroundUnavailable() throws {
        guard ProcessInfo.processInfo.environment["AIDEN_EXPECT_IMAGE_PLAYGROUND_UNAVAILABLE"] == "1" else {
            throw XCTSkip("Enable only for a known ineligible physical iPhone acceptance run.")
        }
        guard #available(iOS 18.1, *) else {
            XCTFail("The physical acceptance device must run iOS 18.1 or later.")
            return
        }
        XCTAssertEqual(UIDevice.current.userInterfaceIdiom, .phone)
        XCTAssertFalse(
            ImagePlaygroundViewController.isAvailable,
            "This opt-in gate is valid only on a physical phone known to be ineligible for Image Playground."
        )
    }

    @MainActor
    func testUnsupportedFallbackRendersAsACompleteNoninteractivePath() throws {
        var copiedCandidateCount = 0
        let content = AidenBotImagePlaygroundView(
            identity: .init(name: "Research Helper", purpose: "Summarize papers"),
            fallbackOverride: .unsupported
        ) { _ in
            copiedCandidateCount += 1
        }
        .frame(width: 350, height: 180, alignment: .topLeading)
        .padding()

        let host = UIHostingController(rootView: content)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 220))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()

        let image = UIGraphicsImageRenderer(size: window.bounds.size).image { context in
            window.layer.render(in: context.cgContext)
        }
        let png = try XCTUnwrap(image.pngData())
        XCTAssertGreaterThan(png.count, 1_000)
        XCTAssertEqual(copiedCandidateCount, 0)

        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = "Bot-Image-Playground-Unsupported-Fallback"
        attachment.lifetime = .keepAlways
        add(attachment)
        window.isHidden = true
    }

    func testIdentityConceptsUseOnlyBoundedVisibleNameAndPurpose() {
        let identity = AidenBotImagePlaygroundIdentity(
            name: "  Research Helper  ",
            purpose: "  Summarizes the papers I choose.  "
        )

        XCTAssertEqual(identity.name, "Research Helper")
        XCTAssertEqual(identity.purpose, "Summarizes the papers I choose.")
        XCTAssertEqual(identity.conceptTexts, [identity.name, identity.purpose])

        let bounded = AidenBotImagePlaygroundIdentity(
            name: String(repeating: "n", count: 100),
            purpose: String(repeating: "p", count: 300)
        )
        XCTAssertEqual(bounded.name.count, 80)
        XCTAssertEqual(bounded.purpose.count, 240)
    }

    func testPresentationStateHandlesUnavailableCancelAcceptAndCopyFailure() {
        var state = AidenBotImagePlaygroundPresentationState()
        XCTAssertEqual(state.phase, .ready)

        state.requestPresentation(systemAvailable: false)
        XCTAssertEqual(state.phase, .fallback(.systemUnavailable))

        state.requestPresentation(systemAvailable: true)
        XCTAssertEqual(state.phase, .presenting)

        state.cancel()
        XCTAssertEqual(state.phase, .cancelled)

        state.requestPresentation(systemAvailable: true)
        state.acceptCopiedCandidate()
        XCTAssertEqual(state.phase, .accepted)

        state.failCandidateCopy()
        XCTAssertEqual(state.phase, .fallback(.candidateCopyFailed))
    }

    func testFallbackCopyCoversSupportedFailureFamiliesWithoutClaimingDetection() {
        XCTAssertTrue(AidenBotImagePlaygroundFallbackReason.unsupported.message.contains("semantic avatar"))
        XCTAssertTrue(AidenBotImagePlaygroundFallbackReason.restricted.message.contains("restricted"))
        XCTAssertTrue(AidenBotImagePlaygroundFallbackReason.modelUnavailable.message.contains("downloading"))
        XCTAssertTrue(AidenBotImagePlaygroundFallbackReason.usageLimit.message.contains("limit"))
        XCTAssertTrue(AidenBotImagePlaygroundFallbackReason.updateRequired.message.contains("iPadOS 18.4"))
        XCTAssertTrue(AidenBotImagePlaygroundFallbackReason.updateRequired.message.contains("non-personalized"))

        let unknown = AidenBotImagePlaygroundFallbackReason.systemUnavailable.message
        XCTAssertTrue(unknown.contains("doesn't currently make"))
        XCTAssertFalse(unknown.contains("restricted"))
        XCTAssertFalse(unknown.contains("downloading"))
        XCTAssertFalse(unknown.contains("usage limit"))
    }

    func testAcceptedSystemURLIsCopiedBeforeItsLifetimeEnds() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appending(path: "aiden-image-playground-test-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? fileManager.removeItem(at: root) }

        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        let systemURL = root.appending(path: "system-temporary-image")
        let expected = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A])
        try expected.write(to: systemURL, options: .atomic)

        let store = AidenBotImagePlaygroundCandidateStore(
            directory: root.appending(path: "owned", directoryHint: .isDirectory)
        )
        let copiedURL = try store.copyImmediately(fromSystemCompletionURL: systemURL)

        XCTAssertFalse(fileManager.fileExists(atPath: systemURL.path))
        XCTAssertTrue(fileManager.fileExists(atPath: copiedURL.path))
        XCTAssertEqual(try Data(contentsOf: copiedURL), expected)
        XCTAssertTrue(copiedURL.path.hasPrefix(store.directory.path))
        XCTAssertNotEqual(copiedURL, systemURL)
    }

    func testCandidateStoreRejectsNonFileAndEmptySources() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appending(path: "aiden-image-playground-invalid-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? fileManager.removeItem(at: root) }
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)

        let store = AidenBotImagePlaygroundCandidateStore(
            directory: root.appending(path: "owned", directoryHint: .isDirectory)
        )
        XCTAssertThrowsError(try store.copyImmediately(fromSystemCompletionURL: URL(string: "https://example.invalid/image")!)) {
            XCTAssertEqual($0 as? AidenBotImagePlaygroundCandidateCopyError, .invalidSource)
        }

        let empty = root.appending(path: "empty")
        try Data().write(to: empty)
        XCTAssertThrowsError(try store.copyImmediately(fromSystemCompletionURL: empty)) {
            XCTAssertEqual($0 as? AidenBotImagePlaygroundCandidateCopyError, .invalidSource)
        }
        XCTAssertFalse(fileManager.fileExists(atPath: empty.path))
    }

    func testAcceptedSystemURLCanComeFromOutsideTemporaryDirectory() throws {
        let fileManager = FileManager.default
        let applicationSupport = try XCTUnwrap(
            fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        )
        let sourceRoot = applicationSupport
            .appending(path: "aiden-image-playground-container-\(UUID().uuidString)", directoryHint: .isDirectory)
        let ownedRoot = fileManager.temporaryDirectory
            .appending(path: "aiden-image-playground-owned-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer {
            try? fileManager.removeItem(at: sourceRoot)
            try? fileManager.removeItem(at: ownedRoot)
        }
        try fileManager.createDirectory(at: sourceRoot, withIntermediateDirectories: true)

        let systemURL = sourceRoot.appending(path: "system-result")
        try Data([0x01, 0x02]).write(to: systemURL)
        XCTAssertFalse(systemURL.path.hasPrefix(fileManager.temporaryDirectory.path))

        let store = AidenBotImagePlaygroundCandidateStore(directory: ownedRoot)
        let copiedURL = try store.copyImmediately(fromSystemCompletionURL: systemURL)

        XCTAssertFalse(fileManager.fileExists(atPath: systemURL.path))
        XCTAssertEqual(try Data(contentsOf: copiedURL), Data([0x01, 0x02]))
    }

    func testCandidateStoreRejectsAndRemovesSystemSymlink() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appending(path: "aiden-image-playground-symlink-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? fileManager.removeItem(at: root) }
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)

        let target = root.appending(path: "target")
        try Data([0x01]).write(to: target)
        let link = root.appending(path: "system-link")
        try fileManager.createSymbolicLink(at: link, withDestinationURL: target)

        let store = AidenBotImagePlaygroundCandidateStore(
            directory: root.appending(path: "owned", directoryHint: .isDirectory)
        )
        XCTAssertThrowsError(try store.copyImmediately(fromSystemCompletionURL: link)) {
            XCTAssertEqual($0 as? AidenBotImagePlaygroundCandidateCopyError, .invalidSource)
        }
        XCTAssertFalse(fileManager.fileExists(atPath: link.path))
        XCTAssertTrue(fileManager.fileExists(atPath: target.path))
    }

    func testCandidateStoreBoundsCrashResidueAndRemovesOnlyOwnedCandidates() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appending(path: "aiden-image-playground-prune-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? fileManager.removeItem(at: root) }
        let owned = root.appending(path: "owned", directoryHint: .isDirectory)
        try fileManager.createDirectory(at: owned, withIntermediateDirectories: true)

        for index in 0..<(AidenBotImagePlaygroundCandidateStore.maximumRetainedCandidates + 3) {
            let url = owned.appending(path: "candidate-\(index).image")
            try Data([UInt8(index)]).write(to: url)
            try fileManager.setAttributes(
                [.modificationDate: Date(timeIntervalSinceNow: TimeInterval(index))],
                ofItemAtPath: url.path
            )
        }
        let unrelated = owned.appending(path: "keep-me.txt")
        try Data([0x01]).write(to: unrelated)

        let store = AidenBotImagePlaygroundCandidateStore(directory: owned)
        store.pruneOwnedCandidates(now: Date(timeIntervalSinceNow: 100))

        let remaining = try fileManager.contentsOfDirectory(at: owned, includingPropertiesForKeys: nil)
        XCTAssertLessThanOrEqual(
            remaining.filter { $0.lastPathComponent.hasPrefix("candidate-") }.count,
            AidenBotImagePlaygroundCandidateStore.maximumRetainedCandidates
        )
        XCTAssertTrue(fileManager.fileExists(atPath: unrelated.path))

        let outside = root.appending(path: "candidate-outside.image")
        try Data([0x02]).write(to: outside)
        store.removeOwnedCandidate(at: outside)
        XCTAssertTrue(fileManager.fileExists(atPath: outside.path))

        store.removeAllOwnedCandidates()
        XCTAssertTrue(fileManager.fileExists(atPath: unrelated.path))
        XCTAssertFalse(
            try fileManager.contentsOfDirectory(at: owned, includingPropertiesForKeys: nil)
                .contains { $0.lastPathComponent.hasPrefix("candidate-") }
        )
    }

    func testProcessLaunchCleanupRemovesCrashResidueWithoutTouchingUnrelatedFiles() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appending(path: "aiden-image-playground-launch-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? fileManager.removeItem(at: root) }
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        let residue = root.appending(path: "candidate-crash.image")
        let unrelated = root.appending(path: "keep-me.txt")
        try Data([0x01]).write(to: residue)
        try Data([0x02]).write(to: unrelated)

        aidenBotImagePlaygroundCleanupAfterProcessLaunch(
            candidateStore: .init(directory: root)
        )

        XCTAssertFalse(fileManager.fileExists(atPath: residue.path))
        XCTAssertTrue(fileManager.fileExists(atPath: unrelated.path))
    }
}
