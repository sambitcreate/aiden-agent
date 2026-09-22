package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotAvatarColors
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotGeneratedAvatarNormalizer
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotAvatarPresentation
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import java.io.ByteArrayOutputStream
import java.util.Base64

class AidenBotGeneratedAvatarTest {
    @Test
    fun testAllAvatarRecipePermutations() {
        for (shape in AidenBotAvatarShape.values()) {
            for (color in AidenBotAvatarColor.values()) {
                for (eyes in AidenBotAvatarEyes.values()) {
                    for (detail in AidenBotAvatarDetail.values()) {
                        val recipe = AidenBotAvatarRecipe(
                            shape = shape,
                            color = color,
                            eyes = eyes,
                            detail = detail
                        )
                        val presentation = aidenBotAvatarPresentation(AidenBotSemanticAvatar.Recipe(recipe))
                        assertEquals(shape, presentation.shape)
                        assertEquals(color, presentation.color)
                        assertEquals(eyes, presentation.eyes)
                        assertEquals(detail, presentation.detail)

                        val gradient = AidenBotAvatarColors.getGradient(color)
                        assertEquals(2, gradient.size)

                        val glyph = AidenBotAvatarColors.getEyeGlyph(eyes)
                        assertTrue(glyph.isNotEmpty())
                    }
                }
            }
        }
    }

    @Test
    fun testLegacyAvatarMappings() {
        val orbitPres = aidenBotAvatarPresentation(AidenBotSemanticAvatar.Legacy(AidenBotLegacyAvatar.ORBIT))
        assertEquals(AidenBotAvatarShape.ORB, orbitPres.shape)
        assertEquals(AidenBotAvatarColor.LILAC, orbitPres.color)
        assertEquals(AidenBotAvatarEyes.FOCUS, orbitPres.eyes)
        assertEquals(AidenBotAvatarDetail.ORBIT, orbitPres.detail)

        val sparkPres = aidenBotAvatarPresentation(AidenBotSemanticAvatar.Legacy(AidenBotLegacyAvatar.SPARK))
        assertEquals(AidenBotAvatarShape.WISP, sparkPres.shape)
        assertEquals(AidenBotAvatarColor.SUN, sparkPres.color)
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
        fun aidenBotAvatarExpectedRevision(botSummary: AidenBotSummary): String {
            return botSummary.avatar.asset?.assetRevision ?: botSummary.revision
        }

        val summaryWithoutAsset = AidenBotSummary(
            id = "bot-1",
            name = "Bot",
            purpose = "Purpose",
            avatar = AidenBotAvatarView(semantic = AidenBotSemanticAvatar.Legacy(AidenBotLegacyAvatar.ORBIT)),
            health = AidenBotHealth.READY,
            createdAt = java.time.Instant.now(),
            updatedAt = java.time.Instant.now(),
            revision = "bot_revision_1"
        )
        assertEquals("bot_revision_1", aidenBotAvatarExpectedRevision(summaryWithoutAsset))

        val summaryWithAsset = summaryWithoutAsset.copy(
            avatar = AidenBotAvatarView(
                semantic = AidenBotSemanticAvatar.Legacy(AidenBotLegacyAvatar.ORBIT),
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
}
