---
name: tailwind
description: >
  Tailwind CSS v4 conventions, dark mode with @variant dark, and CSS-based
  configuration (no tailwind.config.js). ALWAYS load this skill before editing
  any Tailwind styles, markup, or CSS in a Tailwind project.
---

# tailwind v4

use tailwind v4. this new tailwind version does not use tailwind.config.js. instead it does all configuration in css files.

read https://tailwindcss.com/docs/upgrade-guide to understand the updates landed in tailwind v4 if you do not have tailwind v4 in your training context. ignore the parts that talk about running the upgrade cli. this project already uses tailwind v4 so no need to upgrade anything.


## design

prefer a minimalistic, Vercel-like design

focus on good spacing, sizes, gaps and consistency. focus on good typography.

do not use Card as a way to group elements. it looks cheap and it's overly used. do not use shadows unless asked to.

instead prefer minimal layouts with good positioning of the elements. few choices but very carefully made to look good.

if there are already components for what you need inside components/ui folder use them. do not re declare components again.

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

## styling preferences

always prefer using tailwind for styling. use built-in tailwind colors like gray, red, green, blue, etc.

**spacing: always prefer `gap` over margin/padding.** use flexbox/grid `gap` classes for spacing between sibling elements. never use `margin-top`, `margin-bottom`, `space-y-*`, or padding to create space between items in a list or stack. gap is simpler (no first/last-child overrides), composes better, and avoids margin collapse bugs. use `py-*`/`px-*` only for internal padding within a single element (e.g. inside a card), not for spacing between siblings.

```html
<!-- BAD — margin between items -->
<div class="flex flex-col">
  <div class="mb-4">Item 1</div>
  <div class="mb-4">Item 2</div>
  <div>Item 3</div>
</div>

<!-- GOOD — gap between items -->
<div class="flex flex-col gap-4">
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
</div>
```

## CSS custom properties — never duplicate values

never duplicate a CSS variable value. if `--ring` should match `--primary`, write `--ring: var(--primary)`, not the same `color-mix(...)` or `oklch(...)` expression twice. when adding a new token that derives from an existing one, always reference it with `var()`.

```css
/* WRONG — duplicated expression */
:root {
  --primary: oklch(0.205 0 0);
  --ring: oklch(0.205 0 0);
}

/* CORRECT — reference the source token */
:root {
  --primary: oklch(0.205 0 0);
  --ring: var(--primary);
}
```

## shadcn color token convention

use the shadcn/ui CSS custom property convention for design tokens. this makes it trivial to copy-paste shadcn components into the repo without remapping colors. each semantic token is a plain CSS variable in `:root` (light) with a dark override, then bridged to Tailwind via `@theme inline`.

### core tokens to always define

- `--background` / `--foreground` — page background and default text
- `--card` / `--card-foreground` — card surfaces
- `--popover` / `--popover-foreground` — popovers, dropdowns, tooltips
- `--primary` / `--primary-foreground` — primary buttons, links, accents
- `--secondary` / `--secondary-foreground` — secondary/subtle buttons
- `--muted` / `--muted-foreground` — muted backgrounds and placeholder text
- `--accent` / `--accent-foreground` — hover/active highlights
- `--destructive` / `--destructive-foreground` — delete, error actions
- `--border` — default border color
- `--input` — form input borders
- `--ring` — focus ring color
- `--radius` — default border radius

### extra tokens to add when needed

expand with the same `--name` / `--name-foreground` pattern:

- `--info` / `--info-foreground` — informational badges, alerts
- `--success` / `--success-foreground` — success states
- `--warning` / `--warning-foreground` — warning states
- `--sidebar` / `--sidebar-foreground` — sidebar background and text
- `--sidebar-primary` / `--sidebar-primary-foreground` — sidebar active item
- `--sidebar-accent` / `--sidebar-accent-foreground` — sidebar hover
- `--sidebar-border` / `--sidebar-ring` — sidebar borders and focus rings

always follow the `--name` / `--name-foreground` pair convention. never invent a different naming scheme.

## `@theme inline` bridging pattern

in Tailwind v4, CSS custom properties are not automatically available as utility classes. to use them as Tailwind colors, bridge them via `@theme inline`. this replaces the old `theme.extend.colors` in `tailwind.config.js`.

```css
@import 'tailwindcss';

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}
```

after this, classes like `bg-primary`, `text-muted-foreground`, `border-border`, `rounded-lg` just work. add more `--color-*` entries following the same pattern when you add new semantic tokens.

