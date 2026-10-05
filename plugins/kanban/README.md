# Kanban

A small ticket tracker for a project whose tickets start agents. Starting a
ticket creates a worktree and starts an agent with the ticket's title and
description; the ticket then follows its session, and the agent's final reply
is added to it as a comment. The board is a web tab (plugin API 12): the
plugin keeps the tickets, follows sessions and saves, and its page
(`page/main.ts`) draws the board and sends back what you do. It is written in
TypeScript on `@alas/plugin`.

## Build and install

From the repository root:

```bash
npm install
plugins/kanban/build.sh
```

`build.sh` works from any directory and installs into
`~/Library/Application Support/Alas/Plugins/kanban`. Set
`ALAS_APP_SUPPORT_DIR` to install into an isolated Alas profile instead.

Then turn on **Settings → Debug → Experimental → Plugins** (it only shows when
`~/.alas/.debug` exists), open **Settings → Plugins**, click **Approve…** on
Kanban (it asks to read the workspace, open sessions, read agents' final replies
and start agents), and open **View → Plugins → Board**, or **Kanban board** in
the command palette.

## Tickets

A ticket is numbered `KAN-<n>`. Numbers are never reused, even after a delete.
It has a title, a description, a priority (No priority, Low, Medium, High,
Urgent), an optional assignee, and comments.

The board has five columns, one per status: **Backlog**, **Todo**,
**In progress**, **In review** and **Done**. **Show cancelled** adds a
**Cancelled** column. A card shows the number, title, priority, assignee and,
when the ticket has a session, the agent's state.

- **Drag** a card to another column to change its status, or within a column
  to reorder it. The order is kept.
- **Click** a card to open it in the side panel, next to the board.
- **Search** matches titles and `KAN-<n>`; the menus beside it filter by
  priority and assignee.

### Keyboard

| Key | Does |
|---|---|
| `C` | New ticket |
| `/` | Search |
| `J` `K` or `↓` `↑` | Previous / next ticket in the column |
| `H` `L` or `←` `→` | Previous / next column |
| `Enter` | Open the selected ticket |
| `S`, `P`, `A` | Open the selected ticket at its status, priority or assignee menu |
| `Esc` | Leave a field, close the form or the panel, clear the search |
| `⌘Return` | Create the ticket, save the description, post the comment |

### Creating a ticket

**New ticket** (or `C`) opens a form above the board: a title, a description,
a priority and an assignee. Return in the title moves to the description, and
⌘Return creates the ticket. Without a title, the description's first line
becomes the title. New tickets start in Backlog.

### The side panel

- Status, priority and assignee menus. The assignee menu lists the agents Alas
  can start, refreshed each time a ticket opens.
- **Start** / **Open session**, the agent's state and the ticket's branch.
- The description, saved when you leave it or press ⌘Return.
- Comments, oldest first, from **You** or the **Agent**, and a field to add
  one (⌘Return posts it).
- **Cancel ticket** and **Delete** (click twice).

### Starting an agent

**Start** creates a new worktree on branch `task/kan-<n>` and starts the
assignee there, or the project's default agent when the ticket is unassigned.
The prompt is `KAN-<n>: <title>` followed by the description. Start is offered
while the ticket is open (not Done or Cancelled) and has no running session.
If the start is refused, the ticket keeps its status and shows the reason.

A started ticket follows its session: running, waiting for input or for
permission → **In progress**; idle → **In review**; a session that has gone missing after it was seen also → **In review** (unless it had already gone idle, so a status you set by hand survives a relaunch). A status you set
by hand holds until the session's state changes again. Done and Cancelled stop
following. **Open session** focuses the agent's session.

When a followed session goes idle after running, the plugin fetches the
agent's last reply once with `session/last_message` and adds it to the ticket
as an **Agent** comment.

## Upgrading

From 0.3: nothing to do. The tickets are stored the same way; only the board
moved from a view tab to a web tab, so it needs an Alas with plugin API 12.

### From the card board

A board saved by the earlier card version of this plugin is converted on first
load: each card becomes a ticket, numbered in card order, with its prompt as
the description and its session carried over. Columns map to statuses:
Backlog → Backlog, Running and Needs you → In progress, Review → In review,
Done → Done. Prompts longer than 4,000 characters are cut, the description
limit. The old `board` key is left in place, so nothing
is lost and an older plugin build still finds its board.

## Storage and caps

Tickets are saved per project in the plugin's storage: `meta`, an `index` with
one small record per ticket, and one `ticket-<n>` key per description and
comments. The board reads only the index; a ticket's body is read when its
screen opens or an agent comment arrives.

| Cap | Value |
|---|---|
| Tickets in the index | 300 |
| Done and Cancelled tickets kept in the index | 15, the oldest-closed leave first |
| Title | 200 characters |
| Description | 4,000 characters |
| Comments per ticket | 10, the oldest dropped first |
| Comment | 2,000 characters; a longer agent reply is cut |
| Labels | 8 of 32 characters |

Alas gives every plugin call 250 ms. After every change the plugin posts the
whole index (and the open ticket's body) to the page, which redraws; at the
caps that message stays far below the 1 MiB limit and takes a few milliseconds.
Archived tickets leave the index and their bodies are deleted. When the
tracker is full, a new ticket is refused until you delete some.

## Known limits

- If Alas quits while a ticket is starting, the ticket is not linked to the
  worktree and agent that were created: after a relaunch it moves to In review,
  and **Start again** makes a second worktree.
- All of a project's tickets share the plugin's 1 MB of storage. When it is
  full, saving shows an error.
