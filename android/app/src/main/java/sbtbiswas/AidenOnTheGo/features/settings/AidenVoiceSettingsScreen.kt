package sbtbiswas.AidenOnTheGo.features.settings

import android.content.Context
import android.content.Intent
import android.os.Build
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputMode
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.models.AidenSpeechModel
import sbtbiswas.AidenOnTheGo.models.AidenSpeechStatus
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/**
 * Voice input: where speech is transcribed, plus the status of that engine. Desktop speech
 * models render from the cached status and refresh in the background; a running download
 * shows its real percentage.
 */
@Composable
fun AidenVoiceSettingsScreen(
    store: AidenSettingsStore,
    voiceInputStore: AidenVoiceInputStore,
    onNavigateBack: () -> Unit
) {
    val context = LocalContext.current
    val state by store.state.collectAsStateWithLifecycle()
    val mode by voiceInputStore.mode.collectAsStateWithLifecycle()
    var onDeviceReady by remember { mutableStateOf(isOnDeviceRecognitionAvailable(context)) }
    var languageDownloadFailed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        onDeviceReady = isOnDeviceRecognitionAvailable(context)
        if (mode == AidenVoiceInputMode.PAIRED_MAC) store.refreshSpeech()
    }

    AidenSettingsScaffold(
        title = stringResource(R.string.voice_title),
        onNavigateBack = onNavigateBack
    ) {
        item(key = "mode") {
            AidenVoiceInputModeChoices(
                selected = mode,
                onSelect = {
                    voiceInputStore.updateMode(it)
                    if (it == AidenVoiceInputMode.PAIRED_MAC) store.refreshSpeech()
                }
            )
        }
        if (mode == AidenVoiceInputMode.ON_DEVICE) {
            item(key = "on-device") {
                val canInstall = !onDeviceReady && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                AidenSettingsGroup(
                    title = stringResource(R.string.voice_group_on_device),
                    error = if (languageDownloadFailed) stringResource(R.string.voice_language_download_failed) else null
                ) {
                    row {
                        AidenSettingsValueRow(
                            headline = stringResource(R.string.voice_on_device_status),
                            supporting = stringResource(
                                if (onDeviceReady) R.string.voice_on_device_ready else R.string.voice_on_device_needs_language
                            ),
                            leadingIcon = Icons.Outlined.GraphicEq
                        )
                    }
                    if (canInstall) {
                        row {
                            AidenSettingsValueRow(
                                headline = stringResource(R.string.voice_install_language),
                                leadingIcon = Icons.Outlined.Language,
                                onClick = {
                                    languageDownloadFailed = !triggerLanguageDownload(context) { recognizer ->
                                        scope.launch {
                                            delay(5_000)
                                            recognizer.destroy()
                                        }
                                    }
                                }
                            )
                        }
                    }
                }
            }
        } else {
            item(key = "desktop-model") {
                AidenDesktopSpeechGroup(
                    state = state,
                    onSelect = store::selectSpeechModel,
                    onDownload = store::downloadSpeechModel,
                    onCancel = store::cancelSpeechModelDownload
                )
            }
        }
    }
}

private fun isOnDeviceRecognitionAvailable(context: Context): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)

/** Asks Android to fetch on-device language support. Returns false when it could not start. */
private fun triggerLanguageDownload(context: Context, release: (SpeechRecognizer) -> Unit): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
    return runCatching {
        val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer.triggerModelDownload(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, java.util.Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        })
        release(recognizer)
    }.isSuccess
}

internal fun AidenVoiceInputMode.choiceDescription(): Int = when (this) {
    AidenVoiceInputMode.ON_DEVICE -> R.string.voice_mode_on_device_description
    AidenVoiceInputMode.PAIRED_MAC -> R.string.voice_mode_paired_description
}

