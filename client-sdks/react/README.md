# @mastra/react

`@mastra/react` provides React context, hooks, message utilities, voice helpers, and UI primitives for applications that connect to a Mastra server. Wrap the application once with `MastraReactProvider`, then access the configured client throughout the component tree.

## Installation

```bash
npm install @mastra/react
```

## Usage

```tsx
import { MastraReactProvider } from '@mastra/react';

export function App({ children }: { children: React.ReactNode }) {
  return <MastraReactProvider baseUrl="http://localhost:4111">{children}</MastraReactProvider>;
}
```

## Documentation

`MastraReactProvider` constructs and shares the Mastra client. In addition to `baseUrl`, it accepts custom headers, an API prefix, fetch credentials, and a custom `fetch` implementation for applications that need authentication or request instrumentation. Use `useMastraClient()` when a component needs direct access to the underlying client.

The package exports agent hooks such as `useChat` for generated or streamed conversations, including optimistic messages, tool calls, approvals, task signals, aborts, and reconnection to active runs. It also exports workflow hooks and `WorkflowStepFactory` for consuming workflow state and streamed step results.

Voice helpers include browser speech recognition, microphone recording, and Web Audio playback. Message utilities expose Mastra's database message types and accumulation helpers, while the `@mastra/react/ui` entry point provides reusable message, code, icon, button, entity, and tooltip components. Import `@mastra/react/styles.css` when using the packaged UI components.

React 19 or newer is required. The package also expects compatible versions of `@mastra/core` and Zod in the consuming application.

## Workflow hooks entry

If your app only needs workflow hooks, import them from the workflow entry to avoid loading the UI components and their syntax-highlighting dependencies:

```tsx
import {
  MastraReactProvider,
  useCreateWorkflowRun,
  useStreamWorkflow,
  useCancelWorkflowRun,
} from '@mastra/react/workflow-hooks';
```

This entry exports the same provider, client hook, workflow hooks, and workflow types as the root package. Existing hook options and behavior are unchanged. A provider from either entry works with hooks from either entry. Continue importing UI components such as `WorkflowStepFactory` from `@mastra/react`.

To check the built package entries and their public types, run `pnpm build:js` followed by `pnpm test:package` from this directory.

## Changelog

See the [package changelog](https://github.com/mastra-ai/mastra/blob/main/client-sdks/react/CHANGELOG.md) for version history and release notes.

## Support

We have an [open community Discord](https://discord.gg/mastra-ai). Come and say hello and let us know if you have any questions or need any help getting things running.
