# advice-stock-bot

Stock monitor for **iPhone 18 Pro Max — every colour, every capacity — on
Advice** (`www.advice.co.th`), with LINE / Telegram / Discord alerts.

Cloned from `true-stock-bot` (True Online Store). Same architecture, same
notification channels, separate database — run all of them side by side and
get alerted whichever store restocks first.

---

## How it gets the data

Advice's storefront is Nuxt 3. Its JSON API (`/_advice-api/...`) needs a
session token, but the **group product page** is server-rendered and embeds
the whole variant group in `<script id="__NUXT_DATA__">`:

```
product.product_group[]            one entry per colour x capacity (16 today)
  code                             "A0186084"  (Advice item code = our SKU)
  product                          "Apple iPhone 18 Pro Max 256GB Black (MJXN4ZP/A)"
  price_sale                       52900
  option { "459": 1071, "460": 1074 }   -> colour / capacity via product.options
  product_get.stock { instock, type, cart, ... }
```

So **one GET of the product page is a full sweep** — catalogue and stock
together, no auth, no cookie. Nothing is hard-coded: a new colour or price
change is picked up on the next check.

### What counts as "available"

```
AVAILABLE  =  stock.type === "instock"
              AND stock.instock > 0
              AND stock.cart === "T"        (add-to-cart button enabled)
```

`ADVICE_REQUIRE_CART=false` drops the cart condition.
`instock` is a 0/1 flag, not a unit count, so alerts never show "เหลือ N เครื่อง".

Anything the bot does not understand — no payload, a shape change, an
unreachable page, a Cloudflare challenge — becomes **UNKNOWN**, never
`UNAVAILABLE`. UNKNOWN never notifies and never overwrites the last known
answer, so an outage cannot manufacture a false "back in stock" edge.

### Which variants

| Variable | Default | Meaning |
|---|---|---|
| `ADVICE_STORAGES` | *(empty)* | capacities to watch, e.g. `256GB,512GB` (empty = all) |
| `ADVICE_COLORS` | *(empty)* | colours to watch, e.g. `Black,Glacier` (empty = all) |

### When it notifies

```
previous.available === false && current === AVAILABLE   ->  notify
```

Every alert carries the price and a **direct buy link** to that exact
colour + capacity, plus the full list of what else is in stock (each with its
own link). The first run only seeds a baseline, `AVAILABLE -> AVAILABLE` stays quiet, and
going out of stock is recorded but not pushed.

### Cloudflare

Advice sits behind Cloudflare. A 403 / 429 / 503 or a "Just a moment..."
challenge page counts as push-back: the adaptive cooldown pauses checks
(120s, doubling up to 30min) and LINE / Discord get a notice. The bot does not
try to get around the protection. Default interval is **60s** — each check
downloads the ~1.6MB page (~150KB brotli on the wire), so don't go much lower.

---

## Quick start

```bash
cp .env.example .env     # then fill in at least one notification channel
npm install
npm run prisma:migrate   # creates the advice_stock_bot database + tables
npm run dev
```

The default `DATABASE_URL` uses the local Postgres on 5432 (database
`advice_stock_bot`). For Docker instead: `docker compose up -d postgres`
publishes on **5434** — update `DATABASE_URL` to match.

Check your notification wiring without waiting for a restock:

```bash
npm run notify:test      # one alert to every configured channel
npm run notify:samples   # one of each message the bot can produce
npm run notify:status    # what the bot currently believes is in stock
npm run notify:live      # fetch Advice now and alert whatever is in stock
```

> Telegram: open the bot in Telegram and press **Start** once, otherwise it
> is not allowed to message you.

---

## Layout

```
src/advice/          talking to www.advice.co.th
  advice.client.ts      HTTP + retry + Cloudflare-challenge detection
  advice.parser.ts      __NUXT_DATA__ -> product_group -> variants + stock
  advice.catalog.ts     last-known variant list (for UNKNOWN fallback / banner)
  advice.channel.ts     the ONLINE selling channel
  advice.availability.ts one full sweep (one request)
  advice.types.ts       zod schemas for the payload
src/stock/           change detection + persistence (source-agnostic)
src/notification/    LINE Flex, Telegram, Discord, message text
src/scheduler/       tick loop, adaptive rate-limit cooldown
```

## Tests

```bash
npm test
```

The parser suite runs against the **real captured payload** in
`tests/fixtures/advice-pdp.json` (the product node of the live
`__NUXT_DATA__`, pruned to the fields the bot reads), re-encoded with devalue
exactly as Nuxt ships it.

## License

MIT
