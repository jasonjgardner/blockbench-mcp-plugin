/**
 * Java entity model templates for the Modded Entity exporter, copied verbatim
 * from Blockbench's `Templates` object in js/formats/java/modded_entity.ts.
 *
 * The template strings keep Blockbench's source indentation (three leading tabs
 * per continuation line). `templateText` strips them exactly like
 * `Templates.get` does (`replace(/\t\t\t/g, '')`), so generated code matches
 * Blockbench byte for byte. The strings were extracted from the source file by
 * evaluating the object literal, not retyped, so keep them in sync by
 * re-extracting rather than editing by hand.
 *
 * Placeholders: `%(name)` is a variable; a line starting with `?(flag)` is kept
 * only when the flag holds; `{?(has_mirror)...}` is kept only for mirrored
 * cubes; `%(remove_n)` joins a line onto the previous one.
 *
 * The animation templates (`AnimationTemplates`) are not ported.
 *
 * @module
 */

/** Template ids, in the order Blockbench lists them in the project dialog. */
export const MODDED_ENTITY_TEMPLATE_IDS = ["1.12", "1.14", "1.14_mojmaps", "1.15", "1.15_mojmaps", "1.17", "1.17_yarn"] as const;

/** One Modded Entity template id (Blockbench's `Project.modded_entity_version`). */
export type ModdedEntityTemplateId = (typeof MODDED_ENTITY_TEMPLATE_IDS)[number];

/** Mod loader a template targets. */
export type ModdedEntityLoader = "forge" | "fabric";

/** Name mappings a template's generated code is written against. */
export type ModdedEntityMappings = "mcp" | "mojang" | "yarn";

/**
 * One raw template, with Blockbench's field names so the port reads like the source.
 * Snippet fields are filled per bone (`field`, `bone`, `model_part`, `renderer`) or per cube (`cube`).
 */
export interface IModdedEntityTemplate {
  /** Display name shown in Blockbench's project dialog. */
  readonly name: string;
  /** Whether Blockbench treats the export as the saved state of the project. */
  readonly remember: boolean;
  /** Cube sizes are written as floored integers (old `ModelBox`/`addBox(int...)` APIs). */
  readonly integer_size: boolean;
  /** Uses 1.17+ `LayerDefinition`/`PartDefinition` instead of a mutable renderer tree. */
  readonly use_layer_definition?: boolean;
  /** Whole class file. */
  readonly file: string;
  /** Field declaration per bone. */
  readonly field: string;
  /** Constructor lookup of each baked `ModelPart` (1.17+ only). */
  readonly model_part?: string;
  /** Bone definition, with `%(cubes)` expanded from `cube`. */
  readonly bone: string;
  /** Render call per root bone. */
  readonly renderer: string;
  /** One cube (box) line. */
  readonly cube: string;
  /** Animation template family (`mojang` or `fabric`); not used by the geometry export. */
  readonly animation_template?: string;
}

/** Display metadata for one template. */
export interface IModdedEntityTemplateInfo {
  /** Template id to pass as `template`. */
  readonly id: ModdedEntityTemplateId;
  /** Blockbench's display name. */
  readonly name: string;
  /** Minecraft versions, as the template's own header comment states them. */
  readonly minecraftVersions: string;
  /** Mod loader. */
  readonly loader: ModdedEntityLoader;
  /** Name mappings. */
  readonly mappings: ModdedEntityMappings;
  /** Cube sizes are floored to integers. */
  readonly integerSize: boolean;
}

