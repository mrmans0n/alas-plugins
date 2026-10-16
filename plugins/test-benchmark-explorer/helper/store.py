def validate_config(value):
    if not isinstance(value, dict) or not isinstance(value.get("profiles"), list) or len(value["profiles"]) > 16:
        raise ValueError("Configuration needs profiles, at most 16")
    if len(canonical(value).encode("utf-8")) > 16384:
        raise ValueError("Configuration exceeds 16 KiB")
    seen = set()
    for profile in value["profiles"]:
        if not isinstance(profile, dict) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", str(profile.get("id", ""))):
            raise ValueError("Profile IDs use 1–32 lowercase letters, numbers or hyphens")
        if profile["id"] in seen or not isinstance(profile.get("script"), str) or not profile["script"] or len(profile["script"]) > 1024:
            raise ValueError("Profiles need unique IDs and a run-script key")
        seen.add(profile["id"])
        for field in ("toolchain", "configuration", "target"):
            if field in profile and (not isinstance(profile[field], str) or len(profile[field]) > 512):
                raise ValueError("Profile condition labels must be strings up to 512 characters")
        artifacts = profile.get("artifacts")
        if not isinstance(artifacts, list) or not 1 <= len(artifacts) <= 16:
            raise ValueError("Each profile needs 1–16 artifact declarations")
        for artifact in artifacts:
            path_parts(artifact["path"])
            if artifact.get("format") not in ("junit", "benchmark", "xcresult"):
                raise ValueError("Unknown artifact format")
        thresholds = profile.get("thresholds", {})
        if not isinstance(thresholds, dict) or any(not finite(v) or v < 0 for v in thresholds.values()):
            raise ValueError("Regression thresholds must be nonnegative finite percentages")
    return value


def installation(root, identity):
    value = safe_json(root, GENERATED + "/installation.json")
    for field in ("project", "worktree", "hostKey"):
        if value.get(field) != identity.get(field):
            raise ValueError("Capture belongs to another " + field)
    if value.get("root") != str(Path(root).resolve()):
        raise ValueError("Worktree moved; reinstall the capture wrapper before running it")
    return value


def install_helper(root, identity, config, program):
    root = Path(root).resolve()
    validate_config(config)
    for field in ("project", "worktree", "hostKey"):
        if not isinstance(identity.get(field), str) or not identity[field] or len(identity[field]) > 4096:
            raise ValueError("Missing installation " + field)
    try:
        old = installation(root, identity)
    except (ValueError, OSError):
        old = {}
    value = {**identity, "root": str(root), "token": old.get("token", uuid.uuid4().hex),
             "helperVersion": HELPER_VERSION, "helperDigest": digest(program.encode("utf-8"))}
    safe_write(root, GENERATED + "/capture.py", program.encode("utf-8"))
    write_json(root, GENERATED + "/configuration.json", config)
    write_json(root, GENERATED + "/installation.json", value)
    return {"installed": True, "path": GENERATED + "/capture.py", "helperVersion": HELPER_VERSION}


def capture_key(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}|[a-f0-9]{64}", value):
        raise ValueError("Invalid capture identity")
    return value


