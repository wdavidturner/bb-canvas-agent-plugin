import type BetterSqlite3 from "better-sqlite3";

export const MAX_TERMINAL_COMMANDS_PER_CANVAS = 200;

export function pruneTerminalCommands(
  db: BetterSqlite3.Database,
  canvasId: string,
  limit = MAX_TERMINAL_COMMANDS_PER_CANVAS,
): void {
  db.prepare(
    `DELETE FROM canvas_commands
      WHERE canvas_id = ?
        AND status IN ('completed', 'failed')
        AND id NOT IN (
          SELECT id
            FROM canvas_commands
           WHERE canvas_id = ?
             AND status IN ('completed', 'failed')
           ORDER BY updated_at DESC
           LIMIT ?
        )`,
  ).run(canvasId, canvasId, limit);
}
