def capture_command(root, profile_id, argv):
    root = Path(root).resolve()
    execution_directory = Path.cwd().resolve()
    if execution_directory != root and root not in execution_directory.parents:
        raise ValueError("Command directory is outside the owning worktree")
    installed = safe_json(root, GENERATED + "/installation.json")
    installation(root, installed)
    config = validate_config(safe_json(root, GENERATED + "/configuration.json"))
    profile = next((p for p in config["profiles"] if p["id"] == profile_id), None)
    if profile is None or not argv:
        raise ValueError("Select a configured profile and supply the command after --")
    if digest(Path(__file__).read_bytes()) != installed["helperDigest"]:
        raise ValueError("Installed capture wrapper changed; reinstall it from the plugin")
    environment_identity = {"project": os.environ.get("ALAS_PROJECT_ID"), "worktree": os.environ.get("ALAS_WORKTREE_ID")}
    run = os.environ.get("ALAS_RUN_ID")
    if run:
        run_key(run)
        if any(environment_identity[k] != installed[k] for k in environment_identity) or os.environ.get("ALAS_RUN_SCRIPT_KEY") != profile["script"]:
            raise ValueError("API 16 launch identity does not match this worktree/profile")
        if str(Path(os.environ.get("ALAS_WORKTREE_ROOT", "")).resolve()) != str(root):
            raise ValueError("API 16 launch root does not match the installed worktree")
        parent, name = parent_fd(root, GENERATED + "/runs/" + run_key(run) + ".claim", create=True)
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            os.close(fd)
        except FileExistsError as error:
            raise ValueError("This run already has a capture or an interrupted capture; use a new Alas run") from error
        finally:
            os.close(parent)
    capture_id = uuid.uuid4().hex
    output_relative = GENERATED + "/output/" + capture_id
    parent, name = parent_fd(root, output_relative, create=True)
    try:
        os.mkdir(name, mode=0o700, dir_fd=parent)
    finally:
        os.close(parent)
    captured_at = time.time()
    observer = source_observer(root)
    before = fingerprint(root)
    child_env = dict(os.environ, ALAS_RESULTS_DIR=str(root / output_relative))
    stopped = False
    child = None
    def interrupt(signum, frame):
        nonlocal stopped
        stopped = True
        if child is not None and child.poll() is None:
            try:
                child.send_signal(signum)
            except ProcessLookupError:
                pass
    previous = {s: signal.signal(s, interrupt) for s in (signal.SIGTERM, signal.SIGINT)}
    started = time.time()
    launch_error = None
    try:
        child = subprocess.Popen(argv, cwd=execution_directory, env=child_env)
        code = child.wait()
    except OSError as error:
        code, launch_error = 127, str(error)
    finally:
        ended = time.time()
        after = fingerprint(root)
        observation = observer.finish()
        for s, handler in previous.items():
            signal.signal(s, handler)
    try:
        result = import_artifacts(root / output_relative, profile["artifacts"])
    except (ValueError, OSError, UnicodeError, RecursionError) as error:
        result = {"schema": SCHEMA, "complete": False, "tests": [], "benchmarks": [], "artifacts": [],
                  "issues": [{"message": "Normalization failed: " + str(error)[:2048]}]}
    for artifact in result["artifacts"]:
        artifact["path"] = output_relative + "/" + artifact["path"]
    if stopped or code < 0 or launch_error:
        result["complete"] = False
        result["issues"].append({"message": launch_error or "Command was stopped; artifacts may be incomplete"})
    source = {"before": before, "after": after, "observation": observation,
              "captureStartedAt": captured_at, "captureEndedAt": time.time(), "state": "unknown"}
    source.update(source_freshness(root, source))
    result.update({k: installed[k] for k in ("project", "worktree", "hostKey")},
                  id=capture_id, run=run, script=profile["script"], host=socket.gethostname(), cwd=str(execution_directory),
                  capturedAt=captured_at, installation=installed["token"], source=source,
                  command={"argv": argv, "startedAt": started, "endedAt": ended, "exit": code,
                           "outcome": "stopped" if stopped or code < 0 else "unknown" if launch_error else "succeeded" if code == 0 else "failed"},
                  conditions={"host": socket.gethostname(), "toolchain": profile.get("toolchain"),
                              "configuration": profile.get("configuration"), "target": profile.get("target")},
                  thresholds=profile.get("thresholds", {}), helperVersion=HELPER_VERSION)
    try:
        persist_result(root, result)
        if run:
            write_json(root, GENERATED + "/runs/" + run_key(run) + ".json", {"run": run, "capture": capture_id})
        try:
            pinned = safe_json(root, GENERATED + "/pins.json")
        except FileNotFoundError:
            pinned = []
        prune_results(root, installed, pinned)
        print("Structured results captured: " + capture_id, flush=True)
    except (OSError, ValueError) as error:
        print("Structured results unavailable: " + str(error), file=sys.stderr, flush=True)
    return 128 - code if code < 0 else code
