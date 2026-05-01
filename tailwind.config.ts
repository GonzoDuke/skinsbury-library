import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#4A3F35',  // warm medium walnut — body in dark mode (workable, not gloomy)
          soft: '#5C4E42',     // polished oak — card surfaces, clearly elevated above body
          elevated: '#6E5E50', // lighter oak — hover / active surfaces
        },
        // Cream tokens kept for backward compatibility, retuned to Carnegie
        // limestone/marble palette so widespread `bg-cream-50` etc. picks up
        // the rebrand automatically.
        cream: {
          50: '#E8E2D4',  // limestone — card surfaces
          100: '#F0EBDD', // mid-tone for inputs and hover
          200: '#DCD4C2', // deeper for table headers
          300: '#C9BEA6', // borders
        },
        accent: {
          DEFAULT: '#1E3A2F', // library green
          soft: '#DCE7DF',    // pale green tint for soft backgrounds
          deep: '#16302A',    // darker green for active / hover-darken
        },
        brass: {
          DEFAULT: '#C9A96E',
          soft: '#F1E8D5',
          deep: '#A88B54',
        },
        fern: '#2D5A4A',           // hover, secondary buttons
        'green-deep': '#1E4534',   // dark-mode header — Scottish racing green
        mahogany: '#8B4513',       // warnings, low-confidence (light mode)
        tartan: '#7A2030',         // Scottish-red accent — dark-mode warnings / reject states
        marble: '#F5F2EB',         // page background (light)
        limestone: '#E8E2D4',      // card surfaces (light)
        // Domain colors
        philosophy: { bg: '#EEEDFE', fg: '#3C3489' },
        religion: { bg: '#E1F5EE', fg: '#085041' },
        psychology: { bg: '#FBEAF0', fg: '#72243E' },
        literature: { bg: '#E6F1FB', fg: '#0C447C' },
        language: { bg: '#FAEEDA', fg: '#633806' },
        history: { bg: '#FAECE7', fg: '#712B13' },
        media_tech: { bg: '#F1EFE8', fg: '#444441' },
        social_political: { bg: '#EAF3DE', fg: '#27500A' },
        science: { bg: '#E6F1FB', fg: '#0C447C' },
        biography: { bg: '#EEEDFE', fg: '#3C3489' },
        arts_culture: { bg: '#FAECE7', fg: '#712B13' },
        books_libraries: { bg: '#F1EFE8', fg: '#444441' },
        gold: { bg: '#FAEEDA', fg: '#633806' },
      },
      fontFamily: {
        serif: ['"Source Serif 4"', '"Lora"', 'Georgia', 'serif'],
        // Display / wordmark / page headings — institutional, slightly letterspaced
        display: ['"Cormorant Garamond"', '"Source Serif 4"', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
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
