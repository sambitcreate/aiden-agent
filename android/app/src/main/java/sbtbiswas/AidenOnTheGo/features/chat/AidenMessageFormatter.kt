package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.sp
import sbtbiswas.AidenOnTheGo.config.AidenPalette

enum class AidenAnnotationTag {
    LINK, CODE_INLINE, MENTION
}

private val markdownPattern by lazy {
    Regex("""(https?://[^\s\t\n]+)|(`[^`\n]+`)|(@\w+)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)|(~[^~]+~)""")
}

/**
 * High-performance regex tokenizer generating AnnotatedString with rich inline styles and clickable link annotations.
 */
@Composable
fun buildAidenFormattedMessage(
    text: String,
    palette: AidenPalette,
    isUser: Boolean
): AnnotatedString {
    val tokens = markdownPattern.findAll(text)
    val inlineCodeBg = if (isUser) Color.White.copy(alpha = 0.2f) else palette.canvas
    val linkColor = if (isUser) Color.White else palette.accent

    return buildAnnotatedString {
        var cursor = 0
        for (token in tokens) {
            append(text.substring(cursor, token.range.first))
            val raw = token.value

            when {
                raw.startsWith("http://") || raw.startsWith("https://") -> {
                    val start = length
                    append(raw)
                    val end = length
                    addStyle(
                        SpanStyle(
                            color = linkColor,
                            textDecoration = TextDecoration.Underline,
                            fontWeight = FontWeight.Medium
                        ),
                        start, end
                    )
                    addStringAnnotation(AidenAnnotationTag.LINK.name, raw, start, end)
                }
                raw.startsWith("`") && raw.endsWith("`") -> {
                    val content = raw.removeSurrounding("`")
                    val start = length
                    append(content)
                    val end = length
                    addStyle(
                        SpanStyle(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 13.sp,
                            background = inlineCodeBg,
                            baselineShift = BaselineShift(0.1f)
                        ),
                        start, end
                    )
                    addStringAnnotation(AidenAnnotationTag.CODE_INLINE.name, content, start, end)
                }
                raw.startsWith("**") && raw.endsWith("**") -> {
                    val start = length
                    append(raw.removeSurrounding("**"))
                    addStyle(SpanStyle(fontWeight = FontWeight.Bold), start, length)
                }
                raw.startsWith("*") && raw.endsWith("*") -> {
                    val start = length
                    append(raw.removeSurrounding("*"))
                    addStyle(SpanStyle(fontStyle = FontStyle.Italic), start, length)
                }
                raw.startsWith("_") && raw.endsWith("_") -> {
                    val start = length
                    append(raw.removeSurrounding("_"))
                    addStyle(SpanStyle(fontStyle = FontStyle.Italic), start, length)
                }
                raw.startsWith("~") && raw.endsWith("~") -> {
                    val start = length
                    append(raw.removeSurrounding("~"))
                    addStyle(SpanStyle(textDecoration = TextDecoration.LineThrough), start, length)
                }
                raw.startsWith("@") -> {
                    val start = length
                    append(raw)
                    addStyle(SpanStyle(color = linkColor, fontWeight = FontWeight.SemiBold), start, length)
                    addStringAnnotation(AidenAnnotationTag.MENTION.name, raw.drop(1), start, length)
                }
                else -> append(raw)
            }
            cursor = token.range.last + 1
        }
        if (cursor < text.length) {
            append(text.substring(cursor))
        }
    }
}
