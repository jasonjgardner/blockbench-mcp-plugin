/// <reference types="three" />
/// <reference types="blockbench-types" />

import { createResource } from "@/lib/factories";

// ============================================================================
// Types for Validator (not fully typed in blockbench-types)
// ============================================================================

interface ValidatorButton {
  name: string;
  icon: string;
  color?: string;
  click: (event?: Event) => void;
}

interface ValidatorProblem {
  message: string;
  buttons?: ValidatorButton[];
  error?: boolean;
}

interface ValidatorCheckInstance {
  id: string;
  type?: string;
  update_triggers: string[];
  condition?: unknown;
  errors: ValidatorProblem[];
  warnings: ValidatorProblem[];
  plugin?: string;
}

interface ValidatorSingleton {
  checks: ValidatorCheckInstance[];
  warnings: ValidatorProblem[];
  errors: ValidatorProblem[];
  triggers: string[];
  validate: (trigger?: string) => void;
}

// Access the global Validator
declare const Validator: ValidatorSingleton;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract element references from a problem's buttons
 * Looks for common patterns like "Select Cube", "Select Texture", etc.
 */
function extractElementRefs(problem: ValidatorProblem): {
  type?: string;
  name?: string;
  uuid?: string;
}[] {
  const refs: { type?: string; name?: string; uuid?: string }[] = [];

  if (!problem.buttons) return refs;

  // Try to find referenced elements by parsing the message
  // Common patterns in validator messages:
  // - 'The cube "name"' or 'cube "${cube.name}"'
  // - 'Texture "name"'
  // - 'on "${animator.name}"'

  const cubeMatch = problem.message.match(/cube\s+"([^"]+)"/i);
  if (cubeMatch) {
    const cubeName = cubeMatch[1];
    const cube = Cube.all.find((c) => c.name === cubeName);
    if (cube) {
      refs.push({ type: "cube", name: cube.name, uuid: cube.uuid });
    }
  }

  const textureMatch = problem.message.match(/texture\s+"([^"]+)"/i);
  if (textureMatch) {
    const textureName = textureMatch[1];
    const texture = Texture.all.find(
      (t) => t.name === textureName || t.folder + "/" + t.name === textureName
    );
    if (texture) {
      refs.push({ type: "texture", name: texture.name, uuid: texture.uuid });
    }
  }

  const animationMatch = problem.message.match(/in\s+"([^"]+)"/i);
  if (animationMatch) {
    const animName = animationMatch[1];
    // @ts-ignore - Animation.all exists at runtime
    const animation = Animation.all?.find((a: { name: string; uuid: string }) => a.name === animName);
    if (animation) {
      refs.push({ type: "animation", name: animation.name, uuid: animation.uuid });
    }
  }

  const boneMatch = problem.message.match(/on\s+"([^"]+)"/i);
  if (boneMatch && !animationMatch) {
    const boneName = boneMatch[1];
    const group = Group.all.find((g) => g.name === boneName);
    if (group) {
      refs.push({ type: "group", name: group.name, uuid: group.uuid });
    }
  }

  return refs;
}

/**
 * Serialize a validator problem with element references
 */
function serializeProblem(problem: ValidatorProblem, isError: boolean) {
  const elementRefs = extractElementRefs(problem);

  return {
    message: problem.message,
    severity: isError ? "error" : "warning",
    hasActions: (problem.buttons?.length ?? 0) > 0,
    actionNames: problem.buttons?.map((b) => b.name) ?? [],
    elementRefs,
  };
}

/**
 * Serialize a validator check definition
 */
function serializeCheck(check: ValidatorCheckInstance) {
  return {
    id: check.id,
    type: check.type ?? null,
    updateTriggers: check.update_triggers,
    plugin: check.plugin ?? null,
    currentErrors: check.errors.length,
    currentWarnings: check.warnings.length,
  };
}

// ============================================================================
// Resource Registration
// ============================================================================

