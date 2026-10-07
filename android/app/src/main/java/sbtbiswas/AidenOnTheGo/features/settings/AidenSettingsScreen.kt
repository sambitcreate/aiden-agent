package sbtbiswas.AidenOnTheGo.features.settings

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Contrast
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.SdStorage
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.models.READ_ALOUD_SETUP_GUIDANCE
import sbtbiswas.AidenOnTheGo.navigation.AidenSettingsPage
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/** Routes a Settings destination to its page. Every page is a full screen with its own back. */
@Composable
fun AidenSettingsDestination(
    page: AidenSettingsPage,
    settingsStore: AidenSettingsStore,
    appearanceStore: AidenAppearanceStore,
    voiceInputStore: AidenVoiceInputStore,
    installationStore: AidenInstallationStore,
    onNavigate: (AidenSettingsPage) -> Unit,
    onOpenInstallations: () -> Unit,
    onNavigateBack: () -> Unit
) {
    when (page) {
        AidenSettingsPage.ROOT -> {
            val installations by installationStore.installations.collectAsStateWithLifecycle()
            val activeId by installationStore.activeInstallationId.collectAsStateWithLifecycle()
            AidenSettingsScreen(
                store = settingsStore,
                voiceInputStore = voiceInputStore,
                connectedDesktopName = installations.firstOrNull { it.id == activeId }?.name,
                onNavigate = onNavigate,
                onOpenInstallations = onOpenInstallations,
                onNavigateBack = onNavigateBack
            )
        }
        AidenSettingsPage.APPEARANCE -> AidenAppearanceSettingsScreen(appearanceStore, onNavigateBack)
        AidenSettingsPage.VOICE -> AidenVoiceSettingsScreen(settingsStore, voiceInputStore, onNavigateBack)
        AidenSettingsPage.PROVIDERS -> AidenProviderSettingsScreen(
            store = settingsStore,
            onAddProvider = { onNavigate(AidenSettingsPage.ADD_PROVIDER) },
            onNavigateBack = onNavigateBack
        )
        AidenSettingsPage.ADD_PROVIDER -> AidenAddProviderScreen(settingsStore, onNavigateBack)
        AidenSettingsPage.ABOUT -> AidenAboutSettingsScreen(onNavigateBack)
    }
}

/**
 * Settings root, in the same order as iOS: connected desktop, providers, memory, voice
 * input, Read Aloud, appearance, about. Cached desktop values render immediately and
 * refresh in the background whenever the page is entered or the app resumes.
 */
