package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotAvatarExpectedRevision
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotGeneratedAvatarNormalizer
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotAvatarPresentation
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotGeneratedAvatarError
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotGeneratedAvatarModel
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotGeneratedAvatarPhase

class AidenBotGeneratedAvatarTest {
    @Test
    fun testRetiredEyesAndAccessoryAreAcceptedButNeverChangeTheLookOrTheWire() {
        val json = AidenBotWireJson.json
        for (shape in AidenBotAvatarShape.entries) {
            for (color in AidenBotAvatarColor.entries) {
                val shapeWire = json.encodeToJsonElement(AidenBotAvatarShape.serializer(), shape)
                val colorWire = json.encodeToJsonElement(AidenBotAvatarColor.serializer(), color)
                val withRetired = """{"version":1,"shape":$shapeWire,"color":$colorWire,"eyes":"wide","detail":"orbit"}"""
                val recipe = json.decodeFromString(AidenBotAvatarRecipe.serializer(), withRetired)
                val presentation = aidenBotAvatarPresentation(AidenBotSemanticAvatar.Recipe(recipe))
                assertEquals(shape, presentation.shape)
                assertEquals(color, presentation.color)
                assertEquals(
                    setOf("version", "shape", "color"),
                    json.parseToJsonElement(json.encodeToString(AidenBotAvatarRecipe.serializer(), recipe)).let {
                        (it as kotlinx.serialization.json.JsonObject).keys
                    }
                )
            }
        }
    }

    @Test
    fun testRecipeRejectsUnknownColoursAndRetiredLegacyIds() {
        val json = AidenBotWireJson.json
        assertThrows(Exception::class.java) {
            json.decodeFromString(AidenBotAvatarRecipe.serializer(), """{"version":1,"shape":"orb","color":"teal"}""")
        }
        assertThrows(Exception::class.java) {
            json.decodeFromString(AidenBotSemanticAvatar.serializer(), "\"orbit\"")
        }
        assertEquals(12, AidenBotAvatarColor.entries.size)
    }

    @Test
    fun testAvatarUploadValidation() {
        val validPngData = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0)
        val base64 = Base64.getEncoder().encodeToString(validPngData)

        val upload = AidenBotAvatarUpload(
            mimeType = AidenBotAvatarUploadMimeType.PNG,
            data = base64
        )
        assertEquals(base64, upload.data)

