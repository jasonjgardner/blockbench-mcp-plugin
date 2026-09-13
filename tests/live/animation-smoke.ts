import { type IToolRequest, type LiveSession, runLiveSuite, suiteArtifactPath, type ToolCallResult } from "./harness";
import { record, records, sameCanonical } from "./narrow";

// Real native animation checks in a dedicated project; does not edit user rigs.

/** Wall-clock playback window before pausing; long enough for Blockbench to advance the timeline. */
const PLAYBACK_SAMPLE_MS = 180;
/** Allowed radian error when comparing the previewed rig rotation with an exact quarter turn. */
const ROTATION_TOLERANCE = 1e-5;
/** Keyframe time used to verify exact time retention (not on a frame boundary). */
const OFF_GRID_KEYFRAME_TIME = 0.37;

/** One animation property change that must be applied, recorded once, and undone. */
interface ISettingRoundTrip {
  action: string;
  args: Record<string, unknown>;
  field: string;
  value: unknown;
}

/** Identifiers shared by the animation scenarios after the rig and animation exist. */
interface IAnimationTarget {
  groupId: string;
  animationId: string;
}

const settingRoundTrips: readonly ISettingRoundTrip[] = [
  { action: "set_length", args: { length: 5 }, field: "length", value: 5 },
  { action: "set_fps", args: { fps: 48 }, field: "snapping", value: 48 },
  { action: "loop", args: { loop_mode: "once" }, field: "loop", value: "once" },
];

async function exportedAnimations(session: LiveSession): Promise<Record<string, unknown>[]> {
  return records((await session.exportProject()).animations ?? []);
}

async function findAnimation(session: LiveSession, id: unknown): Promise<Record<string, unknown>> {
  const animation = (await exportedAnimations(session)).find(item => item.uuid === id);
  if (!animation) throw new Error(`Exported project has no animation with UUID ${String(id)}`);
  return animation;
}

async function historyIndex(session: LiveSession): Promise<number> {
  return Number((await session.json("get_undo_stack")).index);
}

async function rigStructure(session: LiveSession): Promise<Record<string, unknown>> {
  const project = await session.exportProject();
  return { groups: project.groups ?? [], elements: project.elements ?? [], outliner: project.outliner ?? [] };
}

function keyframes(animation: Record<string, unknown>, groupId: string): Record<string, unknown>[] {
  return records(record(record(animation.animators)[groupId]).keyframes);
}

function timeline(session: LiveSession, animationId: string, action: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  return session.call("animation_timeline", { animation_id: animationId, action, ...args });
}

/** manage_keyframes arguments creating Spin root position keys, all at {@link OFF_GRID_KEYFRAME_TIME}. */
function positionKeyframes(animationId: string, values: number[][]): Record<string, unknown> {
  return {
    animation_id: animationId, action: "create", bone_name: "Spin root", channel: "position",
    keyframes: values.map(value => ({ time: OFF_GRID_KEYFRAME_TIME, values: value })),
  };
}

/** Blockbench expression reporting timeline state and the rig group's live preview rotation. */
function timelineProbeCode(groupId: string): string {
  return [
    `(() => { const group = Group.all.find(item => item.uuid === ${JSON.stringify(groupId)});`,
    "return {time: Timeline.time, playing: Timeline.playing, mode: Modes.selected.id,",
    "rotation: group.mesh.rotation.toArray().slice(0,3), selected_animation: Animation.selected?.uuid}; })()",
  ].join(" ");
}

async function groupUndoScenario(session: LiveSession): Promise<void> {
  await session.call("create_project", { name: "MCP Animation - Verified", format: "free" });
  const emptyRig = await rigStructure(session);
  const emptyIndex = await historyIndex(session);
  await session.call("add_group", { name: "Spin root", origin: [0, 0, 0] });
  const addedRoot = await rigStructure(session);
  session.check(records(addedRoot.groups).length === 1 && await historyIndex(session) === emptyIndex + 1, "add_group creates one tracked group in a single undo entry");
  await session.call("undo");
  session.check(sameCanonical(await rigStructure(session), emptyRig), "add_group undo removes its group and UUID-only outliner node");
  await session.call("redo");
  session.check(sameCanonical(await rigStructure(session), addedRoot), "add_group redo restores the group properties, UUID, and hierarchy");
}

