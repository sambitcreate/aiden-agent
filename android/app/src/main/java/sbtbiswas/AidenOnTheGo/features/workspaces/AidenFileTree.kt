package sbtbiswas.AidenOnTheGo.features.workspaces

import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileEntry
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileKind

object AidenFileTree {
    fun rows(entries: List<AidenWorkspaceFileEntry>, expanded: Set<String>, query: String): List<AidenWorkspaceFileEntry> {
        val paths = entries.associateBy { it.displayPath }.toMutableMap()
        entries.forEach { entry ->
            val segments = entry.displayPath.split('/')
            for (depth in 1 until segments.size) {
                val path = segments.take(depth).joinToString("/")
                paths.putIfAbsent(path, AidenWorkspaceFileEntry("ui-directory:$path", path, segments[depth - 1], AidenWorkspaceFileKind.DIRECTORY))
            }
        }
        return paths.values.filter { entry ->
            if (query.isNotBlank()) entry.displayPath.contains(query, ignoreCase = true)
            else {
                val segments = entry.displayPath.split('/')
                (1 until segments.size).all { segments.take(it).joinToString("/") in expanded }
            }
        }.sortedBy { it.displayPath }
    }
}

enum class AidenDiffLineKind { HEADER, ADDITION, DELETION, CONTEXT }
fun aidenDiffLineKind(line: String): AidenDiffLineKind = when {
    line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ") -> AidenDiffLineKind.HEADER
    line.startsWith("+") -> AidenDiffLineKind.ADDITION
    line.startsWith("-") -> AidenDiffLineKind.DELETION
    else -> AidenDiffLineKind.CONTEXT
}
