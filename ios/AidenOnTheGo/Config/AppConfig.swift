import Foundation

enum AppConfig {
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
