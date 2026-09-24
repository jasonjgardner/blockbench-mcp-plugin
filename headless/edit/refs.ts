/**
 * Reference helpers shared by the edit operation modules.
 *
 * They live apart from `operations.ts` so operation modules that
 * `operations.ts` imports (such as the particle operations) can use them
 * without an import cycle.
 *
 * @module
 */

import type { IAnimation, IBBModel } from "../document/schema";

/**
 * Returns `requested` when no group, element, texture or animation uses it yet,
 * or a new random UUID when none was requested.
 *
 * @throws Error when `requested` is already taken; Blockbench misloads duplicate UUIDs.
 */
export function freshUuid(doc: IBBModel, requested: string | undefined): string {
  if (requested === undefined) return crypto.randomUUID();
  const taken = [doc.groups, doc.elements, doc.textures, doc.animations ?? [], doc.texture_groups ?? []].some((list) => list.some((entry) => entry.uuid === requested));
  if (taken) throw new Error(`UUID ${requested} is already used in this model.`);
  return requested;
}

/**
 * Finds an animation by UUID or exact name.
 *
 * @throws Error when nothing matches or a name matches several animations.
 */
export function findAnimation(doc: IBBModel, ref: string): IAnimation {
  const matches = (doc.animations ?? []).filter((animation) => animation.uuid === ref || animation.name === ref);
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} animations; pass a UUID.`);
  throw new Error(`No animation named or identified "${ref}".`);
}
