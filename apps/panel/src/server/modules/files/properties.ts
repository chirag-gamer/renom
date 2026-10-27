/**
 * `server.properties` is a flat `key=value` file that Minecraft rewrites on
 * every start, in its own key order, with `#` comments preserved only by
 * accident. That makes it a poor fit for a generic text editor and a good fit
 * for typed fields — but only for the keys the panel actually understands.
 *
 * This module is the whole format knowledge: it decides which keys become
 * typed controls, which stay as free text, and it round-trips unknown keys and
 * comments untouched so saving never silently drops a setting the panel has
 * never heard of (mods add some, and old versions keep removed ones).
 */

/** How the Properties tab renders one key. */
export type PropertyKind = "boolean" | "number" | "enum" | "text";

export interface PropertyDefinition {
  key: string;
  label: string;
  kind: PropertyKind;
  /** Shown under the control; explains the consequence, not the syntax. */
  help: string;
  group: string;
  options?: string[];
  min?: number;
  max?: number;
  /** Panel-owned value (e.g. server-port): rendered read-only, PUT rejects it. */
  readonly?: boolean;
}

/**
 * Curated from the vanilla dedicated-server keys for 1.21. Deliberately short:
 * the useful ones, grouped the way a server owner thinks about them. Anything
 * absent still round-trips through the free-text group.
 */
export const PROPERTY_DEFINITIONS: readonly PropertyDefinition[] = [
  // Identity
  {
    key: "motd",
    label: "Message of the day",
    kind: "text",
    group: "Identity",
    help: "Shown under the server name in the multiplayer list. Supports § colour codes.",
  },
  {
    key: "max-players",
    label: "Player slots",
    kind: "number",
    group: "Player limits",
    help: "Maximum simultaneous players. Higher values cost memory.",
    min: 1,
    max: 10000,
  },
  // Gameplay
  {
    key: "difficulty",
    label: "Difficulty",
    kind: "enum",
    group: "Gameplay",
    options: ["peaceful", "easy", "normal", "hard"],
    help: "Peaceful turns off hostile mobs.",
  },
  {
    key: "gamemode",
    label: "Default game mode",
    kind: "enum",
    group: "Gameplay",
    options: ["survival", "creative", "adventure", "spectator"],
    help: "The game mode new players start in.",
  },
  {
    key: "force-gamemode",
    label: "Force game mode on join",
    kind: "boolean",
    group: "Gameplay",
    help: "Players switch to the default game mode every time they join.",
  },
  {
    key: "hardcore",
    label: "Hardcore",
    kind: "boolean",
    group: "Gameplay",
    help: "Players become spectators when they die and cannot respawn.",
  },
  {
    key: "pvp",
    label: "PvP",
    kind: "boolean",
    group: "Gameplay",
    help: "Whether players can damage each other.",
  },
  {
    key: "allow-flight",
    label: "Allow flying",
    kind: "boolean",
    group: "Gameplay",
    help: "Required for most flight mods; without it players are kicked.",
  },
  {
    key: "spawn-animals",
    label: "Spawn animals",
    kind: "boolean",
    group: "World",
    help: "Whether passive mobs spawn naturally.",
  },
  {
    key: "spawn-monsters",
    label: "Spawn monsters",
    kind: "boolean",
    group: "World",
    help: "Whether hostile mobs spawn naturally.",
  },
  {
    key: "spawn-npcs",
    label: "Spawn villagers",
    kind: "boolean",
    group: "World",
    help: "Whether villagers spawn in new villages.",
  },
  // Performance
  {
    key: "view-distance",
    label: "View distance",
    kind: "number",
    group: "World & performance",
    help: "How many chunks players can see. Lowering it saves the most memory.",
    min: 3,
    max: 32,
  },
  {
    key: "simulation-distance",
    label: "Simulation distance",
    kind: "number",
    group: "World & performance",
    help: "How far from players the world keeps running. Farms and redstone stop outside it.",
    min: 3,
    max: 32,
  },
  {
    key: "spawn-protection",
    label: "Spawn protection",
    kind: "number",
    group: "World & performance",
    help: "Radius around spawn where only operators can build. Set to 0 to turn off.",
    min: 0,
    max: 10000,
  },
  {
    key: "player-idle-timeout",
    label: "Idle kick (minutes)",
    kind: "number",
    group: "World & performance",
    help: "Set to 0 to never kick idle players.",
    min: 0,
    max: 10000,
  },
  // Access
  {
    key: "enable-command-block",
    label: "Command blocks",
    kind: "boolean",
    group: "Who can join",
    help: "Command blocks only run when this is on.",
  },
  {
    key: "white-list",
    label: "Whitelist",
    kind: "boolean",
    group: "Who can join",
    help: "Only players on the whitelist can join.",
  },
  {
    key: "enforce-whitelist",
    label: "Kick players not on the whitelist",
    kind: "boolean",
    group: "Who can join",
    help: "Kicks online players who aren't on the whitelist when it's turned on.",
  },
  {
    key: "online-mode",
    label: "Verify accounts with Mojang",
    kind: "boolean",
    group: "Who can join",
    help: "Turning this off allows non-premium accounts. Use the switch above instead.",
  },
  {
    key: "enforce-secure-profile",
    label: "Require signed chat",
    kind: "boolean",
    group: "Who can join",
    help: "Turn off for Bedrock players and most non-premium setups.",
  },
  {
    key: "allow-cheats",
    label: "Allow cheats",
    kind: "boolean",
    group: "Who can join",
    help: "Lets operators and command blocks use cheats in survival.",
  },
  // Network (read-mostly; the panel owns the port)
  {
    key: "server-port",
    label: "Server port",
    kind: "number",
    group: "Network",
    readonly: true,
    help: "Assigned by the panel from the server's allocation — change it on the Network tab, not here.",
    min: 1024,
    max: 65535,
  },
  {
    key: "max-tick-time",
    label: "Watchdog timeout (ms)",
    kind: "number",
    group: "Network",
    help: "-1 disables the watchdog that kills a hung server.",
    min: -1,
    max: 600000,
  },
];

