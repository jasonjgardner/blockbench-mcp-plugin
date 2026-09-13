/**
 * Structured availability rules understood by Blockbench's native `Condition`.
 * All populated fields are combined with AND; entries within modes, formats,
 * and tools are alternatives. Feature names refer to flags on the active
 * `ModelFormat`; selection keys include registered outliner element types.
 * Runtime-dependent checks belong in `method`, never in schema construction.
 *
 * This strict shape replaces the published `ConditionResolvable`, whose
 * catch-all member discards TypeScript checking of condition declarations.
 */
export interface IToolCondition {
  /** Optional nested native condition, matching BarItem-like condition wrappers. */
  condition?: ToolCondition;
  /** Active mode IDs accepted by the operation, such as `edit` or `paint`. */
  modes?: string[];
  /** Active format IDs accepted by the operation, such as `bedrock_block`. */
  formats?: string[];
  /** Native toolbar tool IDs that must currently be selected. */
  tools?: string[];
  /** Every listed format capability must be enabled on the active format. */
  features?: string[];
  /** Selection presence/absence checks, including plugin-defined element types. */
  selected?: Record<string, boolean>;
  /** Require a selected project before the operation can execute. */
  project?: boolean;
  /** Additional runtime check evaluated by native Condition after structured rules. */
  method?: (context?: unknown) => boolean;
}

/**
 * Type-safe subset of Blockbench conditions used by MCP tool definitions.
 * `undefined` leaves a tool available; functions run only while checking live
 * availability. Blockbench itself evaluates the rules so its mode, format,
 * feature, and selection semantics remain the source of truth.
 */
export type ToolCondition = undefined | boolean | IToolCondition | ((context?: unknown) => boolean);
