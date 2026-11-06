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
import sbtbiswas.AidenOnTheGo.models.AidenOpenWorkState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenBotOpenWorkEditorUiTest {
    @get:Rule val compose=createComposeRule()
    @Test fun waitingRequiresAnExplicitReasonAndPreservesTheTitle() {
        var latest=AidenOpenWorkDraft("work-1","item-2","Review the brief")
        compose.setContent {
            var draft by remember{mutableStateOf(latest)}
            AidenTheme{Column(Modifier.verticalScroll(rememberScrollState())){AidenOpenWorkEditor(draft,true){change->draft=change(draft);latest=draft}}}
        }
        compose.onNodeWithText("Waiting").performScrollTo().performClick().assertIsSelected()
        compose.runOnIdle{assertFalse(latest.valid);assertEquals("Review the brief",latest.title)}
        compose.onNodeWithText("What is this waiting for?").performScrollTo().performTextInput("An updated brief")
        compose.runOnIdle{assertTrue(latest.valid);assertEquals(AidenOpenWorkState.WAITING,latest.state);assertEquals("An updated brief",latest.waitingReason)}
    }
    @Test fun textEntryRespectsScalarAndUtf8BudgetsWithoutSplittingCharacters() {
        var latest=AidenOpenWorkDraft(expectedRevision="snapshot-1")
        compose.setContent{var draft by remember{mutableStateOf(latest)};AidenTheme{Column(Modifier.verticalScroll(rememberScrollState())){AidenOpenWorkEditor(draft,true){change->draft=change(draft);latest=draft}}}}
        compose.onNodeWithText("Title").performTextInput("😀".repeat(161))
        compose.onNodeWithText("Note").performScrollTo().performTextInput("€".repeat(683))
        compose.runOnIdle{assertEquals("😀".repeat(160),latest.title);assertEquals("€".repeat(682),latest.note);assertTrue(latest.valid)}
    }
    @Test fun readOnlyEditorDisablesEveryMetadataChange() {
        var changes=0
        compose.setContent{AidenTheme{Column(Modifier.verticalScroll(rememberScrollState())){AidenOpenWorkEditor(AidenOpenWorkDraft("work-1","item-2","Task"),false){changes++}}}}
        compose.onNodeWithText("Title").assertIsNotEnabled()
        compose.onNodeWithText("Waiting").performScrollTo().assertIsNotEnabled()
        compose.runOnIdle{assertEquals(0,changes)}
    }
}
