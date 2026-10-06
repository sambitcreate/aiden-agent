package sbtbiswas.AidenOnTheGo.features.scheduled

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenScheduledTaskFilter
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenScheduledTasksUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun searchFieldHasAnAccessibleSearchName() {
        compose.setContent {
            AidenTheme {
                AidenScheduleSearchField(value = "", onValueChanged = {})
            }
        }

        compose.onNodeWithContentDescription("Search scheduled tasks")
            .assertIsDisplayed()
            .assert(hasSetTextAction())
    }

    @Test
    fun statusFilterIsARadioGroupThatSelectsOncePerTap() {
        val picks = mutableListOf<AidenScheduledTaskFilter>()
        compose.setContent {
            var filter by remember { mutableStateOf(AidenScheduledTaskFilter.ALL) }
            AidenTheme {
                AidenScheduledTaskFilterRow(filter = filter, onFilterChanged = { picks += it; filter = it })
            }
        }
        val isRadio = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)

        compose.onNodeWithContentDescription("All scheduled tasks").assert(isRadio).assertIsSelected()
        compose.onNodeWithContentDescription("Paused scheduled tasks").assert(isRadio).assertIsNotSelected()

        compose.onNodeWithContentDescription("Paused scheduled tasks").performClick()

        compose.onNodeWithContentDescription("Paused scheduled tasks").assertIsSelected()
        compose.onNodeWithContentDescription("All scheduled tasks").assertIsNotSelected()
        compose.runOnIdle { assertEquals(listOf(AidenScheduledTaskFilter.PAUSED), picks) }
    }
}
