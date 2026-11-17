package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.AidenRemoteContractFixture
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceConfig
import sbtbiswas.AidenOnTheGo.models.AidenBotAccessMode
import sbtbiswas.AidenOnTheGo.models.AidenBotCapabilityCatalog
import sbtbiswas.AidenOnTheGo.models.AidenBotCapabilityOption
import sbtbiswas.AidenOnTheGo.models.AidenBotChatActivityWording
import sbtbiswas.AidenOnTheGo.models.AidenBotMessaging

/** Revision 61's client-only pieces: they change this phone's screens, never the wire. */
class AidenBotClientOnlyUxTest {
    private val catalog by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")).bufferedReader().use { it.readText() }
        Json { ignoreUnknownKeys = true }.decodeFromString<AidenRemoteContractFixture>(text).botCapabilityCatalog
    }

    @Test
    fun theStatusLineFollowsThisPhonesSwitchOnANewMacAndReadsThinkingUntilItIsOn() {
        // An older Mac: the Bot's own wording stands, whatever the switch says.
        assertEquals(AidenBotChatActivityWording.THINKING, aidenBotStatusWording(AidenBotChatActivityWording.THINKING, hostOffersBotUx = false, showToolActivity = true))
        assertEquals(AidenBotChatActivityWording.FOLLOWS, aidenBotStatusWording(null, hostOffersBotUx = false, showToolActivity = false))
        // A new Mac and a phone that never touched the switch: tool activity is hidden, even for a Bot that followed its tools.
        val untouched = AidenAppearanceConfig().showToolActivity
        assertEquals(AidenBotChatActivityWording.THINKING, aidenBotStatusWording(AidenBotChatActivityWording.FOLLOWS, hostOffersBotUx = true, showToolActivity = untouched))
        assertEquals(AidenBotChatActivityWording.THINKING, aidenBotStatusWording(null, hostOffersBotUx = true, showToolActivity = untouched))
        // Turned on, it follows the tools whatever the Bot says.
        assertEquals(AidenBotChatActivityWording.FOLLOWS, aidenBotStatusWording(AidenBotChatActivityWording.THINKING, hostOffersBotUx = true, showToolActivity = true))
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

    /** What Full access grants on the Mac (`bot-runtime-authority.ts`), with web search off there. */
    private fun fullGrant(catalog: AidenBotCapabilityCatalog, webSearchOn: Boolean = false) = object {
        val files = catalog.fileScopes.filter { it.available }.map { it.id }.toSet()
        val shell = catalog.shellAvailable
        val connections = catalog.connections.filter { it.available }.map { it.id }.toSet()
        val skills = if (catalog.skillsEnabled) catalog.skills.filter { it.available }.map { it.id }.toSet() else emptySet()
        val others = catalog.otherCapabilities.filter { it.available && (webSearchOn || it.label != "Web search") }.map { it.id }.toSet()
    }

    @Test
    fun disablingOneToolOnFullAccessOnlyNarrowsAndLeavesWebSearchOff() {
        // The host's own labels: web search is "Web search"; the browser is granted under Full whatever the switch.
        val withBrowser = catalog.copy(otherCapabilities = listOf(
            AidenBotCapabilityOption("capability.web", "Web search", true),
            AidenBotCapabilityOption("capability.browser", "Browser", true)
        ))
        val full = AidenBotAdvancedDraft(usesFullAccess = true, customAccess = AidenBotCustomAccessDraft.fromCatalog(withBrowser)!!.copy(fileScopeIDs = emptySet(), connectionIDs = emptySet()))
        val tools = aidenBotAvailableTools(withBrowser, "Run commands")
        val calendar = tools.first { it.second == "Calendar" }.first

        val next = full.disabling(calendar, withBrowser)
        assertFalse(next.usesFullAccess)
        val selection = next.customAccess.selection()
        assertEquals(listOf("scope.full_mac"), selection.fileScopeIds)
        assertTrue(selection.shellEnabled)
        assertTrue(selection.connectionIds.isEmpty())
        assertEquals(listOf("skill.research"), selection.skillIds)
        // Web search is not added: Full may not have granted it. The browser stays.
        assertEquals(listOf("capability.browser"), selection.otherCapabilityIds)
        // Every grant is one Full gives even with the Mac's web search off.
        val granted = fullGrant(withBrowser)
        assertTrue(granted.files.containsAll(selection.fileScopeIds))
        assertTrue(!selection.shellEnabled || granted.shell)
        assertTrue(granted.connections.containsAll(selection.connectionIds))
        assertTrue(granted.skills.containsAll(selection.skillIds))
        assertTrue(granted.others.containsAll(selection.otherCapabilityIds))
        // It saves as Custom through the existing capabilities route.
        assertEquals(AidenBotAccessMode.CUSTOM, next.accessUpdate(withBrowser).accessMode)

        // A second tool off keeps the first one off.
        val noShell = next.disabling(AidenBotTool.Shell, withBrowser).customAccess.selection()
        assertFalse(noShell.shellEnabled)
        assertTrue(noShell.connectionIds.isEmpty())
    }

    @Test
    fun theFixturesWebCapabilityIsLeftOffToo() {
        val full = AidenBotAdvancedDraft(usesFullAccess = true, customAccess = AidenBotCustomAccessDraft.fromCatalog(catalog)!!)
        val selection = full.disabling(AidenBotTool.Shell, catalog).customAccess.selection()
        assertTrue(selection.otherCapabilityIds.isEmpty())
        assertFalse(selection.shellEnabled)
    }

    @Test
    fun withoutAWholeMacScopeTheBotsFolderAndApprovedPlacesStay() {
        val noWholeMac = catalog.copy(fileScopes = catalog.fileScopes.filterNot { it.id == "scope.full_mac" })
        val full = AidenBotAdvancedDraft(usesFullAccess = true, customAccess = AidenBotCustomAccessDraft.fromCatalog(noWholeMac)!!)
        val files = full.disabling(AidenBotTool.Skill("skill.research"), noWholeMac).customAccess.selection().fileScopeIds
        assertEquals(listOf("scope.bot_home", "scope.documents"), files)
    }
}
