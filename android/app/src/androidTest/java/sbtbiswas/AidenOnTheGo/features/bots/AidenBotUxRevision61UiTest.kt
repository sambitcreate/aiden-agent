package sbtbiswas.AidenOnTheGo.features.bots

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.features.chat.AidenApprovalAnsweredRow
import sbtbiswas.AidenOnTheGo.features.chat.AidenTypedApprovalCardContent
import sbtbiswas.AidenOnTheGo.features.settings.AidenApprovalRulesScreen
import sbtbiswas.AidenOnTheGo.features.settings.AidenApprovalSettingsController
import sbtbiswas.AidenOnTheGo.features.settings.AidenApprovalSettingsRemote
import sbtbiswas.AidenOnTheGo.features.settings.AidenApprovalSettingsScreen
import sbtbiswas.AidenOnTheGo.features.settings.AidenAppearanceSettingsScreen
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/**
 * Revision 61 screens rendered from the shared fixtures. With the instrumentation argument
 * `aidenScreenshots=1` each state is also saved as a full-screen PNG under the app's external
 * files (`phase6c/`), named for the system's light or dark mode, for review.
 */
@RunWith(AndroidJUnit4::class)
class AidenBotUxRevision61UiTest {
    @get:Rule
    val compose = createComposeRule()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val wire = AidenBotWireJson.json
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    @After fun tearDown() = scope.cancel()

    private fun asset(name: String): JsonObject =
        wire.parseToJsonElement(instrumentation.context.assets.open(name).bufferedReader().use { it.readText() }).jsonObject

    private val fixture by lazy { asset("bot-ux-revision-61.json") }
    private val contract by lazy { asset("contract.json") }
    private fun card(name: String) = AidenApprovalCard.parse(fixture.getValue("approvalCards").jsonObject.getValue(name))

