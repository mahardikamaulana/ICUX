# ICUX

Quality-of-life additions for [IdleCorp](https://idlecorp.net), as one userscript.

![screenshot](docs/screenshot.png)

## Install

1. Install a userscript manager (Tampermonkey or Violentmonkey).
2. Open [ic-ux.user.js](https://raw.githubusercontent.com/mahardikamaulana/ICUX/main/ic-ux.user.js) and confirm the install.

Updates come through the same link.

## What it adds

- **Max assign:** a Max button on group cards (Priority list and Network inspector) assigns every unassigned building of that type.
- **Build / Demolish buttons:** ＋ and 🗑 next to each building's ⋯ menu. They open the game's own dialogs.
- **Presets 1 / 5 / 10** in the build and demolish dialogs. They only fill the amount; you still confirm.
- **Cost preview:** hover Build for the next, +5 and +10 cost and the materials needed; hover Demolish for the refund.
- **Market board:** an "only items I hold" filter, a Held column, a Net column (revenue minus goods at base value, freight and fuel, the way the game's Sell dialog prices freight), a "hide expiring" filter and an exact m:ss countdown under 5 minutes.
- **Ship:** a Ship button on each Inventory row opens the game's "Ship to Exchange" dialog for that item. You still set the amount and price and confirm.
- **Research search:** a search box on the Construction research panel lights matching buildings and dims the rest. Typing centres the first match; Enter and Shift+Enter go to the next and previous one.
- **Post an order:** Sell lists only items you have in stock.
- **Free land** for the selected region in the top bar.
- **Optional columns:** every table in the game gets a Columns menu above it that shows or hides columns, the way Odoo's optional columns work. The market board's Held and Net columns and IC Autopilot's Auto ship table are in the same menu. Choices are saved per table across reloads.
- **Compact top bar:** on desktop windows about 1360px and wider the top bar stays on one row, so the balance no longer drops to a second line. Nothing is hidden; narrower windows wrap the chips as before.
- **Profit per group:** a $/h figure on each production group card, after inputs, power and water, at base value. A group that loses money is flagged in red. A toggle in the Production groups header hides or shows the figure.

Filters are saved across reloads.

## Safety

ICUX sends one game action itself: `AssignBuildings`, when you click Max. Everything else only changes what you see or opens the game's own dialogs, so the game's confirm and cost display still apply.

It runs alongside other IdleCorp userscripts; its classes, storage key and global all use the `icux` prefix.

## Development

`bun test.js` runs the self-checks for the money and freight math.

## License

MIT