/** Raw templates keyed by id, verbatim from Blockbench. */
export const MODDED_ENTITY_TEMPLATES: Readonly<Record<ModdedEntityTemplateId, IModdedEntityTemplate>> = {
  "1.12": {
    name: "Forge 1.7 - 1.13",
    remember: true,
    integer_size: true,
    file: "// Made with Blockbench %(bb_version)\n\t\t\t// Exported for Minecraft version 1.7 - 1.12\n\t\t\t// Paste this class into your mod and generate all required imports\n\n\n\t\t\tpublic class %(identifier) extends ModelBase {\n\t\t\t\t%(fields)\n\n\t\t\t\tpublic %(identifier)() {\n\t\t\t\t\ttextureWidth = %(texture_width);\n\t\t\t\t\ttextureHeight = %(texture_height);\n\n\t\t\t\t\t%(content)\n\t\t\t\t}\n\n\t\t\t\t@Override\n\t\t\t\tpublic void render(Entity entity, float f, float f1, float f2, float f3, float f4, float f5) {\n\t\t\t\t\t%(renderers)\n\t\t\t\t}\n\n\t\t\t\tpublic void setRotationAngle(ModelRenderer modelRenderer, float x, float y, float z) {\n\t\t\t\t\tmodelRenderer.rotateAngleX = x;\n\t\t\t\t\tmodelRenderer.rotateAngleY = y;\n\t\t\t\t\tmodelRenderer.rotateAngleZ = z;\n\t\t\t\t}\n\t\t\t}",
    field: "private final ModelRenderer %(bone);",
    bone: "%(bone) = new ModelRenderer(this);\n\t\t\t%(bone).setRotationPoint(%(x), %(y), %(z));\n\t\t\t?(has_parent)%(parent).addChild(%(bone));\n\t\t\t?(has_rotation)setRotationAngle(%(bone), %(rx), %(ry), %(rz));\n\t\t\t%(cubes)",
    renderer: "%(bone).render(f5);",
    cube: "%(bone).cubeList.add(new ModelBox(%(bone), %(uv_x), %(uv_y), %(x), %(y), %(z), %(dx), %(dy), %(dz), %(inflate), %(mirror)));",
  },
  "1.14": {
    name: "Forge 1.14 (MCP)",
    remember: true,
    integer_size: true,
    file: "// Made with Blockbench %(bb_version)\n\t\t\t// Exported for Minecraft version 1.14 with MCP mappings\n\t\t\t// Paste this class into your mod and generate all required imports\n\n\n\t\t\tpublic class %(identifier) extends EntityModel {\n\t\t\t\t%(fields)\n\n\t\t\t\tpublic %(identifier)() {\n\t\t\t\t\ttextureWidth = %(texture_width);\n\t\t\t\t\ttextureHeight = %(texture_height);\n\n\t\t\t\t\t%(content)\n\t\t\t\t}\n\n\t\t\t\t@Override\n\t\t\t\tpublic void render(Entity entity, float f, float f1, float f2, float f3, float f4, float f5) {\n\t\t\t\t\t%(renderers)\n\t\t\t\t}\n\n\t\t\t\tpublic void setRotationAngle(RendererModel modelRenderer, float x, float y, float z) {\n\t\t\t\t\tmodelRenderer.rotateAngleX = x;\n\t\t\t\t\tmodelRenderer.rotateAngleY = y;\n\t\t\t\t\tmodelRenderer.rotateAngleZ = z;\n\t\t\t\t}\n\t\t\t}",
    field: "private final RendererModel %(bone);",
    bone: "%(bone) = new RendererModel(this);\n\t\t\t%(bone).setRotationPoint(%(x), %(y), %(z));\n\t\t\t?(has_parent)%(parent).addChild(%(bone));\n\t\t\t?(has_rotation)setRotationAngle(%(bone), %(rx), %(ry), %(rz));\n\t\t\t%(cubes)",
    renderer: "%(bone).render(f5);",
    cube: "%(bone).cubeList.add(new ModelBox(%(bone), %(uv_x), %(uv_y), %(x), %(y), %(z), %(dx), %(dy), %(dz), %(inflate), %(mirror)));",
  },
  "1.14_mojmaps": {
    name: "Forge 1.14 (Mojmaps)",
    remember: false,
    integer_size: true,
    file: "// Made with Blockbench %(bb_version)\n\t\t\t// Exported for Minecraft version 1.14 with Mojang mappings\n\t\t\t// Paste this class into your mod and generate all required imports\n\n\n\t\t\tpublic class %(identifier) extends EntityModel {\n\t\t\t\t%(fields)\n\n\t\t\t\tpublic %(identifier)() {\n\t\t\t\t\ttexWidth = %(texture_width);\n\t\t\t\t\ttexHeight = %(texture_height);\n\n\t\t\t\t\t%(content)\n\t\t\t\t}\n\n\t\t\t\t@Override\n\t\t\t\tpublic void render(Entity entity, float f, float f1, float f2, float f3, float f4, float f5) {\n\t\t\t\t\t%(renderers)\n\t\t\t\t}\n\n\t\t\t\tpublic void setRotationAngle(RendererModel modelRenderer, float x, float y, float z) {\n\t\t\t\t\tmodelRenderer.xRot = x;\n\t\t\t\t\tmodelRenderer.yRot = y;\n\t\t\t\t\tmodelRenderer.zRot = z;\n\t\t\t\t}\n\t\t\t}",
    field: "private final RendererModel %(bone);",
    bone: "%(bone) = new RendererModel(this);\n\t\t\t%(bone).setPos(%(x), %(y), %(z));\n\t\t\t?(has_parent)%(parent).addChild(%(bone));\n\t\t\t?(has_rotation)setRotationAngle(%(bone), %(rx), %(ry), %(rz));\n\t\t\t%(cubes)",
    renderer: "%(bone).render(f5);",
    cube: "%(bone).cubes.add(new ModelBox(%(bone), %(uv_x), %(uv_y), %(x), %(y), %(z), %(dx), %(dy), %(dz), %(inflate), %(mirror)));",
  },
  "1.15": {
    name: "Forge 1.15 - 1.16 (MCP)",
    remember: true,
    integer_size: false,
    file: "// Made with Blockbench %(bb_version)\n\t\t\t// Exported for Minecraft version 1.15 - 1.16 with MCP mappings\n\t\t\t// Paste this class into your mod and generate all required imports\n\n\n\t\t\tpublic class %(identifier) extends EntityModel<Entity> {\n\t\t\t\t%(fields)\n\n\t\t\t\tpublic %(identifier)() {\n\t\t\t\t\ttextureWidth = %(texture_width);\n\t\t\t\t\ttextureHeight = %(texture_height);\n\n\t\t\t\t\t%(content)\n\t\t\t\t}\n\n\t\t\t\t@Override\n\t\t\t\tpublic void setRotationAngles(Entity entity, float limbSwing, float limbSwingAmount, float ageInTicks, float netHeadYaw, float headPitch){\n\t\t\t\t\t//previously the render function, render code was moved to a method below\n\t\t\t\t}\n\n\t\t\t\t@Override\n\t\t\t\tpublic void render(MatrixStack matrixStack, IVertexBuilder buffer, int packedLight, int packedOverlay, float red, float green, float blue, float alpha){\n\t\t\t\t\t%(renderers)\n\t\t\t\t}\n\n\t\t\t\tpublic void setRotationAngle(ModelRenderer modelRenderer, float x, float y, float z) {\n\t\t\t\t\tmodelRenderer.rotateAngleX = x;\n\t\t\t\t\tmodelRenderer.rotateAngleY = y;\n\t\t\t\t\tmodelRenderer.rotateAngleZ = z;\n\t\t\t\t}\n\t\t\t}",
    field: "private final ModelRenderer %(bone);",
    bone: "%(bone) = new ModelRenderer(this);\n\t\t\t%(bone).setRotationPoint(%(x), %(y), %(z));\n\t\t\t?(has_parent)%(parent).addChild(%(bone));\n\t\t\t?(has_rotation)setRotationAngle(%(bone), %(rx), %(ry), %(rz));\n\t\t\t%(cubes)",
    renderer: "%(bone).render(matrixStack, buffer, packedLight, packedOverlay, red, green, blue, alpha);",
    cube: "%(bone).setTextureOffset(%(uv_x), %(uv_y)).addBox(%(x), %(y), %(z), %(dx), %(dy), %(dz), %(inflate), %(mirror));",
  },
  "1.15_mojmaps": {
    name: "Forge 1.15 - 1.16 (Mojmaps)",
    remember: false,
    integer_size: false,
    file: "// Made with Blockbench %(bb_version)\n\t\t\t// Exported for Minecraft version 1.15 - 1.16 with Mojang mappings\n\t\t\t// Paste this class into your mod and generate all required imports\n\n\n\t\t\tpublic class %(identifier) extends EntityModel<Entity> {\n\t\t\t\t%(fields)\n\n\t\t\t\tpublic %(identifier)() {\n\t\t\t\t\ttexWidth = %(texture_width);\n\t\t\t\t\ttexHeight = %(texture_height);\n\n\t\t\t\t\t%(content)\n\t\t\t\t}\n\n\t\t\t\t@Override\n\t\t\t\tpublic void setupAnim(Entity entity, float limbSwing, float limbSwingAmount, float ageInTicks, float netHeadYaw, float headPitch){\n\t\t\t\t\t//previously the render function, render code was moved to a method below\n\t\t\t\t}\n\n\t\t\t\t@Override\n\t\t\t\tpublic void renderToBuffer(MatrixStack matrixStack, IVertexBuilder buffer, int packedLight, int packedOverlay, float red, float green, float blue, float alpha){\n\t\t\t\t\t%(renderers)\n\t\t\t\t}\n\n\t\t\t\tpublic void setRotationAngle(ModelRenderer modelRenderer, float x, float y, float z) {\n\t\t\t\t\tmodelRenderer.xRot = x;\n\t\t\t\t\tmodelRenderer.yRot = y;\n\t\t\t\t\tmodelRenderer.zRot = z;\n\t\t\t\t}\n\t\t\t}",
    field: "private final ModelRenderer %(bone);",
    bone: "%(bone) = new ModelRenderer(this);\n\t\t\t%(bone).setPos(%(x), %(y), %(z));\n\t\t\t?(has_parent)%(parent).addChild(%(bone));\n\t\t\t?(has_rotation)setRotationAngle(%(bone), %(rx), %(ry), %(rz));\n\t\t\t%(cubes)",
    renderer: "%(bone).render(matrixStack, buffer, packedLight, packedOverlay, red, green, blue, alpha);",
    cube: "%(bone).texOffs(%(uv_x), %(uv_y)).addBox(%(x), %(y), %(z), %(dx), %(dy), %(dz), %(inflate), %(mirror));",
  },
  "1.17": {
    name: "Forge 1.17+ (Mojmaps)",
    remember: false,
    integer_size: false,
    use_layer_definition: true,
    file: "// Made with Blockbench %(bb_version)\n\t\t\t// Exported for Minecraft version 1.17 or later with Mojang mappings\n\t\t\t// Paste this class into your mod and generate all required imports\n\n\n\t\t\tpublic class %(identifier)<T extends %(entity)> extends EntityModel<T> {\n\t\t\t\t// This layer location should be baked with EntityRendererProvider.Context in the entity renderer and passed into this model's constructor\n\t\t\t\tpublic static final ModelLayerLocation LAYER_LOCATION = new ModelLayerLocation(new ResourceLocation(\"modid\", \"%(identifier_rl)\"), \"main\");\n\t\t\t\t%(fields)\n\n\t\t\t\tpublic %(identifier)(ModelPart root) {\n\t\t\t\t\t%(model_parts)\n\t\t\t\t}\n\n\t\t\t\tpublic static LayerDefinition createBodyLayer() {\n\t\t\t\t\tMeshDefinition meshdefinition = new MeshDefinition();\n\t\t\t\t\tPartDefinition partdefinition = meshdefinition.getRoot();\n\n\t\t\t\t\t%(content)\n\n\t\t\t\t\treturn LayerDefinition.create(meshdefinition, %(texture_width), %(texture_height));\n\t\t\t\t}\n\n\t\t\t\t@Override\n\t\t\t\tpublic void setupAnim(%(entity) entity, float limbSwing, float limbSwingAmount, float ageInTicks, float netHeadYaw, float headPitch) {\n\n\t\t\t\t}\n\n\t\t\t\t@Override\n\t\t\t\tpublic void renderToBuffer(PoseStack poseStack, VertexConsumer vertexConsumer, int packedLight, int packedOverlay, float red, float green, float blue, float alpha) {\n\t\t\t\t\t%(renderers)\n\t\t\t\t}\n\t\t\t}",
    field: "private final ModelPart %(bone);",
    model_part: "?(has_no_parent)this.%(bone) = root.getChild(\"%(bone)\");\n\t\t\t?(has_parent)this.%(bone) = this.%(parent).getChild(\"%(bone)\");",
    bone: "?(has_no_parent)PartDefinition %(bone) = partdefinition.addOrReplaceChild(\"%(bone)\", CubeListBuilder.create()\n\t\t\t?(has_parent)PartDefinition %(bone) = %(parent).addOrReplaceChild(\"%(bone)\", CubeListBuilder.create()\n\t\t\t%(remove_n)%(cubes)\n\t\t\t?(has_rotation)%(remove_n), PartPose.offsetAndRotation(%(x), %(y), %(z), %(rx), %(ry), %(rz)));\n\t\t\t?(has_no_rotation)%(remove_n), PartPose.offset(%(x), %(y), %(z)));",
    renderer: "%(bone).render(poseStack, vertexConsumer, packedLight, packedOverlay, red, green, blue, alpha);",
    cube: ".texOffs(%(uv_x), %(uv_y)){?(has_mirror).mirror()}.addBox(%(x), %(y), %(z), %(dx), %(dy), %(dz), new CubeDeformation(%(inflate))){?(has_mirror).mirror(false)}",
    animation_template: "mojang",
  },
  "1.17_yarn": {
    name: "Fabric 1.17+ (Yarn)",
    remember: false,
    integer_size: false,
    file: "// Made with Blockbench %(bb_version)\n\t\t\t// Exported for Minecraft version 1.17+ for Yarn\n\t\t\t// Paste this class into your mod and generate all required imports\n\t\t\tpublic class %(identifier) extends EntityModel<%(entity)> {\n\t\t\t\t%(fields)\n\t\t\t\tpublic %(identifier)(ModelPart root) {\n\t\t\t\t\t%(model_parts)\n\t\t\t\t}\n\t\t\t\tpublic static TexturedModelData getTexturedModelData() {\n\t\t\t\t\tModelData modelData = new ModelData();\n\t\t\t\t\tModelPartData modelPartData = modelData.getRoot();\n\t\t\t\t\t%(content)\n\t\t\t\t\treturn TexturedModelData.of(modelData, %(texture_width), %(texture_height));\n\t\t\t\t}\n\t\t\t\t@Override\n\t\t\t\tpublic void setAngles(%(entity) entity, float limbSwing, float limbSwingAmount, float ageInTicks, float netHeadYaw, float headPitch) {\n\t\t\t\t}\n\t\t\t\t@Override\n\t\t\t\tpublic void render(MatrixStack matrices, VertexConsumer vertexConsumer, int light, int overlay, float red, float green, float blue, float alpha) {\n\t\t\t\t\t%(renderers)\n\t\t\t\t}\n\t\t\t}",
    field: "private final ModelPart %(bone);",
    model_part: "?(has_no_parent)this.%(bone) = root.getChild(\"%(bone)\");\n\t\t\t\t\t?(has_parent)this.%(bone) = this.%(parent).getChild(\"%(bone)\");",
    bone: "?(has_no_parent)ModelPartData %(bone) = modelPartData.addChild(\"%(bone)\", ModelPartBuilder.create()\n\t\t\t?(has_parent)ModelPartData %(bone) = %(parent).addChild(\"%(bone)\", ModelPartBuilder.create()\n\t\t\t%(remove_n)%(cubes)\n\t\t\t?(has_rotation)%(remove_n), ModelTransform.of(%(x), %(y), %(z), %(rx), %(ry), %(rz)));\n\t\t\t?(has_no_rotation)%(remove_n), ModelTransform.pivot(%(x), %(y), %(z)));",
    renderer: "%(bone).render(matrices, vertexConsumer, light, overlay, red, green, blue, alpha);",
    cube: ".uv(%(uv_x), %(uv_y)){?(has_mirror).mirrored()}.cuboid(%(x), %(y), %(z), %(dx), %(dy), %(dz), new Dilation(%(inflate))){?(has_mirror).mirrored(false)}",
    animation_template: "fabric",
  },
};

