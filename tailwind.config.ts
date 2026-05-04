import type { Config } from 'tailwindcss';

/**
 * Carnegie palette (v3 redesign).
 *
 * Primary accent: #1B3A5C navy. Status colors: gold (approve / progress),
 * green (high confidence / done), amber (medium confidence / warning),
 * red (reject / low confidence).
 *
 * Surfaces drop the warm cream palette in favour of true off-white card
 * stacks on a #F6F6F4 page. The legacy token names (`cream`, `limestone`,
 * `marble`, `brass`, `accent`, `mahogany`, `tartan`, `fern`) are kept so
 * existing utility classes don't need to be rewritten in this step — they
 * now point at the new palette.
 */
const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ---- New palette tokens (preferred for new code) -----------------
        // Use these going forward. The legacy tokens below alias to the
        // same values so existing class strings keep working until each
        // screen gets restyled.
        navy: {
          DEFAULT: '#1B3A5C',         // Carnegie navy — primary interactive color
          soft: '#ECF0F4',             // hover backgrounds, selected rows (~ rgba(27,58,92,0.08) on white)
          mid: '#DDE3EC',              // badges, filter pills (~ rgba(27,58,92,0.15) on white)
          deep: '#14304B',             // active / hover-darken
        },
        carnegie: {
          gold: '#C4A35A',             // approve / progress / brand accent
          'gold-soft': '#FAF4E5',      // approved row tint (~ rgba(196,163,90,0.10) on white)
          green: '#1A8754',            // high confidence / done
          'green-soft': '#EAF6F0',     // ~ rgba(26,135,84,0.07)
          red: '#B83232',              // reject / low confidence / error
          'red-soft': '#FBECEC',       // ~ rgba(184,50,50,0.06)
          amber: '#C08800',            // medium confidence / warning
          'amber-soft': '#FBF4E6',     // ~ rgba(192,136,0,0.07)
        },
        // The v3 surface / line / text tokens are wired to CSS variables
        // defined in globals.css so they swap on .dark automatically.
        // Consumers write `bg-surface-card` / `text-text-primary` / etc.
        // and pick up the right value in either mode without per-call
        // dark: overrides. The `<alpha-value>` placeholder lets Tailwind's
        // opacity utilities (`/40`, `/60`) keep working.
        surface: {
          page: 'rgb(var(--color-surface-page) / <alpha-value>)',
          card: 'rgb(var(--color-surface-card) / <alpha-value>)',
          'card-hover': 'rgb(var(--color-surface-card-hover) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--color-line) / <alpha-value>)',
          light: 'rgb(var(--color-line-light) / <alpha-value>)',
        },
        text: {
          primary: 'rgb(var(--color-text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--color-text-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--color-text-tertiary) / <alpha-value>)',
          quaternary: 'rgb(var(--color-text-quaternary) / <alpha-value>)',
        },

        // ---- Legacy tokens, repointed to the new palette -----------------
        // These keep `bg-cream-50`, `text-accent`, `bg-brass`, `border-mahogany`
        // etc. working with the new colors. Do not introduce new uses;
        // prefer the tokens above for any restyle.
        ink: {
          DEFAULT: '#141414',          // text primary (was warm walnut)
          soft: '#242220',             // dark-mode card surface (was polished oak)
          elevated: '#3A3836',         // dark-mode borders (was lighter oak)
        },
        cream: {
          50: '#FFFFFF',               // card surface (was limestone)
          100: '#FBFBFA',              // card-hover / inputs (was mid-tone cream)
          200: '#EFEFEC',              // border-light / table headers (was deeper cream)
          300: '#E4E4E0',              // border (was warm border)
        },
        accent: {
          DEFAULT: '#1B3A5C',          // navy (was library green)
          soft: '#ECF0F4',             // pale navy tint (was pale green)
          deep: '#14304B',             // darker navy (was darker green)
        },
        brass: {
          DEFAULT: '#C4A35A',          // Carnegie gold (was old brass)
          soft: '#FAF4E5',             // pale gold tint (was pale brass)
          deep: '#A88940',             // darker gold (was darker brass)
        },
        fern: '#14304B',               // hover/secondary — now darker navy
        'green-deep': '#14304B',       // legacy header tone — now darker navy
        mahogany: '#B83232',           // warning/low-confidence — now red
        tartan: '#B83232',             // dark-mode reject — now red
        marble: '#F6F6F4',             // page background — new neutral
        limestone: '#FFFFFF',          // card surface — now white
        // ---- Tag domain colors (21-class LCC-aligned palette) -----------
        // Each domain corresponds to one LCC top-level class letter.
        // The bg is a soft tint, the fg is the saturated version used
        // for text + dark-mode swap. Empty domains use the same colors;
        // the UI applies opacity / scale to indicate emptiness.
        general_works: { bg: '#EFEFEF', fg: '#5C5C5C' },             // A — neutral gray (catchall)
        philosophy_psychology_religion: { bg: '#EEF0FF', fg: '#4547A9' }, // B — indigo (was philosophy)
        auxiliary_history: { bg: '#F2EBE3', fg: '#6B4D2E' },         // C — muted brown (incl. CT biography)
        world_history: { bg: '#FFF0E8', fg: '#8B3A1D' },             // D — red-brown (was history)
        american_history: { bg: '#FFE5DD', fg: '#A03517' },          // E — bright russet
        local_american_history: { bg: '#F5E2D8', fg: '#8A4F38' },    // F — muted russet
        geography_recreation: { bg: '#E5EDDA', fg: '#44663B' },      // G — forest green
        social_sciences: { bg: '#EEF6E6', fg: '#3A6B1A' },           // H — leaf green (was social_political)
        political_science: { bg: '#D9E6CC', fg: '#294E18' },         // J — deeper green
        law: { bg: '#E2E5EC', fg: '#3A4A6B' },                       // K — slate
        education: { bg: '#FAF1D9', fg: '#8C6A1A' },                 // L — warm tan
        music: { bg: '#FBE6EE', fg: '#A33D5E' },                     // M — rose
        fine_arts: { bg: '#FFEEE2', fg: '#B05030' },                 // N — terracotta (distinct from world_history)
        language_literature: { bg: '#E8F2FC', fg: '#2A5F9E' },       // P — blue (was literature)
        science: { bg: '#E0EAF7', fg: '#1F4F87' },                   // Q — denim (slightly distinct from P)
        medicine: { bg: '#E0F0EC', fg: '#2D6E60' },                  // R — clinical teal
        agriculture: { bg: '#E0E5D0', fg: '#4F5C24' },               // S — sage
        technology: { bg: '#F0F0EC', fg: '#4A4840' },                // T — graphite (was media_tech)
        military_science: { bg: '#E5E0BF', fg: '#6F6427' },          // U — olive
        naval_science: { bg: '#DDE5F0', fg: '#2D4A6B' },             // V — navy (distinct from law's slate)
        books_libraries: { bg: '#F2EFE2', fg: '#6B5E3D' },           // Z — beige (distinct from technology)
        gold: { bg: '#FFF6E0', fg: '#7A5B14' },
      },
      fontFamily: {
        // Sans-serif everywhere. The `serif` and `display` keys still exist
        // so any straggling `font-serif` / `font-display` class falls back
        // gracefully to Outfit instead of compiling to a broken stack.
        sans: ['"Outfit"', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['"Outfit"', 'system-ui', '-apple-system', 'sans-serif'],
        serif: ['"Outfit"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      transitionTimingFunction: {
        gentle: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
