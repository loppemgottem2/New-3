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
  // Hidden things are re-checked first, every frame, so they pop back in right away when they come into
  // view; visible things are re-checked a few times a second (a little late hiding costs nothing).
  apply(cam, items) {
    const now = performance.now();
    let budget = 260;                 // objects tested per frame
    const stale = [];
    for (const it of items) {
      const d = Math.hypot(it.x - cam.x, it.z - cam.z);
      it._d = d;
      if (d < it.r + 3) { it.set(true); const e = this.cache.get(it.obj); if (e) e.vis = true; continue; }   // right next to the camera
      let e = this.cache.get(it.obj);
      if (!e) { e = { t: -1e9, vis: true }; this.cache.set(it.obj, e); }
      if (now - e.t > (e.vis ? 220 : 0)) stale.push(it);
      it.set(e.vis);
    }
    stale.sort((a, b) => (this.cache.get(a.obj).vis - this.cache.get(b.obj).vis) || (this.cache.get(a.obj).t - this.cache.get(b.obj).t));
    for (const it of stale) {
      if (budget-- <= 0) break;
      const e = this.cache.get(it.obj);
      e.t = now; e.vis = this.visible(cam, it, it._d);
      it.set(e.vis);
    }
  }

  // can the camera see any of: the middle, the top, or the left / right edges of the object?
  visible(cam, it, d) {
    const map = this.map;
    const px = -(it.z - cam.z) / (d || 1), pz = (it.x - cam.x) / (d || 1);     // sideways, across the view
    // a slightly bigger outline than the object, so it reappears just before any of it can be seen
    const r = it.r * 1.25 + 0.15, top = it.y + Math.max(0.1, it.h) + 0.1, mid = it.y + it.h * 0.5, low = it.y + 0.08;
    const pts = [[it.x, mid, it.z], [it.x, top, it.z], [it.x + px * r, mid, it.z + pz * r], [it.x - px * r, mid, it.z - pz * r],
      [it.x + px * r, top, it.z + pz * r], [it.x - px * r, top, it.z - pz * r], [it.x + px * r, low, it.z + pz * r], [it.x - px * r, low, it.z - pz * r]];
    for (const [x, y, z] of pts) {
      const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z, L = Math.hypot(dx, dy, dz) || 1e-6;
      if (map.ray(cam.x, cam.y, cam.z, dx / L, dy / L, dz / L, L) >= L - 0.15) return true;
    }
    return false;
  }
}
