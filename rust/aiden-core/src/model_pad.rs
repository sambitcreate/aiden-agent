//! Model Pad layout — port of `renderer/lib/model-pad-layout.ts`.
//!
//! The renderer persists each model's pad position in `localStorage` under
//! `aiden-agent.modelPadLayout.v1`. The pure parts are portable wholesale:
//! a fail-closed parse of the stored layout, structural equality, and the
//! deterministic "next open cell near the center" placement for newly added
//! models. The browser-only storage/event wiring (`window.localStorage`,
//! `dispatchEvent`) is left to the GPUI side, which supplies a `StorageLike`
//! implementation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `MODEL_PAD_LAYOUT_KEY` — the storage key for the persisted layout.
pub const MODEL_PAD_LAYOUT_KEY: &str = "aiden-agent.modelPadLayout.v1";
/// `MAX_PLACEMENTS` — a parsed layout above this many placements is rejected.
pub const MAX_PLACEMENTS: usize = 2_000;
/// Bounded model id length; longer keys are dropped by the parser.
pub const MAX_MODEL_KEY_LENGTH: usize = 1_024;

/// `ModelPadPlacementSource` — how a placement was chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ModelPadPlacementSource {
    User,
    #[serde(rename = "artificial-analysis")]
    ArtificialAnalysis,
}

/// `ModelPadPlacement` — a normalized [0,1]-bounded position on the pad.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelPadPlacement {
    pub x: f64,
    pub y: f64,
    pub source: ModelPadPlacementSource,
}

/// `ModelPadLayout` — schemaVersion 1 + a per-model-id placement map.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelPadLayout {
    pub schema_version: u8,
    pub placements: BTreeMap<String, ModelPadPlacement>,
}

impl Default for ModelPadLayout {
    fn default() -> Self {
        Self::empty()
    }
}

/// `emptyModelPadLayout()`.
pub fn empty_model_pad_layout() -> ModelPadLayout {
    ModelPadLayout::empty()
}

impl ModelPadLayout {
    /// `emptyModelPadLayout()`.
    pub fn empty() -> Self {
        Self {
            schema_version: 1,
            placements: BTreeMap::new(),
        }
    }
}

fn record(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object().filter(|_| !value.is_array())
}

/// Accept only finite coordinates inside the closed unit square.
fn coordinate(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    (number.is_finite() && (0.0..=1.0).contains(&number)).then_some(number)
}

/// `parseModelPadLayout` — fail closed: any malformed shape becomes the empty
/// layout, and individual invalid placements are skipped.
pub fn parse_model_pad_layout(value: &Value) -> ModelPadLayout {
    let Some(layout) = record(value) else {
        return ModelPadLayout::empty();
    };
    if layout.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return ModelPadLayout::empty();
    }
    let Some(raw_placements) = layout.get("placements").and_then(record) else {
        return ModelPadLayout::empty();
    };
    if raw_placements.len() > MAX_PLACEMENTS {
        return ModelPadLayout::empty();
    }

    let mut placements = BTreeMap::new();
    for (model, raw_placement) in raw_placements {
        if model.is_empty() || model.chars().count() > MAX_MODEL_KEY_LENGTH {
            continue;
        }
        let Some(placement) = record(raw_placement) else {
            continue;
        };
        let (Some(x), Some(y)) = (
            placement.get("x").and_then(coordinate),
            placement.get("y").and_then(coordinate),
        ) else {
            continue;
        };
        let Some(source) = placement
            .get("source")
            .and_then(Value::as_str)
            .and_then(|source| match source {
                "user" => Some(ModelPadPlacementSource::User),
                "artificial-analysis" => Some(ModelPadPlacementSource::ArtificialAnalysis),
                _ => None,
            })
        else {
            continue;
        };
        placements.insert(model.clone(), ModelPadPlacement { x, y, source });
    }
    ModelPadLayout {
        schema_version: 1,
        placements,
    }
}

/// `modelPadLayoutsEqual` — structural equality of the *normalized* layouts.
pub fn model_pad_layouts_equal(left: &ModelPadLayout, right: &ModelPadLayout) -> bool {
    let left = serde_json::to_value(parse_model_pad_layout(
        &serde_json::to_value(left).unwrap_or(Value::Null),
    ))
    .unwrap_or(Value::Null);
    let right = serde_json::to_value(parse_model_pad_layout(
        &serde_json::to_value(right).unwrap_or(Value::Null),
    ))
    .unwrap_or(Value::Null);
    left == right
}

