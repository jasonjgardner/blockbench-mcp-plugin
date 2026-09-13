/// <reference types="three" />
/// <reference types="blockbench-types" />
import { registerCreateAnimationTool } from "@/server/tools/animation/create";
import { registerManageKeyframesTool } from "@/server/tools/animation/keyframes";
import { registerAnimationGraphEditorTool } from "@/server/tools/animation/curves";
import { registerBoneRiggingTool } from "@/server/tools/animation/rigging";
import { registerAnimationTimelineTool } from "@/server/tools/animation/timeline";
import { registerBatchKeyframeOperationsTool } from "@/server/tools/animation/batch";
import { registerAnimationCopyPasteTool } from "@/server/tools/animation/copy-paste";

export {
  createAnimationParameters,
  manageKeyframesParameters,
  animationGraphEditorParameters,
  boneRiggingParameters,
  animationTimelineParameters,
  batchKeyframeOperationsParameters,
  animationCopyPasteParameters,
} from "@/server/tools/animation/schemas";
export { animationToolDocs } from "@/server/tools/animation/docs";

/**
 * Registers animation editing and playback tools after Blockbench is initialized.
 * Tools register in `animationToolDocs` order so the MCP tool list is stable.
 */
export function registerAnimationTools(): void {
  registerCreateAnimationTool();
  registerManageKeyframesTool();
  registerAnimationGraphEditorTool();
  registerBoneRiggingTool();
  registerAnimationTimelineTool();
  registerBatchKeyframeOperationsTool();
  registerAnimationCopyPasteTool();
}
