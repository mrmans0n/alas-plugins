class UnknownObserver:
    def __init__(self, reason):
        self.reason = reason

    def finish(self):
        return {"supported": False, "changed": False, "reason": self.reason}


class MacObserver:
    """FSEvents with a running CFRunLoop and synchronous delivery barriers."""
    def __init__(self, root, git_dirs):
        self.root, self.git_dirs = root, git_dirs
        self.paths, self.reason = set(), None
        self.ready, self.stop = threading.Event(), threading.Event()
        self.stream = None
        self.cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        self.fs = ctypes.CDLL("/System/Library/Frameworks/CoreServices.framework/CoreServices")
        ptr = ctypes.c_void_p
        self.cf.CFStringCreateWithCString.argtypes = [ptr, ctypes.c_char_p, ctypes.c_uint32]
        self.cf.CFStringCreateWithCString.restype = ptr
        self.cf.CFArrayCreate.argtypes = [ptr, ctypes.POINTER(ptr), ctypes.c_long, ptr]
        self.cf.CFArrayCreate.restype = ptr
        self.cf.CFRelease.argtypes = [ptr]
        self.cf.CFRunLoopGetCurrent.restype = ptr
        self.cf.CFRunLoopRunInMode.argtypes = [ptr, ctypes.c_double, ctypes.c_ubyte]
        self.cf.CFRunLoopRunInMode.restype = ctypes.c_int32
        self.mode = ptr.in_dll(self.cf, "kCFRunLoopDefaultMode")
        callback_type = ctypes.CFUNCTYPE(None, ptr, ptr, ctypes.c_size_t, ptr,
                                         ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint64))
        def receive(stream, context, count, paths, flags, ids):
            try:
                names = ctypes.cast(paths, ctypes.POINTER(ctypes.c_char_p))
                for index in range(count):
                    flag = flags[index]
                    if flag & (0x1 | 0x2 | 0x4 | 0x8 | 0x20 | 0x40 | 0x80):
                        self.reason = "FSEvents lost coverage, changed roots or requires a rescan"
                    if flag & (0x100 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x4000 | 0x8000 | 0x400000):
                        self.paths.add(os.fsdecode(names[index]))
                    if len(self.paths) > 10000:
                        self.reason = "Source observation exceeded 10,000 paths"
            except BaseException as error:
                self.reason = "FSEvents callback could not classify an event: " + str(error)
        self.callback = callback_type(receive)
        self.fs.FSEventStreamCreate.argtypes = [ptr, callback_type, ptr, ptr, ctypes.c_uint64, ctypes.c_double, ctypes.c_uint32]
        self.fs.FSEventStreamCreate.restype = ptr
        self.fs.FSEventStreamScheduleWithRunLoop.argtypes = [ptr, ptr, ptr]
        self.fs.FSEventStreamStart.argtypes = [ptr]
        self.fs.FSEventStreamStart.restype = ctypes.c_ubyte
        for name in ("FSEventStreamFlushSync", "FSEventStreamStop", "FSEventStreamInvalidate", "FSEventStreamRelease"):
            getattr(self.fs, name).argtypes = [ptr]
        def run():
            strings, array = [], None
            try:
                strings = [self.cf.CFStringCreateWithCString(None, os.fsencode(p), 0x08000100) for p in sorted(set([str(root)] + git_dirs))]
                array = self.cf.CFArrayCreate(None, (ptr * len(strings))(*strings), len(strings), None)
                self.stream = self.fs.FSEventStreamCreate(None, self.callback, None, array, 0xFFFFFFFFFFFFFFFF, 0.01, 0x10 | 0x4 | 0x2)
                if not self.stream:
                    raise ValueError("Could not create FSEvents stream")
                self.fs.FSEventStreamScheduleWithRunLoop(self.stream, self.cf.CFRunLoopGetCurrent(), self.mode)
                if not self.fs.FSEventStreamStart(self.stream):
                    raise ValueError("Could not start FSEvents stream")
                self.ready.set()
                while not self.stop.is_set():
                    self.cf.CFRunLoopRunInMode(self.mode, 0.05, False)
            except BaseException as error:
                self.reason = "FSEvents unavailable: " + str(error)
                self.ready.set()
            finally:
                if self.stream:
                    self.fs.FSEventStreamStop(self.stream)
                    self.fs.FSEventStreamInvalidate(self.stream)
                    self.fs.FSEventStreamRelease(self.stream)
                if array:
                    self.cf.CFRelease(array)
                for item in strings:
                    if item:
                        self.cf.CFRelease(item)
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        if not self.ready.wait(5):
            self.reason = "FSEvents did not establish coverage before execution"
        if not self.reason:
            self.fs.FSEventStreamFlushSync(self.stream)
            self.paths.clear()

    def finish(self):
        if self.stream and self.thread.is_alive():
            self.fs.FSEventStreamFlushSync(self.stream)
        self.stop.set()
        self.thread.join(5)
        if self.thread.is_alive():
            self.reason = "FSEvents drain did not finish"
        try:
            changed = any(event_relevant(self.root, p, self.git_dirs) for p in self.paths)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            self.reason, changed = str(error), False
        return {"supported": self.reason is None, "changed": changed,
                "reason": self.reason, "mechanism": "FSEvents", "observedPaths": len(self.paths)}


