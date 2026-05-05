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

## Post-migration checklist

1. Review the git diff carefully, especially `globals.css` or your main CSS entry point
2. Check that `@theme inline` bridges all CSS custom properties you use as Tailwind utilities
3. Verify dark mode works (check `@custom-variant dark` is defined correctly)
4. Run the dev server and spot-check pages for visual regressions
5. Delete the old `tailwind.config.js` / `tailwind.config.ts` if the CLI didn't remove it
6. Remove `postcss-import` and `autoprefixer` from `postcss.config.js` if still present
