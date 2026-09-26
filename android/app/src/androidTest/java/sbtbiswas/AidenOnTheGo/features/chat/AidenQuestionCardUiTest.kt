package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenPendingQuestion
import sbtbiswas.AidenOnTheGo.models.AidenQuestionAnswer
import sbtbiswas.AidenOnTheGo.models.AidenQuestionRespondRequest
import sbtbiswas.AidenOnTheGo.models.AidenRemoteQuestion
import sbtbiswas.AidenOnTheGo.models.AidenRemoteQuestionOption
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenQuestionCardUiTest {
    @get:Rule
    val compose = createComposeRule()

    private fun option(label: String) = AidenRemoteQuestionOption(label, "$label detail")

    private fun prompt(multiSelect: Boolean = false) = AidenPendingQuestion(
        id = "q-1",
        questions = listOf(
            AidenRemoteQuestion(
                question = "Which scope?",
                header = "Scope",
                multiSelect = multiSelect,
                options = listOf(option("Small"), option("Large"))
            )
        ),
        expiresAt = Instant.now().plusSeconds(300),
        canRespond = true
    )

    @Test
    fun questionCardSubmitsSingleChoiceAnswer() {
        var submitted: AidenQuestionRespondRequest? = null
        compose.setContent {
            AidenTheme {
                AidenQuestionCard(prompt = prompt(), enabled = true, onSubmit = { submitted = it })
            }
        }

        compose.onNodeWithText("Submit").assertIsNotEnabled()
        compose.onNodeWithText("Large").performClick()
        compose.onNodeWithText("Submit").assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(
                AidenQuestionRespondRequest(
                    cancelled = false,
                    answers = listOf(AidenQuestionAnswer.Option(0, "Large"))
                ),
                submitted
            )
        }
    }

    @Test
    fun questionCardSkipSendsCancelledRequest() {
        var submitted: AidenQuestionRespondRequest? = null
        compose.setContent {
            AidenTheme {
                AidenQuestionCard(prompt = prompt(), enabled = true, onSubmit = { submitted = it })
            }
        }

        compose.onNodeWithText("Skip").assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(AidenQuestionRespondRequest(cancelled = true, answers = emptyList()), submitted)
        }
    }

    @Test
    fun questionCardMultiSelectAccumulatesSelections() {
        val multi = prompt(multiSelect = true)
        var submitted: AidenQuestionRespondRequest? = null
        compose.setContent {
            AidenTheme {
                AidenQuestionCard(prompt = multi, enabled = true, onSubmit = { submitted = it })
            }
        }

        compose.onNodeWithText("Select all that apply").assertExists()
        compose.onNodeWithText("Small").assertIsOff().performClick()
        compose.onNodeWithText("Large").assertIsOff().performClick()
        compose.onNodeWithText("Submit").performClick()
        compose.runOnIdle {
            assertEquals(
                AidenQuestionRespondRequest(
                    cancelled = false,
                    answers = listOf(AidenQuestionAnswer.Multi(0, listOf("Small", "Large")))
                ),
                submitted
            )
        }
    }

    @Test
    fun questionCardSingleSelectReplacesSelection() {
        compose.setContent {
            AidenTheme {
                AidenQuestionCard(prompt = prompt(), enabled = true, onSubmit = {})
            }
        }

        compose.onNodeWithText("Small").assertIsOff().performClick()
        compose.onNodeWithText("Small").assertIsOn()
        compose.onNodeWithText("Large").performClick()
        compose.onNodeWithText("Large").assertIsOn()
        compose.onNodeWithText("Small").assertIsOff()
    }

    @Test
    fun questionCardReviewOnlyPromptHidesActions() {
        compose.setContent {
            AidenTheme {
                AidenQuestionCard(
                    prompt = prompt().copy(canRespond = false),
                    enabled = true,
                    onSubmit = {}
                )
            }
        }

        compose.onNodeWithText("This paired device cannot respond to prompts.").assertExists()
        compose.onNodeWithText("Submit").assertDoesNotExist()
        compose.onNodeWithText("Skip").assertDoesNotExist()
    }

    @Test
    fun questionCardDisabledKeepsControlsInert() {
        var submitted = false
        compose.setContent {
            AidenTheme {
                AidenQuestionCard(prompt = prompt(), enabled = false, onSubmit = { submitted = true })
            }
        }

        compose.onNodeWithText("Skip").assertIsNotEnabled()
        compose.onNodeWithText("Submit").assertIsNotEnabled()
        compose.runOnIdle { assertTrue(!submitted) }
    }
}
