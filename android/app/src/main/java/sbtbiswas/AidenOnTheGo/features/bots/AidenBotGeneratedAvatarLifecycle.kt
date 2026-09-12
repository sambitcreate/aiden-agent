package sbtbiswas.AidenOnTheGo.features.bots

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarUpload
import sbtbiswas.AidenOnTheGo.models.AidenBotDetail
import sbtbiswas.AidenOnTheGo.models.AidenBotSemanticAvatar
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenBotCache
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Base64

sealed class AidenBotGeneratedAvatarError(val messageText: String) : Exception(messageText) {
    object SourceTooLarge : AidenBotGeneratedAvatarError("That image is too large. Choose another image.")
    object UnsupportedImage : AidenBotGeneratedAvatarError("That image format can't be used for a Bot photo.")
    object InvalidImage : AidenBotGeneratedAvatarError("Aiden couldn't prepare that image. Choose another image.")
    object Unavailable : AidenBotGeneratedAvatarError("Reconnect to your paired desktop before saving this Bot photo.")
}

enum class AidenBotGeneratedAvatarPhase {
    IDLE, LOADING, NORMALIZING, READY, UPLOADING, REVERTING, FAILED
}

fun aidenBotAvatarMutationFailureIsAmbiguous(error: Throwable): Boolean {
    return error !is AidenBotGeneratedAvatarError.Unavailable
}

object AidenBotGeneratedAvatarNormalizer {
    const val EDGE = 512
    const val MAX_SOURCE_BYTES = 32 * 1024 * 1024
    const val MAXIMUM_SOURCE_BYTES = MAX_SOURCE_BYTES
    const val MAX_OUTPUT_BYTES = 4 * 1024 * 1024
    const val MAXIMUM_OUTPUT_BYTES = MAX_OUTPUT_BYTES
    const val MAX_SOURCE_DIMENSION = 16_384
    const val MAX_SOURCE_PIXELS = 40_000_000

    fun normalize(data: ByteArray): ByteArray {
        if (data.isEmpty() || data.size > MAX_SOURCE_BYTES) {
            throw AidenBotGeneratedAvatarError.SourceTooLarge
        }

        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, options)
        val srcWidth = options.outWidth
        val srcHeight = options.outHeight
        val mimeType = options.outMimeType?.lowercase()

        if (srcWidth <= 0 || srcHeight <= 0 ||
            srcWidth > MAX_SOURCE_DIMENSION || srcHeight > MAX_SOURCE_DIMENSION ||
            srcWidth.toLong() * srcHeight.toLong() > MAX_SOURCE_PIXELS ||
            (mimeType != null && mimeType != "image/png" && mimeType != "image/jpeg" && mimeType != "image/webp")
        ) {
            throw AidenBotGeneratedAvatarError.InvalidImage
        }

        val decodeOptions = BitmapFactory.Options().apply {
            inSampleSize = calculateInSampleSize(srcWidth, srcHeight, 2048, 2048)
        }
        val decoded = BitmapFactory.decodeByteArray(data, 0, data.size, decodeOptions)
            ?: throw AidenBotGeneratedAvatarError.InvalidImage

        val outputBitmap = Bitmap.createBitmap(EDGE, EDGE, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(outputBitmap)
        canvas.drawColor(Color.TRANSPARENT)

        val scale = maxOf(EDGE.toFloat() / decoded.width, EDGE.toFloat() / decoded.height)
        val drawWidth = (decoded.width * scale).toInt()
        val drawHeight = (decoded.height * scale).toInt()
        val left = (EDGE - drawWidth) / 2
        val top = (EDGE - drawHeight) / 2

        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        val dstRect = Rect(left, top, left + drawWidth, top + drawHeight)
        canvas.drawBitmap(decoded, null, dstRect, paint)

        val stream = ByteArrayOutputStream()
        outputBitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        val output = stream.toByteArray()

        if (output.size > MAX_OUTPUT_BYTES) {
            throw AidenBotGeneratedAvatarError.InvalidImage
        }
        return output
    }

    private fun calculateInSampleSize(width: Int, height: Int, reqWidth: Int, reqHeight: Int): Int {
        var inSampleSize = 1
        if (height > reqHeight || width > reqWidth) {
            val halfHeight: Int = height / 2
            val halfWidth: Int = width / 2
            while ((halfHeight / inSampleSize) >= reqHeight && (halfWidth / inSampleSize) >= reqWidth) {
                inSampleSize *= 2
            }
        }
        return inSampleSize
    }

