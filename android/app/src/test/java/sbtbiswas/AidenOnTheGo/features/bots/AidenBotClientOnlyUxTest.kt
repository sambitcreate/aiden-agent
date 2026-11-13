package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.AidenRemoteContractFixture
import sbtbiswas.AidenOnTheGo.models.AidenBotAccessMode
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivityWording
import sbtbiswas.AidenOnTheGo.models.AidenBotMessaging

/** Revision 61's client-only pieces: they change this phone's screens, never the wire. */
class AidenBotClientOnlyUxTest {
    private val catalog by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")).bufferedReader().use { it.readText() }
        Json { ignoreUnknownKeys = true }.decodeFromString<AidenRemoteContractFixture>(text).botCapabilityCatalog
    }

    @Test
    fun theStatusLineFollowsThisPhonesSwitchOnlyOnANewMacAndOnlyOnceSet() {
        // An older Mac, or a switch never touched: the Bot's own wording stands.
        assertEquals(AidenBotChatActivityWording.THINKING, aidenBotStatusWording(AidenBotChatActivityWording.THINKING, hostOffersBotUx = false, showToolActivity = true))
        assertEquals(AidenBotChatActivityWording.THINKING, aidenBotStatusWording(AidenBotChatActivityWording.THINKING, hostOffersBotUx = true, showToolActivity = null))
        assertEquals(AidenBotChatActivityWording.FOLLOWS, aidenBotStatusWording(null, hostOffersBotUx = true, showToolActivity = null))
        // Set on a new Mac: on follows the tools, off reads Thinking, whatever the Bot says.
        assertEquals(AidenBotChatActivityWording.FOLLOWS, aidenBotStatusWording(AidenBotChatActivityWording.THINKING, hostOffersBotUx = true, showToolActivity = true))
        assertEquals(AidenBotChatActivityWording.THINKING, aidenBotStatusWording(AidenBotChatActivityWording.FOLLOWS, hostOffersBotUx = true, showToolActivity = false))
    }

    @Test
    fun theSingleMessagingSwitchIsOnOnlyWhenBothDirectionsAreAndWritesBoth() {
        assertTrue(aidenBotMessagingSingleSwitch(AidenBotMessaging(receive = true, send = true)))
        assertFalse(aidenBotMessagingSingleSwitch(AidenBotMessaging(receive = true, send = false)))
        assertFalse(aidenBotMessagingSingleSwitch(AidenBotMessaging(receive = false, send = true)))
        val half = AidenBotMessaging(receive = false, send = true)
        assertEquals(AidenBotMessaging(receive = true, send = true), aidenBotMessagingSingleSwitchPatch(true).applying(half))
        assertEquals(AidenBotMessaging(receive = false, send = false), aidenBotMessagingSingleSwitchPatch(false).applying(half))
    }

    @Test
    fun disablingOneToolOnFullAccessKeepsEverythingElseAndTheWidestFiles() {
        val full = AidenBotAdvancedDraft(usesFullAccess = true, customAccess = AidenBotCustomAccessDraft.fromCatalog(catalog)!!.copy(fileScopeIDs = emptySet(), connectionIDs = emptySet()))
        val tools = aidenBotAvailableTools(catalog, "Run commands")
        val calendar = tools.first { it.second == "Calendar" }.first

        val next = full.disabling(calendar, catalog)
        assertFalse(next.usesFullAccess)
        val selection = next.customAccess.selection()
        assertEquals(listOf("scope.full_mac"), selection.fileScopeIds)
        assertTrue(selection.shellEnabled)
        assertTrue(selection.connectionIds.isEmpty())
        assertEquals(listOf("skill.research"), selection.skillIds)
        assertEquals(listOf("capability.web"), selection.otherCapabilityIds)
        // It saves as Custom through the existing capabilities route.
        assertEquals(AidenBotAccessMode.CUSTOM, next.accessUpdate(catalog).accessMode)

        // A second tool off keeps the first one off.
        val noShell = next.disabling(AidenBotTool.Shell, catalog).customAccess.selection()
        assertFalse(noShell.shellEnabled)
        assertTrue(noShell.connectionIds.isEmpty())
    }

    @Test
    fun withoutAWholeMacScopeTheBotsFolderAndApprovedPlacesStay() {
        val noWholeMac = catalog.copy(fileScopes = catalog.fileScopes.filterNot { it.id == "scope.full_mac" })
        val full = AidenBotAdvancedDraft(usesFullAccess = true, customAccess = AidenBotCustomAccessDraft.fromCatalog(noWholeMac)!!)
        val files = full.disabling(AidenBotTool.Other("capability.web"), noWholeMac).customAccess.selection().fileScopeIds
        assertEquals(listOf("scope.bot_home", "scope.documents"), files)
    }
}
