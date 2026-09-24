import { describe, expect, test } from "bun:test";
import { bbmodelSchema, type IBBModel } from "../document/schema";
import { compileModdedEntity, createUniqueName, MODDED_ENTITY_TEMPLATE_IDS, MODDED_ENTITY_TEMPLATE_LIST, type ModdedEntityTemplateId, sanitizeBoneName } from "./modded-entity";

/** Box-UV cube JSON with fixed UUIDs, so expected lines can be written by hand. */
const cube = (uuid: string, name: string, from: number[], to: number[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  uuid,
  name,
  type: "cube",
  from,
  to,
  origin: [0, 0, 0],
  box_uv: true,
  uv_offset: [0, 0],
  faces: {},
  ...extra,
});

/**
 * A small rig: body (with a rotated fin), head rotated 30° on X with an inflated hat,
 * a mirrored left leg, a right leg, a loose root cube (→ bb_main) and a root mesh.
 */
function riggedModel(): IBBModel {
  return bbmodelSchema.parse({
    meta: { format_version: "5.0", model_format: "modded_entity", box_uv: true },
    name: "test creature",
    model_identifier: "TestCreature",
    resolution: { width: 64, height: 64 },
    elements: [
      cube("c-torso", "torso", [-4, 12, -2], [4, 24, 2], { uv_offset: [16, 16] }),
      cube("c-fin", "fin", [-1, 20, 2], [1, 23, 4], { uv_offset: [40, 16], origin: [0, 20, 2], rotation: [0, 0, 45] }),
      cube("c-skull", "skull", [-4, 24, -4], [4, 32, 4]),
      cube("c-hat", "hat", [-4, 24, -4], [4, 32, 4], { uv_offset: [32, 0], inflate: 0.5 }),
      cube("c-leg-l", "leg_l_cube", [0, 0, -2], [4, 12, 2], { uv_offset: [0, 16], mirror_uv: true }),
      cube("c-leg-r", "leg_r_cube", [-4, 0, -2], [0, 12, 2], { uv_offset: [0, 16] }),
      cube("c-base", "base", [-2, 0, -2], [2, 1, 2], { uv_offset: [0, 48] }),
      { uuid: "m-blob", name: "blob", type: "mesh", origin: [0, 0, 0], vertices: {}, faces: {} },
    ],
    groups: [
      { uuid: "g-body", name: "body", origin: [0, 12, 0], rotation: [0, 0, 0] },
      { uuid: "g-head", name: "head", origin: [0, 24, 0], rotation: [30, 0, 0] },
      { uuid: "g-leg-l", name: "leg_l", origin: [2, 12, 0], rotation: [0, 0, 0] },
      { uuid: "g-leg-r", name: "leg_r", origin: [-2, 12, 0], rotation: [0, 0, 0] },
    ],
    outliner: [
      {
        uuid: "g-body",
        children: [
          "c-torso",
          "c-fin",
          { uuid: "g-head", children: ["c-skull", "c-hat"] },
          { uuid: "g-leg-l", children: ["c-leg-l"] },
          { uuid: "g-leg-r", children: ["c-leg-r"] },
        ],
      },
      "c-base",
      "m-blob",
    ],
  });
}

const compile = (template: ModdedEntityTemplateId, doc: IBBModel = riggedModel()) => compileModdedEntity(doc, { template, bbVersion: "5.0.0" });
const lines = (code: string): string[] => code.split("\n").map((line) => line.trim());

/**
 * Expected key lines per template, written by hand from Blockbench's templates and
 * `compile()` (flip Y on: root pivots get +24, Y negated; X negated; rotations X/Y negated, radians).
 */
