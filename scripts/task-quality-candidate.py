"""Bounded persistent candidate endpoint. Only the documented Python subset is admitted.
OS isolation protects host files/network; constrained execution separately protects
observation fidelity. Arbitrary Python introspection is explicitly unsupported.
"""
import ast
import builtins
import contextlib
import errno
import csv
import io
import importlib.util
from pathlib import Path
import json
import resource
import socket
import sys
sys.dont_write_bytecode = True

resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_CPU, (4, 4))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
if sys.platform.startswith("linux"):
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))

class Discard:
    def write(self, value): return len(value)
    def flush(self): pass

# These are the syntax and operations needed by the frozen synthetic tasks,
# not a claim of general Python compatibility or a replacement OS sandbox.
NODE_NAMES = set("Module Import alias FunctionDef arguments arg Return Assign AugAssign Global If IfExp For While Break Continue Pass Raise Try ExceptHandler Expr Name Load Store Constant List Tuple Dict Set Subscript Slice Attribute Call keyword ListComp SetComp DictComp GeneratorExp comprehension BinOp BoolOp UnaryOp Compare Add Sub Mult Div FloorDiv Mod Pow And Or Not USub UAdd Eq NotEq Lt LtE Gt GtE Is IsNot In NotIn".split())
ATTRIBUTES = set("writer QUOTE_ALL StringIO getvalue append extend sort strip join writerow writerows get copy items keys values count pop remove insert index split replace lower upper startswith endswith".split())
BUILTIN_NAMES = set("str int float bool list tuple dict set len min max sorted reversed range enumerate zip sum any all abs round isinstance ValueError KeyError TypeError RuntimeError Exception".split())

def admit(source):
    if len(source.encode()) > 131072: raise RuntimeError("candidate_not_admitted: source bound")
    tree = ast.parse(source, filename="solution.py")
    if sum(1 for _ in ast.walk(tree)) > 8192: raise RuntimeError("candidate_not_admitted: syntax bound")
    for node in ast.walk(tree):
        if type(node).__name__ not in NODE_NAMES: raise RuntimeError("candidate_not_admitted: unsupported syntax")
        if isinstance(node, ast.Name) and node.id.startswith("__"): raise RuntimeError("candidate_not_admitted: reflection")
        if isinstance(node, (ast.FunctionDef, ast.arg)) and (node.name if isinstance(node, ast.FunctionDef) else node.arg).startswith("__"): raise RuntimeError("candidate_not_admitted: reflection")
        if isinstance(node, ast.Import) and any(alias.name not in {"csv", "io"} or (alias.asname or "").startswith("__") for alias in node.names): raise RuntimeError("candidate_not_admitted: import")
        if isinstance(node, ast.Global) and any(name.startswith("__") for name in node.names): raise RuntimeError("candidate_not_admitted: reflection")
        if isinstance(node, ast.Attribute):
            if node.attr not in ATTRIBUTES or not isinstance(node.ctx, ast.Load): raise RuntimeError("candidate_not_admitted: attribute")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"getattr", "setattr", "delattr", "globals", "locals", "vars", "dir", "eval", "exec", "compile", "open", "input", "print", "help", "breakpoint", "memoryview", "super", "type"}: raise RuntimeError("candidate_not_admitted: reflection or IO")
        if isinstance(node, ast.Compare):
            left = node.left
            for operator, right in zip(node.ops, node.comparators):
                singleton = lambda value: isinstance(value, ast.Constant) and (value.value is None or type(value.value) is bool)
                if isinstance(operator, (ast.Is, ast.IsNot)) and not (singleton(left) or singleton(right)):
                    raise RuntimeError("candidate_not_admitted: non-singleton identity comparison")
                left = right
        if isinstance(node, ast.FunctionDef) and node.decorator_list: raise RuntimeError("candidate_not_admitted: decorator")
    return compile(tree, "solution.py", "exec")

def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level or name not in {"csv", "io"}: raise RuntimeError("candidate_not_admitted: import")
    return {"csv": csv, "io": io}[name]

def emit(value):
    encoded = json.dumps(value, ensure_ascii=True, allow_nan=False)
    if len(encoded) > 131072: raise RuntimeError("candidate output bound exceeded")
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()

graph_spec = importlib.util.spec_from_file_location("host_object_graph", Path(__file__).with_name("task_quality_object_graph.py"))
graph_module = importlib.util.module_from_spec(graph_spec)
graph_spec.loader.exec_module(graph_module)

def main():
    initial = json.loads(sys.stdin.readline(65536))
    if initial.get("mode") == "isolation_probe":
        denied = []
        for path, mode in [(initial["read"], "r"), (initial["write"], "w")]:
            try:
                with open(path, mode) as target:
                    target.read() if mode == "r" else target.write("forged")
            except (PermissionError, FileNotFoundError): denied.append(True)
            else: denied.append(False)
        try:
            with socket.socket() as connection:
                connection.settimeout(2)
                connection.connect(("127.0.0.1", initial["port"]))
        except OSError as error:
            # The parent supplies an actually listening host port. Linux's
            # separate network namespace cannot reach it; macOS denies it.
            denied.append(error.errno in {errno.EPERM, errno.EACCES, errno.ECONNREFUSED, errno.ENETUNREACH, errno.ENETDOWN, errno.EHOSTUNREACH})
        else: denied.append(False)
        emit({"isolated": denied == [True, True, True]})
        return
    source = open(initial["file"], encoding="utf8").read(131073)
    safe_builtins = {name: getattr(builtins, name) for name in BUILTIN_NAMES}
    safe_builtins["__import__"] = safe_import
    namespace = {"__builtins__": safe_builtins}
    with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
        exec(admit(source), namespace)
    emit({"ready": True})
    graph = graph_module.ObjectGraph("w")
    # Namespace and module state persist for the complete frozen oracle run.
    for line in sys.stdin:
        if len(line) > 65536: raise RuntimeError("candidate input bound exceeded")
        request = json.loads(line)
        graph.apply(request["graph"])
        arguments = [graph.decode(argument) for argument in request["args"]]
        function = namespace.get(request["function"])
        if not callable(function): raise RuntimeError("candidate function unavailable")
        with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
            try:
                result = function(*arguments)
                response = {"result": graph.encode(result)}
            except (KeyError, ValueError, TypeError, RuntimeError) as error:
                response = {"exception": type(error).__name__}
        response["graph"] = graph.snapshot()
        emit(response)

main()
