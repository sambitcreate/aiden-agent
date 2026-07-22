use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=src/darwin_security.m");
    // Keep Rust's final Mach-O deployment floor aligned with the Objective-C
    // launch-requirement shim and the helper's signed Info.plist.
    println!("cargo:rustc-link-arg=-mmacosx-version-min=14.4");

    let target = env::var("TARGET").expect("Cargo did not provide TARGET");
    let architecture = if target.starts_with("aarch64-") {
        "arm64"
    } else if target.starts_with("x86_64-") {
        "x86_64"
    } else {
        panic!("unsupported Aiden Computer Use target: {target}");
    };
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo did not provide OUT_DIR"))
        .join("darwin_security.o");
    let status = Command::new("/usr/bin/xcrun")
        .args([
            "clang",
            "-fobjc-arc",
            "-fmodules",
            "-fno-common",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-arch",
            architecture,
            "-mmacosx-version-min=14.4",
            "-c",
            "src/darwin_security.m",
            "-o",
        ])
        .arg(&output)
        .status()
        .expect("could not invoke the Apple clang toolchain");
    assert!(status.success(), "could not compile Darwin security shim");

    println!("cargo:rustc-link-arg={}", output.display());
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=ApplicationServices");
    println!("cargo:rustc-link-lib=framework=CoreGraphics");
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rustc-link-lib=bsm");
    println!("cargo:rustc-link-lib=proc");
}
