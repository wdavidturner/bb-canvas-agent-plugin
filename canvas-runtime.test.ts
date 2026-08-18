import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "tldraw";
import type * as tldraw from "tldraw";
import { runCanvasCode, serializeCanvasResult } from "./canvas-runtime.js";

const originalMarker = Object.getOwnPropertyDescriptor(
  globalThis,
  "canvasAgentMarker",
);

afterEach(() => {
  if (originalMarker) {
    Object.defineProperty(globalThis, "canvasAgentMarker", originalMarker);
  } else {
    delete (globalThis as Record<string, unknown>).canvasAgentMarker;
  }
});

describe("canvas command runtime", () => {
  it("provides the editor and tldraw SDK", async () => {
    const editor = { answer: 40 } as unknown as Editor;
    const sdk = { increment: 2 } as unknown as typeof tldraw;

    await expect(
      runCanvasCode(editor, sdk, "return editor.answer + tldraw.increment"),
    ).resolves.toBe(42);
  });

  it("shadows common browser globals by default", async () => {
    await expect(
      runCanvasCode(
        {} as Editor,
        {} as typeof tldraw,
        `return {
          globalThis: typeof globalThis,
          fetch: typeof fetch,
          document: typeof document,
          window: typeof window,
        }`,
      ),
    ).resolves.toEqual({
      globalThis: "undefined",
      fetch: "undefined",
      document: "undefined",
      window: "undefined",
    });
  });

  it("can expose browser globals when explicitly enabled", async () => {
    (globalThis as Record<string, unknown>).canvasAgentMarker = 42;

    await expect(
      runCanvasCode(
        {} as Editor,
        {} as typeof tldraw,
        "return globalThis.canvasAgentMarker",
        { allowBrowserGlobals: true },
      ),
    ).resolves.toBe(42);
  });

  it("serializes awkward command results without failing the edit", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(JSON.parse(serializeCanvasResult(cyclic))).toMatchObject({
      unserializable: true,
    });
    expect(JSON.parse(serializeCanvasResult(() => undefined))).toEqual({
      unserializable: true,
      valueType: "function",
    });
    expect(JSON.parse(serializeCanvasResult("abcdefgh", 5))).toMatchObject({
      truncated: true,
    });
  });
});
