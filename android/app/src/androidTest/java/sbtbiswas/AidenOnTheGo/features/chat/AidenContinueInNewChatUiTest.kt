package sbtbiswas.AidenOnTheGo.features.chat

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceConfig
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceMode
import sbtbiswas.AidenOnTheGo.models.AidenNoWorkspace
import sbtbiswas.AidenOnTheGo.models.AidenWorkspace
import sbtbiswas.AidenOnTheGo.models.AidenWorkspacePermission
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.io.File

@RunWith(AndroidJUnit4::class)
class AidenContinueInNewChatUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val refusal = "This chat's workspace folder is missing on your Mac. It may have been moved, renamed or deleted, or its drive isn't connected. Put it back, then send again."

    private fun workspace(id: String, name: String, noWorkspace: Boolean = false) = AidenWorkspace(
        id = id, name = name, permission = AidenWorkspacePermission.ASK, hasFolder = true,
        noWorkspace = noWorkspace, revision = "revision_$id"
    )

    private val destinations = AidenNoWorkspace.grouped(
        listOf(
            workspace("workspace_site", "Marketing site"),
            workspace("workspace_api", "Billing API"),
            workspace("default", "default", noWorkspace = true)
        )
    )

    @Test
    fun theRefusalOffersContinueOnlyWhenTheHostDoes() {
        var offered by mutableStateOf(true)
        var opened = 0
        compose.setContent {
            AidenTheme {
                AidenChatErrorBanner(
                    message = refusal,
                    onContinueInNewChat = if (offered) ({ opened += 1 }) else null
                )
            }
        }
        compose.onNodeWithText(refusal).assertIsDisplayed()
        compose.onNodeWithText(AidenContinueInNewChat.ACTION_LABEL).assertIsDisplayed().performClick()
        assertEquals(1, opened)

        offered = false
        compose.waitForIdle()
        compose.onNodeWithText(refusal).assertIsDisplayed()
        compose.onNodeWithText(AidenContinueInNewChat.ACTION_LABEL).assertDoesNotExist()
    }

    @Test
    fun thePickerNamesEachWorkspaceAndPicksOneOnlyWhenNotAlreadyContinuing() {
        var continuing by mutableStateOf(true)
        val picked = mutableListOf<String>()
        compose.setContent {
            AidenTheme {
                AidenContinueInNewChatPickerContent(destinations, isContinuing = continuing) { picked += it.id }
            }
        }
        compose.onNodeWithText(AidenContinueInNewChat.PICKER_BODY).assertIsDisplayed()
        compose.onNodeWithText("Billing API").assertIsDisplayed()
        compose.onNodeWithText(AidenNoWorkspace.GROUP_NAME).assertIsDisplayed()
        compose.onNode(hasText("Marketing site") and hasClickAction()).performClick()
        assertTrue("a pick while a Continue is in flight is ignored", picked.isEmpty())

        continuing = false
        compose.waitForIdle()
        compose.onNode(hasText("Marketing site") and hasClickAction()).performClick()
        assertEquals(listOf("workspace_site"), picked)
    }

    @Test
    fun thePickerSaysSoWhenThereIsNowhereElseToContinue() {
        compose.setContent {
            AidenTheme { AidenContinueInNewChatPickerContent(emptyList(), isContinuing = false) {} }
        }
        compose.onNodeWithText(AidenContinueInNewChat.NO_DESTINATIONS).assertIsDisplayed()
    }

    /**
     * Light and dark captures of the refusal with Continue and of the picker sheet. Runs only with
     * the `aidenScreenshots=true` instrumentation argument; files land in the app's files/screens.
     */
    @Test
    fun captureScreens() {
        val arguments = InstrumentationRegistry.getArguments()
        assumeTrue(arguments.getString("aidenScreenshots") == "true")
        var mode by mutableStateOf(AidenAppearanceMode.LIGHT)
        var showsPicker by mutableStateOf(false)
        compose.setContent {
            AidenTheme(AidenAppearanceConfig(mode = mode)) {
                Column(
                    Modifier.fillMaxSize().background(AidenTheme.palette.canvas),
                    verticalArrangement = Arrangement.Bottom
                ) {
                    AidenChatErrorBanner(message = refusal, onContinueInNewChat = { showsPicker = true })
                    Spacer(Modifier.height(120.dp))
                }
                if (showsPicker) {
                    AidenContinueInNewChatPicker(destinations, isContinuing = false, onPick = {}, onDismiss = {})
                }
            }
        }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = File(instrumentation.targetContext.filesDir, "screens").apply { mkdirs() }
        fun shoot(name: String) {
            compose.waitForIdle()
            Thread.sleep(1_200)
            compose.waitForIdle()
            val bitmap = instrumentation.uiAutomation.takeScreenshot()
            File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        for ((label, appearance) in listOf("light" to AidenAppearanceMode.LIGHT, "dark" to AidenAppearanceMode.DARK)) {
            mode = appearance
            showsPicker = false
            shoot("android-continue-refusal-$label")
            compose.onNodeWithText(AidenContinueInNewChat.ACTION_LABEL).performClick()
            shoot("android-continue-picker-$label")
        }
    }
}
