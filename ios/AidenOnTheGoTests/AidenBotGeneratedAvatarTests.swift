import ImageIO
import UIKit
import XCTest
@testable import AidenOnTheGo

final class AidenBotGeneratedAvatarTests: XCTestCase {
    func testCanonicalAvatarCacheIdentityChangesOnlyWithScopeOrAssetRevision() {
        let original = AidenBotCanonicalAvatarCacheKey(
            instanceID: "mac-a",
            deviceID: "phone-a",
            botID: "bot-a",
            assetRevision: "avatar-1"
        )
        XCTAssertEqual(
            original,
            AidenBotCanonicalAvatarCacheKey(
                instanceID: "mac-a",
                deviceID: "phone-a",
                botID: "bot-a",
                assetRevision: "avatar-1"
            )
        )
        XCTAssertNotEqual(
            original,
            AidenBotCanonicalAvatarCacheKey(
                instanceID: "mac-a",
                deviceID: "phone-a",
                botID: "bot-a",
                assetRevision: "avatar-2"
            )
        )
    }

    override func setUp() {
        super.setUp()
        AidenAvatarURLProtocol.reset()
    }

    override func tearDown() {
        AidenAvatarURLProtocol.reset()
        super.tearDown()
    }

    func testNormalizerCenterCropsAndEmitsMetadataFreeCanonicalPNG() throws {
        let source = Self.splitImageData(width: 1_024, height: 512)
        let normalized = try AidenBotGeneratedAvatarNormalizer.normalize(source)
        let image = try XCTUnwrap(UIImage(data: normalized)?.cgImage)

        XCTAssertEqual(image.width, 512)
        XCTAssertEqual(image.height, 512)
        XCTAssertLessThanOrEqual(
            normalized.count,
            AidenBotGeneratedAvatarNormalizer.maximumOutputBytes
        )
        let sourceRef = try XCTUnwrap(CGImageSourceCreateWithData(normalized as CFData, nil))
        XCTAssertEqual(CGImageSourceGetCount(sourceRef), 1)
        let properties = try XCTUnwrap(
            CGImageSourceCopyPropertiesAtIndex(sourceRef, 0, nil) as? [CFString: Any]
        )
        XCTAssertEqual(properties[kCGImagePropertyPixelWidth] as? Int, 512)
        XCTAssertEqual(properties[kCGImagePropertyPixelHeight] as? Int, 512)
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary])
        XCTAssertNil(properties[kCGImagePropertyTIFFDictionary])
        let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
        XCTAssertNil(exif?[kCGImagePropertyExifUserComment])
    }

    func testNormalizerRejectsCorruptAndOversizeInputs() throws {
        XCTAssertThrowsError(try AidenBotGeneratedAvatarNormalizer.normalize(Data([1, 2, 3])))
        XCTAssertThrowsError(try AidenBotGeneratedAvatarNormalizer.normalize(
            Data(count: AidenBotGeneratedAvatarNormalizer.maximumSourceBytes + 1)
        )) { error in
            XCTAssertEqual(error as? AidenBotGeneratedAvatarError, .sourceTooLarge)
        }
    }

    func testNormalizerAcceptsBoundedSystemInputAboveUploadLimitAndShrinksCanonicalOutput() throws {
        let source = try Self.noisyPNGData(edge: 1_536)
        XCTAssertGreaterThan(source.count, AidenBotGeneratedAvatarNormalizer.maximumOutputBytes)
        XCTAssertLessThanOrEqual(source.count, AidenBotGeneratedAvatarNormalizer.maximumSourceBytes)

        let normalized = try AidenBotGeneratedAvatarNormalizer.normalize(source)

        XCTAssertLessThanOrEqual(
            normalized.count,
            AidenBotGeneratedAvatarNormalizer.maximumOutputBytes
        )
        XCTAssertEqual(UIImage(data: normalized)?.size, CGSize(width: 512, height: 512))
    }

    func testExpectedRevisionUsesBotRevisionFirstThenAssetRevisionForReplaceAndDelete() throws {
        let fixture = try Self.fixtureObject()
        let detailObject = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
        let withAsset = try Self.decodeDetail(detailObject)
        var withoutAssetObject = detailObject
        var avatar = try XCTUnwrap(withoutAssetObject["avatar"] as? [String: Any])
        avatar.removeValue(forKey: "asset")
        withoutAssetObject["avatar"] = avatar
        let withoutAsset = try Self.decodeDetail(withoutAssetObject)

        XCTAssertEqual(aidenBotAvatarExpectedRevision(withoutAsset), withoutAsset.revision)
        XCTAssertEqual(
            aidenBotAvatarExpectedRevision(withAsset),
            try XCTUnwrap(withAsset.avatar.asset).assetRevision
        )
    }

    func testExactScopeAvatarWriteDoesNotInvalidateHomeSnapshotActivation() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-avatar-exact-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let activation = await cache.activate(instanceId: "instance-a", deviceId: "device-a")
        let canonical = try AidenBotGeneratedAvatarNormalizer.normalize(
            Self.solidImageData(width: 512, height: 512)
        )
        let content = AidenBotAvatarContent(
            data: canonical,
            assetRevision: "avatar_revision_\(String(repeating: "a", count: 32))"
        )

        let exactStored = try await cache.storeAvatar(
            content,
            botId: "bot-a",
            instanceId: "instance-a",
            deviceId: "device-a"
        )
        let activationStillCurrent = await cache.isCurrent(activation)
        let snapshotStored = try await cache.store(
            AidenBotCacheSnapshot(savedAt: Date(timeIntervalSince1970: 1_777_777_777)),
            activation: activation
        )
        let loaded = await cache.avatar(
            instanceId: "instance-a",
            deviceId: "device-a",
            botId: "bot-a",
            assetRevision: content.assetRevision
        )

        XCTAssertTrue(exactStored)
        XCTAssertTrue(activationStillCurrent)
        XCTAssertTrue(snapshotStored)
        XCTAssertEqual(loaded, canonical)

        let relaunchedCache = AidenBotCache(root: root)
        let exactRelaunch = await relaunchedCache.avatar(
            instanceId: "instance-a",
            deviceId: "device-a",
            botId: "bot-a",
            assetRevision: content.assetRevision
        )
        let otherPairing = await relaunchedCache.avatar(
            instanceId: "instance-a",
            deviceId: "device-b",
            botId: "bot-a",
            assetRevision: content.assetRevision
        )
        XCTAssertEqual(exactRelaunch, canonical)
        XCTAssertNil(otherPairing)
    }

    @MainActor
    func testCandidateURLIsRemovedAfterNormalizationAndDismissalClearsBytes() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-avatar-candidate-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appending(path: "system-image")
        try Self.solidImageData(width: 700, height: 700).write(to: source)
        let store = AidenBotImagePlaygroundCandidateStore(
            directory: root.appending(path: "owned", directoryHint: .isDirectory)
        )
        let candidate = try store.copyImmediately(fromSystemCompletionURL: source)
        let coordinator = AidenRemoteCoordinator(
            installationStore: AidenInstallationStore(keychain: AidenAvatarMemoryKeychain())
        )
        let model = AidenBotGeneratedAvatarModel(coordinator: coordinator, botID: "bot-a")

        await model.ingestCopiedCandidate(at: candidate, candidateStore: store)

        XCTAssertFalse(FileManager.default.fileExists(atPath: candidate.path))
        XCTAssertTrue(model.hasCandidate)
        XCTAssertNotNil(model.candidateImage)
        model.clearForDismissal()
        XCTAssertFalse(model.hasCandidate)
        XCTAssertNil(model.candidateImage)
        XCTAssertNil(model.currentImage)
    }

    @MainActor
    func testCandidateIngestionRejectsSymlinkAndRemovesOwnedLink() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-avatar-link-\(UUID().uuidString)", directoryHint: .isDirectory)
        let owned = root.appending(path: "owned", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: owned, withIntermediateDirectories: true)
        let target = root.appending(path: "target")
        try Self.solidImageData(width: 512, height: 512).write(to: target)
        let link = owned.appending(path: "candidate-\(UUID().uuidString).image")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let store = AidenBotImagePlaygroundCandidateStore(directory: owned)
        let coordinator = AidenRemoteCoordinator(
            installationStore: AidenInstallationStore(keychain: AidenAvatarMemoryKeychain())
        )
        let model = AidenBotGeneratedAvatarModel(coordinator: coordinator, botID: "bot-a")

        await model.ingestCopiedCandidate(at: link, candidateStore: store)

        XCTAssertFalse(model.hasCandidate)
        XCTAssertEqual(model.phase, .failed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: link.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
    }

    func testMutationAmbiguityClassificationClearsDefiniteFailures() {
        XCTAssertTrue(aidenBotAvatarMutationFailureIsAmbiguous(URLError(.networkConnectionLost)))
        XCTAssertTrue(aidenBotAvatarMutationFailureIsAmbiguous(
            AidenRemoteClientError.unexpectedStatus(503)
        ))
        XCTAssertFalse(aidenBotAvatarMutationFailureIsAmbiguous(
            AidenRemoteClientError.unexpectedStatus(400)
        ))
        XCTAssertFalse(aidenBotAvatarMutationFailureIsAmbiguous(
            AidenRemoteClientError.installationChanged
        ))
    }

    @MainActor
    func testLifecycleReusesAmbiguousUploadKeyReplacesByAssetRevisionAndReconcilesLostDelete() async throws {
        let fixture = try Self.fixtureObject()
        let typedFixture = try Self.typedFixture()
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-avatar-lifecycle-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenBotCache(root: root)
        let firstCandidate = try AidenBotGeneratedAvatarNormalizer.normalize(
            Self.solidImageData(width: 900, height: 700, color: .systemIndigo)
        )
        let secondCandidate = try AidenBotGeneratedAvatarNormalizer.normalize(
            Self.solidImageData(width: 700, height: 900, color: .systemOrange)
        )
        let firstRevision = "avatar_revision_\(String(repeating: "1", count: 32))"
        let secondRevision = "avatar_revision_\(String(repeating: "2", count: 32))"
        let firstAsset = Self.assetObject(revision: firstRevision, byteSize: firstCandidate.count)
        let secondAsset = Self.assetObject(revision: secondRevision, byteSize: secondCandidate.count)
        var currentDetail = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
        var currentAvatar = try XCTUnwrap(currentDetail["avatar"] as? [String: Any])
        currentAvatar.removeValue(forKey: "asset")
        currentDetail["avatar"] = currentAvatar
        let initialBotRevision = try XCTUnwrap(currentDetail["revision"] as? String)
        var putKeys: [String] = []
        var putMatches: [String] = []
        var deleteMatches: [String] = []
        var putCount = 0

        AidenAvatarURLProtocol.handler = { request in
            let path = try XCTUnwrap(request.url?.path)
            switch (request.httpMethod, path) {
            case ("GET", "/api/aiden/v1/server"):
                return try Self.jsonResponse(request, status: 200, object: try XCTUnwrap(fixture["server"]))
            case ("GET", "/api/aiden/v1/workspaces"):
                return try Self.jsonResponse(request, status: 200, object: ["workspaces": []])
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01"):
                return try Self.jsonResponse(request, status: 200, object: currentDetail)
            case ("PUT", "/api/aiden/v1/bots/bot_fixture_01/avatar"):
                putCount += 1
                putKeys.append(try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key")))
                putMatches.append(try XCTUnwrap(request.value(forHTTPHeaderField: "If-Match")))
                if putCount == 1 {
                    return try Self.jsonResponse(
                        request,
                        status: 400,
                        object: ["error": try XCTUnwrap(fixture["error"])]
                    )
                }
                if putCount == 2 {
                    throw URLError(.networkConnectionLost)
                }
                let nextAsset = putCount == 3 ? firstAsset : secondAsset
                var avatar = try XCTUnwrap(currentDetail["avatar"] as? [String: Any])
                avatar["asset"] = nextAsset
                currentDetail["avatar"] = avatar
                return try Self.jsonResponse(request, status: 200, object: nextAsset)
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01/avatar/\(firstRevision)"):
                return try Self.imageResponse(request, data: firstCandidate)
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01/avatar/\(secondRevision)"):
                return try Self.imageResponse(request, data: secondCandidate)
            case ("DELETE", "/api/aiden/v1/bots/bot_fixture_01/avatar"):
                deleteMatches.append(try XCTUnwrap(request.value(forHTTPHeaderField: "If-Match")))
                var avatar = try XCTUnwrap(currentDetail["avatar"] as? [String: Any])
                avatar.removeValue(forKey: "asset")
                currentDetail["avatar"] = avatar
                throw URLError(.networkConnectionLost)
            default:
                XCTFail("Unexpected avatar lifecycle request: \(request.httpMethod ?? "nil") \(path)")
                return try Self.jsonResponse(
                    request,
                    status: 404,
                    object: ["error": try XCTUnwrap(fixture["error"])]
                )
            }
        }

        let session = Self.mockSession()
        let keychain = AidenAvatarMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            typedFixture.pairingExchange,
            trust: .init(mode: .system),
            name: "Avatar Mac",
            validatedServer: typedFixture.server
        )
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { _, credential in
                AidenRemoteClient(
                    endpoint: URL(string: "https://aiden-fixture.example.test/api/aiden/v1")!,
                    credential: credential,
                    session: session
                )
            }
        )
        await coordinator.start()
        XCTAssertEqual(coordinator.connectionState, .connected)
        let model = AidenBotGeneratedAvatarModel(
            coordinator: coordinator,
            botID: "bot_fixture_01",
            cache: cache
        )
        await model.sessionDidChangeAndRefresh()
        XCTAssertFalse(model.hasGeneratedAvatar)

        await model.ingestCopiedCandidate(data: firstCandidate)
        await model.useCandidate() // definite 400; key must be discarded
        XCTAssertTrue(model.hasCandidate)
        await model.useCandidate() // lost response with no commit; key retained
        XCTAssertTrue(model.hasCandidate)
        await model.useCandidate() // same key succeeds

        XCTAssertEqual(putCount, 3)
        XCTAssertNotEqual(putKeys[0], putKeys[1])
        XCTAssertEqual(putKeys[1], putKeys[2])
        XCTAssertEqual(putMatches, [initialBotRevision, initialBotRevision, initialBotRevision])
        XCTAssertFalse(model.hasCandidate)
        XCTAssertEqual(model.authoritativeBot?.avatar.asset?.assetRevision, firstRevision)
        XCTAssertNotNil(model.currentImage)
        let cachedFirst = await cache.avatar(
            instanceId: typedFixture.pairingExchange.instanceId,
            deviceId: typedFixture.pairingExchange.deviceId,
            botId: "bot_fixture_01",
            assetRevision: firstRevision
        )
        XCTAssertEqual(cachedFirst, firstCandidate)

        await model.ingestCopiedCandidate(data: secondCandidate)
        await model.useCandidate()
        XCTAssertEqual(putCount, 4)
        XCTAssertEqual(putMatches.last, firstRevision)
        XCTAssertEqual(model.authoritativeBot?.avatar.asset?.assetRevision, secondRevision)

        await model.revertToSemanticAvatar()
        XCTAssertEqual(deleteMatches, [secondRevision])
        XCTAssertFalse(model.hasGeneratedAvatar)
        XCTAssertNil(model.currentImage)
        let cachedSecond = await cache.avatar(
            instanceId: typedFixture.pairingExchange.instanceId,
            deviceId: typedFixture.pairingExchange.deviceId,
            botId: "bot_fixture_01",
            assetRevision: secondRevision
        )
        XCTAssertNil(cachedSecond)
    }

    @MainActor
    func testLostUploadResponseThatCommittedReconcilesWithoutReplay() async throws {
        let fixture = try Self.fixtureObject()
        let typedFixture = try Self.typedFixture()
        let candidate = try AidenBotGeneratedAvatarNormalizer.normalize(
            Self.solidImageData(width: 760, height: 820, color: .systemTeal)
        )
        let revision = "avatar_revision_\(String(repeating: "d", count: 32))"
        let asset = Self.assetObject(revision: revision, byteSize: candidate.count)
        var currentDetail = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
        currentDetail = try Self.detailObject(base: currentDetail, asset: nil)
        var putCount = 0
        var putKeys: [String] = []

        AidenAvatarURLProtocol.handler = { request in
            let path = try XCTUnwrap(request.url?.path)
            switch (request.httpMethod, path) {
            case ("GET", "/api/aiden/v1/server"):
                return try Self.jsonResponse(request, status: 200, object: try XCTUnwrap(fixture["server"]))
            case ("GET", "/api/aiden/v1/workspaces"):
                return try Self.jsonResponse(request, status: 200, object: ["workspaces": []])
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01"):
                return try Self.jsonResponse(request, status: 200, object: currentDetail)
            case ("PUT", "/api/aiden/v1/bots/bot_fixture_01/avatar"):
                putCount += 1
                putKeys.append(try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key")))
                currentDetail = try Self.detailObject(base: currentDetail, asset: asset)
                throw URLError(.networkConnectionLost)
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01/avatar/\(revision)"):
                return try Self.imageResponse(request, data: candidate)
            default:
                XCTFail("Unexpected committed-upload request \(request.httpMethod ?? "nil") \(path)")
                return try Self.jsonResponse(
                    request,
                    status: 404,
                    object: ["error": try XCTUnwrap(fixture["error"])]
                )
            }
        }

        let keychain = AidenAvatarMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            typedFixture.pairingExchange,
            trust: .init(mode: .system),
            name: "Avatar Mac",
            validatedServer: typedFixture.server
        )
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { _, credential in
                AidenRemoteClient(
                    endpoint: typedFixture.pairingExchange.endpoint,
                    credential: credential,
                    session: Self.mockSession()
                )
            }
        )
        await coordinator.start()
        let model = AidenBotGeneratedAvatarModel(coordinator: coordinator, botID: "bot_fixture_01")
        await model.sessionDidChangeAndRefresh()
        await model.ingestCopiedCandidate(data: candidate)

        await model.useCandidate()

        XCTAssertEqual(putCount, 1)
        XCTAssertEqual(putKeys.count, 1)
        XCTAssertFalse(model.hasCandidate)
        XCTAssertFalse(model.isBusy)
        XCTAssertEqual(model.phase, .idle)
        XCTAssertEqual(model.authoritativeBot?.avatar.asset?.assetRevision, revision)
        XCTAssertNotNil(model.currentImage)
    }

    @MainActor
    func testRetainedAmbiguousUploadRetryStaysSingleFlightThroughReconciliation() async throws {
        let fixture = try Self.fixtureObject()
        let typedFixture = try Self.typedFixture()
        let candidate = try AidenBotGeneratedAvatarNormalizer.normalize(
            Self.solidImageData(width: 810, height: 790, color: .systemMint)
        )
        let revision = "avatar_revision_\(String(repeating: "e", count: 32))"
        let asset = Self.assetObject(revision: revision, byteSize: candidate.count)
        var currentDetail = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
        currentDetail = try Self.detailObject(base: currentDetail, asset: nil)
        var putCount = 0
        var putKeys: [String] = []
        let reconciliationEntered = expectation(description: "retained upload reconciliation entered")

        AidenAvatarURLProtocol.handler = { request in
            let path = try XCTUnwrap(request.url?.path)
            switch (request.httpMethod, path) {
            case ("GET", "/api/aiden/v1/server"):
                return try Self.jsonResponse(request, status: 200, object: try XCTUnwrap(fixture["server"]))
            case ("GET", "/api/aiden/v1/workspaces"):
                return try Self.jsonResponse(request, status: 200, object: ["workspaces": []])
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01"):
                return try Self.jsonResponse(request, status: 200, object: currentDetail)
            case ("PUT", "/api/aiden/v1/bots/bot_fixture_01/avatar"):
                putCount += 1
                putKeys.append(try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key")))
                if putCount == 1 {
                    throw URLError(.networkConnectionLost)
                }
                currentDetail = try Self.detailObject(base: currentDetail, asset: asset)
                return try Self.jsonResponse(request, status: 200, object: asset)
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01/avatar/\(revision)"):
                return try Self.imageResponse(request, data: candidate)
            default:
                XCTFail("Unexpected single-flight request \(request.httpMethod ?? "nil") \(path)")
                return try Self.jsonResponse(
                    request,
                    status: 404,
                    object: ["error": try XCTUnwrap(fixture["error"])]
                )
            }
        }

        let keychain = AidenAvatarMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            typedFixture.pairingExchange,
            trust: .init(mode: .system),
            name: "Avatar Mac",
            validatedServer: typedFixture.server
        )
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { _, credential in
                AidenRemoteClient(
                    endpoint: typedFixture.pairingExchange.endpoint,
                    credential: credential,
                    session: Self.mockSession()
                )
            }
        )
        await coordinator.start()
        let model = AidenBotGeneratedAvatarModel(coordinator: coordinator, botID: "bot_fixture_01")
        await model.sessionDidChangeAndRefresh()
        await model.ingestCopiedCandidate(data: candidate)
        await model.useCandidate()
        XCTAssertEqual(putCount, 1)
        XCTAssertTrue(model.hasCandidate)

        AidenAvatarURLProtocol.deferNextResponse(
            path: "/api/aiden/v1/bots/bot_fixture_01",
            onDeferred: { reconciliationEntered.fulfill() }
        )
        let retry = Task { await model.useCandidate() }
        await fulfillment(of: [reconciliationEntered], timeout: 2)
        XCTAssertTrue(model.isBusy)
        let duplicate = Task { await model.useCandidate() }
        await duplicate.value
        XCTAssertEqual(putCount, 1)
        XCTAssertTrue(model.isBusy)

        AidenAvatarURLProtocol.completeDeferredResponse()
        await retry.value

        XCTAssertEqual(putCount, 2)
        XCTAssertEqual(putKeys.count, 2)
        XCTAssertEqual(putKeys[0], putKeys[1])
        XCTAssertFalse(model.isBusy)
        XCTAssertFalse(model.hasCandidate)
        XCTAssertEqual(model.authoritativeBot?.avatar.asset?.assetRevision, revision)
    }

    @MainActor
    func testOverlappingSameContextLoadsPublishOnlyNewestAttempt() async throws {
        let fixture = try Self.fixtureObject()
        let typedFixture = try Self.typedFixture()
        let oldBytes = try AidenBotGeneratedAvatarNormalizer.normalize(
            Self.solidImageData(width: 700, height: 700, color: .systemRed)
        )
        let newBytes = try AidenBotGeneratedAvatarNormalizer.normalize(
            Self.solidImageData(width: 700, height: 700, color: .systemGreen)
        )
        let oldRevision = "avatar_revision_\(String(repeating: "a", count: 32))"
        let newRevision = "avatar_revision_\(String(repeating: "b", count: 32))"
        let base = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
        let oldDetail = try Self.detailObject(
            base: base,
            asset: Self.assetObject(revision: oldRevision, byteSize: oldBytes.count)
        )
        let newDetail = try Self.detailObject(
            base: base,
            asset: Self.assetObject(revision: newRevision, byteSize: newBytes.count)
        )
        let firstEntered = expectation(description: "first Bot detail load entered")
        let countLock = NSLock()
        var botLoadCount = 0

        AidenAvatarURLProtocol.handler = { request in
            let path = try XCTUnwrap(request.url?.path)
            switch (request.httpMethod, path) {
            case ("GET", "/api/aiden/v1/server"):
                return try Self.jsonResponse(request, status: 200, object: try XCTUnwrap(fixture["server"]))
            case ("GET", "/api/aiden/v1/workspaces"):
                return try Self.jsonResponse(request, status: 200, object: ["workspaces": []])
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01"):
                countLock.lock()
                botLoadCount += 1
                let load = botLoadCount
                countLock.unlock()
                if load == 1 {
                    return try Self.jsonResponse(request, status: 200, object: oldDetail)
                }
                return try Self.jsonResponse(request, status: 200, object: newDetail)
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01/avatar/\(oldRevision)"):
                return try Self.imageResponse(request, data: oldBytes)
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01/avatar/\(newRevision)"):
                return try Self.imageResponse(request, data: newBytes)
            default:
                XCTFail("Unexpected overlapping-load request \(request.httpMethod ?? "nil") \(path)")
                return try Self.jsonResponse(
                    request,
                    status: 404,
                    object: ["error": try XCTUnwrap(fixture["error"])]
                )
            }
        }

        let keychain = AidenAvatarMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            typedFixture.pairingExchange,
            trust: .init(mode: .system),
            name: "Avatar Mac",
            validatedServer: typedFixture.server
        )
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { _, credential in
                AidenRemoteClient(
                    endpoint: typedFixture.pairingExchange.endpoint,
                    credential: credential,
                    session: Self.mockSession()
                )
            }
        )
        await coordinator.start()
        let cacheRoot = FileManager.default.temporaryDirectory
            .appending(path: "aiden-avatar-load-token-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: cacheRoot) }
        let cache = AidenBotCache(root: cacheRoot)
        let model = AidenBotGeneratedAvatarModel(
            coordinator: coordinator,
            botID: "bot_fixture_01",
            cache: cache
        )

        AidenAvatarURLProtocol.deferNextResponse(
            path: "/api/aiden/v1/bots/bot_fixture_01",
            onDeferred: { firstEntered.fulfill() }
        )
        let oldTask = Task { await model.sessionDidChangeAndRefresh() }
        await fulfillment(of: [firstEntered], timeout: 2)
        let newTask = Task { await model.sessionDidChangeAndRefresh() }
        await newTask.value
        AidenAvatarURLProtocol.completeDeferredResponse()
        await oldTask.value

        XCTAssertEqual(model.authoritativeBot?.avatar.asset?.assetRevision, newRevision)
        XCTAssertNotNil(model.currentImage)
        let staleCached = await cache.avatar(
            instanceId: typedFixture.pairingExchange.instanceId,
            deviceId: typedFixture.pairingExchange.deviceId,
            botId: "bot_fixture_01",
            assetRevision: oldRevision
        )
        let currentCached = await cache.avatar(
            instanceId: typedFixture.pairingExchange.instanceId,
            deviceId: typedFixture.pairingExchange.deviceId,
            botId: "bot_fixture_01",
            assetRevision: newRevision
        )
        XCTAssertNil(staleCached)
        XCTAssertEqual(currentCached, newBytes)
    }

    @MainActor
    func testConcurrentMacReplacementClearsUnconfirmedCandidateAndShowsAuthoritativePhoto() async throws {
        let fixture = try Self.fixtureObject()
        let typedFixture = try Self.typedFixture()
        let candidate = try AidenBotGeneratedAvatarNormalizer.normalize(
            Self.solidImageData(width: 800, height: 800, color: .systemRed)
        )
        let macPhoto = try AidenBotGeneratedAvatarNormalizer.normalize(
            Self.solidImageData(width: 800, height: 800, color: .systemGreen)
        )
        let macRevision = "avatar_revision_\(String(repeating: "c", count: 32))"
        let macAsset = Self.assetObject(revision: macRevision, byteSize: macPhoto.count)
        var currentDetail = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
        currentDetail = try Self.detailObject(base: currentDetail, asset: nil)
        var putCount = 0

        AidenAvatarURLProtocol.handler = { request in
            let path = try XCTUnwrap(request.url?.path)
            switch (request.httpMethod, path) {
            case ("GET", "/api/aiden/v1/server"):
                return try Self.jsonResponse(request, status: 200, object: try XCTUnwrap(fixture["server"]))
            case ("GET", "/api/aiden/v1/workspaces"):
                return try Self.jsonResponse(request, status: 200, object: ["workspaces": []])
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01"):
                return try Self.jsonResponse(request, status: 200, object: currentDetail)
            case ("PUT", "/api/aiden/v1/bots/bot_fixture_01/avatar"):
                putCount += 1
                XCTFail("Preflight avatar drift must stop before PUT")
                return try Self.jsonResponse(request, status: 200, object: macAsset)
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01/avatar/\(macRevision)"):
                return try Self.imageResponse(request, data: macPhoto)
            default:
                return try Self.jsonResponse(
                    request,
                    status: 404,
                    object: ["error": try XCTUnwrap(fixture["error"])]
                )
            }
        }

        let keychain = AidenAvatarMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            typedFixture.pairingExchange,
            trust: .init(mode: .system),
            name: "Avatar Mac",
            validatedServer: typedFixture.server
        )
        let session = Self.mockSession()
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { _, credential in
                AidenRemoteClient(
                    endpoint: typedFixture.pairingExchange.endpoint,
                    credential: credential,
                    session: session
                )
            }
        )
        await coordinator.start()
        let model = AidenBotGeneratedAvatarModel(coordinator: coordinator, botID: "bot_fixture_01")
        await model.sessionDidChangeAndRefresh()
        await model.ingestCopiedCandidate(data: candidate)
        currentDetail = try Self.detailObject(base: currentDetail, asset: macAsset)

        await model.useCandidate()

        XCTAssertEqual(putCount, 0)
        XCTAssertFalse(model.hasCandidate)
        XCTAssertEqual(model.authoritativeBot?.avatar.asset?.assetRevision, macRevision)
        XCTAssertNotNil(model.currentImage)
        XCTAssertEqual(model.phase, .idle)
        XCTAssertTrue(model.errorMessage?.contains("changed on your paired desktop") == true)
    }

    @MainActor
    func testConcurrentMacReplacementBlocksDeleteUntilPhotoIsReconfirmed() async throws {
        let fixture = try Self.fixtureObject()
        let typedFixture = try Self.typedFixture()
        let observedPhoto = try AidenBotGeneratedAvatarNormalizer.normalize(
            Self.solidImageData(width: 800, height: 800, color: .systemBlue)
        )
        let replacementPhoto = try AidenBotGeneratedAvatarNormalizer.normalize(
            Self.solidImageData(width: 800, height: 800, color: .systemYellow)
        )
        let observedRevision = "avatar_revision_\(String(repeating: "f", count: 32))"
        let replacementRevision = "avatar_revision_\(String(repeating: "9", count: 32))"
        let observedAsset = Self.assetObject(revision: observedRevision, byteSize: observedPhoto.count)
        let replacementAsset = Self.assetObject(revision: replacementRevision, byteSize: replacementPhoto.count)
        var currentDetail = try Self.detailObject(
            base: try XCTUnwrap(fixture["botDetail"] as? [String: Any]),
            asset: observedAsset
        )
        var deleteCount = 0

        AidenAvatarURLProtocol.handler = { request in
            let path = try XCTUnwrap(request.url?.path)
            switch (request.httpMethod, path) {
            case ("GET", "/api/aiden/v1/server"):
                return try Self.jsonResponse(request, status: 200, object: try XCTUnwrap(fixture["server"]))
            case ("GET", "/api/aiden/v1/workspaces"):
                return try Self.jsonResponse(request, status: 200, object: ["workspaces": []])
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01"):
                return try Self.jsonResponse(request, status: 200, object: currentDetail)
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01/avatar/\(observedRevision)"):
                return try Self.imageResponse(request, data: observedPhoto)
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01/avatar/\(replacementRevision)"):
                return try Self.imageResponse(request, data: replacementPhoto)
            case ("DELETE", "/api/aiden/v1/bots/bot_fixture_01/avatar"):
                deleteCount += 1
                XCTFail("Preflight avatar drift must stop before DELETE")
                return try Self.jsonResponse(request, status: 200, object: currentDetail)
            default:
                XCTFail("Unexpected delete-drift request \(request.httpMethod ?? "nil") \(path)")
                return try Self.jsonResponse(
                    request,
                    status: 404,
                    object: ["error": try XCTUnwrap(fixture["error"])]
                )
            }
        }

        let keychain = AidenAvatarMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            typedFixture.pairingExchange,
            trust: .init(mode: .system),
            name: "Avatar Mac",
            validatedServer: typedFixture.server
        )
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { _, credential in
                AidenRemoteClient(
                    endpoint: typedFixture.pairingExchange.endpoint,
                    credential: credential,
                    session: Self.mockSession()
                )
            }
        )
        await coordinator.start()
        let model = AidenBotGeneratedAvatarModel(coordinator: coordinator, botID: "bot_fixture_01")
        await model.sessionDidChangeAndRefresh()
        XCTAssertEqual(model.authoritativeBot?.avatar.asset?.assetRevision, observedRevision)
        currentDetail = try Self.detailObject(base: currentDetail, asset: replacementAsset)

        await model.revertToSemanticAvatar()

        XCTAssertEqual(deleteCount, 0)
        XCTAssertFalse(model.isBusy)
        XCTAssertEqual(model.phase, .idle)
        XCTAssertEqual(model.authoritativeBot?.avatar.asset?.assetRevision, replacementRevision)
        XCTAssertNotNil(model.currentImage)
        XCTAssertTrue(model.errorMessage?.contains("changed on your paired desktop") == true)
    }

    @MainActor
    func testCredentialRevocationDuringNestedUploadReconciliationPurgesRasterAuthority() async throws {
        let fixture = try Self.fixtureObject()
        let typedFixture = try Self.typedFixture()
        var detail = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
        detail = try Self.detailObject(base: detail, asset: nil)
        var revoked = false

        AidenAvatarURLProtocol.handler = { request in
            let path = try XCTUnwrap(request.url?.path)
            switch (request.httpMethod, path) {
            case ("GET", "/api/aiden/v1/server"):
                return try Self.jsonResponse(request, status: 200, object: try XCTUnwrap(fixture["server"]))
            case ("GET", "/api/aiden/v1/workspaces"):
                return try Self.jsonResponse(request, status: 200, object: ["workspaces": []])
            case ("GET", "/api/aiden/v1/bots/bot_fixture_01"):
                if revoked {
                    return try Self.jsonResponse(
                        request,
                        status: 403,
                        object: ["error": [
                            "code": "credential_revoked",
                            "message": "This device credential was revoked.",
                            "requestId": "request_avatar_revoked",
                            "retryable": false,
                        ]]
                    )
                }
                return try Self.jsonResponse(request, status: 200, object: detail)
            case ("PUT", "/api/aiden/v1/bots/bot_fixture_01/avatar"):
                revoked = true
                throw URLError(.networkConnectionLost)
            default:
                return try Self.jsonResponse(
                    request,
                    status: 404,
                    object: ["error": try XCTUnwrap(fixture["error"])]
                )
            }
        }

        let keychain = AidenAvatarMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        _ = try store.savePairing(
            typedFixture.pairingExchange,
            trust: .init(mode: .system),
            name: "Avatar Mac",
            validatedServer: typedFixture.server
        )
        let session = Self.mockSession()
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { _, credential in
                AidenRemoteClient(
                    endpoint: typedFixture.pairingExchange.endpoint,
                    credential: credential,
                    session: session
                )
            }
        )
        await coordinator.start()
        let model = AidenBotGeneratedAvatarModel(coordinator: coordinator, botID: "bot_fixture_01")
        await model.sessionDidChangeAndRefresh()
        await model.ingestCopiedCandidate(
            data: Self.solidImageData(width: 700, height: 700, color: .systemPurple)
        )

        await model.useCandidate()

        XCTAssertNil(store.activeInstallation)
        XCTAssertEqual(coordinator.connectionState, .needsPairing)
        XCTAssertFalse(model.hasCandidate)
        XCTAssertNil(model.currentImage)
        XCTAssertNil(model.authoritativeBot)
    }

    private static func fixtureURL() throws -> URL {
        try XCTUnwrap(
            Bundle(for: AidenBotGeneratedAvatarTests.self)
                .url(forResource: "contract", withExtension: "json")
        )
    }

    private static func fixtureObject() throws -> [String: Any] {
        return try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL())) as? [String: Any]
        )
    }

    private static func typedFixture() throws -> AidenRemoteContractFixture {
        try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: fixtureURL())
        )
    }

    private static func decodeDetail(_ object: [String: Any]) throws -> AidenBotDetail {
        try AidenRemoteJSONDecoder.decode(
            AidenBotDetail.self,
            from: JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        )
    }

    private static func solidImageData(
        width: Int,
        height: Int,
        color: UIColor = .systemIndigo
    ) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(
            size: CGSize(width: width, height: height),
            format: format
        ).pngData { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    private static func splitImageData(width: Int, height: Int) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(
            size: CGSize(width: width, height: height),
            format: format
        ).pngData { context in
            UIColor.systemRed.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: width / 2, y: 0, width: width / 2, height: height))
        }
    }

    private static func assetObject(revision: String, byteSize: Int) -> [String: Any] {
        [
            "assetRevision": revision,
            "mimeType": "image/png",
            "width": 512,
            "height": 512,
            "byteSize": byteSize,
        ]
    }

    private static func detailObject(
        base: [String: Any],
        asset: [String: Any]?
    ) throws -> [String: Any] {
        var result = base
        var avatar = try XCTUnwrap(result["avatar"] as? [String: Any])
        avatar["asset"] = asset
        if asset == nil { avatar.removeValue(forKey: "asset") }
        result["avatar"] = avatar
        return result
    }

    private static func mockSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AidenAvatarURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static func jsonResponse(
        _ request: URLRequest,
        status: Int,
        object: Any
    ) throws -> (HTTPURLResponse, Data) {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let response = try XCTUnwrap(HTTPURLResponse(
            url: try XCTUnwrap(request.url),
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "application/json",
                "Aiden-Protocol-Version": "1",
            ]
        ))
        return (response, data)
    }

    private static func imageResponse(
        _ request: URLRequest,
        data: Data
    ) throws -> (HTTPURLResponse, Data) {
        let response = try XCTUnwrap(HTTPURLResponse(
            url: try XCTUnwrap(request.url),
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "image/png",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Aiden-Protocol-Version": "1",
            ]
        ))
        return (response, data)
    }

    private static func noisyPNGData(edge: Int) throws -> Data {
        var pixels = Data(count: edge * edge * 4)
        pixels.withUnsafeMutableBytes { rawBuffer in
            guard let bytes = rawBuffer.bindMemory(to: UInt8.self).baseAddress else { return }
            var value: UInt32 = 0xA1D3_5EED
            for index in 0..<(edge * edge * 4) {
                value = value &* 1_664_525 &+ 1_013_904_223
                bytes[index] = UInt8(truncatingIfNeeded: value >> 16)
            }
        }
        let provider = try XCTUnwrap(CGDataProvider(data: pixels as CFData))
        let image = try XCTUnwrap(CGImage(
            width: edge,
            height: edge,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: edge * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        ))
        let output = NSMutableData()
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil)
        )
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return output as Data
    }
}

