package sbtbiswas.AidenOnTheGo.features.scheduled

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
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
}
