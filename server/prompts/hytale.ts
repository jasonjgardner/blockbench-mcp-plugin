/// <reference types="three" />
/// <reference types="blockbench-types" />

import { z } from "zod";
import { createPrompt } from "@/lib/factories";
import { readPrompt } from "@/macros/readPrompt" with { type: "macro" };
import { isHytalePluginInstalled } from "@/lib/hytale";

/**
 * Register Hytale-specific prompts.
 * These prompts are only registered when the Hytale plugin is installed.
 */
export function registerHytalePrompts() {
  // Only register if Hytale plugin is available
  if (!isHytalePluginInstalled()) {
    console.log("[MCP] Hytale plugin not detected, skipping Hytale prompts registration");
    return;
  }

  console.log("[MCP] Hytale plugin detected, registering Hytale prompts");

  createPrompt(
    "hytale_model_creation",
    {
      title: "Hytale Model Creation Guide",
      description:
        "Comprehensive guide for creating Hytale character and prop models. Covers format selection, node limits, shading modes, stretch, quads, and best practices.",
      argsSchema: z.object({
        format_type: z
          .enum(["character", "prop", "both"])
          .describe("Which format type to focus on")
          .optional()
          .default("both"),
      }),
      async generate({ format_type }) {
        const baseGuide = await readPrompt("hytale_model_creation");

        let additionalInfo = "";
        if (format_type === "character") {
          additionalInfo = `
## Character-Specific Guidelines

You are creating a **Hytale Character** model (64px block size).

Key considerations:
- Complex bone hierarchies for humanoid/creature rigs
- Full animation support with all channels
- Attachment system for equipment
- Higher detail level (64px textures)

Typical bone structure:
\`\`\`
root
├── body
│   ├── head
│   │   └── [face details]
│   ├── arm_left
│   │   └── hand_left
│   ├── arm_right
│   │   └── hand_right
│   ├── leg_left
│   │   └── foot_left
│   └── leg_right
│       └── foot_right
└── [accessories]
\`\`\`
`;
        } else if (format_type === "prop") {
          additionalInfo = `
## Prop-Specific Guidelines

You are creating a **Hytale Prop** model (32px block size).

Key considerations:
- Simpler structure optimized for items/objects
- May have minimal or no animation
- Often single-bone or simple hierarchy
- Lower detail level (32px textures)

Common prop types:
- Weapons (sword, axe, bow)
- Tools (pickaxe, shovel)
- Items (food, potions, keys)
- Decorations (furniture, plants)
`;
        }

        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: baseGuide + additionalInfo,
              },
            },
          ],
        };
      },
    },
    "experimental"
  );

  createPrompt(
    "hytale_animation_workflow",
    {
      title: "Hytale Animation Workflow",
      description:
        "Guide for creating animations for Hytale models. Covers 60 FPS timing, quaternion rotations, visibility keyframes, loop modes, and common animation patterns.",
      argsSchema: z.object({
        animation_type: z
          .enum(["walk", "idle", "attack", "general"])
          .describe("Type of animation to focus on")
          .optional()
          .default("general"),
      }),
      async generate({ animation_type }) {
        const baseGuide = await readPrompt("hytale_animation_workflow");

        let specificTips = "";
        if (animation_type === "walk") {
          specificTips = `
## Walk Cycle Focus

Creating a walk cycle animation:

1. **Timing** (1 second loop at 60 FPS)
   - Frame 0: Right foot forward (contact)
   - Frame 15: Right foot passing
   - Frame 30: Left foot forward (contact)
   - Frame 45: Left foot passing
   - Frame 60: Loop to frame 0

2. **Key Bones**
   - Legs: Primary motion drivers
   - Arms: Counter-swing to legs
   - Body: Slight up/down bob
   - Head: Subtle stabilization

3. **Interpolation**
   - Use \`smooth\` for organic feel
   - Slight ease-in/out on contacts
`;
        } else if (animation_type === "idle") {
          specificTips = `
## Idle Animation Focus

Creating a breathing/idle animation:

1. **Timing** (2-3 second loop)
   - Slow, subtle movements
   - Natural breathing rhythm

2. **Key Elements**
   - Chest: Scale Y for breathing (1.0 → 1.02 → 1.0)
   - Head: Tiny rotation shifts
   - Arms: Minimal sway
   - Weight shifts: Subtle body position

3. **Tips**
   - Keep movements very small
   - Use smooth interpolation
   - Avoid mechanical repetition
`;
        } else if (animation_type === "attack") {
          specificTips = `
## Attack Animation Focus

Creating a combat animation:

1. **Timing** (0.5-1 second)
   - Anticipation: 0.1-0.2s (wind-up)
   - Strike: 0.1s (fast action)
   - Recovery: 0.2-0.5s (return)

2. **Key Phases**
   - Wind-up: Draw weapon back
   - Strike: Quick forward motion
   - Impact: Slight pause/emphasis
   - Recovery: Return to ready pose

3. **Interpolation**
   - Anticipation: Smooth ease-in
   - Strike: Linear (fast)
   - Recovery: Smooth ease-out

4. **Tips**
   - Exaggerate wind-up for readability
   - Strike should be 2-3x faster than wind-up
   - Add slight overshoot on recovery
`;
        }

        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: baseGuide + specificTips,
              },
            },
          ],
        };
      },
    },
    "experimental"
  );

  createPrompt(
    "hytale_attachments",
    {
      title: "Hytale Attachments System",
      description:
        "Guide for creating and managing attachments in Hytale models. Covers attachment collections, piece bones, modular equipment, and best practices.",
      argsSchema: z.object({}),
      async generate() {
        const guide = await readPrompt("hytale_attachments");
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: guide,
              },
            },
          ],
        };
      },
    },
    "experimental"
  );

  console.log("[MCP] Hytale prompts registered successfully");
}
