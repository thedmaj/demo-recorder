/**
 * Gingham — Tailwind theme mapping.
 *
 * This maps Tailwind utilities onto the CSS custom properties in `gingham.css`,
 * so `gingham.css` stays the SINGLE source of truth. Import gingham.css at your
 * app root, then use classes like `bg-gg-primary`, `text-gg-ink`,
 * `rounded-gg-lg`, `shadow-gg-md`, `font-display`, `bg-gradient-weave`.
 *
 * CommonJS shown; for ESM use `export default { ... }`.
 * Merge `theme.extend` into your existing config rather than replacing it.
 */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,html}"],
  theme: {
    extend: {
      colors: {
        "gg-blue": {
          50: "var(--gg-blue-50)", 100: "var(--gg-blue-100)", 200: "var(--gg-blue-200)",
          300: "var(--gg-blue-300)", 400: "var(--gg-blue-400)", 500: "var(--gg-blue-500)",
          600: "var(--gg-blue-600)", 700: "var(--gg-blue-700)", 800: "var(--gg-blue-800)", 900: "var(--gg-blue-900)",
        },
        "gg-sky": {
          50: "var(--gg-sky-50)", 100: "var(--gg-sky-100)", 200: "var(--gg-sky-200)", 300: "var(--gg-sky-300)",
          400: "var(--gg-sky-400)", 500: "var(--gg-sky-500)", 600: "var(--gg-sky-600)", 700: "var(--gg-sky-700)",
        },
        "gg-gray": {
          50: "var(--gg-gray-50)", 100: "var(--gg-gray-100)", 200: "var(--gg-gray-200)", 300: "var(--gg-gray-300)",
          400: "var(--gg-gray-400)", 500: "var(--gg-gray-500)", 600: "var(--gg-gray-600)", 700: "var(--gg-gray-700)",
        },
        gg: {
          ink: "var(--gg-ink)",
          bg: "var(--gg-bg)",
          "bg-subtle": "var(--gg-bg-subtle)",
          surface: "var(--gg-surface)",
          border: "var(--gg-border)",
          text: "var(--gg-text)",
          "text-muted": "var(--gg-text-muted)",
          "text-subtle": "var(--gg-text-subtle)",
          primary: "var(--gg-primary)",
          "primary-hover": "var(--gg-primary-hover)",
          "primary-tint": "var(--gg-primary-tint)",
          accent: "var(--gg-accent)",
          link: "var(--gg-link)",
          positive: "var(--gg-positive)",
          warning: "var(--gg-warning)",
          negative: "var(--gg-negative)",
        },
      },
      fontFamily: {
        display: ["Space Grotesk", "system-ui", "sans-serif"],
        sans: ["Hanken Grotesk", "system-ui", "sans-serif"],
      },
      borderRadius: {
        "gg-sm": "var(--gg-radius-sm)",
        "gg-md": "var(--gg-radius-md)",
        "gg-lg": "var(--gg-radius-lg)",
        "gg-xl": "var(--gg-radius-xl)",
      },
      boxShadow: {
        "gg-sm": "var(--gg-shadow-sm)",
        "gg-md": "var(--gg-shadow-md)",
        "gg-lg": "var(--gg-shadow-lg)",
        "gg-primary": "var(--gg-shadow-primary)",
        "gg-focus": "var(--gg-focus-ring)",
      },
      backgroundImage: {
        "gradient-weave": "var(--gg-grad-weave)",
        "gradient-deep-weave": "var(--gg-grad-deep-weave)",
        "gradient-mist": "var(--gg-grad-mist)",
      },
      letterSpacing: {
        "gg-tight": "-0.03em",
        "gg-eyebrow": "0.12em",
      },
    },
  },
  plugins: [],
};
