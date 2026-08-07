//! Port of `renderer/shared/claim-check.ts` — detection of narrow
//! false-success cases from renderer-safe evidence only.
//!
//! The TypeScript implementation uses a set of hand-written `RegExp` literals.
//! `aiden-core` must stay free of non-serde dependencies, so this module ships
//! a small backtracking matcher for the bounded grammar those literals use
//! (literals, `(?:...)` groups, alternation, `?`/`+`/`{m,n}` repetition,
//! character classes, `\s`/`\w`/`\d`/`\b`, and multiline `^`/`$` anchors) and
//! parses the exact JS pattern sources. Indexes are char-based (UTF-16-code-
//! unit indexes in JS); they coincide for the ASCII evidence the detector is
//! applied to.

use std::sync::OnceLock;

use crate::{
    AgentStep, AgentStepStatus, AgentToolStep, GenerationClaimCheck, GenerationTimeline,
    GenerationTimelineStatus,
};

// ===========================================================================
// Tiny regex subset
// ===========================================================================

#[derive(Debug, Clone)]
enum ClassMember {
    Char(char),
    Range(char, char),
    Space,
    Word,
    Digit,
}

#[derive(Debug, Clone)]
struct CharClass {
    negated: bool,
    members: Vec<ClassMember>,
}

#[derive(Debug, Clone)]
enum Node {
    Seq(Vec<Node>),
    /// Alternatives, each a sequence.
    Alt(Vec<Vec<Node>>),
    Lit(char),
    Class(CharClass),
    Start,
    End,
    WordBoundary,
    Repeat(Box<Node>, usize, Option<usize>),
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn new(source: &str) -> Self {
        Self {
            chars: source.chars().collect(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn parse_alt(&mut self) -> Node {
        let mut alternatives = vec![self.parse_seq()];
        while self.peek() == Some('|') {
            self.pos += 1;
            alternatives.push(self.parse_seq());
        }
        if alternatives.len() == 1 {
            Node::Seq(alternatives.pop().unwrap())
        } else {
            Node::Alt(alternatives)
        }
    }

    fn parse_seq(&mut self) -> Vec<Node> {
        let mut items: Vec<Node> = Vec::new();
        loop {
            match self.peek() {
                None | Some('|') | Some(')') => break,
                Some('^') => {
                    self.pos += 1;
                    items.push(Node::Start);
                }
                Some('$') => {
                    self.pos += 1;
                    items.push(Node::End);
                }
                _ => {
                    let atom = self.parse_atom();
                    match self.peek() {
                        Some('?') => {
                            self.pos += 1;
                            items.push(Node::Repeat(Box::new(atom), 0, Some(1)));
                        }
                        Some('+') => {
                            self.pos += 1;
                            items.push(Node::Repeat(Box::new(atom), 1, None));
                        }
                        Some('{') => {
                            if let Some((min, max)) = self.parse_braced_quantifier() {
                                items.push(Node::Repeat(Box::new(atom), min, max));
                            } else {
                                items.push(atom);
                            }
                        }
                        _ => items.push(atom),
                    }
                }
            }
        }
        items
    }

    fn parse_braced_quantifier(&mut self) -> Option<(usize, Option<usize>)> {
        if self.peek() != Some('{') {
            return None;
        }
        let start = self.pos;
        self.pos += 1;
        let mut min_digits = String::new();
        while let Some(digit) = self.peek() {
            if digit.is_ascii_digit() {
                min_digits.push(digit);
                self.pos += 1;
            } else {
                break;
            }
        }
        if min_digits.is_empty() {
            self.pos = start;
            return None;
        }
        let max: Option<usize> = if self.peek() == Some(',') {
            self.pos += 1;
            let mut max_digits = String::new();
            while let Some(digit) = self.peek() {
                if digit.is_ascii_digit() {
                    max_digits.push(digit);
                    self.pos += 1;
                } else {
                    break;
                }
            }
            if max_digits.is_empty() {
                None
            } else {
                max_digits.parse().ok()
            }
        } else {
            Some(min_digits.parse().ok()?)
        };
        if self.peek() != Some('}') {
            self.pos = start;
            return None;
        }
        self.pos += 1;
        Some((min_digits.parse().ok()?, max))
    }

    fn parse_atom(&mut self) -> Node {
        match self.peek() {
            Some('(') => {
                self.pos += 1;
                // Our patterns only use non-capturing groups.
                if self.peek() == Some('?') && self.chars.get(self.pos + 1) == Some(&':') {
                    self.pos += 2;
                }
                let node = self.parse_alt();
                if self.peek() == Some(')') {
                    self.pos += 1;
                }
                node
            }
            Some('[') => self.parse_class(),
            Some('\\') => self.parse_escape(),
            Some(ch) => {
                self.pos += 1;
                Node::Lit(ch)
            }
            _ => Node::Seq(Vec::new()),
        }
    }

    fn parse_class(&mut self) -> Node {
        self.pos += 1; // '['
        let negated = if self.peek() == Some('^') {
            self.pos += 1;
            true
        } else {
            false
        };
        let mut members: Vec<ClassMember> = Vec::new();
        loop {
            let ch = match self.peek() {
                Some(']') => {
                    self.pos += 1;
                    break;
                }
                Some(ch) => ch,
                None => break,
            };
            if ch == '\\' {
                self.pos += 1;
                match self.peek() {
                    Some('s') => {
                        members.push(ClassMember::Space);
                        self.pos += 1;
                    }
                    Some('w') => {
                        members.push(ClassMember::Word);
                        self.pos += 1;
                    }
                    Some('d') => {
                        members.push(ClassMember::Digit);
                        self.pos += 1;
                    }
                    Some(escaped) => {
                        let literal = match escaped {
                            'n' => '\n',
                            't' => '\t',
                            other => other,
                        };
                        members.push(ClassMember::Char(literal));
                        self.pos += 1;
                    }
                    None => break,
                }
                continue;
            }
            // Range detection: `a-z` where '-' follows a char member.
            if ch == '-' {
                let has_prev_char = matches!(members.last(), Some(ClassMember::Char(_)));
                if has_prev_char
                    && self
                        .chars
                        .get(self.pos + 1)
                        .map(|next| *next != ']')
                        .unwrap_or(false)
                {
                    let end = self.chars[self.pos + 1];
                    let start = match members.pop() {
                        Some(ClassMember::Char(start)) => start,
                        _ => unreachable!(),
                    };
                    members.push(ClassMember::Range(start, end));
                    self.pos += 2;
                    continue;
                }
            }
            members.push(ClassMember::Char(ch));
            self.pos += 1;
        }
        Node::Class(CharClass { negated, members })
    }

    fn parse_escape(&mut self) -> Node {
        self.pos += 1; // '\'
        match self.peek() {
            Some('s') => {
                self.pos += 1;
                Node::Class(CharClass {
                    negated: false,
                    members: vec![ClassMember::Space],
                })
            }
            Some('w') => {
                self.pos += 1;
                Node::Class(CharClass {
                    negated: false,
                    members: vec![ClassMember::Word],
                })
            }
            Some('d') => {
                self.pos += 1;
                Node::Class(CharClass {
                    negated: false,
                    members: vec![ClassMember::Digit],
                })
            }
            Some('b') => {
                self.pos += 1;
                Node::WordBoundary
            }
            Some('n') => {
                self.pos += 1;
                Node::Lit('\n')
            }
            Some('t') => {
                self.pos += 1;
                Node::Lit('\t')
            }
            Some(other) => {
                self.pos += 1;
                Node::Lit(other)
            }
            None => Node::Lit('\\'),
        }
    }
}

fn parse_pattern(source: &str) -> Node {
    Parser::new(source).parse_alt()
}

fn is_js_space(ch: char) -> bool {
    matches!(
        ch,
        ' ' | '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn is_js_word(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

fn eq_ci(a: char, b: char) -> bool {
    a == b || a.eq_ignore_ascii_case(&b)
}

fn member_matches(member: &ClassMember, ch: char) -> bool {
    match member {
        ClassMember::Char(expect) => *expect == ch,
        ClassMember::Range(start, end) => *start <= ch && ch <= *end,
        ClassMember::Space => is_js_space(ch),
        ClassMember::Word => is_js_word(ch),
        ClassMember::Digit => ch.is_ascii_digit(),
    }
}

/// Class membership under the `i` flag: any case variant of the text char may
/// satisfy the positive members; a negated class requires none of them to.
fn class_matches(class: &CharClass, ch: char) -> bool {
    let variants = [ch, ch.to_ascii_lowercase(), ch.to_ascii_uppercase()];
    let hit = class.members.iter().any(|member| {
        variants
            .iter()
            .any(|variant| member_matches(member, *variant))
    });
    if class.negated {
        !hit
    } else {
        hit
    }
}

fn match_node(node: &Node, text: &[char], pos: usize, ends: &mut Vec<usize>) {
    match node {
        Node::Lit(ch) => {
            if pos < text.len() && eq_ci(*ch, text[pos]) {
                ends.push(pos + 1);
            }
        }
        Node::Class(class) => {
            if pos < text.len() && class_matches(class, text[pos]) {
                ends.push(pos + 1);
            }
        }
        Node::Start => {
            if pos == 0 || text.get(pos.wrapping_sub(1)) == Some(&'\n') {
                ends.push(pos);
            }
        }
        Node::End => {
            if pos == text.len() || text.get(pos) == Some(&'\n') {
                ends.push(pos);
            }
        }
        Node::WordBoundary => {
            let left = pos > 0 && is_js_word(text[pos - 1]);
            let right = pos < text.len() && is_js_word(text[pos]);
            if left != right {
                ends.push(pos);
            }
        }
        Node::Seq(items) => match_seq(items, text, pos, ends),
        Node::Alt(alternatives) => {
            for alternative in alternatives {
                match_seq(alternative, text, pos, ends);
            }
        }
        Node::Repeat(node, min, max) => match_repeat(node, text, pos, *min, *max, ends),
    }
}

fn match_seq(items: &[Node], text: &[char], pos: usize, ends: &mut Vec<usize>) {
    if items.is_empty() {
        ends.push(pos);
        return;
    }
    let mut child_ends = Vec::new();
    match_node(&items[0], text, pos, &mut child_ends);
    for end in child_ends {
        match_seq(&items[1..], text, end, ends);
    }
}

fn match_repeat(
    node: &Node,
    text: &[char],
    pos: usize,
    min: usize,
    max: Option<usize>,
    ends: &mut Vec<usize>,
) {
    fn go(
        node: &Node,
        text: &[char],
        pos: usize,
        count: usize,
        min: usize,
        max: Option<usize>,
        ends: &mut Vec<usize>,
    ) {
        if count >= min {
            ends.push(pos);
        }
        if max.is_some_and(|limit| count >= limit) {
            return;
        }
        let mut child_ends = Vec::new();
        match_node(node, text, pos, &mut child_ends);
        for end in child_ends {
            if end > pos {
                go(node, text, end, count + 1, min, max, ends);
            }
        }
    }
    go(node, text, pos, 0, min, max, ends);
}

/// Does the pattern match at `pos`? (Any end position counts.)
fn matches_at(pattern: &Node, text: &[char], pos: usize) -> bool {
    let mut ends = Vec::new();
    match_node(pattern, text, pos, &mut ends);
    !ends.is_empty()
}

/// All start indexes where the pattern matches.
fn all_match_indexes(pattern: &Node, text: &[char]) -> Vec<usize> {
    let mut indexes = Vec::new();
    for pos in 0..=text.len() {
        if matches_at(pattern, text, pos) {
            indexes.push(pos);
        }
    }
    indexes
}

// ===========================================================================
// Claim-check logic
// ===========================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConsequentialStepKind {
    File,
    Command,
    Computer,
    Schedule,
    Connector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SuccessClaimKind {
    Consequential(ConsequentialStepKind),
    Generic,
}

const SUCCESS_PATTERN_SOURCES: &[(SuccessClaimKind, &str)] = &[
    (SuccessClaimKind::Generic, r"^(?:[-*]\s*)?(?:all\s+)?done\b"),
    (
        SuccessClaimKind::Generic,
        r"\b(?:the\s+)?(?:task|request|work|fix|implementation)\s+(?:is|was|has been)\s+(?:now\s+)?(?:done|complete|completed|finished|fixed|implemented|resolved)\b",
    ),
    (
        SuccessClaimKind::Generic,
        r"\b(?:i|we)(?:['’]ve| have)?\s+(?:successfully\s+)?(?:completed|finished|fixed|implemented|resolved)\s+(?:the\s+)?(?:task|request|work|change|fix|issue|implementation)\b",
    ),
    (
        SuccessClaimKind::Consequential(ConsequentialStepKind::File),
        r"\b(?:i|we)(?:['’]ve| have)?\s+(?:successfully\s+)?(?:updated|created|saved|applied|wrote|edited|fixed|implemented)\s+(?:it|them|(?:the\s+)?(?:files?|changes?|fix|docs?|code|config(?:uration)?))\b",
    ),
    (
        SuccessClaimKind::Consequential(ConsequentialStepKind::File),
        r"^(?:[-*]\s*)?(?:changes?|files?|docs?|code|config(?:uration)?)\s+(?:successfully\s+)?(?:updated|created|saved|fixed|applied|completed)\b",
    ),
    (
        SuccessClaimKind::Consequential(ConsequentialStepKind::Command),
        r"\b(?:tests?|checks?|build|lint|type[- ]?check|command)\s+(?:all\s+)?(?:pass(?:ed|es)?|succeeded|completed|finished)\b",
    ),
    (
        SuccessClaimKind::Consequential(ConsequentialStepKind::Command),
        r"\b(?:i|we)(?:['’]ve| have)?\s+(?:successfully\s+)?ran\s+(?:the\s+)?(?:tests?|checks?|build|lint|type[- ]?check|command)\b",
    ),
    (
        SuccessClaimKind::Consequential(ConsequentialStepKind::Schedule),
        r"\b(?:i|we)(?:['’]ve| have)?\s+(?:successfully\s+)?(?:scheduled|created|paused|resumed|removed)\s+(?:the\s+)?(?:scheduled\s+)?task\b",
    ),
    (
        SuccessClaimKind::Consequential(ConsequentialStepKind::Computer),
        r"\b(?:i|we)(?:['’]ve| have)?\s+(?:successfully\s+)?(?:opened|clicked|typed|selected|dragged|scrolled)\s+(?:it|the\s+(?:app|button|field|window|item|page))\b",
    ),
];

const FAILURE_MARKER: &str = r"(?:fail(?:ed|ure)?|blocked|denied|cancelled|canceled|unable to|could not|couldn't|did not|didn't|not)";

const ACKNOWLEDGEMENT_ACTIONS: &[(ConsequentialStepKind, &str)] = &[
    (
        ConsequentialStepKind::File,
        r"(?:edit(?:ed|ing)?|writ(?:e|ten|ing)|updat(?:e|ed|ing)|sav(?:e|ed|ing)|appl(?:y|ied|ying)|files?|changes?|docs?|code|config(?:uration)?)",
    ),
    (
        ConsequentialStepKind::Command,
        r"(?:tests?|checks?|build|lint|type[- ]?check|commands?|run|execution)",
    ),
    (
        ConsequentialStepKind::Computer,
        r"(?:computer|mac|app|button|field|window|click|typ(?:e|ed|ing)|drag|scroll|selection?)",
    ),
    (
        ConsequentialStepKind::Schedule,
        r"(?:schedul(?:e|ed|ing)|tasks?|cron|run)",
    ),
    (
        ConsequentialStepKind::Connector,
        r"(?:mcp|connector|tools?|calls?)",
    ),
];

struct CompiledPatterns {
    success: Vec<(SuccessClaimKind, Node)>,
    acknowledgement: Vec<(ConsequentialStepKind, Vec<Node>)>,
}

fn compiled_patterns() -> &'static CompiledPatterns {
    static PATTERNS: OnceLock<CompiledPatterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let success = SUCCESS_PATTERN_SOURCES
            .iter()
            .map(|(kind, source)| (*kind, parse_pattern(source)))
            .collect();
        let acknowledgement = ACKNOWLEDGEMENT_ACTIONS
            .iter()
            .map(|(kind, action)| {
                let patterns = vec![
                    parse_pattern(&format!(
                        r"\b{action}\b(?:\s+\w+){{0,3}}\s+\b{failure}\b",
                        action = action,
                        failure = FAILURE_MARKER,
                    )),
                    parse_pattern(&format!(
                        r"\b{failure}\b(?:\s+\w+){{0,3}}\s+\b{action}\b",
                        action = action,
                        failure = FAILURE_MARKER,
                    )),
                    parse_pattern(&format!(
                        r"\bno\s+(?:\w+\s+){{0,3}}{action}\b[^.!?\n]{{0,32}}\b(?:succeeded|completed|finished|updated|saved|applied|ran)\b",
                        action = action,
                    )),
                ];
                (*kind, patterns)
            })
            .collect();
        CompiledPatterns {
            success,
            acknowledgement,
        }
    })
}

fn success_claims(text: &str) -> Vec<(usize, SuccessClaimKind)> {
    let chars: Vec<char> = text.chars().collect();
    let mut claims = Vec::new();
    for (kind, pattern) in &compiled_patterns().success {
        for index in all_match_indexes(pattern, &chars) {
            claims.push((index, *kind));
        }
    }
    claims
}

fn consequential_step_kind(step: &AgentToolStep) -> Option<ConsequentialStepKind> {
    if !matches!(
        step.status,
        AgentStepStatus::Failed | AgentStepStatus::Blocked | AgentStepStatus::Cancelled
    ) {
        return None;
    }
    match step.tool_name.as_str() {
        "write_file" | "edit_file" => Some(ConsequentialStepKind::File),
        "run_command" => Some(ConsequentialStepKind::Command),
        "computer_use" => Some(ConsequentialStepKind::Computer),
        "schedule_task" | "edit_automation" => Some(ConsequentialStepKind::Schedule),
        _ => step
            .tool_name
            .contains("__")
            .then_some(ConsequentialStepKind::Connector),
    }
}

fn last_acknowledgement_index(text: &str, kind: ConsequentialStepKind) -> i64 {
    let chars: Vec<char> = text.chars().collect();
    let mut latest: i64 = -1;
    for (pattern_kind, patterns) in &compiled_patterns().acknowledgement {
        if *pattern_kind != kind {
            continue;
        }
        for pattern in patterns {
            for index in all_match_indexes(pattern, &chars) {
                latest = latest.max(index as i64);
            }
        }
    }
    latest
}

/// Detect narrow false-success cases from renderer-safe evidence only.
/// A later acknowledgement suppresses only the failed action it actually
/// names.
pub fn detect_unverified_success_claim(
    assistant_text: &str,
    timeline: &GenerationTimeline,
) -> Option<GenerationClaimCheck> {
    if timeline.status == GenerationTimelineStatus::Running {
        return None;
    }
    let claims = success_claims(assistant_text);
    let mut step_ids: Vec<String> = Vec::new();

    for step in &timeline.steps {
        let AgentStep::Tool(tool) = step else {
            continue;
        };
        let Some(kind) = consequential_step_kind(tool) else {
            continue;
        };
        let latest_relevant_claim = claims.iter().fold(-1i64, |latest, (index, claim_kind)| {
            if *claim_kind == SuccessClaimKind::Generic
                || *claim_kind == SuccessClaimKind::Consequential(kind)
            {
                latest.max(*index as i64)
            } else {
                latest
            }
        });
        if latest_relevant_claim >= 0
            && last_acknowledgement_index(assistant_text, kind) <= latest_relevant_claim
        {
            step_ids.push(tool.id.clone());
            if step_ids.len() == 20 {
                break;
            }
        }
    }

    if step_ids.is_empty() {
        None
    } else {
        Some(GenerationClaimCheck::UnverifiedSuccess { step_ids })
    }
}

/// Attach the post-turn claim check without rewriting assistant prose.
pub fn attach_claim_check(
    timeline: GenerationTimeline,
    assistant_text: &str,
) -> GenerationTimeline {
    match detect_unverified_success_claim(assistant_text, &timeline) {
        Some(claim_check) => GenerationTimeline {
            claim_check: Some(claim_check),
            ..timeline
        },
        None => timeline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentStep, AgentThinkingStep, AgentToolStep};

    fn timeline(tool_name: &str, status: AgentStepStatus) -> GenerationTimeline {
        GenerationTimeline {
            version: 2,
            generation_id: "generation-1".into(),
            status: GenerationTimelineStatus::Completed,
            started_at: 1,
            finished_at: Some(2),
            steps: vec![AgentStep::Tool(AgentToolStep {
                id: "tool-1".into(),
                order: 0,
                tool_call_id: "call-1".into(),
                tool_name: tool_name.into(),
                label: tool_name.into(),
                status,
                started_at: 1,
                updated_at: 2,
                finished_at: Some(2),
                target: None,
                detail: None,
            })],
            claim_check: None,
        }
    }

    fn claim(text: &str, tool_name: &str, status: AgentStepStatus) -> Option<GenerationClaimCheck> {
        detect_unverified_success_claim(text, &timeline(tool_name, status))
    }

    #[test]
    fn flags_a_success_claim_after_a_failed_mutating_tool() {
        assert_eq!(
            claim(
                "Done — I updated the file.",
                "edit_file",
                AgentStepStatus::Failed
            ),
            Some(GenerationClaimCheck::UnverifiedSuccess {
                step_ids: vec!["tool-1".into()]
            })
        );
        assert_eq!(
            claim(
                "The task is completed.",
                "github__merge_pr",
                AgentStepStatus::Failed
            ),
            Some(GenerationClaimCheck::UnverifiedSuccess {
                step_ids: vec!["tool-1".into()]
            })
        );
        assert_eq!(
            claim(
                "Done — I updated the automation.",
                "edit_automation",
                AgentStepStatus::Failed
            ),
            Some(GenerationClaimCheck::UnverifiedSuccess {
                step_ids: vec!["tool-1".into()]
            })
        );
    }

    #[test]
    fn keeps_completed_and_read_only_failures_quiet() {
        assert_eq!(
            claim("Done.", "edit_file", AgentStepStatus::Completed),
            None
        );
        assert_eq!(claim("Done.", "read_file", AgentStepStatus::Failed), None);
    }

    #[test]
    fn does_not_mistake_negative_or_qualified_prose_for_false_success() {
        let failed = AgentStepStatus::Failed;
        assert_eq!(
            claim("I could not complete the task.", "run_command", failed),
            None
        );
        assert_eq!(
            claim(
                "I implemented the change, but the tests failed.",
                "run_command",
                failed
            ),
            None
        );
        assert_eq!(
            claim(
                "The edit failed. I described an updated approach instead.",
                "run_command",
                failed
            ),
            None
        );
        assert_eq!(
            claim(
                "The edit failed. No files were updated.",
                "run_command",
                failed
            ),
            None
        );
        assert_eq!(
            claim(
                "The tests failed, but the work is done.",
                "run_command",
                failed
            ),
            Some(GenerationClaimCheck::UnverifiedSuccess {
                step_ids: vec!["tool-1".into()]
            })
        );
    }

    #[test]
    fn associates_a_later_failure_acknowledgement_with_the_failed_action() {
        for content in [
            "Done — I updated the file. The tests failed.",
            "I implemented the change, but the tests failed.",
            "Done — I updated the file, but the tests did not pass.",
            "I saved the file; however, the build failed.",
            "I edited the file, though lint did not pass.",
        ] {
            assert_eq!(
                claim(content, "edit_file", AgentStepStatus::Failed),
                Some(GenerationClaimCheck::UnverifiedSuccess {
                    step_ids: vec!["tool-1".into()]
                }),
                "{content}"
            );
        }
        assert_eq!(
            claim(
                "Done — I updated the file, but the edit failed.",
                "edit_file",
                AgentStepStatus::Failed
            ),
            None
        );
        assert_eq!(
            claim(
                "Done, but the tests failed.",
                "run_command",
                AgentStepStatus::Failed
            ),
            None
        );
    }

    #[test]
    fn ignores_unrelated_hypothetical_and_future_completion_prose() {
        let failed = AgentStepStatus::Failed;
        for content in [
            "I completed my review.",
            "This would be completed after you grant access.",
            "Once completed, the file will contain the new value.",
            "The task will be completed after approval.",
        ] {
            assert_eq!(claim(content, "edit_file", failed), None, "{content}");
        }
    }

    #[test]
    fn recognizes_concise_first_person_and_status_list_success_claims() {
        let failed = AgentStepStatus::Failed;
        assert_eq!(
            claim("I've saved the file.", "write_file", failed),
            Some(GenerationClaimCheck::UnverifiedSuccess {
                step_ids: vec!["tool-1".into()]
            })
        );
        assert_eq!(
            claim("Files updated", "write_file", failed),
            Some(GenerationClaimCheck::UnverifiedSuccess {
                step_ids: vec!["tool-1".into()]
            })
        );
    }

    #[test]
    fn running_timelines_never_get_a_claim_check() {
        let mut running = timeline("edit_file", AgentStepStatus::Failed);
        running.status = GenerationTimelineStatus::Running;
        assert_eq!(
            detect_unverified_success_claim("Done — I updated the file.", &running),
            None
        );
    }

    #[test]
    fn attach_claim_check_only_sets_the_field_when_detected() {
        let base = timeline("edit_file", AgentStepStatus::Failed);
        let attached = attach_claim_check(base.clone(), "Done — I updated the file.");
        assert!(attached.claim_check.is_some());
        let untouched = attach_claim_check(base, "I could not complete the task.");
        assert_eq!(untouched, timeline("edit_file", AgentStepStatus::Failed));
    }

    #[test]
    fn thinking_steps_are_skipped_by_the_detector() {
        let mut with_thinking = timeline("edit_file", AgentStepStatus::Failed);
        with_thinking.steps.insert(
            0,
            AgentStep::Thinking(AgentThinkingStep {
                id: "think-1".into(),
                order: 0,
                started_at: 1,
                updated_at: 2,
                finished_at: Some(2),
                duration_ms: None,
            }),
        );
        assert_eq!(
            detect_unverified_success_claim("Done — I updated the file.", &with_thinking),
            Some(GenerationClaimCheck::UnverifiedSuccess {
                step_ids: vec!["tool-1".into()]
            })
        );
    }
}
