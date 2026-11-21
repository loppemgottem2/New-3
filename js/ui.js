// HUD, messages, scoreboard and menu screen switching (plain DOM).
import { CONFIG } from './config.js';
import { hexToCss, textColor } from './util.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class UI {
  constructor() {
    this.isTouch = false;
    this.screens = ['menu', 'browser', 'private', 'settings', 'loading', 'left', 'help', 'editor'];
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
    if (!inGame) { this.showScoreboard(false); $('bigmsg').classList.add('hidden'); $('toasts').innerHTML = ''; }
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
    const rows = [...g.chars.values()].sort((a, b) => (a.isBot - b.isBot) || a.nick.localeCompare(b.nick));
    $('sb-title').textContent = `${g.serverLabel}${g.code ? '  ·  Code ' + g.code : ''}`;
    $('sb-rows').innerHTML = rows.map((c) => `
      <div class="sb-row${c.id === g.localId ? ' me' : ''}">
        <span class="sb-nick">${esc(c.nick)}${c.isBot ? ' <i>BOT</i>' : ''}${c.id === g.localId ? ' <i>YOU</i>' : ''}</span>
      </div>`).join('');
  }

  // Called every frame by the game
  updateHud(s) {
    const me = s.me;
    // round timer
    let ph = '';
    const t = Math.max(0, Math.ceil(s.timeLeft));
    const mmss = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    if (s.phase === 'waiting') ph = 'Waiting for players…';
    else if (s.phase === 'pre') ph = `Round starts in ${t}`;
    else if (s.phase === 'play') ph = mmss;
    else if (s.phase === 'post') ph = `Next round in ${t}`;
    this._set('hud-timer', ph);

    // identity panel (bottom-left, colored like your clothes)
    const roleTxt = !me.alive ? 'Spectating' : s.role === 'murderer' ? 'Murderer' : s.role === 'none' ? '' : s.hasGun ? 'Sheriff' : 'Bystander';
    this._set('hud-name', me.nick);
    this._set('hud-role', roleTxt);
    const col = me.alive ? textColor(me.color) : '#888';
    if (this.lastHud.col !== col) { $('hud-id').style.borderColor = me.alive ? hexToCss(me.color) : '#888'; $('hud-name').style.color = col; this.lastHud.col = col; }
    $('hud-role').className = s.role === 'murderer' && me.alive ? 'murderer' : s.hasGun && me.alive ? 'sheriff' : '';

    // weapon / parts
    let wtxt = '';
    if (me.alive) {
      if (s.hasKnife) wtxt = s.weapon === 1 ? 'Knife (out)' : 'Knife (hidden)';
      else if (s.hasGun) wtxt = s.weapon === 2 ? 'Revolver (drawn)' : 'Revolver (holstered)';
      else if (s.role === 'murderer') wtxt = 'Knife thrown — go pick it up!';
    }
    this._set('hud-weapon', wtxt);
    this._set('hud-parts', s.parts >= 0 && me.alive ? `Gun parts ${s.parts}/${CONFIG.GUNPARTS.COUNT}` : '');

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
    $('crosshair').style.display = me.alive ? 'block' : 'none';

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
      tb('attack', alive && (s.hasKnife || s.hasGun), s.weapon === 1 ? 'STAB' : s.weapon === 2 ? 'SHOOT' : s.hasKnife ? 'KNIFE' : 'GUN');
      tb('equip', alive && (s.hasKnife || s.hasGun), s.weapon ? 'HIDE' : 'DRAW');
      tb('throw', alive && s.weapon === 1, 'THROW');
      tb('jump', alive);
      tb('run', alive);
      tb('next', !alive);
    }
    if (this.scoreOpen && Math.random() < 0.05) this.refreshScoreboard();
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
