package sbtbiswas.AidenOnTheGo.features.bots.prototype

import sbtbiswas.AidenOnTheGo.config.AidenThemePresetID
import sbtbiswas.AidenOnTheGo.models.*
import java.time.Instant

enum class AidenBotPrototypeState(val title: String) {
    READY("Ready"),
    EMPTY("Empty"),
    LOADING("Loading"),
    ERROR("Error"),
    OFFLINE("Offline"),
    DEGRADED("Degraded"),
    ARCHIVED("Archived"),
    NO_RESULTS("No Results")
}

enum class AidenBotPrototypeScreen {
    INBOX, PROFILE, EDITOR, ACCESS, CHAT
}

data class AidenBotFirstPrototypeConfiguration(
    val theme: AidenThemePresetID = AidenThemePresetID.AIDEN,
    val state: AidenBotPrototypeState = AidenBotPrototypeState.READY,
    val screen: AidenBotPrototypeScreen = AidenBotPrototypeScreen.INBOX,
    val noticeAcknowledged: Boolean = false
)

object AidenBotPrototypeFixtures {
    fun sampleBotSummary(id: String = "bot_sample", name: String = "Coding Assistant"): AidenBotSummary {
        val recipe = AidenBotAvatarRecipe(
            shape = AidenBotAvatarShape.ORB,
            color = AidenBotAvatarColor.LILAC,
            eyes = AidenBotAvatarEyes.HAPPY,
            detail = AidenBotAvatarDetail.SPARKLES
        )
        return AidenBotSummary(
            id = id,
            name = name,
            purpose = "Helps build Kotlin & Compose applications",
            avatar = AidenBotAvatarView(semantic = AidenBotSemanticAvatar.Recipe(recipe)),
            health = AidenBotHealth.READY,
            createdAt = Instant.now(),
            updatedAt = Instant.now(),
            revision = "rev_1"
        )
    }

    fun sampleConversation(botId: String = "bot_sample", chatId: String = "chat_sample"): AidenBotConversationItem {
        val now = Instant.now()
        return AidenBotConversationItem(
            chatId = chatId,
            botId = botId,
            title = "Sample Bot Chat",
            preview = "Let's build Compose components",
            createdAt = now,
            updatedAt = now,
            activityState = AidenBotConversationActivityState.IDLE,
            canRespondToApproval = false,
            revision = "rev_1"
        )
    }
}
