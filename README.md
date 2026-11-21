# KILLER MYSTERY

A multiplayer murder-mystery game for phones and browsers, in the style of the classic sandbox-game "Murder" gamemode.
One player is secretly the **Murderer** (has a knife), one bystander secretly has a **revolver**, and everyone else must
survive, collect **gun parts**, and figure out who the killer is.

- 📱 Works on phones (touch joystick + drag to look) and computers (WASD + mouse)
- 🌐 Real online multiplayer: **public servers** (Quick Play / Server Browser) and **private servers** with a 5-letter code
- 🤖 Bots fill empty slots: A* pathfinding, line-of-sight vision, suspicion, fleeing, jumping, aiming with reaction time
- 🏢 Big 120 m map: office, cafeteria, storage, lobby, gym, library, workshop, courtyard and parking lot
- 💡 Pre-computed ("baked") lighting from every ceiling light + sun shadows + ambient occlusion + grime, and optional real-time lights
- 🪑 Real rigid-body furniture (chairs, tables, boxes, crates, barrels, mattresses, lamps, bottles) with per-part hitboxes — push it, shoot it, knock it over, stand on it
- 🧍 Character editor: name, hairstyle, face, skin, shirt and pants types/colors. Ragdolls on death
- 🔪 Murderer (stab + throw knife), 🔫 Sheriff (shooting an innocent kills the Sheriff too), 🧩 5 gun parts → build a revolver
- 🎥 First person or third person (zoom in/out), lots of settings, available mid-match from the ⚙ button
- No build step, no server to pay for — just static files

---

## ▶️ Put it online (free, you own it) — GitHub Pages

1. Make the repository **public** (Settings → General → Danger Zone → Change visibility), or use a paid plan.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**: Source = **Deploy from a branch**, Branch = the branch with this code
   (e.g. `main` after merging, or `claude/gmod-murder-mobile-qz6xxb`), folder = **/ (root)** → **Save**.
4. After ~1 minute your game is live at `https://<your-username>.github.io/<repo-name>/`.
   Send that link to friends. On a phone, use the browser's **"Add to Home Screen"** to get an app icon that opens fullscreen.

You can also put the folder on any static host (Netlify, Cloudflare Pages, itch.io as an HTML game, your own domain…).

### How multiplayer works
There is no paid game server. The player who **creates** a server becomes the **host**; their browser runs the
real game (bots, rounds, hits) and other players connect directly to them (WebRTC peer-to-peer, via the free
public [PeerJS](https://peerjs.com) matchmaking service).

- **Quick Play** joins the busiest public server, or starts a new one if none exist.
- **Server Browser** lists public servers 1–8.
- **Private Server** gives a code like `K7QXM` — friends type it in to join.
- If the **host closes the tab**, that server ends and everyone returns to the menu. Hosts: keep the tab open.
- Some strict mobile/corporate networks block peer-to-peer connections. If joining fails on mobile data, try Wi-Fi.
  (For 100% reliability you can add a TURN server to `ICE_SERVERS` in `js/config.js`.)
- Want your own private network of servers, separate from anyone else running this code? Change
  `PEER_PREFIX` in `js/config.js`.

### Test multiplayer on one computer
Open `index.html?local=1` in two tabs of the same browser. This uses a fake in-browser network so you can test hosting
and joining without internet.

### Run locally
Browsers block ES modules from `file://`, so start any static server in this folder:
```
python3 -m http.server 8000
```
then open http://localhost:8000

---

## 🎮 Controls

| | Phone | Computer |
|---|---|---|
| Move | Left thumb anywhere on left side (push to edge = sprint) | WASD / arrows |
| Look | Drag on right side (also works while holding the attack button) | Mouse (click to lock) |
| Sprint | RUN toggle or push stick to the edge | Shift |
| Jump | JUMP | Space |
| Draw / hide weapon | DRAW / HIDE | Q |
| Stab / shoot | big red button | Left click |
| Throw knife (murderer) | THROW | Right click / G |
| Zoom camera / third person | Pinch with two fingers | Mouse wheel / V |
| Settings | ⚙ | ⚙ / Esc / P |
| Scoreboard | ☰ | Tab |
| Next spectate target | ▶ | F / click |
| **X button** | ✕ top-right | X key |

**X button:** in a match → you die (ragdoll) and spectate. Press again → main menu. Press on the main menu → leave the game.

---

## 🛠️ Editing the game (all code is plain, commented JavaScript)

| File | What's in it |
|---|---|
| `js/config.js` | **Every tunable number**: speeds, jump, stamina, weapon range/cooldowns, round time, bot count, bot aim/vision/suspicion, network settings |
| `js/map.js` | **The map as ASCII art** — edit the `LAYOUT` text to redesign the level (floors `. , ; _ o a ~`, `#` wall, `P` pillar, `Q` shelf, `W` counter, furniture `B C K T X M L b`, `S` spawn, `G` gun part spot). Also the baked lighting |
| `js/props.js` | Rigid-body furniture: each prop's box hitboxes (`PROP_TYPES`), looks, physics |
| `js/game.js` | Rounds, roles, combat, gun parts, item pickups, events, camera, network messages |
| `js/bots.js` | Bot AI: perception, suspicion, flee, sheriff aiming, murderer hunting |
| `js/nav.js` | A* pathfinding grid + path smoothing |
| `js/physics.js` | Movement, gravity, jumping, wall collision, raycasts |
| `js/character.js` | Character body, hairstyles, clothing, animations, first-person arms |
| `js/ragdoll.js` | Ragdoll physics (joints + limb constraints) |
| `js/textures.js` | Procedurally drawn textures (floor grid, walls, grass, crates…) |
| `js/input.js` | Touch joystick / look / buttons, keyboard & mouse |
| `js/ui.js`, `index.html`, `css/style.css` | Menus and HUD |
| `js/net.js` | Peer-to-peer networking, public slots, private codes |
| `js/audio.js` | Synthesized sound effects |
| `js/main.js` | Startup, settings (the `SCHEMA` list — add options there), character editor, matchmaking, main loop |

Third-party libraries (MIT licensed) are bundled in `vendor/`: three.js r170 and PeerJS 1.5.4.

Tip: open the browser console and type `GMM.game` to inspect the running match.
