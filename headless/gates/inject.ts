/**
 * Defect injectors and the differential self-test for geometry gates.
 *
 * bbmodel-maker's central lesson: a gate can pass everything while detecting
 * nothing, and nobody notices because it "has output and looks like it works".
 * So each gate gets an injector that plants the defect the gate exists to catch
 * into a copy of the real model. A gate that reports no more violations on the
 * damaged copy than on the original has lost its discriminating power on this
 * asset, and its green result means nothing.
 *
 * Injectors pick their victim from the model itself (never a hard-coded name) and
 * report when a defect cannot be planted, for example no two groups to
 * interpenetrate.
 *
 * @module
 */

import { type IBBModel, type ICube, isCube, type Vec3 } from "../document/schema";
import { ancestorsOf, detachNode, indexModel, nodeName } from "../document/tree";
import { aabbSize, elementBoxes } from "../geometry/bounds";
import { DEFAULT_GEOMETRY_OPTIONS, type GeometryGateId, type IGeometryGateOptions, mirrorName, runGeometryGates, sideOf } from "./geometry";

/** A planted defect, or the reason none could be planted. */
export type Injection = { doc: IBBModel; victim: string; description: string } | { impossible: string };

/** Self-test verdict for one gate. */
export interface ISelfTestResult {
  gate: GeometryGateId;
  /** True when the gate reported more violations on the damaged copy. */
  discriminates: boolean | null;
  clean_violations: number;
  injected_violations: number;
  injected?: string;
  impossible?: string;
}

const shiftCube = (cube: ICube, delta: Vec3): ICube => ({
  ...cube,
  from: [cube.from[0] + delta[0], cube.from[1] + delta[1], cube.from[2] + delta[2]],
  to: [cube.to[0] + delta[0], cube.to[1] + delta[1], cube.to[2] + delta[2]],
  origin: [cube.origin[0] + delta[0], cube.origin[1] + delta[1], cube.origin[2] + delta[2]],
});

const replaceCube = (doc: IBBModel, replacement: ICube): IBBModel => ({
  ...doc,
  elements: doc.elements.map((element) => (element.uuid === replacement.uuid ? replacement : element)),
});

const placedCubes = (doc: IBBModel): ICube[] => {
  const index = indexModel(doc);
  return doc.elements.filter(isCube).filter((cube) => index.placement.has(cube.uuid));
};

const INJECTORS: Readonly<Record<GeometryGateId, (doc: IBBModel, options: IGeometryGateOptions) => Injection>> = {
  outliner: (doc) => ({ doc: { ...doc, outliner: [...doc.outliner, crypto.randomUUID()] }, victim: "(outliner)", description: "added a reference to a node that does not exist" }),
  unlisted_nodes: (doc) => {
    const [victim] = placedCubes(doc);
    if (!victim) return { impossible: "The model has no placed cube." };
    return { doc: { ...doc, outliner: detachNode(doc.outliner, victim.uuid).outliner }, victim: victim.name, description: "removed it from the outliner" };
  },
  degenerate: (doc, options) => {
    const [victim] = placedCubes(doc);
    if (!victim) return { impossible: "The model has no placed cube." };
    const thin: ICube = { ...victim, to: [victim.to[0], victim.from[1] + options.minThickness / 4, victim.to[2]] };
    return { doc: replaceCube(doc, thin), victim: victim.name, description: `made it ${options.minThickness / 4} units thick` };
  },
  block_limits: (doc, options) => {
    const [victim] = placedCubes(doc);
    if (!victim) return { impossible: "The model has no placed cube." };
    if (options.blockLimits === "none") return { impossible: "block_limits is disabled." };
    return { doc: replaceCube(doc, shiftCube(victim, [0, 200, 0])), victim: victim.name, description: "moved it 200 units up" };
  },
  floating: (doc, options) => {
    const free = new Set(options.freeElements);
    const victim = placedCubes(doc).find((cube) => !free.has(cube.name));
    if (!victim || placedCubes(doc).length < 2) return { impossible: "Needs at least two placed cubes." };
    return { doc: replaceCube(doc, shiftCube(victim, [0, 1000, 0])), victim: victim.name, description: "moved it 1000 units away" };
  },
  interpenetration: (doc, options) => {
    const index = indexModel(doc);
    const boxes = elementBoxes(doc, index);
    const cubes = placedCubes(doc).filter((cube) => !cube.rotation?.some((value) => value !== 0) && ancestorsOf(index, cube.uuid).every((id) => (index.groups.get(id)?.rotation ?? [0, 0, 0]).every((value) => value === 0)));
    const thick = cubes.filter((cube) => {
      const box = boxes.get(cube.uuid);
      return box ? Math.min(...aabbSize(box)) > options.interpenetrationDepth : false;
    });
    const groupOf = (cube: ICube): string | null => ancestorsOf(index, cube.uuid)[0] ?? null;
    const pair = thick.flatMap((host) => cubes.filter((mover) => groupOf(mover) !== groupOf(host) && (options.materialKey === "none" || mover.color !== host.color)).map((mover) => ({ host, mover })))[0];
    if (!pair) return { impossible: "Needs two unrotated cubes in different groups, one thicker than the penetration depth." };
    const moved: ICube = { ...pair.mover, from: [...pair.host.from], to: [...pair.host.to], origin: [...pair.host.origin] };
    return { doc: replaceCube(doc, moved), victim: pair.mover.name, description: `moved it inside ${pair.host.name}` };
  },
  mirror: (doc) => {
    const index = indexModel(doc);
    const victim = placedCubes(doc).find((cube) => [cube.uuid, ...ancestorsOf(index, cube.uuid)].some((id) => sideOf(nodeName(index, id)) === "left"));
    if (!victim) return { impossible: "No placed cube has a left/right name or sits under a left/right group." };
    return { doc: replaceCube(doc, shiftCube(victim, [2, 0, 0])), victim: victim.name, description: `shifted it 2 units on x (its mirror is ${mirrorName(victim.name)})` };
  },
};

/**
 * Plants one defect.
 *
 * @returns The damaged copy, or why the defect cannot be planted on this model.
 */
export function injectDefect(doc: IBBModel, gate: GeometryGateId, options: Partial<IGeometryGateOptions> = {}): Injection {
  return INJECTORS[gate](doc, { ...DEFAULT_GEOMETRY_OPTIONS, ...options });
}

/**
 * Runs each gate on the model and on a copy with that gate's defect planted.
 *
 * @returns One verdict per gate; `discriminates: null` when no defect could be planted.
 */
export function selfTestGeometryGates(doc: IBBModel, options: Partial<IGeometryGateOptions>, gates: readonly GeometryGateId[]): ISelfTestResult[] {
  return gates.map((gate) => {
    const count = (model: IBBModel): number => runGeometryGates(model, options, [gate])[0]?.violations.length ?? 0;
    const clean = count(doc);
    const injection = injectDefect(doc, gate, options);
    if ("impossible" in injection) return { gate, discriminates: null, clean_violations: clean, injected_violations: clean, impossible: injection.impossible };
    const injected = count(injection.doc);
    return { gate, discriminates: injected > clean, clean_violations: clean, injected_violations: injected, injected: `${injection.victim}: ${injection.description}` };
  });
}
