package sbtbiswas.AidenOnTheGo.features.remote

import androidx.compose.ui.draw.drawWithCache
import androidx.compose.foundation.layout.Spacer
import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.core.app.ActivityCompat
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.settings.AidenSettingsDefaults
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import androidx.compose.foundation.interaction.MutableInteractionSource
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress
import java.util.concurrent.Executors

/** Whether the scanner can show the camera, ask for it, or must send the user to Settings. */
enum class AidenCameraAccess { GRANTED, REQUESTABLE, BLOCKED }

/**
 * Camera access from the permission state. Once Aiden has asked and Android no longer
 * offers a rationale, the request dialog will not appear again ("Don't allow" twice, or
 * a policy block), so the only way forward is the app's system settings page.
 */
internal fun aidenCameraAccess(granted: Boolean, askedBefore: Boolean, showRationale: Boolean): AidenCameraAccess = when {
    granted -> AidenCameraAccess.GRANTED
    askedBefore && !showRationale -> AidenCameraAccess.BLOCKED
    else -> AidenCameraAccess.REQUESTABLE
}

private fun Context.findActivity(): Activity? =
    generateSequence(this) { (it as? ContextWrapper)?.baseContext }.filterIsInstance<Activity>().firstOrNull()

/**
 * CameraX and ML Kit QR scanner with a viewfinder overlay. The viewfinder is roughly
 * square, capped to a share of the screen height so the manual fallback stays in reach.
 * Permission is re-checked whenever the app resumes, so returning from system settings
 * shows the camera immediately.
 */
@Composable
fun AidenQRCodeScanner(
    onCodeScanned: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val palette = AidenTheme.palette
    fun isGranted() = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    fun showsRationale() = context.findActivity()?.let {
        ActivityCompat.shouldShowRequestPermissionRationale(it, Manifest.permission.CAMERA)
    } ?: false
    var granted by remember { mutableStateOf(isGranted()) }
    var showRationale by remember { mutableStateOf(showsRationale()) }
    var askedBefore by rememberSaveable { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        granted = isGranted()
        showRationale = showsRationale()
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { result ->
        askedBefore = true
        granted = result
        showRationale = showsRationale()
    }

    when (aidenCameraAccess(granted, askedBefore, showRationale)) {
        AidenCameraAccess.GRANTED -> BoxWithConstraints(modifier.fillMaxWidth()) {
            val screenHeight = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.height.toDp() }
            val side = minOf(maxWidth, screenHeight * 0.45f).coerceAtLeast(200.dp)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(side)
                    .clip(MaterialTheme.shapes.large)
                    .background(Color.Black)
            ) {
                CameraPreview(onCodeScanned = onCodeScanned)
                ScannerViewfinderOverlay(accentColor = palette.accent)
            }
        }
        AidenCameraAccess.REQUESTABLE -> AidenCameraPermissionPrompt(
            onEnableCamera = { permissionLauncher.launch(Manifest.permission.CAMERA) },
            modifier = modifier
        )
        AidenCameraAccess.BLOCKED -> AidenCameraPermissionPrompt(
            onEnableCamera = {
                context.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            },
            blocked = true,
            modifier = modifier
        )
    }
}

/**
 * Camera permission explainer. [onEnableCamera] runs exactly once per tap; when [blocked]
 * the action opens Aiden's system settings page instead of the permission dialog.
 */
@Composable
internal fun AidenCameraPermissionPrompt(
    onEnableCamera: () -> Unit,
    modifier: Modifier = Modifier,
    blocked: Boolean = false
) {
    val palette = AidenTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Surface(
        color = AidenSettingsDefaults.groupColor,
        shape = MaterialTheme.shapes.large,
        modifier = modifier.fillMaxWidth()
    ) {
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Icon(
                imageVector = Icons.Default.QrCodeScanner,
                contentDescription = null,
                tint = palette.accent,
                modifier = Modifier.size(48.dp)
            )
            Text(
                text = stringResource(R.string.camera_prompt_title),
                style = MaterialTheme.typography.titleMedium,
                color = palette.foreground,
                textAlign = TextAlign.Center
            )
            Text(
                text = stringResource(if (blocked) R.string.camera_prompt_blocked else R.string.camera_prompt_body),
                style = MaterialTheme.typography.bodyMedium,
                color = palette.secondary,
                textAlign = TextAlign.Center
            )
            Spacer(modifier = Modifier.height(8.dp))
            Button(
                onClick = onEnableCamera,
                interactionSource = interaction,
                colors = ButtonDefaults.buttonColors(containerColor = palette.accent, contentColor = palette.onAccent),
                shape = AidenShape.Button,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = AidenUi.MinimumTouchTarget)
                    .tactilePress(interaction)
            ) {
                Icon(
                    if (blocked) Icons.Default.Settings else Icons.Default.Videocam,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    stringResource(if (blocked) R.string.camera_open_settings else R.string.camera_enable),
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
    }
}

@OptIn(ExperimentalGetImage::class)
@Composable
private fun CameraPreview(
    onCodeScanned: (String) -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var deliveredCode by remember { mutableStateOf(false) }

    val cameraProviderFuture = remember { ProcessCameraProvider.getInstance(context) }
    val scanner = remember {
        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
        BarcodeScanning.getClient(options)
    }

    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }
    DisposableEffect(Unit) {
        onDispose {
            // Release the camera and the analyzer thread when the scanner leaves composition.
            if (cameraProviderFuture.isDone) runCatching { cameraProviderFuture.get().unbindAll() }
            scanner.close()
            cameraExecutor.shutdown()
        }
    }

    AndroidView(
        factory = { ctx ->
            val previewView = PreviewView(ctx).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
            }

            cameraProviderFuture.addListener({
                val cameraProvider = cameraProviderFuture.get()
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }

                val imageAnalysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()

                imageAnalysis.setAnalyzer(cameraExecutor) { imageProxy ->
                    val mediaImage = imageProxy.image
                    if (mediaImage != null && !deliveredCode) {
                        val image = InputImage.fromMediaImage(
                            mediaImage,
                            imageProxy.imageInfo.rotationDegrees
                        )
                        scanner.process(image)
                            .addOnSuccessListener { barcodes ->
                                val qr = barcodes.firstOrNull()?.rawValue
                                if (qr != null && !deliveredCode) {
                                    deliveredCode = true
                                    onCodeScanned(qr)
                                }
                            }
                            .addOnCompleteListener {
                                imageProxy.close()
                            }
                    } else {
                        imageProxy.close()
                    }
                }

                try {
                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        imageAnalysis
                    )
                } catch (_: Exception) {}
            }, ContextCompat.getMainExecutor(ctx))

            previewView
        },
        modifier = Modifier.fillMaxSize()
    )
}

