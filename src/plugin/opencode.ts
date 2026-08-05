/**
 * Dedicated import entry point for OpenCode plugin wrappers.
 *
 * OpenCode configuration lists the package name in the `plugin` array:
 * `"plugin": ["sortie-dogs"]`. Files such as `.opencode/plugins/*.ts` use
 * `import { SortieDogsPlugin } from "sortie-dogs/plugin"`.
 *
 * OpenCode treats every runtime export of a loaded plugin module as a plugin factory and calls
 * each one with the plugin input. A non-factory runtime export therefore fails the whole module
 * load and silently disables the plugin. This entry exposes the factory and nothing else; every
 * other runtime symbol stays on the package root.
 */
export { SortieDogsPlugin } from "./index.js";
export type {
  OpenCodeEvent,
  OpenCodeHooks,
  OpenCodePlugin,
  OpenCodePluginInput,
  SortieDogsPluginOptions,
} from "./index.js";
