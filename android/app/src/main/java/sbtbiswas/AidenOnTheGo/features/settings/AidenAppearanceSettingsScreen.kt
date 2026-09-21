package sbtbiswas.AidenOnTheGo.features.settings

import android.content.Intent
import android.os.Build
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.config.*
import sbtbiswas.AidenOnTheGo.models.AidenSpeechStatus
import sbtbiswas.AidenOnTheGo.models.AidenMemorySettings
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

@Composable
fun AidenAppearanceSettingsScreen(
    appearanceStore: AidenAppearanceStore? = null,
    voiceInputStore: AidenVoiceInputStore,
    remoteClient: AidenRemoteClient?,
    onOpenInstallations: (() -> Unit)? = null
) {
    val currentConfig = AidenTheme.config
    val palette = AidenTheme.palette
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val voiceMode by voiceInputStore.mode.collectAsState()
    var speechStatus by remember { mutableStateOf<AidenSpeechStatus?>(null) }
    var speechError by remember { mutableStateOf<String?>(null) }
    var memorySettings by remember { mutableStateOf<AidenMemorySettings?>(null) }
    var memoryError by remember { mutableStateOf<String?>(null) }
    var memorySaving by remember { mutableStateOf(false) }

    suspend fun refreshSpeech() {
        val client = remoteClient ?: run {
            speechStatus = null
            return
        }
        runCatching { client.speechStatus() }
            .onSuccess { speechStatus = it; speechError = null }
            .onFailure { speechError = it.message ?: "Mac transcription is unavailable." }
    }

    fun runSpeechAction(action: suspend () -> AidenSpeechStatus) {
        scope.launch {
            runCatching { action() }
                .onSuccess { speechStatus = it; speechError = null }
                .onFailure { speechError = it.message ?: "Mac transcription is unavailable." }
        }
    }

    LaunchedEffect(remoteClient, voiceMode) {
        if (voiceMode == AidenVoiceInputMode.PAIRED_MAC) refreshSpeech()
    }
    LaunchedEffect(remoteClient) {
        memorySettings = remoteClient?.let { client ->
            runCatching { client.memorySettings() }
                .onFailure { memoryError = it.message ?: "Memory settings are unavailable." }
                .getOrNull()
        }
    }
    LaunchedEffect(speechStatus) {
        if (speechStatus?.models?.any { it.download?.status == "downloading" } == true) {
            delay(1_000)
            refreshSpeech()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(20.dp)
    ) {
        Text(
            text = "Settings",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            color = palette.foreground
        )

        Spacer(modifier = Modifier.height(16.dp))

        if (onOpenInstallations != null) {
            Surface(
                onClick = onOpenInstallations,
                color = palette.raised,
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                    Icon(Icons.Outlined.Devices, contentDescription = null, tint = palette.foreground)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Installations", style = MaterialTheme.typography.titleMedium, color = palette.foreground)
                        Text("Pair or switch your Aiden Agent Mac", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                    }
                }
            }
            Spacer(modifier = Modifier.height(22.dp))
        }

        Text(
            text = "Memory",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = palette.foreground
        )
        Spacer(Modifier.height(8.dp))
        Surface(color = palette.raised, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Use memory", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                    Text("Controls recall, saving, and indexing on your paired Mac. Existing approved facts are not deleted.", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                }
                Switch(
                    checked = memorySettings?.enabled ?: true,
                    enabled = memorySettings != null && !memorySaving,
                    onCheckedChange = { enabled ->
                        val current = memorySettings ?: return@Switch
                        memorySettings = current.copy(enabled = enabled)
                        memorySaving = true
                        scope.launch {
                            runCatching { remoteClient?.updateMemorySettings(current.revision, enabled) ?: error("Connect to a paired Mac.") }
                                .onSuccess { memorySettings = it; memoryError = null }
                                .onFailure { memorySettings = current; memoryError = it.message ?: "Memory settings are unavailable." }
                            memorySaving = false
                        }
                    }
                )
            }
        }
        memoryError?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, style = MaterialTheme.typography.bodySmall, color = palette.danger)
        }
        Spacer(modifier = Modifier.height(22.dp))

        Text(
            text = "Voice input",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = palette.foreground
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = "Choose where speech is transcribed. Paired Mac sends microphone audio over Aiden's encrypted pinned connection and does not retain it.",
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary
        )
        Spacer(Modifier.height(10.dp))
        AidenVoiceInputMode.entries.forEach { mode ->
            Surface(
                selected = voiceMode == mode,
                onClick = { voiceInputStore.updateMode(mode) },
                color = if (voiceMode == mode) MaterialTheme.colorScheme.primaryContainer else palette.raised,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Text(mode.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                    Text(
                        if (mode == AidenVoiceInputMode.ON_DEVICE) "Android SpeechRecognizer; speech stays on this device." else "Parakeet on your connected Aiden Agent Mac; final text appears after you stop.",
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
        }

        if (voiceMode == AidenVoiceInputMode.ON_DEVICE) {
            val available = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
            Text(
                if (available) "On-device recognition is ready." else "On-device recognition needs language support.",
                style = MaterialTheme.typography.bodySmall,
                color = if (available) palette.success else palette.warning
            )
            if (!available && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                TextButton(onClick = {
                    runCatching {
                        val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
                        recognizer.triggerModelDownload(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                            putExtra(RecognizerIntent.EXTRA_LANGUAGE, java.util.Locale.getDefault().toLanguageTag())
                            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                        })
                        scope.launch {
                            delay(5_000)
                            recognizer.destroy()
                        }
                    }.onFailure { speechError = "Android couldn't start the language download." }
                }) { Text("Install language support") }
            }
        } else {
            val status = speechStatus
            if (remoteClient == null) {
                Text("Connect to a paired Mac to configure transcription.", style = MaterialTheme.typography.bodySmall, color = palette.warning)
            } else if (status == null && speechError == null) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
            } else if (status != null) {
                status.models.forEach { model ->
                    Surface(color = palette.raised, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(model.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                                    Text("${model.sizeLabel} · ${model.languagesLabel}", style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                                }
                                when {
                                    model.download?.status == "downloading" -> TextButton(onClick = {
                                        runSpeechAction { remoteClient.cancelSpeechModelDownload(model.id) }
                                    }) { Text("Cancel") }
                                    model.installed && status.selectedModelId == model.id -> Text("Selected", style = MaterialTheme.typography.labelMedium, color = palette.accent)
                                    model.installed -> TextButton(onClick = {
                                        runSpeechAction { remoteClient.selectSpeechModel(model.id) }
                                    }) { Text("Use") }
                                    else -> TextButton(onClick = {
                                        runSpeechAction { remoteClient.downloadSpeechModel(model.id) }
                                    }) { Text("Download") }
                                }
                            }
                            model.download?.takeIf { it.status == "downloading" }?.let { download ->
                                Spacer(Modifier.height(8.dp))
                                LinearProgressIndicator(progress = { download.percentage / 100f }, modifier = Modifier.fillMaxWidth())
                            }
                            model.download?.error?.let { failure ->
                                Spacer(Modifier.height(6.dp))
                                Text(failure, style = MaterialTheme.typography.bodySmall, color = palette.danger)
                            }
                            Text(model.description, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                }
            }
        }
        speechError?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = palette.danger)
        }

        Spacer(modifier = Modifier.height(22.dp))

        Text(
            text = "Appearance",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = palette.foreground
        )
        Spacer(modifier = Modifier.height(14.dp))

        // Mode selector (System, Light, Dark)
        Text(
            text = "Mode",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = palette.secondary
        )
        Spacer(modifier = Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            AidenAppearanceMode.values().forEach { mode ->
                AidenSettingsChoice(
                    label = mode.title,
                    selected = currentConfig.mode == mode,
                    onClick = { appearanceStore?.updateMode(mode) },
                    modifier = Modifier.weight(1f)
                )
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Theme tile grid
        Text(
            text = "Themes",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = palette.secondary
        )
        Spacer(modifier = Modifier.height(8.dp))

        AidenThemePresetID.entries.toList().chunked(3).forEach { rowPresets ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                rowPresets.forEach { preset ->
                    AidenThemeTile(
                        preset = preset,
                        selected = currentConfig.preset == preset,
                        onClick = { appearanceStore?.updatePreset(preset) },
                        modifier = Modifier.weight(1f)
                    )
                }
                repeat(3 - rowPresets.size) {
                    Spacer(modifier = Modifier.weight(1f))
                }
            }
            Spacer(modifier = Modifier.height(10.dp))
        }

        Spacer(modifier = Modifier.height(6.dp))
        Text(
            text = "Current theme: ${currentConfig.preset.title}",
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary
        )
    }
}

