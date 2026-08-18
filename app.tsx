import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type PluginMessageDirectiveProps,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Tldraw, getSnapshot, loadSnapshot, type Editor } from "tldraw";
import * as tldraw from "tldraw";
import type { canvasRpcContract } from "./server.js";
import "tldraw/tldraw.css";
import "./app.css";

interface CanvasCommand {
  id: string;
  canvasId: string;
  code: string;
  description: string;
  createdAt: number;
}

interface CanvasSurfaceProps {
  canvasId: string;
  name: string;
}

type AsyncCommand = new (
  ...args: string[]
) => (editor: Editor, sdk: typeof tldraw) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as AsyncCommand;

const SNAPSHOT_CACHE_LIMIT = 32;
const snapshotCache = new Map<string, string>();
const persistenceQueues = new Map<string, Promise<void>>();

function cacheSnapshot(canvasId: string, snapshotJson: string): void {
  snapshotCache.delete(canvasId);
  snapshotCache.set(canvasId, snapshotJson);
  while (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldestCanvasId = snapshotCache.keys().next().value;
    if (oldestCanvasId === undefined) break;
    snapshotCache.delete(oldestCanvasId);
  }
}

function cachedSnapshot(canvasId: string): string | null {
  const snapshotJson = snapshotCache.get(canvasId);
  if (snapshotJson === undefined) return null;
  cacheSnapshot(canvasId, snapshotJson);
  return snapshotJson;
}

function enqueuePersistence(
  canvasId: string,
  persist: () => Promise<void>,
): Promise<void> {
  const previous = persistenceQueues.get(canvasId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(persist);
  persistenceQueues.set(canvasId, next);
  void next
    .finally(() => {
      if (persistenceQueues.get(canvasId) === next) {
        persistenceQueues.delete(canvasId);
      }
    })
    .catch(() => undefined);
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultJson(value: unknown): string {
  const serialized = JSON.stringify(value ?? null);
  if (serialized.length <= 256_000) return serialized;
  return JSON.stringify({
    truncated: true,
    preview: serialized.slice(0, 255_000),
  });
}

function CanvasSurface({ canvasId, name }: CanvasSurfaceProps) {
  const rpc = useRpc<typeof canvasRpcContract>();
  const settings = useSettings();
  const connectionState = useRealtimeConnectionState();
  const editorRef = useRef<Editor | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const mountGenerationRef = useRef(0);
  const processingRef = useRef(false);
  const initializedRef = useRef(false);
  const [state, setState] = useState<
    "loading" | "ready" | "saving" | "running" | "error"
  >("loading");
  const [detail, setDetail] = useState("Opening canvas…");
  const configuredLicenseKey = settings.values?.tldrawLicenseKey;
  const licenseKey =
    typeof configuredLicenseKey === "string"
      ? configuredLicenseKey.trim() || undefined
      : undefined;

  const snapshotNow = useCallback(
    (editor: Editor) => {
      const snapshotJson = JSON.stringify(getSnapshot(editor.store));
      cacheSnapshot(canvasId, snapshotJson);
      return snapshotJson;
    },
    [canvasId],
  );

  const persistSnapshot = useCallback(
    (snapshotJson: string) =>
      enqueuePersistence(canvasId, async () => {
        await rpc.call("saveCanvas", { canvasId, snapshotJson });
      }),
    [canvasId, rpc],
  );

  const disposeEditor = useCallback(
    (editor: Editor) => {
      if (editorRef.current !== editor) return;
      const shouldPersist = initializedRef.current;
      initializedRef.current = false;
      mountGenerationRef.current += 1;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      unlistenRef.current?.();
      unlistenRef.current = null;
      editorRef.current = null;
      if (shouldPersist) {
        const snapshotJson = snapshotNow(editor);
        void persistSnapshot(snapshotJson).catch(() => undefined);
      }
    },
    [persistSnapshot, snapshotNow],
  );

  const saveNow = useCallback(
    async (editor: Editor) => {
      setState("saving");
      setDetail("Saving locally…");
      const snapshotJson = snapshotNow(editor);
      await persistSnapshot(snapshotJson);
      setState("ready");
      setDetail("Saved");
    },
    [persistSnapshot, snapshotNow],
  );

  const scheduleSave = useCallback(
    (editor: Editor) => {
      if (!initializedRef.current) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void saveNow(editor).catch((error: unknown) => {
          setState("error");
          setDetail(`Save failed: ${errorMessage(error)}`);
        });
      }, 350);
    },
    [saveNow],
  );

  const processCommands = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || processingRef.current || !initializedRef.current) return;
    processingRef.current = true;
    let failed = false;
    try {
      while (true) {
        const response = await rpc.call("claimCommands", { canvasId });
        const commands = response.commands as CanvasCommand[];
        if (commands.length === 0) break;
        for (const command of commands) {
          setState("running");
          setDetail(command.description);
          try {
            const run = new AsyncFunction(
              "editor",
              "tldraw",
              `"use strict";\n${command.code}`,
            );
            const value = await run(editor, tldraw);
            await saveNow(editor);
            await rpc.call("completeCommand", {
              commandId: command.id,
              resultJson: resultJson(value),
              error: null,
            });
          } catch (error) {
            failed = true;
            await rpc.call("completeCommand", {
              commandId: command.id,
              resultJson: null,
              error: errorMessage(error).slice(0, 16_000),
            });
            setState("error");
            setDetail(`Command failed: ${errorMessage(error)}`);
          }
        }
      }
    } finally {
      processingRef.current = false;
      if (!failed) {
        setState("ready");
        setDetail("Saved");
      }
    }
  }, [canvasId, rpc, saveNow]);

  useRealtime("canvas-command", (payload) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      "canvasId" in payload &&
      payload.canvasId === canvasId
    ) {
      void processCommands();
    }
  });

  useEffect(() => {
    if (connectionState === "connected") void processCommands();
  }, [connectionState, processCommands]);

  const onMount = useCallback(
    (editor: Editor) => {
      const mountGeneration = mountGenerationRef.current + 1;
      mountGenerationRef.current = mountGeneration;
      editorRef.current = editor;
      initializedRef.current = false;
      setState("loading");
      setDetail("Loading saved canvas…");
      void (async () => {
        try {
          const canvas = await rpc.call("loadCanvas", { canvasId, name });
          if (
            mountGenerationRef.current !== mountGeneration ||
            editorRef.current !== editor
          ) {
            return;
          }
          const snapshotJson = cachedSnapshot(canvasId) ?? canvas.snapshotJson;
          if (snapshotJson) {
            loadSnapshot(editor.store, JSON.parse(snapshotJson), {
              forceOverwriteSessionState: true,
            });
            cacheSnapshot(canvasId, snapshotJson);
          }
          initializedRef.current = true;
          unlistenRef.current?.();
          const unlistenDocument = editor.store.listen(
            () => scheduleSave(editor),
            { scope: "document" },
          );
          const unlistenSession = editor.store.listen(
            () => scheduleSave(editor),
            { scope: "session" },
          );
          unlistenRef.current = () => {
            unlistenDocument();
            unlistenSession();
          };
          setState("ready");
          setDetail("Saved");
          await processCommands();
        } catch (error) {
          if (mountGenerationRef.current !== mountGeneration) return;
          setState("error");
          setDetail(`Canvas failed: ${errorMessage(error)}`);
        }
      })();
      return () => disposeEditor(editor);
    },
    [canvasId, disposeEditor, name, processCommands, rpc, scheduleSave],
  );

  const statusStyle = {
    "--canvas-agent-status-tone":
      state === "error"
        ? "var(--destructive)"
        : state === "ready"
          ? "var(--success, #2f9e67)"
          : "var(--primary)",
  } as CSSProperties;

  return (
    <div className="canvas-agent-shell">
      <div className="canvas-agent-status" style={statusStyle}>
        <div className="canvas-agent-title-group">
          <span className="canvas-agent-mark" aria-hidden="true" />
          <div className="canvas-agent-titles">
            <strong>{name}</strong>
            <span>{detail}</span>
          </div>
        </div>
        <span className="canvas-agent-trust">local agent bridge</span>
      </div>
      <div className="canvas-agent-stage">
        {settings.isLoading ? (
          <div className="canvas-agent-loading">Loading canvas settings…</div>
        ) : (
          <Tldraw
            key={licenseKey ?? "unlicensed"}
            licenseKey={licenseKey}
            onMount={onMount}
          />
        )}
      </div>
    </div>
  );
}

