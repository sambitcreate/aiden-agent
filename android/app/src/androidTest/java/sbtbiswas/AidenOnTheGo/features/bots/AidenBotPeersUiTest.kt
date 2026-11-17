package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenBotWatchJournal
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenBotPeersUiTest {
    @get:Rule val compose=createComposeRule()
    private var writes=0
    private fun controller():AidenBotPeersController {
        val host=object:AidenBotPeersTransport {
            override suspend fun settings()=AidenPeerSettings("planner","r1","Review plans",emptyList(),1)
            override suspend fun catalog()=AidenPeerCatalog("planner","catalog",listOf(AidenPeerOption("researcher","Researcher",true)))
            override suspend fun exchanges()=AidenPeerExchangeList("planner","list",emptyList())
            override suspend fun detail(id:String):AidenPeerExchange=error("Not used")
            override suspend fun evidence(exchange:AidenPeerExchange,kind:AidenOpenWorkEvidenceKind):AidenPeerEvidence=error("Not used")
            override suspend fun stop(request:AidenPeerStopMutation):AidenPeerStopResult=error("Not used")
            override suspend fun mutate(request:AidenPeerMutation):AidenPeerMutationResult{writes++;return AidenPeerMutationResult(false,code=AidenPeerError.UNAVAILABLE,error="Not available")}
        }
        val journal=object:AidenBotWatchJournal{var raw:String?=null;override fun read()=raw;override fun write(record:String?){raw=record}}
        return AidenBotPeersController("planner",host,{true},{true},{true},journal,{journal}).also{runBlocking{it.load()}}
    }
    @Test fun approvalNamesBothBotsAndRequiresExplicitConfirmation(){
        val c=controller()
        compose.setContent{val ui by c.state.collectAsState();AidenTheme{Column(Modifier.verticalScroll(rememberScrollState())){AidenBotPeersContent(ui,c,"Planner",true,true,{runBlocking{it()}})}}}
        compose.onNodeWithText("Approve pair").performScrollTo().performClick();compose.runOnIdle{assertEquals(0,writes)}
        compose.onNodeWithText("Allow Planner and Researcher to message each other in both directions? Each keeps its own rules, grants, model and spending limits. This does not grant access to either Bot’s private chats, instructions or credentials.").assertExists()
        compose.onNodeWithText("Cancel").performClick();compose.runOnIdle{assertEquals(0,writes)}
    }
    @Test fun readOnlyCatalogKeepsApprovalAndDescriptionSaveDisabled(){
        val c=controller()
        compose.setContent{val ui by c.state.collectAsState();AidenTheme{Column(Modifier.verticalScroll(rememberScrollState())){AidenBotPeersContent(ui,c,"Planner",false,false,{runBlocking{it()}})}}}
        compose.onNodeWithText("Researcher").performScrollTo().assertExists()
        compose.onNodeWithText("Approve pair").performScrollTo().assertIsNotEnabled();compose.onNodeWithText("Save").performScrollTo().assertIsNotEnabled()
        compose.runOnIdle{assertEquals(0,writes)}
    }
}
