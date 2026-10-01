// Pixel Office: one character per agent session, one desk per worktree.

import { log, present, requestSnapshot, sessionFocus, setRegions, worktreeSwitch, type Event, type Plugin, type Snapshot } from "@alas/plugin";
import { layout, type Layout } from "./layout.ts";
import { Renderer, regions, type Target } from "./render.ts";
import { World } from "./sim.ts";

export class Office implements Plugin {
  layout?: Layout;
  world = new World();
  renderer = new Renderer();
  /** The last regions sent, as JSON, so unchanged ones are not sent again. */
  regions = "";
  targets: Target[] = [];

  apply(snapshot: Snapshot): void {
    const next = layout(snapshot);
    this.world.sync(snapshot, next);
    this.layout = next;
  }

  handle(event: Event): void {
    switch (event.type) {
      case "activate":
        requestSnapshot();
        return;
      case "workspaceChanged":
      case "snapshot":
        return this.apply(event.snapshot);
      case "reply":
        // E.g. a session that ended between the snapshot and the click.
        if (event.error) log("warn", `request failed: ${event.error.code} ${event.error.message}`);
        return;
      case "tick": {
        if (!this.layout) return;
        this.world.step(event.dt);
        const frame = this.renderer.render(this.world, this.layout);
        present(0, frame.pixels, frame.width);
        const next = regions(this.world, this.layout);
        const json = JSON.stringify(next.regions);
        if (json !== this.regions) {
          setRegions(0, next.regions);
          this.regions = json;
        }
        this.targets = next.targets;
        return;
      }
      case "click": {
        const index = /^r\d+$/.test(event.region) ? Number(event.region.slice(1)) : -1;
        const target = this.targets[index];
        if (!target) return;
        if ("session" in target) sessionFocus(target.session);
        else worktreeSwitch(target.worktree);
        return;
      }
    }
  }
}
