package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarColor
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarDetail
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarEyes
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarRecipe
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarShape
import sbtbiswas.AidenOnTheGo.models.AidenBotDetail
import sbtbiswas.AidenOnTheGo.models.AidenBotIdentityPatch
import sbtbiswas.AidenOnTheGo.models.AidenBotSemanticAvatar
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

/**
 * A Bot's Character: one colour and one shape. The wire recipe still carries eye and
 * accessory fields; they always hold the default values because every Bot shares one
 * fixed eye mark.
 */
object AidenBotCharacter {
    /** Matches the desktop's `DEFAULT_BOT_AVATAR`. */
    val DEFAULT = AidenBotAvatarRecipe(
        shape = AidenBotAvatarShape.WISP,
        color = AidenBotAvatarColor.LILAC,
        eyes = AidenBotAvatarEyes.DOTS,
        detail = AidenBotAvatarDetail.SPARKLES
    )

    /** Picker order, roundest to most playful. */
    val SHAPES = listOf(
        AidenBotAvatarShape.ORB,
        AidenBotAvatarShape.WISP,
        AidenBotAvatarShape.SQUIRCLE,
        AidenBotAvatarShape.CAPSULE,
        AidenBotAvatarShape.PEAK,
        AidenBotAvatarShape.HEX,
        AidenBotAvatarShape.CLOUD,
        AidenBotAvatarShape.DROP
    )

    /** Every colour the paired Mac understands. */
    val COLORS: List<AidenBotAvatarColor> = AidenBotAvatarColor.entries

    /** The editable recipe for any stored avatar, including legacy string ids. */
    fun recipe(avatar: AidenBotSemanticAvatar): AidenBotAvatarRecipe {
        val presentation = aidenBotAvatarPresentation(avatar)
        return DEFAULT.copy(shape = presentation.shape, color = presentation.color)
    }

    fun withColor(recipe: AidenBotAvatarRecipe, color: AidenBotAvatarColor) =
        DEFAULT.copy(shape = recipe.shape, color = color)

    fun withShape(recipe: AidenBotAvatarRecipe, shape: AidenBotAvatarShape) =
        DEFAULT.copy(shape = shape, color = recipe.color)

    fun reset(): AidenBotAvatarRecipe = DEFAULT

    fun isDefault(recipe: AidenBotAvatarRecipe): Boolean =
        recipe.shape == DEFAULT.shape && recipe.color == DEFAULT.color

    /**
     * A new Bot gets a character picked from its name, so two Bots made back to back
     * rarely look alike and the same name always lands on the same look.
     */
    fun autoAssigned(name: String): AidenBotAvatarRecipe {
        val seed = name.trim().lowercase().fold(17) { acc, c -> acc * 31 + c.code }
        val positive = seed and Int.MAX_VALUE
        return DEFAULT.copy(
            color = COLORS[positive % COLORS.size],
            shape = SHAPES[(positive / COLORS.size) % SHAPES.size]
        )
    }
}

/** The identity patch that saves [next] as the Bot's character, or null when nothing changes. */
fun aidenBotCharacterPatch(bot: AidenBotDetail, next: AidenBotAvatarRecipe): AidenBotIdentityPatch? {
    val avatar = AidenBotSemanticAvatar.Recipe(next)
    if (avatar == bot.avatar.semantic) return null
    return AidenBotIdentityPatch(avatar = avatar)
}

fun aidenBotAvatarColorLabel(color: AidenBotAvatarColor): String =
    color.name.lowercase().replaceFirstChar { it.uppercase() }

fun aidenBotAvatarShapeLabel(shape: AidenBotAvatarShape): String = when (shape) {
    AidenBotAvatarShape.ORB -> "Circle"
    AidenBotAvatarShape.WISP -> "Wisp"
    AidenBotAvatarShape.SQUIRCLE -> "Rounded square"
    AidenBotAvatarShape.CAPSULE -> "Pill"
    AidenBotAvatarShape.PEAK -> "Triangle"
    AidenBotAvatarShape.HEX -> "Hexagon"
    AidenBotAvatarShape.CLOUD -> "Cloud"
    AidenBotAvatarShape.DROP -> "Drop"
}