def run_key(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("Expected an Alas run UUID") from error


def summarize_result(result):
    source = result.get("source", {})
    summary = {key: result.get(key) for key in ("id", "schema", "project", "worktree", "hostKey", "host", "run", "script", "capturedAt", "conditions", "complete")}
    command = result.get("command", {})
    summary["command"] = {"outcome": command.get("outcome", "unknown"), "exit": command.get("exit"),
                          "argv": [str(a)[:256] for a in command.get("argv", [])[:8]],
                          "truncated": len(command.get("argv", [])) > 8 or any(len(str(a)) > 256 for a in command.get("argv", [])),
                          "startedAt": command.get("startedAt"), "endedAt": command.get("endedAt")}
    if command.get("hostOutcome"):
        summary["command"]["outcome"] = command["hostOutcome"]
    summary["counts"] = result_counts(result)
    summary["source"] = {"state": source.get("state", "unknown"), "reason": str(source.get("reason", ""))[:1024],
                         "head": source.get("before", {}).get("head"), "checkedAt": source.get("checkedAt")}
    summary["sourceEvidence"] = {point: {key: source.get(point, {}).get(key) for key in ("known", "digest", "head", "reason")} for point in ("before", "after")}
    summary["sourceEvidence"]["observation"] = {key: source.get("observation", {}).get(key) for key in ("supported", "changed", "reason")}
    summary["detail"] = "available"
    summary["issues"] = [{"message": str(i.get("message", ""))[:512], "path": str(i.get("path", ""))[:256]} for i in result.get("issues", [])[:8]]
    summary["artifacts"] = [{k: str(a.get(k, ""))[:512] for k in ("id", "path", "digest", "format")} for a in result.get("artifacts", [])[:4]]
    summary["artifactCount"] = len(result.get("artifacts", []))
    return summary


def persist_result(root, result):
    key = capture_key(result["id"])
    write_json(root, GENERATED + "/results/" + key + ".json", result)
    summary = summarize_result(result)
    write_json(root, GENERATED + "/summaries/" + key + ".json", summary)
    return summary


def validate_result(result, identity):
    if not isinstance(result, dict) or result.get("schema") != SCHEMA:
        raise ValueError("Unsupported normalized result model")
    for field in ("project", "worktree", "hostKey"):
        if result.get(field) != identity.get(field):
            raise ValueError("Result belongs to another " + field)
    if not isinstance(result.get("tests"), list) or not isinstance(result.get("benchmarks"), list):
        raise ValueError("Normalized detail is malformed")
    if len(result["tests"]) + len(result["benchmarks"]) > MAX_ROWS:
        raise ValueError("Normalized result exceeds its row budget")
    capture_key(result.get("id"))
    return result


def load_result(root, identity, capture):
    result = validate_result(safe_json(root, GENERATED + "/results/" + capture_key(capture) + ".json"), identity)
    try:
        summary = safe_json(root, GENERATED + "/summaries/" + capture_key(capture) + ".json")
        if summary.get("id") == result["id"]:
            result.setdefault("source", {}).update(summary.get("source", {}))
    except FileNotFoundError:
        pass
    return result


def load_run(root, identity, run):
    record = safe_json(root, GENERATED + "/runs/" + run_key(run) + ".json")
    if record.get("run") != run:
        raise ValueError("Run manifest does not match the requested run")
    result = load_result(root, identity, record["capture"])
    installed = installation(root, identity)
    if result.get("run") != run or result.get("installation") != installed["token"]:
        raise ValueError("Run capture identity did not validate")
    return result


def manual_import(root, request):
    result = import_artifacts(root, request.get("specs", []))
    identity = {key: request[key] for key in ("project", "worktree", "hostKey")}
    references = sorted((a["path"], a["digest"], a["format"]) for a in result["artifacts"])
    key = digest(canonical([identity, references, None if references else request.get("specs")]).encode("utf-8"))
    result.update(identity, id=key, capturedAt=time.time(), host=socket.gethostname(),
                  source={"state": "unknown", "reason": "Manual artifact import has no execution-boundary source capture"},
                  command={"outcome": "unknown", "argv": []}, conditions=request.get("conditions", {}))
    persist_result(root, result)
    return result


def list_summaries(root, identity):
    try:
        files = walk_files(root, GENERATED + "/summaries")
    except FileNotFoundError:
        return []
    summaries = []
    for path in files:
        if not re.fullmatch(r"(?:[a-f0-9]{32}|[a-f0-9]{64})\.json", path.rsplit("/", 1)[-1]):
            continue
        summary = safe_json(root, path)
        if all(summary.get(k) == identity.get(k) for k in ("project", "worktree", "hostKey")):
            summaries.append(summary)
    return sorted(summaries, key=lambda s: s.get("capturedAt", 0), reverse=True)


def refresh_summary_sources(root, summaries):
    def needs_current(summary):
        proof = summary.get("sourceEvidence", {})
        before, after, observer = proof.get("before", {}), proof.get("after", {}), proof.get("observation", {})
        return before.get("known") and after.get("known") and observer.get("supported") and not observer.get("reason") and not observer.get("changed") and before.get("digest") == after.get("digest")
    current = fingerprint(root) if any(needs_current(s) for s in summaries) else {"known": False, "reason": "No stable source capture"}
    for summary in summaries:
        proof = summary.get("sourceEvidence", {})
        summary["source"].update(source_freshness(root, proof, current))
        write_json(root, GENERATED + "/summaries/" + capture_key(summary["id"]) + ".json", summary)
    return summaries


def remove_generated_file(root, path):
    parent, name = parent_fd(root, path)
    try:
        os.unlink(name, dir_fd=parent)
    except FileNotFoundError:
        pass
    finally:
        os.close(parent)


def prune_results(root, identity, pinned=None, now=None, max_bytes=128 * 1024 * 1024):
    now = time.time() if now is None else now
    pinned = set((pinned or [])[:2])
    write_json(root, GENERATED + "/pins.json", list(pinned))
    prune_comparisons(root, "")
    summaries = list_summaries(root, identity)
    retained, total = 0, 0
    ordered = sorted(summaries, key=lambda s: (s["id"] not in pinned, -s.get("capturedAt", 0)))
    for summary in ordered:
        path = GENERATED + "/results/" + capture_key(summary["id"]) + ".json"
        try:
            data = safe_read(root, path)
        except FileNotFoundError:
            summary["detail"] = "pruned" if summary.get("detail") == "pruned" else "missing"
        else:
            expired = now - summary.get("capturedAt", 0) > 30 * 86400 and summary["id"] not in pinned
            if retained >= 30 or total + len(data) > max_bytes or expired:
                remove_generated_file(root, path)
                summary["detail"] = "pruned"
            else:
                total += len(data)
                retained += 1
        write_json(root, GENERATED + "/summaries/" + summary["id"] + ".json", summary)
    keep = sorted(summaries, key=lambda s: (s["id"] not in pinned, -s.get("capturedAt", 0)))[:40]
    for summary in summaries:
        if summary not in keep:
            remove_generated_file(root, GENERATED + "/summaries/" + summary["id"] + ".json")
            if summary.get("run"):
                for suffix in (".json", ".claim"):
                    remove_generated_file(root, GENERATED + "/runs/" + run_key(summary["run"]) + suffix)
    return sorted(keep, key=lambda s: s.get("capturedAt", 0), reverse=True)


def prune_comparisons(root, keep, max_bytes=32 * 1024 * 1024):
    try:
        files = walk_files(root, GENERATED + "/comparisons")
    except FileNotFoundError:
        return
    total = 0
    files.sort(key=lambda path: (path.endswith("/" + keep + ".json"), os.lstat(Path(root) / path).st_mtime), reverse=True)
    for path in files:
        if not re.fullmatch(r"(?:[a-f0-9]{32}|[a-f0-9]{64})\.json", path.rsplit("/", 1)[-1]):
            continue
        metadata = os.lstat(Path(root) / path)
        if total + metadata.st_size > max_bytes or time.time() - metadata.st_mtime > 1800:
            remove_generated_file(root, path)
        else:
            total += metadata.st_size


def check_evidence(root, result):
    states = []
    for artifact in result.get("artifacts", []):
        item = {"id": artifact["id"], "path": artifact["path"], "state": "unknown"}
        try:
            if artifact["format"] == "xcresult":
                hasher, size = hashlib.sha256(), 0
                for file in walk_files(root, artifact["path"]):
                    data = safe_read(root, file, MAX_BUNDLE)
                    size += len(data)
                    if size > MAX_BUNDLE:
                        raise ValueError("Artifact exceeds the evidence verification limit")
                    hasher.update(canonical([file[len(artifact["path"]) + 1:], digest(data)]).encode("utf-8"))
                checksum = hasher.hexdigest()
            else:
                checksum = digest(safe_read(root, artifact["path"]))
            item["state"] = "available" if checksum == artifact["digest"] else "replaced"
        except FileNotFoundError:
            item["state"] = "missing"
        except (OSError, ValueError) as error:
            item["reason"] = str(error)
        states.append(item)
    return states
