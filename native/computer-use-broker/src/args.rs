use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Mode {
    Broker,
    Bridge,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct Args {
    pub(crate) mode: Mode,
    pub(crate) control_socket: PathBuf,
    pub(crate) launch_lease_socket: Option<PathBuf>,
}

pub(crate) fn parse<I>(arguments: I) -> Result<Args, String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut arguments = arguments.into_iter();
    let mut bridge = false;
    let mut control_socket = None;
    let mut launch_lease_socket = None;

    while let Some(argument) = arguments.next() {
        if argument == "--bridge" {
            if bridge {
                return Err("duplicate --bridge".to_owned());
            }
            bridge = true;
            continue;
        }
        if argument == "--control-socket" {
            if control_socket.is_some() {
                return Err("duplicate --control-socket".to_owned());
            }
            let value = arguments
                .next()
                .ok_or_else(|| "missing --control-socket value".to_owned())?;
            control_socket = Some(PathBuf::from(value));
            continue;
        }
        if argument == "--launch-lease-socket" {
            if launch_lease_socket.is_some() {
                return Err("duplicate --launch-lease-socket".to_owned());
            }
            let value = arguments
                .next()
                .ok_or_else(|| "missing --launch-lease-socket value".to_owned())?;
            launch_lease_socket = Some(PathBuf::from(value));
            continue;
        }
        return Err(format!(
            "unsupported argument: {}",
            argument.to_string_lossy()
        ));
    }

    let control_socket = control_socket.ok_or_else(|| "missing --control-socket".to_owned())?;
    if !control_socket.is_absolute() {
        return Err("control socket must be absolute".to_owned());
    }
    if launch_lease_socket
        .as_ref()
        .is_some_and(|path| !path.is_absolute())
    {
        return Err("launch lease socket must be absolute".to_owned());
    }
    if launch_lease_socket.is_none() {
        return Err("both broker and bridge modes require --launch-lease-socket".to_owned());
    }
    if launch_lease_socket.as_ref().and_then(|path| path.parent()) != control_socket.parent() {
        return Err(
            "broker control and launch lease sockets must share one session directory".to_owned(),
        );
    }
    Ok(Args {
        mode: if bridge { Mode::Bridge } else { Mode::Broker },
        control_socket,
        launch_lease_socket,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn accepts_only_the_two_documented_modes() {
        assert_eq!(
            parse(strings(&[
                "--control-socket",
                "/tmp/acu-a/control.sock",
                "--launch-lease-socket",
                "/tmp/acu-a/lease.sock",
            ]))
            .unwrap(),
            Args {
                mode: Mode::Broker,
                control_socket: "/tmp/acu-a/control.sock".into(),
                launch_lease_socket: Some("/tmp/acu-a/lease.sock".into()),
            }
        );
        assert_eq!(
            parse(strings(&[
                "--bridge",
                "--control-socket",
                "/tmp/acu-a/control.sock",
                "--launch-lease-socket",
                "/tmp/acu-a/lease.sock",
            ]))
            .unwrap(),
            Args {
                mode: Mode::Bridge,
                control_socket: "/tmp/acu-a/control.sock".into(),
                launch_lease_socket: Some("/tmp/acu-a/lease.sock".into()),
            }
        );
    }

    #[test]
    fn rejects_missing_duplicate_relative_and_private_arguments() {
        for values in [
            vec![],
            vec!["--bridge"],
            vec!["--control-socket", "/tmp/a"],
            vec!["--bridge", "--bridge", "--control-socket", "/tmp/a"],
            vec!["--control-socket", "relative.sock"],
            vec![
                "--control-socket",
                "/tmp/a",
                "--launch-lease-socket",
                "relative.sock",
            ],
            vec![
                "--control-socket",
                "/tmp/acu-a/control.sock",
                "--launch-lease-socket",
                "/tmp/acu-b/lease.sock",
            ],
            vec![
                "--bridge",
                "--control-socket",
                "/tmp/acu-a/control.sock",
                "--launch-lease-socket",
                "/tmp/acu-b/lease.sock",
            ],
            vec!["--control-socket", "/tmp/a", "--expected-peer-pid", "42"],
            vec!["--watchdog", "--control-socket", "/tmp/a"],
            vec!["serve", "--control-socket", "/tmp/a"],
        ] {
            assert!(parse(strings(&values)).is_err(), "accepted {values:?}");
        }
    }
}
