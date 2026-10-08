package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AidenAdaptiveUiTest {
    @get:Rule
    val compose = createComposeRule()

    /**
     * Lays a screen root out in a window of [width], independent of the test device:
     * the host ignores the real window's constraints so a phone emulator can stand
     * in for a tablet.
     */
    private fun layOut(width: Dp): Pair<DpRect, DpRect> {
        compose.setContent {
            Box(Modifier.wrapContentSize(align = Alignment.TopStart, unbounded = true)) {
                Box(Modifier.requiredSize(width, 480.dp).testTag("window")) {
                    Box(Modifier.fillMaxSize().aidenReadableWidth().testTag("content"))
                }
            }
        }
        val window = compose.onNodeWithTag("window").getUnclippedBoundsInRoot()
        val content = compose.onNodeWithTag("content").getUnclippedBoundsInRoot()
        return window to content
    }

    private fun assertDpEquals(expected: Dp, actual: Dp) = assertEquals(expected.value, actual.value, 0.5f)

    @Test
    fun readableWidthCapsAndCentersContentOnAWideWindow() {
        val (window, content) = layOut(1280.dp)

        assertDpEquals(AidenReadableMaxWidth, content.width)
        assertDpEquals((1280.dp - AidenReadableMaxWidth) / 2, content.left - window.left)
        assertDpEquals(window.right - content.right, content.left - window.left)
        assertDpEquals(window.top, content.top)
        assertDpEquals(window.bottom, content.bottom)
    }

    @Test
    fun readableWidthLeavesAPhoneWindowEdgeToEdge() {
        val (window, content) = layOut(360.dp)
        assertDpEquals(window.left, content.left)
        assertDpEquals(window.right, content.right)
    }

    @Test
    fun readableWidthLeavesAMediumWindowEdgeToEdge() {
        val (window, content) = layOut(700.dp)
        assertDpEquals(window.left, content.left)
        assertDpEquals(window.right, content.right)
    }
}
