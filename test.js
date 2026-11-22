// Self-checks for the pure math in ic-ux.user.js (run: bun test.js). Fixtures are hand-written, not live data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./ic-ux.user.js', import.meta.url), 'utf8').split('\n');
const a = src.findIndex((l) => l === '// icuxMath:begin');
const b = src.findIndex((l) => l === '// icuxMath:end');
assert.ok(a >= 0 && b > a, 'icuxMath block markers not found');
const m = new Function(src.slice(a + 1, b).join('\n') + '\nreturn icuxMath;')();

// hops: the hex distance between regions 0..3, plus the start tile
assert.equal(m.hops(0, 0), 1);
assert.equal(m.hops(0, 1), 2);
assert.equal(m.hops(0, 3), 4); // Frontier -> Heartland: 4 hops
assert.equal(m.hops(3, 0), 4);
assert.equal(m.hops(1, 2), 4);

// freight: within the free allowance nothing is charged
assert.deepEqual(m.freight({ cargo: 8000, allow: 10000, hops: 2, cut: 0, freeTrucks: 3 }),
  { trucks: 0, money: 0, fuel: 0, md: 0, forced: false });
// courier forced (no free truck) with plenty of MD and money: the overflow is paid in cash, $0.05 per CU per hop
const paid = m.freight({ cargo: 20000, allow: 10000, hops: 1, cut: 0, freeTrucks: 0, md: 1000, money: 1e9 });
assert.equal(paid.trucks, 0);
assert.equal(paid.money, (20000 - 10000) * 5 * 1);
assert.equal(paid.md, 34); // ceil(10000 / 300)
// courier forced but no MD or money: capacity stays at the allowance, so it falls back to trucks
assert.equal(m.freight({ cargo: 20000, allow: 10000, hops: 1, cut: 0, freeTrucks: 0 }).trucks, 1);
// trucks: 120000 CU = 3 trucks; fuel per trip = floor(5 * 4 * 90 / 100) = 18
assert.deepEqual(m.freight({ cargo: 120000, allow: 10000, hops: 4, cut: 10, freeTrucks: 3 }),
  { trucks: 3, money: 0, fuel: 3 * Math.floor((5 * 4 * (100 - 10)) / 100), md: 0, forced: false });
assert.equal(m.fuelTrip(4, 10), 18);
assert.equal(m.courierCap(10000, 1000, 1e9, 1), 77225);
assert.equal(m.allowance(0), 10000);
assert.equal(m.allowance(99), 50000);

// free trucks: capped by depots, trucks out and hired out, and by the fuel for one trip each
assert.equal(m.freeTrucks({ trucks: 10, depots: 2, out: 3, hiredOut: 1, fuel: 100, trip: 18 }), 4);
assert.equal(m.freeTrucks({ trucks: 10, depots: 2, out: 3, hiredOut: 1, fuel: 30, trip: 18 }), 1);
assert.equal(m.freeTrucks({ trucks: 0, depots: 2, out: 0, hiredOut: 0, fuel: 100, trip: 18 }), 0);

// account-level items (money 0, MD 25) are not in stock; the refiner cut is capped at 50
const st = {
  items: { 0: 123456, 25: 40 },
  stock: { 0: { 59: 6, 60: 200, 7: 9 }, 1: { 7: 2 } },
  building_pool: { 0: { 1: 3, 2: 1, 13: 1 }, 1: { 1: 2 } },
  groups: {
    7: { building: 1, region: 0, count: 4 },
    8: { building: 2, region: 1, count: 2 },
    9: { building: 2, count: 1 }, // no region means region 0
    10: { building: 13, region: 0, count: 1 },
  },
  land_bought: { 0: 5, 1: 10 },
  courier_levels: { capacity: 2 },
  shipments: [{ from_region: 0, trucks: 1 }, { trucks: 1 }, { from_region: 1, trucks: 5 }],
  fleet_modules: [1, 2, 3],
  module_defs: { 1: { kind: 62, inputs_bonus: -30 }, 2: { kind: 62, inputs_bonus: -40 }, 3: { kind: 61, inputs_bonus: -90 } },
  ssi: { corp_id: 77 },
};
assert.equal(m.held(st, 0, 0), 123456);
assert.equal(m.held(st, 1, 25), 40);
assert.equal(m.held(st, 0, 7), 9);
assert.equal(m.held(st, 1, 7), 2);
assert.equal(m.held(st, 2, 7), 0);
assert.equal(m.refinerCut(st), 50);
assert.equal(m.refinerCut({}), 0);
assert.equal(m.ownedCount(st, 1), 3 + 2 + 4);
assert.equal(m.ownedCount(st, 2), 1 + 2 + 1);
const env = m.freightEnv(st, 0, [{ hauler: 77, region: 0, until: 100, trucks: 2 }, { hauler: 77, region: 0, until: 5, trucks: 9 }, { hauler: 1, region: 0, until: 100, trucks: 9 }], 50);
assert.deepEqual(env, { allow: 20000, cut: 50, md: 40, money: 123456, trucks: 6, depots: 2, fuel: 200, out: 2, hiredOut: 2 });

