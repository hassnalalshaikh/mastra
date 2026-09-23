import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { transformWithEsbuild } from 'vite';
const root = process.cwd();
const sources: Record<string, string> = {
  'official-base-session': 'packages/core/src/agent-controller/session.ts',
  'official-base-route': 'packages/server/src/server/handlers/agent-controller.ts',
};
export default defineConfig({
  define: { __MASTRA_VERSION__: JSON.stringify('1.69.0-alpha.2') },
  resolve: { alias: [{ find: '@mastra/core/utils/zod-to-json', replacement: path.join(root, 'packages/core/src/zod-to-json.ts') }, { find: '@mastra/core', replacement: path.join(root, 'packages/core/src') }] },
  plugins: [{
    name: 'exact-official-base-reproduction',
    resolveId(id) { if (sources[id]) return '\0' + id; },
    load(id) {
      const file = sources[id.slice(1)];
      if (!id.startsWith('\0') || !file) return;
      return execFileSync('git', ['show', '2a832580e3cf3efcdb4be3355eaa9a02929b3a2c:' + file], {encoding:'utf8'})
        .replace(/from ['"](\.[^'"]+)['"]/g, (_, specifier) => 'from ' + JSON.stringify(path.resolve(root, path.dirname(file), specifier).replaceAll('\\','/')));
    },
    transform(source, id) {
      if (!id.startsWith('\0official-base-')) return;
      return transformWithEsbuild(source, 'official-base-source.ts', { loader: 'ts', target: 'es2022' });
    },
  }],
  test: { include: ['receipt-proof/reproduction.test.ts'], environment: 'node', maxWorkers: 1 },
});


