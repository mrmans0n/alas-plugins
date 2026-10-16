def bridge(root, request, program):
    if not isinstance(request, dict):
        raise ValueError("Malformed helper request")
    operation = request.get("operation")
    root = Path(root).resolve()
    identity = {key: request[key] for key in ("project", "worktree", "hostKey")}
    if operation == "install":
        return install_helper(root, identity, request["config"], program)
    if operation == "configure":
        installation(root, identity)
        write_json(root, GENERATED + "/configuration.json", validate_config(request["config"]))
        return {"configured": True}
    if operation == "list":
        summaries = refresh_summary_sources(root, prune_results(root, identity, request.get("pinned")))
        page = bounded_page(summaries, request.get("offset", 0), 5)
        return {"summaries": page["rows"], "next": page["next"]}
    if operation == "manual":
        result = manual_import(root, request)
        return {"summary": summarize_result(result)}
    if operation == "importRun":
        result = load_run(root, identity, request["run"])
        if request.get("script") and request["script"] != result.get("script"):
            raise ValueError("Capture belongs to another script")
        if request.get("outcome") in ("succeeded", "failed", "stopped", "unknown"):
            result["command"]["hostOutcome"] = request["outcome"]
            if request["outcome"] in ("stopped", "unknown"):
                result["complete"] = False
                message = "Alas reports a stopped/unknown command outcome; capture completion cannot be verified"
                if not any(i.get("message") == message for i in result["issues"]):
                    result["issues"].append({"message": message})
        result["source"].update(source_freshness(root, result.get("source", {})))
        return {"summary": persist_result(root, result)}
    if operation == "stage":
        token = capture_key(request["token"])
        path = GENERATED + "/comparisons/" + token + ".json"
        chunk = request.get("chunk")
        if not isinstance(chunk, str) or len(chunk.encode("utf-8")) > MAX_PAGE:
            raise ValueError("Comparison chunk is too large")
        data = b"" if request.get("offset") == 0 else safe_read(root, path)
        if len(data.decode("utf-8")) != request.get("offset"):
            raise ValueError("Comparison chunks arrived out of order")
        data += chunk.encode("utf-8")
        if len(data) > MAX_DETAIL:
            raise ValueError("Comparison exceeds the detail limit")
        safe_write(root, path, data)
        prune_comparisons(root, token)
        return {"staged": True}
    result = load_result(root, identity, request["capture"])
    if operation == "export":
        text = canonical(result)
        offset = max(0, int(request.get("offset", 0)))
        chunk = text[offset:offset + 12000]
        end = offset + len(chunk)
        return {"chunk": chunk, "offset": offset, "next": end if end < len(text) else None}
    if operation == "detail":
        summary = summarize_result(result)
        evidence = check_evidence(root, result)
        return {"summary": summary, "page": query_result(result, request), "evidence": bounded_page(evidence)["rows"], "evidenceTotal": len(evidence)}
    if operation == "freshness":
        source = source_freshness(root, result.get("source", {}))
        result["source"].update(source)
        return {"summary": persist_result(root, result)}
    if operation == "evidence":
        rows = result.get("benchmarks" if request.get("kind") == "benchmarks" else "tests", [])
        index = int(request["rowIndex"])
        if not 0 <= index < len(rows):
            raise ValueError("Evidence row is outside the retained result")
        row = rows[index]
        artifact = next((a for a in result.get("artifacts", []) if a["id"] == row.get("evidence", {}).get("artifact")), None)
        text = canonical({"row": row, "artifact": artifact, "capture": result["id"]})
        offset = max(0, int(request.get("offset", 0)))
        end = offset + 12000
        return {"text": text[offset:end], "next": end if end < len(text) else None}
    if operation in ("compare", "brief"):
        base = None
        if request.get("baseline"):
            base = load_result(root, identity, request["baseline"])
        elif request.get("foreignBaseline"):
            base = safe_json(root, GENERATED + "/comparisons/" + capture_key(request["foreignBaseline"]) + ".json")
            if base.get("schema") != SCHEMA or base.get("project") != identity["project"]:
                raise ValueError("Foreign baseline belongs to another project/model")
        comparison = compare_results(base, result) if base else None
        if operation == "brief":
            return {"text": investigation_brief(result, request.get("selected"), comparison, request.get("selectedBenchmarks"))}
        if not comparison:
            raise ValueError("Choose a baseline to compare")
        rows = comparison["benchmarks" if request.get("kind") == "benchmarks" else "tests"]
        search = str(request.get("search", "")).casefold()
        if search:
            rows = [row for row in rows if search in canonical([row.get("name"), row.get("id"), row.get("parameters"), row.get("metric")]).casefold()]
        return {"page": bounded_page(rows, request.get("offset", 0)),
                "baseline": {"id": base["id"], "host": base.get("host"), "source": base.get("source")}}
    raise ValueError("Unknown helper operation")


if __name__ == "__main__":
    if "request" in globals():
        try:
            reply = {"ok": True, "result": bridge(Path.cwd(), request, program)}
        except (ValueError, OSError, KeyError, TypeError, IndexError, RecursionError, subprocess.SubprocessError) as error:
            reply = {"ok": False, "error": str(error)[:4096]}
        encoded = canonical(reply)
        if len(encoded.encode("utf-8")) > 128 * 1024:
            encoded = canonical({"ok": False, "error": "Helper reply exceeds the bounded transport limit"})
        print(encoded)
    else:
        parser = argparse.ArgumentParser(description="Capture structured test and benchmark evidence for Alas")
        parser.add_argument("operation", choices=["capture"])
        parser.add_argument("--profile", required=True)
        separator = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
        args = parser.parse_args(sys.argv[1:separator])
        argv = sys.argv[separator + 1:]
        try:
            root = Path(os.environ.get("ALAS_WORKTREE_ROOT", Path.cwd())).resolve()
            sys.exit(capture_command(root, args.profile, argv))
        except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
            print("Capture failed: " + str(error), file=sys.stderr)
            sys.exit(2)