        // Invalid non-base64 throws
        assertThrows(AidenBotContractException.InvalidField::class.java) {
            AidenBotAvatarUpload(
                mimeType = AidenBotAvatarUploadMimeType.PNG,
                data = "not_valid_base64!!"
            )
        }
    }

    @Test
    fun testCanonicalAvatarCacheIdentityChangesOnlyWithScopeOrAssetRevision() {
        data class CanonicalAvatarCacheKey(
            val instanceId: String,
            val deviceId: String,
            val botId: String,
            val assetRevision: String
        )

        val original = CanonicalAvatarCacheKey("mac-a", "phone-a", "bot-a", "avatar-1")
        val same = CanonicalAvatarCacheKey("mac-a", "phone-a", "bot-a", "avatar-1")
        val differentRev = CanonicalAvatarCacheKey("mac-a", "phone-a", "bot-a", "avatar-2")
        val differentDev = CanonicalAvatarCacheKey("mac-a", "phone-b", "bot-a", "avatar-1")

        assertEquals(original, same)
        assertNotEquals(original, differentRev)
        assertNotEquals(original, differentDev)
    }

    @Test
    fun testNormalizerRejectsCorruptAndOversizedInputs() {
        assertThrows(Exception::class.java) {
            AidenBotGeneratedAvatarNormalizer.normalize(byteArrayOf(1, 2, 3))
        }
        assertThrows(Exception::class.java) {
            AidenBotGeneratedAvatarNormalizer.normalize(ByteArray(0))
        }
        assertThrows(Exception::class.java) {
            AidenBotGeneratedAvatarNormalizer.normalize(ByteArray(AidenBotGeneratedAvatarNormalizer.MAXIMUM_SOURCE_BYTES + 1))
        }
    }

    @Test
    fun testExpectedRevisionUsesBotRevisionFirstThenAssetRevision() {
        val summaryWithoutAsset = AidenBotSummary(
            id = "bot-1",
            name = "Bot",
            purpose = "Purpose",
            avatar = AidenBotAvatarView(semantic = AidenBotSemanticAvatar.Recipe(AidenBotAvatarRecipe(shape = AidenBotAvatarShape.ORB, color = AidenBotAvatarColor.LILAC))),
            health = AidenBotHealth.READY,
            createdAt = java.time.Instant.now(),
            updatedAt = java.time.Instant.now(),
            revision = "bot_revision_1"
        )
        assertEquals("bot_revision_1", aidenBotAvatarExpectedRevision(summaryWithoutAsset))

        val summaryWithAsset = summaryWithoutAsset.copy(
            avatar = AidenBotAvatarView(
                semantic = AidenBotSemanticAvatar.Recipe(AidenBotAvatarRecipe(shape = AidenBotAvatarShape.ORB, color = AidenBotAvatarColor.LILAC)),
                asset = AidenBotAvatarAsset(
                    assetRevision = "avatar_rev_42",
                    mimeType = AidenBotAvatarAssetMimeType.PNG,
                    width = 512,
                    height = 512,
                    byteSize = 1024
                )
            )
        )
        assertEquals("avatar_rev_42", aidenBotAvatarExpectedRevision(summaryWithAsset))
    }

    @Test
    fun testMutationAmbiguityClassification() {
        fun isAmbiguous(statusCode: Int?, isNetworkError: Boolean): Boolean {
            if (isNetworkError) return true
            return statusCode == 503 || statusCode == 504
        }

        assertTrue(isAmbiguous(null, isNetworkError = true))
        assertTrue(isAmbiguous(503, isNetworkError = false))
        assertTrue(isAmbiguous(504, isNetworkError = false))
        assertFalse(isAmbiguous(400, isNetworkError = false))
        assertFalse(isAmbiguous(409, isNetworkError = false))
        assertFalse(isAmbiguous(422, isNetworkError = false))
    }

    @Test
    fun aLaterPhotoSelectionSupersedesAnEarlierOneStillNormalizing() {
        val directory = kotlin.io.path.createTempDirectory("avatar-selection-").toFile()
        val main = java.util.concurrent.Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val firstStarted = java.util.concurrent.CountDownLatch(1)
        val releaseFirst = java.util.concurrent.CountDownLatch(1)
        val first = byteArrayOf(1)
        val second = byteArrayOf(2)
        try {
            val coordinator = AidenRemoteCoordinator(
                installationStore = AidenInstallationStore(directory, InMemoryAidenSecureStore()),
                storageDir = directory,
                chatCache = AidenChatCache(directory),
                scope = CoroutineScope(Dispatchers.Unconfined + Job().apply { cancel() })
            )
            // The first photo is slow and then turns out to be invalid; the second is fine.
            val model = AidenBotGeneratedAvatarModel(coordinator, normalize = { data ->
                if (data.contentEquals(first)) {
                    firstStarted.countDown()
                    releaseFirst.await(5, java.util.concurrent.TimeUnit.SECONDS)
                    throw AidenBotGeneratedAvatarError.InvalidImage
                }
                byteArrayOf(9)
            })
            runBlocking(main) {
                val earlier = async { model.setCandidate(first) }
                withContext(Dispatchers.IO) { assertTrue(firstStarted.await(5, java.util.concurrent.TimeUnit.SECONDS)) }
                assertTrue("the latest selection is current", model.setCandidate(second))
                releaseFirst.countDown()
                assertFalse("a superseded selection must not upload", earlier.await())
            }
            assertEquals(AidenBotGeneratedAvatarPhase.READY, model.phase.value)
            assertNull(model.errorMessage.value)
            assertTrue(model.hasCandidate)
        } finally {
            main.close()
            directory.deleteRecursively()
        }
    }

    @Test
    fun aPhotoPickedDuringAnUploadKeepsItsStateWhenThatUploadEnds() {
        val directory = kotlin.io.path.createTempDirectory("avatar-upload-").toFile()
        val main = java.util.concurrent.Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val uploadArrived = java.util.concurrent.CountDownLatch(1)
        val releaseUpload = java.util.concurrent.CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.method == "PUT" && request.requestUrl!!.encodedPath.endsWith("/bots/bot-1/avatar")) {
                    uploadArrived.countDown()
                    releaseUpload.await(5, java.util.concurrent.TimeUnit.SECONDS)
                    MockResponse().setResponseCode(503).setBody(
                        """{"error":{"code":"internal_error","message":"Upload failed","requestId":"r","retryable":true}}""")
                } else MockResponse().setResponseCode(404)
        }
        server.start()
        try {
            val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
            installations.addInstallation(AidenPairingExchange(instanceId = "instance-avatar", deviceId = "device-avatar",
                endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test", credential = "synthetic",
                capabilities = listOf(AidenRemoteCapability.CHAT_READ)), null)
            val coordinator = AidenRemoteCoordinator(
                installationStore = installations,
                storageDir = directory,
                chatCache = AidenChatCache(directory),
                scope = CoroutineScope(Dispatchers.Unconfined + Job().apply { cancel() })
            )
            coordinator.refreshClient()
            val model = AidenBotGeneratedAvatarModel(coordinator, normalize = { it })
            runBlocking(main) {
                assertTrue(model.setCandidate(byteArrayOf(1)))
                val upload = launch { model.uploadAvatar("bot-1", "rev-1") { fail("the upload failed") } }
                withContext(Dispatchers.IO) { assertTrue(uploadArrived.await(5, java.util.concurrent.TimeUnit.SECONDS)) }
                // A second photo is picked and ready while the first upload is still on the wire.
                assertTrue(model.setCandidate(byteArrayOf(2)))
                releaseUpload.countDown()
                upload.join()
            }
            assertEquals("the first upload's failure must not take over the second photo",
                AidenBotGeneratedAvatarPhase.READY, model.phase.value)
            assertNull(model.errorMessage.value)
            assertTrue(model.hasCandidate)
        } finally {
            releaseUpload.countDown()
            server.shutdown()
            main.close()
            directory.deleteRecursively()
        }
    }

    @Test
    fun aPhotoTheMacTookStaysTheBaseForTheNextChangeWhenTheBotCannotBeReRead() {
        val directory = kotlin.io.path.createTempDirectory("avatar-commit-").toFile()
        val server = MockWebServer()
        val uploads = java.util.concurrent.LinkedBlockingQueue<RecordedRequest>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                return when {
                    request.method == "PUT" && path.endsWith("/bots/bot-1/avatar") -> {
                        uploads.add(request)
                        val next = "avatar_rev_${uploads.size}"
                        MockResponse().setResponseCode(200).setBody(
                            """{"assetRevision":"$next","mimeType":"image/png","width":512,"height":512,"byteSize":3}""")
                    }
                    request.method == "GET" && path.endsWith("/bots/bot-1") -> MockResponse().setResponseCode(503).setBody(
                        """{"error":{"code":"internal_error","message":"Busy","requestId":"r","retryable":true}}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        try {
            val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
            installations.addInstallation(AidenPairingExchange(instanceId = "instance-avatar", deviceId = "device-avatar",
                endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test", credential = "synthetic",
                capabilities = listOf(AidenRemoteCapability.CHAT_READ)), null)
            val coordinator = AidenRemoteCoordinator(
                installationStore = installations,
                storageDir = directory,
                chatCache = AidenChatCache(directory),
                scope = CoroutineScope(Dispatchers.Unconfined + Job().apply { cancel() })
            )
            coordinator.refreshClient()
            val model = AidenBotGeneratedAvatarModel(coordinator, normalize = { it })
            // The page still holds the Bot from before either photo: no asset, Bot revision rev-1.
            val pageBot = sbtbiswas.AidenOnTheGo.models.AidenBotDetail(
                id = "bot-1", name = "Helper", purpose = "Assists", instructions = "Be concise.",
                avatar = sbtbiswas.AidenOnTheGo.models.AidenBotAvatarView(
                    semantic = sbtbiswas.AidenOnTheGo.models.AidenBotSemanticAvatar.Recipe(
                        sbtbiswas.AidenOnTheGo.models.AidenBotAvatarRecipe(
                            shape = sbtbiswas.AidenOnTheGo.models.AidenBotAvatarShape.ORB,
                            color = sbtbiswas.AidenOnTheGo.models.AidenBotAvatarColor.LILAC))),
                health = sbtbiswas.AidenOnTheGo.models.AidenBotHealth.READY,
                createdAt = java.time.Instant.EPOCH, updatedAt = java.time.Instant.EPOCH,
                revision = "rev-1",
                access = sbtbiswas.AidenOnTheGo.models.AidenBotAccessView(
                    botId = "bot-1", accessMode = sbtbiswas.AidenOnTheGo.models.AidenBotAccessMode.FULL,
                    revision = "pol-1", policyEpoch = "epoch-1", summary = "Full access"))
            runBlocking {
                assertTrue(model.setCandidate(byteArrayOf(1)))
                model.uploadAvatar("bot-1", model.expectedAvatarRevision(pageBot)) { fail("the Bot could not be re-read") }
                assertEquals("the Mac took the photo, so the page does not report a failed upload",
                    AidenBotGeneratedAvatarPhase.IDLE, model.phase.value)
                assertNull(model.errorMessage.value)

                assertTrue(model.setCandidate(byteArrayOf(2)))
                model.uploadAvatar("bot-1", model.expectedAvatarRevision(pageBot)) { fail("the Bot could not be re-read") }
            }
            val first = uploads.poll(5, java.util.concurrent.TimeUnit.SECONDS)!!
            val second = uploads.poll(5, java.util.concurrent.TimeUnit.SECONDS)!!
            assertEquals("rev-1", first.getHeader("If-Match"))
            assertEquals("the next photo matches the revision the first one committed",
                "avatar_rev_1", second.getHeader("If-Match"))
        } finally {
            server.shutdown()
            directory.deleteRecursively()
        }
    }
}
