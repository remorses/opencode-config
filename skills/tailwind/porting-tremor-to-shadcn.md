# Porting Tremor to shadcn-compatible tokens

Tremor uses raw Tailwind palette colors with explicit `dark:` variants for every light/dark pair. shadcn uses semantic CSS variable tokens (`background`, `foreground`, `primary`, etc.) that adapt to the active theme. This guide shows how to collapse Tremor's light+dark class pairs into shadcn semantic utilities using `windlint rename`.

## Core mapping table

Each row shows the Tremor light+dark pair and the shadcn semantic token it maps to. All commands use token form (namespace-prefixed), consistent with windlint's API.

| Tremor light class | Tremor dark class | shadcn token | windlint command |
|---|---|---|---|
| `text-gray-900` | `dark:text-gray-50` | `text-foreground` | `windlint rename 'color-gray-900 dark:color-gray-50' color-foreground` |
| `text-gray-500` | `dark:text-gray-500` | `text-muted-foreground` | `windlint rename 'color-gray-500 dark:color-gray-500' color-muted-foreground` |
| `text-gray-700` | `dark:text-gray-300` | `text-muted-foreground` | `windlint rename 'color-gray-700 dark:color-gray-300' color-muted-foreground` |
| `bg-white` | `dark:bg-gray-950` | `bg-background` | `windlint rename 'color-white dark:color-gray-950' color-background` |
| `bg-gray-50` | `dark:bg-gray-900` | `bg-muted` | `windlint rename 'color-gray-50 dark:color-gray-900' color-muted` |
| `bg-gray-100` | `dark:bg-gray-800` | `bg-accent` | `windlint rename 'color-gray-100 dark:color-gray-800' color-accent` |
| `border-gray-200` | `dark:border-gray-800` | `border-border` | `windlint rename 'color-gray-200 dark:color-gray-800' color-border` |
| `border-gray-300` | `dark:border-gray-700` | `border-input` | `windlint rename 'color-gray-300 dark:color-gray-700' color-input` |
| `ring-gray-200` | `dark:ring-gray-800` | `ring-border` | `windlint rename 'color-gray-200 dark:color-gray-800' color-border` |
| `divide-gray-200` | `dark:divide-gray-800` | `divide-border` | `windlint rename 'color-gray-200 dark:color-gray-800' color-border` |
| `hover:bg-gray-100` | `dark:hover:bg-gray-900` | `hover:bg-accent` | `windlint rename 'color-gray-100 dark:color-gray-900' color-accent` |
| `hover:bg-gray-50` | `dark:hover:bg-gray-800` | `hover:bg-muted` | `windlint rename 'color-gray-50 dark:color-gray-800' color-muted` |

## Brand/primary colors

If the project uses indigo as its primary, collapse indigo pairs to `primary`:

| Tremor light class | Tremor dark class | shadcn token |
|---|---|---|
| `bg-indigo-500` | `dark:bg-indigo-500` | `bg-primary` |
| `text-indigo-500` | `dark:text-indigo-500` | `text-primary` |
| `ring-indigo-200` | `dark:ring-indigo-800` | `ring-ring` |
| `border-indigo-500` | `dark:border-indigo-500` | `border-primary` |

```bash
windlint rename 'color-indigo-500 dark:color-indigo-500' color-primary
windlint rename 'color-indigo-200 dark:color-indigo-800' color-ring
```

## Recommended order of operations

Run renames from most-used pairs to least-used. This reduces noise in later passes.

