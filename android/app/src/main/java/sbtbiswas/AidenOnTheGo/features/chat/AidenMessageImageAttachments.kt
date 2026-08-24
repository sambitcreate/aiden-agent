package sbtbiswas.AidenOnTheGo.features.chat

import android.content.ContentValues
import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import android.widget.Toast
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.zIndex
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentImageValidation
import sbtbiswas.AidenOnTheGo.models.AidenAttachmentKind
import sbtbiswas.AidenOnTheGo.models.AidenChatRole
import sbtbiswas.AidenOnTheGo.models.AidenMessageAttachment
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.security.MessageDigest
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

internal object AidenInlineCardDeckLayout {
    const val EDGE_RESISTANCE = 0.22f
    const val SELECTED_CARD_DRAG_MULTIPLIER = 0.88f

    fun isVisible(index: Int, selection: Int, count: Int): Boolean =
        count > 1 && index in 0 until count && selection in 0 until count && abs(index - selection) <= 1

    fun resistedTranslation(current: Int, count: Int, translation: Float): Float {
        if (count <= 1) return 0f
        val pastLeading = current <= 0 && translation > 0
        val pastTrailing = current >= count - 1 && translation < 0
        return if (pastLeading || pastTrailing) translation * EDGE_RESISTANCE else translation
    }

    fun dragProgress(translation: Float, width: Float): Float =
        if (width <= 0f) 0f else (-translation / width).coerceIn(-1f, 1f)

    fun selectedCardOffset(translation: Float): Float = translation * SELECTED_CARD_DRAG_MULTIPLIER

    fun preferredBackgroundIndex(selection: Int, count: Int, translation: Float): Int? {
        if (count <= 1 || selection !in 0 until count) return null
        val preferred = if (translation > 0) selection - 1 else selection + 1
        if (preferred in 0 until count) return preferred
        val fallback = if (translation > 0) selection + 1 else selection - 1
        return fallback.takeIf { it in 0 until count }
    }

    fun resolvedSelection(
        current: Int,
        count: Int,
        translation: Float,
        predictedTranslation: Float
    ): Int {
        if (count <= 1) return 0
        val effective = if (abs(predictedTranslation) > abs(translation)) predictedTranslation else translation
        if (abs(translation) < 44f && abs(effective) < 80f) return current.coerceIn(0, count - 1)
        return (current + if (effective < 0) 1 else -1).coerceIn(0, count - 1)
    }
}

internal object AidenAttachmentGalleryWindow {
    fun contains(index: Int, selectedIndex: Int, count: Int): Boolean =
        count > 0 && index in 0 until count && selectedIndex in 0 until count &&
            abs(index - selectedIndex) <= 1
}

internal enum class AidenMessageMediaEdge {
    LEADING, TRAILING;

    companion object {
        fun forRole(role: AidenChatRole) = if (role == AidenChatRole.USER) TRAILING else LEADING
    }
}

internal fun aidenEligibleImageAttachments(
    attachments: List<AidenMessageAttachment>
): List<AidenMessageAttachment> {
    val counts = attachments.groupingBy { it.id }.eachCount()
    return attachments.filter {
        it.kind == AidenAttachmentKind.IMAGE &&
            (it.mimeType == "image/jpeg" || it.mimeType == "image/png") &&
            it.size in 1..AidenAttachmentImageValidation.MAXIMUM_BYTES &&
            counts[it.id] == 1
    }.take(20)
}

@Composable
internal fun AidenMessageImageAttachments(
    attachments: List<AidenMessageAttachment>,
    edge: AidenMessageMediaEdge,
    loadData: suspend (AidenMessageAttachment) -> ByteArray?
) {
    if (attachments.isEmpty()) return
    var galleryStart by remember { mutableStateOf<Int?>(null) }
    var selection by rememberSaveable(attachments.map { it.id }) { mutableIntStateOf(0) }
    selection = selection.coerceIn(0, attachments.lastIndex)

    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = if (edge == AidenMessageMediaEdge.TRAILING) Alignment.CenterEnd else Alignment.CenterStart
    ) {
        if (attachments.size == 1) {
            AidenAttachmentImage(
                attachment = attachments.first(),
                maximumPixelSize = 960,
                loadData = loadData,
                modifier = Modifier
                    .widthIn(max = 360.dp)
                    .fillMaxWidth()
                    .aspectRatio(1f)
                    .clickable { galleryStart = 0 },
                alignment = if (edge == AidenMessageMediaEdge.TRAILING) Alignment.CenterEnd else Alignment.CenterStart,
                imageCornerRadius = 16.dp
            )
        } else {
            AidenInlineImageCardDeck(
                attachments = attachments,
                edge = edge,
                selection = selection,
                onSelectionChange = { selection = it },
                onOpen = { galleryStart = selection },
                loadData = loadData
            )
        }
    }

    galleryStart?.let { start ->
        AidenAttachmentGallery(
            attachments = attachments,
            initialPage = start,
            loadData = loadData,
            onDismiss = { galleryStart = null }
        )
    }
}

