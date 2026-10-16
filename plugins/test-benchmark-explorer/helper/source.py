def git_output(root, args, binary=False):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
    result = subprocess.run(["git", "-C", str(root)] + args, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, timeout=30)
    if result.returncode or len(result.stdout) > MAX_DETAIL:
        raise ValueError("Could not capture git source state: " + result.stderr[:1024].decode("utf-8", "replace"))
    return result.stdout if binary else result.stdout.decode("utf-8").strip()


def source_listing(root):
    index = git_output(root, ["ls-files", "--stage", "-z"], binary=True)
    staged = []
    for entry in index.split(b"\0"):
        if entry:
            metadata, path = entry.split(b"\t", 1)
            name = os.fsdecode(path)
            if name == GENERATED or name.startswith(GENERATED + "/"):
                continue
            mode = metadata.split(b" ", 1)[0]
            if mode == b"160000":
                raise ValueError("Submodule source capture is not supported; provenance remains unknown")
            staged.append((name, metadata.decode("ascii")))
    untracked = [os.fsdecode(path) for path in git_output(root, ["ls-files", "--others", "--exclude-standard", "-z"], binary=True).split(b"\0") if path]
    untracked = [p for p in untracked if p != GENERATED and not p.startswith(GENERATED + "/")]
    paths = sorted(set([p for p, _ in staged] + untracked))
    if len(paths) > MAX_ROWS:
        raise ValueError("Source capture exceeds 100,000 files")
    return staged, paths


def fingerprint(root):
    root = Path(root).resolve()
    try:
        repository = git_output(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        git_dir = git_output(root, ["rev-parse", "--absolute-git-dir"])
        top = git_output(root, ["rev-parse", "--show-toplevel"])
        if Path(top).resolve() != root:
            raise ValueError("Capture requires a project rooted at its git worktree; nested project roots remain unknown")
        head = git_output(root, ["rev-parse", "--verify", "HEAD"])
        staged, paths = source_listing(root)
        hasher = hashlib.sha256(canonical([str(root), repository, head, staged]).encode("utf-8"))
        states = {}
        for path in paths:
            parent, name = parent_fd(root, path)
            try:
                try:
                    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    states[path] = None
                    hasher.update(canonical([path, "deleted"]).encode("utf-8"))
                    continue
                if stat.S_ISLNK(before.st_mode):
                    contents = os.fsencode(os.readlink(name, dir_fd=parent))
                elif stat.S_ISREG(before.st_mode):
                    contents = safe_read(root, path, 64 * 1024 * 1024)
                else:
                    raise ValueError("Source contains an unsupported special file")
                states[path] = (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_mode)
                hasher.update(canonical([path, stat.S_IMODE(before.st_mode), digest(contents)]).encode("utf-8"))
            finally:
                os.close(parent)
        if git_output(root, ["rev-parse", "--verify", "HEAD"]) != head or source_listing(root) != (staged, paths):
            raise ValueError("Git state changed while capturing source")
        for path, before in states.items():
            try:
                after = os.lstat(root / path)
                after = (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_mode)
            except FileNotFoundError:
                after = None
            if after != before:
                raise ValueError("Source changed while capturing its fingerprint")
        return {"known": True, "digest": hasher.hexdigest(), "head": head, "repository": repository,
                "root": str(root), "gitDir": git_dir, "files": len(paths), "capturedAt": time.time(),
                "exclusions": [GENERATED, "nontracked gitignored files"]}
    except (ValueError, OSError, UnicodeError, subprocess.SubprocessError) as error:
        return {"known": False, "reason": str(error), "capturedAt": time.time()}


def source_freshness(root, source, current=None):
    checked = time.time()
    before, after = source.get("before", {}), source.get("after", {})
    observation = source.get("observation", {})
    if not before.get("known") or not after.get("known") or not observation.get("supported") or observation.get("reason"):
        return {"state": "unknown", "reason": source.get("reason") or observation.get("reason") or before.get("reason") or after.get("reason") or "No trustworthy source capture", "checkedAt": checked}
    if observation.get("changed") or before["digest"] != after["digest"]:
        return {"state": "changed during run", "reason": "Source changed during the enclosing capture interval", "checkedAt": checked}
    current = fingerprint(root) if current is None else current
    if not current.get("known"):
        return {"state": "unknown", "reason": current.get("reason"), "checkedAt": checked}
    return {"state": "current" if current["digest"] == after["digest"] else "stale", "head": before.get("head"), "checkedAt": checked}


def event_relevant(root, path, git_dirs):
    absolute = os.path.abspath(path)
    for directory in sorted(git_dirs, key=len, reverse=True):
        if absolute == directory or absolute.startswith(directory + os.sep):
            relative = os.path.relpath(absolute, directory)
            return relative in ("HEAD", "index", "packed-refs", "config") or relative.startswith("refs/")
    try:
        relative = str(Path(absolute).relative_to(root))
    except ValueError:
        return False
    if relative == ".":
        return False  # Root metadata is not a tracked input; per-file events are required.
    if relative == GENERATED or relative.startswith(GENERATED + "/") or relative == ".git" or relative.startswith(".git/"):
        return False
    result = subprocess.run(["git", "-C", str(root), "check-ignore", "-q", "--", relative],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            env=dict(os.environ, GIT_OPTIONAL_LOCKS="0"), timeout=10)
    if result.returncode not in (0, 1):
        raise ValueError("Could not classify source observation against gitignore")
    return result.returncode == 1