@Composable
fun AidenSettingsScreen(
    store: AidenSettingsStore,
    voiceInputStore: AidenVoiceInputStore,
    connectedDesktopName: String?,
    onNavigate: (AidenSettingsPage) -> Unit,
    onOpenInstallations: () -> Unit,
    onNavigateBack: () -> Unit
) {
    val state by store.state.collectAsStateWithLifecycle()
    val voiceMode by voiceInputStore.mode.collectAsStateWithLifecycle()
    val config = AidenTheme.config
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { store.refresh() }

    AidenSettingsScaffold(
        title = stringResource(R.string.settings_title),
        onNavigateBack = onNavigateBack
    ) {
        item(key = "desktop") {
            AidenSettingsGroup(title = stringResource(R.string.settings_group_desktop)) {
                row {
                    AidenSettingsNavigationRow(
                        headline = stringResource(R.string.settings_connected_desktop),
                        supporting = connectedDesktopName ?: stringResource(R.string.settings_not_connected),
                        leadingIcon = Icons.Outlined.Laptop,
                        onClick = onOpenInstallations
                    )
                }
            }
        }
        item(key = "providers") {
            val supporting = when {
                state.providers != null -> pluralStringResource(
                    R.plurals.settings_providers_connected,
                    state.providers!!.size,
                    state.providers!!.size
                )
                state.providersFailure != null -> stringResource(R.string.settings_providers_unavailable)
                !state.isConnected -> stringResource(R.string.settings_connect_to_manage)
                else -> null
            }
            AidenSettingsGroup(
                title = stringResource(R.string.settings_group_providers),
                footer = stringResource(R.string.settings_providers_footer)
            ) {
                row {
                    AidenSettingsNavigationRow(
                        headline = stringResource(R.string.settings_providers),
                        supporting = supporting,
                        supportingLoading = state.isLoadingProviders,
                        leadingIcon = Icons.Outlined.Dns,
                        onClick = { onNavigate(AidenSettingsPage.PROVIDERS) }
                    )
                }
            }
        }
        item(key = "memory") {
            AidenSettingsMemoryGroup(state = state, onToggle = store::setMemoryEnabled)
        }
        item(key = "voice") {
            AidenSettingsGroup(title = stringResource(R.string.settings_group_voice)) {
                row {
                    AidenSettingsNavigationRow(
                        headline = stringResource(R.string.settings_transcription),
                        supporting = voiceMode.title,
                        leadingIcon = Icons.Outlined.Mic,
                        onClick = { onNavigate(AidenSettingsPage.VOICE) }
                    )
                }
            }
        }
        item(key = "read-aloud") {
            val readAloud = state.readAloud
            val supporting = when {
                readAloud?.ready == true -> stringResource(R.string.settings_read_aloud_ready)
                readAloud != null -> stringResource(R.string.settings_read_aloud_setup)
                state.readAloudFailure != null || !state.isConnected -> stringResource(R.string.settings_read_aloud_unavailable)
                else -> null
            }
            AidenSettingsGroup(
                title = stringResource(R.string.settings_group_read_aloud),
                footer = READ_ALOUD_SETUP_GUIDANCE
            ) {
                row {
                    AidenSettingsValueRow(
                        headline = stringResource(R.string.settings_read_aloud),
                        supporting = supporting,
                        supportingLoading = state.isLoadingReadAloud,
                        leadingIcon = Icons.Outlined.RecordVoiceOver
                    )
                }
            }
        }
        item(key = "appearance") {
            AidenSettingsGroup(title = stringResource(R.string.settings_group_appearance)) {
                row {
                    AidenSettingsNavigationRow(
                        headline = stringResource(R.string.settings_appearance),
                        supporting = "${config.preset.title} · ${config.mode.title}",
                        leadingIcon = Icons.Outlined.Contrast,
                        onClick = { onNavigate(AidenSettingsPage.APPEARANCE) }
                    )
                }
            }
        }
        item(key = "about") {
            AidenSettingsGroup(title = stringResource(R.string.settings_group_about)) {
                row {
                    AidenSettingsNavigationRow(
                        headline = stringResource(R.string.settings_about),
                        supporting = stringResource(R.string.settings_about_supporting),
                        leadingIcon = Icons.Outlined.Info,
                        onClick = { onNavigate(AidenSettingsPage.ABOUT) }
                    )
                }
            }
        }
    }
}

/**
 * Memory on the paired desktop. Unknown state shows a placeholder rather than a fake On,
 * the whole row toggles, and a failed save rolls back with an inline error.
 */
@Composable
internal fun AidenSettingsMemoryGroup(state: AidenSettingsState, onToggle: (Boolean) -> Unit) {
    val headline = stringResource(R.string.settings_use_memory)
    AidenSettingsGroup(
        title = stringResource(R.string.settings_group_memory),
        footer = stringResource(R.string.settings_memory_footer),
        error = when (state.memoryFailure) {
            AidenSettingsFailure.SAVE_FAILED -> stringResource(R.string.settings_memory_save_failed)
            AidenSettingsFailure.UNAVAILABLE -> if (state.memory != null) stringResource(R.string.settings_memory_stale) else null
            null -> null
        }
    ) {
        row {
            val memory = state.memory
            if (memory != null || state.isLoadingMemory) {
                AidenSettingsSwitchRow(
                    headline = headline,
                    checked = memory?.enabled,
                    enabled = state.isConnected && !state.isSavingMemory,
                    leadingIcon = Icons.Outlined.SdStorage,
                    onCheckedChange = onToggle
                )
            } else {
                AidenSettingsValueRow(
                    headline = headline,
                    supporting = stringResource(
                        if (state.isConnected) R.string.settings_memory_unavailable else R.string.settings_connect_to_manage
                    ),
                    leadingIcon = Icons.Outlined.SdStorage
                )
            }
        }
    }
}
