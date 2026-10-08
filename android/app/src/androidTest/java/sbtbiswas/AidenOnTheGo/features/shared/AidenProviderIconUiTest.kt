package sbtbiswas.AidenOnTheGo.features.shared

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenProviderArtwork
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenProviderIconUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val hiddenFromTalkBack = SemanticsMatcher.keyIsDefined(SemanticsProperties.HideFromAccessibility)

    private fun ImageBitmap.share(matches: (Color) -> Boolean): Float {
        val pixels = toPixelMap()
        var hits = 0
        for (x in 0 until width) for (y in 0 until height) if (matches(pixels[x, y])) hits++
        return hits.toFloat() / (width * height)
    }

    private fun Color.isRed() = alpha > 0.9f && red > 0.8f && green < 0.3f && blue < 0.3f
    private fun Color.isBlue() = alpha > 0.9f && blue > 0.8f && red < 0.3f && green < 0.3f
    private fun Color.isClose(other: Color) =
        abs(red - other.red) < 0.03f && abs(green - other.green) < 0.03f && abs(blue - other.blue) < 0.03f

    private fun solidBluePng(): AidenProviderArtwork {
        val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.BLUE) }
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        return AidenProviderArtwork("image/png", Base64.getEncoder().encodeToString(bytes))
    }

    @Test
    fun knownProviderDrawsItsLogoInTheTintInsteadOfAnInitial() {
        compose.setContent {
            AidenTheme {
                Box(Modifier.testTag("mark").background(Color.White)) {
                    AidenProviderIcon(providerId = "openai", providerLabel = "OpenAI", size = 48.dp, tint = Color.Red)
                }
            }
        }

        compose.onNodeWithText("O", useUnmergedTree = true).assertDoesNotExist()
        compose.onNode(hiddenFromTalkBack, useUnmergedTree = true).assertExists()
        val ink = compose.onNodeWithTag("mark").captureToImage().share { it.isRed() }
        assertTrue("OpenAI mark covered only $ink of its box", ink > 0.1f)
    }

    @Test
    fun unknownProviderShowsANeutralInitialHiddenFromTalkBack() {
        var neutralFill = Color.Unspecified
        compose.setContent {
            AidenTheme {
                neutralFill = MaterialTheme.colorScheme.surfaceContainerHigh
                Box(Modifier.testTag("mark")) {
                    AidenProviderIcon(providerId = "custom:my-server", providerLabel = "my server", size = 48.dp)
                }
            }
        }

        compose.onNode(hiddenFromTalkBack and hasAnyDescendant(hasText("M")), useUnmergedTree = true).assertExists()
        val image = compose.onNodeWithTag("mark").captureToImage()
        // Sample just inside the top edge, clear of the rounded corners and the letter.
        assertTrue(image.toPixelMap()[image.width / 2, 3].isClose(neutralFill))
    }

    @Test
    fun customArtworkTakesPrecedenceOverTheBundledLogo() {
        compose.setContent {
            AidenTheme {
                Box(Modifier.testTag("mark")) {
                    AidenProviderIcon(
                        providerId = "openai",
                        providerLabel = "OpenAI",
                        artwork = solidBluePng(),
                        size = 48.dp,
                        tint = Color.Red
                    )
                }
            }
        }

        val image = compose.onNodeWithTag("mark").captureToImage()
        assertTrue(image.share { it.isBlue() } > 0.8f)
        assertEquals(0f, image.share { it.isRed() })
    }

    @Test
    fun everyBundledLogoInflatesAndDrawsVisibleInk() {
        val slugs = AidenProviderIconResolver.supportedSlugs.sorted()
        compose.setContent {
            AidenTheme {
                Column {
                    slugs.chunked(7).forEach { row ->
                        Row {
                            row.forEach { slug ->
                                Box(Modifier.testTag(slug).background(Color.White)) {
                                    AidenProviderIcon(providerId = slug, providerLabel = slug, size = 40.dp, tint = Color.Red)
                                }
                            }
                        }
                    }
                }
            }
        }

        // No provider fell back to its initial.
        compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Text), useUnmergedTree = true)
            .assertCountEquals(0)
        slugs.forEach { slug ->
            val image = compose.onNodeWithTag(slug).captureToImage()
            val ink = if (slug in AidenProviderIconResolver.multicolorSlugs) {
                image.share { !it.isClose(Color.White) }
            } else {
                image.share { it.isRed() }
            }
            // Concentrate's dot field is the sparsest mark at roughly 3% coverage.
            assertTrue("$slug drew only $ink of its box", ink > 0.005f)
        }
    }
}
