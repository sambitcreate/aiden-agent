package sbtbiswas.AidenOnTheGo.features.simulators

import kotlin.math.sqrt
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorDisplayRotation

/**
 * Whether the viewer's controls overlay is showing. Controls greet the user
 * while input connects, then get out of the stream's way; the grabber handle,
 * a shake, or Android Back bring them back.
 *
 * Adapted from t3code apps/mobile/src/features/devices/DevicePreviewRouteScreen.tsx (MIT).
 */
data class AidenSimulatorControls(
    val visible: Boolean = true,
    val inputConnected: Boolean = false
) {
    /** Connecting hides the controls once; losing input keeps the current choice. */
    fun withInputConnected(connected: Boolean): AidenSimulatorControls = when {
        connected && !inputConnected -> copy(visible = false, inputConnected = true)
        else -> copy(inputConnected = connected)
    }

    /** A shake flips the overlay either way. */
    fun toggled(): AidenSimulatorControls = copy(visible = !visible)

    /** The grabber handle. */
    fun shown(): AidenSimulatorControls = copy(visible = true)

    /** The dimmed backdrop exists, and hides the controls, only while input is connected. */
    fun backdropTapped(): AidenSimulatorControls = if (inputConnected) copy(visible = false) else this

    /**
     * Android Back reveals hidden controls first, so leaving the viewer takes a
     * deliberate second press. Returns the next state and whether to exit.
     */
    fun back(): Pair<AidenSimulatorControls, Boolean> =
        if (visible) this to true else copy(visible = true) to false
}

/**
 * Reports a shake after two strong jolts within a short window. A single bump,
 * setting the phone down, or walking stays below the threshold or the count.
 * Samples are in g with gravity included (Android reports m/s²; see [STANDARD_GRAVITY]).
 *
 * Adapted from t3code apps/mobile/src/features/devices/shakeDetector.ts (MIT).
 */
class AidenShakeDetector(
    private val thresholdG: Double = 1.8,
    private val windowMillis: Long = 600,
    private val cooldownMillis: Long = 1_000
) {
    private val jolts = ArrayDeque<Long>()
    private var lastShake: Long? = null

    fun onSample(xG: Double, yG: Double, zG: Double, timestampMillis: Long): Boolean {
        lastShake?.let { if (timestampMillis - it < cooldownMillis) return false }
        if (sqrt(xG * xG + yG * yG + zG * zG) < thresholdG) return false
        while (jolts.isNotEmpty() && timestampMillis - jolts.first() > windowMillis) jolts.removeFirst()
        jolts.addLast(timestampMillis)
        if (jolts.size < 2) return false
        jolts.clear()
        lastShake = timestampMillis
        return true
    }

    /** Feeds an Android accelerometer event (m/s², nanosecond timestamp). */
    fun onSensorSample(x: Float, y: Float, z: Float, timestampNanos: Long): Boolean =
        onSample(
            x / STANDARD_GRAVITY,
            y / STANDARD_GRAVITY,
            z / STANDARD_GRAVITY,
            timestampNanos / 1_000_000
        )

    companion object {
        const val STANDARD_GRAVITY = 9.80665
        /** ~20 Hz, in the microseconds `SensorManager.registerListener` takes. */
        const val SAMPLING_PERIOD_MICROS = 50_000
    }
}

/** Where an aspect-fit frame sits inside its container, in container pixels. */
data class AidenFittedRect(val left: Float, val top: Float, val width: Float, val height: Float) {
    /**
     * A point in the container as normalized frame coordinates (0,0 top-left),
     * or null outside the frame. With [clamp] a point outside is pinned to the
     * edge instead, so a drag that leaves the frame still ends cleanly.
     */
    fun normalized(x: Float, y: Float, clamp: Boolean = false): Pair<Double, Double>? {
        if (width <= 0f || height <= 0f) return null
        val nx = ((x - left) / width).toDouble()
        val ny = ((y - top) / height).toDouble()
        if (clamp) return nx.coerceIn(0.0, 1.0) to ny.coerceIn(0.0, 1.0)
        if (nx < 0.0 || nx > 1.0 || ny < 0.0 || ny > 1.0) return null
        return nx to ny
    }

    companion object {
        fun aspectFit(containerWidth: Float, containerHeight: Float, contentWidth: Float, contentHeight: Float): AidenFittedRect {
            if (containerWidth <= 0f || containerHeight <= 0f || contentWidth <= 0f || contentHeight <= 0f) {
                return AidenFittedRect(0f, 0f, 0f, 0f)
            }
            val scale = minOf(containerWidth / contentWidth, containerHeight / contentHeight)
            val width = contentWidth * scale
            val height = contentHeight * scale
            return AidenFittedRect((containerWidth - width) / 2f, (containerHeight - height) / 2f, width, height)
        }

        /**
         * Where a [frameWidth] × [frameHeight] frame shows once turned by
         * [rotation]: a quarter turn fits the transposed size. Touches are
         * normalized against this rect, then `AidenSimulatorInput.mapTouch`
         * maps them back into the raw frame.
         */
        fun displayed(
            containerWidth: Float,
            containerHeight: Float,
            frameWidth: Float,
            frameHeight: Float,
            rotation: AidenSimulatorDisplayRotation
        ): AidenFittedRect = if (rotation.isSideways) {
            aspectFit(containerWidth, containerHeight, frameHeight, frameWidth)
        } else {
            aspectFit(containerWidth, containerHeight, frameWidth, frameHeight)
        }
    }
}
