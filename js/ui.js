// HUD, messages, scoreboard and menu screen switching (plain DOM).
import { CONFIG } from './config.js?v=130';
import { hexToCss, textColor } from './util.js?v=130';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class UI {
  constructor() {
    this.isTouch = false;
    this.screens = ['menu', 'browser', 'private', 'settings', 'loading', 'left', 'help', 'editor'];
    this.invOpen = false; this.invPick = null;
    this.bigT = 0;
    this.game = null;
    this.lastHud = {};
  }

  show(name) {
    this.current = name;
    for (const s of this.screens) $(s).classList.toggle('hidden', s !== name);
    const inGame = name === 'game';
    $('hud').classList.toggle('hidden', !inGame);
    $('touch').classList.toggle('hidden', !(inGame && this.isTouch));
    $('menu-bg-shade').classList.toggle('hidden', inGame || name === 'editor');
    $('gearbtn').classList.toggle('hidden', !inGame);
    $('settings').classList.remove('overlay');
    document.body.classList.toggle('ingame', inGame);
    if (!inGame) { document.body.classList.remove('blinded', 'spectating'); $('slbtn').classList.add('hidden'); this.showScoreboard(false); this.toggleInventory(null, false); $('bigmsg').classList.add('hidden'); $('toasts').innerHTML = ''; $('blind').classList.add('hidden'); $('hotbar').classList.add('hidden'); this.lastHud.hb = null; }
  }

  // settings on top of a running match
  openOverlay(on) {
    $('settings').classList.toggle('hidden', !on);
    $('settings').classList.toggle('overlay', on);
    this.overlayOpen = on;
  }

  setTouch(on) {
    this.isTouch = on;
    document.body.classList.toggle('touch', on);
  }

  loading(text, onCancel) {
    this.show('loading');
    $('loading-text').textContent = text;
    $('loading-cancel').onclick = () => onCancel?.();
  }

  notice(text) {
    const n = $('menu-notice');
    n.textContent = text || '';
    n.classList.toggle('hidden', !text);
  }

  toast(html, color = '#fff', dur = 4) {
    const box = $('toasts');
    const d = document.createElement('div');
    d.className = 'toast';
    d.style.color = color;
    d.innerHTML = html;
    box.appendChild(d);
    while (box.children.length > 5) box.removeChild(box.firstChild);
    setTimeout(() => { d.classList.add('fade'); setTimeout(() => d.remove(), 600); }, dur * 1000);
  }

  bigMessage(title, sub, color, dur = 3) {
    const b = $('bigmsg');
    b.querySelector('.t').textContent = title;
    b.querySelector('.t').style.color = color;
    b.querySelector('.s').innerHTML = sub || '';
    b.classList.remove('hidden');
    clearTimeout(this._bigTimer);
    this._bigTimer = setTimeout(() => b.classList.add('hidden'), dur * 1000);
  }

  showScoreboard(on, game) {
    if (game) this.game = game;
    $('scoreboard').classList.toggle('hidden', !on);
    this.scoreOpen = on;
    if (on) this.refreshScoreboard();
  }

  refreshScoreboard() {
    const g = this.game;
    if (!this.scoreOpen || !g) return;
    const order = { seeker: 0, prop: 1, none: 2 };
    const rows = [...g.chars.values()].sort((a, b) => (order[a.team] - order[b.team]) || (a.isBot - b.isBot) || a.nick.localeCompare(b.nick));
    $('sb-title').textContent = `${g.serverLabel}${g.code ? '  ·  Code ' + g.code : ''}`;
    $('sb-rows').innerHTML = rows.map((c) => `
      <div class="sb-row${c.id === g.localId ? ' me' : ''}${c.alive ? '' : ' dead'}">
        <span class="sb-nick" style="color:${textColor(c.color)}">${esc(c.nick)}${c.isBot ? ' <i>BOT</i>' : ''}${c.id === g.localId ? ' <i>YOU</i>' : ''}</span>
        <span class="sb-team">${c.team === 'seeker' ? 'Seeker' : c.team === 'prop' ? 'Prop' : 'Spectator'}${c.alive || c.team === 'none' ? '' : ' · out'}</span>
      </div>`).join('');
  }

  // Called every frame by the game
  updateHud(s) {
    const me = s.me;
    const seeker = s.team === 'seeker', prop = s.team === 'prop';
    // round timer
    let ph = '';
    const t = Math.max(0, Math.ceil(s.timeLeft));
    const mmss = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    if (s.phase === 'waiting') ph = 'Waiting for players…';
    // blindfolded seekers already see the big countdown, so the top timer stays empty until the round starts
    else if (s.phase === 'pre') ph = s.blind ? '' : `Hiding… ${t}`;
    else if (s.phase === 'play') ph = mmss;
    else if (s.phase === 'post') ph = `Next round in ${t}`;
    this._set('hud-timer', ph);
    this._set('hud-count', s.phase === 'pre' || s.phase === 'play' ? `Props ${s.propsLeft} · Seekers ${s.seekersLeft}` : '');

    // seekers are blindfolded while the props hide
    const bl = $('blind');
    bl.classList.toggle('hidden', !s.blind);
    // while blindfolded, every control is hidden (only the server text, settings, scoreboard and X stay)
    document.body.classList.toggle('blinded', !!s.blind);
    document.body.classList.toggle('spectating', !me.alive);
    if (s.blind) this._set('blind-t', String(t));

    // identity panel (bottom-left, team colored)
    const teamTxt = !me.alive ? 'Spectating' : seeker ? 'Seeker' : prop ? (s.disguise ? `Prop · ${s.disguise}` : 'Prop · person (T-pose)') : '';
    // shift lock button
    const sl = $('slbtn');
    sl.classList.toggle('hidden', !me.alive);
    sl.classList.toggle('on', !!s.shiftLock);
    this._set('hud-name', me.nick);
    this._set('hud-role', teamTxt);
    const col = me.alive ? textColor(me.color) : '#888';
    if (this.lastHud.col !== col) { $('hud-id').style.borderColor = me.alive ? hexToCss(me.color) : '#888'; $('hud-name').style.color = col; this.lastHud.col = col; }
    $('hud-role').className = me.alive && seeker ? 'seeker' : me.alive && prop ? 'prop' : '';

    // health (seekers)
    const hpEl = $('hud-hp');
    hpEl.style.display = me.alive && seeker ? 'block' : 'none';
    if (me.alive && seeker) {
      const k = clamp01(s.hp / CONFIG.TEAMS.SEEKER_HP);
      hpEl.firstElementChild.style.width = `${(k * 100).toFixed(1)}%`;
      this._set('hud-hp-t', `${Math.max(0, Math.round(s.hp))} HP`);
    }
    let info = '';
    if (me.alive && prop) info = s.disguise ? (this.isTouch ? 'Tap other furniture to change' : 'Click other furniture to change') : (this.isTouch ? 'Tap furniture to turn into it' : 'Click furniture to turn into it');
    if (me.alive && seeker && !s.hasKnife) info = 'Knife thrown — go pick it up!';
    this._set('hud-weapon', info);

    // hotbar (seekers)
    this.renderHotbar(me.alive && seeker ? s : null);
    if (this.invOpen) this.renderInventory(s);

    // stamina bar
    const st = me.alive ? me.stamina / CONFIG.PLAYER.STAMINA_MAX : 1;
    const stEl = $('hud-stamina');
    stEl.style.display = me.alive && st < 0.999 ? 'block' : 'none';
    stEl.firstElementChild.style.width = `${(st * 100).toFixed(1)}%`;
    stEl.classList.toggle('tired', !!me.exhausted);

    // look-at name
    const look = s.look;
    const lk = look ? `${look.nick}|${look.color}` : '';
    if (this.lastHud.lk !== lk) {
      this.lastHud.lk = lk;
      const el = $('hud-look');
      el.textContent = look ? look.nick : '';
      el.style.color = look ? textColor(look.color) : '';
    }
    $('crosshair').style.display = me.alive && !s.blind && s.crosshair ? 'block' : 'none';

    // spectate info
    let sp = '';
    if (!me.alive) {
      if (s.spec) sp = `Spectating <b style="color:${textColor(s.spec.color)}">${esc(s.spec.nick)}</b>`;
      sp += `<small>${this.isTouch ? 'Tap ▶ to switch · X = main menu' : 'Click / F to switch · X = main menu'}</small>`;
    }
    this._setHtml('hud-spec', sp);

    // server label
    this._set('hud-server', `${s.server}${s.code ? ' · Code: ' + s.code : ''} · ${s.players} players`);

    // touch buttons
    if (this.isTouch) {
      const tb = (name, show, label) => {
        const el = document.querySelector(`[data-btn="${name}"]`);
        if (!el) return;
        el.style.display = show ? '' : 'none';
        if (label && el.dataset.label !== label) { el.dataset.label = label; el.textContent = label; }
      };
      const alive = me.alive;
      tb('attack', alive && (seeker || prop), seeker ? (s.weapon === 1 ? 'STAB' : s.weapon === 2 ? 'SHOOT' : 'DRAW') : 'BECOME');
      tb('throw', alive && seeker && s.weapon === 1, 'THROW');
      tb('jump', alive);
      tb('run', alive);
      tb('next', !alive);
    }
    if (this.scoreOpen && Math.random() < 0.05) this.refreshScoreboard();
  }

  // ---------- hotbar + inventory ----------
  renderHotbar(s) {
    const el = $('hotbar');
    const key = s ? `${s.hotbar.join(',')}|${s.slot}|${s.hasKnife}|${s.hasGun}|${this.isTouch}` : '';
    if (this.lastHud.hb === key) return;
    this.lastHud.hb = key;
    el.classList.toggle('hidden', !s);
    if (!s) return;
    if (!el.children.length) {
      for (let k = 0; k < CONFIG.INVENTORY.HOTBAR; k++) {
        const d = document.createElement('div');
        d.className = 'hb-slot';
        d.dataset.slot = k;
        const pick = (e) => { e.preventDefault(); e.stopPropagation(); this.game?.selectSlot(k); };
        d.addEventListener('pointerdown', pick);
        el.appendChild(d);
      }
      const bag = document.createElement('div');
      bag.className = 'hb-slot hb-small hb-bag'; bag.title = 'Inventory (I)'; bag.textContent = '🎒';
      bag.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.toggleInventory(this.game); });
      el.appendChild(bag);
    }
    [...el.querySelectorAll('.hb-slot:not(.hb-small)')].forEach((d, k) => {
      const it = s.hotbar[k];
      const gone = (it === 'knife' && !s.hasKnife) || (it === 'revolver' && !s.hasGun);
      d.classList.toggle('sel', s.slot === k);
      d.classList.toggle('gone', gone);
      d.innerHTML = `<span class="hb-n">${k + 1}</span>${it ? itemIcon(it) : ''}`;
    });
  }

  toggleInventory(game, on = !this.invOpen) {
    if (game) this.game = game;
    const me = this.game?.me;
    if (on && (!me || !me.alive || me.team !== 'seeker')) on = false;
    this.invOpen = on;
    this.invPick = null;
    $('inventory').classList.toggle('hidden', !on);
    if (on) { document.exitPointerLock?.(); this.lastHud.inv = null; }
  }

  renderInventory(s) {
    if (!s.me.alive || s.team !== 'seeker') { this.toggleInventory(null, false); return; }
    const all = [...s.hotbar, ...s.backpack];
    const key = `${all.join(',')}|${this.invPick}|${s.hasKnife}|${s.hasGun}`;
    if (this.lastHud.inv === key) return;
    this.lastHud.inv = key;
    const H = CONFIG.INVENTORY.HOTBAR;
    const cell = (k) => {
      const it = all[k];
      const gone = (it === 'knife' && !s.hasKnife) || (it === 'revolver' && !s.hasGun);
      return `<div class="inv-slot${this.invPick === k ? ' pick' : ''}${gone ? ' gone' : ''}" data-k="${k}">${it ? itemIcon(it) + `<small>${CONFIG_ITEM(it)}</small>` : ''}</div>`;
    };
    $('inv-hotbar').innerHTML = all.slice(0, H).map((_, k) => cell(k)).join('');
    $('inv-bag').innerHTML = all.slice(H).map((_, k) => cell(H + k)).join('');
    for (const d of $('inventory').querySelectorAll('.inv-slot')) {
      d.onpointerdown = (e) => {
        e.preventDefault(); e.stopPropagation();
        const k = +d.dataset.k;
        if (this.invPick === null) { if (all[k]) this.invPick = k; }
        else { if (this.invPick !== k) this.game?.invSwap(this.invPick, k); this.invPick = null; }
        this.lastHud.inv = null;
      };
    }
  }

  _set(id, txt) {
    if (this.lastHud[id] === txt) return;
    this.lastHud[id] = txt;
    $(id).textContent = txt;
  }
  _setHtml(id, html) {
    if (this.lastHud[id] === html) return;
    this.lastHud[id] = html;
    $(id).innerHTML = html;
  }
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const CONFIG_ITEM = (it) => ({ knife: 'Knife', revolver: 'Revolver' }[it] || it);
// small inline icons for inventory items
function itemIcon(it) {
  if (it === 'knife') return '<svg class="ico" viewBox="0 0 32 32"><path d="M6 26 L9 23 L11 25 L8 28 Z" fill="#6b4524"/><path d="M9 23 L24 6 Q27 4 26 8 L11 25 Z" fill="#d8dde3" stroke="#889" stroke-width="0.8"/><rect x="7.5" y="21.5" width="5" height="1.6" transform="rotate(-45 10 22)" fill="#333"/></svg>';
  if (it === 'revolver') return '<svg class="ico" viewBox="0 0 32 32"><rect x="6" y="10" width="20" height="4" rx="1" fill="#4a4d52"/><rect x="11" y="9" width="7" height="7" rx="2" fill="#5c6066"/><path d="M8 14 L13 14 L11 25 L6 25 Z" fill="#6b4524"/><path d="M13 15 q2 4 4 0" stroke="#333" stroke-width="1.4" fill="none"/></svg>';
  return `<b>${it}</b>`;
}
