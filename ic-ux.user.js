// ==UserScript==
// @name         ICUX
// @namespace    https://github.com/mahardikamaulana
// @version      0.6.0
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

    // Steady profit of one production group while it runs, in cents per hour. Items are valued at base value, as the game's card
    // values a recipe: runs per wave = buildings x floorplan rate, and the wave is the recipe's ticks shortened by the modules' speed
    // (report: the engine's moduleReport; its inputs_pct and outputs_pct scale what a run eats and makes). Power and water cost the
    // grid price ($10 per MW and $4 per kL per 10-minute bill) for every building's draw plus each run's recipe draw, as the
    // game counts load; power or water a recipe generates is credited at the same price (a day/night generator at its daily mean).
    // value(item) -> cents, or not a number when the item has no base value: such items are left out and listed in unvalued.
    const TICKS_H = 7200;
    const UTIL_PER_H = { power: 6000, water: 2400 };
    const DAY_MEAN = (21600 + 7200 * 0.25) / 28800; // full output for 21,600 of 28,800 ticks, 25% at night
    const groupProfit = ({ count, recipe, building, rate = 1, report, value, powerMult = 1 }) => {
      if (!(recipe?.ticks > 0) || !(count > 0)) return null;
      const ticks = Math.max(1, Math.floor((recipe.ticks * 100) / (100 + (report?.speed ?? 0))));
      const runs = count * rate, runsH = (runs * TICKS_H) / ticks;
      const unvalued = new Set();
      const worth = (list, pct) => list.reduce((a, x) => {
        const v = value(x.item);
        if (typeof v !== 'number') { unvalued.add(x.item); return a; }
        return a + (x.amount * pct * v * runsH) / 100;
      }, 0);
      const drawPct = report?.draws_pct ?? 100;
      const outputs = worth(recipe.outputs ?? [], report?.outputs_pct ?? 100);
      const inputs = worth(recipe.inputs ?? [], report?.inputs_pct ?? 100);
      const util = {};
      for (const u of ['power', 'water']) {
        const draw = ((building?.draws?.[u] ?? 0) * count + (recipe.draws?.[u] ?? 0) * runs) * (drawPct / 100); // draws_pct scales every draw
        const made = (recipe.generates?.[u] ?? 0) * runs * (recipe.diurnal ? DAY_MEAN : 1);
        const price = UTIL_PER_H[u] * (u === 'power' ? powerMult : 1);
        util[u] = { draw, made, cost: draw * price, credit: made * price };
      }
      const perH = outputs - inputs - util.power.cost - util.water.cost + util.power.credit + util.water.credit;
      return { perH: Math.round(perH), outputs, inputs, power: util.power, water: util.water, ticks, runsH, unvalued: [...unvalued] };
    };

    return { held, inRegion, ownedCount, hops, nextCosts, freeLand, maxAssign, allowance, fuelTrip, refinerCut, freeTrucks, courierCap, mdCost, freight, freightEnv, freightFor, net, mmss, groupProfit };
  })();
