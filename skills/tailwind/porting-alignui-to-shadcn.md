# Porting AlignUI to shadcn-compatible tokens

AlignUI uses ~90 custom semantic color tokens with a `bg-*/text-*/stroke-*` naming convention. shadcn uses ~15 flat tokens (`background`, `foreground`, `primary`, etc.). This guide shows how to rename AlignUI tokens to shadcn equivalents using `windlint rename`, so shadcn components can be dropped in and AlignUI components use standard names.

## Token mapping

| AlignUI token | shadcn equivalent | Usage count |
|---|---|---|
| `color-bg-white-0` | `color-background` | ~115 |
| `color-bg-weak-50` | `color-muted` | ~91 |
| `color-bg-soft-200` | `color-accent` | ~21 |
| `color-bg-sub-300` | `color-secondary` | ~0 |
| `color-bg-strong-950` | `color-foreground` | ~10 (inverted surface) |
| `color-bg-surface-800` | `color-foreground/80` | ~1 |
| `color-text-strong-950` | `color-foreground` | ~235 |
| `color-text-sub-600` | `color-muted-foreground` | ~382 |
| `color-text-soft-400` | `color-foreground/40` | ~150 |
| `color-text-disabled-300` | `color-foreground/25` | ~65 |
| `color-text-white-0` | `color-background` | ~10 (inverted text) |
| `color-stroke-soft-200` | `color-border` | ~149 |
| `color-stroke-sub-300` | `color-input` | ~4 |
| `color-stroke-strong-950` | `color-ring` | ~11 |
| `color-stroke-white-0` | `color-background` | ~10 |
| `color-primary-base` | `color-primary` | ~83 |
| `color-primary-alpha-10` | `color-primary/10` | ~8 |
| `color-primary-alpha-16` | `color-primary/[.16]` | ~2 |
| `color-primary-darker` | `color-primary/90` | ~2 |
| `color-error-base` | `color-destructive` | ~49 |
| `color-error-dark` | `color-destructive/80` | ~1 |
| `color-error-light` | `color-destructive/20` | ~5 |
| `color-error-lighter` | `color-destructive/10` | ~3 |
| `color-success-base` | `color-success` | ~50 |
| `color-warning-base` | `color-warning` | ~26 |
| `color-information-base` | `color-info` | ~9 |
| `color-static-white` | `color-primary-foreground` | ~22 |
| `color-static-black` | `color-accent-foreground` | ~7 |
| `color-faded-base` | `color-muted-foreground` | ~11 |
| `color-faded-dark` | `color-foreground` | ~5 |
| `color-faded-light` | `color-border` | ~9 |
| `color-faded-lighter` | `color-muted` | ~5 |
| `color-away-*` | `color-yellow-*` | ~19 |
| `color-feature-*` | `color-purple-*` | ~13 |
| `color-verified-*` | `color-sky-*` | ~12 |
| `color-highlighted-*` | `color-pink-*` | ~8 |
| `color-stable-*` | `color-teal-*` | ~8 |
| `color-social-apple/twitter/github` | `color-foreground` | ~5 |

## Rename commands

Run these sequentially. Use `NODE_OPTIONS='--max-old-space-size=8192'` if any command OOMs on large projects.

### Phase 1: Background tokens

```bash
windlint rename color-bg-white-0 color-background
windlint rename color-bg-weak-50 color-muted
windlint rename color-bg-soft-200 color-accent
windlint rename color-bg-strong-950 color-foreground
windlint rename color-bg-surface-800 color-foreground/80
windlint rename color-bg-sub-300 color-secondary
```

### Phase 2: Text tokens

```bash
windlint rename color-text-strong-950 color-foreground
windlint rename color-text-sub-600 color-muted-foreground
windlint rename color-text-soft-400 color-foreground/40
windlint rename color-text-disabled-300 color-foreground/25
windlint rename color-text-white-0 color-background
```

### Phase 3: Stroke/border tokens

```bash
windlint rename color-stroke-soft-200 color-border
windlint rename color-stroke-strong-950 color-ring
windlint rename color-stroke-sub-300 color-input
windlint rename color-stroke-white-0 color-background
```

### Phase 4: Primary + destructive

```bash
windlint rename color-primary-base color-primary
windlint rename color-primary-alpha-10 color-primary/10
windlint rename color-primary-alpha-16 'color-primary/[.16]'
windlint rename color-primary-alpha-24 'color-primary/[.24]'
windlint rename color-primary-darker color-primary/90
windlint rename color-primary-dark color-primary/80
windlint rename color-error-base color-destructive
windlint rename color-error-dark color-destructive/80
windlint rename color-error-light color-destructive/20
windlint rename color-error-lighter color-destructive/10
windlint rename color-red-alpha-10 color-destructive/10
```

### Phase 5: Status tokens

```bash
windlint rename color-success-base color-success
windlint rename color-success-dark color-success/80
windlint rename color-success-light color-success/20
windlint rename color-success-lighter color-success/10

windlint rename color-warning-base color-warning
windlint rename color-warning-dark color-warning/80
windlint rename color-warning-light color-warning/20
windlint rename color-warning-lighter color-warning/10

windlint rename color-information-base color-info
windlint rename color-information-dark color-info/80
windlint rename color-information-light color-info/20
windlint rename color-information-lighter color-info/10
```

### Phase 6: Static colors + faded

