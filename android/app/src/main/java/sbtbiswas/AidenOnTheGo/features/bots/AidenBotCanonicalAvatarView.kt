package sbtbiswas.AidenOnTheGo.features.bots

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatar
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenBotCache

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
    modifier: Modifier = Modifier
) {
    val effectiveClient = client ?: coordinator?.client?.value
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

    Box(modifier = modifier.size(size)) {
        val bmp = customBitmap
        if (bmp != null) {
            Image(
                bitmap = bmp.asImageBitmap(),
                contentDescription = if (name.isNotEmpty()) "$name avatar" else "Bot Avatar",
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(size)
                    .clip(CircleShape)
            )
        } else {
            AidenBotSemanticAvatarView(
                avatar = avatar.semantic,
                name = name,
                size = size
            )
        }
    }
}