export function registerValidatorResources() {
  // ---------------------------------------------------------------------------
  // Validator Status (Combined Summary)
  // ---------------------------------------------------------------------------
  createResource("validator-status", {
    uriTemplate: "validator://status",
    title: "Validator Status",
    description:
      "Returns the current validation status including error/warning counts and a summary of all problems.",
    async listCallback() {
      const totalProblems = Validator.errors.length + Validator.warnings.length;
      return {
        resources: [
          {
            uri: "validator://status",
            name: "Validation Status",
            description: totalProblems === 0
              ? "No validation problems"
              : `${Validator.errors.length} errors, ${Validator.warnings.length} warnings`,
            mimeType: "application/json",
          },
        ],
      };
    },
    async readCallback(uri) {
      const errors = Validator.errors.map((e) => serializeProblem(e, true));
      const warnings = Validator.warnings.map((w) => serializeProblem(w, false));

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(
              {
                summary: {
                  totalProblems: errors.length + warnings.length,
                  errorCount: errors.length,
                  warningCount: warnings.length,
                  checkCount: Validator.checks.length,
                  triggers: Validator.triggers,
                },
                errors,
                warnings,
              },
              null,
              2
            ),
            mimeType: "application/json",
          },
        ],
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Validator Checks (Check Definitions)
  // ---------------------------------------------------------------------------
  createResource("validator-checks", {
    uriTemplate: "validator://checks/{id}",
    title: "Validator Checks",
    description:
      "Returns information about registered validator checks. Use without an ID to list all checks, or provide a check ID to get details about a specific check.",
    async listCallback() {
      if (Validator.checks.length === 0) {
        return { resources: [] };
      }

      return {
        resources: Validator.checks.map((check) => ({
          uri: `validator://checks/${check.id}`,
          name: check.id,
          description: `Triggers: ${check.update_triggers.join(", ") || "manual"}`,
          mimeType: "application/json",
        })),
      };
    },
    async readCallback(uri, { id }) {
      // If no ID, return all checks
      if (!id) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(
                {
                  checks: Validator.checks.map(serializeCheck),
                  count: Validator.checks.length,
                  allTriggers: Validator.triggers,
                },
                null,
                2
              ),
              mimeType: "application/json",
            },
          ],
        };
      }

      // Find specific check
      const check = Validator.checks.find((c) => c.id === id);
      if (!check) {
        throw new Error(`Validator check with ID "${id}" not found.`);
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(
              {
                ...serializeCheck(check),
                errors: check.errors.map((e) => serializeProblem(e, true)),
                warnings: check.warnings.map((w) => serializeProblem(w, false)),
              },
              null,
              2
            ),
            mimeType: "application/json",
          },
        ],
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Validator Warnings
  // ---------------------------------------------------------------------------
  createResource("validator-warnings", {
    uriTemplate: "validator://warnings",
    title: "Validator Warnings",
    description:
      "Returns all current validation warnings with element references where available.",
    async listCallback() {
      return {
        resources: [
          {
            uri: "validator://warnings",
            name: "Validation Warnings",
            description:
              Validator.warnings.length === 0
                ? "No warnings"
                : `${Validator.warnings.length} warning(s)`,
            mimeType: "application/json",
          },
        ],
      };
    },
    async readCallback(uri) {
      const warnings = Validator.warnings.map((w) => serializeProblem(w, false));

      // Group warnings by affected element type
      const byElement: Record<string, typeof warnings> = {};
      const unlinked: typeof warnings = [];

      for (const warning of warnings) {
        if (warning.elementRefs.length > 0) {
          const type = warning.elementRefs[0].type ?? "unknown";
          if (!byElement[type]) byElement[type] = [];
          byElement[type].push(warning);
        } else {
          unlinked.push(warning);
        }
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(
              {
                count: warnings.length,
                warnings,
                byElementType: byElement,
                unlinkedWarnings: unlinked,
              },
              null,
              2
            ),
            mimeType: "application/json",
          },
        ],
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Validator Errors
  // ---------------------------------------------------------------------------
  createResource("validator-errors", {
    uriTemplate: "validator://errors",
    title: "Validator Errors",
    description:
      "Returns all current validation errors with element references where available.",
    async listCallback() {
      return {
        resources: [
          {
            uri: "validator://errors",
            name: "Validation Errors",
            description:
              Validator.errors.length === 0
                ? "No errors"
                : `${Validator.errors.length} error(s)`,
            mimeType: "application/json",
          },
        ],
      };
    },
    async readCallback(uri) {
      const errors = Validator.errors.map((e) => serializeProblem(e, true));

      // Group errors by affected element type
      const byElement: Record<string, typeof errors> = {};
      const unlinked: typeof errors = [];

      for (const error of errors) {
        if (error.elementRefs.length > 0) {
          const type = error.elementRefs[0].type ?? "unknown";
          if (!byElement[type]) byElement[type] = [];
          byElement[type].push(error);
        } else {
          unlinked.push(error);
        }
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(
              {
                count: errors.length,
                errors,
                byElementType: byElement,
                unlinkedErrors: unlinked,
              },
              null,
              2
            ),
            mimeType: "application/json",
          },
        ],
      };
    },
  });
}
