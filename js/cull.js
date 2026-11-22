// =====================================================================
//  CULL.JS — don't draw things hidden behind walls.
//  The renderer already skips what's outside the camera's view. This also skips furniture and people
//  that are in front of the camera but completely behind walls / floors / ceilings: a few rays from the
//  camera to points on the object go through the level grid; if every ray is blocked, the object isn't
//  drawn. As soon as any of those points can be seen again it's drawn again.
//  Results are cached and refreshed a few at a time (each object every ~0.2 s) so it costs very little.
// =====================================================================

export class Culler {
  constructor(map) {
    this.map = map;
    this.cache = new WeakMap();      // object -> { t, vis }
  }

  // items: [{ obj, x, y, z, r, h, set(visible) }] (y = bottom). cam: the camera position.
  apply(cam, items) {
    const now = performance.now();
    let budget = 90;                  // ray tests per frame
    for (const it of items) {
      const d = Math.hypot(it.x - cam.x, it.z - cam.z);
      if (d < it.r + 2.5) { it.set(true); continue; }          // right next to the camera: always drawn
      let e = this.cache.get(it.obj);
      if (!e || (now - e.t > 200 && budget > 0)) {
        budget--;
        if (!e) { e = { t: 0, vis: true }; this.cache.set(it.obj, e); }
        e.t = now; e.vis = this.visible(cam, it, d);
      }
      it.set(e.vis);
    }
  }

  // can the camera see any of: the middle, the top, or the left / right edges of the object?
  visible(cam, it, d) {
    const map = this.map;
    const px = -(it.z - cam.z) / (d || 1), pz = (it.x - cam.x) / (d || 1);     // sideways, across the view
    const r = it.r * 0.9, top = it.y + Math.max(0.1, it.h), mid = it.y + it.h * 0.5;
    const pts = [[it.x, mid, it.z], [it.x, top, it.z], [it.x + px * r, mid, it.z + pz * r], [it.x - px * r, mid, it.z - pz * r], [it.x + px * r, top, it.z + pz * r], [it.x - px * r, top, it.z - pz * r]];
    for (const [x, y, z] of pts) {
      const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z, L = Math.hypot(dx, dy, dz) || 1e-6;
      if (map.ray(cam.x, cam.y, cam.z, dx / L, dy / L, dz / L, L) >= L - 0.15) return true;
    }
    return false;
  }
}
