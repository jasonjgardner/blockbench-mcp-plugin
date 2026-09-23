/**
 * Shared result types for headless validation gates.
 *
 * @module
 */

/** How serious a gate finding is. `error` means the model is broken; `warning` means it is suspicious. */
export type GateSeverity = "error" | "warning";

/** One finding. */
export interface IGateViolation {
  message: string;
  /** Names of the nodes involved. */
  targets: string[];
}

/** Outcome of one gate. */
export interface IGateResult {
  /** Stable gate ID, such as `floating`. */
  id: string;
  label: string;
  severity: GateSeverity;
  /** False when the gate could not run on this model, with the reason in `skipped_reason`. */
  ran: boolean;
  skipped_reason?: string;
  violations: IGateViolation[];
}

/** Builds a result for a gate that ran. */
export function gateResult(id: string, label: string, severity: GateSeverity, violations: IGateViolation[]): IGateResult {
  return { id, label, severity, ran: true, violations };
}

/** Builds a result for a gate that could not run. */
export function skippedGate(id: string, label: string, severity: GateSeverity, reason: string): IGateResult {
  return { id, label, severity, ran: false, skipped_reason: reason, violations: [] };
}

/** Counts findings by severity. */
export function summarizeGates(results: readonly IGateResult[]): { errors: number; warnings: number; passed: boolean } {
  const count = (severity: GateSeverity): number =>
    results.filter((result) => result.severity === severity).reduce((total, result) => total + result.violations.length, 0);
  const errors = count("error");
  return { errors, warnings: count("warning"), passed: errors === 0 };
}
