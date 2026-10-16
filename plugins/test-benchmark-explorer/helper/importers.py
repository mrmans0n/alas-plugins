# Concatenated with common.py into the shipped, standalone capture.py.

def parse_junit(text, artifact):
    if re.search(r"<!\s*(DOCTYPE|ENTITY)\b", text, re.I):
        raise ValueError("JUnit DTDs and entity declarations are not supported")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as error:
        raise ValueError("Malformed JUnit XML: " + str(error)) from error
    local = lambda element: element.tag.rsplit("}", 1)[-1]
    if local(root) not in ("testsuite", "testsuites"):
        raise ValueError("Expected a testsuite or testsuites JUnit root")
    rows = []
    def visit(element, ancestry):
        tag = local(element)
        if tag == "testsuite" and element.get("name"):
            ancestry = ancestry + [element.get("name")]
        if tag == "testcase":
            name = element.get("name")
            if not name:
                raise ValueError("JUnit testcase has no name")
            status = "passed"
            messages = []
            for child in element:
                kind = local(child)
                if kind in ("failure", "error", "skipped"):
                    if kind == "error" or status != "error" and kind == "failure":
                        status = "error" if kind == "error" else "failed"
                    elif kind == "skipped" and status == "passed":
                        status = "skipped"
                    messages.append("\n".join(filter(None, [child.get("type"), child.get("message"), "".join(child.itertext())])))
            index = len(rows)
            row = {"id": canonical(["junit", ancestry, element.get("classname"), name]),
                   "name": name, "suite": ancestry, "status": status,
                   "attempt": {"id": artifact + ":" + str(index), "ordered": False},
                   "evidence": {"artifact": artifact, "selector": "testcase[" + str(index) + "]"}}
            if element.get("classname"):
                row["classname"] = element.get("classname")
            duration = number(element.get("time"))
            if duration is not None:
                row["duration"] = duration
            source = location({"file": element.get("file"), "line": element.get("line")})
            if source:
                row["source"] = source
            if messages:
                row["failure"] = "\n\n".join(messages)
            rows.append(row)
            if len(rows) > MAX_ROWS:
                raise ValueError("JUnit exceeds 100,000 test attempts")
            return
        for child in element:
            visit(child, ancestry)
    visit(root, [])
    return rows


def measurement_key(row):
    return canonical([row["id"], row.get("parameters", {}), row["metric"], row["unit"],
                      row["direction"], row.get("statistic")])


def parse_benchmarks(text, artifact):
    document = json.loads(text)
    if not isinstance(document, dict) or document.get("format") != "alas-benchmarks" or document.get("version") != 1:
        raise ValueError("Expected alas-benchmarks version 1")
    measurements = document.get("measurements")
    if not isinstance(measurements, list) or len(measurements) > MAX_ROWS:
        raise ValueError("Expected at most 100,000 benchmark measurements")
    rows = []
    keys = set()
    for index, row in enumerate(measurements):
        if not isinstance(row, dict) or any(not isinstance(row.get(key), str) or not row[key] for key in ("id", "metric", "unit")):
            raise ValueError("Each benchmark needs an id, metric and unit")
        if not finite(row.get("value")) or row.get("direction") not in ("lower", "higher"):
            raise ValueError("A benchmark needs a finite value and lower/higher direction")
        if not isinstance(row.get("parameters", {}), dict):
            raise ValueError("Benchmark parameters must be a JSON object")
        if "statistic" in row and (not isinstance(row["statistic"], str) or not row["statistic"]):
            raise ValueError("Benchmark statistic must be a nonempty string when supplied")
        if "samples" in row and (not isinstance(row["samples"], list) or len(row["samples"]) > 10000 or not all(finite(v) for v in row["samples"])):
            raise ValueError("Benchmark samples must contain at most 10,000 finite numbers")
        canonical(row)  # Reject nonfinite values in nested parameters/metadata too.
        key = measurement_key(row)
        if key in keys:
            raise ValueError("Duplicate benchmark identity; supply one measurement with explicit samples/statistic")
        keys.add(key)
        result = {k: row[k] for k in ("id", "parameters", "metric", "value", "unit", "direction", "statistic", "samples", "summary") if k in row}
        if "conditions" in document:
            result["conditions"] = document["conditions"]
        result["evidence"] = {"artifact": artifact, "selector": "measurements[" + str(index) + "]"}
        rows.append(result)
    return rows


