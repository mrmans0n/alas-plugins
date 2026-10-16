# Pure normalized-model operations, also used by the on-host bridge.

def logical_tests(result):
    groups = {}
    for row in result.get("tests", []):
        groups.setdefault(row["id"], []).append(row)
    output = {}
    for key, attempts in groups.items():
        ordered = all(a.get("attempt", {}).get("ordered") and "order" in a["attempt"] for a in attempts)
        if ordered and len({a["attempt"]["order"] for a in attempts}) == len(attempts):
            status = max(attempts, key=lambda a: a["attempt"]["order"])["status"]
        else:
            status = next((s for s in ("error", "failed", "unknown", "passed", "skipped") if any(a["status"] == s for a in attempts)), "unknown")
        logical = {"id": key, "name": attempts[0]["name"], "suite": attempts[0].get("suite", []),
                   "status": status, "attempts": len(attempts)}
        if all(finite(a.get("duration")) for a in attempts):
            logical["duration"] = sum(a["duration"] for a in attempts)
        output[key] = logical
    return output


def result_counts(result):
    tests = logical_tests(result)
    counts = {status: sum(row["status"] == status for row in tests.values()) for status in ("passed", "failed", "error", "skipped", "unknown")}
    counts.update(tests=len(tests), attempts=len(result.get("tests", [])), benchmarks=len(result.get("benchmarks", [])))
    counts["state"] = "incomplete" if not result.get("complete") else "failed" if counts["failed"] + counts["error"] else "unknown" if counts["unknown"] else "passed" if counts["passed"] else "no tests"
    return counts


def compare_results(base, current):
    before, after = logical_tests(base), logical_tests(current)
    tests = []
    failed = lambda row: row["status"] in ("failed", "error")
    for key in sorted(before.keys() | after.keys()):
        b, c = before.get(key), after.get(key)
        change = "unchanged"
        if b is None:
            change = "added" if base.get("complete") else "unknown"
        elif c is None:
            change = "removed" if current.get("complete") else "unknown"
        elif failed(b) and c["status"] == "passed":
            change = "recovered"
        elif b["status"] == "passed" and failed(c):
            change = "newly failing"
        row = {"id": key, "name": (c or b)["name"], "change": change,
               "baseline": b, "current": c}
        if b and c and finite(b.get("duration")) and finite(c.get("duration")):
            row["durationDelta"] = c["duration"] - b["duration"]
        tests.append(row)
    bg, cg = {}, {}
    for result, groups in ((base, bg), (current, cg)):
        for measurement in result.get("benchmarks", []):
            groups.setdefault(measurement_key(measurement), []).append(measurement)
    benchmarks = []
    for key in sorted(bg.keys() | cg.keys()):
        bs, cs = bg.get(key, []), cg.get(key, [])
        b, c = bs[0] if bs else None, cs[0] if cs else None
        example = c or b
        row = {"key": key, "id": example["id"], "parameters": example.get("parameters", {}), "metric": example["metric"],
               "unit": example["unit"], "direction": example["direction"], "statistic": example.get("statistic"),
               "baseline": b["value"] if b else None, "current": c["value"] if c else None,
               "compatible": False, "significance": "not assessed",
               "baselineSamples": b.get("samples") if b else None, "currentSamples": c.get("samples") if c else None}
        bc, cc = (b or {}).get("conditions", base.get("conditions", {})), (c or {}).get("conditions", current.get("conditions", {}))
        row["conditions"] = {"baseline": bc, "current": cc}
        if not b or not c:
            row["reason"] = "No matching measurement with the same parameters, metric, unit, direction and statistic"
        elif len(bs) != 1 or len(cs) != 1:
            row["reason"] = "Multiple measurements have this identity; no unambiguous pairing"
        elif not base.get("complete") or not current.get("complete"):
            row["reason"] = "An import is incomplete"
        else:
            different = [field for field in ("host", "toolchain", "configuration", "target") if not bc.get(field) or not cc.get(field) or bc[field] != cc[field]]
            if different:
                row["reason"] = "Different or unknown execution conditions: " + ", ".join(different)
            else:
                row["compatible"] = True
                row["absolute"] = c["value"] - b["value"]
                row["percent"] = row["absolute"] / abs(b["value"]) * 100 if b["value"] else None
                threshold = current.get("thresholds", {}).get(example["id"])
                if finite(threshold) and threshold >= 0 and row["percent"] is not None:
                    row["threshold"] = threshold
                    row["regression"] = row["percent"] * (1 if example["direction"] == "lower" else -1) > threshold
        benchmarks.append(row)
    return {"tests": tests, "benchmarks": benchmarks}


