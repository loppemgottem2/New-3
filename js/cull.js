// =====================================================================
//  CULL.JS — don't draw things hidden behind walls.
//  The renderer already skips what's outside the camera's view. This also skips furniture, people and
//  marks that ARE in view but completely behind walls / floors / ceilings: rays from the camera to
//  points all over the object go through the level grid; if every ray is blocked, it isn't drawn.
//
//  Cheap + no pop-in:
//   - things outside the view are never ray-tested; they count as visible, so turning around can never
//     make something pop in (the renderer skips them anyway while they're off screen)
//   - hidden things in view are re-tested every frame, so they come back the moment any part shows
//   - visible things are re-tested a few times a second (hiding a bit late costs nothing)
// =====================================================================

const OUTLINE = [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];

export class Culler {
  constructor(map) {
    this.map = map;
    this.cache = new WeakMap();      // object -> { t, vis }
    this.stale = [];
  }

  // items: [{ obj, x, y, z, r, h, set(visible), low? }] (y = bottom; low = low priority, e.g. marks)
  // cam: ray origin; fwd: camera forward (unit); halfFov: half of the widest view angle (radians)
  apply(cam, items, fwd, halfFov) {
    const now = performance.now();
    const stale = this.stale; stale.length = 0;
    for (const it of items) {
      const dx = it.x - cam.x, dy = it.y + it.h * 0.5 - cam.y, dz = it.z - cam.z;
      const d = Math.hypot(dx, dy, dz) || 1e-6;
      let e = this.cache.get(it.obj);
      if (!e) { e = { t: -1e9, vis: true }; this.cache.set(it.obj, e); }
      // right next to the camera, or outside the view: drawn (no rays)
      const ang = fwd ? Math.acos(Math.max(-1, Math.min(1, (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d))) : 0;
      if (d < it.r + 3 || (fwd && ang > halfFov + Math.atan2(it.r + 0.5, d) + 0.15)) { e.vis = true; e.t = now; it.set(true); continue; }
      if (now - e.t > (e.vis ? 220 : 0)) { it._p = (e.vis ? 2 : 0) + (it.low ? 1 : 0); stale.push(it); }
      it.set(e.vis);
    }
    // hidden things first (props / people before marks), then visible ones, until the ray budget is used
    stale.sort((a, b) => a._p - b._p);
    let rays = 2600;
    for (const it of stale) {
      if (rays <= 0) break;
      const e = this.cache.get(it.obj);
      const res = this.visible(cam, it);
      rays -= res[1]; e.t = now; e.vis = res[0];
      it.set(e.vis);
    }
  }

  // Can the camera see any part of the object? Rays go to its middle and top, and to the corners + edge
  // midpoints of a box a bit bigger than its footprint (long crates and counters get points along their
  // whole length, so an end poking out around a corner still counts). Stops at the first clear ray.
  visible(cam, it) {
    const map = this.map;
    let used = 0;
    const test = (x, y, z) => {
      used++;
      const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z, L = Math.hypot(dx, dy, dz) || 1e-6;
      return map.ray(cam.x, cam.y, cam.z, dx / L, dy / L, dz / L, L) >= L - 0.15;
    };
    const top = it.y + Math.max(0.1, it.h) + 0.1, mid = it.y + it.h * 0.5;
    if (test(it.x, mid, it.z) || test(it.x, top, it.z)) return [true, used];
    if (it.low) {                      // small flat things (marks): a few points are plenty
      for (let k = 0; k < 4; k++) if (test(it.x + OUTLINE[k][0] * it.r, mid, it.z + OUTLINE[k][1] * it.r)) return [true, used];
      return [false, used];
    }
    const r = it.r * 1.1 + 0.15;
    for (const [ox, oz] of OUTLINE) {
      const x = it.x + ox * r, z = it.z + oz * r;
      if (test(x, mid, z) || test(x, top, z)) return [true, used];
    }
    return [false, used];
  }
}
