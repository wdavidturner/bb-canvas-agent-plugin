import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

interface ClaimedCommand {
  id: string;
  canvasId: string;
  code: string;
  description: string;
  createdAt: number;
}

function readCommands(value: unknown): ClaimedCommand[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("commands" in value) ||
    !Array.isArray(value.commands)
  ) {
    throw new Error("invalid command response");
  }
  return value.commands as ClaimedCommand[];
}

describe("Canvas Agent command bridge", () => {
  it("declares canvas runtime settings", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-canvas-agent-plugin",
      agentSkillIds: ["canvas-agent"],
    });
    await plugin(bb);

    expect(
      harness.registrations.settingsDescriptors.allowBrowserGlobals,
    ).toEqual({
      type: "boolean",
      label: "Allow browser globals in agent code",
      description:
        "Lets canvas commands access window, document, network APIs, and other shared browser state. Disabled by default. This guardrail is not a security sandbox.",
      default: false,
    });

    await expect(
      harness.setSettings({
        tldrawLicenseKey: "test-license",
        allowBrowserGlobals: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("holds an agent tool call until the live canvas completes its command", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-canvas-agent-plugin",
      agentSkillIds: ["canvas-agent"],
    });
    await plugin(bb);

    const toolResult = harness.callAgentTool(
      "canvas_agent_exec",
      {
        description: "Create a concept card",
        code: "return { created: 'shape:concept-card' }",
      },
      { threadId: "thread-42" },
    );

    let commands: ClaimedCommand[] = [];
    for (let attempt = 0; attempt < 20 && commands.length === 0; attempt += 1) {
      commands = readCommands(
        await harness.callRpc("claimCommands", {
          canvasId: "thread:thread-42",
        }),
      );
      if (commands.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      canvasId: "thread:thread-42",
      description: "Create a concept card",
    });

    await harness.callRpc("completeCommand", {
      commandId: commands[0]!.id,
      resultJson: JSON.stringify({ created: "shape:concept-card" }),
      error: null,
    });

    await expect(toolResult).resolves.toContain("shape:concept-card");

    await expect(
      harness.callRpc("canvasStatus", { canvasId: "thread:thread-42" }),
    ).resolves.toMatchObject({ storedCommands: 1, queuedCommands: 0 });
  });

  it("inspects viewport and selection state with the shapes", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-canvas-agent-plugin",
      agentSkillIds: ["canvas-agent"],
    });
    await plugin(bb);

    const toolResult = harness.callAgentTool(
      "canvas_agent_inspect",
      {},
      { threadId: "thread-inspect" },
    );
    let commands: ClaimedCommand[] = [];
    for (let attempt = 0; attempt < 20 && commands.length === 0; attempt += 1) {
      commands = readCommands(
        await harness.callRpc("claimCommands", {
          canvasId: "thread:thread-inspect",
        }),
      );
      if (commands.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    expect(commands).toHaveLength(1);
    expect(commands[0]!.code).toContain("editor.getCamera()");
    expect(commands[0]!.code).toContain("editor.getSelectedShapeIds()");
    await harness.callRpc("completeCommand", {
      commandId: commands[0]!.id,
      resultJson: JSON.stringify({ shapes: [] }),
      error: null,
    });
    await expect(toolResult).resolves.toContain('"shapes":[]');
  });

  it("persists the renderer snapshot and reports it through canvas status", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-canvas-agent-plugin",
      agentSkillIds: ["canvas-agent"],
    });
    await plugin(bb);

    await harness.callRpc("loadCanvas", {
      canvasId: "thread:thread-9",
      name: "Thread canvas",
    });
    await harness.callRpc("saveCanvas", {
      canvasId: "thread:thread-9",
      snapshotJson: JSON.stringify({ document: { store: {} } }),
    });

    await expect(
      harness.callRpc("canvasStatus", { canvasId: "thread:thread-9" }),
    ).resolves.toMatchObject({
      canvasId: "thread:thread-9",
      name: "Thread canvas",
      hasSnapshot: true,
      queuedCommands: 0,
      storedCommands: 0,
    });
  });
});
