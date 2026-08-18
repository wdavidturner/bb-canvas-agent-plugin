import { randomUUID } from "node:crypto";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { pruneTerminalCommands } from "./command-retention.js";

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_CODE_BYTES = 64 * 1024;
const COMMAND_WAIT_MS = 15_000;
const COMMAND_CLAIM_TIMEOUT_MS = 30_000;
const COMMAND_CHANNEL = "canvas-command";

const migrations = [
  `CREATE TABLE IF NOT EXISTS canvases (
     id            TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     snapshot_json TEXT,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS canvas_commands (
     id           TEXT PRIMARY KEY,
     canvas_id    TEXT NOT NULL,
     code         TEXT NOT NULL,
     description  TEXT NOT NULL,
     status       TEXT NOT NULL,
     result_json  TEXT,
     error        TEXT,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL,
     FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_commands_claim
     ON canvas_commands(canvas_id, status, created_at)`,
];

const canvasIdSchema = z.string().trim().min(1).max(256);
const snapshotJsonSchema = z.string().max(MAX_SNAPSHOT_BYTES);
const codeSchema = z.string().min(1).max(MAX_CODE_BYTES);
const commandSchema = z
  .object({
    id: z.string(),
    canvasId: z.string(),
    code: z.string(),
    description: z.string(),
    createdAt: z.number().int(),
  })
  .strict();

