#if DEBUG
import Foundation
import Synchronization

/// The demo Mac's Agent Slider (contract revision 66), only with
/// `-AidenDemoAgentSlider`, so no other launch changes. Every machine then
/// offers `chat:agent-slider`, this phone holds it, `/models` carries a
/// five-stop slider, and a chat's turns run: each reply says which model and
/// level the turn asked for, and the chat keeps that selection as the Mac does
/// for a phone that holds the capability.
enum AidenDemoAgentSlider {
    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains("-AidenDemoAgentSlider")
    }

    static let models: [(id: String, label: String)] = [
        ("claude-haiku-4-5", "Claude Haiku 4.5"),
        ("claude-sonnet-4-5", "Claude Sonnet 4.5"),
        ("claude-opus-4-5", "Claude Opus 4.5"),
    ]

    /// `GET /models` with the slider: Quick, Balanced (home), Deep, a stop on a
    /// provider this Mac isn't signed in to, and one with no model yet.
    static func modelsJSON() -> Data {
        let stops: [[String: Any]] = [
            ["id": "stop_quick", "label": "Quick", "providerId": "anthropic",
             "modelId": "claude-haiku-4-5", "thinkingLevel": "low", "availability": "ready"],
            ["id": "stop_balanced", "label": "Balanced", "providerId": "anthropic",
             "modelId": "claude-sonnet-4-5", "thinkingLevel": "medium", "availability": "ready"],
            ["id": "stop_deep", "label": "Deep", "providerId": "anthropic",
             "modelId": "claude-opus-4-5", "thinkingLevel": "high", "availability": "ready"],
            ["id": "stop_research", "label": "Research", "providerId": "openai",
             "modelId": "gpt-5", "thinkingLevel": "high", "availability": "not-signed-in"],
            ["id": "stop_spare", "label": "Spare", "availability": "unassigned"],
        ]
        return json([
            "providers": [[
                "id": "anthropic",
                "label": "Anthropic",
                "models": models.map { model in
                    [
                        "id": model.id,
                        "label": model.label,
                        "thinkingLevels": ["low", "medium", "high"],
                        "defaultThinkingLevel": "medium",
                    ] as [String: Any]
                },
            ]],
            "defaults": ["providerId": "anthropic", "modelId": "claude-sonnet-4-5"],
            "agentSlider": ["stops": stops, "homeStopId": "stop_balanced"],
        ])
    }

    /// What a reply says for a turn on this model and level.
    static func replyText(modelId: String?, thinkingLevel: String?) -> String {
        let model = models.first { $0.id == modelId }?.label ?? modelId ?? "the chat's model"
        return "Answered on \(model) at \(thinkingLevel ?? "its own") effort."
    }

    /// Runs turns in each chat: `POST /chats/{id}/turns`, the turn's stream,
    /// and the chat itself with the turns and the selection they sent.
    static func register(instanceId: String, chats: [(id: String, base: Data)], responder: AidenDemoResponder) {
        let log = TurnLog()
        for chat in chats {
            let chatId = chat.id
            let base = chat.base
            responder.reply(instanceId: instanceId, path: "/chats/\(chatId)", status: 200) { _ in
                chatJSON(base: base, turns: log.turns(in: chatId))
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
                    thinkingLevel: request["thinkingLevel"] as? String
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
        let at: Date

        var turnId: String { "turn_demo_\(number)" }
        var streamId: String { "stream_demo_\(number)" }
        var userMessageId: String { "message_demo_\(number)_user" }
        var replyMessageId: String { "message_demo_\(number)_assistant" }
    }

    /// The turns each chat has run, from the responder's queue.
    final class TurnLog: Sendable {
        private let state = Mutex<(next: Int, turns: [String: [Turn]])>((1, [:]))

        func start(chatId: String, text: String, providerId: String?, modelId: String?, thinkingLevel: String?) -> Turn {
            state.withLock { state in
                let turn = Turn(
                    number: state.next, text: text, providerId: providerId,
                    modelId: modelId, thinkingLevel: thinkingLevel, at: Date()
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

    private static func chatJSON(base: Data, turns: [Turn]) -> Data {
        guard var chat = (try? JSONSerialization.jsonObject(with: base)) as? [String: Any],
              let last = turns.last else { return base }
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
        // The Mac keeps the turn's selection, its level included.
        chat["providerId"] = last.providerId
        chat["modelId"] = last.modelId
        chat["thinkingLevel"] = last.thinkingLevel
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