def parse_xcresult(tree, details, artifact):
    if not isinstance(tree, dict) or not isinstance(tree.get("testNodes"), list):
        raise ValueError("Unsupported xcresult tests schema")
    rows = []
    statuses = {"Passed": "passed", "Failed": "failed", "Skipped": "skipped", "Expected Failure": "passed"}
    def messages(node):
        found, source = [], None
        def descend(n):
            nonlocal source
            if n.get("nodeType") in ("Failure Message", "Skip Message", "Test Case Run") and n.get("name"):
                found.append(n["name"])
            source = source or location(n.get("sourceLocation"))
            for child in n.get("children", []):
                descend(child)
        descend(node)
        return "\n\n".join(dict.fromkeys(found)), source
    def emit(node, suite, case, suffix="", order=None, destination=None):
        identifier = case.get("nodeIdentifierURL", case.get("nodeIdentifier"))
        if not identifier:
            raise ValueError("xcresult test is missing its identifier")
        row = {"id": canonical(["xcresult", identifier, suffix, destination]), "name": case.get("name", identifier) + suffix,
               "suite": suite, "status": statuses.get(node.get("result", case.get("result")), "unknown"),
               "attempt": {"id": artifact + ":" + str(len(rows)), "ordered": order is not None},
               "evidence": {"artifact": artifact, "selector": identifier, "repetition": node.get("nodeIdentifier")}}
        if order is not None:
            row["attempt"]["order"] = order
        if destination:
            row["destination"] = destination
        duration = number(node.get("durationInSeconds"))
        if duration is not None:
            row["duration"] = duration
        failure, source = messages(node)
        if failure:
            row["failure"] = failure
        if source:
            row["source"] = source
        rows.append(row)
    def case_rows(case, suite, destination=None):
        detail = details.get(case.get("nodeIdentifierURL"), details.get(case.get("nodeIdentifier"), {}))
        root = dict(case)
        if detail.get("testRuns"):
            root["children"] = detail["testRuns"]
        execution_kinds = {"Device", "Test Plan Configuration", "Arguments", "Test Case Arguments", "Repetition"}
        def executions(node, suffix="", where=destination, order=None, identifier=None):
            kind = node.get("nodeType")
            identifier = node.get("nodeIdentifierURL", identifier)
            if kind == "Device":
                where = dict(where or {}, device=node.get("nodeIdentifier", node.get("name")))
            elif kind == "Test Plan Configuration":
                where = dict(where or {}, configuration=node.get("nodeIdentifier", node.get("name")))
            elif kind in ("Arguments", "Test Case Arguments"):
                suffix = " " + node.get("name", "unknown arguments")
            children = [c for c in node.get("children", []) if c.get("nodeType") in execution_kinds
                        and (c.get("nodeType") not in ("Arguments", "Test Case Arguments") or "result" in c or "nodeIdentifierURL" in c)]
            if children:
                for index, child in enumerate(children):
                    child_order = index if child.get("nodeType") == "Repetition" else order
                    executions(child, suffix, where, child_order, identifier)
            else:
                metadata = dict(case)
                if identifier:
                    metadata["nodeIdentifierURL"] = identifier
                emit(node, suite, metadata, suffix, order, where)
        executions(root)
    def visit(node, suite, destination=None):
        kind = node.get("nodeType")
        if kind == "Device":
            destination = dict(destination or {}, device=node.get("nodeIdentifier", node.get("name")))
        elif kind == "Test Plan Configuration":
            destination = dict(destination or {}, configuration=node.get("nodeIdentifier", node.get("name")))
        if kind == "Test Case":
            case_rows(node, suite, destination)
            return
        if kind in ("Test Suite", "Unit test bundle", "UI test bundle", "Test Plan"):
            suite = suite + [node.get("name", "Unknown suite")]
        for child in node.get("children", []):
            visit(child, suite, destination)
    for node in tree["testNodes"]:
        visit(node, [])
    if len(rows) > MAX_ROWS:
        raise ValueError("xcresult exceeds 100,000 test attempts")
    return rows


