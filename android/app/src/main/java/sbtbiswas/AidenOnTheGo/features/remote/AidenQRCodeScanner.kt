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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
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
        // Permission Request View
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
                text = "Point your camera at the QR code displayed in Aiden on your Mac to pair instantly.",
                style = MaterialTheme.typography.bodySmall,
                color = palette.secondary,
                textAlign = TextAlign.Center
            )
            Spacer(modifier = Modifier.height(24.dp))

            Button(
                onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .tactilePress()
            ) {
                Icon(Icons.Default.Videocam, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("Enable Camera", fontWeight = FontWeight.Bold, color = Color.White)
            }
        }
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

    DisposableEffect(lifecycleOwner) {
        onDispose {
            cameraExecutor.shutdown()
            scanner.close()
            try {
                if (cameraProviderFuture.isDone) {
                    cameraProviderFuture.get().unbindAll()
                }
            } catch (_: Exception) {
            }
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
    val transition = rememberInfiniteTransition(label = "scanner_laser")
    val laserYRatio by transition.animateFloat(
        initialValue = 0.1f,
        targetValue = 0.9f,
        animationSpec = infiniteRepeatable(
            animation = tween(2000, easing = EaseInOutCubic),
            repeatMode = RepeatMode.Reverse
        ),
        label = "laser_y"
    )

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

        // Corner Reticle Accents
        val cornerLen = 24.dp.toPx()
        val cornerStroke = 4.dp.toPx()

        // Top Left
        drawLine(accentColor, Offset(left, top + 8.dp.toPx()), Offset(left, top + cornerLen), cornerStroke)
        drawLine(accentColor, Offset(left + 8.dp.toPx(), top), Offset(left + cornerLen, top), cornerStroke)

        // Top Right
        drawLine(accentColor, Offset(right, top + 8.dp.toPx()), Offset(right, top + cornerLen), cornerStroke)
        drawLine(accentColor, Offset(right - 8.dp.toPx(), top), Offset(right - cornerLen, top), cornerStroke)

        // Bottom Left
        drawLine(accentColor, Offset(left, bottom - 8.dp.toPx()), Offset(left, bottom - cornerLen), cornerStroke)
        drawLine(accentColor, Offset(left + 8.dp.toPx(), bottom), Offset(left + cornerLen, bottom), cornerStroke)

        // Bottom Right
        drawLine(accentColor, Offset(right, bottom - 8.dp.toPx()), Offset(right, bottom - cornerLen), cornerStroke)
        drawLine(accentColor, Offset(right - 8.dp.toPx(), bottom), Offset(right - cornerLen, bottom), cornerStroke)

        // Animated laser line
        val laserY = top + boxSize * laserYRatio
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
