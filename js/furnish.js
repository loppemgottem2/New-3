// =====================================================================
//  FURNISH.JS — where every piece of furniture goes, room by room.
//  Positions are in meters (each map cell is 2 m). Things placed on top of
//  something (a computer on a desk) just go after it at the same spot: the
//  prop system stacks them on whatever is already there.
//
//  Facing: chairs, swivel chairs, couches and desks all have their "back"
//  on +z, so yaw = face(dx, dz) turns the sitter to look along (dx, dz).
//
//  Rooms (inside the walls):
//   office     x 4-32   z 4-32   (carpet, bookshelf in the top-left corner)
//   cafeteria  x 44-76  z 4-32   (tile)
//   storeroom  x 88-116 z 4-32   (concrete)
//   classroom  x 4-32   z 44-76  (tile, 4 pillars)
//   courtyard  x 44-76  z 44-76  (grass, paths cross in the middle)
//   squat      x 88-116 z 44-76  (the trashed room)
//   library    x 4-32   z 88-116 (carpet, 3 rows of bookshelves)
//   warehouse  x 44-76  z 88-116 (concrete, the barrel room: lights off)
//   yard       x 88-116 z 88-116 (asphalt loading yard, outdoors)
// =====================================================================

const face = (dx, dz) => Math.atan2(-dx, -dz);
const E = face(1, 0), W = face(-1, 0), N = face(0, -1), S = face(0, 1);

// tiny deterministic random (same layout for everyone)
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

