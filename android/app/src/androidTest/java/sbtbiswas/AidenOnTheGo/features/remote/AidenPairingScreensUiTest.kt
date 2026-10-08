package sbtbiswas.AidenOnTheGo.features.remote

import android.content.Context
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.features.settings.InMemorySecureStore
import sbtbiswas.AidenOnTheGo.models.AidenInstallation
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.io.File
import java.time.Instant
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class AidenPairingScreensUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val root = File(context.cacheDir, "pairing-ui-${UUID.randomUUID()}")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    @After
    fun tearDown() {
        scope.cancel()
        root.deleteRecursively()
    }

    private fun coordinator() = AidenRemoteCoordinator(
        installationStore = AidenInstallationStore(root, InMemorySecureStore()),
        storageDir = root,
        scope = scope
    )

    @Test
    fun firstRunPairingHasNoCloseOrBackAction() {
        val coordinator = coordinator()
        compose.setContent {
            AidenTheme {
                AidenPairDesktopScreen(coordinator = coordinator, firstRun = true, onPaired = {}, onNavigateBack = null)
            }
        }

        compose.onAllNodesWithText("Connect your desktop").onFirst().assertExists()
        compose.onAllNodesWithText("Open Aiden Agent.").onFirst().assertExists()
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        compose.onNodeWithContentDescription("Close").assertDoesNotExist()
    }

    @Test
    fun pairingFromInstallationsCanGoBack() {
        val coordinator = coordinator()
        var backs = 0
        compose.setContent {
            AidenTheme {
                AidenPairDesktopScreen(coordinator = coordinator, firstRun = false, onPaired = {}, onNavigateBack = { backs++ })
            }
        }

        compose.onAllNodesWithText("Pair a desktop").onFirst().assertExists()
        compose.onNodeWithContentDescription("Back").performClick()

        compose.runOnIdle { assertEquals(1, backs) }
    }

    @Test
    fun theActiveDesktopIsTheSelectedChoiceAndRemovalIsItsOwnAction() {
        val studio = installation("studio", "Studio")
        val laptop = installation("laptop", "Laptop")
        val activated = mutableListOf<String>()
        val removed = mutableListOf<String>()
        compose.setContent {
            AidenTheme {
                AidenInstallationList(
                    installations = listOf(studio, laptop),
                    activeId = studio.id,
                    onActivate = { activated += it.id },
                    onRemove = { removed += it.id }
                )
            }
        }
        val isRadio = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)

        compose.onNode(hasText("Studio") and isRadio).assertIsSelected()
        compose.onNode(hasText("Active · ${studio.endpoint}") and isRadio).assertIsSelected()
        compose.onNode(hasText("Laptop") and isRadio).assertIsNotSelected()

        compose.onNode(hasText("Laptop") and isRadio).performClick()
        compose.onNodeWithContentDescription("Remove Studio").performClick()

        compose.runOnIdle {
            assertEquals(listOf("laptop"), activated)
            assertEquals(listOf("studio"), removed)
        }
    }

    private fun installation(id: String, name: String) = AidenInstallation(
        instanceId = id,
        deviceId = "device-$id",
        name = name,
        endpoint = "https://$id.local:8765/api/aiden/v1",
        serverSpkiSha256 = "a".repeat(64),
        deviceCapabilities = emptyList(),
        createdAt = Instant.EPOCH
    )
}