def xcresult_import(root, path):
    # Copy only regular files into a bounded snapshot so xcresulttool never follows
    # artifact symlinks or a concurrently replaced ancestor outside the worktree.
    files = walk_files(root, path)
    hasher, size = hashlib.sha256(), 0
    with tempfile.TemporaryDirectory(prefix="alas-xcresult-") as directory:
        bundle = Path(directory) / "Report.xcresult"
        bundle.mkdir()
        for file in files:
            data = safe_read(root, file, MAX_BUNDLE)
            size += len(data)
            if size > MAX_BUNDLE:
                raise ValueError("xcresult exceeds the 128 MiB bundle import limit")
            relative = file[len(path) + 1:]
            hasher.update(canonical([relative, digest(data)]).encode("utf-8"))
            destination = bundle / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        version = tool_output(["xcrun", "xcresulttool", "version"], 4096).strip()
        if "schema version: 0.4.0" not in version:
            raise ValueError("Unsupported xcresulttool schema; this importer requires schema 0.4.0. Tool: " + version)
        def query(kind, extra=None):
            return json.loads(tool_output(["xcrun", "xcresulttool", "get", "test-results", kind,
                                          "--schema-version", "0.4.0", "--path", str(bundle), "--compact"] + (extra or [])))
        summary, tree = query("summary"), query("tests")
        preliminary = parse_xcresult(tree, {}, "pending")
        details = {}
        # Detail queries are necessary only when the tree did not contain failure evidence.
        for row in preliminary:
            selector = row["evidence"]["selector"]
            if row["status"] in ("failed", "unknown") and not row.get("source") and selector not in details:
                if len(details) >= 100:
                    raise ValueError("xcresult needs more than 100 detail queries; import is incomplete")
                details[selector] = query("test-details", ["--test-id", selector])
        return hasher.hexdigest(), tree, details, summary, version


def import_artifacts(root, specs):
    root = Path(root)
    result = {"schema": SCHEMA, "complete": True, "tests": [], "benchmarks": [], "artifacts": [], "issues": []}
    seen = set()
    if not specs:
        result["complete"] = False
        result["issues"].append({"message": "No artifacts configured"})
    expanded = []
    for spec in specs:
        try:
            path, kind = spec["path"], spec["format"]
            path_parts(path)
            if kind not in ("junit", "benchmark", "xcresult"):
                raise ValueError("Unknown artifact format")
            if spec.get("directory") and kind != "xcresult":
                paths = [p for p in walk_files(root, path) if p.endswith(".xml" if kind == "junit" else ".json")]
                if not paths:
                    raise ValueError("Configured report directory contains no matching artifacts")
                expanded.extend({"path": p, "format": kind} for p in paths)
            else:
                expanded.append({"path": path, "format": kind})
        except (ValueError, OSError, KeyError) as error:
            result["complete"] = False
            result["issues"].append({"path": spec.get("path"), "message": str(error)})
    for spec in expanded:
        path, kind = spec["path"], spec["format"]
        if path in seen:
            continue
        seen.add(path)
        try:
            if len(seen) > MAX_ARTIFACTS:
                raise ValueError("Import exceeds 2000 artifacts")
            if kind == "xcresult":
                checksum, tree, details, summary, version = xcresult_import(root, path)
            else:
                data = safe_read(root, path)
                checksum = digest(data)
            identity = digest(canonical([path, checksum]).encode("utf-8"))
            artifact = {"id": identity, "path": path, "digest": checksum, "format": kind,
                        "importer": kind, "version": HELPER_VERSION, "available": True}
            result["artifacts"].append(artifact)
            if kind == "xcresult":
                artifact["toolVersion"] = version
                artifact["originalSummary"] = summary
                rows = parse_xcresult(tree, details, identity)
                result["tests"].extend(rows)
            else:
                text = data.decode("utf-8-sig")
                rows = parse_junit(text, identity) if kind == "junit" else parse_benchmarks(text, identity)
                result["tests" if kind == "junit" else "benchmarks"].extend(rows)
            if len(result["tests"]) + len(result["benchmarks"]) > MAX_ROWS or len(canonical(result).encode("utf-8")) > MAX_DETAIL:
                raise ValueError("Normalized capture exceeds 16 MiB or 100,000 rows")
        except (ValueError, OSError, UnicodeError, RecursionError) as error:
            result["complete"] = False
            result["issues"].append({"path": path, "message": str(error)[:4096]})
            # Never retain an over-budget partially appended artifact as a complete result.
            while len(result["tests"]) + len(result["benchmarks"]) > MAX_ROWS or len(canonical(result).encode("utf-8")) > MAX_DETAIL - 8192:
                rows = result["tests"] or result["benchmarks"]
                if not rows:
                    break
                del rows[max(0, len(rows) - max(1, len(rows) // 4)):]
    if any(row.get("status") == "unknown" for row in result["tests"]):
        result["complete"] = False
        result["issues"].append({"message": "Some test outcomes are unknown"})
    return result