class LinuxObserver:
    def __init__(self, root, git_dirs):
        self.root, self.git_dirs, self.paths, self.reason = root, git_dirs, {}, None
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.inotify_init1.argtypes = [ctypes.c_int]
        self.libc.inotify_init1.restype = ctypes.c_int
        self.libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        self.libc.inotify_add_watch.restype = ctypes.c_int
        self.fd = self.libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), "Could not start inotify")
        try:
            for base in sorted(set([str(root)] + git_dirs)):
                for directory, dirs, files in os.walk(base, followlinks=False):
                    dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(directory, d))
                               and (base in git_dirs or event_relevant(root, os.path.join(directory, d), git_dirs))]
                    watch = self.libc.inotify_add_watch(self.fd, os.fsencode(directory), 0x2 | 0x4 | 0x8 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x2000000)
                    if watch < 0:
                        raise OSError(ctypes.get_errno(), "Could not register complete inotify coverage")
                    self.paths[watch] = directory
                    if len(self.paths) > 20000:
                        raise ValueError("Source observer exceeds 20,000 directories")
        except BaseException:
            os.close(self.fd)
            raise

    def finish(self):
        changed, events = False, 0
        try:
            while True:
                try:
                    data = os.read(self.fd, 256 * 1024)
                except BlockingIOError:
                    break  # Kernel read barrier after the second source fingerprint.
                if not data:
                    break
                offset = 0
                while offset < len(data):
                    watch, mask, cookie, size = struct.unpack_from("iIII", data, offset)
                    name = os.fsdecode(data[offset + 16:offset + 16 + size].split(b"\0", 1)[0])
                    offset += 16 + size
                    events += 1
                    if mask & (0x4000 | 0x8000 | 0x400 | 0x800) or watch not in self.paths:
                        self.reason = "inotify lost coverage or its watched root changed"
                    else:
                        path = os.path.join(self.paths[watch], name)
                        if event_relevant(self.root, path, self.git_dirs):
                            changed = True
                    if events > 10000:
                        raise ValueError("Source observation exceeded 10,000 events")
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            self.reason = str(error)
        finally:
            os.close(self.fd)
        return {"supported": self.reason is None, "changed": changed, "reason": self.reason,
                "mechanism": "inotify", "observedEvents": events}


def mac_filesystem_type(path):
    # Darwin stat(1) %T is a file type marker, unlike GNU stat -f %T.
    # Match the public statfs64 layout in sys/mount.h instead.
    class StatFS(ctypes.Structure):
        _fields_ = [("bsize", ctypes.c_uint32), ("iosize", ctypes.c_int32),
                    ("blocks", ctypes.c_uint64), ("bfree", ctypes.c_uint64), ("bavail", ctypes.c_uint64),
                    ("files", ctypes.c_uint64), ("ffree", ctypes.c_uint64), ("fsid", ctypes.c_int32 * 2),
                    ("owner", ctypes.c_uint32), ("type", ctypes.c_uint32), ("flags", ctypes.c_uint32),
                    ("subtype", ctypes.c_uint32), ("name", ctypes.c_char * 16),
                    ("mount", ctypes.c_char * 1024), ("from_name", ctypes.c_char * 1024),
                    ("flags_ext", ctypes.c_uint32), ("reserved", ctypes.c_uint32 * 7)]
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "statfs64", libc.statfs)
    function.argtypes = [ctypes.c_char_p, ctypes.POINTER(StatFS)]
    function.restype = ctypes.c_int
    value = StatFS()
    if function(os.fsencode(path), ctypes.byref(value)) != 0:
        raise OSError(ctypes.get_errno(), "Could not inspect the source filesystem")
    return value.name.decode("ascii") if value.flags & 0x1000 else "network filesystem"


def source_observer(root):
    try:
        root = Path(root).resolve()
        git_dirs = sorted(set([git_output(root, ["rev-parse", "--absolute-git-dir"]),
                               git_output(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])]))
        if sys.platform == "darwin":
            if any(mac_filesystem_type(path) != "apfs" for path in [root] + git_dirs):
                return UnknownObserver("Source observation is verified only on local APFS on macOS")
            return MacObserver(root, git_dirs)
        if sys.platform.startswith("linux"):
            filesystem = tool_output(["stat", "-f", "-c", "%T", str(root)], 4096).strip()
            if filesystem not in ("ext2/ext3", "ext4", "xfs"):
                return UnknownObserver("Source observation is unverified on filesystem " + filesystem)
            return LinuxObserver(root, git_dirs)
        return UnknownObserver("This operating system has no supported source observer")
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        return UnknownObserver(str(error))
