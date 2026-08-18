import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPendingCommandCapacity,
  pruneTerminalCommands,
} from "./command-retention.js";

describe("terminal command retention", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE canvas_commands (
      id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  });

  afterEach(() => db.close());

  it("keeps the newest terminal commands for only the target canvas", () => {
    const insert = db.prepare(
      "INSERT INTO canvas_commands (id, canvas_id, status, updated_at) VALUES (?, ?, ?, ?)",
    );
    const insertMany = db.transaction(() => {
      for (let index = 0; index < 205; index += 1) {
        insert.run(`a-${index}`, "canvas-a", "completed", index);
      }
      insert.run("a-queued", "canvas-a", "queued", 999);
      insert.run("b-completed", "canvas-b", "completed", 1);
    });
    insertMany();

    pruneTerminalCommands(db, "canvas-a", 200);

    const canvasA = db
      .prepare(
        "SELECT id, status FROM canvas_commands WHERE canvas_id = ? ORDER BY updated_at",
      )
      .all("canvas-a") as Array<{ id: string; status: string }>;
    expect(canvasA).toHaveLength(201);
    expect(canvasA.slice(0, 2)).toEqual([
      { id: "a-5", status: "completed" },
      { id: "a-6", status: "completed" },
    ]);
    expect(canvasA.at(-1)).toEqual({ id: "a-queued", status: "queued" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM canvas_commands WHERE canvas_id = ?",
        )
        .get("canvas-b"),
    ).toEqual({ count: 1 });
  });

  it("rejects additional work when the pending queue reaches its limit", () => {
    const insert = db.prepare(
      "INSERT INTO canvas_commands (id, canvas_id, status, updated_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("queued", "canvas-a", "queued", 1);
    insert.run("running", "canvas-a", "running", 2);
    insert.run("completed", "canvas-a", "completed", 3);

    expect(() => assertPendingCommandCapacity(db, "canvas-a", 2)).toThrow(
      "Canvas canvas-a already has 2 pending commands",
    );
    expect(() => assertPendingCommandCapacity(db, "canvas-b", 2)).not.toThrow();
  });
});