```bash
windlint rename color-static-white color-primary-foreground
windlint rename color-static-black color-accent-foreground

windlint rename color-faded-base color-muted-foreground
windlint rename color-faded-dark color-foreground
windlint rename color-faded-light color-border
windlint rename color-faded-lighter color-muted
```

### Phase 7: Minor status tokens → raw palette

```bash
windlint rename color-away-base color-yellow-500
windlint rename color-away-dark color-yellow-950
windlint rename color-away-light color-yellow-200
windlint rename color-away-lighter color-yellow-50

windlint rename color-feature-base color-purple-500
windlint rename color-feature-dark color-purple-950
windlint rename color-feature-light color-purple-200
windlint rename color-feature-lighter color-purple-50

windlint rename color-verified-base color-sky-500
windlint rename color-verified-dark color-sky-950
windlint rename color-verified-light color-sky-200
windlint rename color-verified-lighter color-sky-50

windlint rename color-highlighted-base color-pink-500
windlint rename color-highlighted-dark color-pink-950
windlint rename color-highlighted-light color-pink-200
windlint rename color-highlighted-lighter color-pink-50

windlint rename color-stable-base color-teal-500
windlint rename color-stable-dark color-teal-950
windlint rename color-stable-light color-teal-200
windlint rename color-stable-lighter color-teal-50
```

### Phase 8: Social + remaining alpha tokens

```bash
windlint rename color-social-apple color-foreground
windlint rename color-social-twitter color-foreground
windlint rename color-social-github color-foreground
windlint rename color-white-alpha-16 'color-white/[.16]'
```

## Manual cleanup after renames

### 1. Fix `var()` references in inline styles

`windlint rename` handles utility classes but may miss `var(--color-*)` in JSX props (chart fills, SVG strokes). Search for leftover refs:

```bash
rg 'var\(--color-(orange|green|yellow|primary)-alpha' -g '*.tsx'
rg 'var\(--color-(text-soft|success-dark|warning-dark)' -g '*.tsx'
```

Replace with `color-mix()`:
```tsx
// Before: fill='var(--color-orange-alpha-10)'
// After:  fill='color-mix(in srgb, var(--color-primary) 10%, transparent)'
```

**Never use `var(--color-primary / .10)`.** The `/` opacity syntax only works in Tailwind class names, not inside `var()`. In CSS values, use `color-mix(in srgb, var(--color-primary) 10%, transparent)`.

### 2. Fix chart color collisions

AlignUI used `warning-base` (orange-500) as a chart data color alongside `yellow-500`. After rename, `--warning` might be yellow, making both identical. Replace `bg-warning` with `bg-primary` in chart/visualization contexts:

```bash
# Find chart components using bg-warning next to bg-yellow
rg 'bg-warning|fill-warning' -g '*.tsx' components/widgets/ components/chart*
```

Replace with `bg-primary` (which keeps the original orange).

### 3. Rewrite globals.css

After all renames, `globals.css` will have duplicate definitions, self-referencing vars, and dead tokens. Replace it with the standard shadcn pattern:

```css
@import 'tailwindcss';
@import 'tw-animate-css';

@custom-variant dark (&:is(.dark *));

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
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-info: var(--info);
  --color-info-foreground: var(--info-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-overlay: var(--overlay);
  /* radius, shadows, typography... */
}

:root {
  --background: #ffffff;
  --foreground: #171717;
  --card: #ffffff;
  --card-foreground: #171717;
  --popover: #ffffff;
  --popover-foreground: #171717;
  --primary: #fa7319;
  --primary-foreground: #ffffff;
  --secondary: #f5f5f5;
  --secondary-foreground: #171717;
  --muted: #f7f7f7;
  --muted-foreground: #5c5c5c;
  --accent: #ebebeb;
  --accent-foreground: #171717;
  --destructive: #fb3748;
  --destructive-foreground: #ffffff;
  --success: #1fc16b;
  --success-foreground: #ffffff;
  --warning: #f6b51e;
  --warning-foreground: #ffffff;
  --info: #335cff;
  --info-foreground: #ffffff;
  --border: #ebebeb;
  --input: #d1d1d1;
  --ring: #fa7319;
  --overlay: #3333333d;
}

.dark {
  --background: #171717;
  --foreground: #ffffff;
  --card: #1c1c1c;
  --card-foreground: #f7f7f7;
  --popover: #1c1c1c;
  --popover-foreground: #f7f7f7;
  --secondary: #292929;
  --secondary-foreground: #f7f7f7;
  --muted: #1c1c1c;
  --muted-foreground: #a3a3a3;
  --accent: #333333;
  --accent-foreground: #f7f7f7;
  --destructive: #e93544;
  --success: #1daf61;
  --warning: #e6a819;
  --border: #333333;
  --input: #5c5c5c;
  --overlay: #3333338f;
}
```

**Critical:** use `@theme inline` with `var()` references, not flat hex values. Flat hex values get baked into utility classes at build time, breaking dark mode (`.dark` overrides have no effect since the classes don't reference CSS variables).

### 4. Delete dead tokens

Remove all tokens with 0 usage: `neutral-*` aliases, `illustration-*`, `overlay-slate`, `black-alpha-*`, `slate-alpha-*`, `slate-0`, unused typography/shadow tokens. Run `windlint rename count` to find them.

### 5. Validate

```bash
pnpm build        # verify no compilation errors
windlint rename count  # verify no old token names remain
```

Check dark mode toggle works (`.dark` class on `<html>`). Check charts have distinct colors (no two adjacent bars/slices the same color).
