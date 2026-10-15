package sbtbiswas.AidenOnTheGo.features.remote

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenProductAreaLayerUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun aHiddenAreaBeneathPassiveChromeIgnoresTaps() {
        var hiddenTaps = 0
        val hiddenActive = mutableStateOf(false)
        compose.setContent {
            AidenTheme {
                Box(Modifier.size(200.dp)) {
                    // The inactive area sits below the active one, as in the product shell.
                    Box(
                        Modifier
                            .fillMaxSize()
                            .inactiveAreaGuard(hiddenActive.value)
                            .clickable { hiddenTaps++ }
                            .testTag("hidden")
                    )
                    // Passive chrome (no pointer input) on top, like the Bots title row.
                    Text("Bots", Modifier.testTag("chrome"))
                }
            }
        }

        compose.onNodeWithTag("chrome").performClick()
        compose.onNodeWithTag("hidden").performClick()
        assertEquals(0, hiddenTaps)

        hiddenActive.value = true
        compose.waitForIdle()
        compose.onNodeWithTag("hidden").performClick()
        assertEquals(1, hiddenTaps)
    }
}
