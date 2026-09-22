package sbtbiswas.AidenOnTheGo.features.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentKind
import sbtbiswas.AidenOnTheGo.models.AidenChatRole
import sbtbiswas.AidenOnTheGo.models.AidenMessageAttachment

class AidenImageCarouselTest {
    @Test
    fun cardDeckMatchesIosResistanceFlickAndNeighborContract() {
        assertTrue(AidenInlineCardDeckLayout.isVisible(0, 0, 5))
        assertTrue(AidenInlineCardDeckLayout.isVisible(1, 0, 5))
        assertFalse(AidenInlineCardDeckLayout.isVisible(2, 0, 5))
        assertEquals(22f, AidenInlineCardDeckLayout.resistedTranslation(0, 5, 100f), 0.001f)
        assertEquals(-100f, AidenInlineCardDeckLayout.resistedTranslation(1, 5, -100f), 0.001f)
        assertEquals(0.25f, AidenInlineCardDeckLayout.dragProgress(-80f, 320f), 0.001f)
        assertEquals(-70.4f, AidenInlineCardDeckLayout.selectedCardOffset(-80f), 0.001f)
        assertEquals(3, AidenInlineCardDeckLayout.preferredBackgroundIndex(2, 5, -40f))
        assertEquals(1, AidenInlineCardDeckLayout.preferredBackgroundIndex(2, 5, 40f))
        assertEquals(2, AidenInlineCardDeckLayout.resolvedSelection(1, 5, -20f, -120f))
        assertEquals(1, AidenInlineCardDeckLayout.resolvedSelection(1, 5, 20f, 30f))
        assertEquals(0, AidenInlineCardDeckLayout.resolvedSelection(0, 5, 120f, 160f))
    }

    @Test
    fun galleryKeepsOnlySelectedPageAndImmediateNeighborsActive() {
        assertTrue(AidenAttachmentGalleryWindow.contains(9, 10, 20))
        assertTrue(AidenAttachmentGalleryWindow.contains(10, 10, 20))
        assertTrue(AidenAttachmentGalleryWindow.contains(11, 10, 20))
        assertFalse(AidenAttachmentGalleryWindow.contains(8, 10, 20))
        assertFalse(AidenAttachmentGalleryWindow.contains(-1, 0, 20))
    }

    @Test
    fun imageAdmissionRejectsDuplicatesUnsupportedTypesAndOversize() {
        val valid = attachment("one", "image/png", AidenAttachmentKind.IMAGE, 1024)
        val duplicate = attachment("dupe", "image/jpeg", AidenAttachmentKind.IMAGE, 2048)
        val attachments = listOf(
            valid,
            duplicate,
            duplicate.copy(name = "copy.jpg"),
            attachment("gif", "image/gif", AidenAttachmentKind.IMAGE, 200),
            attachment("text", "text/plain", AidenAttachmentKind.TEXT, 200),
            attachment("large", "image/png", AidenAttachmentKind.IMAGE, 8 * 1_048_576 + 1)
        )
        assertEquals(listOf(valid), aidenEligibleImageAttachments(attachments))
    }

    @Test
    fun mediaEdgeAndThumbnailResolutionRemainPartOfIdentity() {
        assertEquals(AidenMessageMediaEdge.TRAILING, AidenMessageMediaEdge.forRole(AidenChatRole.USER))
        assertEquals(AidenMessageMediaEdge.LEADING, AidenMessageMediaEdge.forRole(AidenChatRole.ASSISTANT))
        val data = byteArrayOf(1, 2, 3, 4)
        assertNotEquals(
            aidenAttachmentThumbnailCacheKey(data, 960),
            aidenAttachmentThumbnailCacheKey(data, 2_560)
        )
    }

    private fun attachment(
        id: String,
        mime: String,
        kind: AidenAttachmentKind,
        size: Int
    ) = AidenMessageAttachment(id, "$id.bin", mime, kind, size)
}