const EXPECTED: Record<ModdedEntityTemplateId, string[]> = {
  "1.12": [
    "public class TestCreature extends ModelBase {",
    "private final ModelRenderer body;",
    "private final ModelRenderer fin_r1;",
    "private final ModelRenderer bb_main;",
    "textureWidth = 64;",
    "textureHeight = 64;",
    "body = new ModelRenderer(this);",
    "body.setRotationPoint(0.0F, 12.0F, 0.0F);",
    "body.cubeList.add(new ModelBox(body, 16, 16, -4.0F, -12.0F, -2.0F, 8, 12, 4, 0.0F, false));",
    "fin_r1.setRotationPoint(0.0F, -8.0F, 2.0F);",
    "body.addChild(fin_r1);",
    "setRotationAngle(fin_r1, 0.0F, 0.0F, 0.7854F);",
    "fin_r1.cubeList.add(new ModelBox(fin_r1, 40, 16, -1.0F, -3.0F, 0.0F, 2, 3, 2, 0.0F, false));",
    "head.setRotationPoint(0.0F, -12.0F, 0.0F);",
    "setRotationAngle(head, -0.5236F, 0.0F, 0.0F);",
    "head.cubeList.add(new ModelBox(head, 0, 0, -4.0F, -8.0F, -4.0F, 8, 8, 8, 0.0F, false));",
    "head.cubeList.add(new ModelBox(head, 32, 0, -4.0F, -8.0F, -4.0F, 8, 8, 8, 0.5F, false));",
    "leg_l.setRotationPoint(-2.0F, 0.0F, 0.0F);",
    "leg_l.cubeList.add(new ModelBox(leg_l, 0, 16, -2.0F, 0.0F, -2.0F, 4, 12, 4, 0.0F, true));",
    "leg_r.setRotationPoint(2.0F, 0.0F, 0.0F);",
    "bb_main.setRotationPoint(0.0F, 24.0F, 0.0F);",
    "bb_main.cubeList.add(new ModelBox(bb_main, 0, 48, -2.0F, -1.0F, -2.0F, 4, 1, 4, 0.0F, false));",
    "body.render(f5);",
    "bb_main.render(f5);",
  ],
  "1.14": [
    "public class TestCreature extends EntityModel {",
    "private final RendererModel head;",
    "head = new RendererModel(this);",
    "head.setRotationPoint(0.0F, -12.0F, 0.0F);",
    "body.addChild(head);",
    "setRotationAngle(head, -0.5236F, 0.0F, 0.0F);",
    "head.cubeList.add(new ModelBox(head, 32, 0, -4.0F, -8.0F, -4.0F, 8, 8, 8, 0.5F, false));",
    "leg_l.cubeList.add(new ModelBox(leg_l, 0, 16, -2.0F, 0.0F, -2.0F, 4, 12, 4, 0.0F, true));",
    "body.render(f5);",
  ],
  "1.14_mojmaps": [
    "texWidth = 64;",
    "head.setPos(0.0F, -12.0F, 0.0F);",
    "head.cubes.add(new ModelBox(head, 32, 0, -4.0F, -8.0F, -4.0F, 8, 8, 8, 0.5F, false));",
    "leg_l.cubes.add(new ModelBox(leg_l, 0, 16, -2.0F, 0.0F, -2.0F, 4, 12, 4, 0.0F, true));",
    "modelRenderer.xRot = x;",
  ],
  "1.15": [
    "public class TestCreature extends EntityModel<Entity> {",
    "private final ModelRenderer fin_r1;",
    "body.setTextureOffset(16, 16).addBox(-4.0F, -12.0F, -2.0F, 8.0F, 12.0F, 4.0F, 0.0F, false);",
    "setRotationAngle(fin_r1, 0.0F, 0.0F, 0.7854F);",
    "fin_r1.setTextureOffset(40, 16).addBox(-1.0F, -3.0F, 0.0F, 2.0F, 3.0F, 2.0F, 0.0F, false);",
    "head.setTextureOffset(32, 0).addBox(-4.0F, -8.0F, -4.0F, 8.0F, 8.0F, 8.0F, 0.5F, false);",
    "leg_l.setTextureOffset(0, 16).addBox(-2.0F, 0.0F, -2.0F, 4.0F, 12.0F, 4.0F, 0.0F, true);",
    "body.render(matrixStack, buffer, packedLight, packedOverlay, red, green, blue, alpha);",
    "bb_main.render(matrixStack, buffer, packedLight, packedOverlay, red, green, blue, alpha);",
  ],
  "1.15_mojmaps": [
    "texHeight = 64;",
    "body.setPos(0.0F, 12.0F, 0.0F);",
    "body.texOffs(16, 16).addBox(-4.0F, -12.0F, -2.0F, 8.0F, 12.0F, 4.0F, 0.0F, false);",
    "leg_l.texOffs(0, 16).addBox(-2.0F, 0.0F, -2.0F, 4.0F, 12.0F, 4.0F, 0.0F, true);",
    "public void renderToBuffer(MatrixStack matrixStack, IVertexBuilder buffer, int packedLight, int packedOverlay, float red, float green, float blue, float alpha){",
  ],
  "1.17": [
    "public class TestCreature<T extends Entity> extends EntityModel<T> {",
    'public static final ModelLayerLocation LAYER_LOCATION = new ModelLayerLocation(new ResourceLocation("modid", "testcreature"), "main");',
    "private final ModelPart body;",
    "this.body = root.getChild(\"body\");",
    "this.head = this.body.getChild(\"head\");",
    "this.bb_main = root.getChild(\"bb_main\");",
    'PartDefinition body = partdefinition.addOrReplaceChild("body", CubeListBuilder.create().texOffs(16, 16).addBox(-4.0F, -12.0F, -2.0F, 8.0F, 12.0F, 4.0F, new CubeDeformation(0.0F)), PartPose.offset(0.0F, 12.0F, 0.0F));',
    'PartDefinition fin_r1 = body.addOrReplaceChild("fin_r1", CubeListBuilder.create().texOffs(40, 16).addBox(-1.0F, -3.0F, 0.0F, 2.0F, 3.0F, 2.0F, new CubeDeformation(0.0F)), PartPose.offsetAndRotation(0.0F, -8.0F, 2.0F, 0.0F, 0.0F, 0.7854F));',
    'PartDefinition head = body.addOrReplaceChild("head", CubeListBuilder.create().texOffs(0, 0).addBox(-4.0F, -8.0F, -4.0F, 8.0F, 8.0F, 8.0F, new CubeDeformation(0.0F))',
    ".texOffs(32, 0).addBox(-4.0F, -8.0F, -4.0F, 8.0F, 8.0F, 8.0F, new CubeDeformation(0.5F)), PartPose.offsetAndRotation(0.0F, -12.0F, 0.0F, -0.5236F, 0.0F, 0.0F));",
    'PartDefinition leg_l = body.addOrReplaceChild("leg_l", CubeListBuilder.create().texOffs(0, 16).mirror().addBox(-2.0F, 0.0F, -2.0F, 4.0F, 12.0F, 4.0F, new CubeDeformation(0.0F)).mirror(false), PartPose.offset(-2.0F, 0.0F, 0.0F));',
    'PartDefinition leg_r = body.addOrReplaceChild("leg_r", CubeListBuilder.create().texOffs(0, 16).addBox(-2.0F, 0.0F, -2.0F, 4.0F, 12.0F, 4.0F, new CubeDeformation(0.0F)), PartPose.offset(2.0F, 0.0F, 0.0F));',
    'PartDefinition bb_main = partdefinition.addOrReplaceChild("bb_main", CubeListBuilder.create().texOffs(0, 48).addBox(-2.0F, -1.0F, -2.0F, 4.0F, 1.0F, 4.0F, new CubeDeformation(0.0F)), PartPose.offset(0.0F, 24.0F, 0.0F));',
    "return LayerDefinition.create(meshdefinition, 64, 64);",
    "body.render(poseStack, vertexConsumer, packedLight, packedOverlay, red, green, blue, alpha);",
  ],
  "1.17_yarn": [
    "public class TestCreature extends EntityModel<Entity> {",
    "this.head = this.body.getChild(\"head\");",
    'ModelPartData body = modelPartData.addChild("body", ModelPartBuilder.create().uv(16, 16).cuboid(-4.0F, -12.0F, -2.0F, 8.0F, 12.0F, 4.0F, new Dilation(0.0F)), ModelTransform.pivot(0.0F, 12.0F, 0.0F));',
    'ModelPartData fin_r1 = body.addChild("fin_r1", ModelPartBuilder.create().uv(40, 16).cuboid(-1.0F, -3.0F, 0.0F, 2.0F, 3.0F, 2.0F, new Dilation(0.0F)), ModelTransform.of(0.0F, -8.0F, 2.0F, 0.0F, 0.0F, 0.7854F));',
    ".uv(32, 0).cuboid(-4.0F, -8.0F, -4.0F, 8.0F, 8.0F, 8.0F, new Dilation(0.5F)), ModelTransform.of(0.0F, -12.0F, 0.0F, -0.5236F, 0.0F, 0.0F));",
    'ModelPartData leg_l = body.addChild("leg_l", ModelPartBuilder.create().uv(0, 16).mirrored().cuboid(-2.0F, 0.0F, -2.0F, 4.0F, 12.0F, 4.0F, new Dilation(0.0F)).mirrored(false), ModelTransform.pivot(-2.0F, 0.0F, 0.0F));',
    "return TexturedModelData.of(modelData, 64, 64);",
    "bb_main.render(matrices, vertexConsumer, light, overlay, red, green, blue, alpha);",
  ],
};

