import { describe, expect, it } from 'vitest';
import { Workspace, createWorkspaceTools, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { CloudflareSandbox } from './sandbox';
import { createFakeBridge } from './testing/fake-bridge';

describe('CloudflareSandbox command forms', () => {
  it('executes the full command accepted by the built-in Workspace agent tool', async () => {
    const bridge = createFakeBridge();
    bridge.onExec = () => ({ stdout: 'native-tool-ok', exitCode: 0 });
    const sandbox = new CloudflareSandbox({ baseUrl: 'https://bridge.example.com', fetch: bridge.fetch });
    const workspace = new Workspace({ sandbox });
    await workspace.init();
    try {
      const tools = await createWorkspaceTools(workspace);
      const result = await tools[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND].execute({
        command: "printf '%s' native-tool-ok", timeout: 5,
      });
      expect(bridge.execs).toEqual([{ argv: ['/bin/bash', '-c', "printf '%s' native-tool-ok"], timeout_ms: 5000 }]);
      expect(result).toBe('native-tool-ok');
    } finally {
      await workspace.destroy();
    }
  });

  it.each([undefined, []])('passes a complete command through a non-login shell with args %j', async args => {
    const bridge = createFakeBridge();
    const sandbox = new CloudflareSandbox({ baseUrl: 'https://bridge.example.com', fetch: bridge.fetch });
    await sandbox.start();
    const command = "printf '%s\\n' first | tr a-z A-Z && printf '%s' second";

    await sandbox.executeCommand(command, args, { cwd: '/workspace/project', timeout: 5000 });

    expect(bridge.execs).toEqual([{ argv: ['/bin/bash', '-c', command], cwd: '/workspace/project', timeout_ms: 5000 }]);
  });

  it('preserves explicit arguments as literal argv elements', async () => {
    const bridge = createFakeBridge();
    const sandbox = new CloudflareSandbox({ baseUrl: 'https://bridge.example.com', fetch: bridge.fetch });
    await sandbox.start();
    const args = ['%s', 'one;two', 'a b', '$(printf unexpected)', ''];

    await sandbox.executeCommand('printf', args);

    expect(bridge.execs[0]?.argv).toEqual(['printf', ...args]);
  });

  it('keeps environment overrides ahead of the shell without loading a login profile', async () => {
    const bridge = createFakeBridge();
    const sandbox = new CloudflareSandbox({
      baseUrl: 'https://bridge.example.com', fetch: bridge.fetch,
      env: { PATH: '/workspace/venv/bin', BASE: 'original' },
    });
    await sandbox.start();

    await sandbox.executeCommand('python3 --version', undefined, { env: { BASE: 'replacement value' } });

    expect(bridge.execs[0]?.argv).toEqual([
      'env', 'PATH=/workspace/venv/bin', 'BASE=replacement value',
      '/bin/bash', '-c', 'python3 --version',
    ]);
  });
});
