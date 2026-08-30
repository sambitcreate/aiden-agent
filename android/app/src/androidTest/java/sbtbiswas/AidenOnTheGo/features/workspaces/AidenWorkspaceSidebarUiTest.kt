package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenWorkspace
import sbtbiswas.AidenOnTheGo.models.AidenWorkspacePermission
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenWorkspaceSidebarUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun disclosureReportsExpandedStateToAccessibilityServices() {
        val workspace = AidenWorkspace(
            id = "alpha",
            name = "Alpha",
            permission = AidenWorkspacePermission.ASK,
            updatedAt = Instant.parse("2026-08-24T12:00:00Z"),
            revision = "alpha-r1"
        )
        val section = AidenWorkspaceSidebarSection(
            workspace = workspace,
            chats = emptyList(),
            newestActivityAt = workspace.updatedAt ?: Instant.EPOCH
        )
        var expanded by mutableStateOf(false)

        compose.setContent {
            AidenTheme {
                AidenWorkspaceSidebarSectionRow(
                    section = section,
                    expanded = expanded,
                    canCreateChat = true,
                    onToggle = { expanded = !expanded },
                    onCreateChat = {},
                    onNavigateToChat = {}
                )
            }
        }

        val disclosure = compose.onNodeWithTag("workspace_disclosure_alpha")
        disclosure.assert(
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed")
        )
        disclosure.performClick()
        disclosure.assert(
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded")
        )
    }
}