private final class AidenAvatarURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    private static let lock = NSLock()
    private static var deferredPath: String?
    private static var deferredResponse: (AidenAvatarURLProtocol, HTTPURLResponse, Data)?
    private static var onDeferred: (() -> Void)?

    static func reset() {
        lock.lock()
        handler = nil
        deferredPath = nil
        deferredResponse = nil
        onDeferred = nil
        lock.unlock()
    }

    static func deferNextResponse(path: String, onDeferred: @escaping () -> Void) {
        lock.lock()
        deferredPath = path
        self.onDeferred = onDeferred
        lock.unlock()
    }

    static func completeDeferredResponse() {
        lock.lock()
        let deferred = deferredResponse
        deferredResponse = nil
        lock.unlock()
        if let deferred {
            deferred.0.deliver(response: deferred.1, data: deferred.2)
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (response, data) = try handler(request)
            Self.lock.lock()
            if Self.deferredPath == request.url?.path, Self.deferredResponse == nil {
                Self.deferredPath = nil
                Self.deferredResponse = (self, response, data)
                let callback = Self.onDeferred
                Self.onDeferred = nil
                Self.lock.unlock()
                callback?()
                return
            }
            Self.lock.unlock()
            deliver(response: response, data: data)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() { }

    private func deliver(response: HTTPURLResponse, data: Data) {
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class AidenAvatarMemoryKeychain: KeychainStoring {
    private var values: [String: String] = [:]

    func save(_ value: String, forKey key: KeychainStore.Key) throws {
        values[key.rawValue] = value
    }

    func load(_ key: KeychainStore.Key) throws -> String? { values[key.rawValue] }

    func delete(_ key: KeychainStore.Key) throws { values[key.rawValue] = nil }

    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        values[KeychainStore.scopedKey(key, scope: scope)] = value
    }

    func load(_ key: KeychainStore.Key, scope: String) throws -> String? {
        values[KeychainStore.scopedKey(key, scope: scope)]
    }

    func delete(_ key: KeychainStore.Key, scope: String) throws {
        values[KeychainStore.scopedKey(key, scope: scope)] = nil
    }
}