/** Scheme whose palette visually defines this preset on its tile. */
private val AidenThemePresetID.signatureIsDark: Boolean
    get() = this == AidenThemePresetID.GRAPHITE || this == AidenThemePresetID.DUSK || this == AidenThemePresetID.MIDNIGHT

@Composable
private fun AidenThemeTile(
    preset: AidenThemePresetID,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val preview = AidenThemeCatalog.palette(preset, preset.signatureIsDark)
    Column(
        modifier = modifier
            .tactilePress(onClick = onClick)
            .semantics(mergeDescendants = true) {
                role = Role.RadioButton
                this.selected = selected
                onClick(label = "Select ${preset.title} theme") {
                    onClick()
                    true
                }
            },
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(modifier = Modifier.fillMaxWidth()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(1.52f)
                    .clip(RoundedCornerShape(12.dp))
                    .background(preview.canvas)
            ) {
                Text(
                    text = "Aa",
                    fontSize = 30.sp,
                    fontWeight = FontWeight.Medium,
                    color = preview.foreground,
                    modifier = Modifier.align(Alignment.Center)
                )
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(8.dp)
                        .size(11.dp)
                        .clip(CircleShape)
                        .background(preview.accent)
                        .border(1.dp, Color.White.copy(alpha = 0.55f), CircleShape)
                )
            }
            if (selected) {
                Surface(
                    color = palette.raised,
                    shape = CircleShape,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = 6.dp, y = (-6).dp)
                        .size(21.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.Check,
                        contentDescription = null,
                        tint = palette.accent,
                        modifier = Modifier.padding(4.dp)
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(7.dp))
        Text(
            text = preset.title,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Medium,
            color = if (selected) palette.foreground else palette.secondary,
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                .padding(horizontal = 9.dp, vertical = 3.dp)
        )
    }
}

@Composable
private fun AidenSettingsChoice(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    Surface(
        onClick = onClick,
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else palette.raised,
        shape = RoundedCornerShape(14.dp),
        modifier = modifier.heightIn(min = 44.dp)
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(horizontal = 8.dp, vertical = 10.dp)) {
            Text(
                label,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                color = if (selected) palette.accent else palette.foreground,
                maxLines = 1
            )
        }
    }
}
