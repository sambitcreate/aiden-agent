package sbtbiswas.AidenOnTheGo.features.shared.thinkingorbs

data class OrbSnapshot(
    val frame: OrbFrame,
    val time: Double,
    val mode: OrbMode,
    val size: Double
)