define the actual values in `:root` for light mode and inside `.dark` or `@variant dark` or `@media (prefers-color-scheme: dark)` for dark mode — whichever strategy the project uses. check the existing globals.css to see which strategy is in place before adding new tokens.

## derive colors with opacity, not new hardcoded values

add as few hardcoded colors as possible. derive variations from existing tokens using opacity. this is simpler and auto-adapts in dark mode when the base token changes.

prefer Tailwind's `/` opacity modifier first — it's the simplest:

```html
<div class="bg-primary/10 border-primary/20 text-primary">...</div>
```

in CSS, use `--alpha()` for the same effect:

```css
:root {
  --accent: --alpha(var(--foreground) / 8%);
  --border-subtle: --alpha(var(--foreground) / 5%);
}
```

when opacity alone isn't enough (e.g. mixing two different colors), use `color-mix()`:

```css
:root {
  --muted-foreground: color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-black));
  --sidebar-foreground: color-mix(in srgb, var(--foreground) 64%, var(--sidebar));
}
```

both `--alpha()` and `color-mix()` produce computed colors that auto-adapt in dark mode. prefer opacity over `color-mix()` when possible — it's simpler. use `color-mix()` only when you need to blend two different base colors.

## prefer CSS variables over Tailwind's `dark:` variant

dark mode values should be changed via CSS variables inside `@variant dark { }` blocks, not by scattering `dark:` classes on every element. this keeps dark mode logic centralized in one place.

```css
/* GOOD — one place to change */
:root {
  --card: oklch(1 0 0);
  @variant dark {
    --card: oklch(0.21 0.006 285.885);
  }
}
```

the same pattern works for responsive overrides with `@variant lg`, `@variant sm`, etc.:

```css
:root {
  --bleed: 0px;
  @variant lg {
    --bleed: 32px;
  }
}
```

## extract repeated hardcoded values into CSS variables

if you find yourself using the same hardcoded value across many places (e.g. a max-width, a sticky offset, a spacing constant), extract it into a CSS variable in `:root`. this deduplicates the value and makes it easy to change globally.

```css
:root {
  --content-max-width: 1200px;
  --sticky-top: 64px;
  --prose-gap: 20px;
}
```

but only do this when the value actually appears in **multiple places**. a variable used in a single spot adds indirection for no benefit — just inline the value. zero-reference variables should be deleted immediately.

## no prefixed variable namespaces

never introduce prefixed variable namespaces like `--app-*`, `--hc-*`, `--fd-*`, `--editorial-*`. keep everything in the flat shadcn naming style. if a new variable is needed, pick a descriptive name that could plausibly be a shadcn extension (e.g. `--text-tertiary`, `--border-subtle`, `--divider`).

## SVGs — always use `currentColor`

when creating or editing inline SVGs, always use `currentColor` for `fill` and `stroke` instead of hardcoded colors. this way the icon inherits the parent's CSS `color` property and automatically adapts to dark mode, hover states, and any text color utility.

```html
<!-- GOOD — adapts to parent color -->
<svg fill="currentColor" ...>
<svg stroke="currentColor" fill="none" ...>

<!-- BAD — hardcoded, ignores dark mode -->
<svg fill="#000" ...>
<svg fill="black" ...>
```

then style with Tailwind's text color utilities: `text-foreground`, `text-muted-foreground`, `text-primary`, etc.

**data-URI SVGs cannot use `currentColor`**: SVG used as a CSS `background-image` data URI (`url("data:image/svg+xml,...")`) is NOT part of the document tree, so `currentColor` resolves to black regardless of the parent's color. always use inline `<svg>` elements (not background-image) for icons that need to adapt to light/dark mode.

## dark mode detection in React — hydration-safe with `useSyncExternalStore`

when a client component needs to know if dark mode is active (e.g. to pass a theme to a third-party library like mermaid, or to swap an image src), never use `useState` + `useEffect` + `MutationObserver`. that pattern causes hydration mismatches because `useState(() => document.documentElement.classList.contains('dark'))` evaluates during SSR where `document` doesn't exist.

use `useSyncExternalStore` with **module-level stable callbacks** instead:

```tsx
import { useSyncExternalStore } from 'react'

// Module-level — stable references, never re-allocated
function getIsDark(): boolean {
  return document.documentElement.classList.contains('dark')
}
const getServerIsDark = () => false

function subscribeTheme(cb: () => void) {
  const observer = new MutationObserver(cb)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

// Inside any component
const isDark = useSyncExternalStore(subscribeTheme, getIsDark, getServerIsDark)
```

