from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import select
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import xml.etree.ElementTree as ET

SCHEMA = 1
HELPER_VERSION = "1.0.0"
GENERATED = ".alas/test-benchmark-explorer"
MAX_DETAIL = 16 * 1024 * 1024
MAX_ROWS = 100000
MAX_PAGE = 64 * 1024
MAX_ARTIFACTS = 2000
MAX_BUNDLE = 128 * 1024 * 1024


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (ValueError, TypeError):
        return None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def path_parts(path):
    if not isinstance(path, str) or not path or len(path) > 4096 or "\x00" in path or "\\" in path:
        raise ValueError("Expected a nonempty relative path")
    parts = path.split("/")
    if any(p in ("", ".", "..") or p.casefold() == ".git" for p in parts):
        raise ValueError("Paths must stay inside the worktree and cannot include .git")
    return parts


def parent_fd(root, path, create=False):
    parts = path_parts(path)
    fd = os.open(str(root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def safe_read(root, path, limit=MAX_DETAIL):
    parent, name = parent_fd(root, path)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
                raise ValueError("Artifact is not a regular file or exceeds the byte limit")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                data = stream.read(limit + 1)
            after = os.fstat(fd)
            if len(data) > limit or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError("Artifact changed while being read or exceeds the byte limit")
            return data
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def safe_write(root, path, data):
    parent, name = parent_fd(root, path, create=True)
    temporary = "." + uuid.uuid4().hex + ".tmp"
    try:
        try:
            if stat.S_ISLNK(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode):
                raise ValueError("Refusing to replace a symlink")
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)


def safe_json(root, path):
    return json.loads(safe_read(root, path).decode("utf-8"))


def write_json(root, path, value):
    data = canonical(value).encode("utf-8")
    if len(data) > MAX_DETAIL:
        raise ValueError("Normalized result exceeds 16 MiB")
    safe_write(root, path, data)


def walk_files(root, path):
    """Enumerate regular files using held directory FDs, never following symlinks."""
    parent, name = parent_fd(root, path)
    found = []
    def visit(fd, relative):
        for entry in sorted(os.listdir(fd)):
            mode = os.stat(entry, dir_fd=fd, follow_symlinks=False).st_mode
            child_path = relative + "/" + entry
            if entry.casefold() == ".git" or stat.S_ISLNK(mode):
                raise ValueError("Report directories cannot contain symlinks or .git")
            if stat.S_ISDIR(mode):
                child = os.open(entry, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    visit(child, child_path)
                finally:
                    os.close(child)
            elif stat.S_ISREG(mode):
                found.append(child_path)
                if len(found) > MAX_ARTIFACTS:
                    raise ValueError("Report directory exceeds 2000 files")
            else:
                raise ValueError("Report directories cannot contain special files")
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            visit(fd, path)
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    return found


def tool_output(argv, limit=MAX_DETAIL, timeout=60):
    """Drain to a bounded spool; terminate oversized output rather than allocating it."""
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        process = subprocess.Popen(argv, stdout=out, stderr=err)
        deadline = time.monotonic() + timeout
        while process.poll() is None:
            if time.monotonic() >= deadline or os.fstat(out.fileno()).st_size + os.fstat(err.fileno()).st_size > limit:
                process.kill()
                process.wait()
                raise ValueError("Importer tool timed out or exceeded its output limit")
            try:
                process.wait(timeout=0.05)
            except subprocess.TimeoutExpired:
                pass
        if os.fstat(out.fileno()).st_size + os.fstat(err.fileno()).st_size > limit:
            raise ValueError("Importer tool exceeded its output limit")
        out.seek(0)
        err.seek(0)
        if process.returncode:
            raise ValueError("Importer tool failed: " + err.read(4096).decode("utf-8", "replace"))
        return out.read(limit).decode("utf-8")


def location(value):
    if not isinstance(value, dict):
        return None
    path = value.get("filePath", value.get("file"))
    line = value.get("lineNumber", value.get("line"))
    if not isinstance(path, str) or not path:
        return None
    result = {"path": path}
    if number(line) is not None and float(line).is_integer() and float(line) > 0:
        result["line"] = int(line)
    return result
