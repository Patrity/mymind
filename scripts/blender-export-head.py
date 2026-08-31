# scripts/blender-export-head.py
#
# Crops a MakeHuman/MPFB2 figure down to the head and writes the GLB that
# `scripts/bake-head.ts` consumes. Run from Blender's Scripting workspace.
#
# THIS SCRIPT MUTATES THE SCENE. It deletes geometry. Save your .blend first,
# and use File > Revert to get the full figure back afterwards.
#
# The bake reads POSITION, NORMAL, indices and MORPH TARGETS — nothing else.
# Materials, textures and UVs are dead weight, so they are not exported. Morph
# targets are NOT optional: MPFB2 stores every modelling slider as a weighted
# morph target, so a GLB without them bakes the neutral androgynous basemesh
# instead of the character.

import bpy

# The previous export cropped at the jaw (normalised skin span +/-1.30). This
# export kept noticeably more neck (+/-1.52), which shrinks the face in frame and
# invalidates the landmark constants in bake-head.ts. 0.88 puts the cut back at
# the jawline; lower it only if you want neck and shoulders in shot.
CUT = 0.88  # keep the top 12% of the BODY — lower toward 0.84 for more neck
OUT = "/Users/tony/Documents/GitHub/mymind/assets/source/bridget-head.glb"


def log(msg):
    print(f"[export-head] {msg}")


def shape_key_count(o):
    return len(o.data.shape_keys.key_blocks) if o.data.shape_keys else 0


# ---------------------------------------------------------------------------
# 1. Make everything visible, included and selectable.
#
# This is why hair and eyebrows went missing. `select_set(True)` silently
# no-ops on an object that is hidden, unselectable, or in a view-layer
# collection that is excluded — no error, no warning, it just doesn't select.
# MPFB2 files assets into sub-collections, so this bites easily.
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

for o in bpy.context.scene.objects:
    if o.type == 'MESH' and o.particle_systems:
        names = ", ".join(p.name for p in o.particle_systems)
        log(f"WARNING: {o.name} has particle system(s) [{names}] — these are NOT")
        log("         exportable geometry. Convert them first, or use a mesh hair asset.")

# ---------------------------------------------------------------------------
# 3. Inventory, before anything is touched.
# ---------------------------------------------------------------------------
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError("no mesh objects in the scene")

log(f"found {len(meshes)} mesh object(s):")
for o in meshes:
    mods = ", ".join(m.type for m in o.modifiers) or "-"
    log(f"    {o.name:<28} verts={len(o.data.vertices):>6}  "
        f"shapekeys={shape_key_count(o):>3}  modifiers={mods}")

# ---------------------------------------------------------------------------
# 3b. Prefer MPFB2 export copies, and delete the geometry the bake must never see.
#
# "Create export copy" leaves the ORIGINAL in the scene next to the copy, so
# exporting everything ships each piece of geometry twice.
# ---------------------------------------------------------------------------
by_name = {o.name: o for o in meshes}
superseded = [o for o in meshes
              if not o.name.endswith('_export_copy') and f"{o.name}_export_copy" in by_name]
for o in superseded:
    log(f"skipping {o.name}: superseded by {o.name}_export_copy")
meshes = [o for o in meshes if o not in superseded]

# The export copy WELDS the eyeballs, teeth and tongue into the skin. They used
# to arrive as separate connected components, which `largestShell()` in
# bake-head.ts discarded for free; once welded it cannot tell them apart, and
# the render grows bulging eye orbs and a mouth full of teeth. Delete them here,
# by vertex group, while they are still identifiable.
NON_SKIN_GROUPS = {
    'highpolyeyes', 'eyes', 'eye', 'cornea', 'sclera',
    'teeth', 'upperteeth', 'lowerteeth', 'tongue', 'gums',
    'eyelashes', 'eyebrows',
}


def is_non_skin(group_name):
    n = group_name.lower().replace('_', '').replace('-', '').replace(' ', '')
    return n in NON_SKIN_GROUPS or n.startswith('helper') or n.startswith('joint')


for o in meshes:
    groups = [g for g in o.vertex_groups if is_non_skin(g.name)]
    if not groups:
        continue
    idx = {g.index for g in groups}
    doomed = [v.index for v in o.data.vertices
              if any(ge.group in idx for ge in v.groups)]
    if not doomed:
        continue

    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    for i in doomed:
        o.data.vertices[i].select = True
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.delete(type='VERT')
    bpy.ops.object.mode_set(mode='OBJECT')
    log(f"    {o.name}: deleted {len(doomed)} verts in non-skin groups "
        f"[{', '.join(g.name for g in groups)}]")

