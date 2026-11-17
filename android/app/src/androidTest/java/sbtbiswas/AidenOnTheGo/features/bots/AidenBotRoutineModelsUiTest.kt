package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenBotWatchJournal
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenBotRoutineModelsUiTest {
    @get:Rule val compose=createComposeRule()
    private val choice=AidenRoutineModelChoice("provider","model",AidenRoutineThinkingLevel.HIGH)
    private fun controller():AidenBotRoutineModelsController {
        val transport=object:AidenBotRoutineModelsTransport {
            override suspend fun settings()=AidenRoutineModelSettings("bot","routine","r1",AidenRoutineModelSelection.Inherit,1)
            override suspend fun catalog()=AidenRoutineModelCatalog("catalog",listOf(AidenRoutineModelProvider("provider","Test provider",true,listOf(AidenRoutineModelOption("model","Test model",true,true,listOf(AidenRoutineThinkingLevel.HIGH))))))
            override suspend fun runs()=emptyList<AidenRoutineModelRun>()
            override suspend fun save(request:AidenRoutineModelSave)=error("No UI test network writes")
        }
        val journal=object:AidenBotWatchJournal{var raw:String?=null;override fun read()=raw;override fun write(record:String?){raw=record}}
        return AidenBotRoutineModelsController("bot","routine",transport,{true},{true},journal).also{runBlocking{it.load()}}
    }
    @Test fun modelPickerOffersOnlyHostSupportedThinkingAndFallbackIsExplicit() {
        val controller=controller()
        compose.setContent{val ui by controller.state.collectAsState();AidenTheme{AidenRoutineModelDetail("Morning review",ui,controller,true,true,{})}}
        compose.onNodeWithText("Choose primary model and thinking").performScrollTo().performClick()
        compose.onNodeWithText("Test model").assertExists();compose.onNodeWithText("max").assertDoesNotExist()
        compose.onNodeWithText("high").performClick()
        compose.runOnIdle{assertEquals(choice,controller.state.value.draft!!.primary);assertNull(controller.state.value.draft!!.fallback)}
        compose.onNodeWithText("Choose optional fallback and thinking").performScrollTo().assertIsEnabled()
    }
    @Test fun readOnlyDetailsDisableSelectionAndSave() {
        val controller=controller()
        compose.setContent{val ui by controller.state.collectAsState();AidenTheme{AidenRoutineModelDetail("Morning review",ui,controller,true,false,{})}}
        compose.onNodeWithText("Choose primary model and thinking").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Save").performScrollTo().assertIsNotEnabled()
    }
}
