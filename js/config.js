// =====================================================================
//  CONFIG.JS  —  every tunable number in the game lives here.
//  Change a value, save, refresh the page. No build step needed.
// =====================================================================

export const CONFIG = {
  VERSION: '1.0.0',
  TITLE: 'FIND THE THINGS',
  SUBTITLE: '',

  // ---------------- Server / lobby ----------------
  SERVER: {
    MAX_PLAYERS: 12,        // total characters per server (humans + bots)
    FILL_WITH_BOTS_TO: 8,   // if fewer humans than this, bots fill the gap
    MAX_HUMANS: 12,         // hard cap of real players per server
  },

  // ---------------- Round timing (seconds) ----------------
  ROUND: {
    HIDE_TIME: 30,          // props hide, seekers are blindfolded and frozen
    TIME_LIMIT: 240,        // props win if at least one survives this long
    POST_TIME: 8,           // results screen before next round
  },

  // ---------------- Teams ----------------
  TEAMS: {
    SEEKER_SHARE: 0.34,     // about a third of the players are seekers (always at least 1)
    SEEKER_HP: 100,
    PROP_HUMAN_HP: 100,     // a prop player who hasn't turned into furniture yet
    // health of a prop player disguised as each piece of furniture (bigger = tougher)
    PROP_HP: { bottle: 10, takeout: 15, babydoll: 20, box: 60, chair: 80, lamp: 80, trashcan: 100, barrel: 150, mattress: 180, crate: 220, table: 300 },
    WRONG_PROP_DAMAGE: 10,  // seekers lose this much health for shooting / stabbing real furniture
    DISGUISE_RANGE: 6,      // props can turn into furniture this close (meters)
    DISGUISE_COOLDOWN: 0.8,
  },

  // ---------------- Inventory (seekers) ----------------
  INVENTORY: {
    HOTBAR: 5,              // hotbar slots (keys 1-5)
    BACKPACK: 15,           // extra inventory slots
    START: ['knife', 'revolver', 'crowbar'], // what seekers spawn with (in the hotbar)
  },

  // ---------------- Player movement / physics ----------------
  PLAYER: {
    RADIUS: 0.32,
    HEIGHT: 1.84,
    EYE: 1.68,
    WALK_SPEED: 3.8,
    RUN_SPEED: 6.6,
    MAX_SPEED: 11,          // hard speed cap (you can build speed by jumping)
    GROUND_ACCEL: 10,       // Source-style acceleration (higher = snappier)
    FRICTION: 4,            // ground friction (lower = more sliding)
    STOP_SPEED: 1.5,
    LAND_GRACE: 0.12,       // seconds of low friction after landing (keeps momentum when chain-jumping)
    AIR_ACCEL: 14,          // air strafing strength
    AIR_WISH_CAP: 2.4,
    JUMP_BOOST: 0.55,       // extra speed added per running jump
    GRAVITY: 18,
    JUMP_SPEED: 6.4,        // jump apex = JUMP_SPEED^2 / (2*GRAVITY) ≈ 1.14 m
    STEP_HEIGHT: 0.4,       // only used for map/bot-path checks
    WALL_SLIDE: 1.2,        // props pushing into a wall slide down this slowly (m/s)
    WALL_CLIMB_MAX: 4.5,    // props can wall-jump up to this height (walls are 6 m)
    FLUTTER_SPAM: 4,        // props: this many joystick taps / flicks within FLUTTER_WINDOW seconds = "fluttering"
    FLUTTER_WINDOW: 1.0,
    FLUTTER_GRAVITY: 0.4,   // fluttering props fall with this much of normal gravity
    FLUTTER_JUMP_DELAY: 0.35, // fluttering props can jump again in the air at most this often
    WALK_STEP: 0.28,        // tiny auto step-up, ONLY while walking/running on the ground (enough for a mattress); none while jumping
    STAMINA_MAX: 100,
    STAMINA_DRAIN: 16,      // per second while sprinting
    STAMINA_REGEN: 11,      // per second while not sprinting
    STAMINA_RECOVER_AT: 25, // after running out, need this much to sprint again
  },

  // ---------------- Weapons ----------------
  WEAPONS: {
    KNIFE_RANGE: 2.1,           // meters
    KNIFE_ANGLE_DEG: 55,        // half-angle of the stab cone
    KNIFE_COOLDOWN: 0.85,       // seconds between stabs
    KNIFE_SLASH_WINDOW: 0.35,   // after you swing, anyone who comes into the slash during this time still gets hit
    KNIFE_THROW_SPEED: 24,      // m/s
    KNIFE_THROW_COOLDOWN: 1.2,
    KNIFE_PICKUP_RADIUS: 1.2,
    GUN_RANGE: 90,
    GUN_COOLDOWN: 2.0,          // revolver fire rate
    KNIFE_DAMAGE: 50,           // damage to props (seekers' health is only lost by hitting real furniture)
    GUN_DAMAGE: 75,
    THROW_DAMAGE: 75,           // a thrown knife
    CROWBAR_DAMAGE: 60,         // a crowbar hit (a bit more than the knife)
    CROWBAR_THROW_DAMAGE: 110,  // a thrown crowbar is heavy: hits harder...
    CROWBAR_THROW_SPEED: 17,    // ...but flies slower
    CROWBAR_GRAVITY: 16,        // ...and drops faster (thrown knife: 9)
  },

  // ---------------- Bots ----------------
  BOTS: {
    NAMES: ['Arnold', 'Bella', 'Carl', 'Dina', 'Eddie', 'Fay', 'Gus', 'Hana',
            'Ivan', 'Jules', 'Kurt', 'Lena', 'Milo', 'Nora', 'Otto', 'Pia'],
    VIEW_DISTANCE: 28,      // meters they can see
    FOV_DEG: 120,           // field of view
    CLOSE_SENSE: 3.5,       // always notice people this close (hearing)
    THINK_INTERVAL: 0.2,    // seconds between perception updates
    REACTION_MIN: 0.3,      // seconds before they react
    REACTION_MAX: 0.75,
    TURN_SPEED: 5.0,        // radians/sec while aiming
    AIM_SPREAD_DEG: 2.4,    // random error when shooting
    // seeker bots
    MOVE_SUSPICION: 70,     // suspicion per second while watching a piece of "furniture" move (100 = attack it)
    STARE_SUSPICION: 40,    // suspicion per second while a seeker looks at a disguised prop up close (more for skilled seekers)
    CHECK_RANGE: 8,         // seekers sometimes test furniture this close
    CHECK_CHANCE: 0.008,    // per think, chance to test a nearby prop (real disguised players are tested more by skilled bots)
    // prop bots
    HIDE_RANGE: 45,         // how far a prop bot walks to find furniture to copy
    PANIC_RANGE: 3,         // a prop bot may run if a seeker comes this close
    JUMPINESS: 0.35,        // random hops per second while running away
    BLOCKS_BEFORE_DETOUR: 3, // a bot only walks around someone after being blocked by them this many times
    BLOCK_WAIT: 0.7,        // seconds standing still behind someone = one "block"
    // Each bot gets a random skill (0..1) every round. Higher skill =
    //  seeker: faster reactions, steadier aim, spots moving props, tests the right furniture more often
    //  prop: hides further away, copies furniture that is near it, stays still
  },

  // ---------------- Networking ----------------
  NET: {
    PEER_PREFIX: 'findthethings-v1-', // change this to get your own isolated server network
    PUBLIC_SLOTS: 8,        // number of public server slots in the browser
    SNAPSHOT_RATE: 15,      // host -> clients updates per second
    INPUT_RATE: 20,         // client -> host updates per second
    CONNECT_TIMEOUT: 8000,
    HOST_TIMEOUT: 9000,     // client gives up if host silent this long
    CLIENT_TIMEOUT: 12000,  // host kicks a client silent this long
    ICE_SERVERS: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },

  // ---------------- Controls defaults (changeable in Settings) ----------------
  CONTROLS: {
    MOUSE_SENS: 0.0022,
    JOYSTICK_RADIUS: 60,     // px
    JOYSTICK_RUN_AT: 0.9,    // push joystick past 90% to sprint
  },

  GRAPHICS: {
    FOV: 75,
    // presets used by Settings -> Graphics quality
    PRESETS: {
      low:    { renderScale: 0.6, dynLights: 0,  viewDist: 70,  glow: false },
      medium: { renderScale: 0.85, dynLights: 0, viewDist: 110, glow: true },
      high:   { renderScale: 1.0, dynLights: 6,  viewDist: 160, glow: true },
      ultra:  { renderScale: 1.5, dynLights: 12, viewDist: 220, glow: true },
    },
  },

  // Character customization choices (character editor)
  LOOKS: {
    HAIR: ['short', 'buzz', 'sidepart', 'long', 'ponytail', 'bun', 'mohawk', 'spiky', 'afro', 'cap', 'beanie', 'bald'],
    SHIRTS: ['tshirt', 'dressshirt', 'sweater'],
    PANTS: ['jeans', 'slacks', 'cargo', 'shorts', 'sweats'],
    SKINS: [0xf7e3d4, 0xf0d2bd, 0xe5bf9f, 0xd2a07c, 0xb07b55, 0x7d5034, 0x523222], // first one = default (white)
    FACES: ['smile', 'happy', 'neutral', 'sad', 'angry', 'surprised', 'sleepy'],
    HAIR_COLORS: [0x1a1410, 0x3b2716, 0x6b4a2b, 0xa0763c, 0xd8b26a, 0x8c2f1c, 0x9a9a9a, 0x2b4fa8],
    PANTS_COLORS: [0x2c3e66, 0x22242a, 0x4a4033, 0x5b6b4a, 0x777a80, 0x1d2f4a, 0x8a7a5a],
    SHIRT_COLORS: [0xc23b3b, 0x2f6fd8, 0x2fa84a, 0xe0c020, 0x9b40d0, 0xf0f0f0, 0x303030, 0xe07a20],
  },

  // team colors (names on the scoreboard / HUD)
  TEAM_COLORS: { seeker: 0xe04040, prop: 0x3f8cff, none: 0x999999 },
};
