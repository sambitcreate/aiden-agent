package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.QuestionMark
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sbtbiswas.AidenOnTheGo.models.AidenPendingQuestion
import sbtbiswas.AidenOnTheGo.models.AidenQuestionAnswerDraft
import sbtbiswas.AidenOnTheGo.models.AidenQuestionRespondRequest
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/** `ask_user_question` prompt card (iOS parity: AidenQuestionCard). All
 * questions render stacked; a non-blank custom draft overrides that question's
 * option selections, and unaddressed questions are sent as skipped. */
@Composable
fun AidenQuestionCard(
    prompt: AidenPendingQuestion,
    enabled: Boolean,
    onSubmit: (AidenQuestionRespondRequest) -> Unit
) {
    val palette = AidenTheme.palette
    var selections by remember(prompt.id) { mutableStateOf(mapOf<Int, Set<String>>()) }
    var customDrafts by remember(prompt.id) { mutableStateOf(mapOf<Int, String>()) }
    var customOpen by remember(prompt.id) { mutableStateOf(setOf<Int>()) }

    val answers = AidenQuestionAnswerDraft.answers(
        questions = prompt.questions,
        selections = selections,
        customAnswers = customDrafts
    )

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .shadow(elevation = 8.dp, shape = RoundedCornerShape(16.dp)),
        colors = CardDefaults.cardColors(containerColor = palette.raised),
        shape = RoundedCornerShape(16.dp)
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Default.QuestionMark,
                    contentDescription = null,
                    tint = palette.accent,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Column {
                    Text(
                        text = "Aiden needs your input",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        color = palette.foreground
                    )
                    Text(
                        text = if (prompt.questions.size > 1) {
                            "Answer what you can — unanswered questions are skipped."
                        } else {
                            "Choose an option or type your own answer."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary
                    )
                }
            }
            prompt.questions.forEachIndexed { index, question ->
                Spacer(modifier = Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = question.header,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.secondary,
                        modifier = Modifier
                            .background(palette.canvas, RoundedCornerShape(50))
                            .padding(horizontal = 8.dp, vertical = 3.dp)
                    )
                    if (question.multiSelect) {
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = "Select all that apply",
                            style = MaterialTheme.typography.labelSmall,
                            color = palette.secondary
                        )
                    }
                }
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = question.question,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    color = palette.foreground
                )
                Spacer(modifier = Modifier.height(6.dp))
                question.options.forEach { option ->
                    val selected = selections[index]?.contains(option.label) == true
                    Row(
                        verticalAlignment = Alignment.Top,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (selected) palette.accent.copy(alpha = 0.10f) else palette.canvas)
                            .toggleable(
                                value = selected,
                                enabled = enabled,
                                role = if (question.multiSelect) Role.Checkbox else Role.RadioButton,
                                onValueChange = {
                                    selections = AidenQuestionAnswerDraft.toggled(
                                        selections = selections,
                                        questionIndex = index,
                                        label = option.label,
                                        multiSelect = question.multiSelect
                                    )
                                }
                            )
                            .padding(horizontal = 10.dp, vertical = 8.dp)
                    ) {
                        Icon(
                            if (question.multiSelect) {
                                if (selected) Icons.Default.CheckBox else Icons.Default.CheckBoxOutlineBlank
                            } else {
                                if (selected) Icons.Default.RadioButtonChecked else Icons.Default.RadioButtonUnchecked
                            },
                            contentDescription = null,
                            tint = if (selected) palette.accent else palette.secondary,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(10.dp))
                        Column {
                            Text(
                                text = option.label,
                                style = MaterialTheme.typography.bodyMedium,
                                color = palette.foreground
                            )
                            Text(
                                text = option.description,
                                style = MaterialTheme.typography.bodySmall,
                                color = palette.secondary
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                }
                if (customOpen.contains(index)) {
                    val draftValue = customDrafts[index] ?: ""
                    BasicTextField(
                        value = draftValue,
                        onValueChange = { next ->
                            customDrafts = if (next.isEmpty()) customDrafts - index else customDrafts + (index to next)
                        },
                        enabled = enabled,
                        textStyle = MaterialTheme.typography.bodyMedium.copy(color = palette.foreground),
                        cursorBrush = SolidColor(palette.accent),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(palette.canvas)
                            .padding(horizontal = 10.dp, vertical = 8.dp)
                            .semantics { contentDescription = "Custom answer" }
                    ) { innerTextField ->
                        Box {
                            if (draftValue.isEmpty()) {
                                Text(
                                    text = "Type your answer",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = palette.secondary
                                )
                            }
                            innerTextField()
                        }
                    }
                } else {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .clickable(enabled = enabled) { customOpen = customOpen + index }
                            .padding(horizontal = 10.dp, vertical = 8.dp)
                            .semantics {
                                contentDescription = "Type something. Shows a field for a custom answer"
                            }
                    ) {
                        Icon(
                            Icons.Default.Edit,
                            contentDescription = null,
                            tint = palette.secondary,
                            modifier = Modifier.size(14.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Type something.",
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.Medium,
                            color = palette.secondary
                        )
                    }
                }
            }
            if (!prompt.canRespond) {
                Spacer(modifier = Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Default.Lock,
                        contentDescription = null,
                        tint = palette.secondary,
                        modifier = Modifier.size(14.dp)
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = "This paired device cannot respond to prompts.",
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary
                    )
                }
            } else {
                Spacer(modifier = Modifier.height(10.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End
                ) {
                    Button(
                        onClick = { onSubmit(AidenQuestionRespondRequest(cancelled = true, answers = emptyList())) },
                        enabled = enabled,
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Text("Skip", fontWeight = FontWeight.SemiBold)
                    }
                    Spacer(modifier = Modifier.width(10.dp))
                    Button(
                        onClick = { onSubmit(AidenQuestionRespondRequest(cancelled = false, answers = answers)) },
                        enabled = enabled && answers.isNotEmpty(),
                        colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Text("Submit", color = Color.White, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}
