package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceConfig
import sbtbiswas.AidenOnTheGo.models.AidenBrowserBreadcrumb
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileEntry
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileKind
import sbtbiswas.AidenOnTheGo.models.AidenWorkspacePermission
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenWorkspaceShellUiTest {
    @get:Rule
    val compose = createComposeRule()

    private fun hasRole(role: Role) = SemanticsMatcher.expectValue(SemanticsProperties.Role, role)

    @Test
    fun permissionCardsAreRadioChoicesThatSelectOnce() {
        var selected by mutableStateOf(AidenWorkspacePermission.ASK)
        val picks = mutableListOf<AidenWorkspacePermission>()
        compose.setContent {
            AidenTheme {
                AidenWorkspacePermissionGroup(
                    selected = selected,
                    onSelect = {
                        picks += it
                        selected = it
                    }
                )
            }
        }

        val full = compose.onNode(hasText("Full") and hasRole(Role.RadioButton))
        val ask = compose.onNode(hasText("Ask") and hasRole(Role.RadioButton))
        ask.assertIsSelected()
        full.assertIsNotSelected()

        full.performClick()

        assertEquals(listOf(AidenWorkspacePermission.FULL), picks)
        full.assertIsSelected()
        ask.assertIsNotSelected()
    }

    @Test
    fun memoryCardTogglesAsASingleSwitch() {
        var enabled by mutableStateOf(true)
        var changes = 0
        compose.setContent {
            AidenTheme {
                AidenWorkspaceMemoryRow(checked = enabled, onCheckedChange = {
                    changes += 1
                    enabled = it
                })
            }
        }

        val row = compose.onNode(hasText("Use memory") and hasRole(Role.Switch))
        row.assert(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.On))
        row.performClick()
        assertEquals(1, changes)
        row.assert(SemanticsMatcher.expectValue(SemanticsProperties.ToggleableState, ToggleableState.Off))
    }

    @Test
    fun gitActionBarRoutesEachSegmentToItsOwnActionOnce() {
        val taps = mutableListOf<String>()
        compose.setContent {
            AidenTheme {
                AidenGitActionBar(
                    pushInFlight = false,
                    onBranch = { taps += "branch" },
                    onPush = { taps += "push" },
                    onCompare = { taps += "compare" },
                    onWorktrees = { taps += "worktrees" }
                )
            }
        }

        listOf("Branch", "Push", "Compare", "Worktrees").forEach { label ->
            compose.onNode(hasText(label) and hasRole(Role.Button)).performClick()
        }
        assertEquals(listOf("branch", "push", "compare", "worktrees"), taps)
    }

    @Test
    fun pushSegmentKeepsItsLabelWhileCheckingCapability() {
        compose.setContent {
            AidenTheme {
                AidenGitActionBar(pushInFlight = true, onBranch = {}, onPush = {}, onCompare = {}, onWorktrees = {})
            }
        }
        compose.onNode(hasText("Push") and hasRole(Role.Button)).assertIsDisplayed()
    }

    @Test
    fun folderRowReportsDisclosureStateAndTogglesOncePerTap() {
        val folder = AidenWorkspaceFileEntry("dir", "src/features", "features", AidenWorkspaceFileKind.DIRECTORY)
        var expanded by mutableStateOf(false)
        var taps = 0
        compose.setContent {
            AidenTheme(config = AidenAppearanceConfig(reduceMotion = true)) {
                AidenWorkspaceFileTreeRow(
                    entry = folder,
                    index = 0,
                    count = 1,
                    expanded = expanded,
                    enabled = true,
                    onClick = {
                        taps += 1
                        expanded = !expanded
                    }
                )
            }
        }

        val row = compose.onNodeWithText("features")
        row.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
        row.performClick()
        assertEquals(1, taps)
        row.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
    }

    @Test
    fun symlinkRowIsNotActionable() {
        val link = AidenWorkspaceFileEntry("link", "docs/latest", "latest", AidenWorkspaceFileKind.SYMLINK)
        compose.setContent {
            AidenTheme {
                AidenWorkspaceFileTreeRow(entry = link, index = 0, count = 1, expanded = false, enabled = false, onClick = {})
            }
        }
        compose.onNodeWithText("latest").assertIsNotEnabled()
    }

    @Test
    fun breadcrumbPillsNavigateToTheirLocationAndRootsClearsIt() {
        val chosen = mutableListOf<String?>()
        compose.setContent {
            AidenTheme {
                AidenFolderBreadcrumbs(
                    crumbs = aidenFolderCrumbs(listOf(AidenBrowserBreadcrumb("Users", "loc-users"), AidenBrowserBreadcrumb("projects", "loc-projects"))),
                    onSelect = { chosen += it.location }
                )
            }
        }

        compose.onNode(hasText("Users") and hasRole(Role.Button)).performClick()
        compose.onNode(hasText("Roots") and hasRole(Role.Button)).performClick()
        assertEquals(listOf("loc-users", null), chosen)
    }

    @Test
    fun dialogWithoutConfirmOffersOnlyTheDismissAction() {
        var dismissals = 0
        compose.setContent {
            AidenTheme {
                AidenWorkspaceAlertDialog(
                    title = "Push to Remote",
                    onDismissRequest = { dismissals += 1 },
                    confirmText = null,
                    onConfirm = {}
                ) {
                    androidx.compose.material3.Text("Push is not allowed")
                }
            }
        }

        compose.onNodeWithText("Push").assertDoesNotExist()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(1, dismissals)
    }
}