export const canvasRpcContract = defineRpcContract({
  loadCanvas: {
    input: z
      .object({ canvasId: canvasIdSchema, name: z.string().trim().min(1) })
      .strict(),
    output: z
      .object({ snapshotJson: z.string().nullable(), updatedAt: z.number() })
      .strict(),
  },
  saveCanvas: {
    input: z
      .object({ canvasId: canvasIdSchema, snapshotJson: snapshotJsonSchema })
      .strict(),
    output: z.object({ ok: z.literal(true), updatedAt: z.number() }).strict(),
  },
  claimCommands: {
    input: z.object({ canvasId: canvasIdSchema }).strict(),
    output: z.object({ commands: z.array(commandSchema) }).strict(),
  },
  completeCommand: {
    input: z
      .object({
        commandId: z.string().min(1),
        resultJson: z.string().nullable(),
        error: z.string().nullable(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  canvasStatus: {
    input: z.object({ canvasId: canvasIdSchema }).strict(),
    output: z
      .object({
        canvasId: z.string(),
        name: z.string(),
        hasSnapshot: z.boolean(),
        updatedAt: z.number(),
        queuedCommands: z.number().int(),
        storedCommands: z.number().int(),
      })
      .strict(),
  },
});

interface CanvasRow {
  id: string;
  name: string;
  snapshot_json: string | null;
  updated_at: number;
}

interface CommandRow {
  id: string;
  canvas_id: string;
  code: string;
  description: string;
  status: "queued" | "running" | "completed" | "failed";
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function canvasIdForThread(threadId: string): string {
  return `thread:${threadId}`;
}

function canvasNameForThread(threadId: string): string {
  return `Thread canvas · ${threadId.slice(0, 12)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function toolError(message: string): PluginAgentToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function formatCommandResult(row: CommandRow): PluginAgentToolResult {
  if (row.status === "failed") {
    return toolError(row.error ?? "The canvas command failed.");
  }
  if (row.status !== "completed") {
    return [
      `Canvas command ${row.id} is queued.`,
      "Open the Canvas Agent panel for this thread and the command will run automatically.",
      "Do not enqueue the same command again.",
    ].join("\n");
  }
  if (row.result_json === null) return "Canvas updated.";
  return `Canvas updated. Result:\n${row.result_json}`;
}

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    tldrawLicenseKey: {
      type: "string",
      label: "tldraw license key",
      description:
        "Client-side license key from tldraw. BB sends this value to the browser, as required by tldraw. Leave blank for development.",
      default: "",
    },
    allowBrowserGlobals: {
      type: "boolean",
      label: "Allow browser globals in agent code",
      description:
        "Lets canvas commands access window, document, network APIs, and other shared browser state. Disabled by default. This guardrail is not a security sandbox.",
      default: false,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const ensureCanvas = (canvasId: string, name: string): CanvasRow => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO canvases (id, name, snapshot_json, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(canvasId, name, now, now);
    return db
      .prepare(
        `SELECT id, name, snapshot_json, updated_at
           FROM canvases
          WHERE id = ?`,
      )
      .get(canvasId) as CanvasRow;
  };

  const readCommand = (commandId: string): CommandRow | undefined =>
    db
      .prepare(
        `SELECT id, canvas_id, code, description, status, result_json,
                error, created_at, updated_at
           FROM canvas_commands
          WHERE id = ?`,
      )
      .get(commandId) as CommandRow | undefined;

  const enqueueCommand = (
    canvasId: string,
    name: string,
    code: string,
    description: string,
  ): string => {
    ensureCanvas(canvasId, name);
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO canvas_commands
         (id, canvas_id, code, description, status, result_json, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', NULL, NULL, ?, ?)`,
    ).run(id, canvasId, code, description, now, now);
    bb.realtime.publish(COMMAND_CHANNEL, { canvasId, commandId: id });
    return id;
  };

  const waitForCommand = async (
    commandId: string,
    signal?: AbortSignal,
  ): Promise<CommandRow> => {
    const deadline = Date.now() + COMMAND_WAIT_MS;
    while (Date.now() < deadline && !signal?.aborted) {
      const row = readCommand(commandId);
      if (!row) throw new Error(`Canvas command ${commandId} disappeared`);
      if (row.status === "completed" || row.status === "failed") return row;
      await sleep(80, signal);
    }
    const row = readCommand(commandId);
    if (!row) throw new Error(`Canvas command ${commandId} disappeared`);
    return row;
  };

  const claimCommands = (canvasId: string): CommandRow[] =>
    db.transaction(() => {
      const now = Date.now();
      db.prepare(
        `UPDATE canvas_commands
            SET status = 'queued', updated_at = ?
          WHERE canvas_id = ?
            AND status = 'running'
            AND updated_at < ?`,
      ).run(now, canvasId, now - COMMAND_CLAIM_TIMEOUT_MS);
      const rows = db
        .prepare(
          `SELECT id, canvas_id, code, description, status, result_json,
                  error, created_at, updated_at
             FROM canvas_commands
            WHERE canvas_id = ? AND status = 'queued'
            ORDER BY created_at
            LIMIT 25`,
        )
        .all(canvasId) as CommandRow[];
      const markRunning = db.prepare(
        `UPDATE canvas_commands
            SET status = 'running', updated_at = ?
          WHERE id = ? AND status = 'queued'`,
      );
      return rows.filter((row) => markRunning.run(now, row.id).changes === 1);
    })();

  const handlers = {
    loadCanvas({ canvasId, name }: { canvasId: string; name: string }) {
      const row = ensureCanvas(canvasId, name);
      return { snapshotJson: row.snapshot_json, updatedAt: row.updated_at };
    },
    saveCanvas({
      canvasId,
      snapshotJson,
    }: {
      canvasId: string;
      snapshotJson: string;
    }) {
      const now = Date.now();
      ensureCanvas(canvasId, canvasId);
      db.prepare(
        `UPDATE canvases SET snapshot_json = ?, updated_at = ? WHERE id = ?`,
      ).run(snapshotJson, now, canvasId);
      return { ok: true as const, updatedAt: now };
    },
    claimCommands({ canvasId }: { canvasId: string }) {
      return {
        commands: claimCommands(canvasId).map((row) => ({
          id: row.id,
          canvasId: row.canvas_id,
          code: row.code,
          description: row.description,
          createdAt: row.created_at,
        })),
      };
    },
    completeCommand({
      commandId,
      resultJson,
      error,
    }: {
      commandId: string;
      resultJson: string | null;
      error: string | null;
    }) {
      const command = readCommand(commandId);
      if (!command || command.status !== "running") {
        throw new Error(`Canvas command ${commandId} is not running`);
      }
      const status = error === null ? "completed" : "failed";
      const result = db
        .prepare(
          `UPDATE canvas_commands
            SET status = ?, result_json = ?, error = ?, updated_at = ?
          WHERE id = ? AND status = 'running'`,
        )
        .run(status, resultJson, error, Date.now(), commandId);
      if (result.changes !== 1) {
        throw new Error(`Canvas command ${commandId} is not running`);
      }
      pruneTerminalCommands(db, command.canvas_id);
      return { ok: true as const };
    },
    canvasStatus({ canvasId }: { canvasId: string }) {
      const row = ensureCanvas(canvasId, canvasId);
      const queued = db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM canvas_commands
            WHERE canvas_id = ? AND status IN ('queued', 'running')`,
        )
        .get(canvasId) as { count: number };
      const stored = db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM canvas_commands
            WHERE canvas_id = ?`,
        )
        .get(canvasId) as { count: number };
      return {
        canvasId,
        name: row.name,
        hasSnapshot: row.snapshot_json !== null,
        updatedAt: row.updated_at,
        queuedCommands: queued.count,
        storedCommands: stored.count,
      };
    },
  };

  bb.rpc.register(canvasRpcContract, handlers);

  const inspectCode = `return {
    currentPageId: editor.getCurrentPageId(),
    camera: editor.getCamera(),
    zoom: editor.getZoomLevel(),
    selectedShapeIds: editor.getSelectedShapeIds(),
    shapes: editor.getCurrentPageShapes().map((shape) => ({
      id: shape.id,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      rotation: shape.rotation,
      props: shape.props,
      meta: shape.meta,
    })),
  }`;

  bb.agents.registerTool({
    name: "canvas_agent_inspect",
    description:
      "Inspect the live canvas associated with this BB thread. Returns the current page, camera, zoom, selection, and raw shape records.",
    instructions:
      "Inspect the canvas before changing existing content. If the command queues, ask the user to open the Canvas Agent panel and do not submit a duplicate command.",
    experimental_statusLabels: {
      pending: "Inspecting the canvas",
      completed: "Inspected the canvas",
    },
    parameters: z.object({}).strict(),
    async execute(_input, ctx) {
      const canvasId = canvasIdForThread(ctx.threadId);
      const commandId = enqueueCommand(
        canvasId,
        canvasNameForThread(ctx.threadId),
        inspectCode,
        "Inspect the current page",
      );
      return formatCommandResult(await waitForCommand(commandId, ctx.signal));
    },
  });

  bb.agents.registerTool({
    name: "canvas_agent_exec",
    description:
      "Run trusted JavaScript against the live tldraw Editor associated with this BB thread. The function receives editor and tldraw variables and may return a JSON-serializable result.",
    instructions: [
      "Use editor.createShape/createShapes/updateShape/deleteShapes for mutations.",
      "Use tldraw.createShapeId('stable-name') for stable ids and tldraw.toRichText('label') for text.",
      "Browser globals are unavailable unless the user enables them in plugin settings. Keep commands scoped to editor and tldraw.",
      "Return a compact verification object from the code.",
      "After a successful edit, include ::canvas-agent{} in your reply so the user can open the live canvas.",
    ].join(" "),
    experimental_statusLabels: {
      pending: "Editing the canvas",
      completed: "Edited the canvas",
    },
    parameters: z
      .object({
        description: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("Short description of the intended visible change"),
        code: codeSchema.describe(
          "JavaScript function body. editor and tldraw are available. Top-level await and return are supported.",
        ),
      })
      .strict(),
    async execute({ code, description }, ctx) {
      const canvasId = canvasIdForThread(ctx.threadId);
      const commandId = enqueueCommand(
        canvasId,
        canvasNameForThread(ctx.threadId),
        code,
        description,
      );
      return formatCommandResult(await waitForCommand(commandId, ctx.signal));
    },
  });

  bb.agents.configure(() => ({
    tools: ["canvas_agent_inspect", "canvas_agent_exec"],
    skills: ["canvas-agent"],
    instructions:
      "This BB thread has a live Canvas Agent. Use the canvas tools when the user asks to draw, diagram, arrange, inspect, or change the canvas.",
  }));

  const cliUsage = [
    "Usage:",
    "  bb canvas status [--thread <thread-id> | --canvas <canvas-id>]",
    "  bb canvas inspect [--thread <thread-id> | --canvas <canvas-id>]",
    "  bb canvas exec [--thread <thread-id> | --canvas <canvas-id>] <javascript>",
    "  bb canvas clear [--thread <thread-id> | --canvas <canvas-id>]",
  ].join("\n");

  const parseCli = (argv: string[], contextThreadId?: string) => {
    const values = [...argv];
    let threadId = contextThreadId;
    const threadIndex = values.indexOf("--thread");
    if (threadIndex >= 0) {
      threadId = values[threadIndex + 1];
      values.splice(threadIndex, 2);
    }
    let explicitCanvasId: string | undefined;
    const canvasIndex = values.indexOf("--canvas");
    if (canvasIndex >= 0) {
      explicitCanvasId = values[canvasIndex + 1];
      values.splice(canvasIndex, 2);
    }
    if (threadId && explicitCanvasId) {
      throw new Error("Pass either --thread or --canvas, not both.");
    }
    if (!threadId && !explicitCanvasId) {
      throw new Error("Missing target. Pass --thread <id> or --canvas <id>.");
    }
    return {
      command: values.shift() ?? "help",
      rest: values,
      threadId,
      canvasId: explicitCanvasId ?? canvasIdForThread(threadId!),
      canvasName: explicitCanvasId
        ? `Canvas · ${explicitCanvasId}`
        : canvasNameForThread(threadId!),
    };
  };

  bb.cli.register({
    name: "canvas",
    summary: "Inspect and edit the live Canvas Agent",
    commands: [
      {
        name: "status",
        summary: "Show canvas persistence and queue status",
        usage: "bb canvas status [--thread <thread-id>]",
      },
      {
        name: "inspect",
        summary: "Read the current page's tldraw shape records",
        usage: "bb canvas inspect [--thread <thread-id>]",
      },
      {
        name: "exec",
        summary: "Run JavaScript against the live tldraw Editor",
        usage: "bb canvas exec [--thread <thread-id>] <javascript>",
      },
      {
        name: "clear",
        summary: "Delete every shape on the current page",
        usage: "bb canvas clear [--thread <thread-id>]",
      },
    ],
    async run(argv, ctx) {
      try {
        const parsed = parseCli(argv, ctx.threadId);
        if (parsed.command === "help" || parsed.command === "--help") {
          return { exitCode: 0, stdout: cliUsage };
        }
        if (parsed.command === "status") {
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              handlers.canvasStatus({ canvasId: parsed.canvasId }),
              null,
              2,
            ),
          };
        }
        let code: string;
        let description: string;
        if (parsed.command === "inspect") {
          code = inspectCode;
          description = "Inspect the current page";
        } else if (parsed.command === "clear") {
          code =
            "editor.deleteShapes([...editor.getCurrentPageShapeIds()]); return { cleared: true }";
          description = "Clear the current page";
        } else if (parsed.command === "exec") {
          code = parsed.rest.join(" ").trim();
          if (!code) return { exitCode: 2, stderr: cliUsage };
          if (code.length > MAX_CODE_BYTES) {
            return { exitCode: 2, stderr: "Canvas code exceeds 64 KiB." };
          }
          description = "Run a canvas command";
        } else {
          return {
            exitCode: 2,
            stderr: `Unknown canvas command: ${parsed.command}\n${cliUsage}`,
          };
        }
        const commandId = enqueueCommand(
          parsed.canvasId,
          parsed.canvasName,
          code,
          description,
        );
        const result = formatCommandResult(
          await waitForCommand(commandId, ctx.signal),
        );
        if (typeof result === "string") {
          return { exitCode: 0, stdout: result };
        }
        return {
          exitCode: result.isError ? 1 : 0,
          stdout: result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const readHttpJson = async <Schema extends z.ZodType>(
    context: Parameters<Parameters<BbPluginApi["http"]["route"]>[2]>[0],
    schema: Schema,
  ): Promise<z.output<Schema>> => {
    const value: unknown = await context.req.json();
    return schema.parse(value);
  };

  const httpExecSchema = z
    .object({
      threadId: z.string().min(1).optional(),
      canvasId: canvasIdSchema.optional(),
      code: codeSchema,
      description: z.string().trim().min(1).max(200).default("HTTP command"),
    })
    .strict()
    .refine((input) => Boolean(input.threadId) !== Boolean(input.canvasId), {
      message: "Pass exactly one of threadId or canvasId",
    });

  bb.http.route(
    "POST",
    "/exec",
    async (context) => {
      const input = await readHttpJson(context, httpExecSchema);
      const canvasId = input.canvasId ?? canvasIdForThread(input.threadId!);
      const canvasName = input.canvasId
        ? `Canvas · ${input.canvasId}`
        : canvasNameForThread(input.threadId!);
      const commandId = enqueueCommand(
        canvasId,
        canvasName,
        input.code,
        input.description,
      );
      const row = await waitForCommand(commandId);
      return context.json({
        commandId,
        status: row.status,
        resultJson: row.result_json,
        error: row.error,
      });
    },
    { auth: "token" },
  );

  bb.http.route(
    "POST",
    "/snapshot",
    async (context) => {
      const input = await readHttpJson(
        context,
        z.object({ threadId: z.string().min(1) }).strict(),
      );
      const row = ensureCanvas(
        canvasIdForThread(input.threadId),
        canvasNameForThread(input.threadId),
      );
      return context.json({
        canvasId: row.id,
        snapshotJson: row.snapshot_json,
        updatedAt: row.updated_at,
      });
    },
    { auth: "token" },
  );

  bb.log.info("Canvas Agent loaded");
}