/// `nextModelPadPlacement` — a calm, deterministic open cell near the center
/// for a newly added model, with a `user` source.
pub fn next_model_pad_placement(
    placements: &BTreeMap<String, ModelPadPlacement>,
) -> ModelPadPlacement {
    let occupied: Vec<ModelPadPlacement> = placements.values().copied().collect();
    let grid_size = (7_f64)
        .max(((occupied.len() + 1) as f64).sqrt().ceil())
        .max(2_f64) as usize;
    let mut candidates: Vec<(f64, f64, f64)> = (0..grid_size * grid_size)
        .map(|index| {
            let column = index % grid_size;
            let row = index / grid_size;
            let x = 0.08 + (column as f64 / (grid_size - 1) as f64) * 0.84;
            let y = 0.08 + (row as f64 / (grid_size - 1) as f64) * 0.84;
            let distance = (x - 0.5).powi(2) + (y - 0.5).powi(2);
            (x, y, distance)
        })
        .collect();
    // Sort by distance from center, then y, then x — mirroring the TS chain
    // `left.distance - right.distance || left.y - right.y || left.x - right.x`.
    candidates.sort_by(|left, right| {
        left.2
            .partial_cmp(&right.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                left.1
                    .partial_cmp(&right.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| {
                left.0
                    .partial_cmp(&right.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let minimum_distance = 0.42 / (grid_size - 1) as f64;
    let best = candidates
        .iter()
        .copied()
        .find(|(x, y, _)| {
            occupied.iter().all(|placement| {
                ((x - placement.x).powi(2) + (y - placement.y).powi(2)).sqrt() > minimum_distance
            })
        })
        .unwrap_or_else(|| {
            candidates.iter().copied().fold(
                (candidates[0].0, candidates[0].1, f64::NEG_INFINITY),
                |best, (x, y, _)| {
                    let nearest = occupied
                        .iter()
                        .map(|placement| {
                            ((x - placement.x).powi(2) + (y - placement.y).powi(2)).sqrt()
                        })
                        .fold(f64::INFINITY, f64::min);
                    if nearest > best.2 {
                        (x, y, nearest)
                    } else {
                        best
                    }
                },
            )
        });
    ModelPadPlacement {
        x: best.0,
        y: best.1,
        source: ModelPadPlacementSource::User,
    }
}

/// `StorageLike` — the tiny browser-storage surface the TS module abstracts.
pub trait StorageLike {
    fn get_item(&self, key: &str) -> Option<String>;
    fn set_item(&mut self, key: &str, value: &str);
}

/// `readModelPadLayout` — read + parse from a storage backend, failing closed
/// to the empty layout on any error.
pub fn read_model_pad_layout<S: StorageLike>(storage: &S) -> ModelPadLayout {
    let Some(raw) = storage.get_item(MODEL_PAD_LAYOUT_KEY) else {
        return ModelPadLayout::empty();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) => parse_model_pad_layout(&value),
        Err(_) => ModelPadLayout::empty(),
    }
}

/// `writeModelPadLayout` — normalize, persist, and return the normalized
/// layout. Storage failures surface as an error (the GPUI caller decides how
/// to surface them).
pub fn write_model_pad_layout<S: StorageLike>(
    layout: &ModelPadLayout,
    storage: &mut S,
) -> Result<ModelPadLayout, serde_json::Error> {
    let normalized = parse_model_pad_layout(&serde_json::to_value(layout)?);
    let raw = serde_json::to_string(&normalized)?;
    storage.set_item(MODEL_PAD_LAYOUT_KEY, &raw);
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn layouts_fail_closed_and_retain_only_valid_placements() {
        assert_eq!(
            parse_model_pad_layout(&Value::Null),
            ModelPadLayout::empty()
        );
        assert_eq!(
            parse_model_pad_layout(&json!({
                "schemaVersion": 1,
                "placements": {
                    "openai::gpt": { "x": 0.2, "y": 0.8, "source": "user" },
                    "bad::range": { "x": 4, "y": 0.2, "source": "user" },
                    "bad::source": { "x": 0.2, "y": 0.2, "source": "generated" },
                },
            })),
            ModelPadLayout {
                schema_version: 1,
                placements: BTreeMap::from([(
                    "openai::gpt".to_string(),
                    ModelPadPlacement {
                        x: 0.2,
                        y: 0.8,
                        source: ModelPadPlacementSource::User,
                    },
                )]),
            }
        );
    }

    #[test]
    fn layouts_round_trip_through_device_local_storage() {
        struct MemoryStorage(Option<String>);
        impl StorageLike for MemoryStorage {
            fn get_item(&self, _key: &str) -> Option<String> {
                self.0.clone()
            }
            fn set_item(&mut self, _key: &str, value: &str) {
                self.0 = Some(value.to_string());
            }
        }
        let mut storage = MemoryStorage(None);
        let layout = ModelPadLayout {
            schema_version: 1,
            placements: BTreeMap::from([(
                "anthropic::claude".to_string(),
                ModelPadPlacement {
                    x: 0.42,
                    y: 0.86,
                    source: ModelPadPlacementSource::ArtificialAnalysis,
                },
            )]),
        };
        assert_eq!(
            write_model_pad_layout(&layout, &mut storage).unwrap(),
            layout
        );
        assert_eq!(read_model_pad_layout(&storage), layout);
        assert!(model_pad_layouts_equal(
            &layout,
            &read_model_pad_layout(&storage)
        ));
    }

    #[test]
    fn new_models_receive_deterministic_non_overlapping_positions() {
        let first = next_model_pad_placement(&BTreeMap::new());
        let mut one = BTreeMap::new();
        one.insert("first".to_string(), first);
        let second = next_model_pad_placement(&one);
        assert_eq!(first, next_model_pad_placement(&BTreeMap::new()));
        assert_eq!(first.source, ModelPadPlacementSource::User);
        assert!(((first.x - second.x).powi(2) + (first.y - second.y).powi(2)).sqrt() > 0.08);
    }

    #[test]
    fn large_personal_pads_keep_assigning_unique_open_positions() {
        let mut placements = BTreeMap::new();
        let mut seen = std::collections::HashSet::new();
        for index in 0..80 {
            let placement = next_model_pad_placement(&placements);
            let key = format!("{}:{}", placement.x, placement.y);
            assert!(seen.insert(key), "duplicate placement at index {index}");
            placements.insert(format!("model-{index}"), placement);
        }
    }
}
