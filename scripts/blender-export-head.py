# scripts/blender-export-head.py
#
# Crops a MakeHuman/MPFB2 figure down to the head and writes the GLB that
# `scripts/bake-head.ts` consumes. Run from Blender's Scripting workspace.
#
# The bake reads POSITION, NORMAL, indices and MORPH TARGETS — nothing else.
# Materials, textures and UVs are dead weight, so they are deliberately not
# exported. Morph targets are NOT optional: MPFB2 stores every modelling
# slider as a weighted morph target, so a GLB without them bakes the neutral
# androgynous basemesh instead of the character.

import bpy

CUT = 0.84  # keep the top 16% of the BODY — raise toward 0.88 for less shoulder
OUT = "/Users/tony/Documents/GitHub/mymind/assets/source/bridget-head.glb"


def log(msg):
    print(f"[export-head] {msg}")


# ---------------------------------------------------------------------------
# 1. Make everything visible, included and selectable.
#
# This is why hair and eyebrows went missing. `select_set(True)` silently
# no-ops on an object that is hidden, unselectable, or in a view-layer
# collection that is excluded — no error, no warning, it just doesn't select.
# The object then isn't part of the join and vanishes from the export. MPFB2
# files assets into sub-collections, so this bites easily.
# ---------------------------------------------------------------------------
def include_all(layer_collection, is_root=False):
    # The master (root) layer collection's `exclude` is read-only — setting it
    # raises. Only its children can be excluded, so skip it at the top.
    if not is_root:
        layer_collection.exclude = False
    layer_collection.hide_viewport = False
    if layer_collection.collection:
        layer_collection.collection.hide_viewport = False
        layer_collection.collection.hide_select = False
    for child in layer_collection.children:
        include_all(child)


include_all(bpy.context.view_layer.layer_collection, is_root=True)

if bpy.context.object and bpy.context.object.mode != 'OBJECT':
    bpy.ops.object.mode_set(mode='OBJECT')

for o in bpy.context.scene.objects:
    o.hide_viewport = False
    o.hide_select = False
    o.hide_render = False
    try:
        o.hide_set(False)  # per-view-layer visibility (the eye icon)
    except RuntimeError:
        pass  # not in this view layer

# ---------------------------------------------------------------------------
# 2. Convert non-mesh geometry. Hair is frequently a Curve, which never
#    appears in a `type == 'MESH'` filter and so was never even a candidate.
# ---------------------------------------------------------------------------
CONVERTIBLE = {'CURVE', 'SURFACE', 'FONT', 'META'}
for o in list(bpy.context.scene.objects):
    if o.type in CONVERTIBLE:
        log(f"converting {o.name} ({o.type}) -> MESH")
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.convert(target='MESH')

# Particle-system hair is not real geometry and cannot be joined. Say so loudly
# rather than exporting a bald head and leaving you to wonder why.
for o in bpy.context.scene.objects:
    if o.type == 'MESH' and o.particle_systems:
        names = ", ".join(p.name for p in o.particle_systems)
        log(f"WARNING: {o.name} has particle system(s) [{names}] — these are NOT")
        log("         exportable geometry. Convert them first, or use a mesh hair asset.")

# ---------------------------------------------------------------------------
# 3. Inventory. Print what we found BEFORE touching anything, so a missing
#    asset is obvious here rather than three steps later.
# ---------------------------------------------------------------------------
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError("no mesh objects in the scene")

log(f"found {len(meshes)} mesh object(s):")
for o in meshes:
    keys = len(o.data.shape_keys.key_blocks) if o.data.shape_keys else 0
    mods = ", ".join(m.type for m in o.modifiers) or "-"
    log(f"    {o.name:<28} verts={len(o.data.vertices):>6}  shapekeys={keys:>3}  modifiers={mods}")

