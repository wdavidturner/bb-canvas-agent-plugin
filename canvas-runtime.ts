import type { Editor } from "tldraw";
import type * as tldraw from "tldraw";

type AsyncCanvasCommand = new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as AsyncCanvasCommand;

const BROWSER_GLOBAL_NAMES = [
  "window",
  "document",
  "globalThis",
  "self",
  "parent",
  "top",
  "opener",
  "frames",
  "location",
  "history",
  "navigator",
  "screen",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
] as const;

export interface CanvasRuntimeOptions {
  allowBrowserGlobals?: boolean;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serializeCanvasResult(
  value: unknown,
  maxCharacters = 256_000,
): string {
  try {
    const serialized = JSON.stringify(value ?? null);
    if (typeof serialized !== "string") {
      return JSON.stringify({
        unserializable: true,
        valueType: typeof value,
      });
    }
    if (serialized.length <= maxCharacters) return serialized;
    return JSON.stringify({
      truncated: true,
      preview: serialized.slice(0, Math.max(0, maxCharacters - 1_000)),
    });
  } catch (error) {
    return JSON.stringify({
      unserializable: true,
      error: messageFor(error).slice(0, 2_000),
    });
  }
}

/**
 * Runs a command with an editor and SDK. Browser globals are shadowed by
 * default to prevent accidental plugin-wide UI changes. This is a usability
 * guardrail, not a security sandbox: determined code can still escape it.
 */
export async function runCanvasCode(
  editor: Editor,
  sdk: typeof tldraw,
  code: string,
  options: CanvasRuntimeOptions = {},
): Promise<unknown> {
  const run = new AsyncFunction(
    "editor",
    "tldraw",
    ...BROWSER_GLOBAL_NAMES,
    `"use strict";\n${code}`,
  );
  const scope = globalThis as Record<string, unknown>;
  const browserValues = options.allowBrowserGlobals
    ? BROWSER_GLOBAL_NAMES.map((name) => scope[name])
    : BROWSER_GLOBAL_NAMES.map(() => undefined);
  return run(editor, sdk, ...browserValues);
}
