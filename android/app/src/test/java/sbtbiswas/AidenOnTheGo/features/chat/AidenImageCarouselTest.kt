package sbtbiswas.AidenOnTheGo.features.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
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
    fun deckCountPillShowsOneBasedPositionOnlyForMultiImageDecks() {
        assertNull(AidenImageCountBadge.label(0, 0))
        assertNull(AidenImageCountBadge.label(0, 1))
        assertEquals("1 / 4", AidenImageCountBadge.label(0, 4))
        assertEquals("4 / 4", AidenImageCountBadge.label(3, 4))
        // A stale selection after attachments shrink never reads past the end.
        assertEquals("2 / 2", AidenImageCountBadge.label(5, 2))
        assertEquals("1 / 2", AidenImageCountBadge.label(-1, 2))
    }

    @Test
    fun galleryPageIndicatorStretchesExactlyOneDotWithoutChangingRowWidth() {
        val pages = 5
        val totals = (0 until pages).map { selected ->
            val widths = (0 until pages).map { AidenImageCountBadge.dotWidth(it, selected) }
            assertEquals(1, widths.count { it > AidenImageCountBadge.DotSize })
            assertEquals(AidenImageCountBadge.ActiveDotWidth, widths[selected])
            widths.fold(0.dp) { sum, width -> sum + width }
        }
        assertEquals(1, totals.toSet().size)
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

    @Test
    fun visualSnapshotFrameTakesTheDecodedImagesOwnShape() {
        // A 720×1200 CSS visual captured at 2x: the frame is as tall as the image, never a 4:3 box.
        val tall = AidenVisualSnapshotFrame.aspectRatio(imageWidth = 1_440, imageHeight = 2_400, wide = false)
        assertEquals(0.6f, tall, 0.0001f)
        // Full width on a 360dp phone column gives a 600dp-tall row, so the image fills it with no letterbox.
        assertEquals(600f, 360f / tall, 0.01f)
        // A wide layout follows the image too, once it is known.
        assertEquals(2f, AidenVisualSnapshotFrame.aspectRatio(2_000, 1_000, wide = true), 0.0001f)
        assertEquals(2f, AidenVisualSnapshotFrame.aspectRatio(2_000, 1_000, wide = false), 0.0001f)
    }

    @Test
    fun visualSnapshotFrameHoldsAPlaceholderShapeUntilTheImageDecodes() {
        assertEquals(4f / 3f, AidenVisualSnapshotFrame.aspectRatio(null, null, wide = false), 0.0001f)
        assertEquals(16f / 9f, AidenVisualSnapshotFrame.aspectRatio(null, null, wide = true), 0.0001f)
        // Unusable dimensions are treated as undecoded.
        assertEquals(4f / 3f, AidenVisualSnapshotFrame.aspectRatio(0, 800, wide = false), 0.0001f)
        assertEquals(16f / 9f, AidenVisualSnapshotFrame.aspectRatio(800, -1, wide = true), 0.0001f)
    }

    private fun attachment(
        id: String,
        mime: String,
        kind: AidenAttachmentKind,
        size: Int
    ) = AidenMessageAttachment(id, "$id.bin", mime, kind, size)
}