# Print every remaining group so an unrecognised eyeball/teeth group is visible
# rather than silently rendered.
for o in meshes:
    names = sorted(g.name for g in o.vertex_groups)
    if names:
        log(f"    {o.name} vertex groups: {', '.join(names)}")

# ---------------------------------------------------------------------------
# 4. DO NOT JOIN.
#
# An earlier version joined every mesh into one object, and that mangled the
# figure: MPFB2 fits hair/eyes/brows to the body as proxies carrying their OWN
# shape keys, which mirror the body's modelling targets by name. Blender's join
# merges shape keys BY NAME, so those same-named keys collapse into one another
# with unrelated per-vertex deltas — the face tore and stretched toward the
# midline.
#
# The join was never needed anyway: `mergeSceneGeometry` in bake-head.ts already
# walks every node and primitive in the document and merges them itself, applying
# each node's world matrix as it goes. Exporting several meshes is fine.
# ---------------------------------------------------------------------------

# The body is the object carrying the most shape keys (ties -> most vertices).
body = max(meshes, key=lambda o: (shape_key_count(o), len(o.data.vertices)))
log(f"body: {body.name} ({shape_key_count(body)} shape keys)")

# ---------------------------------------------------------------------------
# 5. Cut height from the BODY ALONE.
#
# Measuring after including assets made the cut depend on them: hair sits above
# the skull, raising the bounding box, so the same CUT fraction sliced lower
# down the body. Measuring the body keeps CUT meaning one thing.
#
# `v.co` is the BASIS position, not the shape-keyed one. With modelling targets
# at non-zero weights the visible surface differs, so evaluate the object
# through the depsgraph and measure what is actually on screen.
# ---------------------------------------------------------------------------
depsgraph = bpy.context.evaluated_depsgraph_get()


def evaluated_coords(o):
    """World-space vertex coords as actually displayed (shape keys + modifiers)."""
    eval_obj = o.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    coords = [o.matrix_world @ v.co.copy() for v in mesh.vertices]
    eval_obj.to_mesh_clear()
    return coords


body_zs = [c.z for c in evaluated_coords(body)]
cut_z = min(body_zs) + (max(body_zs) - min(body_zs)) * CUT
log(f"body z range {min(body_zs):.3f} .. {max(body_zs):.3f}  ->  cut at z={cut_z:.3f}")

# ---------------------------------------------------------------------------
# 6. Crop every mesh at that height, in place, each on its own.
#
# Selection is driven by the EVALUATED position so the cut follows the surface
# you can see. Vertex order is identical between the evaluated mesh and the
# original as long as no generative modifier is active, which is the case here.
# ---------------------------------------------------------------------------
for o in meshes:
    coords = evaluated_coords(o)
    if len(coords) != len(o.data.vertices):
        log(f"    {o.name}: evaluated vert count differs "
            f"({len(coords)} vs {len(o.data.vertices)}) — a generative modifier is "
            f"active; cropping on basis positions instead")
        coords = [o.matrix_world @ v.co for v in o.data.vertices]

    doomed = [i for i, c in enumerate(coords) if c.z < cut_z]
    if not doomed:
        log(f"    {o.name}: nothing below the cut, kept whole ({len(o.data.vertices)} verts)")
        continue

    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o

    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    for i in doomed:
        o.data.vertices[i].select = True
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.delete(type='VERT')
    bpy.ops.object.mode_set(mode='OBJECT')

    log(f"    {o.name}: cut {len(doomed)} verts, {len(o.data.vertices)} remain, "
        f"{shape_key_count(o)} shape keys survive")

# Anything emptied entirely by the cut would export as a degenerate mesh.
survivors = [o for o in meshes if len(o.data.vertices) > 0]
for o in meshes:
    if o not in survivors:
        log(f"    {o.name}: emptied by the cut, excluded from the export")

# ---------------------------------------------------------------------------
# 7. Export.
#
# The original script defined OUT and never used it, so the export was done by
# hand through the file dialog — where "Shape Keys" lives inside a collapsed
# "Data" section and is easy to miss.
#
# export_apply MUST stay False: applying modifiers destroys shape keys, and the
# shape keys are the character.
# ---------------------------------------------------------------------------
bpy.ops.object.select_all(action='DESELECT')
for o in survivors:
    o.select_set(True)
    if not o.select_get():
        log(f"WARNING: {o.name} refused selection and will NOT be exported")
bpy.context.view_layer.objects.active = survivors[0]

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
log(f"wrote {OUT} ({len(survivors)} mesh object(s))")
log("next: File > Revert to restore the figure, then `pnpm bake:head`")
