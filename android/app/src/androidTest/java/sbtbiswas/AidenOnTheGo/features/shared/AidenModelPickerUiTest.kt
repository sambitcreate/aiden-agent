package sbtbiswas.AidenOnTheGo.features.shared

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenModelPickerUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val deepseekV3 = AidenModelPickerModel(id = "deepseek-v3", label = "DeepSeek V3")
    private val providers = listOf(
        AidenModelPickerProvider(
            id = "deepseek",
            label = "DeepSeek",
            models = listOf(
                deepseekV3,
                AidenModelPickerModel(id = "deepseek-r1", label = "DeepSeek R1", capabilities = listOf(AidenModelCapability.REASONING))
            )
        ),
        AidenModelPickerProvider(id = "opencode-go", label = "OpenCode Go", models = listOf(deepseekV3)),
        AidenModelPickerProvider(
            id = "anthropic",
            label = "Anthropic",
            models = listOf(
                AidenModelPickerModel(id = "claude-opus-4-1", label = "Claude Opus 4.1", capabilities = listOf(AidenModelCapability.VISION)),
                AidenModelPickerModel(id = "claude-sonnet-4-5", label = "Claude Sonnet 4.5")
            )
        )
    )

    private fun row(label: String) = hasText(label) and isSelectable()

    /** Hosts the picker with hoisted selection, recording every reported pick. */
    private fun setPicker(
        initial: AidenModelRoute?,
        picks: MutableList<AidenModelRoute>,
        defaultRoute: AidenModelRoute? = null,
        allowsDefault: Boolean = false
    ) {
        compose.setContent {
            var selection by remember { mutableStateOf(initial) }
            AidenTheme {
                Box(Modifier.height(720.dp)) {
                    AidenModelPicker(
                        providers = providers,
                        selection = selection,
                        onSelect = { entry ->
                            picks += entry.route
                            selection = entry.route
                        },
                        defaultRoute = defaultRoute,
                        allowsDefault = allowsDefault
                    )
                }
            }
        }
    }

    @Test
    fun searchFiltersRowsAndShowsAnEmptyStateWhenNothingMatches() {
        setPicker(initial = null, picks = mutableListOf())

        compose.onNodeWithTag(AidenModelPickerSearchTag).performTextInput("opus")
        compose.onNode(row("Claude Opus 4.1")).assertIsDisplayed()
        compose.onNode(row("Claude Sonnet 4.5")).assertDoesNotExist()
        compose.onAllNodes(row("DeepSeek V3")).assertCountEquals(0)

        compose.onNodeWithTag(AidenModelPickerSearchTag).performTextReplacement("zzz")
        compose.onNodeWithText("No models match “zzz”").assertIsDisplayed()
        compose.onAllNodes(isSelectable()).assertCountEquals(0)

        compose.onNodeWithContentDescription("Clear search").performClick()
        compose.onNode(row("Claude Sonnet 4.5")).assertIsDisplayed()
    }

    @Test
    fun selectingARowReportsItsProviderAndModelAndMovesTheCheck() {
        val picks = mutableListOf<AidenModelRoute>()
        setPicker(initial = AidenModelRoute("anthropic", "claude-opus-4-1"), picks = picks)

        compose.onNode(row("Claude Opus 4.1")).assertIsSelected()
        compose.onNode(row("Claude Sonnet 4.5")).assertIsNotSelected().performClick()

        compose.runOnIdle { assertEquals(listOf(AidenModelRoute("anthropic", "claude-sonnet-4-5")), picks) }
        compose.onNode(row("Claude Sonnet 4.5")).assertIsSelected()
        compose.onNode(row("Claude Opus 4.1")).assertIsNotSelected()
        compose.onAllNodes(isSelectable() and isSelected()).assertCountEquals(1)

        // Tapping the checked row again is not a new pick.
        compose.onNode(row("Claude Sonnet 4.5")).performClick()
        compose.runOnIdle { assertEquals(1, picks.size) }
    }

    @Test
    fun withoutAnExplicitPickTheDefaultRowIsCheckedAndNamesTheMacDefault() {
        setPicker(
            initial = null,
            picks = mutableListOf(),
            defaultRoute = AidenModelRoute("anthropic", "claude-sonnet-4-5"),
            allowsDefault = true
        )

        compose.onNode(row("Default")).assertIsSelected()
        compose.onNodeWithText("Uses Claude Sonnet 4.5 · Anthropic").assertIsDisplayed()
        compose.onAllNodes(isSelectable() and isSelected()).assertCountEquals(1)
        // The summary names the resolved model as the Mac's default.
        compose.onNodeWithTag(AidenModelPickerSummaryTag)
            .assert(hasText("Claude Sonnet 4.5") and hasText("Mac default"))
    }

    @Test
    fun aModelOfferedByTwoProvidersRendersTwiceAndEachRowPicksItsOwnRoute() {
        val picks = mutableListOf<AidenModelRoute>()
        setPicker(initial = AidenModelRoute("deepseek", "deepseek-v3"), picks = picks)

        val copies = compose.onAllNodes(row("DeepSeek V3"))
        copies.assertCountEquals(2)
        copies[0].assertIsSelected()
        copies[1].assertIsNotSelected().performClick()

        compose.runOnIdle { assertEquals(listOf(AidenModelRoute("opencode-go", "deepseek-v3")), picks) }
        compose.onAllNodes(row("DeepSeek V3"))[1].assertIsSelected()
        compose.onAllNodes(row("DeepSeek V3"))[0].assertIsNotSelected()
    }

    @Test
    fun collapsingAProviderHidesItsRowsUntilExpandedAgain() {
        setPicker(initial = null, picks = mutableListOf())
        val header = hasText("DeepSeek") and hasClickAction() and !isSelectable()

        compose.onNode(header).assertIsDisplayed().performClick()
        compose.onNode(row("DeepSeek R1")).assertDoesNotExist()
        compose.onNode(header).assert(hasStateDescription("Collapsed"))
        compose.onNode(row("Claude Opus 4.1")).assertIsDisplayed()

        compose.onNode(header).performClick()
        compose.onNode(row("DeepSeek R1")).assertIsDisplayed()
    }

    @Test
    fun theFieldOpensThePickerSheetAndShowsTheNewPickAfterClosing() {
        compose.setContent {
            var selection by remember { mutableStateOf(AidenModelRoute("deepseek", "deepseek-r1")) }
            AidenTheme {
                AidenModelPickerField(
                    title = "AI Model",
                    providers = providers,
                    selection = selection,
                    onSelect = { selection = it.route }
                )
            }
        }

        compose.onNodeWithText("DeepSeek R1").assertIsDisplayed().performClick()
        compose.onNodeWithText("AI Model").assertIsDisplayed()
        compose.onNode(row("Claude Opus 4.1")).performClick()

        compose.onNodeWithText("AI Model").assertDoesNotExist()
        compose.onNodeWithText("Claude Opus 4.1").assertIsDisplayed()
        compose.onNodeWithText("DeepSeek R1").assertDoesNotExist()
    }
}
