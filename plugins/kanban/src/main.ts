import { definePlugin } from "@alas/plugin";
import { Kanban } from "./kanban.ts";

definePlugin(new Kanban());