# ---------------------------------------------------------------------------
# 4. Pick the join target deliberately.
#
# `meshes[0]` was whatever the scene happened to list first. Joining INTO an
# asset with no shape keys risks the body's modelling targets, which are the
# whole point of the export. Join into the object carrying the most shape keys
# (ties broken by vertex count) — that's the body.
# ---------------------------------------------------------------------------
def shape_key_count(o):
    return len(o.data.shape_keys.key_blocks) if o.data.shape_keys else 0


body = max(meshes, key=lambda o: (shape_key_count(o), len(o.data.vertices)))
log(f"join target: {body.name} ({shape_key_count(body)} shape keys)")

# ---------------------------------------------------------------------------
# 5. Compute the cut height from the BODY ALONE, before joining.
#
# Doing it after the join made the cut depend on the assets: hair sits above
# the skull, so including it raised the bounding box, and the same CUT fraction
# then sliced lower down the body. Measuring the body first keeps CUT meaning
# the same thing no matter which assets are present.
# ---------------------------------------------------------------------------
zs = [(body.matrix_world @ v.co).z for v in body.data.vertices]
cut_z = min(zs) + (max(zs) - min(zs)) * CUT
log(f"body z range {min(zs):.3f} .. {max(zs):.3f}  ->  cut at z={cut_z:.3f}")

# ---------------------------------------------------------------------------
# 6. Join everything into the body.
# ---------------------------------------------------------------------------
bpy.ops.object.select_all(action='DESELECT')
selected = []
for o in meshes:
    o.select_set(True)
    if o.select_get():
        selected.append(o.name)
    else:
        log(f"WARNING: {o.name} refused selection and will NOT be exported")
bpy.context.view_layer.objects.active = body

if len(selected) > 1:
    bpy.ops.object.join()
obj = bpy.context.active_object
log(f"joined {len(selected)} object(s) -> {obj.name}: {len(obj.data.vertices)} verts, "
    f"{shape_key_count(obj)} shape keys")

# ---------------------------------------------------------------------------
# 7. Delete everything below the cut.
# ---------------------------------------------------------------------------
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='DESELECT')
bpy.ops.object.mode_set(mode='OBJECT')
for v in obj.data.vertices:
    v.select = (obj.matrix_world @ v.co).z < cut_z
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.delete(type='VERT')
bpy.ops.object.mode_set(mode='OBJECT')

log(f"kept above z={cut_z:.3f}; {len(obj.data.vertices)} verts remain, "
    f"{shape_key_count(obj)} shape keys survive")

# ---------------------------------------------------------------------------
# 8. Export.
#
# The original script defined OUT and never used it, so the export was done by
# hand through the file dialog — where "Shape Keys" lives inside a collapsed
# "Data" section and is easy to miss. Scripting it removes that failure mode.
#
# export_apply MUST stay False: applying modifiers destroys shape keys, and
# the shape keys are the character.
# ---------------------------------------------------------------------------
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.context.view_layer.objects.active = obj

wanted = dict(
    filepath=OUT,
    export_format='GLB',
    use_selection=True,
    export_yup=True,            # glTF convention; the baker assumes it
    export_apply=False,         # applying modifiers would destroy the shape keys
    export_normals=True,
    export_morph=True,          # the modelling targets — without these it's the basemesh
    export_morph_normal=False,  # the baker derives normals; this halves the file
    export_morph_tangent=False,
    export_skins=False,
    export_animations=False,
    export_materials='NONE',    # we render points, not surfaces
    export_texcoords=False,
    export_cameras=False,
    export_lights=False,
    export_extras=False,
)

# Keep only the arguments this Blender's exporter actually declares, so a
# renamed flag in a future version degrades instead of raising.
valid = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
kwargs = {k: v for k, v in wanted.items() if k in valid}
dropped = sorted(set(wanted) - set(kwargs))
if dropped:
    log(f"WARNING: this Blender ignores these export flags: {dropped}")

bpy.ops.export_scene.gltf(**kwargs)
log(f"wrote {OUT}")
log("next: pnpm bake:head")
