

# tailwind v4

use tailwind v4. this new tailwind version does not use tailwind.config.js. instead it does all configuration in css files.

read https://tailwindcss.com/docs/upgrade-guide to understand the updates landed in tailwind v4 if you do not have tailwind v4 in your training context. ignore the parts that talk about running the upgrade cli. this project already uses tailwind v4 so no need to upgrade anything.


## dark mode with @variant dark

always prefer `@variant dark { ... }` over hardcoded `.dark` selectors for dark mode overrides. this is strategy-agnostic: it compiles to whatever selector is configured in `@custom-variant dark` (e.g. `.dark` class, `prefers-color-scheme`, `data-theme`, or a combination). changing the strategy only requires updating one line. never write `.dark { }` or `.dark .selector` in Tailwind-processed CSS files — use `@variant dark` instead.

**critical**: `@variant dark` must be nested inside a parent CSS rule — it does NOT work at the top level. the `&` in the custom variant needs a parent selector to bind to. at the top level, it produces a literal `&:where(...)` that browsers can't resolve.

```css
/* WRONG — & has no parent, produces broken CSS */
@variant dark {
  --background: #111;
}

/* CORRECT — nested inside :root, & binds to :root */
:root {
  --background: #fff;

  @variant dark {
    --background: #111;
  }
}
```

**also critical**: `@variant dark` only works in CSS files processed by Tailwind — the file with `@import "tailwindcss"` and files `@import`ed from it. CSS files imported via JS `import "file.css"` are plain CSS and Tailwind directives are silently ignored. for those files, use `.dark .selector` selectors directly.