@Composable
private fun ScannerViewfinderOverlay(
    accentColor: Color
) {
    val reduceMotion = aidenReduceMotion()
    val laserYRatio = if (reduceMotion) {
        remember { mutableFloatStateOf(AidenScannerLaserRestingRatio) }
    } else {
        rememberInfiniteTransition(label = "scanner_laser").animateFloat(
            initialValue = 0.1f,
            targetValue = 0.9f,
            animationSpec = infiniteRepeatable(
                animation = tween(2000, easing = EaseInOutCubic),
                repeatMode = RepeatMode.Reverse
            ),
            label = "laser_y"
        )
    }

    Spacer(
        modifier = Modifier
            .fillMaxSize()
            .drawWithCache {
                val width = size.width
                val height = size.height
                val boxSize = (minOf(width, height) * 0.7f).coerceAtMost(240.dp.toPx())
                val left = (width - boxSize) / 2f
                val top = (height - boxSize) / 2f
                val right = left + boxSize
                val bottom = top + boxSize
                val cutoutRadius = CornerRadius(16.dp.toPx())
                val borderStroke = Stroke(width = 2.dp.toPx())
                // Rounded corner brackets that follow the 16.dp cutout radius.
                val bracketStroke = Stroke(width = 4.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
                val radius = 16.dp.toPx()
                val length = 28.dp.toPx()
                val brackets = listOf(
                    cornerBracketPath(Offset(left, top), 1f, 1f, radius, length),
                    cornerBracketPath(Offset(right, top), -1f, 1f, radius, length),
                    cornerBracketPath(Offset(right, bottom), -1f, -1f, radius, length),
                    cornerBracketPath(Offset(left, bottom), 1f, -1f, radius, length)
                )
                val laserBrush = Brush.horizontalGradient(
                    colors = listOf(Color.Transparent, accentColor, Color.Transparent),
                    startX = left,
                    endX = right
                )
                val laserSize = Size(boxSize - 16.dp.toPx(), 2.dp.toPx())
                val laserLeft = left + 8.dp.toPx()

                onDrawBehind {
                    // Dark dimming overlay around targeting box
                    drawRect(color = Color.Black.copy(alpha = 0.55f), size = size)

                    // Clear center targeting window
                    drawRoundRect(
                        color = Color.Transparent,
                        topLeft = Offset(left, top),
                        size = Size(boxSize, boxSize),
                        cornerRadius = cutoutRadius,
                        blendMode = BlendMode.Clear
                    )

                    // Viewfinder bounding box border
                    drawRoundRect(
                        color = Color.White.copy(alpha = 0.3f),
                        topLeft = Offset(left, top),
                        size = Size(boxSize, boxSize),
                        cornerRadius = cutoutRadius,
                        style = borderStroke
                    )

                    brackets.forEach { drawPath(path = it, color = accentColor, style = bracketStroke) }

                    // Laser line (held at mid-height when motion is reduced)
                    drawRect(
                        brush = laserBrush,
                        topLeft = Offset(laserLeft, top + boxSize * laserYRatio.value),
                        size = laserSize
                    )
                }
            }
    )
}

/** Laser position, as a fraction of the viewfinder height, when motion is reduced. */
internal const val AidenScannerLaserRestingRatio = 0.5f

/**
 * L-shaped bracket for the viewfinder [corner] whose bend is a [radius] arc matching the
 * cutout. [xDir]/[yDir] point from the corner into the box (+1 right/down, -1 left/up).
 */
private fun cornerBracketPath(corner: Offset, xDir: Float, yDir: Float, radius: Float, length: Float): Path =
    Path().apply {
        moveTo(corner.x, corner.y + yDir * length)
        lineTo(corner.x, corner.y + yDir * radius)
        arcTo(
            rect = Rect(
                left = minOf(corner.x, corner.x + xDir * radius * 2),
                top = minOf(corner.y, corner.y + yDir * radius * 2),
                right = maxOf(corner.x, corner.x + xDir * radius * 2),
                bottom = maxOf(corner.y, corner.y + yDir * radius * 2)
            ),
            startAngleDegrees = if (xDir > 0) 180f else 0f,
            sweepAngleDegrees = xDir * yDir * 90f,
            forceMoveTo = false
        )
        lineTo(corner.x + xDir * length, corner.y)
    }
