import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow, type ShellOutputInfo } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import { Connection, nodePlatform } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { daemon } from "./daemon.ts";

const context = BACKGROUND_CONTEXT;
const connections: Connection[] = [];
const dirs: string[] = [];
afterAll(() => {
    for (const connection of connections) connection.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

function environment(): { env: RemoteExecutionEnv; connection: Connection } {
    const cwd = mkdtempSync(join(tmpdir(), "pi-env-remote-"));
    dirs.push(cwd);
    const connection = new Connection({ command: [daemon] });
    connections.push(connection);
    return { env: new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd }), connection };
}

describe("Custom RemoteExecutionEnv Test", () => {
    it("transfers only about a window of output a caller keeps, with exact counts", async () => {
        const { env } = environment();
        const total = 5_000_000;
        let delivered = 0;
        let skipped = 0;
        let tail = "";
        const result = await env.exec(
            ["sh", "-c", `yes 0123456789abcdef | head -c ${total}`],
            {
                window: { maxBytes: 1000, maxLines: 20, minIntervalMs: 20, bytesPerSecond: 1_000_000 },
                onOutput: (text: string, _context, info: ShellOutputInfo) => {
                    delivered += Buffer.byteLength(text);
                    if (info.skipped) {
                        skipped += info.skipped.bytes;
                        tail = "";
                    }
                },
            },
            BACKGROUND_CONTEXT
        );

        if (result.ok) {
            // Access exitCode only if the result is successful
            expect(delivered + skipped).toBe(total);
            expect(result.value.exitCode).toBe(0);
        } else {
            // Handle the error case
            throw new Error(`Execution failed: ${result.error.message}`);
        }
    });
});