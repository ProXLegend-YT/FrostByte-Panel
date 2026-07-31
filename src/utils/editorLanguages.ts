import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { javascript } from "@codemirror/lang-javascript";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { xml } from "@codemirror/legacy-modes/mode/xml";

// Extension -> a function producing the CodeMirror extension(s) for it.
// Deliberately covers real files people actually open on a game-server
// panel (server.properties, plugin/mod configs, logs, scripts) rather than
// trying to be a general-purpose IDE for every language under the sun.
const LANGUAGE_BY_EXT: Record<string, () => Extension> = {
  json: () => json(),
  json5: () => json(),
  jsonc: () => json(),

  yml: () => yaml(),
  yaml: () => yaml(),

  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  ts: () => javascript({ typescript: true }),

  properties: () => StreamLanguage.define(properties),
  toml: () => StreamLanguage.define(toml),

  sh: () => StreamLanguage.define(shell),
  bash: () => StreamLanguage.define(shell),

  conf: () => StreamLanguage.define(nginx),

  xml: () => StreamLanguage.define(xml),
};

// Files with no extension but a recognizable name (case-insensitive).
const LANGUAGE_BY_FILENAME: Record<string, () => Extension> = {
  dockerfile: () => StreamLanguage.define(dockerFile),
};

export function languageExtensionFor(filename: string): Extension[] {
  const lower = filename.toLowerCase();
  const byName = LANGUAGE_BY_FILENAME[lower];
  if (byName) return [byName()];

  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const byExt = LANGUAGE_BY_EXT[ext];
  if (byExt) return [byExt()];

  // No specific language — CodeMirror still renders it fine as plain text
  // with line numbers, selection, search, etc. from the base setup.
  return [];
}
