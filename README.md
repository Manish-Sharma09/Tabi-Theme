# Tabi Theme — mytabi.in

Shopify theme for **mytabi.in**, based on **Dawn 15.2.0**.

> **Repo layout matters.** Shopify's GitHub integration expects the theme
> directories (`assets/`, `config/`, `layout/`, `locales/`, `sections/`,
> `snippets/`, `templates/`) at the **root of the branch**. They are — do not
> move them into a subfolder or the connection will fail.

---

## Connecting this repo to Shopify

1. Shopify admin → **Online Store → Themes → Add theme → Connect from GitHub**
2. Authorise the Shopify GitHub app for the `Manish-Sharma09` account
3. Select this repository and the `main` branch
4. Shopify creates a new **unpublished** theme — preview it before publishing

Once connected, syncing is two-way: pushes to `main` deploy to the theme, and
edits made in the online theme editor are committed back to `main`.

**Pull before you push.** The theme editor writes to `config/settings_data.json`
and `templates/*.json`; if you push over an editor commit you will hit conflicts.

---

## Local development

```bash
npm install -g @shopify/cli@latest      # Node 22 LTS — not 25
shopify theme dev --store mytabi.myshopify.com
shopify theme check                     # linter
```

If browser login fails, use a Theme Access token instead:

```bash
export SHOPIFY_CLI_THEME_TOKEN=shptka_xxxxxxxx
shopify theme dev --store mytabi.myshopify.com
```

---

## Custom files

Everything custom lives in two new files, so it is easy to review or revert:

| File | Contains |
|---|---|
| `assets/custom-fixes.css` | Card layout, price, quick-add bar, size popup, image slider, header, drawer, PDP media, overflow guards |
| `assets/custom-fixes.js` | Card image slider, size-chip add-to-cart, menu-drawer close + offset |

Both are registered in `layout/theme.liquid`.

---

## What was changed vs the original export

### Bugs fixed in the inherited theme

| Area | Root cause |
|---|---|
| Product titles wrapping one letter per line | `.grid__item` width rule was fully commented out in `base.css`; grid markup used `grid-cols-3`, a class that only exists inside `snippets/view-grid.liquid` |
| Search not working | `search-form.js`, `details-modal.js`, `details-disclosure.js` and `cart-drawer.js` were each loaded twice (`theme.liquid` + `header.liquid`) → `SyntaxError: Identifier 'SearchForm' has already been declared`. Both search inputs also shared `id="Search-In-Modal"` |
| Header icons hidden on mobile home | `.header__icons { display: none }` scoped to `template == 'index'` |
| `ReferenceError: renderButton is not defined` | Function commented out, call site left live |
| `TypeError` on `.header__inline-menu` | No null guard; killed the size-chart handler that followed |
| Sideways scroll on mobile | `.ctsm-section-added { width: 100% }` pushed the logo past the viewport |
| Collection cards only clickable on "Shop All" | Card was a `<div>`; only the button was a link |
| 404 stylesheet request | `section-collection-feature.css` referenced but absent from `assets/` |
| Invalid schema JSON | Trailing commas in `sections/footer.liquid` and `sections/flipbook-section.liquid` — these sections would not load in the theme editor |
| `transform: translateY(1)` | Invalid (no unit), declaration dropped |
| `display: content` | Typo for `contents` |

### Features added

- Reference-style product card: full-bleed image → ADD TO BAG bar → fabric chip → single-line title → price → size row → colour swatches
- Card image slider — autoplay on mobile, manual arrows on desktop (≥750px)
- Size chips add to cart directly via `/cart/add.js` with cart-drawer re-render
- Size popup for multi-variant products; Dawn's quick-add modal for multi-option products
- Menu drawer: pinned while open, four independent ways to close

### Fabric chip data source

Checked in order, first match wins:

1. `metafields.custom.fabric`
2. `metafields.custom.material`
3. `metafields.custom.fabric_composition`
4. A product tag like `fabric:Cotton Voile`
5. Otherwise the chip is hidden

`product.type` is deliberately **not** used — the catalogue has `Pants` set on
every product, which printed "PANTS" on dresses and shirts.

---

## Gotchas worth knowing

- **`.card__media` is a stacking context.** Dawn sets `z-index: 0` on it (a
  Safari border fix) and `.ratio > *` makes it `position: absolute`. Anything
  placed inside it is trapped below `.card__heading a::after` (z-index 1) — the
  stretched card link. Slider arrows are mounted on `.card__inner` for this reason.
- **Never put `overflow-x` on `<html>`.** Dawn's menu-drawer scroll lock is
  `body { overflow: hidden }`, which only reaches the viewport while `<html>` is
  `overflow: visible`. The overflow guard is scoped to `#MainContent`.
- **`.cart-count-bubble` needs a positioned parent.** Setting the cart icon to
  `position: static` sends the badge to the header's top-left corner.
- **Liquid rejects filters inside index brackets.** `options_with_values[i | minus: 1]`
  is a syntax error — compute the index into a variable first.
- **Liquid parses inside `{% style %}` blocks.** A literal `{% style %}` in a CSS
  comment throws "Unclosed tag".
- `sections/header.liquid` uses **CRLF** line endings. Preserve them.

---

## Validation before any push

- `node --check` on all JS, including inline `<script>` blocks
- Every Liquid expression parsed individually (~6000 of them)
- Liquid tag balance, CSS brace balance
- All section `{% schema %}` blocks and every `templates/`, `config/`, `locales/` JSON file parsed