    fun representsSameImage(lhs: ByteArray, rhs: ByteArray): Boolean {
        if (lhs.contentEquals(rhs)) return true
        return try {
            val normLhs = normalize(lhs)
            val normRhs = normalize(rhs)
            val hashLhs = MessageDigest.getInstance("SHA-256").digest(normLhs)
            val hashRhs = MessageDigest.getInstance("SHA-256").digest(normRhs)
            hashLhs.contentEquals(hashRhs)
        } catch (_: Exception) {
            false
        }
    }
}

class AidenBotGeneratedAvatarModel(
    private val coordinator: AidenRemoteCoordinator,
    private val botId: String? = null,
    private val botCache: AidenBotCache? = null
) {
    private val _phase = MutableStateFlow(AidenBotGeneratedAvatarPhase.IDLE)
    val phase: StateFlow<AidenBotGeneratedAvatarPhase> = _phase.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private var currentCandidateData: ByteArray? = null

    val hasCandidate: Boolean
        get() = currentCandidateData != null

    fun setCandidate(data: ByteArray) {
        try {
            _phase.value = AidenBotGeneratedAvatarPhase.NORMALIZING
            val normalized = AidenBotGeneratedAvatarNormalizer.normalize(data)
            currentCandidateData = normalized
            _phase.value = AidenBotGeneratedAvatarPhase.READY
            _errorMessage.value = null
        } catch (e: AidenBotGeneratedAvatarError) {
            _phase.value = AidenBotGeneratedAvatarPhase.FAILED
            _errorMessage.value = e.messageText
        } catch (e: Exception) {
            _phase.value = AidenBotGeneratedAvatarPhase.FAILED
            _errorMessage.value = "Failed to process image"
        }
    }

    fun ingestCopiedCandidate(bytes: ByteArray) = setCandidate(bytes)

    suspend fun uploadAvatar(
        botId: String,
        revision: String,
        onSuccess: (AidenBotDetail) -> Unit
    ) = withContext(Dispatchers.IO) {
        val data = currentCandidateData ?: return@withContext
        val client = coordinator.client.value ?: run {
            _phase.value = AidenBotGeneratedAvatarPhase.FAILED
            _errorMessage.value = AidenBotGeneratedAvatarError.Unavailable.messageText
            return@withContext
        }

        _phase.value = AidenBotGeneratedAvatarPhase.UPLOADING
        try {
            val base64Data = Base64.getEncoder().encodeToString(data)
            val upload = AidenBotAvatarUpload(data = base64Data)
            val asset = client.putBotAvatar(botId, revision, upload)
            botCache?.putAvatar(botId, asset.assetRevision, data)
            val updatedBot = client.bot(botId)
            _phase.value = AidenBotGeneratedAvatarPhase.IDLE
            currentCandidateData = null
            onSuccess(updatedBot)
        } catch (e: Exception) {
            _phase.value = AidenBotGeneratedAvatarPhase.FAILED
            _errorMessage.value = e.message ?: "Avatar upload failed"
        }
    }

    suspend fun deleteAvatar(
        botId: String,
        revision: String,
        onSuccess: (AidenBotDetail) -> Unit
    ) = withContext(Dispatchers.IO) {
        val client = coordinator.client.value ?: run {
            _phase.value = AidenBotGeneratedAvatarPhase.FAILED
            _errorMessage.value = AidenBotGeneratedAvatarError.Unavailable.messageText
            return@withContext
        }

        _phase.value = AidenBotGeneratedAvatarPhase.REVERTING
        try {
            val updatedBot = client.deleteBotAvatar(botId, revision)
            _phase.value = AidenBotGeneratedAvatarPhase.IDLE
            onSuccess(updatedBot)
        } catch (e: Exception) {
            _phase.value = AidenBotGeneratedAvatarPhase.FAILED
            _errorMessage.value = e.message ?: "Avatar revert failed"
        }
    }
}

@Composable
fun AidenBotGeneratedAvatarLifecycleView(
    model: AidenBotGeneratedAvatarModel,
    semanticAvatar: AidenBotSemanticAvatar,
    botName: String,
    modifier: Modifier = Modifier
) {
    val phase by model.phase.collectAsState()
    val error by model.errorMessage.collectAsState()

    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        if (phase == AidenBotGeneratedAvatarPhase.UPLOADING || phase == AidenBotGeneratedAvatarPhase.REVERTING) {
            CircularProgressIndicator(modifier = Modifier.size(24.dp))
        }
        if (error != null) {
            Text(
                text = error ?: "",
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}