/** Metadata for every template, in Blockbench's order. */
export const MODDED_ENTITY_TEMPLATE_LIST: readonly IModdedEntityTemplateInfo[] = [
  { id: "1.12", name: MODDED_ENTITY_TEMPLATES["1.12"].name, minecraftVersions: "1.7 - 1.12", loader: "forge", mappings: "mcp", integerSize: true },
  { id: "1.14", name: MODDED_ENTITY_TEMPLATES["1.14"].name, minecraftVersions: "1.14", loader: "forge", mappings: "mcp", integerSize: true },
  { id: "1.14_mojmaps", name: MODDED_ENTITY_TEMPLATES["1.14_mojmaps"].name, minecraftVersions: "1.14", loader: "forge", mappings: "mojang", integerSize: true },
  { id: "1.15", name: MODDED_ENTITY_TEMPLATES["1.15"].name, minecraftVersions: "1.15 - 1.16", loader: "forge", mappings: "mcp", integerSize: false },
  { id: "1.15_mojmaps", name: MODDED_ENTITY_TEMPLATES["1.15_mojmaps"].name, minecraftVersions: "1.15 - 1.16", loader: "forge", mappings: "mojang", integerSize: false },
  { id: "1.17", name: MODDED_ENTITY_TEMPLATES["1.17"].name, minecraftVersions: "1.17+", loader: "forge", mappings: "mojang", integerSize: false },
  { id: "1.17_yarn", name: MODDED_ENTITY_TEMPLATES["1.17_yarn"].name, minecraftVersions: "1.17+", loader: "fabric", mappings: "yarn", integerSize: false },
];

/** Blockbench's default template for new Modded Entity projects (`modded_entity_version` default). */
export const DEFAULT_MODDED_ENTITY_TEMPLATE: ModdedEntityTemplateId = "1.17";

const SOURCE_INDENT = /\t\t\t/g;

/**
 * A template field with Blockbench's source indentation removed.
 * Port of `Templates.get(key, version)`.
 *
 * @returns `undefined` when the template has no such field (such as `model_part` before 1.17).
 */
export function templateText(id: ModdedEntityTemplateId, key: "file" | "field" | "model_part" | "bone" | "renderer" | "cube"): string | undefined {
  return MODDED_ENTITY_TEMPLATES[id][key]?.replace(SOURCE_INDENT, "");
}

/** Whether `value` is a known template id. */
export function isModdedEntityTemplateId(value: string): value is ModdedEntityTemplateId {
  return (MODDED_ENTITY_TEMPLATE_IDS as readonly string[]).includes(value);
}
