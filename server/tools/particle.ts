/// <reference types="three" />
/// <reference types="blockbench-types" />
import { registerParticleEffectTools } from "@/server/tools/particle/effects";
import { registerParticleKeyframeTools } from "@/server/tools/particle/keyframes";
import { registerParticlePackTools } from "@/server/tools/particle/pack";

export {
  addLocatorParameters,
  createParticleEffectParameters,
  exportParticlePackParameters,
  listParticleEffectsParameters,
  listParticlePresetsParameters,
  manageParticleKeyframesParameters,
  updateParticleEffectParameters,
} from "@/server/tools/particle/schemas";
export { particleToolDocs } from "@/server/tools/particle/docs";

/**
 * Registers particle effect authoring, keyframing, locator and delivery tools
 * after Blockbench is initialized, in `particleToolDocs` order.
 */
export function registerParticleTools(): void {
  registerParticleEffectTools();
  registerParticleKeyframeTools();
  registerParticlePackTools();
}