server always returns `false` (light). React handles the mismatch gracefully during hydration. the MutationObserver fires `cb` on `<html>` class changes, triggering a synchronous re-render.

**rules:**
- all three callbacks must be **stable references** (module-level or `useCallback`). inline arrows cause React to re-subscribe every render.
- never read `document` inside the server snapshot. return a safe default.
- this pattern works for any external state tied to the DOM (scroll position, media queries, `<html>` attributes, etc.).

## prefer `cn()` for className composition

always use the `cn()` helper (clsx + tailwind-merge) for composing class names. never use template literals or string concatenation to build className strings. `cn()` handles falsy values, deduplicates conflicting tailwind classes, and reads much cleaner.

for conditional classes, pass boolean expressions with `&&` inside `cn()`:

```tsx
// BAD — template literal, no tailwind-merge, hard to scan
<div className={`px-4 py-2 ${isActive ? "bg-primary text-primary-foreground" : "bg-muted"} ${isDisabled ? "opacity-50" : ""}`}>

// BAD — ternary soup
<div className={isActive ? "px-4 py-2 bg-primary text-primary-foreground" : "px-4 py-2 bg-muted"}>

// GOOD — cn() with && for conditional classes
<div className={cn(
  "px-4 py-2",
  isActive && "bg-primary text-primary-foreground",
  !isActive && "bg-muted",
  isDisabled && "opacity-50",
)}>
```

when a component accepts a `className` prop, always merge it last so the caller can override defaults:

```tsx
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-lg border bg-card p-4", className)} {...props} />;
}
```

if existing code uses template literals for conditional classes, refactor it to `cn()` when you touch that code.

## React component reuse (shadcn convention)

never duplicate complex styling across multiple files. instead, create reusable components in `components/ui/` following the shadcn convention, and import them everywhere. this applies to all styled primitives: buttons, inputs, selects, badges, dialogs, tables, empty states, etc.

prefer @base-ui/react components first when shadcn offers both Base UI and Radix versions.

if Base UI is not available and you need Radix primitives, prefer the unified **`radix-ui`** package instead of scoped packages like `@radix-ui/react-slot`, `@radix-ui/react-dialog`, etc. newer shadcn docs and generated components are moving toward the single package, so that should be the default recommendation in docs and examples.

To find available shadcn components fetch https://ui.shadcn.com/llms.txt

**common examples that must always be components:**

- `Button` — never write raw `<button className="bg-primary text-primary-foreground ...">`. use the `Button` component with `variant` and `size` props.
- `Input` / `Textarea` — never write raw `<input className="rounded-md border border-input ...">`. use the `Input` component.
- `NativeSelect` — never write raw `<select className="flex h-9 w-full rounded-md border ...">`. use the `NativeSelect` component for native selects or the `Select` component for custom dropdowns.
- `EmptyState` — the "centered icon + heading + description + action" pattern should be a single component, not copy-pasted markup.

**when you see small differences between usages, add support via props** (variant, size, loading, etc.) on the centralized component rather than duplicating the entire component with tweaks.

```tsx
// BAD — hardcoded select with hand-rolled styles
<select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 ...">
  <option value="">All environments</option>
</select>

// GOOD — reusable component
<NativeSelect>
  <option value="">All environments</option>
</NativeSelect>
```

**module export rule: only export components from component files.** never mix component exports with non-component exports (style strings, constants, utility functions) in the same file. this breaks React Fast Refresh / HMR because the bundler can't determine whether to do a full reload or a hot update when non-component exports change. if you need shared styles, encode them as CSS classes (in globals.css or a utility CSS file) and reference them via className in the component. if you need shared constants, put them in a separate non-component module (e.g. `lib/constants.ts`).

```tsx
// BAD — mixing components and non-component exports breaks HMR
export const hiddenValueStyle = { WebkitTextSecurity: "disc" };
export function SecretsTable() { ... }

// GOOD — style is a CSS class, component file only exports components
// globals.css: .text-security-disc { -webkit-text-security: disc; }
export function SecretsTable() { ... }
```

**when to create a new ui component:** if you find the same visual pattern (same markup structure + same tailwind classes) in 2+ places, extract it. one-off patterns can stay inline. the `components/ui/` folder is for generic, reusable primitives. domain-specific components live in `components/` without the `ui/` prefix.


## scrollbars

always set all scrollbars styles to transparent and thin.

```css
:root {
  scrollbar-width: thin;
  scrollbar-color: gray transparent;
  scrollbar-gutter: stable;
}
```
