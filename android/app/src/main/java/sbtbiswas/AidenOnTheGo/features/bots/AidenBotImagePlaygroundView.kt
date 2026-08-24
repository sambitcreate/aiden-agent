package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

data class AidenBotImagePlaygroundIdentity(
    val name: String,
    val purpose: String
) {
    val conceptTexts: List<String>
        get() = listOf(name.trim().take(80), purpose.trim().take(240)).filter { it.isNotEmpty() }
}

enum class AidenBotImagePlaygroundFallbackReason(
    val title: String,
    val message: String
) {
    UNSUPPORTED(
        title = "Image Playground isn't supported on this device",
        message = "You can keep using the semantic avatar on this device."
    ),
    RESTRICTED(
        title = "Image creation is restricted",
        message = "Image Playground may be restricted by device settings. You can keep using the semantic avatar."
    ),
    MODEL_UNAVAILABLE(
        title = "Apple's image model isn't ready",
        message = "Apple's image model may still be downloading or may be unavailable. Try again later, or use the semantic avatar."
    ),
    USAGE_LIMIT(
        title = "Image creation is temporarily limited",
        message = "Apple's image creation limit may have been reached. Try again later, or use the semantic avatar."
    ),
    UPDATE_REQUIRED(
        title = "Update to create a Bot image",
        message = "Aiden needs newer OS support to limit Image Playground to non-personalized styles. You can keep using the semantic avatar."
    ),
    SYSTEM_UNAVAILABLE(
        title = "Image Playground isn't available",
        message = "Apple doesn't currently make Image Playground available on this device. You can keep using the semantic avatar."
    ),
    CANDIDATE_COPY_FAILED(
        title = "That image couldn't be prepared",
        message = "The selected image couldn't be copied into Aiden safely. Choose another image, or use the semantic avatar."
    )
}

sealed class AidenBotImagePlaygroundPresentationPhase {
    object READY : AidenBotImagePlaygroundPresentationPhase()
    object PRESENTING : AidenBotImagePlaygroundPresentationPhase()
    object CANCELLED : AidenBotImagePlaygroundPresentationPhase()
    object ACCEPTED : AidenBotImagePlaygroundPresentationPhase()
    data class FALLBACK(val reason: AidenBotImagePlaygroundFallbackReason) : AidenBotImagePlaygroundPresentationPhase()
}

class AidenBotImagePlaygroundPresentationState(
    initialPhase: AidenBotImagePlaygroundPresentationPhase = AidenBotImagePlaygroundPresentationPhase.READY
) {
    var phase by mutableStateOf(initialPhase)
        private set

    fun requestPresentation(systemAvailable: Boolean) {
        phase = if (systemAvailable) AidenBotImagePlaygroundPresentationPhase.PRESENTING
        else AidenBotImagePlaygroundPresentationPhase.FALLBACK(AidenBotImagePlaygroundFallbackReason.SYSTEM_UNAVAILABLE)
    }

    fun cancel() {
        phase = AidenBotImagePlaygroundPresentationPhase.CANCELLED
    }

    fun acceptCopiedCandidate() {
        phase = AidenBotImagePlaygroundPresentationPhase.ACCEPTED
    }

    fun failCandidateCopy() {
        phase = AidenBotImagePlaygroundPresentationPhase.FALLBACK(AidenBotImagePlaygroundFallbackReason.CANDIDATE_COPY_FAILED)
    }

    fun showFallback(reason: AidenBotImagePlaygroundFallbackReason) {
        phase = AidenBotImagePlaygroundPresentationPhase.FALLBACK(reason)
    }
}