export interface ParsedProperty {
  key: string;
  value: string;
  /** Definition for known keys; undefined means the panel shows it as free text. */
  definition?: PropertyDefinition;
}

export interface ParsedProperties {
  properties: ParsedProperty[];
}

const DEFINITION_BY_KEY = new Map(PROPERTY_DEFINITIONS.map((d) => [d.key, d]));

/**
 * Parse the file. Order is preserved: Minecraft re-sorts on write anyway, but a
 * user editing by hand should see their own layout, not an alphabetised one.
 */
export function parseProperties(text: string): ParsedProperties {
  const properties: ParsedProperty[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9._-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue; // comment or blank — not a setting
    const key = match[1]!;
    properties.push({
      key,
      value: match[2] ?? "",
      definition: DEFINITION_BY_KEY.get(key),
    });
  }
  return { properties };
}

/**
 * Write values back into the file text.
 *
 * Only keys already present are rewritten: adding a key the panel invented
 * would fight the server, which writes its own defaults for anything missing.
 *
 * Lines that are not a `key=` setting — blanks and `#` comments — pass through
 * untouched. A `#` inside a *value* is safe for the same reason: the key class
 * below excludes `#`, so `motd=a#b` still parses as key `motd`. A rewritten
 * line is re-emitted as `key=value` with no surrounding whitespace, so a file
 * the user indented by hand comes back flush-left for the keys it touched.
 */
export function applyPropertyChanges(
  text: string,
  changes: Readonly<Record<string, string>>,
): string {
  const lines = text.split(/\r?\n/);
  const remaining = new Map(Object.entries(changes));
  const out: string[] = [];
  for (const line of lines) {
    const match = /^\s*([A-Za-z0-9._-]+)\s*=/.exec(line);
    const key = match?.[1];
    if (key && remaining.has(key)) {
      out.push(`${key}=${remaining.get(key)}`);
      remaining.delete(key);
      continue;
    }
    out.push(line);
  }
  // Keys the caller asked for that the file never had: append rather than drop
  // them, so a save from the tab is never silently partial.
  for (const [key, value] of remaining) out.push(`${key}=${value}`);
  return out.join("\n");
}

/**
 * Coerce one submitted value against its definition, or reject it.
 * Returns the string the file should contain.
 */
export function coercePropertyValue(definition: PropertyDefinition, raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  if (definition.kind === "boolean") {
    if (value !== "true" && value !== "false") {
      throw new Error(`${definition.label} must be true or false`);
    }
    return value;
  }
  if (definition.kind === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new Error(`${definition.label} must be a whole number`);
    }
    if (definition.min !== undefined && parsed < definition.min) {
      throw new Error(`${definition.label} must be at least ${definition.min}`);
    }
    if (definition.max !== undefined && parsed > definition.max) {
      throw new Error(`${definition.label} must be at most ${definition.max}`);
    }
    return String(parsed);
  }
  if (definition.kind === "enum") {
    if (!definition.options?.includes(value)) {
      throw new Error(`${definition.label} must be one of ${definition.options?.join(", ")}`);
    }
    return value;
  }
  // Free text: a newline would let a value inject extra keys into the file.
  if (/[\r\n]/.test(value)) {
    throw new Error(`${definition.label} must be a single line`);
  }
  return value;
}
