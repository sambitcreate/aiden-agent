package sbtbiswas.AidenOnTheGo.features.remote

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenPairingControlsUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val isTab = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)

    @Test
    fun enableCameraRequestsPermissionOncePerTap() {
        var launches = 0
        compose.setContent {
            AidenTheme { AidenCameraPermissionPrompt(onEnableCamera = { launches++ }) }
        }

        compose.onNodeWithText("Enable camera").performClick()

        compose.runOnIdle { assertEquals(1, launches) }
    }

    @Test
    fun aBlockedCameraOffersSystemSettingsOncePerTap() {
        var opens = 0
        compose.setContent {
            AidenTheme { AidenCameraPermissionPrompt(onEnableCamera = { opens++ }, blocked = true) }
        }

        compose.onNodeWithText("Enable camera").assertDoesNotExist()
        compose.onNodeWithText("Open settings").performClick()

        compose.runOnIdle { assertEquals(1, opens) }
    }

    @Test
    fun aBusyPairingActionSaysSoAndIgnoresTaps() {
        var attempts = 0
        compose.setContent {
            AidenTheme {
                AidenPairingActionButton(text = "Connect & pair", busy = true, enabled = true, onClick = { attempts++ })
            }
        }

        compose.onNodeWithText("Connect & pair").assertDoesNotExist()
        compose.onNodeWithText("Pairing…").assertIsNotEnabled().performClick()

        compose.runOnIdle { assertEquals(0, attempts) }
    }

    @Test
    fun pairingActionFiresOncePerTap() {
        var attempts = 0
        compose.setContent {
            AidenTheme {
                AidenPairingActionButton(text = "Connect & Pair", busy = false, enabled = true, onClick = { attempts++ })
            }
        }

        compose.onNodeWithText("Connect & Pair").performClick()

        compose.runOnIdle { assertEquals(1, attempts) }
    }

    @Test
    fun disabledPairingActionIgnoresTaps() {
        var attempts = 0
        compose.setContent {
            AidenTheme {
                AidenPairingActionButton(text = "Import & Pair", busy = false, enabled = false, onClick = { attempts++ })
            }
        }

        compose.onNodeWithText("Import & Pair").assertIsNotEnabled().performClick()

        compose.runOnIdle { assertEquals(0, attempts) }
    }

    @Test
    fun modeTabsExposeTabSemanticsAndMoveSelection() {
        val selections = mutableListOf<Int>()
        compose.setContent {
            var selected by remember { mutableIntStateOf(0) }
            AidenTheme {
                AidenPairingModeTabs(selectedTab = selected, onSelectTab = { selections += it; selected = it })
            }
        }

        compose.onNodeWithText("Scan QR").assert(isTab).assertIsSelected()
        compose.onNodeWithText("Setup code").assert(isTab).assertIsNotSelected()

        compose.onNodeWithText("Setup code").performClick()

        compose.onNodeWithText("Setup code").assertIsSelected()
        compose.onNodeWithText("Scan QR").assertIsNotSelected()
        compose.runOnIdle { assertEquals(listOf(1), selections) }
    }

    @Test
    fun noTabIsSelectedWhileTheAdvancedPasteFlowIsOpen() {
        compose.setContent {
            AidenTheme { AidenPairingModeTabs(selectedTab = 2, onSelectTab = {}) }
        }

        compose.onNodeWithText("Scan QR").assertIsNotSelected()
        compose.onNodeWithText("Setup code").assertIsNotSelected()
    }
}
