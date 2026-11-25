#if DEBUG
import Foundation
import Synchronization

/// The demo Mac's Agent Slider (contract revision 66), only with
/// `-AidenDemoAgentSlider`, so no other launch changes. Every machine then
/// offers `chat:agent-slider`, this phone holds it, `/models` carries a
/// five-stop slider, and a chat's turns run: each reply says which model and
/// level the turn asked for. As the Mac does for a phone that holds the
/// capability, the chat keeps a turn's level only when the turn sends
/// `saveSelection`; any other turn runs at its level once, and a model change
/// without it leaves the chat with no level.
enum AidenDemoAgentSlider {
    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains("-AidenDemoAgentSlider")
    }

    static let models: [(id: String, label: String)] = [
        ("demo-small", "Demo Small"),
        ("demo-medium", "Demo Medium"),
        ("demo-large", "Demo Large"),
    ]

    /// The ready stops: label, model and level.
    static let readyStops: [(id: String, label: String, modelId: String, level: String)] = [
        ("stop_quick", "Quick", "demo-small", "low"),
        ("stop_balanced", "Balanced", "demo-medium", "medium"),
        ("stop_deep", "Deep", "demo-large", "high"),
    ]

    /// `GET /models` with the slider: Quick, Balanced (home), Deep, a stop on a
    /// provider this Mac isn't signed in to, and one with no model yet.
    static func modelsJSON() -> Data {
        var stops: [[String: Any]] = readyStops.map { stop in
            [
                "id": stop.id, "label": stop.label, "providerId": "demo",
                "modelId": stop.modelId, "modelLabel": models.first { $0.id == stop.modelId }?.label ?? stop.modelId,
                "providerLabel": "Demo", "thinkingLevel": stop.level, "availability": "ready",
            ]
        }
        stops.append(["id": "stop_research", "label": "Research", "availability": "not-signed-in",
                      "providerLabel": "Other Provider", "modelLabel": "Other Model"])
        stops.append(["id": "stop_spare", "label": "Spare", "availability": "unassigned"])
        return json([
            "providers": [[
                "id": "demo",
                "label": "Demo",
                "models": models.map { model in
                    [
                        "id": model.id,
                        "label": model.label,
                        "thinkingLevels": ["low", "medium", "high"],
                        "defaultThinkingLevel": "medium",
                    ] as [String: Any]
                },
            ]],
            "defaults": ["providerId": "demo", "modelId": "demo-medium", "thinkingLevel": "medium"],
            "agentSlider": ["stops": stops, "homeStopId": "stop_balanced"],
        ])
    }

    /// What a reply says for a turn on this model and level: the stop it
    /// matches, so the copy follows the slider rather than a model's name.
    static func replyText(modelId: String?, thinkingLevel: String?) -> String {
        if let stop = readyStops.first(where: { $0.modelId == modelId && $0.level == thinkingLevel }) {
            return "Answered on the \(stop.label) stop."
        }
        return "Answered off the slider."
    }

    /// A chat that runs turns. A new one starts with no model or level, as
    /// a chat the Mac just made does; any other starts on the home stop.
    struct Chat: Sendable {
        let id: String
        let base: Data
        let isNew: Bool
    }

    /// Runs turns in each chat: `POST /chats/{id}/turns`, the turn's stream,
    /// and the chat itself with the turns and the selection they sent.
    static func register(instanceId: String, chats: [Chat], responder: AidenDemoResponder) {
        let log = TurnLog()
        for chat in chats {
            let chatId = chat.id
            let base = chat.base
            let isNew = chat.isNew
            responder.reply(instanceId: instanceId, path: "/chats/\(chatId)", status: 200) { _ in
                chatJSON(base: base, isNew: isNew, turns: log.turns(in: chatId))
            }
            responder.reply(
                instanceId: instanceId,
                method: "POST",
                path: "/chats/\(chatId)/turns",
                status: 202
            ) { [weak responder] _, body in
                let request = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
                let turn = log.start(
                    chatId: chatId,
                    text: request["text"] as? String ?? "",
                    providerId: request["providerId"] as? String,
                    modelId: request["modelId"] as? String,
                    thinkingLevel: request["thinkingLevel"] as? String,
                    savesSelection: request["saveSelection"] as? Bool == true
                )
                responder?.reply(
                    instanceId: instanceId,
                    path: "/streams/\(turn.streamId)/events",
                    status: 200,
                    json: streamBody(turn, chatId: chatId)
                )
                return json([
                    "turnId": turn.turnId,
                    "streamId": turn.streamId,
                    "status": "running",
                    "message": userMessage(turn),
                ])
            }
        }
    }

    struct Turn: Sendable {
        let number: Int
        let text: String
        let providerId: String?
        let modelId: String?
        let thinkingLevel: String?
        let savesSelection: Bool
        let at: Date

        var turnId: String { "turn_demo_\(number)" }
        var streamId: String { "stream_demo_\(number)" }
        var userMessageId: String { "message_demo_\(number)_user" }
        var replyMessageId: String { "message_demo_\(number)_assistant" }
    }

    /// The turns each chat has run, from the responder's queue.
    final class TurnLog: Sendable {
        private let state = Mutex<(next: Int, turns: [String: [Turn]])>((1, [:]))

        func start(
            chatId: String, text: String, providerId: String?, modelId: String?,
            thinkingLevel: String?, savesSelection: Bool
        ) -> Turn {
            state.withLock { state in
                let turn = Turn(
                    number: state.next, text: text, providerId: providerId, modelId: modelId,
                    thinkingLevel: thinkingLevel, savesSelection: savesSelection, at: Date()
                )
                state.next += 1
                state.turns[chatId, default: []].append(turn)
                return turn
            }
        }

        func turns(in chatId: String) -> [Turn] {
            state.withLock { $0.turns[chatId] ?? [] }
        }
    }

    private static func chatJSON(base: Data, isNew: Bool, turns: [Turn]) -> Data {
        guard var chat = (try? JSONSerialization.jsonObject(with: base)) as? [String: Any] else { return base }
        // Before any phone turn the chat sits on the home stop, as a chat the
        // Mac last ran there does. A copy this phone cached on an earlier
        // launch then can't decide the stop. A new chat has no level.
        var selection: (providerId: String?, modelId: String?, level: String?) =
            isNew ? (nil, nil, nil) : ("demo", "demo-medium", "medium")
        for turn in turns {
            if turn.savesSelection, turn.providerId != nil, turn.modelId != nil {
                selection = (turn.providerId, turn.modelId, turn.thinkingLevel)
            } else if let modelId = turn.modelId {
                // A turn that doesn't save still moves the chat to its model,
                // and a level is kept only while the model stays the same.
                if modelId != selection.modelId || turn.providerId != selection.providerId { selection.level = nil }
                selection.providerId = turn.providerId ?? selection.providerId
                selection.modelId = modelId
            }
        }
        chat["providerId"] = selection.providerId
        chat["modelId"] = selection.modelId
        chat["thinkingLevel"] = selection.level
        guard let last = turns.last else { return json(chat) }
        var messages = chat["messages"] as? [[String: Any]] ?? []
        for turn in turns {
            messages.append(userMessage(turn))
            messages.append([
                "id": turn.replyMessageId, "role": "assistant",
                "text": replyText(modelId: turn.modelId, thinkingLevel: turn.thinkingLevel),
                "createdAt": timestamp(turn.at),
            ])
        }
        chat["messages"] = messages
        chat["updatedAt"] = timestamp(last.at)
        chat["revision"] = "chat_revision_turn_\(last.number)"
        return json(chat)
    }

    private static func userMessage(_ turn: Turn) -> [String: Any] {
        ["id": turn.userMessageId, "role": "user", "text": turn.text, "createdAt": timestamp(turn.at)]
    }

    private static func streamBody(_ turn: Turn, chatId: String) -> Data {
        let events: [(String, Bool, [String: Any])] = [
            ("snapshot", false, ["chatId": chatId, "turnId": turn.turnId, "nextSequence": 2]),
            ("status", false, ["state": "running"]),
            ("text_delta", false, ["text": replyText(modelId: turn.modelId, thinkingLevel: turn.thinkingLevel)]),
            ("done", true, ["messageId": turn.replyMessageId]),
        ]
        let frames = events.enumerated().map { index, event in
            let frame: [String: Any] = [
                "protocolVersion": 1, "streamId": turn.streamId, "sequence": index + 1,
                "timestamp": timestamp(turn.at), "type": event.0, "terminal": event.1, "payload": event.2,
            ]
            return "id: \(index + 1)\nevent: \(event.0)\ndata: \(String(decoding: json(frame), as: UTF8.self))\n\n"
        }
        return Data(frames.joined().utf8)
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func json(_ object: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }
}
#endif
