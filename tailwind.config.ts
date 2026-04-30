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
          DEFAULT: '#1A1A18',
          soft: '#2A2A26',
        },
        cream: {
          50: '#FDFBF5',
          100: '#FAFAF7',
          200: '#F5F2E8',
          300: '#EDE8D7',
        },
        accent: {
          DEFAULT: '#C85A12', // Princeton orange, a touch darker
          soft: '#FCEBDA',
          deep: '#A04610',
        },
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
