package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenBotWatchEditorUiTest {
    @get:Rule val compose = createComposeRule()
    private val mail = AidenBotWatchTemplate(AidenBotWatchTemplateId.MAIL, "Mail messages", "Read a selected mailbox", "email", true, intervals = listOf(15, 30, 60))
    private val calendar = AidenBotWatchTemplate(AidenBotWatchTemplateId.CALENDAR, "Calendar", "Upcoming events", "calendar", false, "Calendar account identity is not safe to bind yet.", listOf(15, 30, 60))
    private val source = AidenBotWatchSourceChoice("22222222-2222-4222-8222-222222222222", AidenBotWatchTemplateId.MAIL, "Mail", "Personal", "Inbox", true)

    @Test fun typedMailFilterAndIntervalChangesKeepThePersonsInstructions() {
        var finalDraft = AidenBotWatchDraft(name = "Project mail", prompt = "Summarize changes", sourceChoiceId = source.id)
        compose.setContent {
            var draft by remember { mutableStateOf(finalDraft) }
            AidenTheme {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    AidenBotWatchEditor(draft, AidenBotWatchList(true, templates = listOf(mail, calendar), watches = emptyList()),
                        null, true, false, onChange = { change -> draft = change(draft); finalDraft = draft }, onDiscover = {}, onChoose = {})
                }
            }
        }
        compose.onNodeWithText("Sender filter (optional)").performScrollTo().performTextInput("person@example.test")
        compose.onNodeWithText("15 minutes").performScrollTo().performClick()
        compose.onNodeWithText("15 minutes · Selected").assertIsSelected()
        compose.runOnIdle {
            assertEquals("person@example.test", (finalDraft.condition as AidenBotWatchCondition.Email).sender)
            assertEquals(15, finalDraft.everyMinutes)
            assertEquals("Summarize changes", finalDraft.prompt)
        }
    }
    @Test fun gatedCalendarExplainsWhyAndSourceChoiceHasSelectionSemantics() {
        compose.setContent {
            AidenTheme {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    AidenBotWatchEditor(AidenBotWatchDraft(sourceChoiceId = source.id),
                        AidenBotWatchList(true, templates = listOf(mail, calendar), watches = emptyList()),
                        AidenBotWatchSourceList(listOf(source), emptyList()), true, false, onChange = {}, onDiscover = {}, onChoose = {})
                }
            }
        }
        compose.onNodeWithText("Calendar: Calendar account identity is not safe to bind yet.").assertExists()
        compose.onNodeWithText("Mail · Personal").assertIsSelected()
        compose.onNodeWithContentDescription("Unread messages only").assertExists()
    }
    @Test fun readOnlyEditorDisablesDiscoveryAndSourceMutations() {
        var discoveries = 0; var choices = 0
        compose.setContent {
            AidenTheme {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    AidenBotWatchEditor(AidenBotWatchDraft(), AidenBotWatchList(true, templates = listOf(mail), watches = emptyList()),
                        AidenBotWatchSourceList(listOf(source), emptyList()), false, false, onChange = {},
                        onDiscover = { discoveries++ }, onChoose = { choices++ })
                }
            }
        }
        compose.onNodeWithText("Find connected sources").assertIsNotEnabled()
        compose.onNodeWithText("Mail · Personal").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(0, discoveries); assertEquals(0, choices) }
    }
}
