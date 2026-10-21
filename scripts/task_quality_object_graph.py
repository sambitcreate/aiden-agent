"""Bounded identity-preserving RPC graph for the six synthetic Python tasks."""
MAX_NODES = 1024
MAX_ITEMS = 8192
MAX_DEPTH = 32

class ObjectGraph:
    def __init__(self, prefix):
        self.prefix = prefix
        self.objects = {}
        self.identities = {}
        self.next_id = 0

    def encode(self, value, depth=0):
        if depth > MAX_DEPTH: raise RuntimeError("object graph depth exceeded")
        if value is None or type(value) in (bool, int, float, str): return value
        if type(value) not in (list, dict, tuple): raise RuntimeError("unsupported candidate value type")
        identity = id(value)
        reference = self.identities.get(identity)
        if reference is None:
            if len(self.objects) >= MAX_NODES: raise RuntimeError("object graph capacity exceeded")
            self.next_id += 1
            reference = self.prefix + str(self.next_id)
            self.identities[identity] = reference
            self.objects[reference] = value
        return {"ref": reference}

    def snapshot(self):
        graph = {}
        items = 0
        # Encoding a container can discover more reachable objects. Every
        # retained object, including prior-call arguments, remains observed.
        while len(graph) < len(self.objects):
            for reference, value in list(self.objects.items()):
                if reference in graph: continue
                if type(value) is dict:
                    entries = [[self.encode(key), self.encode(item)] for key, item in value.items()]
                    kind = "dict"
                else:
                    entries = [self.encode(item) for item in value]
                    kind = "list" if type(value) is list else "tuple"
                items += len(entries)
                if items > MAX_ITEMS: raise RuntimeError("object graph item capacity exceeded")
                graph[reference] = {"kind": kind, "items": entries}
        return graph

    def decode(self, value, depth=0):
        if depth > MAX_DEPTH: raise RuntimeError("object graph depth exceeded")
        if value is None or type(value) in (bool, int, float, str): return value
        if type(value) is not dict or set(value) != {"ref"} or value["ref"] not in self.objects:
            raise RuntimeError("invalid object graph reference")
        return self.objects[value["ref"]]

    def apply(self, graph):
        if type(graph) is not dict or len(graph) > MAX_NODES: raise RuntimeError("invalid object graph")
        if sum(len(node.get("items", [])) for node in graph.values()) > MAX_ITEMS: raise RuntimeError("object graph item capacity exceeded")
        expected_types = {"list": list, "dict": dict, "tuple": tuple}
        for reference, node in graph.items():
            if not isinstance(reference, str) or len(reference) > 32 or set(node) != {"kind", "items"} or node["kind"] not in expected_types or type(node["items"]) is not list:
                raise RuntimeError("invalid object graph node")
            current = self.objects.get(reference)
            if reference in self.objects:
                if type(current) is not expected_types[node["kind"]]: raise RuntimeError("object graph identity changed type")
            elif node["kind"] != "tuple":
                value = [] if node["kind"] == "list" else {}
                self.objects[reference] = value
                self.identities[id(value)] = reference
        # Tuples can refer to already allocated mutable containers. Direct
        # tuple-only cycles cannot be constructed by ordinary Python values.
        resolving = set()
        def resolve_tuple(reference, depth=0):
            if reference in self.objects: return
            if depth > MAX_DEPTH or reference in resolving: raise RuntimeError("invalid immutable graph cycle")
            resolving.add(reference)
            node = graph[reference]
            for item in node["items"]:
                if type(item) is dict and "ref" in item and item["ref"] not in self.objects:
                    resolve_tuple(item["ref"], depth + 1)
            value = tuple(self.decode(item) for item in node["items"])
            self.objects[reference] = value
            self.identities[id(value)] = reference
            resolving.remove(reference)
        for reference, node in graph.items():
            if node["kind"] == "tuple": resolve_tuple(reference)
        # Populate existing containers in place so retained aliases in both
        # the candidate and trusted oracle see cross-call mutations.
        for reference, node in graph.items():
            target = self.objects[reference]
            if node["kind"] == "list": target[:] = [self.decode(item) for item in node["items"]]
            elif node["kind"] == "dict":
                pairs = [(self.decode(key), self.decode(value)) for key, value in node["items"]]
                target.clear()
                target.update(pairs)
