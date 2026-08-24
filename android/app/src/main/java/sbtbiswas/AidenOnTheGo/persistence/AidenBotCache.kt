package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.AidenBotConversationPage
import sbtbiswas.AidenOnTheGo.models.AidenBotDetail
import sbtbiswas.AidenOnTheGo.models.AidenBotList
import sbtbiswas.AidenOnTheGo.models.AidenBotSummary
import java.io.File

class AidenBotCache(private val storageDir: File) {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }
    private val cacheDir = File(storageDir, "bots").apply { mkdirs() }
    private val avatarDir = File(storageDir, "avatars").apply { mkdirs() }

    private val _botList = MutableStateFlow<AidenBotList?>(null)
    val botList: StateFlow<AidenBotList?> = _botList.asStateFlow()

    private val _botDetails = MutableStateFlow<Map<String, AidenBotDetail>>(emptyMap())
    val botDetails: StateFlow<Map<String, AidenBotDetail>> = _botDetails.asStateFlow()

    private val _botConversations = MutableStateFlow<AidenBotConversationPage?>(null)
    val botConversations: StateFlow<AidenBotConversationPage?> = _botConversations.asStateFlow()

    init {
        loadBotList()
        loadDetails()
        loadConversations()
    }

    @Synchronized
    private fun loadBotList() {
        val file = File(cacheDir, "list.json")
        if (!file.exists()) return
        try {
            _botList.value = json.decodeFromString(file.readText(Charsets.UTF_8))
        } catch (_: Exception) {}
    }

    @Synchronized
    private fun loadConversations() {
        val file = File(cacheDir, "conversations.json")
        if (!file.exists()) return
        try {
            _botConversations.value = json.decodeFromString(file.readText(Charsets.UTF_8))
        } catch (_: Exception) {}
    }

    @Synchronized
    private fun loadDetails() {
        val map = mutableMapOf<String, AidenBotDetail>()
        val files = cacheDir.listFiles { _, name -> name.startsWith("bot_") && name.endsWith(".json") } ?: return
        for (file in files) {
            try {
                val detail = json.decodeFromString<AidenBotDetail>(file.readText(Charsets.UTF_8))
                map[detail.id] = detail
            } catch (_: Exception) {}
        }
        _botDetails.value = map
    }

    @Synchronized
    fun putBotList(list: AidenBotList) {
        _botList.value = list
        try {
            val file = File(cacheDir, "list.json")
            file.writeText(json.encodeToString(list), Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    @Synchronized
    fun putBotConversations(page: AidenBotConversationPage) {
        _botConversations.value = page
        try {
            val file = File(cacheDir, "conversations.json")
            file.writeText(json.encodeToString(page), Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    @Synchronized
    fun putBotDetail(detail: AidenBotDetail) {
        val map = _botDetails.value.toMutableMap()
        map[detail.id] = detail
        _botDetails.value = map
        try {
            val file = File(cacheDir, "${detail.id}.json")
            file.writeText(json.encodeToString(detail), Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    @Synchronized
    fun getBotDetail(id: String): AidenBotDetail? = _botDetails.value[id]

    @Synchronized
    fun putAvatarData(botId: String, revision: String, data: ByteArray) {
        try {
            val file = File(avatarDir, "${botId}_$revision.png")
            file.writeBytes(data)
        } catch (_: Exception) {}
    }

    @Synchronized
    fun getAvatarData(botId: String, revision: String): ByteArray? {
        val file = File(avatarDir, "${botId}_$revision.png")
        return if (file.exists()) file.readBytes() else null
    }

    fun putAvatar(botId: String, revision: String, data: ByteArray) = putAvatarData(botId, revision, data)
    fun getAvatar(botId: String, revision: String): ByteArray? = getAvatarData(botId, revision)
}
