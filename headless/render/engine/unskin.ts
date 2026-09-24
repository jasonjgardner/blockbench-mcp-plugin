import { Matrix4, Mesh, SkinnedMesh, type BufferAttribute, type InterleavedBufferAttribute, type Object3D } from "three";

/**
 * The single bone that drives every vertex of `mesh`, or undefined when the mesh is truly
 * weighted across several bones.
 */
export function rigidBoneIndex(skinIndex: ArrayLike<number>, skinWeight: ArrayLike<number>, itemSize: number): number | undefined {
  const vertexCount = Math.floor(skinIndex.length / itemSize);
  if (vertexCount === 0) return undefined;
  const dominant = (vertex: number): number | undefined => {
    const offsets = Array.from({ length: itemSize }, (_, slot) => vertex * itemSize + slot);
    const weighted = offsets.filter((offset) => (skinWeight[offset] ?? 0) > 1e-6);
    if (weighted.length !== 1) return undefined;
    const offset = weighted[0] ?? 0;
    return Math.abs((skinWeight[offset] ?? 0) - 1) < 1e-4 ? skinIndex[offset] : undefined;
  };
  const first = dominant(0);
  if (first === undefined) return undefined;
  const indices = Array.from({ length: vertexCount }, (_, vertex) => vertex);
  return indices.every((vertex) => dominant(vertex) === first) ? first : undefined;
}

type SkinAttribute = BufferAttribute | InterleavedBufferAttribute;

/** A draw range within an indexed geometry, as in `BufferGeometry.groups`. */
export interface IDrawGroup {
  start: number;
  count: number;
  materialIndex?: number | undefined;
}

/**
 * Merges back-to-back draw groups that use the same material.
 *
 * Blockbench cubes are built with one group per face, so a cube whose six faces share a texture
 * costs six draw calls. Merging contiguous same-material ranges draws it once, with identical output.
 */
export function mergeDrawGroups(groups: readonly IDrawGroup[]): IDrawGroup[] {
  return groups.reduce<IDrawGroup[]>((merged, group) => {
    const last = merged.at(-1);
    const contiguous = last !== undefined && last.materialIndex === group.materialIndex && last.start + last.count === group.start;
    if (!contiguous) return [...merged, { ...group }];
    return [...merged.slice(0, -1), { ...last, count: last.count + group.count }];
  }, []);
}

/**
 * Replaces rigidly skinned meshes with plain meshes parented to their bone.
 *
 * three-blockbench builds every cube as a SkinnedMesh bound with weight 1 to its own pivot bone,
 * all sharing one skeleton. The WebGPU renderer then uploads the full bone-matrix array once per
 * mesh per pass, so a 459-cube model spends about a second per frame on uniform uploads. A rigid
 * mesh is equivalent to a plain mesh under its bone with geometry moved into bone space
 * (`boneInverse × bindMatrix`), which the scene graph animates for free.
 *
 * Assumes each SkinnedMesh's world matrix still equals its bind-time matrix (the loader's
 * default "attached" bind mode with a static model root). Meshes with real blended weights are
 * left untouched.
 *
 * @returns how many meshes were converted.
 */
export function unskinRigidMeshes(root: Object3D): number {
  const skinned: SkinnedMesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (object instanceof SkinnedMesh) skinned.push(object);
  });

  return skinned.filter((mesh) => {
    const skinIndex = mesh.geometry.getAttribute("skinIndex") as SkinAttribute | undefined;
    const skinWeight = mesh.geometry.getAttribute("skinWeight") as SkinAttribute | undefined;
    if (skinIndex === undefined || skinWeight === undefined || mesh.parent === null) return false;
    const indexArray = Array.from({ length: skinIndex.count * skinIndex.itemSize }, (_, i) => skinIndex.getComponent(Math.floor(i / skinIndex.itemSize), i % skinIndex.itemSize));
    const weightArray = Array.from({ length: skinWeight.count * skinWeight.itemSize }, (_, i) => skinWeight.getComponent(Math.floor(i / skinWeight.itemSize), i % skinWeight.itemSize));
    const boneIndex = rigidBoneIndex(indexArray, weightArray, skinIndex.itemSize);
    const bone = boneIndex === undefined ? undefined : mesh.skeleton.bones[boneIndex];
    const boneInverse = boneIndex === undefined ? undefined : mesh.skeleton.boneInverses[boneIndex];
    if (bone === undefined || boneInverse === undefined) return false;

    const toBoneSpace = new Matrix4().multiplyMatrices(boneInverse, mesh.bindMatrix);
    const geometry = mesh.geometry.clone();
    geometry.deleteAttribute("skinIndex");
    geometry.deleteAttribute("skinWeight");
    geometry.applyMatrix4(toBoneSpace);
    const groups = mergeDrawGroups(geometry.groups);
    geometry.clearGroups();
    groups.forEach((group) => geometry.addGroup(group.start, group.count, group.materialIndex));

    const replacement = new Mesh(geometry, mesh.material);
    replacement.name = mesh.name;
    replacement.userData = { ...mesh.userData };
    replacement.castShadow = mesh.castShadow;
    replacement.receiveShadow = mesh.receiveShadow;
    replacement.renderOrder = mesh.renderOrder;
    replacement.visible = mesh.visible;
    bone.add(replacement);
    mesh.parent.remove(mesh);
    mesh.geometry.dispose();
    return true;
  }).length;
}
