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
import java.security.MessageDigest

class AidenBotCache(private val storageDir: File) {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }
    private val cacheRoot = File(storageDir, "bots-v2").apply { mkdirs() }
    private val avatarRoot = File(storageDir, "bot-avatars-v2").apply { mkdirs() }
    private var activeScope: String? = null

    private val cacheDir: File?
        get() = activeScope?.let { File(cacheRoot, it).apply { mkdirs() } }
    private val avatarDir: File?
        get() = activeScope?.let { File(avatarRoot, it).apply { mkdirs() } }

    private val _botList = MutableStateFlow<AidenBotList?>(null)
    val botList: StateFlow<AidenBotList?> = _botList.asStateFlow()

    private val _botDetails = MutableStateFlow<Map<String, AidenBotDetail>>(emptyMap())
    val botDetails: StateFlow<Map<String, AidenBotDetail>> = _botDetails.asStateFlow()

    private val _botConversations = MutableStateFlow<AidenBotConversationPage?>(null)
    val botConversations: StateFlow<AidenBotConversationPage?> = _botConversations.asStateFlow()

    @Synchronized
    fun activate(instanceId: String, deviceId: String) {
        val nextScope = digest("$instanceId\u001f$deviceId")
        if (activeScope == nextScope) return
        activeScope = nextScope
        _botList.value = null
        _botDetails.value = emptyMap()
        _botConversations.value = null
        loadBotList()
        loadDetails()
        loadConversations()
    }

    @Synchronized
    private fun loadBotList() {
        val dir = cacheDir ?: return
        val file = File(dir, "list.json")
        if (!file.exists()) return
        try {
            _botList.value = json.decodeFromString(file.readText(Charsets.UTF_8))
        } catch (_: Exception) {}
    }

    @Synchronized
    private fun loadConversations() {
        val dir = cacheDir ?: return
        val file = File(dir, "conversations.json")
        if (!file.exists()) return
        try {
            _botConversations.value = json.decodeFromString(file.readText(Charsets.UTF_8))
        } catch (_: Exception) {}
    }

    @Synchronized
    private fun loadDetails() {
        val dir = cacheDir ?: return
        val map = mutableMapOf<String, AidenBotDetail>()
        val files = dir.listFiles { _, name ->
            name.endsWith(".json") && name != "list.json" && name != "conversations.json"
        } ?: return
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
            val dir = cacheDir ?: return
            val file = File(dir, "list.json")
            file.writeText(json.encodeToString(list), Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    @Synchronized
    fun putBotConversations(page: AidenBotConversationPage) {
        _botConversations.value = page
        try {
            val dir = cacheDir ?: return
            val file = File(dir, "conversations.json")
            file.writeText(json.encodeToString(page), Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    @Synchronized
    fun putBotDetail(detail: AidenBotDetail) {
        val map = _botDetails.value.toMutableMap()
        map[detail.id] = detail
        _botDetails.value = map
        try {
            val dir = cacheDir ?: return
            val file = File(dir, "${detail.id}.json")
            file.writeText(json.encodeToString(detail), Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    @Synchronized
    fun getBotDetail(id: String): AidenBotDetail? = _botDetails.value[id]

    @Synchronized
    fun putAvatarData(botId: String, revision: String, data: ByteArray) {
        try {
            val dir = avatarDir ?: return
            val file = File(dir, "${digest(botId)}_${digest(revision)}.png")
            file.writeBytes(data)
        } catch (_: Exception) {}
    }

    @Synchronized
    fun getAvatarData(botId: String, revision: String): ByteArray? {
        val dir = avatarDir ?: return null
        val file = File(dir, "${digest(botId)}_${digest(revision)}.png")
        return if (file.exists()) file.readBytes() else null
    }

    fun putAvatar(botId: String, revision: String, data: ByteArray) = putAvatarData(botId, revision, data)
    fun getAvatar(botId: String, revision: String): ByteArray? = getAvatarData(botId, revision)

    @Synchronized
    fun purge(instanceId: String, deviceId: String) {
        val scope = digest("$instanceId\u001f$deviceId")
        File(cacheRoot, scope).deleteRecursively()
        File(avatarRoot, scope).deleteRecursively()
        if (activeScope == scope) {
            activeScope = null
            _botList.value = null
            _botDetails.value = emptyMap()
            _botConversations.value = null
        }
    }

    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
}
