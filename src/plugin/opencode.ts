/**
 * OpenCode V2's package loader resolves the `./plugin` export. Expose its
 * default definition here as well as the named V1 factory used by wrappers.
 *
 * OpenCode configuration lists the package name in the `plugins` array:
 * `"plugins": ["sortie-dogs"]`. V1 wrappers can still use
 * `import { SortieDogsPlugin } from "sortie-dogs/plugin"`.
 *
 * OpenCode V2 requires a default definition with an id and setup or effect function.
 * Keep other runtime symbols on the package root rather than this shared entry.
 */
export { SortieDogsV010Plugin as SortieDogsPlugin } from "./profiled.js";
export { default } from "./v2.js";
export type {
  OpenCodeEvent,
  OpenCodeHooks,
  OpenCodePlugin,
  OpenCodePluginInput,
  SortieDogsPluginOptions,
} from "./index.js";
