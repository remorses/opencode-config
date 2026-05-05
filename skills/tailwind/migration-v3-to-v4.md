# Migrating from Tailwind CSS v3 to v4

Official upgrade guide: https://tailwindcss.com/docs/upgrade-guide

## Auto migration CLI

Run the automated upgrade tool from the project root:

```bash
bunx @tailwindcss/upgrade
```

Requires **Node.js 20+**. Run it on a separate git branch so you can review the diff before merging.

The CLI handles:

- Converting `tailwind.config.js` / `tailwind.config.ts` to CSS-first config with `@theme`
- Updating the CSS entry point from `@tailwind base; @tailwind components; @tailwind utilities;` to `@import "tailwindcss"`
- Swapping the `tailwindcss` PostCSS plugin for `@tailwindcss/postcss`
- Removing `postcss-import` and `autoprefixer` (no longer needed)
- Migrating renamed and removed utilities in template files

## What the CLI does NOT handle

Some changes need manual attention after running the tool:

- **JavaScript config logic** like conditional themes, dynamic content paths, or custom plugin code that can't be expressed in CSS
- **Third-party plugin migrations** where the plugin hasn't released a v4-compatible version yet
- **`@apply` inside non-Tailwind CSS files** (files not imported from the Tailwind entry point)
- **`darkMode: 'class'`** strategy needs to become `@custom-variant dark (&:is(.dark *))` in CSS
- **Custom `theme()` references** in CSS that need to become `var(--...)` references

## Difficult parts the CLI cannot fix

### Inline `hsl(var(--name))` references in JS/TSX

This is the most common silent breakage. In v3, a popular pattern was storing raw HSL components in CSS vars and wrapping them with `hsl()` at the usage site:

```css
/* v3 globals.css */
--primary-base: 24 95.74% 53.92%;
```

```ts
// v3 tailwind.config.ts
colors: { 'primary-base': 'hsl(var(--primary-base))' }
```

Tailwind classes like `bg-primary-base` worked because the config added the `hsl()` wrapper. But developers also used the same trick in inline styles and SVG props:

```tsx
<Line stroke='hsl(var(--primary-base))' />
<CircleMarker pathOptions={{ fillColor: 'hsl(var(--primary-base))' }} />
<div style={{ background: `linear-gradient(90deg, hsl(var(--stroke-soft-200)) 1px, ...)` }} />
```

After migration, colors become hex values with a `--color-` prefix (`--color-primary-base: #fa7319`). This breaks the inline references in two ways:
1. `--primary-base` (without `--color-` prefix) no longer exists
2. Even if it did, `hsl(#fa7319)` is invalid CSS

**The fix:** search for `hsl(var(--` across all `.tsx`/`.ts` files and replace with `var(--color-...)`:

```bash
# find all occurrences
rg 'hsl\(var\(--' --include '*.tsx' --include '*.ts'
```

```
hsl(var(--primary-base))      -> var(--color-primary-base)
hsl(var(--stroke-soft-200))   -> var(--color-stroke-soft-200)
hsl(var(--orange-alpha-24))   -> var(--color-orange-alpha-24)
```

The migration CLI only touches Tailwind class names in templates; it does not scan inline styles, SVG attributes, or JS string literals. Always grep for `hsl(var(--` after running the CLI.

### Complex JS configs that fail auto-conversion

When the tailwind config uses `theme()` references in shadows, complex color mappings with `hsl()` wrappers, custom font stacks, or dynamic logic, the CLI gives up and falls back to `@config '../tailwind.config.ts'` in the CSS file. This keeps the old config alive, defeating the purpose of migration.

In that case, manually rewrite the CSS:
1. Convert all color values to hex and put them directly in `@theme {}`
2. Convert shadow definitions, replacing `theme(colors.*)` with `var(--color-*)`
3. Convert typography/font definitions to `--text-*` and `--font-family-*` theme tokens
4. Delete the old config file and the `@config` directive

### `tailwindcss-animate` plugin replacement

The `tailwindcss-animate` plugin is not compatible with v4. Replace it with `tw-animate-css`:

```bash
pnpm remove tailwindcss-animate
pnpm add -D tw-animate-css
```

```css
/* add to globals.css */
@import 'tw-animate-css';
```

The utility classes (`animate-in`, `fade-in-0`, `slide-in-from-bottom-4`, etc.) keep the same names, so template code does not need changes.

### Files that import from the deleted tailwind config

Some projects import exported objects from `tailwind.config.ts` for use in JS (e.g., tailwind-merge configuration, runtime color lookups). Search for these imports before deleting the config:

```bash
rg 'from.*tailwind.config|require.*tailwind.config' --include '*.ts' --include '*.tsx'
```

Inline the needed values or move them to a separate module.

### `postcss.config` cleanup

Remove `tailwindcss/nesting` from the PostCSS config; nesting is built-in to v4. The only plugin needed is `@tailwindcss/postcss`.

### ESLint tailwind plugin config

If `.eslintrc` has `settings.tailwindcss.config` pointing to the deleted config file, remove that property. The plugin will auto-detect the CSS-based configuration.

## Post-migration checklist

1. Review the git diff carefully, especially `globals.css` or your main CSS entry point
2. **Grep for `hsl(var(--` in all `.tsx`/`.ts` files** and fix any inline color references
3. Check that `@theme` or `@theme inline` bridges all CSS custom properties you use as Tailwind utilities
4. Verify dark mode works (check `@custom-variant dark` is defined correctly)
5. Run the dev server and spot-check pages for visual regressions, especially charts and SVG-heavy components
6. Delete the old `tailwind.config.js` / `tailwind.config.ts` if the CLI didn't remove it
7. Remove `postcss-import`, `autoprefixer`, and `tailwindcss/nesting` from `postcss.config.js` if still present
8. Replace `tailwindcss-animate` with `tw-animate-css` if used
9. Check for files that imported from `tailwind.config.ts` and inline or relocate those values
