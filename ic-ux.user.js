// ==UserScript==
// @name         ICUX
// @namespace    https://github.com/mahardikamaulana
// @version      0.3.0
// @description  Quality-of-life additions for idlecorp.net
// @match        https://idlecorp.net/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mahardikamaulana/ICUX/main/ic-ux.user.js
// @downloadURL  https://raw.githubusercontent.com/mahardikamaulana/ICUX/main/ic-ux.user.js
// ==/UserScript==

// ICUX: quality-of-life additions for idlecorp.net.
// Anchors are class names, data attributes and fiber prop names only (the game's minified names change every build).
// Everything injected carries a data-icux marker and an icux-* class; the only message sent is AssignBuildings (Max).
(() => {
  'use strict';
  if (window.icux?._unload) window.icux._unload();

// icuxMath:begin
  // Pure helpers (no DOM, no globals): test.js evals this block on its own.
  const icuxMath = (() => {
    // shortcut: ids, region layout and freight constants are copied from the game build of 2026-11-23; re-check after game updates.
    const ACCOUNT_ITEMS = [0, 24, 25, 26, 111, 106, 107, 108, 109, 110]; // live in st.items, not in st.stock
    const MONEY = 0, MD = 25, TRUCK = 59, FUEL = 60, DEPOT = 13, REFINER_MODULE = 62;
    const COORDS = [[0, 0], [1, 0], [-2, 1], [1, 2]];
    const HEARTLAND_GRANT = 25;
    const TRUCK_CU = 5e4, TRUCKS_PER_DEPOT = 4, FUEL_PER_HOP = 5, COURIER_CENTS = 5;
    const BASE_ALLOW = 1e4, MAX_ALLOW = 5e4, ALLOW_PER_LEVEL = 5e3;
    const MD_START = 300, MD_BATCH = 1e4;

    const held = (st, r, item) => (ACCOUNT_ITEMS.includes(item) ? st.items?.[item] : st.stock?.[r]?.[item]) ?? 0;
    const groupsOf = (st) => Object.values(st.groups ?? {});
    const inRegion = (st, r, id) =>
      (st.building_pool?.[r]?.[id] ?? 0) +
      groupsOf(st).filter((g) => g.building === id && (g.region ?? 0) === r).reduce((a, g) => a + g.count, 0);
    const ownedCount = (st, id) =>
      Object.values(st.building_pool ?? {}).reduce((a, p) => a + (p?.[id] ?? 0), 0) +
      groupsOf(st).filter((g) => g.building === id).reduce((a, g) => a + g.count, 0);

    const hops = (a, b) => {
      const [q1, r1] = COORDS[a] ?? [0, 0], [q2, r2] = COORDS[b] ?? [0, 0];
      const dq = q1 - q2, dr = r1 - r2;
      return 1 + (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
    };

    const nextCosts = (cost, owned) => {
      const unit = (k) => Math.floor((cost * (20 + owned + k)) / 20);
      let five = 0, ten = 0;
      for (let k = 0; k < 10; k++) { if (k < 5) five += unit(k); ten += unit(k); }
      return { next: unit(0), five, ten };
    };

    const freeLand = (st, buildings, r) => {
      const owned = (r === 0 ? HEARTLAND_GRANT : 0) + (st.land_bought?.[r] ?? 0);
      const used = buildings.reduce((a, b) => a + b.acres * inRegion(st, r, b.id), 0);
      return { owned, used, free: owned - used };
    };

    const maxAssign = (st, groupId) => {
      const g = st.groups?.[groupId];
      return g ? st.building_pool?.[g.region ?? 0]?.[g.building] ?? 0 : 0;
    };

    const allowance = (level) => Math.min(MAX_ALLOW, BASE_ALLOW + (level ?? 0) * ALLOW_PER_LEVEL);
    const fuelTrip = (hopCount, cut) => Math.floor((FUEL_PER_HOP * hopCount * (100 - cut)) / 100);
    const refinerCut = (st) =>
      Math.min(50, (st.fleet_modules ?? [])
        .map((id) => st.module_defs?.[String(id)])
        .filter((d) => d != null && d.kind === REFINER_MODULE)
        .reduce((a, d) => a + Math.max(0, -d.inputs_bonus), 0));
    const freeTrucks = ({ trucks, depots, out, hiredOut, fuel, trip }) =>
      Math.min(Math.max(0, Math.min(trucks, TRUCKS_PER_DEPOT * depots) - out - hiredOut), Math.floor(fuel / Math.max(1, trip)));

    // Courier capacity once the courier is paid for: the free allowance plus what money and MD can buy.
    const courierCap = (allow, md, money, hopCount) => {
      const byMoney = allow + Math.floor(Math.max(0, money) / Math.max(1, COURIER_CENTS * hopCount));
      let left = Math.max(0, md), cap = allow, per = MD_START;
      for (;;) {
        if (per <= 1) { cap += left; break; }
        const batch = Math.ceil(MD_BATCH / per);
        if (left < batch) { cap += left * per; break; }
        left -= batch; cap += MD_BATCH; per = Math.max(1, Math.floor((per * 2) / 3));
      }
      return Math.min(cap, byMoney);
    };
    // MD the courier needs for the part of the cargo above the free allowance.
    const mdCost = (cargo, allow) => {
      let over = Math.max(0, cargo - allow), per = MD_START, md = 0;
      while (over > 0) {
        if (per <= 1) return md + over;
        const part = Math.min(over, MD_BATCH);
        md += Math.ceil(part / per); over -= part; per = Math.max(1, Math.floor((per * 2) / 3));
      }
      return md;
    };

    // Default carriage (no hired hauler). free = trucks you can send now; none means the courier is paid automatically.
    const freight = ({ cargo, allow, hops: hopCount, cut = 0, freeTrucks: free, md = 0, money = 0 }) => {
      const forced = free <= 0;
      const cap = forced ? courierCap(allow, md, money, hopCount) : allow;
      const trucks = cargo <= cap ? 0 : Math.ceil(cargo / TRUCK_CU);
      if (trucks > 0) return { trucks, money: 0, fuel: trucks * fuelTrip(hopCount, cut), md: 0, forced };
      return { trucks: 0, money: Math.max(0, cargo - allow) * COURIER_CENTS * hopCount, fuel: 0, md: mdCost(cargo, allow), forced };
    };
    const freightEnv = (st, r, hires, tick) => {
      const corp = st.ssi?.corp_id;
      return {
        allow: allowance(st.courier_levels?.capacity),
        cut: refinerCut(st),
        md: held(st, 0, MD), money: held(st, 0, MONEY),
        trucks: held(st, r, TRUCK), depots: inRegion(st, r, DEPOT), fuel: held(st, r, FUEL),
        out: (st.shipments ?? []).filter((s) => (s.from_region ?? 0) === r).reduce((a, s) => a + s.trucks, 0),
        hiredOut: (hires ?? []).filter((o) => o.hauler === corp && (o.region ?? 0) === r && o.until > tick).reduce((a, o) => a + o.trucks, 0),
      };
    };
    const freightFor = (env, cargo, hopCount) =>
      freight({
        cargo, allow: env.allow, hops: hopCount, cut: env.cut, md: env.md, money: env.money,
        freeTrucks: freeTrucks({ trucks: env.trucks, depots: env.depots, out: env.out, hiredOut: env.hiredOut, fuel: env.fuel, trip: fuelTrip(hopCount, env.cut) }),
      });

    // One bid row sold at n units. null when the item has no base value (never read as 0). Cents throughout.
    const net = ({ n, price, amount, baseValue, freight: fr, fuelValue }) => {
      if (typeof baseValue !== 'number' || n < 1) return null;
      const revenue = n >= amount ? price : Math.floor((price * n) / amount);
      const goods = n * baseValue, cash = fr?.money ?? 0, fuel = fr?.fuel ?? 0;
      const fuelCost = fuel * (fuelValue ?? 0);
      return { revenue, goods, cash, fuel, fuelCost, fuelUnvalued: fuel > 0 && fuelValue == null, net: revenue - goods - cash - fuelCost };
    };

    // Contract ticks are 500 ms.
    const mmss = (ticks) => {
      const s = Math.floor(ticks / 2);
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };

    return { held, inRegion, ownedCount, hops, nextCosts, freeLand, maxAssign, allowance, fuelTrip, refinerCut, freeTrucks, courierCap, mdCost, freight, freightEnv, freightFor, net, mmss };
  })();
// icuxMath:end

  // ---- shared plumbing ----------------------------------------------------------------------------------------------
  const VERSION = '0.3.0';
  const REGIONS = ['Heartland', 'Industrial Basin', 'Coastal Cities', 'Frontier'];
  const FUEL_ITEM = 60;
  const EXPIRING_TICKS = 600; // the game's own expires-soon threshold
  const SETTINGS_KEY = 'icux.settings';

  const store = (() => { try { return window.localStorage ?? null; } catch { return null; } })();
  const settings = { ownedOnly: false, hideExpired: false, hiddenCols: [] };
  try { Object.assign(settings, JSON.parse(store?.getItem(SETTINGS_KEY) ?? '{}')); } catch {}
  if (!Array.isArray(settings.hiddenCols)) settings.hiddenCols = [];
  const saveSettings = () => { try { store?.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };

  // money: integer cents, formatted like the game's own ge()
  const fmt = (c) => (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (c) => (c < 0 ? '−$' : '$') + fmt(Math.abs(c));
  const uiRegion = () => {
    const r = Number(store?.getItem('idlecorp.region'));
    return Number.isInteger(r) && r >= 0 && r < REGIONS.length ? r : 0;
  };

  // React keeps the same fiber on the node for good: when it is the stale half of the pair, use its alternate (the latest props)
  const fiberOf = (el) => {
    const keys = Object.keys(el), f = el[keys.find((x) => x.startsWith('__reactFiber$'))];
    const pk = keys.find((x) => x.startsWith('__reactProps$'));
    return f?.alternate && pk && f.alternate.memoizedProps === el[pk] ? f.alternate : f ?? null;
  };
  const fiberKey = (el) => fiberOf(el)?.key ?? null;
  const propsUp = (el, name) => {
    for (let f = fiberOf(el); f; f = f.return) { const v = f.memoizedProps?.[name]; if (v !== undefined) return v; }
    return undefined;
  };
  const fiberUp = (el, test) => {
    for (let f = fiberOf(el); f; f = f.return) { const p = f.memoizedProps; if (p && test(p)) return p; }
    return null;
  };
  // The distributors board component (props: market, haulage, serverTick, filters, sort, display, catalog).
  const boardProps = (el) => fiberUp(el, (p) => Array.isArray(p.market) && p.haulage !== undefined && p.serverTick !== undefined && !!p.setFilters && p.sort !== undefined);

  // Walk the React fiber tree for the socket, the display state and the catalog (trimmed from ic-autopilot's core walk).
  function walk() {
    const out = { ws: null, st: null, catalog: null };
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer'));
    if (!key) return out;
    const seen = new Set(), stack = [root[key]];
    while (stack.length && !(out.ws && out.st && out.catalog)) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      let h = f.memoizedState, n = 0;
      while (h && n < 50) {
        const v = h.memoizedState;
        if (v && v.current instanceof WebSocket) out.ws = v.current;
        if (v && typeof v === 'object' && v.groups && v.stock && v.ssi) out.st = v;
        h = h.next; n++;
      }
      const p = f.memoizedProps;
      if (p && p.catalog?.techs && !out.catalog) out.catalog = p.catalog;
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return out;
  }

  // The catalog arrays are not indexed by id: re-key once per catalog object.
  let idx = { cat: null, items: new Map(), buildings: new Map() };
  const index = (cat) => {
    if (idx.cat !== cat) idx = { cat, items: new Map((cat.items ?? []).map((i) => [i.id, i])), buildings: new Map((cat.buildings ?? []).map((b) => [b.id, b])) };
    return idx;
  };

  // Server tick (2 per second), seeded from the board's serverTick prop and extrapolated between renders. The board is
  // the only consumer and always has the prop, so there is no socket fallback.
  const tk = { tick: 0, at: 0 };
  const seeTick = (t) => { if (typeof t === 'number' && t > tk.tick) { tk.tick = t; tk.at = Date.now(); } };
  const nowTick = () => (tk.tick ? tk.tick + Math.floor((Date.now() - tk.at) / 500) : 0);

  const mk = (tag, cls, text, key) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    el.setAttribute('data-icux', key ?? '1');
    return el;
  };
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const setAttr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };

  const CSS = [
    '[data-icux-hide]{display:none!important}',
    '.icux-neg{color:var(--status-crit)}',
    '.icux-land{font-size:12.5px;color:var(--ink-2);white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.icux-rowbtn{height:22px;min-width:22px;padding:0 .35rem;margin-right:4px;font-size:12px;line-height:20px}',
    '.icux-rowbtn[aria-disabled=true]{opacity:.45;cursor:default}',
    '.icux-presets{display:inline-flex;gap:4px;margin-right:6px}',
    '.icux-toggle{display:inline-flex;align-items:center;gap:.35rem;font-size:.85rem;color:var(--ink-2);white-space:nowrap;cursor:pointer}',
    '.icux-hidden-count{font-size:.85rem;white-space:nowrap}',
    '.icux-col{white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.icux-mmss{margin-left:.4em;color:var(--status-warn);font-variant-numeric:tabular-nums}',
    '.icux-tip{position:fixed;z-index:1000;display:none;max-width:340px;padding:.5rem .65rem;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);font-size:12.5px;line-height:1.4;color:var(--ink-2);font-variant-numeric:tabular-nums;pointer-events:none}',
    '.icux-tip.on{display:block}',
    '.icux-tip .icux-strong{color:var(--ink);font-weight:600;margin-bottom:2px}',
    '.icux-tip .icux-row{display:flex;justify-content:space-between;gap:16px}',
    '.icux-tip .icux-note{color:var(--muted);margin-top:3px}',
    '.icux-colpick{position:relative;display:inline-flex;margin-left:.5rem}',
    '.icux-colbtn{height:28px;padding:0 .6rem;font-size:.85rem;color:var(--ink-2);background:var(--surface-2);border:1px solid var(--border);border-radius:6px;cursor:pointer;white-space:nowrap}',
    '.icux-colbtn:hover{color:var(--ink)}',
    '.icux-colmenu{display:none;position:absolute;right:0;top:calc(100% + 4px);z-index:50;min-width:180px;padding:.35rem;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow)}',
    '.icux-colmenu.on{display:block}',
    '.icux-colopt{display:flex;align-items:center;gap:.45rem;padding:.25rem .45rem;font-size:.85rem;color:var(--ink-2);white-space:nowrap;cursor:pointer;border-radius:6px}',
    '.icux-colopt:hover{background:var(--surface-3)}',
    // #11 compact header, desktop only (the game's tablet and phone layouts stay as they are). Nothing is hidden. The bar
    // stays on one row where it fits, so the balance no longer drops to a second line; chips wrap inside the tools otherwise.
    '@media (min-width:901px){',
    'header.topbar{flex-wrap:nowrap;gap:.5rem;padding:.4rem 1rem}',
    'header.topbar>.topbar-tools{flex:1 1 0;gap:.35rem}',
    'header.topbar>.topbar-tools>:is(.event-chip,.shipments-chip,.idc-chip),header.topbar>.topbar-tools>.tip-anchor>.power-status{padding:0 .45rem}',
    '}',
  ].join('');

  // ---- #11 compact header (CSS above) -------------------------------------------------------------------------------
  // The game writes the bar's height to --chrome-h (the sticky offsets below it) on mount and on window resize only.
  // The compact bar changes its height after that, so the variable follows the bar's own size.
  let chromeEl = null, chromeRO = null;
  const syncChrome = () => { if (chromeEl) document.documentElement.style.setProperty('--chrome-h', chromeEl.getBoundingClientRect().height + 'px'); };
  function watchChrome() {
    const el = document.querySelector('.chrome');
    if (el === chromeEl) return;
    chromeRO?.disconnect();
    chromeEl = el;
    chromeRO = el ? new ResizeObserver(syncChrome) : null;
    chromeRO?.observe(el);
  }

  // ---- #10 free land ------------------------------------------------------------------------------------------------
  function applyLand(c) {
    const tools = document.querySelector('header.topbar .topbar-tools');
    if (!tools) return;
    let el = tools.querySelector(':scope > .icux-land');
    if (!el) { el = mk('span', 'icux-land', '', 'land'); tools.prepend(el); }
    const all = !!document.querySelector('header.topbar .topbar-scope'); // no region picker: the page is not region-bound
    const regions = all ? REGIONS.map((_, r) => r) : [uiRegion()];
    let owned = 0, used = 0;
    for (const r of regions) { const l = icuxMath.freeLand(c.st, c.catalog.buildings ?? [], r); owned += l.owned; used += l.used; }
    const free = owned - used;
    setText(el, 'Land ' + free.toLocaleString() + ' free');
    setAttr(el, 'title', used.toLocaleString() + ' / ' + owned.toLocaleString() + ' acres in use ' + (all ? 'across all regions' : 'in ' + REGIONS[regions[0]]));
    el.classList.toggle('icux-neg', free < 0);
  }

  // ---- #1 max assign ------------------------------------------------------------------------------------------------
  const sentPool = new Map(); // groupId -> pool size at click; the button stays off until the pool changes
  function applyMax(c) {
    for (const bulk of document.querySelectorAll('.stepper-bulk')) {
      let btn = bulk.querySelector(':scope > .icux-max');
      // fiber .return crosses the dialog portal, so a dialog opened from a group card would also report a groupId
      const gid = bulk.closest('.modal-backdrop') ? undefined : propsUp(bulk, 'groupId');
      if (typeof gid !== 'number') { btn?.remove(); continue; }
      if (!btn) {
        btn = mk('button', 'icux-max', 'Max', 'max');
        btn.type = 'button';
        btn.addEventListener('click', () => sendMax(Number(btn.dataset.icuxGroup)));
        bulk.append(btn);
      }
      btn.dataset.icuxGroup = String(gid);
      const pool = icuxMath.maxAssign(c.st, gid);
      if (sentPool.has(gid) && sentPool.get(gid) !== pool) sentPool.delete(gid);
      btn.disabled = pool < 1 || c.ws?.readyState !== 1 || sentPool.get(gid) === pool;
      setAttr(btn, 'title', pool < 1 ? 'No unassigned buildings' : 'Assign all ' + pool.toLocaleString() + ' unassigned');
    }
  }
  function sendMax(gid) {
    const c = walk();
    const pool = c.st ? icuxMath.maxAssign(c.st, gid) : 0;
    if (pool < 1 || c.ws?.readyState !== 1 || sentPool.get(gid) === pool) return;
    sentPool.set(gid, pool);
    c.ws.send(JSON.stringify({ type: 'AssignBuildings', group: gid, amount: pool }));
    setTimeout(() => { sentPool.delete(gid); schedule(); }, 2000); // the guard must not outlive a command the server dropped
    schedule();
  }

  // ---- #2 build / demolish buttons, #4 cost preview -----------------------------------------------------------------
  let ctx = { ws: null, st: null, catalog: null };
  let tip = null, tipAnchor = null;
  const menuItems = (wrap) => { const it = propsUp(wrap, 'items'); return Array.isArray(it) ? it : null; };

  function applyBuildingRows() {
    for (const link of document.querySelectorAll('button[data-building]')) {
      const tr = link.closest('tr');
      const wrap = tr?.querySelector('.menu-wrap');
      const items = wrap && menuItems(wrap);
      if (!items || items.length < 2) continue;
      const cell = wrap.parentElement;
      [['build', '＋', 'Build', 0], ['demolish', '🗑', 'Demolish', 1]].forEach(([key, glyph, label, i]) => {
        let b = cell.querySelector(':scope > .icux-' + key);
        if (!b) {
          b = mk('button', 'icux-rowbtn icux-' + key, glyph, key);
          b.type = 'button';
          b.setAttribute('aria-label', label);
          b.setAttribute('aria-describedby', 'icux-tip');
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            if (b.getAttribute('aria-disabled') === 'true') return; // the game's handler does not guard this itself
            const item = menuItems(b.parentElement.querySelector('.menu-wrap'))?.[i];
            if (item && !item.disabled) item.onClick();
          });
          b.addEventListener('mouseenter', () => showTip(b));
          b.addEventListener('focus', () => showTip(b));
          b.addEventListener('mouseleave', hideTip);
          b.addEventListener('blur', hideTip);
          cell.insertBefore(b, wrap);
        }
        b.dataset.icuxBuilding = link.getAttribute('data-building');
        setAttr(b, 'aria-disabled', items[i].disabled ? 'true' : 'false');
      });
    }
  }

  function tipLines(anchor) {
    const { st } = ctx;
    const id = Number(anchor.dataset.icuxBuilding);
    const b = idx.buildings.get(id);
    if (!st || !b) return null;
    const uiR = uiRegion();
    const name = b.name ?? 'Building';
    if (anchor.classList.contains('icux-demolish')) {
      const avail = st.building_pool?.[uiR]?.[id] ?? 0;
      const lines = [{ k: 'head', a: 'Demolish ' + name }];
      if (anchor.getAttribute('aria-disabled') === 'true') lines.push({ k: 'note', a: 'Nothing to demolish: no unassigned ' + name + ' in ' + REGIONS[uiR] });
      else lines.push({ k: 'row', a: 'Unassigned in ' + REGIONS[uiR], b: avail.toLocaleString() });
      lines.push({ k: 'row', a: 'Refund each', b: money(Math.floor(b.cost / 2)) }, { k: 'note', a: 'Materials are not returned' });
      return lines;
    }
    const cash = icuxMath.held(st, uiR, 0);
    const c = icuxMath.nextCosts(b.cost, icuxMath.ownedCount(st, id));
    const lines = [
      { k: 'head', a: 'Build ' + name },
      { k: 'row', a: 'Next', b: money(c.next), bad: c.next > cash },
      { k: 'row', a: '+5', b: money(c.five), bad: c.five > cash },
      { k: 'row', a: '+10', b: money(c.ten), bad: c.ten > cash },
    ];
    for (const m of b.build_items ?? []) {
      const have = icuxMath.held(st, uiR, m.item);
      lines.push({ k: 'row', a: (idx.items.get(m.item)?.name ?? '#' + m.item) + ' (have ' + have.toLocaleString() + ')', b: [1, 5, 10].map((n) => ({ t: (m.amount * n).toLocaleString(), bad: have < m.amount * n })) });
    }
    lines.push({ k: 'note', a: '+ land if needed (see dialog). Materials: need for 1 / 5 / 10.' });
    return lines;
  }
  function lineEl(l) {
    if (l.k === 'head') return mk('div', 'icux-strong', l.a, 'tip-line');
    if (l.k === 'note') return mk('div', 'icux-note', l.a, 'tip-line');
    const row = mk('div', 'icux-row', null, 'tip-line');
    row.append(mk('span', null, l.a, 'tip-line'));
    if (Array.isArray(l.b)) {
      const cells = mk('span', null, null, 'tip-line');
      l.b.forEach((x, i) => { if (i) cells.append(' / '); cells.append(mk('span', x.bad ? 'icux-neg' : null, x.t, 'tip-line')); });
      row.append(cells);
    } else row.append(mk('span', l.bad ? 'icux-neg' : null, l.b, 'tip-line'));
    return row;
  }
  function showTip(anchor) { tipAnchor = anchor; refreshTip(); }
  function hideTip() { tipAnchor = null; tip?.classList.remove('on'); }
  function refreshTip() {
    if (!tipAnchor) return;
    const lines = tipAnchor.isConnected ? tipLines(tipAnchor) : null;
    if (!lines) { hideTip(); return; }
    if (!tip) { tip = mk('div', 'icux-tip', null, 'tip'); tip.id = 'icux-tip'; tip.setAttribute('role', 'tooltip'); document.body.append(tip); }
    const sig = JSON.stringify(lines);
    if (tip.dataset.sig !== sig) { tip.dataset.sig = sig; tip.replaceChildren(...lines.map(lineEl)); }
    tip.classList.add('on');
    const r = tipAnchor.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    tip.style.top = r.bottom + 6 + 'px';
  }

  // ---- #3 presets 1 / 5 / 10 in the build and demolish dialogs --------------------------------------------------------
  function dialogKind(input) {
    let shell = false;
    for (let f = fiberOf(input); f; f = f.return) {
      if (typeof f.type !== 'function') continue;
      const p = f.memoizedProps ?? {};
      if (!shell) { shell = p.title !== undefined && !!p.onClose && !!p.actions && p.children !== undefined; continue; }
      if (p.onConfirm && p.building && p.assigned === undefined) return 'build';
      if (p.assigned !== undefined && p.available !== undefined) return 'demolish';
      return null; // sell dialog, land dialog, group assignment: not ours
    }
    return null;
  }
  const setInput = (input, n) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(n));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  function applyPresets() {
    for (const bulk of document.querySelectorAll('.modal-backdrop .field .stepper-bulk')) {
      let host = bulk.querySelector(':scope > .icux-presets');
      const input = bulk.closest('.field')?.querySelector('input[type=number]');
      if (!input || !dialogKind(input)) { host?.remove(); continue; }
      if (host) continue;
      host = mk('span', 'icux-presets', null, 'presets');
      for (const n of [1, 5, 10]) {
        const b = mk('button', null, String(n), 'preset');
        b.type = 'button';
        b.addEventListener('click', () => setInput(bulk.closest('.field').querySelector('input[type=number]'), n));
        host.append(b);
      }
      bulk.prepend(host);
    }
  }

  // ---- #5 owned filter, #6 held column, #8 net, #9 hide expiring + m:ss -----------------------------------------------
  let timer = 0;
  const tickSpans = () => {
    for (const s of document.querySelectorAll('.icux-mmss')) {
      const left = Number(s.dataset.icuxExp) - nowTick();
      if (left > 0) setText(s, icuxMath.mmss(left)); else s.remove();
    }
  };
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = 0; } };

  function syncToggle(controls, count, key, text, title) {
    let lab = controls.querySelector(':scope > .icux-toggle[data-icux="' + key + '"]');
    if (!lab) {
      lab = mk('label', 'icux-toggle', null, key);
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => { settings[key] = input.checked; saveSettings(); schedule(); });
      lab.append(input, mk('span', null, text, key + '-text'));
      controls.insertBefore(lab, count);
    }
    setAttr(lab, 'title', title);
    const input = lab.firstElementChild;
    if (input.checked !== !!settings[key]) input.checked = !!settings[key];
  }
  const gameLast = (tr) => [...tr.children].reverse().find((c) => !c.classList.contains('icux-col')) ?? null;
  const cellOf = (tr, key) => {
    let td = tr.querySelector(':scope > td.icux-' + key);
    if (!td) {
      td = mk('td', 'num icux-col icux-' + key, null, key);
      td.append(mk('span', 'icux-v', '', 'v')); // the cell's own span: another script may put nodes next to it, so never touch td.textContent
      tr.insertBefore(td, gameLast(tr)); // before the game's action cell: autosell (ic-autopilot) puts its button in tr.lastElementChild
    }
    return td;
  };
  const valueSpan = (td) => td.querySelector(':scope > .icux-v');

  function netCell(deal, item, fill, env, uiR, fuelValue) {
    if (deal.side !== 'Sell') return { text: '—', title: 'Only bids (you sell) are valued' };
    if (fill < 1) return { text: '—', title: 'Nothing to fill' };
    if (typeof item?.base_value !== 'number') return { text: '—', title: 'No base value' };
    const fr = item.intangible ? { money: 0, fuel: 0, md: 0, trucks: 0 }
      : icuxMath.freightFor(env, fill * Math.max(1, item.cargo_weight ?? 10), icuxMath.hops(uiR, deal.region));
    const r = icuxMath.net({ n: fill, price: deal.price, amount: deal.amount, baseValue: item.base_value, freight: fr, fuelValue });
    const lines = ['Selling ' + fill.toLocaleString() + ' of ' + deal.amount.toLocaleString() + ' (what you can fill) from ' + REGIONS[uiR],
      'Revenue ' + money(r.revenue), 'Goods at base value −' + money(r.goods)];
    if (r.cash > 0) lines.push('Courier overflow −' + money(r.cash));
    if (fr.trucks > 0) lines.push(fr.trucks + ' truck' + (fr.trucks > 1 ? 's' : '') + ', fuel ' + r.fuel.toLocaleString() + (fuelValue != null ? ' × ' + money(fuelValue) + ' = −' + money(r.fuelCost) : ''));
    if (fr.md > 0) lines.push('MD ' + fr.md.toLocaleString() + ' (not charged)');
    lines.push('Net ' + money(r.net));
    if (r.fuelUnvalued) lines.push('Fuel not valued: no base value');
    if (idx.items.get(deal.item)?.category === 'Goods') lines.push('Excl. quality bonus');
    return { text: money(r.net), title: lines.join('\n'), neg: r.net < 0 };
  }

  // ---- #12 optional columns: a Columns menu on the board controls; a column is hidden by its header label -----------
  // Labels are read from the game's header row each pass, so the menu follows whatever columns the board shows (ICUX's
  // Held and Net included). The choice is stored in settings.hiddenCols.
  const closeColumnMenus = () => {
    for (const m of document.querySelectorAll('.icux-colmenu.on')) {
      m.classList.remove('on');
      m.parentElement.querySelector(':scope > .icux-colbtn')?.setAttribute('aria-expanded', 'false');
    }
  };
  document.addEventListener('click', closeColumnMenus);
  // Header text without sort arrows or other glyphs: letters, digits and plain punctuation only.
  const colName = (th) => th.textContent.replace(/[^\p{L}\p{N}&%()./+ -]+/gu, ' ').replace(/\s+/g, ' ').trim();
  function applyColumns(controls, count, table, head) {
    let pick = controls.querySelector(':scope > .icux-colpick');
    if (!pick) {
      pick = mk('span', 'icux-colpick', null, 'colpick');
      const btn = mk('button', 'icux-colbtn', 'Columns', 'colbtn');
      btn.type = 'button';
      btn.setAttribute('aria-haspopup', 'true');
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = pick.querySelector(':scope > .icux-colmenu');
        const on = !menu.classList.contains('on');
        closeColumnMenus();
        menu.classList.toggle('on', on);
        btn.setAttribute('aria-expanded', String(on));
      });
      const menu = mk('div', 'icux-colmenu', null, 'colmenu');
      menu.addEventListener('click', (e) => e.stopPropagation()); // ticking a column must not close the menu
      pick.append(btn, menu);
      controls.insertBefore(pick, count);
    }
    const menu = pick.querySelector(':scope > .icux-colmenu');
    const names = [...new Set([...head.children].map(colName).filter(Boolean))];
    const sig = JSON.stringify(names);
    if (menu.dataset.sig !== sig) {
      menu.dataset.sig = sig;
      menu.replaceChildren(...names.map((name) => {
        const lab = mk('label', 'icux-colopt', null, 'colopt');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = name;
        input.addEventListener('change', () => {
          const rest = settings.hiddenCols.filter((n) => n !== name);
          settings.hiddenCols = input.checked ? rest : [...rest, name];
          saveSettings();
          schedule();
        });
        lab.append(input, mk('span', null, name, 'colopt-name'));
        return lab;
      }));
    }
    for (const input of menu.querySelectorAll('input')) {
      const checked = !settings.hiddenCols.includes(input.value);
      if (input.checked !== checked) input.checked = checked;
    }
    const hidden = new Set(settings.hiddenCols);
    const hideAt = [...head.children].map((th) => hidden.has(colName(th)));
    for (const row of table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr')) {
      const cells = [...row.children];
      if (cells.length !== hideAt.length) continue; // colspan rows (empty or loading states) stay as they are
      cells.forEach((cell, i) => cell.toggleAttribute('data-icux-hide', hideAt[i]));
    }
  }

  function applyBoard(c) {
    const controls = [...document.querySelectorAll('.board-controls')].find((el) => boardProps(el));
    if (!controls) { stopTimer(); return; }
    const bp = boardProps(controls);
    const st = bp.display ?? c.st;
    const cat = bp.catalog ?? c.catalog;
    seeTick(bp.serverTick);
    const count = controls.querySelector(':scope > .board-count');
    syncToggle(controls, count, 'ownedOnly', 'Only items I hold', 'Show only bids for items you hold in this region. Sees only the rows the board has loaded.');
    syncToggle(controls, count, 'hideExpired', 'Hide expiring (<5 min)', 'Hide contracts with less than 5 minutes left');
    let hiddenEl = controls.querySelector(':scope > .icux-hidden-count');
    if (!hiddenEl) { hiddenEl = mk('span', 'muted icux-hidden-count', '', 'hidden'); controls.insertBefore(hiddenEl, count); }

    const board = controls.parentElement;
    const table = board.querySelector(':scope > .table-bleed .market-table');
    const bleed = table?.closest('.table-bleed');
    if (table && !timer) timer = setInterval(tickSpans, 1000);
    if (!table) stopTimer();

    const uiR = uiRegion(), tick = nowTick();
    const env = icuxMath.freightEnv(st, uiR, bp.haulage?.hires, tick);
    const items = index(cat).items;
    const fuelItemValue = items.get(FUEL_ITEM)?.base_value;
    const fuelValue = typeof fuelItemValue === 'number' ? fuelItemValue : undefined;
    const deals = new Map(bp.market.map((d) => [String(d.id), d]));
    const head = table?.querySelector('thead > tr');
    if (head) {
      if (!head.querySelector(':scope > th.icux-held')) head.insertBefore(mk('th', 'num icux-col icux-held', 'Held', 'held-head'), gameLast(head));
      if (!head.querySelector(':scope > th.icux-net')) head.insertBefore(mk('th', 'num icux-col icux-net', 'Net', 'net-head'), gameLast(head));
      setAttr(head.querySelector(':scope > th.icux-held'), 'title', 'Units of this item you hold in the region shown in the top bar');
      setAttr(head.querySelector(':scope > th.icux-net'), 'title', 'Profit if you fill what you can: revenue, minus goods at base value, courier cash and fuel. Hover a value for the breakdown');
    }
    const rows = table ? [...table.querySelectorAll('tbody > tr')] : [];
    let hidden = 0;
    for (const tr of rows) {
      const deal = deals.get(String(fiberKey(tr)));
      if (!deal) continue;
      const bid = deal.side === 'Sell';
      const have = icuxMath.held(st, uiR, deal.item);
      const fill = Math.min(have, deal.amount);

      const hide = (settings.ownedOnly && !(bid && have >= 1)) || (settings.hideExpired && tick > 0 && deal.expires_at - tick < EXPIRING_TICKS);
      if (hide) hidden++;
      tr.toggleAttribute('data-icux-hide', hide);

      const held = cellOf(tr, 'held');
      setText(valueSpan(held), bid ? have.toLocaleString() + (fill > 0 && fill < deal.amount ? ' · fill ' + fill.toLocaleString() : '') : '—');
      held.classList.toggle('muted', !bid || have === 0);

      const nc = netCell(deal, items.get(deal.item), fill, env, uiR, fuelValue);
      const net = cellOf(tr, 'net');
      setText(valueSpan(net), nc.text);
      setAttr(net, 'title', nc.title);
      net.classList.toggle('icux-neg', !!nc.neg);

      const exp = tr.children[5]; // Expires: the board's column order is fixed in the game
      const left = deal.expires_at - tick;
      let span = exp?.querySelector(':scope > .icux-mmss');
      if (exp && tick > 0 && left > 0 && left < EXPIRING_TICKS) {
        if (!span) { span = mk('span', 'icux-mmss', '', 'mmss'); exp.append(span); }
        span.dataset.icuxExp = String(deal.expires_at);
        setText(span, icuxMath.mmss(left));
      } else span?.remove();
    }

    setText(hiddenEl, hidden > 0 ? '· ' + hidden + ' hidden by ICUX' : '');
    const all = rows.length > 0 && hidden === rows.length;
    let empty = board.querySelector(':scope > .icux-empty');
    if (all && bleed) {
      if (!empty) { empty = mk('div', 'empty icux-empty', '', 'empty'); bleed.before(empty); }
      setText(empty, settings.ownedOnly ? 'No bids for items you hold in ' + REGIONS[uiR] + (settings.hideExpired ? ' that last 5 minutes or more' : '') : 'Every contract is hidden by the ICUX filters');
    } else empty?.remove();
    bleed?.toggleAttribute('data-icux-hide', all);
    if (table && head) applyColumns(controls, count, table, head);
  }

  // ---- observer -----------------------------------------------------------------------------------------------------
  const FEATURES = [applyLand, applyMax, applyBuildingRows, applyPresets, applyBoard];
  function pass() {
    watchChrome();
    ctx = walk();
    if (!ctx.st || !ctx.catalog) return;
    index(ctx.catalog);
    for (const f of FEATURES) { try { f(ctx); } catch (e) { console.error('[icux]', f.name, e); } }
    refreshTip();
  }
  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; pass(); }); }

  const own = (n) => !!(n.nodeType === 1 ? n : n.parentElement)?.closest('[data-icux]');
  const relevant = (r) => !own(r.target) && !(r.type === 'childList' && r.addedNodes.length + r.removedNodes.length > 0 && [...r.addedNodes, ...r.removedNodes].every(own));
  const observer = new MutationObserver((recs) => { if (recs.some(relevant)) schedule(); });

  const style = mk('style', null, CSS, 'css');
  style.id = 'icux-css';
  document.head.append(style);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  window.icux = {
    version: VERSION, math: icuxMath, settings, refresh: schedule,
    _unload() {
      observer.disconnect();
      stopTimer();
      cancelAnimationFrame(raf);
      for (const el of document.querySelectorAll('[data-icux]')) el.remove();
      for (const el of document.querySelectorAll('[data-icux-hide]')) el.removeAttribute('data-icux-hide');
      document.removeEventListener('click', closeColumnMenus);
      chromeRO?.disconnect();
      if (chromeEl) document.documentElement.style.setProperty('--chrome-h', chromeEl.getBoundingClientRect().height + 'px');
      delete window.icux;
    },
  };
  schedule();
})();
