import { definePlugin } from "@alas/plugin";
import { LinearBridge } from "./bridge.ts";

definePlugin(new LinearBridge());