@Composable
private fun AidenInlineImageCardDeck(
    attachments: List<AidenMessageAttachment>,
    edge: AidenMessageMediaEdge,
    selection: Int,
    onSelectionChange: (Int) -> Unit,
    onOpen: () -> Unit,
    loadData: suspend (AidenMessageAttachment) -> ByteArray?
) {
    var rawDrag by remember { mutableFloatStateOf(0f) }
    var dragging by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val reduceMotion = remember {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }.getOrDefault(false)
    }
    val settledDrag by animateFloatAsState(
        targetValue = if (dragging && !reduceMotion) rawDrag else 0f,
        animationSpec = AidenMotion.spatialExpressiveSpring(),
        label = "image_deck_settle"
    )
    val density = LocalDensity.current
    val dragState = rememberDraggableState { delta ->
        rawDrag = AidenInlineCardDeckLayout.resistedTranslation(selection, attachments.size, rawDrag + delta)
    }

    BoxWithConstraints(
        modifier = Modifier
            .widthIn(max = 360.dp)
            .fillMaxWidth()
            .aspectRatio(1f)
            .testTag("aiden_image_deck")
            .semantics {
                role = Role.Button
                contentDescription = "${attachments.size} image attachments"
                stateDescription = "Photo ${selection + 1} of ${attachments.size}"
                onClick { onOpen(); true }
                customActions = listOf(
                    CustomAccessibilityAction("Next photo") {
                        val next = (selection + 1).coerceAtMost(attachments.lastIndex)
                        onSelectionChange(next)
                        true
                    },
                    CustomAccessibilityAction("Previous photo") {
                        val previous = (selection - 1).coerceAtLeast(0)
                        onSelectionChange(previous)
                        true
                    }
                )
            }
            .draggable(
                state = dragState,
                orientation = Orientation.Horizontal,
                onDragStarted = { dragging = true },
                onDragStopped = { velocity ->
                    val predicted = rawDrag + velocity * 0.12f
                    onSelectionChange(
                        AidenInlineCardDeckLayout.resolvedSelection(
                            current = selection,
                            count = attachments.size,
                            translation = with(density) { rawDrag.toDp().value },
                            predictedTranslation = with(density) { predicted.toDp().value }
                        )
                    )
                    rawDrag = 0f
                    dragging = false
                }
            )
            .clickable { onOpen() }
            .padding(horizontal = 27.dp, vertical = 18.dp),
        contentAlignment = if (edge == AidenMessageMediaEdge.TRAILING) Alignment.CenterEnd else Alignment.CenterStart
    ) {
        val deckWidthPx = with(density) { maxWidth.toPx() }
        val dragProgress = AidenInlineCardDeckLayout.dragProgress(settledDrag, deckWidthPx)
        val preferredBackground = AidenInlineCardDeckLayout.preferredBackgroundIndex(
            selection, attachments.size, settledDrag
        )
        attachments.forEachIndexed { index, attachment ->
            if (AidenInlineCardDeckLayout.isVisible(index, selection, attachments.size)) {
                val selected = index == selection
                val backgroundRotation = if (edge == AidenMessageMediaEdge.TRAILING) -1.8f else 1.8f
                AidenAttachmentImage(
                    attachment = attachment,
                    maximumPixelSize = 960,
                    loadData = loadData,
                    alignment = if (edge == AidenMessageMediaEdge.TRAILING) Alignment.CenterEnd else Alignment.CenterStart,
                    modifier = Modifier
                        .fillMaxSize()
                        .then(
                            if (selected) Modifier.shadow(8.dp, RoundedCornerShape(18.dp), clip = false)
                            else Modifier
                        )
                        .graphicsLayer {
                            transformOrigin = if (edge == AidenMessageMediaEdge.TRAILING) {
                                TransformOrigin(1f, 0.5f)
                            } else {
                                TransformOrigin(0f, 0.5f)
                            }
                            scaleX = if (selected) 1f else 0.94f
                            scaleY = if (selected) 1f else 0.94f
                            rotationZ = if (selected && !reduceMotion) dragProgress * 2.4f else if (selected) 0f else backgroundRotation
                            translationX = if (selected) {
                                if (reduceMotion) 0f else AidenInlineCardDeckLayout.selectedCardOffset(settledDrag)
                            } else 0f
                            translationY = if (selected) 0f else with(density) { 7.dp.toPx() }
                        }
                        .clip(RoundedCornerShape(18.dp))
                        .zIndex(if (selected) 2f else if (index == preferredBackground) 1f else 0f)
                    ,
                    imageCornerRadius = 18.dp
                )
            }
        }
    }
}

