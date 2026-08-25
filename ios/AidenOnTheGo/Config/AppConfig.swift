import Foundation

enum AppConfig {
    static var botFirstMobileEnabled: Bool {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "AidenBotFirstEnabled") else {
            return false
        }
        if let number = value as? NSNumber { return number.boolValue }
        guard let string = value as? String else { return false }
        return ["1", "true", "yes"].contains(string.lowercased())
    }

    static var appGroupIdentifier: String {
        Bundle.main.object(forInfoDictionaryKey: "AidenAppGroupIdentifier") as? String
            ?? "group.sbtbiswas.AidenOnTheGo"
    }

    static let privacyPolicyURL = URL(staticString: "https://chatwithaiden.com/privacy")
    static let supportURL = URL(staticString: "https://chatwithaiden.com/")
}

extension URL {
    init(staticString string: StaticString) {
        let value = string.withUTF8Buffer { String(decoding: $0, as: UTF8.self) }
        guard let url = URL(string: value) else {
            preconditionFailure("Invalid static URL literal: \(value)")
        }
        self = url
    }
}
