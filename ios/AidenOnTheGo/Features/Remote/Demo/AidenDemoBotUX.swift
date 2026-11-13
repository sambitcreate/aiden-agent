#if DEBUG
import Foundation

/// `-AidenDemoBotUX`: the demo Mac offers contract revision 61, so screenshots
/// and UI tests reach the typed approval cards, the Bot's settings-change and
/// suggestion cards, Templates, one-field New Bot and Settings → Approvals.
/// The shapes follow `protocol/aiden-remote/v1/fixtures/bot-ux-revision-61.json`.
enum AidenDemoBotUX {
    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains("-AidenDemoBotUX")
    }

    /// The Bot waits on a hand-off instead of an approval, for the two-step Take control card.
    static var waitsOnAHandoff: Bool {
        ProcessInfo.processInfo.arguments.contains("-AidenDemoBotUXHandoff")
    }

    static func handoff() -> [String: Any] {
        [
            "waitId": "9e2f3a4b-5c6d-4e7f-8a9b-b2c3d4e5f6a7", "kind": "action",
            "action": "Approve the payment in your bank's app",
            "why": "Only you can confirm a payment.",
            "open": ["url": "https://bank.example.com/approve"],
        ]
    }

    private static func data(_ value: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// The Bot's revision 61 entries, after its first two messages.
    static func entries(now: Date) -> [[String: Any]] {
        let at = timestamp(now.addingTimeInterval(-3_600))
        return [
            [
                "type": "settings_change", "id": "entry_demo_ux_1", "changeId": "change_demo_held",
                "mode": "held", "status": "pending", "title": "Update instructions?",
                "fields": ["instructions"], "lines": ["Instructions: 2 lines changed"],
                "heldReason": "outside_content",
                "instructions": "Plan my week.\nKeep Fridays free after 3 PM.\nAsk before booking travel.",
                "previousInstructions": "Plan my week.\nAsk before booking travel.",
                "instructionsDiff": [
                    ["kind": "same", "text": "Plan my week."],
                    ["kind": "added", "text": "Keep Fridays free after 3 PM."],
                    ["kind": "same", "text": "Ask before booking travel."],
                ],
                "undoable": false, "createdAt": at,
            ],
            [
                "type": "settings_change", "id": "entry_demo_ux_2", "changeId": "change_demo_applied",
                "mode": "applied", "status": "pending", "title": "Settings updated",
                "fields": ["name"], "lines": ["Name: Planner → Scout"], "undoable": true, "createdAt": at,
            ],
            [
                "type": "skill_proposal", "id": "entry_demo_ux_3",
                "proposalId": "8d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a62",
                "name": "Weekly review", "description": "Sum up the week every Friday.",
                "reason": "You asked for this three weeks running.", "update": false,
                "preview": "# Weekly review\n\nList what moved, what slipped and what is next.",
                "status": "pending", "createdAt": at,
            ],
            [
                "type": "lesson", "id": "entry_demo_ux_4", "lessonId": "lesson_demo_1", "kind": "proposal",
                "text": "Skip meetings before 9 AM.", "routineName": "Weekly plan", "runs": 3,
                "status": "pending", "createdAt": at,
            ],
            [
                "type": "lesson", "id": "entry_demo_ux_5", "lessonId": "lesson_demo_2", "kind": "learned",
                "text": "Times in 24-hour format.", "status": "active", "createdAt": at,
            ],
            ["type": "memory_tidy", "id": "entry_demo_ux_6", "changeId": "learning_demo_1", "createdAt": at],
        ]
    }

    /// The card a Bot approval carries: Deny, Allow once, Always allow this tool.
    static func botApproval() -> [String: Any] {
        [
            "waitId": "8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f7",
            "toolCallId": "call_demo_ux", "toolName": "web_fetch",
            "summary": "Fetch https://example.com/menu", "canAllow": true, "alwaysCount": 4,
            "card": [
                "kind": "generic", "title": "Review before Fetch web page → example.com",
                "arguments": [["key": "site", "value": "example.com"], ["key": "tool", "value": "Fetch web page"]],
                "body": ["format": "text", "text": "Fetch https://example.com/menu"],
                "notes": ["You’ve allowed this 4 times in the last 2 weeks."],
                "buttons": [
                    ["label": "Deny", "decision": "deny", "answered": "Denied"],
                    ["label": "Allow once", "decision": "allow", "answered": "Allowed once"],
                    ["label": "Always allow this tool", "decision": "allow", "scope": "always", "answered": "Always allowed"],
                ],
            ] as [String: Any],
        ]
    }

    /// The card a chat's run approval carries, for `-AidenDemoLateChatApproval`.
    static func runApprovalFields(summary: String) -> [String: Any] {
        [
            "scopes": ["once", "chat"],
            "card": [
                "kind": "mac", "mac": "shell", "title": "Run on your Mac?",
                "arguments": [["key": "tool", "value": "Run command"]],
                "body": ["format": "command", "text": summary],
                "buttons": [
                    ["label": "Deny", "decision": "deny", "answered": "Denied"],
                    ["label": "Allow once", "decision": "allow", "answered": "Allowed once"],
                    ["label": "Allow in this chat", "decision": "allow", "scope": "chat", "answered": "Allowed in this chat"],
                ],
            ] as [String: Any],
        ]
    }

    private static func catalog() -> [String: Any] {
        func option(_ id: String, _ label: String) -> [String: Any] { ["id": id, "label": label, "available": true] }
        return [
            "revision": "catalog_demo_61",
            "providers": [["id": "provider_demo", "label": "Demo provider", "available": true,
                           "models": [["id": "model_demo", "label": "Demo model", "available": true, "supportsImages": true]]]],
            "fileScopes": [
                ["id": "scope_full", "label": "Your whole Mac", "available": true, "kind": "full_mac"],
                ["id": "scope_home", "label": "Its own folder", "available": true, "kind": "bot_home"],
            ],
            "shellAvailable": true,
            "connections": [option("connection_mail", "Mail"), option("connection_calendar", "Calendar")],
            "skills": [option("skill_notes", "Notes")],
            "skillsEnabled": true,
            "otherCapabilities": [option("capability_web", "Web search")],
        ]
    }

    private static let rules: [String: Any] = [
        "rows": [
            ["ref": ["source": "rule", "id": "rule_demo_01"], "group": "allow", "title": "github.com", "kind": "Site",
             "scope": ["kind": "mac"], "decisions": ["allow", "ask", "block"]],
            ["ref": ["source": "rule", "id": "rule_demo_02"], "group": "block", "title": "Send email", "kind": "Tool",
             "scope": ["kind": "workspace", "label": "Docs"], "decisions": ["allow", "ask", "block"]],
            ["ref": ["source": "rule", "id": "rule_demo_03"], "group": "ask",
             "title": "When a Bot wants to post in public channels", "kind": "When a Bot wants to",
             "scope": ["kind": "mac"], "decisions": ["ask", "block"], "handOff": ["on": true]],
            ["ref": ["source": "workspace-mac", "workspaceId": "workspace_app", "grant": "shell"], "group": "mac",
             "title": "Run commands", "kind": "Mac", "scope": ["kind": "workspace", "label": "Aiden Agent"], "decisions": []],
        ],
    ]

    /// The routes the revision 61 screens read and write on the demo Mac.
    static func register(instanceId id: String, botId: String, responder: AidenDemoResponder) {
        let waitId = botApproval()["waitId"] as? String ?? ""
        responder.reply(instanceId: id, method: "POST", path: "/approvals/\(waitId)/respond", status: 200, json: data([
            "approvalId": waitId, "decision": "allow", "resolvedAt": timestamp(Date()),
        ]))
        let catalog = data(catalog())
        responder.reply(instanceId: id, path: "/bot-capabilities", status: 200, json: catalog)
        responder.reply(instanceId: id, path: "/bot-capabilities", query: "botId=\(botId)", status: 200, json: catalog)
        let mode = data(["mode": "ask", "autoAvailable": false])
        responder.reply(instanceId: id, path: "/approvals/mode", status: 200, json: mode)
        responder.reply(instanceId: id, method: "PUT", path: "/approvals/mode", status: 200, json: mode)
        responder.reply(instanceId: id, path: "/approvals/rules", status: 200, json: data(rules))
        for route in ["/approvals/rules", "/approvals/rules/change", "/approvals/rules/remove"] {
            responder.reply(instanceId: id, method: "POST", path: route, status: 200, json: data(rules))
        }
        responder.reply(instanceId: id, path: "/approvals/rules/picker", status: 200, json: data(["options": [
            ["target": ["kind": "tool", "tool": "send_email"], "label": "Send email", "group": "Aiden"],
            ["target": ["kind": "tool", "tool": "run_command"], "label": "Run commands", "group": "Aiden"],
            ["target": ["kind": "connector", "serverId": "calendar"], "label": "Calendar", "group": "Connected apps",
             "description": "Every tool of this app"],
        ]]))
        responder.reply(instanceId: id, path: "/bot-presets", status: 200, json: data(["presets": [
            [
                "id": "meal-planner", "name": "Meal planner", "subtitle": "Plans the week's meals",
                "avatar": ["version": 1, "shape": "hex", "color": "periwinkle"], "suggestedConnections": [],
                "suggestedRoutine": ["name": "Weekly meal plan", "label": "Every Sunday at 9:00 AM"],
                "version": 2, "instructions": "Plan the week's meals around what I like.",
                "sample": ["What should we eat this week?", "Here's a plan for seven dinners."],
            ],
            [
                "id": "week-planner", "name": "Week planner", "subtitle": "Keeps your week in order",
                "avatar": ["version": 1, "shape": "orb", "color": "mint"], "suggestedConnections": [],
                "version": 3, "instructions": "Plan my week.",
                "sample": ["What's on this week?"], "existingBotId": botId,
            ],
        ]]))
    }
}
#endif
