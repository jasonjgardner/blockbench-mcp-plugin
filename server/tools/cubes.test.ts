import { describe, expect, test } from "bun:test";
import { modifyCubeParameters, placeCubeParameters, planCubeShading, type ICubeShadingFormat } from "@/server/tools/cubes";

const JAVA_26_3: ICubeShadingFormat = { shading_properties: true, direction_override: true };
const JAVA_LEGACY: ICubeShadingFormat = { shading_properties: true, direction_override: false };
const BEDROCK: ICubeShadingFormat = { shading_properties: false, direction_override: false };

describe("planCubeShading", () => {
  test("maps shade=false to shade_direction_override 'up' in Java 26.3+ projects, like Blockbench's import", () => {
    const plan = planCubeShading({ shade: false }, JAVA_26_3);
    expect(plan.patch).toEqual({ shade: false, shade_direction_override: "up" });
    expect(plan.notes.join(" ")).toContain("'up'");
  });

  test("an explicit override wins over the shade mapping", () => {
    expect(planCubeShading({ shade: false, shade_direction_override: "north" }, JAVA_26_3).patch)
      .toEqual({ shade: false, shade_direction_override: "north" });
    expect(planCubeShading({ shade_direction_override: "" }, JAVA_26_3)).toEqual({ patch: { shade_direction_override: "" }, notes: [] });
  });

  test("keeps plain shade in pre-26.3 formats and implies shade=false for a stored override", () => {
    expect(planCubeShading({ shade: false }, JAVA_LEGACY)).toEqual({ patch: { shade: false }, notes: [] });
    const plan = planCubeShading({ shade_direction_override: "down" }, JAVA_LEGACY);
    expect(plan.patch).toEqual({ shade: false, shade_direction_override: "down" });
    expect(plan.notes).toHaveLength(1);
  });

  test("passes light emission through and notes formats that do not export it", () => {
    expect(planCubeShading({ light_emission: 7 }, JAVA_26_3)).toEqual({ patch: { light_emission: 7 }, notes: [] });
    expect(planCubeShading({ light_emission: 7 }, BEDROCK).notes).toHaveLength(1);
  });

  test("leaves every field untouched when nothing is requested", () => {
    expect(planCubeShading({}, JAVA_26_3)).toEqual({ patch: {}, notes: [] });
  });
});

describe("cube shading schemas", () => {
  test("place_cube elements and modify_cube accept the 5.2 shading fields", () => {
    const placed = placeCubeParameters.parse({ elements: [{ name: "lamp", shade_direction_override: "up", light_emission: 15 }] });
    expect(placed.elements[0]).toMatchObject({ shade_direction_override: "up", light_emission: 15 });
    expect(modifyCubeParameters.parse({ shade_direction_override: "" }).shade_direction_override).toBe("");
  });

  test("rejects out-of-range light emission and unknown directions", () => {
    expect(() => modifyCubeParameters.parse({ light_emission: 16 })).toThrow();
    expect(() => modifyCubeParameters.parse({ shade_direction_override: "sideways" })).toThrow();
  });
});
