# Worktree Setup

Gets every new worktree ready to work in. When a worktree is created in the
project, the plugin copies the files you list (`.env`, `.env.local`,
`config/local.json`, …) from the main worktree into it, then runs your setup
command there (`pnpm install`, `make bootstrap`, …). It works the same in
local projects and in remote projects on an SSH host. It uses plugin API 11
(`"remote": true`), and is the reference plugin for files and processes on
SSH hosts. It is written in TypeScript on `@alas/plugin`.

## Full access: it runs any command you configure

The setup command runs as `/bin/sh -c "<your command>"`. The manifest
declares that one process, `["/bin/sh", "-c"]` with your command appended, so
**the plugin can run any shell command you type in its configure sheet**, as
you, outside the sandbox, on this Mac or on the SSH host. It also writes files
in your worktrees. That is why the approval sheet marks it full access and
asks you to confirm. It only ever runs the command saved in its configuration,
and only in a worktree of the project.

| Capability | Why |
|---|---|
| `workspace.read` | The `worktree.created` event, and the snapshot that names the main and the selected worktree |
| `files.read` | Reads the files to copy from the main worktree, and lists the new one's folders |
| `files.write` | Writes the copies into the new worktree |
| `process.exec` | Runs the setup command (`setup`: `/bin/sh -c`, plus your command) |
| `notify` | Reports what it did |

## Build and install

From the repository root:

```bash
npm install
plugins/worktree-setup/build.sh
```

`build.sh` installs into `~/Library/Application Support/Alas/Plugins/worktree-setup`.
Set `ALAS_APP_SUPPORT_DIR` to install into an isolated Alas profile instead.
Approve it in **Settings → Plugins**.

## Configure

Open **Settings → Plugins → Worktree Setup → Configure…**. The configuration
is shared by every project.

- **Turn on / Turn off**: whether new worktrees are set up. On by default; it
  does nothing until you add a file or a command.
- **Files to copy**: paths relative to the worktree. Type one and press Return
  to add it. Absolute paths, `..` and anything under `.git` are refused.
- **Setup command**: one line, at most 1 KiB, saved on Return. Empty runs
  nothing. Chain steps with `&&`.
- **Run on current worktree now**: runs the setup on the worktree selected in
  the project, even when the plugin is turned off, to try a configuration. If
  that is the main worktree, nothing is copied (it is the source) and only
  the command runs.

## What a setup does

1. Picks the source: the project's main worktree, or the first one when no
   worktree is marked main.
2. For each listed file, one at a time: reads it from the source, and writes
   it into the new worktree unless a file of that name is already there,
   creating missing folders. Only UTF-8 text up to 512 KiB can be copied;
   a binary or larger file, or one missing from the source, is skipped and
   reported.
3. Starts the command in the new worktree as a long-running process. It shows
   in that worktree's Run tab, under *Plugins*, with its output and a Stop
   button. It has no time limit, and stops when the plugin stops.
4. Shows one notification, e.g. "Set up feature-x: copied 2 files, running
   `pnpm install`", with anything skipped and why the command could not
   start, if it could not.

## Remote projects

In a project on an SSH host, the files are read and written and the command
runs on the host, as your user there, in the worktree, with your login
shell's environment on the host. That needs:

- Alas with plugin API 11.
- The Alas helper installed on the host.
- For the command, a Linux host with kernel 5.3 or later (pidfds), so Alas can
  stop everything the command starts. Commands are refused on macOS SSH
  hosts; copying files still works there.

When the host refuses, the notification says why, for example
"plugin commands can't run on macOS SSH hosts: …" or "the Alas helper is not
installed on remote host devbox; …".

## Limits

- Alas shows at most one notification every 2 seconds, so when several
  worktrees are created at once some summaries may be dropped. The Run tab
  still shows each command.
- An instance runs at most 2 processes at a time; a third setup command is
  refused until one finishes, and the notification says so.
- An existing file in the new worktree is never overwritten.