object AidenBotCharacterTags {
    const val RESET = "bot_character_reset"
}

/**
 * Colour swatches, shape choices and Reset to default on one grouped card. Choices are
 * radio buttons whose selection is a check mark plus selected semantics, never a ring.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AidenBotCharacterCard(
    recipe: AidenBotAvatarRecipe,
    onChange: (AidenBotAvatarRecipe) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    val palette = AidenTheme.palette
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "Character",
            style = MaterialTheme.typography.labelLarge,
            color = palette.secondary,
            modifier = Modifier.padding(horizontal = 4.dp)
        )
        Surface(
            color = palette.raised,
            shape = RoundedCornerShape(20.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(vertical = 8.dp)) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                        .selectableGroup()
                ) {
                    AidenBotCharacter.COLORS.forEach { color ->
                        AidenBotColorSwatch(
                            color = color,
                            selected = recipe.color == color,
                            enabled = enabled,
                            onClick = { onChange(AidenBotCharacter.withColor(recipe, color)) }
                        )
                    }
                }
                HorizontalDivider(color = palette.canvas, modifier = Modifier.padding(start = 16.dp))
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                        .selectableGroup()
                ) {
                    AidenBotCharacter.SHAPES.forEach { shape ->
                        AidenBotShapeChoice(
                            shape = shape,
                            color = AidenBotAvatarColors.swatch(recipe.color),
                            selected = recipe.shape == shape,
                            enabled = enabled,
                            onClick = { onChange(AidenBotCharacter.withShape(recipe, shape)) }
                        )
                    }
                }
                HorizontalDivider(color = palette.canvas, modifier = Modifier.padding(start = 16.dp))
                TextButton(
                    onClick = { onChange(AidenBotCharacter.reset()) },
                    enabled = enabled && !AidenBotCharacter.isDefault(recipe),
                    modifier = Modifier
                        .padding(horizontal = 4.dp)
                        .testTag(AidenBotCharacterTags.RESET)
                ) {
                    Text("Reset to default", color = palette.accent)
                }
            }
        }
    }
}

/** Avatar colour swatch: a radio choice shown selected with a check mark on its fill. */
@Composable
fun AidenBotColorSwatch(
    color: AidenBotAvatarColor,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(40.dp)
            .tactilePress(interaction)
            .clip(CircleShape)
            .background(AidenBotAvatarColors.swatch(color))
            .selectable(
                selected = selected,
                enabled = enabled,
                interactionSource = interaction,
                indication = ripple(),
                role = Role.RadioButton,
                onClick = onClick
            )
            .semantics { contentDescription = aidenBotAvatarColorLabel(color) }
    ) {
        if (selected) {
            Icon(Icons.Default.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
        }
    }
}

/** One shape choice drawn in the current colour, selected with a soft tonal tile. */
@Composable
fun AidenBotShapeChoice(
    shape: AidenBotAvatarShape,
    color: Color,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    val palette = AidenTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(48.dp)
            .tactilePress(interaction)
            .clip(RoundedCornerShape(14.dp))
            .background(if (selected) palette.accent.copy(alpha = 0.14f) else Color.Transparent)
            .selectable(
                selected = selected,
                enabled = enabled,
                interactionSource = interaction,
                indication = ripple(),
                role = Role.RadioButton,
                onClick = onClick
            )
            .semantics { contentDescription = aidenBotAvatarShapeLabel(shape) }
    ) {
        Canvas(modifier = Modifier.size(30.dp)) {
            drawPath(aidenBotShapePath(shape, size.width, size.height), color = color)
        }
    }
}