describe("compileModdedEntity (port of Blockbench's modded_entity codec)", () => {
  test("lists every template Blockbench offers", () => {
    expect(MODDED_ENTITY_TEMPLATE_LIST.map((info) => [info.id, info.name])).toEqual([
      ["1.12", "Forge 1.7 - 1.13"],
      ["1.14", "Forge 1.14 (MCP)"],
      ["1.14_mojmaps", "Forge 1.14 (Mojmaps)"],
      ["1.15", "Forge 1.15 - 1.16 (MCP)"],
      ["1.15_mojmaps", "Forge 1.15 - 1.16 (Mojmaps)"],
      ["1.17", "Forge 1.17+ (Mojmaps)"],
      ["1.17_yarn", "Fabric 1.17+ (Yarn)"],
    ]);
  });

  test.each([...MODDED_ENTITY_TEMPLATE_IDS])("template %s writes the expected key lines", (template) => {
    const { code, className, notes } = compile(template);
    expect(className).toBe("TestCreature");
    expect(code.startsWith("// Made with Blockbench 5.0.0\n")).toBe(true);
    expect(code).not.toMatch(/%\(|\?\(/);
    const written = lines(code);
    EXPECTED[template].forEach((line) => expect(written).toContain(line));
    expect(notes).toEqual(['Skipped mesh "blob": Java entity models only hold cubes.']);
  });

  test("1.17 templates declare no fields or lookups for rotation subgroups; older ones do", () => {
    expect(compile("1.17").code).not.toContain("private final ModelPart fin_r1;");
    expect(compile("1.17").code).not.toContain('getChild("fin_r1")');
    expect(compile("1.17_yarn").code).not.toContain("private final ModelPart fin_r1;");
    expect(compile("1.15").code).toContain("private final ModelRenderer fin_r1;");
  });

  test("keeps Blockbench's bone order and indentation (1.12 constructor body)", () => {
    const { code } = compile("1.12");
    const body = code.slice(code.indexOf("\t\tbody = new"), code.indexOf("\n\t}\n"));
    expect(body.split("\n").slice(0, 10)).toEqual([
      "\t\tbody = new ModelRenderer(this);",
      "\t\tbody.setRotationPoint(0.0F, 12.0F, 0.0F);",
      "\t\tbody.cubeList.add(new ModelBox(body, 16, 16, -4.0F, -12.0F, -2.0F, 8, 12, 4, 0.0F, false));",
      "",
      "\t\tfin_r1 = new ModelRenderer(this);",
      "\t\tfin_r1.setRotationPoint(0.0F, -8.0F, 2.0F);",
      "\t\tbody.addChild(fin_r1);",
      "\t\tsetRotationAngle(fin_r1, 0.0F, 0.0F, 0.7854F);",
      "\t\tfin_r1.cubeList.add(new ModelBox(fin_r1, 40, 16, -1.0F, -3.0F, 0.0F, 2, 3, 2, 0.0F, false));",
      "",
    ]);
    const order = [...code.matchAll(/^\t\t(\w+) = new ModelRenderer\(this\);$/gm)].map((match) => match[1]);
    expect(order).toEqual(["body", "fin_r1", "head", "leg_l", "leg_r", "bb_main"]);
  });

  test("without flip Y, pivots and cube Y are not negated and roots get no +24", () => {
    const { code } = compileModdedEntity(riggedModel(), { template: "1.15", flipY: false });
    expect(code).toContain("body.setRotationPoint(0.0F, 12.0F, 0.0F);");
    expect(code).toContain("head.setRotationPoint(0.0F, 12.0F, 0.0F);");
    expect(code).toContain("body.setTextureOffset(16, 16).addBox(-4.0F, 0.0F, -2.0F, 8.0F, 12.0F, 4.0F, 0.0F, false);");
    expect(code).toContain("bb_main.setRotationPoint(0.0F, 0.0F, 0.0F);");
  });

  test("integer templates floor fractional sizes and say so; float templates keep them", () => {
    const doc = riggedModel();
    const withFraction = { ...doc, elements: doc.elements.map((element) => (element.uuid === "c-base" ? { ...element, to: [2.5, 1, 2] } : element)) } as IBBModel;
    const old = compile("1.12", withFraction);
    expect(old.code).toContain("bb_main.cubeList.add(new ModelBox(bb_main, 0, 48, -2.5F, -1.0F, -2.0F, 4, 1, 4, 0.0F, false));");
    expect(old.notes.some((note) => note.includes("floored: base"))).toBe(true);
    expect(compile("1.15", withFraction).code).toContain("bb_main.setTextureOffset(0, 48).addBox(-2.5F, -1.0F, -2.0F, 4.5F, 1.0F, 4.0F, 0.0F, false);");
  });

  test("cubes sharing a single-axis rotation share a subgroup only when the relevant pivot axes match", () => {
    const doc = riggedModel();
    const twin = { uuid: "c-fin2", name: "fin", type: "cube", from: [3, 20, 2], to: [4, 22, 3], origin: [5, 20, 2], rotation: [0, 0, 45], box_uv: true, uv_offset: [48, 16], faces: {} };
    const outliner = doc.outliner.map((node) => (typeof node !== "string" && node.uuid === "g-body" ? { ...node, children: [...node.children.slice(0, 2), "c-fin2", ...node.children.slice(2)] } : node));
    const { code } = compile("1.12", bbmodelSchema.parse({ ...doc, elements: [...doc.elements, twin], outliner }));
    // Z rotation: pivots may differ on Z's own axis only, so origin x=5 vs 0 splits them.
    expect(code).toContain("fin_r1.setRotationPoint(-5.0F, -8.0F, 2.0F);");
    expect(code).toContain("fin_r2.setRotationPoint(0.0F, -8.0F, 2.0F);");
  });

  test("per-face UV cubes take their box UV offset the way setUVMode derives it", () => {
    const doc = riggedModel();
    const faces = { north: { uv: [4, 4, 8, 8] }, east: { uv: [10, 20, 12, 24] }, south: { uv: [0, 0, 1, 1] }, west: { uv: [14, 20, 16, 24] }, up: { uv: [12, 20, 10, 18] }, down: { uv: [0, 0, 1, 1] } };
    const elements = doc.elements.map((element) => (element.uuid === "c-base" ? { ...element, box_uv: false, uv_offset: undefined, faces } : element));
    const { code, notes } = compile("1.15", bbmodelSchema.parse({ ...doc, elements }));
    expect(code).toContain("bb_main.setTextureOffset(10, 18).addBox(-2.0F, -1.0F, -2.0F, 4.0F, 1.0F, 4.0F, 0.0F, false);");
    expect(notes.some((note) => note.includes("converted to box UV") && note.includes("base"))).toBe(true);
  });

  test("class name follows getIdentifier: geometry name with spaces/dashes as _, then project name", () => {
    expect(compileModdedEntity(riggedModel(), { template: "1.17", modelName: "my-cool model" }).className).toBe("my_cool_model");
    const unnamed = { ...riggedModel(), model_identifier: undefined, name: "" } as IBBModel;
    expect(compileModdedEntity(unnamed, { template: "1.17" }).className).toBe("CustomModel");
    const spaced = compileModdedEntity({ ...riggedModel(), model_identifier: undefined } as IBBModel, { template: "1.17" });
    expect(spaced.className).toBe("test_creature");
    expect(spaced.notes.some((note) => note.includes('"test creature" is not a Java identifier'))).toBe(true);
  });

  test("entity class comes from the option, then the document, then Entity", () => {
    expect(compileModdedEntity(riggedModel(), { template: "1.17", entityClass: "Zombie" }).code).toContain("public class TestCreature<T extends Zombie> extends EntityModel<T> {");
    expect(compileModdedEntity({ ...riggedModel(), modded_entity_entity_class: "Pig" }, { template: "1.17_yarn" }).code).toContain("extends EntityModel<Pig> {");
  });

  test("group names are sanitised and made unique like Blockbench's bone_rig rules", () => {
    expect(sanitizeBoneName("left-arm.upper #2")).toBe("left_armupper2");
    expect(createUniqueName("arm", ["Arm"])).toBe("arm2");
    expect(createUniqueName("arm2", ["arm2"])).toBe("arm3");
    expect(createUniqueName("bone0", ["bone0"])).toBe("bone1");
    const doc = riggedModel();
    const groups = doc.groups.map((group) => (group.uuid === "g-leg-r" ? { ...group, name: "leg-l" } : group));
    const { code, notes } = compile("1.17", { ...doc, groups });
    expect(code).toContain('PartDefinition leg_l2 = body.addOrReplaceChild("leg_l2"');
    expect(notes.some((note) => note.includes('"leg-l" is exported as "leg_l2"'))).toBe(true);
  });
});