```bash
# 1. Text foreground (most common pair)
windlint rename 'color-gray-900 dark:color-gray-50' color-foreground

# 2. Backgrounds
windlint rename 'color-white dark:color-gray-950' color-background
windlint rename 'color-gray-50 dark:color-gray-900' color-muted
windlint rename 'color-gray-100 dark:color-gray-800' color-accent

# 3. Borders and dividers
windlint rename 'color-gray-200 dark:color-gray-800' color-border
windlint rename 'color-gray-300 dark:color-gray-700' color-input

# 4. Muted text
windlint rename 'color-gray-500 dark:color-gray-500' color-muted-foreground
windlint rename 'color-gray-700 dark:color-gray-300' color-muted-foreground

# 5. Primary colors (adjust indigo to your brand)
windlint rename 'color-indigo-500 dark:color-indigo-500' color-primary

# 6. Rings and focus
windlint rename 'color-indigo-200 dark:color-indigo-800' color-ring
```

After each command, review the diff (`git diff`) before proceeding to the next.

## What to keep as `dark:`

Not everything should be collapsed. Keep explicit `dark:` variants for:

- **Chart/data visualization colors.** Tremor charts use color arrays from `chartUtils.ts` or `colorPalettes` with specific light/dark pairs per data series. These are intentional per-theme overrides, not semantic tokens.
- **Status badge colors.** Yellow, emerald, purple, rose for status indicators (`bg-yellow-100 dark:bg-yellow-900`) are context-specific. They don't map to a single shadcn semantic token.
- **One-off decorative colors.** Gradient stops, illustration fills, or brand accent variations that only appear in one component.

If a light/dark pair appears in fewer than 3 places, consider leaving it as-is and handling it manually.

## After migration

Once all pairs are collapsed, define the semantic tokens in your CSS:

```css
@import 'tailwindcss';

@theme {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-destructive: var(--destructive);
}

:root {
  --background: #ffffff;
  --foreground: #0a0a0a;
  --muted: #f9fafb;
  --muted-foreground: #6b7280;
  --accent: #f3f4f6;
  --border: #e5e7eb;
  --input: #d1d5db;
  --ring: #e5e7eb;
  --primary: #6366f1;
  --primary-foreground: #ffffff;
  --destructive: #ef4444;
}

.dark {
  --background: #030712;
  --foreground: #fafafa;
  --muted: #111827;
  --muted-foreground: #6b7280;
  --accent: #1f2937;
  --border: #1f2937;
  --input: #374151;
  --ring: #1f2937;
  --primary: #6366f1;
  --primary-foreground: #ffffff;
  --destructive: #ef4444;
}
```

## Replace scoped Radix packages with unified `radix-ui`

Tremor pulls in many scoped `@radix-ui/react-*` packages (accordion, checkbox, dialog, popover, select, slider, tabs, toggle, etc.). Replace them all with the single unified `radix-ui` package.

```bash
# Remove all scoped packages
pnpm remove @radix-ui/react-accordion @radix-ui/react-checkbox @radix-ui/react-dialog \
  @radix-ui/react-hover-card @radix-ui/react-label @radix-ui/react-navigation-menu \
  @radix-ui/react-popover @radix-ui/react-radio-group @radix-ui/react-scroll-area \
  @radix-ui/react-select @radix-ui/react-slider @radix-ui/react-slot @radix-ui/react-switch \
  @radix-ui/react-tabs @radix-ui/react-toggle @radix-ui/react-toggle-group @radix-ui/react-tooltip

# Install unified package
pnpm add radix-ui
```

Then update imports across the codebase:

```diff
-import * as SelectPrimitive from '@radix-ui/react-select'
+import { Select as SelectPrimitive } from 'radix-ui'

-import * as DialogPrimitive from '@radix-ui/react-dialog'
+import { Dialog as DialogPrimitive } from 'radix-ui'

-import { Slot } from '@radix-ui/react-slot'
+import { Slot } from 'radix-ui'
```

The unified package re-exports everything from the scoped packages, so the component APIs are identical. This cuts tens of dependencies down to one.

## Note about chartUtils.ts data colors

Tremor's `chartUtils.ts` maps chart series names to color palette arrays. These are raw palette references like `blue-500`, `emerald-500`, `violet-500`. They should stay as raw palette colors, not semantic tokens. Chart colors are data-driven and theme-independent by design.
