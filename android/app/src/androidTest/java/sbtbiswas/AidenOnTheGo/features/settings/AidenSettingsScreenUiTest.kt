package sbtbiswas.AidenOnTheGo.features.settings

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.config.AidenThemePresetID
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.models.AidenMemorySettings
import sbtbiswas.AidenOnTheGo.models.AidenReadAloudStatus
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsCache
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsProvider
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsSnapshot
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class AidenSettingsScreenUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val root = File(context.cacheDir, "settings-ui-${UUID.randomUUID()}")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private fun hasRole(role: Role) = SemanticsMatcher.expectValue(SemanticsProperties.Role, role)
    private val isLoading = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Loading")
    private val memoryRow get() = compose.onNode(hasText("Use memory") and hasRole(Role.Switch))

    @After
    fun tearDown() {
        scope.cancel()
        root.deleteRecursively()
    }

    private fun showSettings(store: AidenSettingsStore) {
        compose.setContent {
            AidenTheme {
                AidenSettingsScreen(
                    store = store,
                    voiceInputStore = AidenVoiceInputStore(context),
                    connectedDesktopName = "Studio",
                    onNavigate = {},
                    onOpenInstallations = {},
                    onNavigateBack = {}
                )
            }
        }
    }

    @Test
    fun memoryTogglesFromTheWholeRowAndRollsBackWhenTheDesktopRefuses() {
        val remote = FakeSettingsRemote().apply {
            memoryGate = CompletableDeferred()
            rejectMemoryUpdates = true
        }
        val store = AidenSettingsStore(AidenSettingsCache(root), scope).apply { bind("mac", remote) }
        showSettings(store)
        compose.waitUntil(5_000) { store.state.value.memory != null }
        memoryRow.assert(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.On))

        // Tap the label, not the switch: the whole row is the control.
        compose.onNodeWithText("Use memory").performClick()

        memoryRow.assert(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.Off))
        compose.runOnIdle { remote.memoryGate!!.complete(Unit) }
        compose.waitUntil(5_000) { !store.state.value.isSavingMemory }

        memoryRow.assert(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.On))
        compose.onNodeWithText("Couldn't change memory. Your previous setting is restored.").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(false), remote.memoryUpdates) }
    }

    @Test
    fun cachedSettingsRenderWithoutPlaceholdersWhileTheDesktopIsSlow() {
        AidenSettingsCache(root).store(
            AidenSettingsSnapshot(
                instanceId = "mac",
                providers = listOf(AidenSettingsProvider("openai", "OpenAI", 3), AidenSettingsProvider("local", "Local", 1)),
                memory = AidenMemorySettings(enabled = false, revision = "r1"),
                readAloud = AidenReadAloudStatus(enabled = true, ready = true, settingsRevision = "t1")
            )
        )
        val store = AidenSettingsStore(AidenSettingsCache(root), scope).apply {
            bind("mac", FakeSettingsRemote(hangReads = true))
        }
        showSettings(store)

        compose.onNodeWithText("2 connected", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Ready on your desktop", substring = true).assertIsDisplayed()
        memoryRow.assert(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.Off))
        compose.onAllNodes(isLoading, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun aFirstLoadWithNothingCachedShowsPlaceholdersInsteadOfAFakeMemoryState() {
        val store = AidenSettingsStore(AidenSettingsCache(root), scope).apply {
            bind("mac", FakeSettingsRemote(hangReads = true))
        }
        showSettings(store)

        compose.onNode(hasText("Use memory") and isLoading).assertExists()
        compose.onAllNodes(hasRole(Role.Switch)).assertCountEquals(0)
    }

    @Test
    fun themeTilesAreSingleRadioChoicesNamedByTheirTheme() {
        var selected by mutableStateOf(AidenThemePresetID.AIDEN)
        compose.setContent {
            AidenTheme {
                AidenThemeTileGrid(
                    selected = selected,
                    onSelect = { selected = it },
                    presets = listOf(AidenThemePresetID.AIDEN, AidenThemePresetID.BERRY, AidenThemePresetID.MOSS)
                )
            }
        }
        val berry = compose.onNode(hasContentDescription("Berry") and hasRole(Role.RadioButton))
        berry.assertIsNotSelected()
        compose.onNode(hasContentDescription("Aiden") and hasRole(Role.RadioButton)).assertIsSelected()

        berry.performClick()

        berry.assertIsSelected()
        compose.onNode(hasContentDescription("Aiden") and hasRole(Role.RadioButton)).assertIsNotSelected()
        // The preview's label is part of the tile's name, not a second stop for TalkBack.
        compose.onAllNodesWithText("Berry").assertCountEquals(0)
    }
}