def bounded_page(rows, offset=0, limit=100):
    offset = max(0, int(offset))
    limit = min(100, max(1, int(limit)))
    page, size = [], 0
    for row in rows[offset:offset + limit]:
        # Long evidence text is available separately, not silently erased in storage.
        display = dict(row)
        for key in ("failure", "name", "id"):
            if isinstance(display.get(key), str) and len(display[key]) > 4096:
                display[key] = display[key][:4096]
                display["textTruncated"] = True
        encoded = len(canonical(display).encode("utf-8"))
        if encoded > MAX_PAGE - 8192:
            display = {"id": str(row.get("id", ""))[:1024], "name": str(row.get("name", row.get("id", "")))[:1024],
                       "evidenceTooLarge": True, "message": "Use the evidence text view to inspect this row"}
            encoded = len(canonical(display).encode("utf-8"))
        if size + encoded > MAX_PAGE - 8192:
            break
        page.append(display)
        size += encoded
    end = offset + len(page)
    return {"rows": page, "total": len(rows), "offset": offset, "next": end if end < len(rows) else None}


def query_result(result, request):
    kind = request.get("kind", "tests")
    rows = result.get("benchmarks" if kind == "benchmarks" else "tests", [])
    search, status = str(request.get("search", "")).casefold(), request.get("status", "all")
    filtered = [dict(row, rowIndex=index) for index, row in enumerate(rows)
                if (not search or search in (str(row.get("name", row.get("id"))) + " " + " / ".join(row.get("suite", []))).casefold())
                and (status == "all" or row.get("status") == status)]
    return bounded_page(filtered, request.get("offset", 0))


def investigation_brief(result, selected=None, comparison=None):
    lines = ["Test & Benchmark investigation", "Capture: " + result.get("id", "unknown"),
             "Run: " + (result.get("run") or "unassociated"), "Worktree: " + result.get("worktree", "unknown"),
             "Host: " + result.get("host", "unknown"), "Captured: " + str(result.get("capturedAt", "unknown")),
             "Source: " + canonical(result.get("source", {})), "Command: " + canonical(result.get("command", {})),
             "Conditions: " + canonical(result.get("conditions", {})), "Import complete: " + str(result.get("complete", False))]
    selected = set(selected or [])
    for index, row in enumerate(result.get("tests", [])):
        if selected and index not in selected or not selected and row["status"] not in ("failed", "error"):
            continue
        lines += ["", row["status"] + ": " + row["name"], str(row.get("failure", "")),
                  "Location: " + canonical(row.get("source")), "Evidence: " + canonical(row.get("evidence"))]
    for row in result.get("benchmarks", []):
        lines += ["", "Measurement: " + canonical(row)]
    if comparison:
        lines += ["", "Comparison: " + canonical(comparison), "Statistical significance has not been assessed."]
    for artifact in result.get("artifacts", []):
        lines.append("Artifact: " + canonical(artifact))
    for issue in result.get("issues", []):
        lines.append("Import issue: " + canonical(issue))
    text = "\n".join(lines)
    return text[:48000] + ("\n[Brief truncated; inspect the retained evidence for the remainder.]" if len(text) > 48000 else "")
