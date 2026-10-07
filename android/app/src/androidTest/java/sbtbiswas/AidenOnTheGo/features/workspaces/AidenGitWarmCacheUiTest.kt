package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasProgressBarRangeInfo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenGitFile
import sbtbiswas.AidenOnTheGo.models.AidenGitFileStatus
import sbtbiswas.AidenOnTheGo.models.AidenGitOperationStatus
import sbtbiswas.AidenOnTheGo.models.AidenGitResult
import sbtbiswas.AidenOnTheGo.models.AidenGitReview
import sbtbiswas.AidenOnTheGo.models.AidenPairingExchange
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenReadSnapshotKeys
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.io.File

/** Git review renders the last saved review of a Workspace before the desktop answers. */
@RunWith(AndroidJUnit4::class)
class AidenGitWarmCacheUiTest {
    @get:Rule
    val compose = createComposeRule()

    private lateinit var storage: File
    private lateinit var coordinator: AidenRemoteCoordinator

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        storage = File(context.cacheDir, "git-warm-${System.nanoTime()}").apply { mkdirs() }
        val installations = AidenInstallationStore(storage, InMemoryAidenSecureStore())
        installations.addInstallation(
            AidenPairingExchange(
                instanceId = "mac-1",
                deviceId = "device-1",
                endpoint = "https://mac-1.test/api/aiden/v1",
                serverSpkiSha256 = "sha256/mac-1",
                credential = "secret",
                capabilities = listOf(AidenRemoteCapability.CHAT_READ)
            ),
            trust = null
        )
        // The coordinator never activates a client, so nothing reaches a network.
        coordinator = AidenRemoteCoordinator(
            installationStore = installations,
            storageDir = storage,
            scope = CoroutineScope(Dispatchers.Unconfined + Job().apply { cancel() })
        )
    }

    @After
    fun tearDown() {
        storage.deleteRecursively()
    }

    @Test
    fun aSavedReviewRendersAtOnceAndHoldsSnapshotActionsUntilItIsFresh() {
        coordinator.readSnapshotCache.store(
            "mac-1",
            AidenReadSnapshotKeys.gitReview("workspace-1"),
            AidenGitResult(
                operationId = "op-1",
                status = AidenGitOperationStatus.SNAPSHOT,
                snapshotId = "snapshot-stale",
                review = AidenGitReview(
                    branch = "release",
                    uncommitted = 1,
                    files = listOf(AidenGitFile(id = "file-1", displayPath = "src/App.kt", status = AidenGitFileStatus.MODIFIED))
                )
            ),
            AidenGitResult.serializer()
        )

        compose.setContent {
            AidenTheme {
                AidenGitScreen(workspaceId = "workspace-1", coordinator = coordinator, onNavigateBack = {})
            }
        }

        compose.onNodeWithText("Branch: release").assertIsDisplayed()
        compose.onNodeWithText("src/App.kt").assertIsDisplayed()
        compose.onNodeWithContentDescription("Loading changes").assertDoesNotExist()
        compose.onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate)).assertDoesNotExist()
        // The saved snapshot id may be stale, so a commit cannot be sent from it.
        compose.onNodeWithText("Commit Changes (1 files)").assertIsNotEnabled()
    }

    @Test
    fun aWorkspaceWithNoSavedReviewWhileDisconnectedSaysSo() {
        compose.setContent {
            AidenTheme {
                AidenGitScreen(workspaceId = "workspace-unseen", coordinator = coordinator, onNavigateBack = {})
            }
        }

        compose.onNodeWithText("Changes unavailable").assertIsDisplayed()
        compose.onNodeWithContentDescription("Loading changes").assertDoesNotExist()
    }
}