// icuxMath:end

  // ---- shared plumbing ----------------------------------------------------------------------------------------------
  const VERSION = '0.6.0';
  const REGIONS = ['Heartland', 'Industrial Basin', 'Coastal Cities', 'Frontier'];
  const FUEL_ITEM = 60;
  const EXPIRING_TICKS = 600; // the game's own expires-soon threshold
  const SETTINGS_KEY = 'icux.settings';

  const store = (() => { try { return window.localStorage ?? null; } catch { return null; } })();
  const settings = { ownedOnly: false, hideExpired: false, hiddenColumns: {}, groupProfit: true };
  try { Object.assign(settings, JSON.parse(store?.getItem(SETTINGS_KEY) ?? '{}')); } catch {}
  if (!settings.hiddenColumns || typeof settings.hiddenColumns !== 'object' || Array.isArray(settings.hiddenColumns)) settings.hiddenColumns = {};
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
    const out = { ws: null, st: null, catalog: null, engine: null };
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer'));
    if (!key) return out;
    const seen = new Set(), stack = [root[key]];
    while (stack.length && !(out.ws && out.st && out.catalog && out.engine)) {
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
      if (p && p.catalog?.techs && !out.catalog) out.catalog = p.catalog; // pass() needs it: without it no feature runs
      if (p && p.engine && typeof p.engine.moduleReport === 'function' && !out.engine) out.engine = p.engine; // the group card's module report
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
    '.icux-gp{margin-right:.5rem;font-size:12.5px;color:var(--ink-2);white-space:nowrap;font-variant-numeric:tabular-nums;align-self:center}',
    '.icux-gp.icux-neg{color:var(--status-crit);font-weight:600}',
    '.icux-gp.muted{color:var(--muted)}',
    '.icux-colbtn[aria-pressed="true"]{color:var(--accent)}',
    '.icux-techsearch{margin-left:auto;width:200px;max-width:45vw}',
    '.icux-techcount{margin-left:.5rem;font-size:.85rem;white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.tech-node[data-icux-dim]{opacity:.3}',
    '.tech-node[data-icux-match]{outline:2px solid var(--accent);outline-offset:2px}',
    '.icux-ship{margin-right:4px}',
    '.icux-colpick{position:relative;display:flex;justify-content:flex-end;margin:0 0 2px}',
    '.icux-colbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:none;color:var(--muted);line-height:1;cursor:pointer}',
    '.icux-colbtn:hover:not(:disabled),.icux-colbtn[aria-expanded="true"]:not(:disabled){background:var(--surface-2);color:var(--ink)}',
    '.icux-colbtn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}',
    '.icux-colbtn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round}',
    '.icux-colmenu{display:none;position:absolute;right:0;top:calc(100% + 4px);z-index:50;min-width:170px;padding:.3rem;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow)}',
    '.icux-colmenu.on{display:block}',
    '.icux-colopt{display:flex;align-items:center;gap:.5rem;padding:.3rem .5rem;font-size:13px;color:var(--ink-2);white-space:nowrap;cursor:pointer;border-radius:6px}',
    '.icux-colopt:hover{background:var(--surface-3);color:var(--ink)}',
    '.icux-colopt input{width:14px;height:14px;flex:none;margin:0;padding:0;border:0;background:none;accent-color:var(--accent)}',
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

  // ---- #10 post an order: selling lists only items in stock -----------------------------------------------------------
  function applyPostOrder(c) {
    const input = document.getElementById('order-item');
    if (!input) return;
    const selling = input.closest('.modal-backdrop')?.querySelector('.seg')?.firstElementChild?.getAttribute('aria-pressed') === 'true'; // the game's side order is Sell, Buy
    const r = propsUp(input, 'region') ?? uiRegion();
    const inStock = (item) => icuxMath.held(c.st, r, item) > 0;
    // the picker's props (value, options, onChange) belong to the game's own component: calling onChange is the same as picking a row
    const picker = fiberUp(input, (p) => Array.isArray(p.options) && typeof p.onChange === 'function');
    if (selling && picker && !inStock(picker.value)) {
      const pick = picker.options.find((o) => inStock(o.value));
      if (pick) picker.onChange(pick.value);
    }
    const list = document.getElementById(input.getAttribute('aria-controls'));
    if (!list) return;
    const rows = [...list.querySelectorAll('.option-pick-row')];
    for (const row of rows) {
      const item = Number(fiberKey(row));
      row.toggleAttribute('data-icux-hide', selling && !inStock(item));
    }
    // every rendered row hidden: the popover would be blank, so say why (nothing held, or only unstocked matches)
    const none = selling && rows.length > 0 && rows.every((row) => row.hasAttribute('data-icux-hide'));
    const note = list.querySelector(':scope > .icux-empty');
    if (none) {
      const text = !picker || !picker.options.some((o) => inStock(o.value)) ? 'You hold nothing to sell' : 'No stocked matches';
      if (note) setText(note, text); else list.prepend(mk('div', 'option-pick-empty icux-empty', text, 'empty'));
    } else note?.remove();
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

  // ---- #12 optional columns: a Columns menu above every in-game table; a column is hidden by its header label -----------
  // Labels are read from each table's header row on every pass, so the menu follows whatever the table shows (ICUX's Held
  // and Net included). Choices are kept per table, keyed by its header labels, in settings.hiddenColumns.
  const closeColumnMenus = () => {
    for (const m of document.querySelectorAll('.icux-colmenu.on')) {
      m.classList.remove('on');
      m.parentElement.querySelector(':scope > .icux-colbtn')?.setAttribute('aria-expanded', 'false');
    }
  };
  document.addEventListener('click', closeColumnMenus);
  // Header text without sort arrows or other glyphs: letters, digits and plain punctuation only.
  const colName = (th) => th.textContent.replace(/[^\p{L}\p{N}&%()./+ -]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const colPicks = new WeakMap(); // table -> its Columns control, placed just above the table
  function colPickFor(table) {
    const old = colPicks.get(table);
    if (old?.isConnected && old.nextElementSibling === table) return old;
    const pick = mk('div', 'icux-colpick', null, 'colpick');
    const btn = mk('button', 'icux-colbtn', null, 'colbtn');
    btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="3" height="11" rx="1"/><rect x="6.5" y="2.5" width="3" height="11" rx="1"/><rect x="11" y="2.5" width="3" height="11" rx="1"/></svg>';
    btn.title = 'Columns';
    btn.setAttribute('aria-label', 'Columns');
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
    table.parentElement.insertBefore(pick, table);
    colPicks.set(table, pick);
    return pick;
  }
  function applyColumns(table, head) {
    const names = [...new Set([...head.children].map(colName).filter(Boolean))];
    if (names.length < 2) { colPicks.get(table)?.remove(); return null; } // one column has nothing to choose between
    const key = JSON.stringify(names);
    const pick = colPickFor(table);
    const menu = pick.querySelector(':scope > .icux-colmenu');
    if (menu.dataset.sig !== key) {
      menu.dataset.sig = key;
      menu.replaceChildren(...names.map((name) => {
        const lab = mk('label', 'icux-colopt', null, 'colopt');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = name;
        input.addEventListener('change', () => {
          const rest = (settings.hiddenColumns[key] ?? []).filter((n) => n !== name);
          settings.hiddenColumns = { ...settings.hiddenColumns, [key]: input.checked ? rest : [...rest, name] };
          saveSettings();
          schedule();
        });
        lab.append(input, mk('span', null, name, 'colopt-name'));
        return lab;
      }));
    }
    const hidden = settings.hiddenColumns[key] ?? [];
    for (const input of menu.querySelectorAll('input')) {
      const checked = !hidden.includes(input.value);
      if (input.checked !== checked) input.checked = checked;
    }
    const hideAt = [...head.children].map((th) => hidden.includes(colName(th)));
    for (const row of table.rows) {
      const cells = [...row.children];
      if (cells.length !== hideAt.length) continue; // colspan rows (empty or loading states) stay as they are
      cells.forEach((cell, i) => cell.toggleAttribute('data-icux-hide', hideAt[i]));
    }
    return pick;
  }
  // ICUX's own tables, ic-autopilot's control panel, tooltips and menus get no Columns menu (its Auto ship jobs table does).
  const ownTable = (table) => !!table.closest('[data-icux], .idc-panel, .idc-chip, [role="tooltip"], [role="menu"]');
  function applyTables() {
    const claimed = new Set();
    for (const table of document.querySelectorAll('table')) {
      const head = table.tHead?.rows[0];
      if (ownTable(table) || !head) { colPicks.get(table)?.remove(); continue; }
      const pick = applyColumns(table, head);
      if (pick) claimed.add(pick);
    }
    // When React swaps a table for a new element, the old pick stays behind: keep only the picks of tables on the page.
    for (const pick of document.querySelectorAll('.icux-colpick')) if (!claimed.has(pick)) pick.remove();
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
      setText(valueSpan(held), bid ? have.toLocaleString() : '—');
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
  }

  // ---- #13 profit per group: $/h on every group card, after inputs, power and water --------------------------------------
  // The card's own props give the group, catalog and display state. The engine (module report, world event) comes from walk():
  // the Priority list's card is not passed it, so it is read from the fiber tree like the socket.
  const cardProps = (el) => fiberUp(el, (p) => typeof p.groupId === 'number' && p.group && p.catalog && p.display);
  const PROFIT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M10 6c-.4-.6-1.1-.9-2-.9-1.1 0-1.9.6-1.9 1.4 0 1.9 3.9 1 3.9 3 0 .8-.8 1.4-2 1.4-.9 0-1.6-.3-2-.9M8 3.6v1.5M8 10.9v1.5"/></svg>';
  const reports = new WeakMap(); // engine -> Map(building + modules -> module report)
  function moduleReport(engine, g) {
    if (typeof engine?.moduleReport !== 'function') return null;
    let cache = reports.get(engine);
    if (!cache) { cache = new Map(); reports.set(engine, cache); }
    const mods = JSON.stringify(g.modules ?? {}), key = g.building + '|' + mods;
    if (!cache.has(key)) { try { cache.set(key, JSON.parse(engine.moduleReport(g.building, mods))); } catch { cache.set(key, null); } }
    return cache.get(key);
  }
  // The NPC power price multiplier of a world event (the client's event chip reads engine.worldEventAt the same way); 1 when none.
  function powerMult(engine, tick) {
    try {
      const ev = tick > 0 && typeof engine?.worldEventAt === 'function' ? JSON.parse(engine.worldEventAt(tick)) : null;
      return ev?.outage && Number.isFinite(ev.percent) ? Math.max(0, (100 + ev.percent) / 100) : 1;
    } catch { return 1; }
  }
  function profitOf(g, { catalog, display, engine, tick }) {
    const recipe = g.recipe == null ? null : display.recipes?.[String(g.recipe)] ?? (catalog.recipes ?? []).find((r) => r.id === g.recipe) ?? null;
    if (!recipe) return null;
    const { items, buildings } = index(catalog);
    const mult = powerMult(engine, tick);
    const r = icuxMath.groupProfit({
      count: g.count, recipe, building: buildings.get(g.building), rate: display.layouts?.[String(recipe.id)]?.fx?.rate ?? 1,
      report: moduleReport(engine, g), value: (id) => items.get(id)?.base_value, powerMult: mult,
    });
    return r && { ...r, paused: !!g.paused, powerMult: mult, recipe };
  }
  const perHour = (c) => (c < 0 ? '−$' : '$') + Math.round(Math.abs(c) / 100).toLocaleString() + '/h';
  function profitTitle(r) {
    const name = (id) => idx.items.get(id)?.name ?? '#' + id;
    const lines = [(r.paused ? 'Paused: earns nothing now. While running, ' : 'While running, ') + 'per hour, items at base value',
      'Outputs +' + money(r.outputs), 'Inputs −' + money(r.inputs)];
    for (const [u, unit] of [['power', 'MW'], ['water', 'kL']]) {
      const x = r[u];
      if (x.draw > 0) lines.push(u[0].toUpperCase() + u.slice(1) + ' ' + x.draw.toLocaleString() + ' ' + unit + ' −' + money(x.cost));
      if (x.made > 0) lines.push(u[0].toUpperCase() + u.slice(1) + ' made ' + (Math.round(x.made * 10) / 10).toLocaleString() + ' ' + unit + ' +' + money(x.credit));
    }
    lines.push('Net ' + perHour(r.perH), (Math.round(r.runsH * 10) / 10).toLocaleString() + ' runs/h, wave ' + (r.ticks / 2).toLocaleString() + ' s');
    if (r.powerMult !== 1) lines.push('Power at the event price x' + r.powerMult);
    if (r.unvalued.length) lines.push('Not valued (no base value): ' + r.unvalued.map(name).join(', '));
    return lines.join('\n');
  }
  function applyGroupProfit(c) {
    const head = document.querySelector('.drag-wrap[data-group-id]')?.closest('section.panel')?.querySelector(':scope > .panel-head');
    let btn = document.querySelector('.icux-gpbtn');
    if (head && btn?.parentElement !== head) {
      btn?.remove();
      btn = mk('button', 'icux-colbtn icux-gpbtn', null, 'gpbtn');
      btn.innerHTML = PROFIT_ICON;
      btn.type = 'button';
      btn.title = 'Profit per hour';
      btn.setAttribute('aria-label', 'Profit per hour');
      btn.addEventListener('click', () => { settings.groupProfit = !settings.groupProfit; saveSettings(); schedule(); });
      head.insertBefore(btn, head.querySelector(':scope > .view-toggle'));
    } else if (!head) btn?.remove();
    if (btn?.isConnected) setAttr(btn, 'aria-pressed', String(!!settings.groupProfit));

    for (const actions of document.querySelectorAll('.worker-collapsed > .head-actions, .worker-row-head > .head-actions, .worker-head > .head-actions')) {
      let cell = actions.querySelector(':scope > .icux-gp');
      const p = settings.groupProfit ? cardProps(actions) : null;
      const r = p && profitOf(p.group, { catalog: p.catalog, display: p.display, engine: c.engine, tick: nowTick() });
      if (!r) { cell?.remove(); continue; }
      if (!cell) { cell = mk('span', 'icux-gp', '', 'gp'); actions.prepend(cell); }
      const loss = r.perH < 0 && r.unvalued.length === 0; // an unvalued output could be what pays: no flag then
      setText(cell, (loss ? '⚠ ' : r.unvalued.length ? '≈ ' : '') + perHour(r.perH));
      setAttr(cell, 'title', profitTitle(r));
      cell.classList.toggle('icux-neg', loss);
      cell.classList.toggle('muted', r.paused);
    }
  }
  // The same figure for other scripts (Core plan's rebalancing can read it): null without a recipe or buildings.
  function groupProfitById(id) {
    const c = walk(), g = c.st?.groups?.[id];
    return g && c.catalog ? profitOf(g, { catalog: c.catalog, display: c.st, engine: c.engine, tick: nowTick() }) : null;
  }

  // ---- #14 research search: a search box on the Construction research panel ----------------------------------------------
  // Matches are lit and the rest dimmed; typing centres the first match, Enter / Shift+Enter the next / previous one. Centring
  // uses the game's own setTechFocus (the tree re-centres when the focused building changes).
  let techQuery = '', techPick = -1;
  const fiberWith = (el, test) => { for (let f = fiberOf(el); f; f = f.return) if (f.memoizedProps && test(f.memoizedProps)) return f; return null; };
  const nodeBuilding = (node) => fiberUp(node, (p) => typeof p.buildingId === 'number' && p.pos !== undefined)?.buildingId;
  const techMatches = (wrap) => {
    const q = techQuery.trim().toLowerCase();
    return q ? [...wrap.querySelectorAll('.tech-node')].filter((n) => (n.querySelector('.tech-node-title')?.textContent ?? '').toLowerCase().includes(q)) : [];
  };
  function focusTech(wrap, dir) {
    const hits = techMatches(wrap).map(nodeBuilding).filter((id) => typeof id === 'number');
    if (!hits.length) return;
    techPick = ((techPick + dir) % hits.length + hits.length) % hits.length;
    const app = fiberUp(wrap, (p) => typeof p.setTechFocus === 'function');
    if (!app) return;
    const id = hits[techPick];
    if (app.techFocus === id) { app.setTechFocus(null); requestAnimationFrame(() => app.setTechFocus(id)); } // same id: the tree only moves on a change
    else app.setTechFocus(id);
  }
  function applyTechSearch() {
    const wrap = document.querySelector('.tech-wrap');
    const head = wrap?.closest('.panel')?.querySelector(':scope > .panel-head');
    if (!head) return;
    let box = head.querySelector(':scope > .icux-techsearch');
    if (!box) {
      box = mk('input', 'icux-techsearch', null, 'techsearch');
      box.type = 'search';
      box.placeholder = 'Search buildings';
      box.setAttribute('aria-label', 'Search buildings in the tree');
      box.value = techQuery;
      box.addEventListener('input', () => { techQuery = box.value; techPick = -1; schedule(); const w = document.querySelector('.tech-wrap'); if (w) focusTech(w, 1); });
      box.addEventListener('keydown', (e) => {
        e.stopPropagation(); // the game's hotkeys must not see typing
        const w = document.querySelector('.tech-wrap');
        if (e.key === 'Enter' && w) { e.preventDefault(); focusTech(w, e.shiftKey ? -1 : 1); }
        if (e.key === 'Escape') { box.value = ''; techQuery = ''; techPick = -1; schedule(); }
      });
      head.append(box, mk('span', 'muted icux-techcount', '', 'techcount'));
    }
    const hits = new Set(techMatches(wrap));
    const on = techQuery.trim() !== '';
    for (const node of wrap.querySelectorAll('.tech-node')) { // attributes, not classes: React rewrites the node's className
      node.toggleAttribute('data-icux-match', on && hits.has(node));
      node.toggleAttribute('data-icux-dim', on && !hits.has(node));
    }
    setText(head.querySelector(':scope > .icux-techcount'), on ? hits.size + (hits.size === 1 ? ' match' : ' matches') : '');
  }

  // ---- #15 Ship: a Ship button on each inventory row opens the game's "Ship to Exchange" dialog for that item ---------------
  // It calls the row's own Sell handler, then moves the Sell dialog that opens to its "Ship to Exchange" step (the dialog's
  // first state, null until a step is picked). Nothing is sent: the game's dialog still asks for the amount and the price.
  let pendingShip = null; // { item, at }
  const rowProps = (tr) => { const p = tr && fiberOf(tr)?.return?.memoizedProps; return p && typeof p.onSell === 'function' && typeof p.item?.id === 'number' ? p : null; }; // the <tr> is the row component's root
  function applyShip() {
    for (const tr of document.querySelectorAll('tr:has(> td > button.item-link)')) {
      const row = rowProps(tr);
      if (!row) continue;
      const sell = tr.lastElementChild?.querySelector('button:not([data-icux])');
      if (!sell) continue;
      let b = sell.parentElement.querySelector(':scope > .icux-ship');
      if (!b) {
        b = mk('button', 'mini icux-ship', 'Ship', 'ship');
        b.type = 'button';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const p = rowProps(b.closest('tr'));
          if (!p || b.disabled) return;
          pendingShip = { item: p.item.id, at: Date.now() };
          p.onSell();
          schedule();
        });
        sell.before(b);
      }
      b.disabled = sell.disabled;
      setAttr(b, 'title', 'Ship ' + (row.item.name ?? 'this item') + ' to the Exchange and list it at your price');
    }
    if (!pendingShip) return;
    if (Date.now() - pendingShip.at > 1500) { pendingShip = null; return; } // never turn a later Sell click into Ship
    for (const m of document.querySelectorAll('.modal-backdrop')) {
      const f = fiberWith(m, (p) => p.item === pendingShip.item && Array.isArray(p.market) && p.starred !== undefined && typeof p.onClose === 'function' && p.deal === undefined);
      const hook = f?.memoizedState;
      if (hook?.queue?.dispatch && hook.memoizedState === null) { hook.queue.dispatch('list'); pendingShip = null; return; }
    }
  }

  // ---- observer -----------------------------------------------------------------------------------------------------
  const FEATURES = [applyLand, applyMax, applyBuildingRows, applyPresets, applyPostOrder, applyBoard, applyTables, applyGroupProfit, applyTechSearch, applyShip];
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
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-pressed'] });

  window.icux = {
    version: VERSION, math: icuxMath, settings, refresh: schedule, groupProfit: groupProfitById,
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
