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
        surface: {
          page: '#F6F6F4',
          card: '#FFFFFF',
          'card-hover': '#FBFBFA',
        },
        line: {
          DEFAULT: '#E4E4E0',          // border
          light: '#EFEFEC',            // internal dividers
        },
        text: {
          primary: '#141414',
          secondary: '#555550',
          tertiary: '#8A8A84',
          quaternary: '#B0B0A8',
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
        // ---- Tag domain colors (slightly muted v3 set) ------------------
        philosophy: { bg: '#EEF0FF', fg: '#4547A9' },
        religion: { bg: '#E6F5EE', fg: '#1A6B45' },
        psychology: { bg: '#FFF0F0', fg: '#A33030' },
        literature: { bg: '#E8F2FC', fg: '#2A5F9E' },
        language: { bg: '#FFF6E0', fg: '#7A5B14' },
        history: { bg: '#FFF0E8', fg: '#8B3A1D' },
        media_tech: { bg: '#F0F0EC', fg: '#4A4840' },
        social_political: { bg: '#EEF6E6', fg: '#3A6B1A' },
        science: { bg: '#E8F2FC', fg: '#2A5F9E' },
        biography: { bg: '#EEF0FF', fg: '#4547A9' },
        arts_culture: { bg: '#FFF0E8', fg: '#8B3A1D' },
        books_libraries: { bg: '#F0F0EC', fg: '#4A4840' },
        gold: { bg: '#FFF6E0', fg: '#7A5B14' },
      },
      fontFamily: {
        // Outfit becomes primary; Cormorant + Source Serif stay defined here
        // so existing usages don't crash before step 3 retires them, but
        // they are no longer recommended.
        serif: ['"Source Serif 4"', '"Lora"', 'Georgia', 'serif'],
        display: ['"Outfit"', '"Inter"', 'system-ui', 'sans-serif'],
        sans: ['"Outfit"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
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