@Composable
private fun AidenAttachmentImage(
    attachment: AidenMessageAttachment,
    maximumPixelSize: Int,
    loadData: suspend (AidenMessageAttachment) -> ByteArray?,
    modifier: Modifier = Modifier,
    alignment: Alignment = Alignment.Center,
    imageCornerRadius: Dp = 0.dp
) {
    var attempt by remember { mutableIntStateOf(0) }
    var bitmap by remember(attachment.id, maximumPixelSize) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(attachment.id, maximumPixelSize) { mutableStateOf(false) }

    LaunchedEffect(attachment.id, maximumPixelSize, attempt) {
        bitmap = null
        failed = false
        val bytes = loadData(attachment)
        val decoded = bytes?.let { AidenAttachmentBitmapCache.decode(it, maximumPixelSize) }
        if (decoded == null) failed = true else bitmap = decoded
    }

    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        when {
            bitmap != null -> BoxWithConstraints(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = alignment
            ) {
                val imageRatio = bitmap!!.width.toFloat() / bitmap!!.height.toFloat()
                val viewportRatio = maxWidth.value / maxHeight.value
                val fitted = if (imageRatio >= viewportRatio) {
                    Modifier.fillMaxWidth().aspectRatio(imageRatio)
                } else {
                    Modifier.fillMaxHeight().aspectRatio(imageRatio)
                }
                Image(
                    bitmap = bitmap!!.asImageBitmap(),
                    contentDescription = attachment.name,
                    contentScale = ContentScale.Fit,
                    modifier = fitted.clip(RoundedCornerShape(imageCornerRadius))
                )
            }
            failed -> Column(
                modifier = Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.surfaceContainerLow)
                    .clickable { attempt++ },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Icon(Icons.Default.Refresh, contentDescription = null)
                Spacer(Modifier.height(6.dp))
                Text("Open to retry", style = MaterialTheme.typography.labelMedium)
            }
            else -> CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
        }
    }
}

@Composable
private fun AidenAttachmentGallery(
    attachments: List<AidenMessageAttachment>,
    initialPage: Int,
    loadData: suspend (AidenMessageAttachment) -> ByteArray?,
    onDismiss: () -> Unit
) {
    val pages = remember(attachments) { attachments.take(20) }
    val pagerState = rememberPagerState(initialPage = initialPage.coerceIn(0, pages.lastIndex)) {
        pages.size
    }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var saveMenu by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var pendingLegacySave by remember { mutableStateOf<List<AidenMessageAttachment>?>(null) }

    fun performSave(requested: List<AidenMessageAttachment>) {
        if (saving || requested.isEmpty()) return
        saving = true
        scope.launch {
            val loaded = requested.map { attachment ->
                val bytes = loadData(attachment) ?: return@map null
                attachment to bytes
            }
            val count = if (loaded.any { it == null }) null else {
                saveImagesToPhotos(context, loaded.filterNotNull())
            }
            saving = false
            Toast.makeText(
                context,
                when {
                    count == null -> "Images couldn't be saved"
                    count == 1 -> "Saved to Photos"
                    else -> "Saved $count images to Photos"
                },
                Toast.LENGTH_SHORT
            ).show()
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val requested = pendingLegacySave
        pendingLegacySave = null
        if (granted && requested != null) performSave(requested)
        else if (!granted) Toast.makeText(context, "Photos access is needed to save images", Toast.LENGTH_SHORT).show()
    }

    fun requestSave(requested: List<AidenMessageAttachment>) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingLegacySave = requested
            permissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        } else {
            performSave(requested)
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black)
                .testTag("aiden_image_gallery")
                .systemBarsPadding()
        ) {
            HorizontalPager(
                state = pagerState,
                beyondViewportPageCount = 1,
                modifier = Modifier.fillMaxSize()
            ) { page ->
                if (AidenAttachmentGalleryWindow.contains(page, pagerState.currentPage, pages.size)) {
                    AidenAttachmentImage(
                        attachment = pages[page],
                        maximumPixelSize = 2_560,
                        loadData = loadData,
                        modifier = Modifier.fillMaxSize()
                    )
                }
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopCenter)
                    .background(Color.Black.copy(alpha = 0.72f))
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Default.Close, contentDescription = "Close image viewer", tint = Color.White)
                }
                Text(
                    text = if (pages.size == 1) pages.first().name else "${pagerState.currentPage + 1} of ${pages.size}",
                    color = Color.White,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                    maxLines = 1
                )
                Box {
                    IconButton(onClick = { saveMenu = true }, enabled = !saving) {
                        if (saving) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = Color.White)
                        else Icon(Icons.Default.MoreVert, contentDescription = "Save images", tint = Color.White)
                    }
                    DropdownMenu(expanded = saveMenu, onDismissRequest = { saveMenu = false }) {
                        DropdownMenuItem(
                            text = { Text("Save Image") },
                            leadingIcon = { Icon(Icons.Default.Download, contentDescription = null) },
                            onClick = {
                                saveMenu = false
                                requestSave(listOf(pages[pagerState.currentPage]))
                            }
                        )
                        if (pages.size > 1) {
                            DropdownMenuItem(
                                text = { Text("Save All Images") },
                                leadingIcon = { Icon(Icons.Default.Download, contentDescription = null) },
                                onClick = {
                                    saveMenu = false
                                    requestSave(pages)
                                }
                            )
                        }
                    }
                }
            }

            if (pages.size > 1) {
                Row(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 18.dp)
                        .background(Color.Black.copy(alpha = 0.48f), CircleShape)
                        .padding(horizontal = 10.dp, vertical = 7.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    pages.indices.forEach { index ->
                        Box(
                            Modifier
                                .size(if (index == pagerState.currentPage) 7.dp else 5.dp)
                                .background(
                                    if (index == pagerState.currentPage) Color.White else Color.White.copy(alpha = 0.42f),
                                    CircleShape
                                )
                        )
                    }
                }
            }
        }
    }
}

