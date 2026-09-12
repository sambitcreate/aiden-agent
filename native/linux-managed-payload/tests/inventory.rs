use aiden_managed_payload::inventory::{self, approval, hash, parse};
use serde_json::{json, Value};
fn valid() -> Value {
    json!({"schemaVersion":1,"hashAlgorithm":"sha256","entries":[
        {"path":".","type":"directory","mode":493},
        {"path":"a","type":"file","mode":420,"size":3,"sha256":hash(b"abc")}
    ]})
}
#[test]
fn parses_phase16_inventory_and_approval() {
    let bytes = serde_json::to_vec(&valid()).unwrap();
    assert_eq!(parse(&bytes).unwrap().entries.len(), 2);
    let record = json!({"schemaVersion":1,"kind":"local-staging-only","inventorySha256":hash(&bytes),"packageSha256":"a".repeat(64)});
    assert!(approval(&serde_json::to_vec(&record).unwrap(), &bytes).is_ok());
}
#[test]
fn rejects_schema_and_path_mutations() {
    let mut mutations = Vec::new();
    for path in [
        "/a", "../a", "a/../b", "a//b", "a/", "a\\b", "\u{fffd}", "a\n", ".",
    ] {
        let mut v = valid();
        v["entries"][1]["path"] = json!(path);
        mutations.push(v);
    }
    for (key, value) in [
        ("mode", json!(-1)),
        ("mode", json!(4096)),
        ("mode", json!(1.5)),
        ("size", json!(inventory::FILE_BYTES + 1)),
        ("sha256", json!("a".repeat(63))),
        ("sha256", json!("A".repeat(64))),
        ("type", json!("symlink")),
        ("size", Value::Null),
    ] {
        let mut v = valid();
        v["entries"][1][key] = value;
        mutations.push(v);
    }
    let mut v = valid();
    v["entries"][0]["size"] = Value::Null;
    mutations.push(v);
    let mut v = valid();
    v["extra"] = json!(true);
    mutations.push(v);
    let mut v = valid();
    v["entries"][1]["extra"] = json!(true);
    mutations.push(v);
    let mut v = valid();
    v["entries"][0]["path"] = json!("x");
    mutations.push(v);
    let mut v = valid();
    v["entries"][1]["path"] = json!("missing/child");
    mutations.push(v);
    let mut v = valid();
    v["schemaVersion"] = json!(2);
    mutations.push(v);
    let mut v = valid();
    v["hashAlgorithm"] = json!("sha1");
    mutations.push(v);
    for mutation in mutations {
        assert!(
            parse(&serde_json::to_vec(&mutation).unwrap()).is_err(),
            "{mutation}"
        );
    }
}
#[test]
fn rejects_duplicate_json_fields_and_wrong_approval() {
    assert!(parse(
        br#"{"schemaVersion":1,"schemaVersion":1,"hashAlgorithm":"sha256","entries":[]}"#
    )
    .is_err());
    let bytes = serde_json::to_vec(&valid()).unwrap();
    for kind in ["verified", "production", ""] {
        let r = json!({"schemaVersion":1,"kind":kind,"inventorySha256":hash(&bytes),"packageSha256":"a".repeat(64)});
        assert!(approval(&serde_json::to_vec(&r).unwrap(), &bytes).is_err());
    }
    let mut r = json!({"schemaVersion":1,"kind":"local-staging-only","inventorySha256":hash(&bytes),"packageSha256":"a".repeat(64)});
    r["verified"] = json!(true);
    assert!(approval(&serde_json::to_vec(&r).unwrap(), &bytes).is_err());
    r.as_object_mut().unwrap().remove("verified");
    r["inventorySha256"] = json!("b".repeat(64));
    assert!(approval(&serde_json::to_vec(&r).unwrap(), &bytes).is_err());
}
#[test]
fn matches_javascript_utf16_path_order() {
    let v = json!({"schemaVersion":1,"hashAlgorithm":"sha256","entries":[
        {"path":".","type":"directory","mode":493},
        {"path":"\u{10000}","type":"directory","mode":493},
        {"path":"\u{e000}","type":"directory","mode":493}
    ]});
    assert!(parse(&serde_json::to_vec(&v).unwrap()).is_ok());
    let mut bad = v;
    bad["entries"].as_array_mut().unwrap().swap(1, 2);
    assert!(parse(&serde_json::to_vec(&bad).unwrap()).is_err());
}
#[test]
fn rejects_total_entry_depth_and_byte_bounds() {
    let mut v = valid();
    v["entries"] = json!([]);
    assert!(parse(&serde_json::to_vec(&v).unwrap()).is_err());
    assert!(!inventory::relative(&vec!["a"; 65].join("/"), false));
    assert!(!inventory::relative(&"x".repeat(4097), false));
    assert!(parse(&vec![b' '; inventory::MANIFEST_BYTES + 1]).is_err());
    let mut v = valid();
    let entries = v["entries"].as_array_mut().unwrap();
    entries.truncate(1);
    for i in 0..9 {
        entries.push(json!({"path":format!("f{i}"),"type":"file","mode":420,"size":inventory::FILE_BYTES,"sha256":"a".repeat(64)}));
    }
    assert!(parse(&serde_json::to_vec(&v).unwrap()).is_err());
}

#[test]
fn cli_rejects_missing_arguments_without_effects() {
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_aiden-managed-payload"))
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(2));
}
#[cfg(target_os = "linux")]
#[test]
fn unprivileged_stage_cannot_create_a_generation() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_aiden-managed-payload"))
        .args([
            "stage",
            "--store",
            "/nonexistent/store",
            "--source",
            "/nonexistent/source",
            "--inventory",
            "/nonexistent/inventory",
            "--approval",
            "/nonexistent/approval",
        ])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8(result.stderr)
        .unwrap()
        .contains("trusted host root execution required"));
}
