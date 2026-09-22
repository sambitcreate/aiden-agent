import Foundation

struct AidenNavigationRequest: Equatable, Sendable {
    enum Destination: Equatable, Sendable { case newChat, chat(String) }
    let destination: Destination
    let instanceId: String?
    let workspaceId: String?
    let startsVoice: Bool
}

enum AidenDeepLink {
    static var scheme: String {
        Bundle.main.object(forInfoDictionaryKey: "AidenURLScheme") as? String ?? "aiden-otg"
    }

    static var newChatURL: URL? { newChatURL(instanceId: nil, workspaceId: nil, startsVoice: false) }
    static var newChatVoiceURL: URL? { newChatURL(instanceId: nil, workspaceId: nil, startsVoice: true) }

    static func newChatURL(instanceId: String?, workspaceId: String?, startsVoice: Bool) -> URL? {
        guard instanceId.map(safeID) ?? true, workspaceId.map(safeID) ?? true else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = startsVoice ? "new-chat-voice" : "new-chat"
        components.queryItems = [
            instanceId.map { URLQueryItem(name: "instance", value: $0) },
            workspaceId.map { URLQueryItem(name: "workspace", value: $0) },
        ].compactMap { $0 }
        return components.url
    }

    static func chatURL(instanceId: String, chatId: String) -> URL? {
        guard safeID(instanceId), safeID(chatId) else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = "chat"
        components.queryItems = [
            URLQueryItem(name: "instance", value: instanceId),
            URLQueryItem(name: "chat", value: chatId),
        ]
        return components.url
    }

    static func request(from url: URL) -> AidenNavigationRequest? {
        guard url.scheme?.lowercased() == scheme.lowercased(),
              url.user == nil, url.password == nil, url.port == nil,
              url.fragment == nil, url.path.isEmpty else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count,
              items.allSatisfy({ $0.value != nil }),
              items.allSatisfy({ $0.name == "instance" || $0.name == "workspace" || $0.name == "chat" }) else {
            return nil
        }
        func value(_ name: String) -> String? { items.first(where: { $0.name == name })?.value }
        let instance = value("instance")
        let workspace = value("workspace")
        guard instance.map(safeID) ?? true, workspace.map(safeID) ?? true else { return nil }
        switch url.host?.lowercased() {
        case "new-chat", "new-chat-voice":
            guard value("chat") == nil else { return nil }
            return AidenNavigationRequest(
                destination: .newChat,
                instanceId: instance,
                workspaceId: workspace,
                startsVoice: url.host?.lowercased() == "new-chat-voice"
            )
        case "chat":
            guard let instance, let chat = value("chat"), safeID(chat), workspace == nil else { return nil }
            return AidenNavigationRequest(
                destination: .chat(chat), instanceId: instance, workspaceId: nil, startsVoice: false
            )
        default:
            return nil
        }
    }

    private static func safeID(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 160
            && value.unicodeScalars.allSatisfy { scalar in
                CharacterSet.alphanumerics.contains(scalar) || "._:-".unicodeScalars.contains(scalar)
            }
    }
}
