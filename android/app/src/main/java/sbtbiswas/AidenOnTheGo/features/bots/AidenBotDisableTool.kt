package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenBotCapabilityCatalog
import sbtbiswas.AidenOnTheGo.models.AidenBotCapabilityOption
import sbtbiswas.AidenOnTheGo.models.AidenBotFileScopeKind
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton

/** Revision 61, client only: one tool a Bot may use, by the access set it lives in. */
sealed interface AidenBotTool {
    data object Shell : AidenBotTool
    data class Connection(val id: String) : AidenBotTool
    data class Skill(val id: String) : AidenBotTool
    data class Other(val id: String) : AidenBotTool
}

/** Every tool a Bot on Full access can use now, with its label ("Run commands" for the shell). */
fun aidenBotAvailableTools(catalog: AidenBotCapabilityCatalog, shellLabel: String): List<Pair<AidenBotTool, String>> = buildList {
    if (catalog.shellAvailable) add(AidenBotTool.Shell to shellLabel)
    catalog.connections.filter { it.available }.forEach { add(AidenBotTool.Connection(it.id) to it.label) }
    catalog.skills.filter { it.available }.forEach { add(AidenBotTool.Skill(it.id) to it.label) }
    catalog.otherCapabilities.filter { it.available }.forEach { add(AidenBotTool.Other(it.id) to it.label) }
}

/**
 * Web search, which Full access grants only while the Mac's own web search switch is on. The wire
 * carries neither that switch nor a capability's kind, so the host's fixed label identifies it.
 */
internal fun aidenBotIsWebSearch(option: AidenBotCapabilityOption): Boolean =
    option.label.trim().let { it.equals("Web search", ignoreCase = true) || it.equals("Web", ignoreCase = true) }

/**
 * Disable a tool, as on the Mac. A Bot on Full access first becomes Custom with everything Full
 * certainly grants and the widest file access (the whole Mac, else its own folder and the approved
 * places), so only [tool] goes. The conversion only narrows: web search is left off, because Full
 * grants it only when the Mac's web search switch is on, which this phone can't see; the person
 * can turn it back on in Custom. The draft saves through the existing capabilities route; Full
 * access again is the selector's Full choice.
 */
fun AidenBotAdvancedDraft.disabling(tool: AidenBotTool, catalog: AidenBotCapabilityCatalog): AidenBotAdvancedDraft {
    var custom = customAccess.copy()
    if (usesFullAccess) {
        val scopes = catalog.fileScopes.filter { it.available }
        val whole = scopes.firstOrNull { it.kind == AidenBotFileScopeKind.FULL_MAC }
        val home = scopes.firstOrNull { it.kind == AidenBotFileScopeKind.BOT_HOME }
        custom = custom.copy(
            fileScopeIDs = when {
                whole != null -> setOf(whole.id)
                home != null -> setOf(home.id) + scopes.filter { it.kind == AidenBotFileScopeKind.APPROVED_LOCATION }.map { it.id }
                else -> emptySet()
            },
            shellEnabled = catalog.shellAvailable,
            connectionIDs = catalog.connections.filter { it.available }.map { it.id }.toSet(),
            skillIDs = catalog.skills.filter { it.available || !catalog.skillsEnabled }.map { it.id }.toSet(),
            otherCapabilityIDs = catalog.otherCapabilities.filter { it.available && !aidenBotIsWebSearch(it) }.map { it.id }.toSet()
        )
    }
    custom = when (tool) {
        AidenBotTool.Shell -> custom.copy(shellEnabled = false)
        is AidenBotTool.Connection -> custom.copy(connectionIDs = custom.connectionIDs - tool.id)
        is AidenBotTool.Skill -> custom.copy(skillIDs = custom.skillIDs - tool.id)
        is AidenBotTool.Other -> custom.copy(otherCapabilityIDs = custom.otherCapabilityIDs - tool.id)
    }
    return copy(usesFullAccess = false, customAccess = custom)
}

/** The Disable a tool menu under Full access. Picking a tool moves the draft to Custom without it. */
@Composable
fun AidenBotDisableToolMenu(catalog: AidenBotCapabilityCatalog, onDisable: (AidenBotTool) -> Unit) {
    val tools = aidenBotAvailableTools(catalog, stringResource(R.string.bot_advanced_run_commands))
    if (tools.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    Box {
        AidenTonalButton(
            text = stringResource(R.string.bot_disable_tool),
            leadingIcon = Icons.Outlined.RemoveCircleOutline,
            onClick = { open = true }
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            tools.forEach { (tool, label) ->
                DropdownMenuItem(text = { Text(label) }, onClick = {
                    open = false
                    onDisable(tool)
                })
            }
        }
    }
}