// nextCosts: unit(k) = floor(cost * (20 + owned + k) / 20)
assert.deepEqual(m.nextCosts(1000, 31), { next: 2550, five: 2550 + 2600 + 2650 + 2700 + 2750, ten: 27750 });
assert.equal(m.nextCosts(1000, 31).five, 13250);
assert.equal(m.nextCosts(1003, 0).next, 1003 * 20 / 20);
assert.equal(m.nextCosts(1003, 1).next, Math.floor(1003 * 21 / 20)); // floors per unit, not per sum
assert.equal(m.nextCosts(7, 0).five, [0, 1, 2, 3, 4].reduce((s, k) => s + Math.floor(7 * (20 + k) / 20), 0));

// freeLand: Heartland grant 25 + bought, minus acres of pool and group buildings in that region
const buildings = [{ id: 1, acres: 2 }, { id: 2, acres: 3 }, { id: 13, acres: 1 }];
assert.deepEqual(m.freeLand(st, buildings, 0), { owned: 30, used: 2 * (3 + 4) + 3 * (1 + 1) + 1 * (1 + 1), free: 30 - 22 });
assert.deepEqual(m.freeLand(st, buildings, 1), { owned: 10, used: 2 * 2 + 3 * 2, free: 0 });
assert.deepEqual(m.freeLand(st, buildings, 2), { owned: 0, used: 0, free: 0 });

// maxAssign: the pool of the group's own region
assert.equal(m.maxAssign(st, 7), 3);
assert.equal(m.maxAssign(st, 8), 0);
assert.equal(m.maxAssign(st, 9), 1);
assert.equal(m.maxAssign(st, 999), 0);

// net: a missing base value is never read as 0
assert.equal(m.net({ n: 10, price: 5000, amount: 20, baseValue: undefined, freight: { money: 0, fuel: 0 } }), null);
assert.equal(m.net({ n: 0, price: 5000, amount: 20, baseValue: 100 }), null);
const n1 = m.net({ n: 10, price: 5000, amount: 20, baseValue: 100, freight: { money: 200, fuel: 5 }, fuelValue: 20 });
assert.deepEqual(n1, { revenue: 2500, goods: 1000, cash: 200, fuel: 5, fuelCost: 100, fuelUnvalued: false, net: 1200 });
assert.equal(m.net({ n: 20, price: 5001, amount: 20, baseValue: 0 }).revenue, 5001); // whole lot: the full price
assert.equal(m.net({ n: 7, price: 1001, amount: 20, baseValue: 0 }).revenue, Math.floor(1001 * 7 / 20));
const n2 = m.net({ n: 1, price: 10, amount: 1, baseValue: 1, freight: { money: 0, fuel: 3 } });
assert.equal(n2.fuelUnvalued, true);
assert.equal(n2.net, 9);
assert.ok(m.net({ n: 1, price: 10, amount: 1, baseValue: 50 }).net < 0);

// mmss: 2 ticks per second
assert.equal(m.mmss(130), '1:05');
assert.equal(m.mmss(120), '1:00');
assert.equal(m.mmss(599), '4:59');
assert.equal(m.mmss(1), '0:00');

console.log('icuxMath: all checks passed');