private object AidenAttachmentBitmapCache {
    private const val MAX_ENTRIES = 24
    private const val MAX_COST = 32 * 1_024 * 1_024L
    private val cache = LinkedHashMap<String, Bitmap>(MAX_ENTRIES, 0.75f, true)
    private var totalCost = 0L

    suspend fun decode(data: ByteArray, maximumPixelSize: Int): Bitmap? = withContext(Dispatchers.Default) {
        val key = aidenAttachmentThumbnailCacheKey(data, maximumPixelSize)
        synchronized(this@AidenAttachmentBitmapCache) {
            cache[key]?.let { return@withContext it }
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null
        val sample = kotlin.math.ceil(
            max(bounds.outWidth, bounds.outHeight).toDouble() / maximumPixelSize.toDouble()
        ).toInt().coerceAtLeast(1)
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        val decoded = BitmapFactory.decodeByteArray(data, 0, data.size, options) ?: return@withContext null
        val sourceEdge = max(decoded.width, decoded.height)
        val bitmap = if (sourceEdge > maximumPixelSize) {
            val scale = maximumPixelSize.toFloat() / sourceEdge.toFloat()
            Bitmap.createScaledBitmap(
                decoded,
                (decoded.width * scale).roundToInt().coerceAtLeast(1),
                (decoded.height * scale).roundToInt().coerceAtLeast(1),
                true
            ).also { if (it !== decoded) decoded.recycle() }
        } else decoded
        synchronized(this@AidenAttachmentBitmapCache) {
            cache.put(key, bitmap)?.let { totalCost -= it.allocationByteCount.toLong() }
            totalCost += bitmap.allocationByteCount.toLong()
            while (cache.size > MAX_ENTRIES || totalCost > MAX_COST) {
                val eldest = cache.entries.firstOrNull() ?: break
                cache.remove(eldest.key)
                totalCost -= eldest.value.allocationByteCount.toLong()
            }
        }
        bitmap
    }
}

internal fun aidenAttachmentThumbnailCacheKey(data: ByteArray, maximumPixelSize: Int): String =
    "$maximumPixelSize:" + MessageDigest.getInstance("SHA-256")
        .digest(data)
        .joinToString("") { "%02x".format(it) }

private suspend fun saveImagesToPhotos(
    context: Context,
    requested: List<Pair<AidenMessageAttachment, ByteArray>>
): Int? = withContext(Dispatchers.IO) {
    val resolver = context.contentResolver
    val created = mutableListOf<android.net.Uri>()
    try {
        requested.forEach { (attachment, data) ->
            val validated = AidenAttachmentImageValidation.validatedData(data, attachment.mimeType, attachment.size)
                ?: error("Invalid image")
            val extension = if (attachment.mimeType == "image/png") ".png" else ".jpg"
            val baseName = attachment.name.substringBeforeLast('.').ifBlank { "Aiden image" }
                .replace(Regex("[^A-Za-z0-9 _.-]"), "_")
                .take(120)
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, "$baseName$extension")
                put(MediaStore.Images.Media.MIME_TYPE, attachment.mimeType)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Aiden On The Go")
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
            }
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                ?: error("No media row")
            created += uri
            resolver.openOutputStream(uri)?.use { it.write(validated) } ?: error("No output stream")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val publish = ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }
            created.forEach { resolver.update(it, publish, null, null) }
        }
        created.size
    } catch (_: Exception) {
        created.forEach { resolver.delete(it, null, null) }
        null
    }
}
