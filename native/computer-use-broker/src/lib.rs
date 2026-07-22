#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

#[cfg(not(target_os = "macos"))]
compile_error!("aiden-cua-broker is a macOS-only security boundary");

mod args;
mod darwin;
mod driver;
mod guard;
mod jsonrpc;
mod lines;
mod runtime;
mod signing;
mod socket;
mod supervisor;

pub fn run_from_environment() -> Result<(), String> {
    let arguments = args::parse(std::env::args_os().skip(1))?;
    match arguments.mode {
        args::Mode::Broker => runtime::run_broker(
            &arguments.control_socket,
            arguments
                .launch_lease_socket
                .as_deref()
                .expect("broker arguments require a launch lease"),
        ),
        args::Mode::Bridge => runtime::run_bridge(
            &arguments.control_socket,
            arguments
                .launch_lease_socket
                .as_deref()
                .expect("bridge arguments require a launch lease"),
        ),
    }
}