export function furnish() {
  const out = [];
  const r = rng(20240611);
  const j = (a) => (r() - 0.5) * a;               // small jitter
  const add = (type, x, z, yaw = 0, tip = false, extra = {}) => out.push({ type, x, z, yaw, tip, ...extra });
  // rotate a local offset (along the desk) into the world
  const at = (x, z, yaw, lx, lz) => [x + lx * Math.cos(yaw) + lz * Math.sin(yaw), z - lx * Math.sin(yaw) + lz * Math.cos(yaw)];

  // a workstation: desk, swivel chair, monitor, keyboard (+ maybe a pen cup); the sitter faces `yaw`'s -z
  const workstation = (x, z, yaw, { pens = r() < 0.5, chairOut = 0 } = {}) => {
    add('desk', x, z, yaw);
    const [mx, mz] = at(x, z, yaw, 0.12, -0.16); add('computer', mx, mz, yaw + j(0.15));
    const [kx, kz] = at(x, z, yaw, 0.12, 0.14); add('keyboard', kx, kz, yaw + j(0.2));
    if (pens) { const [px, pz] = at(x, z, yaw, -0.36, -0.1); add('pencup', px, pz, r() * 6); }   // on the desk top, left of the monitor
    const [cx, cz] = at(x, z, yaw, 0.1 + j(0.2), 0.72 + chairOut); add('swivelchair', cx, cz, yaw + j(0.5));
  };
  // a table with chairs on its long sides, facing it
  const tableSet = (x, z, yaw, perSide = 2, chair = 'chair') => {
    add('table', x, z, yaw);
    for (const side of [-1, 1]) for (let k = 0; k < perSide; k++) {
      const lx = perSide === 1 ? 0 : (k - (perSide - 1) / 2) * 0.62;
      const [cx, cz] = at(x, z, yaw, lx + j(0.08), side * 0.68);
      add(chair, cx, cz, yaw + (side > 0 ? 0 : Math.PI) + j(0.25));
    }
  };
  const pile = (type, x, z, n, spread = 0.35, tipChance = 0.6) => {
    for (let k = 0; k < n; k++) { const a = k * 2.4 + r(), d = k === 0 ? 0 : spread * (0.5 + r() * 0.6); add(type, x + Math.cos(a) * d, z + Math.sin(a) * d, r() * 6.28, r() < tipChance); }
  };
  const stack = (type, x, z, n, yaw = 0) => { for (let k = 0; k < n; k++) add(type, x + j(0.06), z + j(0.06), yaw + j(0.2)); };

  // ------------------------------------------------------------------ old office (carpet)
  // cleared out: a big open lounge / crash space with couches round the walls, mattresses on the floor,
  // cardboard boxes and crates left from the move, a few floor lamps
  add('couch', 9, 30.3, 0); add('crate', 9, 28.1, 0.15); add('bottle', 8.8, 28.0, 0); add('takeout', 9.3, 28.2, 0.6);
  add('couch', 5.0, 18, E); add('couch', 22, 5.2, Math.PI); add('couch', 27.2, 24, W + 0.2);
  add('mattress', 14.5, 12, 0.3); add('mattress', 20.5, 10, 1.4); add('mattress', 24.5, 16.5, 0.15); add('mattress', 12, 22.5, 2.0);
  add('mattress', 12.1, 22.6, 2.05);                                              // two stacked
  add('lamp', 5, 29.6, 0); add('lamp', 29.8, 21.8, 0); add('lamp', 16.5, 6.2, 0); add('lamp', 19.5, 19.5, 1.1, true);
  stack('box', 29.6, 6, 3); add('box', 28.6, 6.3, 0.4); add('box', 29.5, 7.2, 1.2);
  pile('box', 5.8, 25.5, 3, 0.45, 0.4); add('box', 17.5, 25, 0.7, true);
  add('crate', 28.6, 29, 0); add('crate', 29.6, 29, 0.1); add('crate', 29.1, 29, 0.05);   // little pyramid
  add('crate', 6, 9.2, 0.3); add('trashcan', 27.5, 13, 0);

  // ------------------------------------------------------------------ cafeteria (tile)
  // serving counter along the north wall, six dining tables, bins by the doors, plants
  add('longcounter', 54, 5.3, 0); add('longcounter', 58, 5.3, 0); add('shortcounter', 61, 5.3, 0);
  add('takeout', 53.3, 5.2, 0.3); add('takeout', 53.7, 5.4, 2.1); add('takeout', 56.2, 5.1, 1.0); add('bottle', 59.2, 5.3, 0); add('bottle', 59.45, 5.25, 0);
  add('trashcan', 63.2, 5.2, 0);
  for (const x of [50.5, 60, 69.5]) for (const z of [12, 23]) tableSet(x + j(0.3), z + j(0.3), j(0.1), 2);
  add('takeout', 50.3, 12, 0.5); add('takeout', 69.8, 23.1, 2.6); add('bottle', 60.2, 22.9, 0); add('takeout', 59.7, 11.9, 4.1);
  add('trashcan', 45.4, 11.8, 0); add('trashcan', 74.6, 21, 0); add('trashcan', 54.5, 30.6, 0);
  add('plant', 45.5, 5.5, 0); add('plant', 74.5, 5.5, 0); add('plant', 45.5, 30.5, 0); add('plant', 74.5, 30.5, 0);

  // ------------------------------------------------------------------ storeroom (concrete)
  // rows of long crates, boxes stacked on pallets, a few barrels and a crate pyramid
  for (const z of [11, 19, 27]) for (const x of [94.3, 98.8, 103.3, 107.8]) add('longcrate', x, z, 0);
  stack('box', 112.5, 6, 3); stack('box', 113.2, 7.2, 2); add('box', 111.4, 6.8, 0.5);
  add('crate', 112.5, 29.5, 0); add('crate', 113.5, 29.5, 0.1); add('crate', 113, 29.5, 0);
  add('barrel', 91, 6, 0); add('barrel', 91.8, 6.6, 0); add('barrel', 90.6, 30, 0, true);
  pile('box', 113, 17, 3, 0.5, 0.3);

  // ------------------------------------------------------------------ classroom (tile, pillars)
  // a formal lesson room: whiteboard + teacher's desk at the front (west wall), students' workstations
  // in three columns facing it, a lounge with couches at the back, plants in the corners
  add('whiteboard', 5.6, 60, face(1, 0) + Math.PI);
  workstation(9, 60, E, { pens: true });            // the teacher sits facing the class
  add('plant', 5.5, 45.5, 0); add('plant', 5.5, 74.5, 0);
  for (const x of [14.5, 20, 27]) for (const z of [55, 58.8, 62.6, 66.4]) workstation(x, z, W);
  add('couch', 30.9, 47.5, W); add('table', 28.9, 47.5, Math.PI / 2); add('couch', 30.9, 72.5, W); add('table', 28.9, 72.5, Math.PI / 2);
  add('plant', 30.8, 45.4, 0); add('plant', 30.8, 74.6, 0); add('plant', 12.5, 45.3, 0); add('plant', 21.5, 45.3, 0);
  add('trashcan', 7, 46, 0); add('lamp', 30.8, 69.8, 0);

  // ------------------------------------------------------------------ courtyard (grass)
  // four picnic tables on the grass, planters by the path ends, bins near the crossing
  for (const [x, z] of [[51, 51], [69, 51], [51, 69], [69, 69]]) tableSet(x, z, j(0.4), 2);
  for (const [x, z] of [[54.8, 45.5], [65.2, 45.5], [54.8, 74.5], [65.2, 74.5], [45.5, 54.8], [45.5, 65.2], [74.5, 54.8], [74.5, 65.2]]) add('plant', x, z, r() * 6);
  add('trashcan', 56.5, 55.5, 0); add('trashcan', 63.5, 64.5, 0);

  // ------------------------------------------------------------------ squat (trashed room)
  // someone's been living here: beds in the corner (with the creepy doll), an old couch around a crate,
  // a kitchenette counter, piles of bottles and trash, knocked-over stuff
  add('mattress', 112.5, 47.2, 0); add('mattress', 112.6, 47.3, 0.08); add('mattress', 112.4, 50.2, 0.05);
  add('babydoll', 112.7, 50.25, 0.4);
  add('couch', 113.8, 64, W); add('crate', 111.3, 64, 0.2); add('bottle', 111.2, 63.9, 0); add('bottle', 111.45, 64.1, 0); add('takeout', 111.2, 64.25, 1.3);
  add('lamp', 114.5, 67.2, 0); add('lamp', 108, 72.5, 2.1, true);
  add('longcounter', 90.2, 48.5, Math.PI / 2); add('takeout', 90.1, 47.6, 0.4); add('takeout', 90.3, 49.4, 2.0, true); add('bottle', 90.2, 48.8, 0);
  pile('bottle', 96, 70, 7); pile('bottle', 104, 47.5, 5); pile('takeout', 101, 66, 3, 0.4, 0.5);
  add('trashcan', 92, 46.5, 1.0, true); add('trashcan', 92.2, 73.8, 0); pile('box', 106, 72, 3, 0.5, 0.5);
  add('chair', 96, 62, 1.2, true); add('chair', 99.5, 65.5, 2.8); add('table', 98, 63.5, 0.4, true);
  add('mattress', 101, 55, 1.2);

  // ------------------------------------------------------------------ library (carpet, bookshelves)
  // reading tables below the shelves, a librarian's desk by the door, a reading nook with a couch
  for (const x of [10, 19]) tableSet(x, 111.5, 0, 2);
  add('lamp', 5, 110, 0);
  workstation(28.6, 93.5, W);
  add('couch', 30.6, 110, W); add('lamp', 30.8, 112.6, 0); add('plant', 30.6, 107.5, 0);
  add('plant', 5.2, 89.6, 0); add('plant', 30.8, 89.6, 0); add('plant', 5.2, 114.6, 0); add('trashcan', 27.2, 96.5, 0);
  add('box', 27.5, 107.8, 0.3); add('box', 27.5, 107.8, 0.1);

  // ------------------------------------------------------------------ warehouse (barrel room, lights off)
  // barrel storage on the east half, crates and pallets of boxes on the west half, workbenches on the
  // south wall with boxes on them; the middle (door to door) stays clear
  for (const x of [66, 68.4, 70.8, 73.2]) for (const z of [91, 93.4]) add('barrel', x + j(0.1), z + j(0.1), r());
  for (const x of [66, 68.4, 70.8, 73.2]) for (const z of [106, 108.4]) add('barrel', x + j(0.1), z + j(0.1), r());
  add('barrel', 66, 91, 0); add('barrel', 70.8, 106, 0);                      // a few stacked on top
  for (const [oz, k] of [[-0.33, 0], [0.33, 1], [0, 2]]) add('barrel', 73.5, 112.5 + oz, 0, true, { tipAxis: 'z' });
  add('crate', 48, 92, 0); add('crate', 48.95, 92, 0); add('crate', 48.5, 92, 0);   // pyramid
  add('crate', 52, 92, 0.1); add('crate', 52, 92, 0.1);                             // stack of two
  add('crate', 48, 108, 0.3); add('crate', 49.2, 109.5, 1.2, true);
  stack('box', 53, 108.5, 3); stack('box', 53.7, 109.3, 2); add('box', 52.2, 109.4, 0.4);
  add('longcounter', 50, 114.3, 0); add('longcounter', 54, 114.3, 0);
  add('box', 49, 114.3, 0.2); add('box', 50.5, 114.2, 1.0); add('crate', 54.5, 114.3, 0.1); add('bottle', 52.7, 114.4, 0);

  // ------------------------------------------------------------------ loading yard (asphalt, outdoors)
  // shipping crates along the east wall, pallets of boxes, barrels, bins by the back door
  for (const z of [92.5, 97, 101.5, 106]) add('longcrate', 113.7, z, Math.PI / 2);
  stack('box', 104, 110.5, 3); stack('box', 104.7, 111.2, 2); stack('box', 103.3, 111.3, 2);
  add('barrel', 93, 112, 0); add('barrel', 93.8, 112.6, 0); add('barrel', 92.6, 113, 0);
  for (const [oz, k] of [[-0.33, 0], [0.33, 1], [0, 2]]) add('barrel', 96.5, 113 + oz, 0, true, { tipAxis: 'z' });
  add('trashcan', 90, 91.5, 0); add('trashcan', 90, 92.6, 0); add('crate', 108, 92, 0.2); add('crate', 108, 92, 0.25);

  // ------------------------------------------------------------------ corridors
  for (const [x, z] of [[5, 35], [115, 35], [5, 81], [115, 81], [35, 5], [85, 5], [35, 115], [85, 115]]) add('plant', x, z, r() * 6);
  add('trashcan', 41, 35, 0); add('trashcan', 79, 81, 0);

  return out;
}

// rooms with their ceiling lights switched off (x0, z0, x1, z1 in meters)
export const DARK_ROOMS = [[44, 88, 76, 116]];
