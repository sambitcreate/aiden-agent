package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.config.AidenPalette
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

/**
 * Syntax-styled code container with header bar, language pill, and animated copy button.
 */
@Composable
fun AidenCodeBlock(
    code: String,
    language: String?,
    palette: AidenPalette,
    onCopy: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var copied by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Surface(
        color = palette.canvas,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, palette.secondary.copy(alpha = 0.2f)),
        modifier = modifier.fillMaxWidth()
    ) {
        Column {
            // Header Bar
            Surface(
                color = palette.raised,
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = language?.uppercase()?.ifEmpty { "CODE" } ?: "CODE",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        color = palette.secondary
                    )
                    IconButton(
                        onClick = {
                            onCopy(code)
                            copied = true
                            scope.launch {
                                delay(2000)
                                copied = false
                            }
                        },
                        modifier = Modifier
                            .size(28.dp)
                            .tactilePress {
                                onCopy(code)
                                copied = true
                                scope.launch {
                                    delay(2000)
                                    copied = false
                                }
                            }
                    ) {
                        AnimatedContent(
                            targetState = copied,
                            transitionSpec = { fadeIn().togetherWith(fadeOut()) },
                            label = "copy_icon_anim"
                        ) { isCopied ->
                            if (isCopied) {
                                Icon(
                                    imageVector = Icons.Default.Check,
                                    contentDescription = "Copied",
                                    tint = palette.success,
                                    modifier = Modifier.size(14.dp)
                                )
                            } else {
                                Icon(
                                    imageVector = Icons.Default.ContentCopy,
                                    contentDescription = "Copy code",
                                    tint = palette.secondary,
                                    modifier = Modifier.size(14.dp)
                                )
                            }
                        }
                    }
                }
            }

            // Code Content
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(14.dp)
            ) {
                Text(
                    text = code,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    color = palette.foreground
                )
            }
        }
    }
}
