package sbtbiswas.AidenOnTheGo.features.shared.thinkingorbs

enum class OrbMode(val wireName: String) {
    IDLE("idle"),
    CONNECTING("connecting"),
    PLANNING("planning"),
    THINKING("thinking"),
    READING("reading"),
    WRITING("writing"),
    SUCCESS("success"),
    ERROR("error")
}

data class OrbSpec(
    val mode: OrbMode,
    val dotCount: Int = 120,
    val speed: Double = 1.0,
    val radiusScalePow: Double = 0.6
)
