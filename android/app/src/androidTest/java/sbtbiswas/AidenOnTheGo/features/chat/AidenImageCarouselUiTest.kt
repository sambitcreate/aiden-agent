package sbtbiswas.AidenOnTheGo.features.chat

import android.graphics.Bitmap
import android.graphics.Color
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentKind
import sbtbiswas.AidenOnTheGo.models.AidenMessageAttachment
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream

@RunWith(AndroidJUnit4::class)
class AidenImageCarouselUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun cardDeckSwipesOneImageAndOpensTheSelectedGalleryPage() {
        val colors = listOf(Color.rgb(104, 91, 220), Color.rgb(220, 74, 137), Color.rgb(31, 178, 145))
        val images = colors.mapIndexed { index, color -> png(index, color) }
        val attachments = images.mapIndexed { index, bytes ->
            AidenMessageAttachment(
                id = "image-$index",
                name = "Showcase ${index + 1}.png",
                mimeType = "image/png",
                kind = AidenAttachmentKind.IMAGE,
                size = bytes.size
            )
        }
        val byId = attachments.mapIndexed { index, attachment -> attachment.id to images[index] }.toMap()

        compose.setContent {
            AidenTheme {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(AidenTheme.palette.canvas)
                        .padding(24.dp)
                        .testTag("image_test_root")
                ) {
                    AidenMessageImageAttachments(
                        attachments = attachments,
                        edge = AidenMessageMediaEdge.TRAILING,
                        loadData = { byId[it.id] }
                    )
                }
            }
        }

        val deck = compose.onNodeWithTag("aiden_image_deck")
        deck.assertExists()
        deck.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Photo 1 of 3"))
        saveCapture("aiden-image-deck.png", "image_test_root")

        deck.performTouchInput { swipeLeft(durationMillis = 260) }
        compose.waitForIdle()
        deck.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Photo 2 of 3"))
        deck.performClick()

        compose.onNodeWithTag("aiden_image_gallery").assertExists()
        compose.onNodeWithText("2 of 3").assertExists()
        compose.onNodeWithContentDescription("Close image viewer").assertExists()
        saveCapture("aiden-image-gallery.png", "aiden_image_gallery")
    }

    private fun png(index: Int, color: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(800 + index * 80, 600 + index * 120, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(color)
        return ByteArrayOutputStream().use { output ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
            bitmap.recycle()
            output.toByteArray()
        }
    }

    private fun saveCapture(name: String, tag: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = context.getExternalFilesDir(null) ?: context.filesDir
        val file = File(directory, name)
        FileOutputStream(file).use { stream ->
            compose.onNodeWithTag(tag, useUnmergedTree = true)
                .captureToImage()
                .asAndroidBitmap()
                .compress(Bitmap.CompressFormat.PNG, 100, stream)
        }
        assertTrue(file.exists() && file.length() > 0)
    }
}
