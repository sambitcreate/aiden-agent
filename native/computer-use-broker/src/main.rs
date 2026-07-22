fn main() {
    if let Err(error) = aiden_computer_use_broker::run_from_environment() {
        eprintln!("aiden-cua-broker: {error}");
        std::process::exit(1);
    }
}
