package sbtbiswas.AidenOnTheGo.features.simulators

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap

/** How much to subsample a simulator frame for the viewer, as BitmapFactory's power-of-two `inSampleSize`. */
object AidenSimulatorFrameSampling {
    /**
     * The largest power of two that still leaves the frame at least as large as
     * it is drawn when aspect-fit into a [viewWidth] × [viewHeight] viewer, so
     * subsampling never shows as blur. An unknown view size decodes at full size.
     */
    fun inSampleSize(frameWidth: Int, frameHeight: Int, viewWidth: Int, viewHeight: Int): Int {
        if (frameWidth <= 0 || frameHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) return 1
        // Aspect-fit draws the frame at min(view / frame) of its size, so it may shrink by the larger ratio.
        val shrink = maxOf(frameWidth.toDouble() / viewWidth, frameHeight.toDouble() / viewHeight)
        var sample = 1
        while (sample * 2 <= shrink) sample *= 2
        return sample
    }
}

/**
 * Which decoded frames may be decoded into again. Every frame handed to the UI
 * stays reserved until the UI reports showing a frame published at least two
 * frames later, so the frame on screen and the one it replaced (which the
 * screen may still be drawing) are never overwritten. Released frames wait in a
 * small free list; a frame the UI never reports leaves tracking after
 * [trackedLimit] newer ones and is left to the garbage collector, never reused.
 */
class AidenFrameReusePolicy<T : Any>(
    private val freeCapacity: Int = 2,
    private val trackedLimit: Int = 4
) {
    private val published = ArrayDeque<T>()
    private val free = ArrayDeque<T>()

    @Synchronized
    fun published(frame: T) {
        published.addLast(frame)
        while (published.size > trackedLimit) published.removeFirst()
    }

    @Synchronized
    fun shown(frame: T) {
        val index = published.indexOf(frame)
        if (index < 0) return
        // Keep the shown frame and the one before it; everything older is off screen.
        repeat(maxOf(0, index - 1)) {
            val released = published.removeFirst()
            if (free.size < freeCapacity) free.addLast(released)
        }
    }

    /** A released frame that [fits], removed from the free list, or null. */
    @Synchronized
    fun acquire(fits: (T) -> Boolean): T? {
        val index = free.indexOfFirst(fits)
        return if (index < 0) null else free.removeAt(index)
    }

    /** Forgets every frame; none is reused afterwards. */
    @Synchronized
    fun clear() {
        published.clear()
        free.clear()
    }
}

/**
 * Decodes MJPEG parts for one stream session: bounds first, then subsampled to
 * the viewer's size into a reused mutable bitmap when one fits.
 */
class AidenSimulatorFrameDecoder(private val viewSize: () -> Pair<Int, Int>?) {
    private val pool = AidenFrameReusePolicy<Bitmap>()

    fun decode(jpeg: ByteArray): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val (viewWidth, viewHeight) = viewSize() ?: (0 to 0)
        val sample = AidenSimulatorFrameSampling.inSampleSize(bounds.outWidth, bounds.outHeight, viewWidth, viewHeight)
        val width = (bounds.outWidth + sample - 1) / sample
        val height = (bounds.outHeight + sample - 1) / sample
        val needed = width.toLong() * height * 4
        val reuse = pool.acquire { it.isMutable && !it.isRecycled && it.allocationByteCount >= needed }
        val bitmap = decode(jpeg, sample, reuse) ?: reuse?.let { decode(jpeg, sample, null) } ?: return null
        pool.published(bitmap)
        return bitmap.asImageBitmap()
    }

    /** The UI is showing [bitmap]; frames two or more behind it may be decoded into again. */
    fun shown(bitmap: Bitmap) = pool.shown(bitmap)

    private fun decode(jpeg: ByteArray, sample: Int, into: Bitmap?): Bitmap? {
        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            inMutable = true
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inBitmap = into
        }
        return try {
            BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, options)
        } catch (_: IllegalArgumentException) {
            // The reused bitmap could not take this frame.
            null
        }
    }
}
