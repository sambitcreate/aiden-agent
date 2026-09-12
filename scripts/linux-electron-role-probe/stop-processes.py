"""Kill only disposable fixture domains, using pidfds against PID reuse."""
import os
from pathlib import Path
import signal
import sys
import time
roles = {'aiden_electron_role_probe_main_t', 'aiden_electron_role_probe_child_t'}
def fixture_role(proc):
    return (proc / 'attr/current').read_text().split(':')[2] in roles
for attempt in range(30):
    remaining = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        descriptor = None
        try:
            descriptor = os.pidfd_open(int(proc.name))
            # Resolve identity only after opening the kernel process handle.
            if not fixture_role(proc):
                continue
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            remaining.append(proc.name)
        except (FileNotFoundError, ProcessLookupError):
            pass
        finally:
            if descriptor is not None:
                os.close(descriptor)
    if not remaining:
        sys.exit(0)
    time.sleep(0.1)
raise SystemExit('fixture-domain processes remain after bounded cleanup')
