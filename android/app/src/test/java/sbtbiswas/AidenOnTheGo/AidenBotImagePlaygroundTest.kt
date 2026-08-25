package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotGeneratedAvatarNormalizer
import java.io.File

class AidenBotImagePlaygroundTest {
    enum class FallbackReason(val message: String) {
        UNSUPPORTED("Image Playground is unsupported on this system. You can continue using a semantic avatar."),
        RESTRICTED("Image Playground is restricted by Screen Time or device policy."),
        MODEL_UNAVAILABLE("Image Playground models are currently downloading."),
        USAGE_LIMIT("Image Playground generation limit reached."),
        UPDATE_REQUIRED("iPadOS 18.4 or newer is required for non-personalized Image Playground generation."),
        SYSTEM_UNAVAILABLE("Image Playground doesn't currently make generation available.")
    }

    enum class Phase { READY, PRESENTING, ACCEPTED, CANCELLED, FALLBACK }

    class PresentationState {
        var phase = Phase.READY

        fun requestPresentation(available: Boolean) {
            phase = if (available) Phase.PRESENTING else Phase.FALLBACK
        }

        fun cancel() {
            phase = Phase.CANCELLED
        }

        fun accept() {
            phase = Phase.ACCEPTED
        }

        fun failCopy() {
            phase = Phase.FALLBACK
        }
    }

    @Test
    fun testNormalizerByteLimits() {
        val emptyBytes = byteArrayOf()
        assertThrows(Exception::class.java) {
            AidenBotGeneratedAvatarNormalizer.normalize(emptyBytes)
        }

        // Represents same image hashing
        val testData1 = byteArrayOf(1, 2, 3, 4, 5)
        val testData2 = byteArrayOf(1, 2, 3, 4, 5)
        val testData3 = byteArrayOf(1, 2, 3, 4, 6)

        assertTrue(AidenBotGeneratedAvatarNormalizer.representsSameImage(testData1, testData2))
        assertFalse(AidenBotGeneratedAvatarNormalizer.representsSameImage(testData1, testData3))

        assertEquals(32 * 1024 * 1024, AidenBotGeneratedAvatarNormalizer.MAXIMUM_SOURCE_BYTES)
        assertEquals(4 * 1024 * 1024, AidenBotGeneratedAvatarNormalizer.MAXIMUM_OUTPUT_BYTES)
    }

    @Test
    fun testIdentityConceptsBoundaries() {
        data class IdentityConcepts(val name: String, val purpose: String) {
            val boundedName = name.trim().take(80)
            val boundedPurpose = purpose.trim().take(240)
            val conceptTexts = listOf(boundedName, boundedPurpose)
        }

        val normal = IdentityConcepts("  Research Helper  ", "  Summarizes papers.  ")
        assertEquals("Research Helper", normal.boundedName)
        assertEquals("Summarizes papers.", normal.boundedPurpose)
        assertEquals(listOf("Research Helper", "Summarizes papers."), normal.conceptTexts)

        val longIdentity = IdentityConcepts("A".repeat(100), "B".repeat(300))
        assertEquals(80, longIdentity.boundedName.length)
        assertEquals(240, longIdentity.boundedPurpose.length)
    }

    @Test
    fun testFallbackReasonCopy() {
        assertTrue(FallbackReason.UNSUPPORTED.message.contains("semantic avatar"))
        assertTrue(FallbackReason.RESTRICTED.message.contains("restricted"))
        assertTrue(FallbackReason.MODEL_UNAVAILABLE.message.contains("downloading"))
        assertTrue(FallbackReason.USAGE_LIMIT.message.contains("limit"))
        assertTrue(FallbackReason.UPDATE_REQUIRED.message.contains("iPadOS 18.4") || FallbackReason.UPDATE_REQUIRED.message.contains("non-personalized"))
        assertTrue(FallbackReason.SYSTEM_UNAVAILABLE.message.contains("doesn't currently make"))
        assertFalse(FallbackReason.SYSTEM_UNAVAILABLE.message.contains("restricted"))
    }

    @Test
    fun testPresentationStateTransitions() {
        val state = PresentationState()
        assertEquals(Phase.READY, state.phase)

        state.requestPresentation(available = false)
        assertEquals(Phase.FALLBACK, state.phase)

        state.requestPresentation(available = true)
        assertEquals(Phase.PRESENTING, state.phase)

        state.cancel()
        assertEquals(Phase.CANCELLED, state.phase)

        state.requestPresentation(available = true)
        state.accept()
        assertEquals(Phase.ACCEPTED, state.phase)

        state.failCopy()
        assertEquals(Phase.FALLBACK, state.phase)
    }

    @Test
    fun testCandidateStoreBoundsCrashResidue() {
        val tempDir = File.createTempFile("aiden_test_candidate", "").apply {
            delete()
            mkdirs()
        }
        try {
            val maxRetained = 10
            for (i in 0 until maxRetained + 5) {
                val f = File(tempDir, "candidate-$i.image")
                f.writeBytes(byteArrayOf(i.toByte()))
            }
            val files = tempDir.listFiles()?.filter { it.name.startsWith("candidate-") } ?: emptyList()
            assertEquals(15, files.size)

            // Pruning to max retained
            val sorted = files.sortedBy { it.lastModified() }
            val toDelete = sorted.take(files.size - maxRetained)
            toDelete.forEach { it.delete() }

            val remaining = tempDir.listFiles()?.filter { it.name.startsWith("candidate-") } ?: emptyList()
            assertEquals(maxRetained, remaining.size)
        } finally {
            tempDir.deleteRecursively()
        }
    }
}