async function boneCarrierScenario(session: LiveSession): Promise<string> {
  await session.call("add_group", { name: "Unused bone", origin: [0, 0, 0] });
  await session.call("place_mesh", { group: "Spin root", elements: [{ name: "Spin marker", vertices: [[3, 0, 0], [7, 0, 0], [3, 4, 0]], faces: [[0, 1, 2]] }] });
  const group = records((await session.exportProject()).groups).find(item => item.name === "Spin root");
  session.check(typeof group?.uuid === "string", "test rig exposes a stable group UUID");
  const groupId = group.uuid;
  const beforeCarrier = await rigStructure(session);
  const marker = records(beforeCarrier.elements).find(element => element.name === "Spin marker");
  session.check(typeof marker?.uuid === "string", "test mesh exposes a UUID for bone child references");
  const beforeCarrierIndex = await historyIndex(session);
  await session.call("bone_rigging", { action: "create", bone_data: { name: "Carrier probe", parent: groupId, children: [marker.uuid], origin: [0, 1, 0], rotation: [0, 0, 15] } });
  const withCarrier = await rigStructure(session);
  const carrier = records(withCarrier.groups).find(item => item.name === "Carrier probe");
  const rootNode = records(withCarrier.outliner).find(item => item.uuid === groupId);
  const carrierNode = records(rootNode?.children).find(item => item.uuid === carrier?.uuid);
  session.check(typeof carrier?.uuid === "string" && Array.isArray(carrierNode?.children) && carrierNode.children.includes(marker.uuid),
    "bone creation accepts parent and child UUIDs and attaches geometry inside the new carrier");
  session.check(await historyIndex(session) === beforeCarrierIndex + 1, "bone creation and child reparenting record one undo entry");
  await session.call("undo");
  session.check(sameCanonical(await rigStructure(session), beforeCarrier), "bone creation undo removes the carrier and restores the child's original parent");
  await session.call("redo");
  session.check(sameCanonical(await rigStructure(session), withCarrier), "bone creation redo restores carrier properties and complete child hierarchy");
  await session.call("undo");
  return groupId;
}

async function invalidRigScenario(session: LiveSession, groupId: string): Promise<void> {
  const beforeBadRig = await rigStructure(session);
  const beforeBadRigIndex = await historyIndex(session);
  await session.expectRejected([
    { name: "add_group", arguments: { name: "Invalid parent", parent: "__missing__" } },
    { name: "bone_rigging", arguments: { action: "create", bone_data: { name: "Invalid child", children: ["__missing__"] } } },
    { name: "bone_rigging", arguments: { action: "create", bone_data: { name: "Cycle", parent: groupId, children: [groupId] } } },
  ], "rejects missing hierarchy targets or a cycle");
  session.check(sameCanonical(await rigStructure(session), beforeBadRig) && await historyIndex(session) === beforeBadRigIndex,
    "invalid group creation preserves geometry, hierarchy, and undo history");
}

async function creationScenario(session: LiveSession, groupId: string): Promise<IAnimationTarget> {
  const baseline = await historyIndex(session);
  const created = await session.json("create_animation", {
    name: "mcp_spin_probe", animation_length: 4, loop: true,
    bones: { "Spin root": [0, 1, 2, 3, 4].map(time => ({ time, rotation: [0, time * 90, 0] })) },
  });
  session.check(typeof created.uuid === "string" && created.loop === "loop" && created.length === 4, "creation returns the actual animation UUID and loop properties");
  const animationId = created.uuid;
  const createdAnimations = await exportedAnimations(session);
  const spin = createdAnimations.find(animation => animation.uuid === animationId);
  session.check(!!spin, "created animation is included in the project export");
  const rotation = keyframes(spin, groupId).filter(frame => frame.channel === "rotation");
  session.check(rotation.length === 5 && rotation.every(frame => frame.interpolation === "linear"), "spin contains five linear rotation keys");
  session.check(rotation.every(frame => Number(record(records(frame.data_points)[0]).y) === Number(frame.time) * 90), "creation retains native Y rotation signs and full-turn values");
  session.check(await historyIndex(session) === baseline + 1, "animation creation records one undo entry");
  await session.call("undo");
  session.check((await exportedAnimations(session)).length === 0, "creation undo removes the new animation");
  await session.call("redo");
  session.check(sameCanonical(await exportedAnimations(session), createdAnimations), "creation redo restores all animation data");
  return { groupId, animationId };
}

async function playbackScenario(session: LiveSession, { groupId, animationId }: IAnimationTarget): Promise<void> {
  const probe = () => session.json("risky_eval", { code: timelineProbeCode(groupId) });
  const beforePlayback = await historyIndex(session);
  await timeline(session, animationId, "set_time", { time: 1 });
  const quarter = await probe();
  session.check(quarter.mode === "animate" && quarter.selected_animation === animationId, "explicit timeline target enters animation mode and selects the requested animation");
  session.check(Array.isArray(quarter.rotation) && Math.abs(Math.abs(Number(quarter.rotation[1])) - Math.PI / 2) < ROTATION_TOLERANCE, "one second previews a real quarter-turn on the native rig");
  await timeline(session, animationId, "set_time", { time: 0 });
  const start = await probe();
  await timeline(session, animationId, "play");
  await Bun.sleep(PLAYBACK_SAMPLE_MS);
  await timeline(session, animationId, "pause");
  const played = await probe();
  session.check(Number(played.time) > Number(start.time) && played.playing === false, "desktop playback advances time and pauses");
  await timeline(session, animationId, "stop");
  session.check(Number((await probe()).time) === 0, "stop rewinds the native timeline");
  session.check(await historyIndex(session) === beforePlayback, "playback and scrubbing do not add model undo entries");
}

