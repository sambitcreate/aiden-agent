package sbtbiswas.AidenOnTheGo.features.remote

import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.ExifInterface
import android.graphics.BitmapFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentImageValidation
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentUpload
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64

object AidenAttachmentPreparation {
    const val MAXIMUM_SOURCE_IMAGE_BYTES = 32 * 1_048_576
    const val MAXIMUM_IMAGE_BYTES = 8 * 1_048_576
    const val MAXIMUM_IMAGE_DIMENSION = 16_384
    const val MAXIMUM_IMAGE_PIXELS = 40_000_000L
    const val MAXIMUM_TEXT_BYTES = 400_000
    const val MAXIMUM_TEXT_SCALARS = 100_000

    private val workerMutex = Mutex()

    // Only one selected image conversion runs at a time across chats.
    suspend fun <T> onWorker(block: suspend () -> T): T = workerMutex.withLock {
        withContext(Dispatchers.IO) { block() }
    }

    fun imageUpload(
        data: ByteArray,
        name: String,
        checkCancellation: () -> Unit = {}
    ): AidenAttachmentUpload.Image {
        checkCancellation()
        if (data.isEmpty() || data.size > MAXIMUM_SOURCE_IMAGE_BYTES) {
            throw AidenRemoteContractException.UnsafePayloadField("image exceeds size limit")
        }
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, options)
        val pixelWidth = options.outWidth
        val pixelHeight = options.outHeight
        if (pixelWidth <= 0 || pixelHeight <= 0) {
            throw AidenRemoteContractException.UnsafePayloadField("invalid image")
        }
        if (pixelWidth > MAXIMUM_IMAGE_DIMENSION || pixelHeight > MAXIMUM_IMAGE_DIMENSION ||
            pixelWidth.toLong() * pixelHeight.toLong() > MAXIMUM_IMAGE_PIXELS
        ) {
            throw AidenRemoteContractException.UnsafePayloadField("image exceeds dimension limit")
        }

        if (data.size <= MAXIMUM_IMAGE_BYTES) {
            if (AidenAttachmentImageValidation.validatedData(data, "image/png", data.size) != null) {
                return AidenAttachmentUpload.Image(
                    name = safeImageName(name, "png"),
                    mimeType = "image/png",
                    data = Base64.getEncoder().encodeToString(data)
                )
            }
            if (AidenAttachmentImageValidation.validatedData(data, "image/jpeg", data.size) != null) {
                return AidenAttachmentUpload.Image(
                    name = safeImageName(name, "jpg"),
                    mimeType = "image/jpeg",
                    data = Base64.getEncoder().encodeToString(data)
                )
            }
        }

