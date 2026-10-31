"""Run frozen trusted assertions; candidate Python executes only across an OS sandbox.
The original oracle source is never readable in the candidate process. RPC preserves
argument mutation so input_unchanged checks retain their original meaning.
"""
import ast
import importlib.util
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
sys.dont_write_bytecode = True
import time

WORKSPACE = Path(sys.argv[1]).resolve()
PROBE = sys.argv[2] == "--isolation-probe"
ORACLE = Path(sys.argv[3] if PROBE else sys.argv[2]).resolve()
WORKER = Path(__file__).with_name("task-quality-candidate.py").resolve()
PYTHON = Path(sys.executable).resolve()
GRAPH_HELPER = Path(__file__).with_name("task_quality_object_graph.py").resolve()
graph_spec = importlib.util.spec_from_file_location("host_object_graph", GRAPH_HELPER)
graph_module = importlib.util.module_from_spec(graph_spec)
graph_spec.loader.exec_module(graph_module)
object_graph = graph_module.ObjectGraph("h")

def sandbox_command():
    if sys.platform == "darwin":
        literal = lambda value: json.dumps(str(value))
        # Read system runtime files, but exclude home trees, temporary state,
        # external volumes and network mounts. Only this candidate and the
        # generic RPC worker are exceptions; protected oracles stay excluded.
        denied = ["/Users", "/home", "/private/tmp", "/private/var/folders", "/tmp", "/Volumes", "/Network"]
        outside_private = "(require-all " + " ".join("(require-not (subpath " + literal(p) + "))" for p in denied) + ")"
        profile = '(version 1) (deny default) (allow process-fork) (allow sysctl-read) (allow file-read-metadata) '
        profile += '(allow process-exec (subpath ' + literal(Path(sys.prefix).resolve()) + ')) '
        profile += '(allow file-read* ' + outside_private + ' (subpath ' + literal(WORKSPACE) + ') (literal ' + literal(WORKER) + ') (literal ' + literal(GRAPH_HELPER) + '))'
        return ["/usr/bin/sandbox-exec", "-p", profile, str(PYTHON), "-I", "-B", str(WORKER)]
    if sys.platform.startswith("linux") and shutil.which("bwrap"):
        # No host home/repository/temp mount; separate PID/IPC/network namespaces.
        command = ["bwrap", "--die-with-parent", "--unshare-all", "--new-session", "--ro-bind", "/usr", "/usr"]
        for root in ["/lib", "/lib64", str(Path(sys.prefix).resolve())]:
            if Path(root).exists() and root != "/usr": command += ["--ro-bind", root, root]
        command += ["--proc", "/proc", "--dev", "/dev", "--ro-bind", str(WORKSPACE), "/candidate", "--ro-bind", str(WORKER), "/worker.py", "--ro-bind", str(GRAPH_HELPER), "/task_quality_object_graph.py", "--chdir", "/candidate", str(PYTHON), "-I", "-B", "/worker.py"]
        return command
    raise RuntimeError("OS isolation unavailable: require macOS sandbox-exec or Linux bubblewrap; never run untrusted candidates without isolation")

COMMAND = sandbox_command()

class Worker:
    def __init__(self):
        self.child = subprocess.Popen(COMMAND, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     cwd=WORKSPACE, env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}, start_new_session=True)
        self.pending = bytearray()
        self.total = 0
        self.deadline = time.monotonic() + 20
    def exchange(self, payload):
        encoded = json.dumps(payload).encode() + b"\n"
        if len(encoded) > 60000: raise RuntimeError("candidate input bound exceeded")
        self.child.stdin.write(encoded)
        self.child.stdin.flush()
        call_deadline = min(self.deadline, time.monotonic() + 3)
        while b"\n" not in self.pending:
            if time.monotonic() >= call_deadline: raise RuntimeError("candidate timed out")
            ready, _, _ = select.select([self.child.stdout], [], [], 0.05)
            if ready:
                chunk = os.read(self.child.stdout.fileno(), 8192)
                if not chunk: raise RuntimeError("candidate isolation, admission or execution failed")
                self.pending.extend(chunk)
                self.total += len(chunk)
                if len(self.pending) > 131072 or self.total > 1048576: raise RuntimeError("candidate output bound exceeded")
        line, _, remaining = self.pending.partition(b"\n")
        self.pending = bytearray(remaining)
        return json.loads(line)
    def close(self):
        if self.child.poll() is None: os.killpg(self.child.pid, signal.SIGKILL)
        self.child.wait()
        self.child.stdin.close()
        self.child.stdout.close()

worker = Worker()

def invoke(function, args):
    encoded_arguments = [object_graph.encode(argument) for argument in args]
    result = worker.exchange({"function": function, "args": encoded_arguments, "graph": object_graph.snapshot()})
    if not isinstance(result, dict) or set(result) not in [{"exception", "graph"}, {"result", "graph"}]: raise RuntimeError("invalid candidate protocol")
    object_graph.apply(result["graph"])
    if "exception" in result:
        errors = {"KeyError": KeyError, "ValueError": ValueError, "TypeError": TypeError, "RuntimeError": RuntimeError}
        if result["exception"] not in errors: raise RuntimeError("invalid candidate exception")
        raise errors[result["exception"]]()
    return object_graph.decode(result["result"])

class CandidateProxy:
    def __getattr__(self, name):
        if name.startswith("_"): raise AttributeError(name)
        return lambda *args: invoke(name, args)

try:
    if PROBE:
        result = worker.exchange({"mode": "isolation_probe", "read": str(ORACLE), "write": sys.argv[4], "port": int(sys.argv[5])})
        if result != {"isolated": True}: raise RuntimeError("OS isolation probe failed")
        print(json.dumps(result))
    else:
        filename = str(WORKSPACE / "solution.py") if sys.platform == "darwin" else "/candidate/solution.py"
        if worker.exchange({"file": filename}) != {"ready": True}: raise RuntimeError("candidate admission failed")
        # Keep every frozen assertion. Replace only the reviewed importlib bootstrap,
        # which otherwise executes candidate code in the oracle's trusted process.
        source = ORACLE.read_text()
        tree = ast.parse(source, filename=str(ORACLE))
        removed = []
        for node in tree.body:
            text = ast.get_source_segment(source, node) or ""
            if text.startswith("spec = importlib.util.spec_from_file_location") or text.startswith("module = importlib.util.module_from_spec") or text == "spec.loader.exec_module(module)":
                removed.append(node)
        if len(removed) != 3: raise RuntimeError("unsupported frozen oracle loader")
        tree.body = [node for node in tree.body if node not in removed]
        sys.argv = [str(ORACLE), str(WORKSPACE)] + sys.argv[3:]
        exec(compile(tree, str(ORACLE), "exec"), {"__name__": "__main__", "module": CandidateProxy()})
finally:
    worker.close()
