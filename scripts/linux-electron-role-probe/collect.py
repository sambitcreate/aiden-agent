"""Root observation combines the unit cgroup and process ancestry.
GNOME may move the browser into an application scope after launch.
"""
import json
from pathlib import Path
import sys
main_pid = int(sys.argv[1])
cgroup = Path('/sys/fs/cgroup') / sys.argv[2].lstrip('/')
selected = {main_pid}
for group in [cgroup, *[p for p in cgroup.rglob('*') if p.is_dir()]]:
    selected.update(int(value) for value in (group / 'cgroup.procs').read_text().split())
parents = {}
for proc in Path('/proc').iterdir():
    if proc.name.isdigit():
        try:
            stat = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
            parents[int(proc.name)] = int(stat[1])
            if (proc / 'attr/current').read_text().split(':')[2] in {
                'aiden_electron_role_probe_main_t', 'aiden_electron_role_probe_child_t'
            }:
                selected.add(int(proc.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
while True:
    expanded = selected | {pid for pid, parent in parents.items() if parent in selected}
    if expanded == selected:
        break
    selected = expanded
rows = []
for pid in sorted(selected):
    proc = Path('/proc') / str(pid)
    try:
        status = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines())
        rows.append(dict(pid=pid, ppid=int(status['PPid']), uid=status['Uid'].strip(),
            exe=str((proc / 'exe').readlink()), context=(proc / 'attr/current').read_text().rstrip('\0\n'),
            cmdline=(proc / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace').strip(),
            cgroup=(proc / 'cgroup').read_text().strip(),
            seccomp=int(status['Seccomp']), noNewPrivs=int(status['NoNewPrivs'])))
    except (FileNotFoundError, ProcessLookupError):
        continue  # Missing required roles still fail the verifier.
print(json.dumps(dict(mainPid=main_pid, rows=rows), indent=2))