function CanvasNavPanel({ subPath }: PluginNavPanelProps) {
  const canvasId = subPath ? `document:${subPath}` : "studio";
  return (
    <CanvasSurface
      key={canvasId}
      canvasId={canvasId}
      name={subPath ? `Canvas · ${subPath}` : "Studio canvas"}
    />
  );
}

function CanvasThreadPanel({ threadId }: PluginThreadPanelProps) {
  return (
    <CanvasSurface
      key={threadId}
      canvasId={`thread:${threadId}`}
      name="Thread canvas"
    />
  );
}

function CanvasDirectiveCard({ message }: PluginMessageDirectiveProps) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className="canvas-agent-card"
      onClick={() =>
        navigate.openThreadPanel({
          actionId: "canvas",
          title: "Canvas Agent",
        })
      }
    >
      <span className="canvas-agent-card-icon" aria-hidden="true">
        ◇
      </span>
      <span>
        <strong>Open Canvas Agent</strong>
        <small>Live canvas for {message.threadId.slice(0, 12)}</small>
      </span>
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "canvas",
    title: "Canvas",
    icon: "PaintBoard",
    path: "canvas",
    component: CanvasNavPanel,
  });
  app.slots.threadPanelAction({
    id: "canvas",
    title: "Canvas Agent",
    icon: "PaintBoard",
    component: CanvasThreadPanel,
    layout: "flush",
  });
  app.slots.messageAction({
    id: "open-canvas",
    title: "Open Canvas Agent",
    icon: "PaintBoard",
    run(context) {
      context.openPanel({
        actionId: "canvas",
        title: "Canvas Agent",
      });
    },
  });
  app.slots.messageDirective({
    id: "canvas-agent",
    component: CanvasDirectiveCard,
  });
});
