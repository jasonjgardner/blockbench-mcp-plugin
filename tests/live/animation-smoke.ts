import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Real native animation checks in a dedicated project; does not edit user rigs.
const endpoint = new URL(Bun.argv[2] ?? "http://localhost:3000/bb-mcp");
const client = new Client({ name: "blockbench-animation-smoke", version: "1.0.0" });
const checks: string[] = [];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value.map(record);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
  checks.push(label);
  console.log(`PASS ${label}`);
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result;
}
async function json(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await call(name, args);
  const text = records(result.content).find(item => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`${name} returned no JSON text`);
  return record(JSON.parse(text));
}
async function exported(): Promise<Record<string, unknown>> {
  const result = await json("export_model", { codec_id: "project", max_content_length: 1000000 });
  if (result.truncated || typeof result.content !== "string") throw new Error("Animation project export is incomplete");
  return record(JSON.parse(result.content));
}
async function animations(): Promise<Record<string, unknown>[]> { return records((await exported()).animations ?? []); }
async function historyIndex(): Promise<number> { return Number((await json("get_undo_stack")).index); }
async function rigStructure(): Promise<Record<string, unknown>> {
  const project = await exported();
  return { groups: project.groups ?? [], elements: project.elements ?? [], outliner: project.outliner ?? [] };
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  await call("create_project", { name: "MCP Animation - Verified", format: "free" });
  const emptyRig = await rigStructure();
  const emptyIndex = await historyIndex();
  await call("add_group", { name: "Spin root", origin: [0, 0, 0] });
  const addedRoot = await rigStructure();
  check(records(addedRoot.groups).length === 1 && await historyIndex() === emptyIndex + 1, "add_group creates one tracked group in a single undo entry");
  await call("undo");
  check(same(await rigStructure(), emptyRig), "add_group undo removes its group and UUID-only outliner node");
  await call("redo");
  check(same(await rigStructure(), addedRoot), "add_group redo restores the group properties, UUID, and hierarchy");
  await call("add_group", { name: "Unused bone", origin: [0, 0, 0] });
  await call("place_mesh", { group: "Spin root", elements: [{ name: "Spin marker", vertices: [[3, 0, 0], [7, 0, 0], [3, 4, 0]], faces: [[0, 1, 2]] }] });
  const group = records((await exported()).groups).find(item => item.name === "Spin root");
  check(typeof group?.uuid === "string", "test rig exposes a stable group UUID");
  const groupId = group.uuid;
  const beforeCarrier = await rigStructure();
  const marker = records(beforeCarrier.elements).find(element => element.name === "Spin marker");
  check(typeof marker?.uuid === "string", "test mesh exposes a UUID for bone child references");
  const beforeCarrierIndex = await historyIndex();
  await call("bone_rigging", { action: "create", bone_data: { name: "Carrier probe", parent: groupId, children: [marker.uuid], origin: [0, 1, 0], rotation: [0, 0, 15] } });
  const withCarrier = await rigStructure();
  const carrier = records(withCarrier.groups).find(item => item.name === "Carrier probe");
  const rootNode = records(withCarrier.outliner).find(item => item.uuid === groupId);
  const carrierNode = records(rootNode?.children).find(item => item.uuid === carrier?.uuid);
  check(typeof carrier?.uuid === "string" && Array.isArray(carrierNode?.children) && carrierNode.children.includes(marker.uuid), "bone creation accepts parent and child UUIDs and attaches geometry inside the new carrier");
  check(await historyIndex() === beforeCarrierIndex + 1, "bone creation and child reparenting record one undo entry");
  await call("undo");
  check(same(await rigStructure(), beforeCarrier), "bone creation undo removes the carrier and restores the child's original parent");
  await call("redo");
  check(same(await rigStructure(), withCarrier), "bone creation redo restores carrier properties and complete child hierarchy");
  await call("undo");
  const beforeBadRig = await rigStructure();
  const beforeBadRigIndex = await historyIndex();
  for (const request of [
    { name: "add_group", arguments: { name: "Invalid parent", parent: "__missing__" } },
    { name: "bone_rigging", arguments: { action: "create", bone_data: { name: "Invalid child", children: ["__missing__"] } } },
    { name: "bone_rigging", arguments: { action: "create", bone_data: { name: "Cycle", parent: groupId, children: [groupId] } } },
  ]) check((await client.callTool(request)).isError, `${request.name} rejects missing hierarchy targets or a cycle`);
  check(same(await rigStructure(), beforeBadRig) && await historyIndex() === beforeBadRigIndex, "invalid group creation preserves geometry, hierarchy, and undo history");
  const baseline = await historyIndex();
  const created = await json("create_animation", {
    name: "mcp_spin_probe", animation_length: 4, loop: true,
    bones: { "Spin root": [0, 1, 2, 3, 4].map(time => ({ time, rotation: [0, time * 90, 0] })) },
  });
  check(typeof created.uuid === "string" && created.loop === "loop" && created.length === 4, "creation returns the actual animation UUID and loop properties");
  const id = created.uuid;
  const createdAnimations = await animations();
  const spin = createdAnimations.find(animation => animation.uuid === id);
  check(!!spin, "created animation is included in the project export");
  const rotation = records(record(record(spin.animators)[groupId]).keyframes).filter(frame => frame.channel === "rotation");
  check(rotation.length === 5 && rotation.every(frame => frame.interpolation === "linear"), "spin contains five linear rotation keys");
  check(rotation.every(frame => Number(record(records(frame.data_points)[0]).y) === Number(frame.time) * 90), "creation retains native Y rotation signs and full-turn values");
  check(await historyIndex() === baseline + 1, "animation creation records one undo entry");
  await call("undo");
  check((await animations()).length === 0, "creation undo removes the new animation");
  await call("redo");
  check(same(await animations(), createdAnimations), "creation redo restores all animation data");

  const timeline = async (action: string, args: Record<string, unknown> = {}) => call("animation_timeline", { animation_id: id, action, ...args });
  const probe = () => json("risky_eval", { code: `(() => { const group = Group.all.find(item => item.uuid === ${JSON.stringify(groupId)}); return {time: Timeline.time, playing: Timeline.playing, mode: Modes.selected.id, rotation: group.mesh.rotation.toArray().slice(0,3), selected_animation: Animation.selected?.uuid}; })()` });
  const beforePlayback = await historyIndex();
  await timeline("set_time", { time: 1 });
  const quarter = await probe();
  check(quarter.mode === "animate" && quarter.selected_animation === id, "explicit timeline target enters animation mode and selects the requested animation");
  check(Array.isArray(quarter.rotation) && Math.abs(Math.abs(Number(quarter.rotation[1])) - Math.PI / 2) < 1e-5, "one second previews a real quarter-turn on the native rig");
  await timeline("set_time", { time: 0 });
  const start = await probe();
  await timeline("play");
  await new Promise(resolve => setTimeout(resolve, 180));
  await timeline("pause");
  const played = await probe();
  check(Number(played.time) > Number(start.time) && played.playing === false, "desktop playback advances time and pauses");
  await timeline("stop");
  check(Number((await probe()).time) === 0, "stop rewinds the native timeline");
  check(await historyIndex() === beforePlayback, "playback and scrubbing do not add model undo entries");

  for (const [action, args, field, value] of [
    ["set_length", { length: 5 }, "length", 5],
    ["set_fps", { fps: 48 }, "snapping", 48],
    ["loop", { loop_mode: "once" }, "loop", "once"],
  ] as const) {
    const before = await animations();
    const index = await historyIndex();
    await timeline(action, args);
    check((await animations()).find(animation => animation.uuid === id)?.[field] === value, `${action} updates the actual animation property`);
    check(await historyIndex() === index + 1, `${action} records one undo entry`);
    await call("undo");
    check(same(await animations(), before), `${action} undo restores animation settings`);
  }

  const beforeKeys = await animations();
  await call("manage_keyframes", { animation_id: id, action: "create", bone_name: "Spin root", channel: "position", keyframes: [{ time: 0.37, values: [1, 2, 3] }] });
  const edited = (await animations()).find(animation => animation.uuid === id)!;
  const position = records(record(record(edited.animators)[groupId]).keyframes).find(frame => frame.channel === "position");
  check(position?.time === 0.37 && Number(records(position.data_points)[0].x) === 1, "keyframe creation retains exact time and native values");
  await call("undo");
  check(same(await animations(), beforeKeys), "keyframe creation undo restores the original channels");
  const beforeSelect = await historyIndex();
  await call("manage_keyframes", { animation_id: id, action: "select", bone_name: "Spin root", channel: "rotation", keyframes: [{ time: 1 }] });
  const selectedHistory = await json("get_undo_stack");
  check(records(selectedHistory.entries).filter(entry => Number(entry.index) >= beforeSelect && entry.is_applied).every(entry => entry.type === "selection") && same(await animations(), beforeKeys), "keyframe selection changes only selection history, preserving animation data");

  const invalid = [
    { name: "create_animation", arguments: { name: "bad", bones: { "__missing__": [{ time: 0, rotation: [0, 90, 0] }] } } },
    { name: "create_animation", arguments: { name: "bad", bones: { "Spin root": [{ time: -1, rotation: [0, 90, 0] }] } } },
    { name: "create_animation", arguments: { name: "bad", bones: { "Spin root": [{ time: 0, rotation: [0, 0, 0] }, { time: 0, rotation: [0, 90, 0] }] } } },
    { name: "manage_keyframes", arguments: { animation_id: id, action: "create", bone_name: "Spin root", channel: "position", keyframes: [{ time: 0.37, values: [1, 2, 3] }, { time: 0.37, values: [4, 5, 6] }] } },
    { name: "manage_keyframes", arguments: { animation_id: id, action: "edit", bone_name: "Unused bone", channel: "rotation", keyframes: [{ time: 100, values: [0, 1, 0] }] } },
    { name: "animation_timeline", arguments: { animation_id: "__missing__", action: "play" } },
    { name: "animation_timeline", arguments: { animation_id: id, action: "set_length", length: -1 } },
  ];
  const beforeInvalid = await animations();
  const invalidIndex = await historyIndex();
  for (const request of invalid) check((await client.callTool(request)).isError, `${request.name} rejects an invalid target or time before mutation`);
  check(same(await animations(), beforeInvalid) && await historyIndex() === invalidIndex, "rejected requests preserve animation data and undo history");

  const zero = await json("create_animation", { name: "zero_scale", bones: { "Unused bone": [{ time: 0, scale: 0 }] } });
  const zeroAnimation = (await animations()).find(animation => animation.uuid === zero.uuid)!;
  const zeroKeys = Object.values(record(zeroAnimation.animators)).flatMap(animator => records(record(animator).keyframes ?? []));
  check(zeroKeys.some(key => key.channel === "scale" && records(key.data_points).every(point => ["x", "y", "z"].every(axis => Number(point[axis]) === 0))), "creation retains zero-valued scale keyframes");
  await call("undo");
  await timeline("stop");
  await Bun.write(new URL("../../artifacts/animation/animation.bbmodel", import.meta.url), JSON.stringify(await exported(), null, 2));
  await Bun.write(new URL("../../artifacts/animation/smoke-results.json", import.meta.url), JSON.stringify({ checks }, null, 2));
  console.log(`Completed ${checks.length} desktop animation checks.`);
} finally {
  await client.close();
}