        checkCancellation()
        val decodeOptions = BitmapFactory.Options().apply {
            // Largest conversion candidate is 3072 px. Keep enough pixels for that
            // candidate, then scale exactly; original PNG/JPEG passthrough stays intact.
            var sample = 1
            while (maxOf(pixelWidth, pixelHeight) / (sample * 2) >= 3072) sample *= 2
            inSampleSize = sample
        }
        val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size, decodeOptions)
            ?: throw AidenRemoteContractException.UnsafePayloadField("invalid image")
        try {
            val preserveAlpha = bitmap.hasAlpha()
            val orientation = runCatching {
                data.inputStream().use {
                    ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                }
            }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
            val edges = listOf(3072.0f, 2048.0f, 1536.0f, 1024.0f)
            for (edge in edges) {
                checkCancellation()
                val scaledBitmap = scaleBitmap(bitmap, edge)
                try {
                    val orientedBitmap = orientBitmap(scaledBitmap, orientation)
                    try {
                        val qualities = if (preserveAlpha) listOf(100) else listOf(86, 72, 58)
                        val format = if (preserveAlpha) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
                        for (quality in qualities) {
                            checkCancellation()
                            val stream = ByteArrayOutputStream()
                            if (!orientedBitmap.compress(format, quality, stream)) continue
                            checkCancellation()
                            val encoded = stream.toByteArray()
                            if (encoded.size <= MAXIMUM_IMAGE_BYTES) {
                                val ext = if (preserveAlpha) "png" else "jpg"
                                return AidenAttachmentUpload.Image(
                                    name = safeImageName(name, ext),
                                    mimeType = if (preserveAlpha) "image/png" else "image/jpeg",
                                    data = Base64.getEncoder().encodeToString(encoded)
                                )
                            }
                        }
                    } finally {
                        if (orientedBitmap !== scaledBitmap) orientedBitmap.recycle()
                    }
                } finally {
                    if (scaledBitmap !== bitmap) scaledBitmap.recycle()
                }
            }
            throw AidenRemoteContractException.UnsafePayloadField("image too large to attach")
        } finally {
            bitmap.recycle()
        }
    }

    private fun orientBitmap(bitmap: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
            else -> return bitmap
        }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    fun textUpload(data: ByteArray, name: String, mimeType: String): AidenAttachmentUpload.Text {
        if (data.size > MAXIMUM_TEXT_BYTES) {
            throw AidenRemoteContractException.UnsafePayloadField("text exceeds size limit")
        }
        val text = try {
            String(data, Charsets.UTF_8)
        } catch (_: Exception) {
            throw AidenRemoteContractException.UnsafePayloadField("invalid text encoding")
        }
        if (text.codePointCount(0, text.length) > MAXIMUM_TEXT_SCALARS) {
            throw AidenRemoteContractException.UnsafePayloadField("text exceeds scalar limit")
        }
        val canonicalMimeType = allowedTextMimeType(mimeType, name)
        return AidenAttachmentUpload.Text(
            name = safeDisplayName(name),
            mimeType = canonicalMimeType,
            text = text
        )
    }

    fun fileUpload(file: File, preferredName: String? = null, forceImage: Boolean = false): AidenAttachmentUpload {
        val displayName = preferredName ?: file.name
        val isImage = forceImage || isImageFile(file.name)
        val readLimit = if (isImage) MAXIMUM_SOURCE_IMAGE_BYTES else MAXIMUM_TEXT_BYTES
        val length = file.length()
        if (length > readLimit && isImage) {
            throw AidenRemoteContractException.UnsafePayloadField("file exceeds size limit")
        }
        val bytes = file.readBytes()
        if (isImage) {
            if (bytes.size > readLimit) {
                throw AidenRemoteContractException.UnsafePayloadField("file exceeds size limit")
            }
            return imageUpload(bytes, displayName)
        }
        val mimeType = allowedTextMimeType("text/plain", displayName)
        val readWasTruncated = bytes.size > MAXIMUM_TEXT_BYTES
        val prefix = if (readWasTruncated) bytes.copyOfRange(0, MAXIMUM_TEXT_BYTES) else bytes
        val decoded = String(prefix, Charsets.UTF_8)
        val suffix = "\n… [truncated]"
        val scalarWasTruncated = decoded.codePointCount(0, decoded.length) > MAXIMUM_TEXT_SCALARS
        val shouldTruncate = readWasTruncated || scalarWasTruncated
        val bounded = if (shouldTruncate) {
            decoded.take(MAXIMUM_TEXT_SCALARS - suffix.length) + suffix
        } else {
            decoded
        }
        return AidenAttachmentUpload.Text(
            name = safeDisplayName(displayName),
            mimeType = mimeType,
            text = bounded
        )
    }

    private fun scaleBitmap(bitmap: Bitmap, maxEdge: Float): Bitmap {
        val width = bitmap.width
        val height = bitmap.height
        val sourceEdge = maxOf(width, height)
        if (sourceEdge <= maxEdge) return bitmap
        val scale = maxEdge / sourceEdge.toFloat()
        val targetWidth = maxOf(1, Math.floor((width * scale).toDouble()).toInt())
        val targetHeight = maxOf(1, Math.floor((height * scale).toDouble()).toInt())
        return Bitmap.createScaledBitmap(bitmap, targetWidth, targetHeight, true)
    }

    private fun isImageFile(name: String): Boolean {
        val ext = File(name).extension.lowercase()
        return ext in setOf("png", "jpg", "jpeg", "heic", "heif", "webp")
    }

    private fun safeImageName(value: String, ext: String): String {
        val base = File(safeDisplayName(value)).nameWithoutExtension
        val safeBase = if (base.isEmpty()) "Photo" else base
        return safeDisplayName("$safeBase.$ext")
    }

    private fun safeDisplayName(value: String): String {
        val filtered = value.filter { c -> c.code > 0x1f && c.code != 0x7f && c != '/' && c != '\\' }
        val bounded = filtered.take(255).trim()
        return if (bounded.isEmpty()) "Attachment" else bounded
    }

    private fun allowedTextMimeType(value: String, name: String): String {
        val normalized = value.lowercase()
        val allowed = setOf(
            "text/plain", "text/markdown", "text/csv", "application/json", "application/xml",
            "application/yaml", "application/x-yaml", "application/javascript", "application/typescript"
        )
        if (allowed.contains(normalized)) return normalized
        val ext = File(name).extension.lowercase()
        return when (ext) {
            "md", "markdown" -> "text/markdown"
            "csv" -> "text/csv"
            "json" -> "application/json"
            "xml" -> "application/xml"
            "yaml", "yml" -> "application/yaml"
            "js", "jsx" -> "application/javascript"
            "ts", "tsx" -> "application/typescript"
            "txt", "swift", "m", "mm", "h", "c", "cc", "cpp", "py", "rb", "go", "rs", "java", "kt", "sh" -> "text/plain"
            else -> throw AidenRemoteContractException.UnsafePayloadField("unsupported text type")
        }
    }
}