async function verifySettingRoundTrip(session: LiveSession, animationId: string, setting: ISettingRoundTrip): Promise<void> {
  const before = await exportedAnimations(session);
  const index = await historyIndex(session);
  await timeline(session, animationId, setting.action, setting.args);
  session.check((await findAnimation(session, animationId))[setting.field] === setting.value, `${setting.action} updates the actual animation property`);
  session.check(await historyIndex(session) === index + 1, `${setting.action} records one undo entry`);
  await session.call("undo");
  session.check(sameCanonical(await exportedAnimations(session), before), `${setting.action} undo restores animation settings`);
}

async function keyframeScenario(session: LiveSession, { groupId, animationId }: IAnimationTarget): Promise<void> {
  const beforeKeys = await exportedAnimations(session);
  await session.call("manage_keyframes", positionKeyframes(animationId, [[1, 2, 3]]));
  const position = keyframes(await findAnimation(session, animationId), groupId).find(frame => frame.channel === "position");
  session.check(position?.time === OFF_GRID_KEYFRAME_TIME && Number(records(position.data_points)[0].x) === 1, "keyframe creation retains exact time and native values");
  await session.call("undo");
  session.check(sameCanonical(await exportedAnimations(session), beforeKeys), "keyframe creation undo restores the original channels");
  const beforeSelect = await historyIndex(session);
  await session.call("manage_keyframes", { animation_id: animationId, action: "select", bone_name: "Spin root", channel: "rotation", keyframes: [{ time: 1 }] });
  const appliedEntries = records((await session.json("get_undo_stack")).entries).filter(entry => Number(entry.index) >= beforeSelect && entry.is_applied);
  session.check(appliedEntries.every(entry => entry.type === "selection") && sameCanonical(await exportedAnimations(session), beforeKeys),
    "keyframe selection changes only selection history, preserving animation data");
}

function invalidAnimationRequests(animationId: string): IToolRequest[] {
  const create = (bones: Record<string, unknown>): IToolRequest => ({ name: "create_animation", arguments: { name: "bad", bones } });
  return [
    create({ "__missing__": [{ time: 0, rotation: [0, 90, 0] }] }),
    create({ "Spin root": [{ time: -1, rotation: [0, 90, 0] }] }),
    create({ "Spin root": [{ time: 0, rotation: [0, 0, 0] }, { time: 0, rotation: [0, 90, 0] }] }),
    { name: "manage_keyframes", arguments: positionKeyframes(animationId, [[1, 2, 3], [4, 5, 6]]) },
    { name: "manage_keyframes", arguments: { animation_id: animationId, action: "edit", bone_name: "Unused bone", channel: "rotation", keyframes: [{ time: 100, values: [0, 1, 0] }] } },
    { name: "animation_timeline", arguments: { animation_id: "__missing__", action: "play" } },
    { name: "animation_timeline", arguments: { animation_id: animationId, action: "set_length", length: -1 } },
  ];
}

async function invalidAnimationScenario(session: LiveSession, animationId: string): Promise<void> {
  const beforeInvalid = await exportedAnimations(session);
  const invalidIndex = await historyIndex(session);
  await session.expectRejected(invalidAnimationRequests(animationId), "rejects an invalid target or time before mutation");
  session.check(sameCanonical(await exportedAnimations(session), beforeInvalid) && await historyIndex(session) === invalidIndex, "rejected requests preserve animation data and undo history");
}

async function zeroScaleScenario(session: LiveSession, animationId: string): Promise<void> {
  const zero = await session.json("create_animation", { name: "zero_scale", bones: { "Unused bone": [{ time: 0, scale: 0 }] } });
  const zeroAnimation = await findAnimation(session, zero.uuid);
  const zeroKeys = Object.values(record(zeroAnimation.animators)).flatMap(animator => records(record(animator).keyframes ?? []));
  const isZeroScaleKey = (key: Record<string, unknown>): boolean => key.channel === "scale"
    && records(key.data_points).every(point => ["x", "y", "z"].every(axis => Number(point[axis]) === 0));
  session.check(zeroKeys.some(isZeroScaleKey), "creation retains zero-valued scale keyframes");
  await session.call("undo");
  await timeline(session, animationId, "stop");
}

async function animationSuite(session: LiveSession): Promise<void> {
  await groupUndoScenario(session);
  const groupId = await boneCarrierScenario(session);
  await invalidRigScenario(session, groupId);
  const target = await creationScenario(session, groupId);
  await playbackScenario(session, target);
  await Array.fromAsync(settingRoundTrips, setting => verifySettingRoundTrip(session, target.animationId, setting));
  await keyframeScenario(session, target);
  await invalidAnimationScenario(session, target.animationId);
  await zeroScaleScenario(session, target.animationId);
  await Bun.write(suiteArtifactPath("animation", "animation.bbmodel"), JSON.stringify(await session.exportProject(), null, 2));
  await session.writeResults("animation");
  console.log(`Completed ${session.checks.length} desktop animation checks.`);
}

await runLiveSuite("blockbench-animation-smoke", animationSuite);