/** Where speech is transcribed, as one radio group whose whole rows select. */
@Composable
internal fun AidenVoiceInputModeChoices(
    selected: AidenVoiceInputMode,
    onSelect: (AidenVoiceInputMode) -> Unit
) {
    AidenSettingsGroup(
        title = stringResource(R.string.voice_group_transcription),
        footer = stringResource(R.string.voice_transcription_footer),
        selectableGroup = true
    ) {
        AidenVoiceInputMode.entries.forEach { mode ->
            row {
                AidenSettingsRadioRow(
                    headline = mode.title,
                    supporting = stringResource(mode.choiceDescription()),
                    selected = mode == selected,
                    onClick = { if (mode != selected) onSelect(mode) }
                )
            }
        }
    }
}

@Composable
private fun AidenDesktopSpeechGroup(
    state: AidenSettingsState,
    onSelect: (String) -> Unit,
    onDownload: (String) -> Unit,
    onCancel: (String) -> Unit
) {
    val status = state.speech
    AidenSettingsGroup(
        title = stringResource(R.string.voice_group_desktop_model),
        error = when (state.speechFailure) {
            AidenSettingsFailure.SAVE_FAILED -> stringResource(R.string.voice_speech_action_failed)
            AidenSettingsFailure.UNAVAILABLE -> stringResource(R.string.voice_speech_unavailable)
            null -> null
        }
    ) {
        when {
            status != null -> {
                row {
                    AidenSettingsValueRow(
                        headline = stringResource(R.string.voice_engine),
                        value = stringResource(if (status.engine.ready) R.string.voice_engine_ready else R.string.voice_engine_unavailable),
                        supporting = status.engine.error,
                        leadingIcon = Icons.Outlined.GraphicEq
                    )
                }
                status.models.forEach { model ->
                    row(dividerInset = AidenSettingsDefaults.DividerInset) {
                        AidenSpeechModelRow(
                            model = model,
                            status = status,
                            enabled = state.isConnected && !state.isSavingSpeech,
                            onSelect = { onSelect(model.id) },
                            onDownload = { onDownload(model.id) },
                            onCancel = { onCancel(model.id) }
                        )
                    }
                }
            }
            state.isLoadingSpeech -> {
                repeat(2) { row(dividerInset = AidenSettingsDefaults.DividerInset) { AidenSettingsSkeletonRow(leading = false) } }
            }
            !state.isConnected -> row(dividerInset = AidenSettingsDefaults.DividerInset) {
                AidenSettingsMessageRow(stringResource(R.string.voice_connect_desktop))
            }
        }
    }
}

@Composable
private fun AidenSpeechModelRow(
    model: AidenSpeechModel,
    status: AidenSpeechStatus,
    enabled: Boolean,
    onSelect: () -> Unit,
    onDownload: () -> Unit,
    onCancel: () -> Unit
) {
    val palette = AidenTheme.palette
    val download = model.download?.takeIf { it.status == "downloading" }
    AidenSettingsListItem(
        headline = model.name,
        modifier = Modifier,
        leading = null,
        supporting = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("${model.sizeLabel} · ${model.languagesLabel}")
                if (download != null) {
                    LinearProgressIndicator(
                        progress = { download.percentage.coerceIn(0, 100) / 100f },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp)
                    )
                    Text(
                        if (download.phase == "extract") stringResource(R.string.voice_installing)
                        else stringResource(R.string.voice_downloading, download.percentage)
                    )
                }
                model.download?.error?.let { Text(it, color = palette.danger) }
            }
        },
        trailing = {
            when {
                download != null -> TextButton(onClick = onCancel, enabled = enabled, shape = AidenShape.Button) {
                    Text(stringResource(R.string.action_cancel))
                }
                model.installed && status.selectedModelId == model.id -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Icon(Icons.Default.Check, contentDescription = null, tint = palette.accent, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.voice_selected), style = MaterialTheme.typography.labelLarge, color = palette.accent)
                }
                model.installed -> TextButton(onClick = onSelect, enabled = enabled, shape = AidenShape.Button) {
                    Text(stringResource(R.string.voice_use))
                }
                else -> TextButton(onClick = onDownload, enabled = enabled, shape = AidenShape.Button) {
                    Icon(Icons.Outlined.Download, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.voice_download), modifier = Modifier.padding(start = 4.dp))
                }
            }
        }
    )
}
