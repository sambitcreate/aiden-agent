//! Skills discovery — scan `~/.aiden/skills/` for `SKILL.md` files.
//!
//! Port of `main/services/skills-discovery.ts`.

use std::path::{Path, PathBuf};

use aiden_data::aiden_config_dir;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub enabled: bool,
}

#[derive(Debug)]
pub struct SkillDiscoveryError(pub String);

impl std::fmt::Display for SkillDiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for SkillDiscoveryError {}

/// Discover all skills by scanning `~/.aiden/skills/` and `~/.aiden/skill/`
/// for `SKILL.md` files.
pub fn discover_skills() -> Result<Vec<SkillInfo>, SkillDiscoveryError> {
    let config_dir = aiden_config_dir().map_err(|e| SkillDiscoveryError(e.to_string()))?;
    let mut skills = Vec::new();

    for name in ["skills", "skill"] {
        let dir = config_dir.join(name);
        if !dir.is_dir() {
            continue;
        }
        let entries = std::fs::read_dir(&dir).map_err(|e| SkillDiscoveryError(e.to_string()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let skill_md = if path.is_dir() {
                path.join("SKILL.md")
            } else if path.file_name().is_some_and(|n| n == "SKILL.md") {
                path.clone()
            } else {
                continue;
            };
            if !skill_md.is_file() {
                continue;
            }
            if let Ok(info) = parse_skill_md(&skill_md) {
                skills.push(info);
            }
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

fn parse_skill_md(path: &Path) -> Result<SkillInfo, SkillDiscoveryError> {
    let content = std::fs::read_to_string(path).map_err(|e| SkillDiscoveryError(e.to_string()))?;
    let (name, description) = extract_name_and_description(&content);

    Ok(SkillInfo {
        name,
        description,
        path: path.parent().unwrap_or(path).to_path_buf(),
        enabled: true,
    })
}

fn extract_name_and_description(content: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if name.is_empty() {
            if let Some(heading) = trimmed.strip_prefix("# ") {
                name = heading.trim().to_string();
                continue;
            }
        }
        if description.is_empty() && !trimmed.is_empty() && !trimmed.starts_with('#') {
            description = trimmed.to_string();
        }
        if !name.is_empty() && !description.is_empty() {
            break;
        }
    }

    if name.is_empty() {
        name = "Unnamed skill".to_string();
    }
    (name, description)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_name_from_first_heading_and_first_paragraph() {
        let md = "# My Cool Skill\n\nThis skill does cool things.\n\nMore text.";
        let (name, desc) = extract_name_and_description(md);
        assert_eq!(name, "My Cool Skill");
        assert_eq!(desc, "This skill does cool things.");
    }

    #[test]
    fn falls_back_to_unnamed_when_no_heading() {
        let md = "Just some text without a heading.";
        let (name, _) = extract_name_and_description(md);
        assert_eq!(name, "Unnamed skill");
    }

    #[test]
    fn skips_blank_lines_before_description() {
        let md = "# Test\n\n\n\nActual description here.";
        let (_, desc) = extract_name_and_description(md);
        assert_eq!(desc, "Actual description here.");
    }
}
