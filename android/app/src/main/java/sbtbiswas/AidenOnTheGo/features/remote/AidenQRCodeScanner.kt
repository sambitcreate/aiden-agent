package sbtbiswas.AidenOnTheGo.features.remote

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
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

/**
 * High-fidelity CameraX and MLKit QR Code Scanner with Viewfinder Overlay.
 */
@Composable
fun AidenQRCodeScanner(
    onCodeScanned: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val palette = AidenTheme.palette
    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        )
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasCameraPermission = granted
    }

    if (!hasCameraPermission) {
        AidenCameraPermissionPrompt(
            onEnableCamera = { permissionLauncher.launch(Manifest.permission.CAMERA) },
            modifier = modifier
        )
    } else {
        // In-App CameraX Live Viewfinder
        Box(
            modifier = modifier
                .fillMaxWidth()
                .height(340.dp)
                .clip(RoundedCornerShape(20.dp))
                .background(Color.Black)
        ) {
            CameraPreview(onCodeScanned = onCodeScanned)
            ScannerViewfinderOverlay(accentColor = palette.accent)
        }
    }
}

/** Camera permission explainer. [onEnableCamera] runs exactly once per tap. */
@Composable
internal fun AidenCameraPermissionPrompt(
    onEnableCamera: () -> Unit,
    modifier: Modifier = Modifier
) {
    val palette = AidenTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            imageVector = Icons.Default.QrCodeScanner,
            contentDescription = null,
            tint = palette.accent,
            modifier = Modifier.size(64.dp)
        )
        Spacer(modifier = Modifier.height(16.dp))
        Text(
            text = "Scan Pairing QR Code",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            color = palette.foreground
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "Point your camera at the QR code displayed in Aiden on your desktop to pair instantly.",
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(24.dp))

        Button(
            onClick = onEnableCamera,
            interactionSource = interaction,
            colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
            shape = AidenShape.Button,
            modifier = Modifier
                .fillMaxWidth()
                .tactilePress(interaction)
        ) {
            Icon(Icons.Default.Videocam, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(modifier = Modifier.width(8.dp))
            Text("Enable Camera", fontWeight = FontWeight.Bold, color = Color.White)
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

    Canvas(modifier = Modifier.fillMaxSize()) {
        val width = size.width
        val height = size.height
        val boxSize = (minOf(width, height) * 0.7f).coerceAtMost(240.dp.toPx())

        val left = (width - boxSize) / 2f
        val top = (height - boxSize) / 2f
        val right = left + boxSize
        val bottom = top + boxSize

        // Dark dimming overlay around targeting box
        drawRect(
            color = Color.Black.copy(alpha = 0.55f),
            size = size
        )

        // Clear center targeting window
        drawRoundRect(
            color = Color.Transparent,
            topLeft = Offset(left, top),
            size = Size(boxSize, boxSize),
            cornerRadius = CornerRadius(16.dp.toPx()),
            blendMode = BlendMode.Clear
        )

        // Viewfinder bounding box border
        drawRoundRect(
            color = Color.White.copy(alpha = 0.3f),
            topLeft = Offset(left, top),
            size = Size(boxSize, boxSize),
            cornerRadius = CornerRadius(16.dp.toPx()),
            style = Stroke(width = 2.dp.toPx())
        )

        // Rounded corner brackets that follow the 16.dp cutout radius.
        val bracketStroke = Stroke(width = 4.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        val radius = 16.dp.toPx()
        val length = 28.dp.toPx()
        listOf(
            Offset(left, top) to Offset(1f, 1f),
            Offset(right, top) to Offset(-1f, 1f),
            Offset(right, bottom) to Offset(-1f, -1f),
            Offset(left, bottom) to Offset(1f, -1f)
        ).forEach { (corner, direction) ->
            drawPath(
                path = cornerBracketPath(corner, direction.x, direction.y, radius, length),
                color = accentColor,
                style = bracketStroke
            )
        }

        // Laser line (held at mid-height when motion is reduced)
        val laserY = top + boxSize * laserYRatio.value
        drawRect(
            brush = Brush.horizontalGradient(
                colors = listOf(Color.Transparent, accentColor, Color.Transparent),
                startX = left,
                endX = right
            ),
            topLeft = Offset(left + 8.dp.toPx(), laserY),
            size = Size(boxSize - 16.dp.toPx(), 2.dp.toPx())
        )
    }
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
