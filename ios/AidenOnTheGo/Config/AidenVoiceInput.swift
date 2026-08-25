import Foundation

enum AidenVoiceInputMode: String, CaseIterable, Identifiable, Codable, Sendable {
    case onDevice
    case pairedMac

    static let defaultsKey = "aiden.voiceInput.mode"

    var id: String { rawValue }
    var title: String { self == .onDevice ? String(localized: "On this device") : String(localized: "Paired Mac") }

    static var selected: AidenVoiceInputMode {
        AidenVoiceInputMode(rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? "") ?? .onDevice
    }
}
