/** How a clip behaves after its last keyframe, mirroring Blockbench's loop modes. */
export type LoopMode = "loop" | "once" | "hold";

/** What the poser needs to know about the selected animation clip. */
export interface IClipTiming {
  /** Clip length in seconds. */
  duration: number;
  loop: LoopMode;
  /** Whether any track uses step (discrete) interpolation. */
  stepped: boolean;
  /** Blockbench timeline snapping in frames per second, when known. */
  snapping?: number;
}
