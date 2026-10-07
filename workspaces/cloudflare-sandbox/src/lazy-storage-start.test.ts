import { RequestContext } from "@mastra/core/request-context";
import {
  Workspace,
  createWorkspaceTools,
  type WorkspaceFilesystem,
} from "@mastra/core/workspace";
import { describe, expect, it } from "vitest";
import { CloudflareSandbox } from "./sandbox";
import { createFakeBridge } from "./testing/fake-bridge";

const filesystem = {
  id: "files",
  name: "files",
  provider: "s3",
  getMountConfig: () => ({
    type: "s3",
    bucket: "WORKSPACE_FILES",
    region: "auto",
    prefix: "chat-one/",
  }),
} as WorkspaceFilesystem;
const operations = {
  command: (sandbox: CloudflareSandbox) => sandbox.executeCommand("echo ready"),
  write: (sandbox: CloudflareSandbox) =>
    sandbox.writeFiles([{ path: "note.txt", content: "keep" }]),
  read: (sandbox: CloudflareSandbox) => sandbox.readFile("note.txt"),
  archive: (sandbox: CloudflareSandbox) => sandbox.persistWorkspace(),
  restore: (sandbox: CloudflareSandbox) =>
    sandbox.hydrateWorkspace(new Uint8Array([1])),
};

describe("first use with permanent storage", () => {
  it.each(Object.entries(operations))(
    "starts pending storage before %s without an explicit start",
    async (_, operate) => {
      const bridge = createFakeBridge();
      bridge.files.set("/workspace/note.txt", "keep");
      const sandbox = new CloudflareSandbox({
        baseUrl: "https://bridge.example.com",
        fetch: bridge.fetch,
      });
      sandbox.mounts.add({ "/workspace": filesystem });
      await operate(sandbox);
      expect(sandbox.status).toBe("running");
      expect(sandbox.mounts.get("/workspace")?.state).toBe("mounted");
      expect(bridge.mounts).toHaveLength(1);
      const requests = bridge.requests.map((request) => request.url);
      expect(requests.findIndex((url) => url.endsWith("/mount"))).toBeLessThan(
        requests.findIndex((url) => url.endsWith("/exec"))
      );
    }
  );

  it("starts a resolver-backed sandbox through the registered native Workspace command tool", async () => {
    const bridge = createFakeBridge();
    const sandbox = new CloudflareSandbox({
      sandboxId: "chat-one",
      baseUrl: "https://bridge.example.com",
      fetch: bridge.fetch,
    });
    sandbox.mounts.add({ "/workspace": filesystem });
    const workspace = new Workspace({
      sandbox: async () => sandbox,
      sandboxCacheKey: () => "chat-one",
    });
    const tools = await createWorkspaceTools(workspace);
    const result = await tools.mastra_workspace_execute_command.execute(
      { command: "echo ready" },
      { requestContext: new RequestContext() }
    );
    expect(result).not.toContain("Error:");
    expect(bridge.execs.at(-1)?.argv).toEqual([
      "/bin/bash",
      "-c",
      "echo ready",
    ]);
    expect(sandbox.mounts.get("/workspace")?.state).toBe("mounted");
    expect(bridge.mounts).toHaveLength(1);
  });

  it("shares native first startup while concurrent calls cannot bypass the pending mount", async () => {
    const bridge = createFakeBridge();
    let entered!: () => void;
    const mounting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sandbox = new CloudflareSandbox({
      baseUrl: "https://bridge.example.com",
      fetch: async (input, init) => {
        if (String(input).endsWith("/mount")) {
          entered();
          await gate;
        }
        return bridge.fetch(input, init);
      },
    });
    sandbox.mounts.add({ "/workspace": filesystem });
    const first = sandbox.writeFiles([{ path: "note.txt", content: "keep" }]);
    await mounting;
    await expect(sandbox.executeCommand("echo unsafe")).rejects.toThrow(
      "not ready"
    );
    expect(bridge.execs).toHaveLength(0);
    expect(bridge.files.size).toBe(0);
    release();
    await first;
    expect(bridge.files.get("/workspace/note.txt")).toBe("keep");
    expect(bridge.mounts).toHaveLength(1);
  });

  it.each(Object.entries(operations))(
    "rejects %s after initial mount denial and recovers through the native mount path",
    async (_, operate) => {
      const bridge = createFakeBridge();
      bridge.files.set("/workspace/note.txt", "keep");
      let denied = true;
      const sandbox = new CloudflareSandbox({
        baseUrl: "https://bridge.example.com",
        fetch: async (input, init) =>
          denied && String(input).endsWith("/mount")
            ? Response.json({ error: "AccessDenied" }, { status: 403 })
            : bridge.fetch(input, init),
      });
      sandbox.mounts.add({ "/workspace": filesystem });
      await expect(operate(sandbox)).rejects.toThrow("AccessDenied");
      expect(
        bridge.execs.every((exec) => exec.argv.join(" ").includes("mountpoint"))
      ).toBe(true);
      expect(bridge.files.get("/workspace/note.txt")).toBe("keep");
      expect(bridge.persists).toHaveLength(0);
      expect(bridge.hydrations).toHaveLength(0);
      denied = false;
      await operate(sandbox);
      expect(sandbox.mounts.get("/workspace")?.state).toBe("mounted");
    }
  );
});
