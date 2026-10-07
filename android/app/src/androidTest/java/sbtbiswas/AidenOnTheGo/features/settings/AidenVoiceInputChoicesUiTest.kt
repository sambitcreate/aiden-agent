package sbtbiswas.AidenOnTheGo.features.settings

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputMode
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenVoiceInputChoicesUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val isRadio = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)

    @Test
    fun choiceCardsAreRadioButtonsThatMoveSelectionOncePerTap() {
        val picks = mutableListOf<AidenVoiceInputMode>()
        compose.setContent {
            var mode by remember { mutableStateOf(AidenVoiceInputMode.ON_DEVICE) }
            AidenTheme {
                AidenVoiceInputModeChoices(selected = mode, onSelect = { picks += it; mode = it })
            }
        }

        compose.onNodeWithText(AidenVoiceInputMode.ON_DEVICE.title).assert(isRadio).assertIsSelected()
        compose.onNodeWithText(AidenVoiceInputMode.PAIRED_MAC.title).assert(isRadio).assertIsNotSelected()

        compose.onNodeWithText(AidenVoiceInputMode.PAIRED_MAC.title).performClick()

        compose.onNodeWithText(AidenVoiceInputMode.PAIRED_MAC.title).assertIsSelected()
        compose.onNodeWithText(AidenVoiceInputMode.ON_DEVICE.title).assertIsNotSelected()
        compose.runOnIdle { assertEquals(listOf(AidenVoiceInputMode.PAIRED_MAC), picks) }
    }
}