class AidenBotImagePlaygroundCandidateStore(
    private val directory: File = File(System.getProperty("java.io.tmpdir"), "AidenBotImageCandidates").apply { mkdirs() }
) {
    companion object {
        const val MAX_SOURCE_BYTES = 32 * 1024 * 1024
        const val MAX_RETAINED_CANDIDATES = 8
        const val STALE_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1000L
    }

    fun copyImmediately(sourceFile: File): File {
        if (!sourceFile.exists() || !sourceFile.isFile || sourceFile.length() <= 0) {
            throw IllegalArgumentException("Invalid source file")
        }
        if (sourceFile.length() > MAX_SOURCE_BYTES) {
            throw IllegalArgumentException("Source file too large")
        }

        pruneOwnedCandidates(retainingAtMost = MAX_RETAINED_CANDIDATES - 1)
        val destination = File(directory, "candidate-${UUID.randomUUID()}.image")
        sourceFile.copyTo(destination, overwrite = true)
        return destination
    }

    fun copyImmediately(data: ByteArray): File {
        if (data.isEmpty() || data.size > MAX_SOURCE_BYTES) {
            throw IllegalArgumentException("Invalid candidate data")
        }
        pruneOwnedCandidates(retainingAtMost = MAX_RETAINED_CANDIDATES - 1)
        val destination = File(directory, "candidate-${UUID.randomUUID()}.image")
        FileOutputStream(destination).use { it.write(data) }
        return destination
    }

    fun removeOwnedCandidate(file: File) {
        if (isOwnedCandidate(file)) {
            file.delete()
        }
    }

    fun removeAllOwnedCandidates() {
        val files = directory.listFiles() ?: return
        for (file in files) {
            if (isOwnedCandidate(file)) {
                file.delete()
            }
        }
    }

    fun pruneOwnedCandidates(
        now: Long = System.currentTimeMillis(),
        retainingAtMost: Int = MAX_RETAINED_CANDIDATES
    ) {
        val files = directory.listFiles { file -> isOwnedCandidate(file) } ?: return
        val sorted = files.sortedByDescending { it.lastModified() }
        for (index in sorted.indices) {
            val file = sorted[index]
            if (index >= retainingAtMost || (now - file.lastModified()) > STALE_CANDIDATE_AGE_MS) {
                file.delete()
            }
        }
    }

    private fun isOwnedCandidate(file: File): Boolean {
        return file.parentFile?.absolutePath == directory.absolutePath &&
                file.name.startsWith("candidate-") &&
                file.name.endsWith(".image")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotImagePlaygroundSheet(
    botName: String,
    botPurpose: String = "",
    onDismiss: () -> Unit,
    onImageSelected: (ByteArray) -> Unit
) {
    val palette = AidenTheme.palette
    var prompt by remember { mutableStateOf(if (botPurpose.isNotEmpty()) botPurpose else "A friendly AI assistant avatar named $botName") }
    var presentationState = remember { AidenBotImagePlaygroundPresentationState() }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(24.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            Icon(
                imageVector = Icons.Default.AutoAwesome,
                contentDescription = null,
                tint = palette.accent,
                modifier = Modifier.size(28.dp)
            )
            Spacer(modifier = Modifier.width(12.dp))
            Text(
                text = "Avatar Studio",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                color = palette.foreground,
                modifier = Modifier.weight(1f)
            )
            IconButton(onClick = onDismiss) {
                Icon(Icons.Default.Close, contentDescription = "Close", tint = palette.foreground)
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Fallback explanation card for Android platform
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = palette.raised),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Info, contentDescription = null, tint = palette.secondary, modifier = Modifier.size(20.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Image Generation",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        color = palette.foreground
                    )
                }
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Bot photos generated on macOS can be synchronized to Android. You can also customize your Bot with the built-in Semantic Avatar studio.",
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.secondary
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        OutlinedTextField(
            value = prompt,
            onValueChange = { prompt = it },
            label = { Text("Avatar Description") },
            placeholder = { Text("Describe the appearance of your bot...") },
            minLines = 3,
            maxLines = 5,
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(24.dp))

        Button(
            onClick = onDismiss,
            colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Done", color = Color.White, fontWeight = FontWeight.Bold)
        }
    }
}
