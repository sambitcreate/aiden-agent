fn main() {
    #[cfg(target_os = "linux")]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.len() != 10
            || args[1] != "stage"
            || args[2] != "--store"
            || args[4] != "--source"
            || args[6] != "--inventory"
            || args[8] != "--approval"
        {
            eprintln!("usage: aiden-managed-payload stage --store ABS --source ABS --inventory ABS --approval ABS");
            std::process::exit(2);
        }
        let request = aiden_managed_payload::stage::Request {
            store: &args[3],
            source: &args[5],
            inventory: &args[7],
            approval: &args[9],
        };
        match aiden_managed_payload::stage::stage(&request) {
            Ok(receipt) => println!("{}", receipt),
            Err(err) => {
                eprintln!("managed payload staging failed: {err}");
                std::process::exit(1);
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("Linux only");
        std::process::exit(2);
    }
}
