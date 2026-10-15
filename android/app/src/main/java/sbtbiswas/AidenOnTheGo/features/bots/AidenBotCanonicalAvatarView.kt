package sbtbiswas.AidenOnTheGo.features.bots

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.animation.Crossfade
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import sbtbiswas.AidenOnTheGo.features.chat.aidenPowerSaveMode
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMark
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMarkKind
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatar
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenBotCache
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.res.stringResource
import sbtbiswas.AidenOnTheGo.R

object AidenBotAvatarMemoryCache {
    private val lruCache = object : android.util.LruCache<String, Bitmap>(64) {}

    fun get(key: String): Bitmap? = lruCache.get(key)
    fun put(key: String, bitmap: Bitmap) {
        lruCache.put(key, bitmap)
    }
}

@Composable
fun AidenBotCanonicalAvatarView(
    avatar: AidenBotAvatar,
    botId: String,
    coordinator: AidenRemoteCoordinator? = null,
    client: AidenRemoteClient? = null,
    botCache: AidenBotCache? = null,
    name: String = "",
    size: Dp = 48.dp,
    /** The Bot is working: its face glances, or a glance badge says so (R8, R19). */
    working: Boolean = false,
    modifier: Modifier = Modifier
) {
    val coordinatorClient = coordinator?.client?.collectAsStateWithLifecycle()?.value
    val effectiveClient = client ?: coordinatorClient
    val effectiveBotCache = botCache ?: coordinator?.botCache
    val asset = avatar.asset
    var customBitmap by remember(asset?.assetRevision) {
        mutableStateOf<Bitmap?>(
            asset?.assetRevision?.let { rev ->
                AidenBotAvatarMemoryCache.get("$botId:$rev")
            }
        )
    }

    LaunchedEffect(asset?.assetRevision, effectiveClient) {
        val rev = asset?.assetRevision ?: return@LaunchedEffect
        if (customBitmap != null) return@LaunchedEffect

        withContext(Dispatchers.IO) {
            // Check disk cache first
            val cachedBytes = effectiveBotCache?.getAvatar(botId, rev)
            if (cachedBytes != null) {
                val bmp = BitmapFactory.decodeByteArray(cachedBytes, 0, cachedBytes.size)
                if (bmp != null) {
                    AidenBotAvatarMemoryCache.put("$botId:$rev", bmp)
                    withContext(Dispatchers.Main) { customBitmap = bmp }
                    return@withContext
                }
            }

            // Fetch from Mac client if available
            if (effectiveClient != null) {
                try {
                    val content = effectiveClient.botAvatar(botId, rev)
                    effectiveBotCache?.putAvatar(botId, rev, content.data)
                    val bmp = BitmapFactory.decodeByteArray(content.data, 0, content.data.size)
                    if (bmp != null) {
                        AidenBotAvatarMemoryCache.put("$botId:$rev", bmp)
                        withContext(Dispatchers.Main) { customBitmap = bmp }
                    }
                } catch (_: Exception) {}
            }
        }
    }

    val reduceMotion = aidenReduceMotion()
    val motion = aidenBotFaceMotion(
        working = working,
        photo = customBitmap != null,
        reduceMotion = reduceMotion,
        powerSave = working && aidenPowerSaveMode(),
        resumed = aidenBotIsResumed()
    )
    Box(modifier = modifier.size(size)) {
        if (reduceMotion) {
            AidenBotAvatarLayer(customBitmap, avatar, name, size, working)
        } else {
            Crossfade(
                targetState = customBitmap,
                animationSpec = AidenMotion.short(),
                label = "bot_avatar_reveal"
            ) { bmp ->
                AidenBotAvatarLayer(bmp, avatar, name, size, working)
            }
        }
        // A photo can't glance, and a still face can't show it's working: a small glance mark does.
        if (motion.badge) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(size * 0.38f)
                    .clip(CircleShape)
                    .background(AidenTheme.palette.canvas),
                contentAlignment = Alignment.Center
            ) {
                AidenActivityMark(
                    mark = AidenActivityMarkKind.GLANCE,
                    size = size * 0.3f,
                    active = motion.badgeAnimates,
                    color = AidenTheme.palette.foreground
                )
            }
        }
    }
}

@Composable
private fun AidenBotAvatarLayer(
    bitmap: Bitmap?,
    avatar: AidenBotAvatar,
    name: String,
    size: Dp,
    working: Boolean
) {
    if (bitmap != null) {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = if (name.isNotEmpty()) stringResource(R.string.bots_avatar_cd, name) else stringResource(R.string.bots_avatar_default_cd),
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(size)
                .clip(CircleShape)
        )
    } else {
        AidenBotSemanticAvatarView(
            avatar = avatar.semantic,
            name = name,
            size = size,
            working = working
        )
    }
}