    private fun capture(name: String) {
        if (InstrumentationRegistry.getArguments().getString("aidenScreenshots") != "1") return
        compose.waitForIdle()
        // Let the frame reach the display before the screen is read.
        Thread.sleep(800)
        val night = (instrumentation.targetContext.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val dir = File(instrumentation.targetContext.getExternalFilesDir(null), "phase6c").apply { mkdirs() }
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: return
        File(dir, "$name-${if (night) "dark" else "light"}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun page(content: @Composable () -> Unit) {
        compose.setContent {
            AidenTheme {
                Surface(color = AidenTheme.palette.canvas, modifier = Modifier.fillMaxSize()) {
                    Column(
                        Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp)
                    ) { content() }
                }
            }
        }
    }

    @Test
    fun aTypedCardPutsDenyFirstAndAHostOnlyCardOffersOnlyDeny() {
        val taps = mutableListOf<AidenApprovalCardButton>()
        page {
            AidenTypedApprovalCardContent(card("macCommand"), resetKey = "a", enabled = true, canRespond = true, onRespond = { taps += it })
            AidenTypedApprovalCardContent(card("allowOnMac"), resetKey = "b", enabled = true, canRespond = true, onRespond = { taps += it })
            AidenApprovalAnsweredRow(title = "Run on your Mac?", answered = "Allowed once")
        }
        compose.onNodeWithText("Allow it on your Mac.").assertExists()
        capture("approval-card")
        compose.onNodeWithText("Allow once").performClick()
        compose.runOnIdle { assertEquals(listOf("Allowed once"), taps.map { it.answered }) }
        // The Computer Use card has one button, Deny.
        assertEquals(2, compose.onAllNodesWithText("Deny").fetchSemanticsNodes().size)
    }

    private fun entries(): List<AidenBotSessionEntry> {
        val raw = JsonObject(contract.getValue("botSession").jsonObject + ("entries" to JsonArray(fixture.getValue("botSessionEntries").jsonArray)))
        return wire.decodeFromJsonElement(AidenBotSession.serializer(), raw).entries
    }

    @Test
    fun settingsSuggestionAndLearningEntriesOfferTheirAnswers() {
        val settings = mutableListOf<AidenBotSettingsChangeDecision>()
        val skills = mutableListOf<AidenBotSkillProposalDecision>()
        val actions = AidenBotUxEntryActions({ settings += it }, { skills += it }, {}, {}, {})
        val all = entries()
        page {
            all.forEach { entry ->
                AidenBotUxEntryRow(entry, botName = "Chief", canAnswer = true, sending = false, error = null, tidyUndone = false, actions = actions)
            }
        }
        capture("bot-entries")
        compose.onNodeWithText("Apply").performClick()
        compose.runOnIdle { assertEquals(listOf(AidenBotSettingsChangeDecision.APPLY), settings) }
        // The skill too long to review here says so; only the reviewable one offers Add.
        compose.onNodeWithText("Add it on your Mac", substring = true).performScrollTo().assertExists()
        capture("bot-entries-more")
    }

    private class FixtureApprovals(private val fixture: JsonObject) : AidenApprovalSettingsRemote {
        var mode = AidenApprovalModeView.parse(fixture.getValue("approvalMode"))
        override suspend fun mode() = mode
        override suspend fun setMode(mode: AidenApprovalMode) = this.mode.copy(mode = mode).also { this.mode = it }
        override suspend fun rules() = AidenApprovalRulesView.parse(fixture.getValue("approvalRules"))
        override suspend fun picker() = AidenApprovalRulePickerOption.parseList(fixture.getValue("approvalRulePicker"))
        override suspend fun add(target: JsonObject, decision: AidenApprovalRuleDecision) = rules()
        override suspend fun change(ref: JsonObject, decision: AidenApprovalRuleDecision) = rules()
        override suspend fun remove(ref: JsonObject) = rules()
    }

    @Test
    fun theApprovalsPageDisablesAutoWithoutAModel() {
        val remote = FixtureApprovals(fixture).apply { mode = mode.copy(autoAvailable = false) }
        val controller = AidenApprovalSettingsController(scope).apply { bind(remote) }
        compose.setContent { AidenTheme { AidenApprovalSettingsScreen(controller, available = true, onOpenRules = {}, onNavigateBack = {}) } }
        compose.waitUntil(5_000) { controller.state.value.mode != null }
        compose.onNodeWithText("Auto needs an approval model. Choose one on your Mac.").assertExists()
        compose.onNodeWithText("Auto").assertIsNotEnabled()
        capture("approvals-mode")
    }

    @Test
    fun theRulesPageGroupsRowsAndAddsFromThePicker() {
        val controller = AidenApprovalSettingsController(scope).apply { bind(FixtureApprovals(fixture)) }
        compose.setContent { AidenTheme { AidenApprovalRulesScreen(controller, available = true, onNavigateBack = {}) } }
        compose.waitUntil(5_000) { controller.state.value.rules != null }
        compose.onNodeWithText("Tool · Only in Docs").assertExists()
        capture("approvals-rules")
        compose.onNodeWithContentDescription("Add rule").performClick()
        compose.waitUntil(5_000) { controller.state.value.picker != null }
        capture("approvals-add-rule")
        compose.onNodeWithText("Calendar").performClick()
        compose.onNodeWithText("When Calendar comes up").assertExists()
        capture("approvals-add-rule-decision")
    }

    @Test
    fun takeControlComesFirstThenImDone() {
        val done = mutableListOf<String>()
        val handoff = AidenBotHandoff("0a1b2c3d-0000-4000-8000-000000000061", AidenBotHandoffKind.ACTION, "Enter the code your bank sent you")
        page {
            AidenBotHandoffCard(handoff, canAnswer = true, isFinishing = false, macOpened = null,
                onDone = { done += "done" }, onSkip = { done += "skip" }, onFinishOnMac = {}, twoStep = true)
        }
        compose.onNodeWithText("I’m done").assertDoesNotExist()
        capture("handoff-take-control")
        compose.onNodeWithText("Take control").performClick()
        compose.onNodeWithText("I’m done").performClick()
        compose.runOnIdle { assertEquals(listOf("done"), done) }
        capture("handoff-im-done")
    }

    @Test
    fun aTemplateShowsItsVersionAndOpensTheBotItMade() {
        val preset = wire.decodeFromJsonElement(AidenBotPreset.serializer(), fixture.getValue("templates").jsonObject.getValue("presets").jsonArray.first())
        val started = mutableListOf<String>()
        compose.setContent {
            AidenTheme {
                Surface(color = AidenTheme.palette.canvas, modifier = Modifier.fillMaxSize()) {
                    AidenMeetYourFirstBot(listOf(preset), startingPresetId = null, notice = "This template changed. Close it and open it again.",
                        onStartChat = { started += it.id }, onCreateMyOwn = {}, modifier = Modifier.safeDrawingPadding())
                }
            }
        }
        compose.onNodeWithText("Version 2").assertExists()
        capture("templates")
        compose.onNodeWithText("Open").performClick()
        compose.runOnIdle { assertEquals(listOf("meal-planner"), started) }
    }

    @Test
    fun showToolActivityIsAPerDeviceSwitchInAppearance() {
        val store = AidenAppearanceStore(File(instrumentation.targetContext.cacheDir, "phase6c-appearance").apply { deleteRecursively() })
        // As in the app, the theme reads this phone's stored appearance.
        compose.setContent {
            val config by store.config.collectAsState()
            AidenTheme(config) { AidenAppearanceSettingsScreen(store, onNavigateBack = {}, showsToolActivity = true) }
        }
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("Show tool activity"))
        // Off until the person turns it on.
        compose.onNodeWithText("Show tool activity").assertIsOff()
        capture("appearance-tool-activity")
        compose.onNodeWithText("Show tool activity").performClick()
        compose.runOnIdle { assertEquals(true, store.config.value.showToolActivity) }
        compose.onNodeWithText("Show tool activity").assertIsOn()
    }
}
