import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "rgb(var(--mozi-app-bg) / <alpha-value>)",
        surface: "rgb(var(--mozi-surface-base) / <alpha-value>)",
        elevated: "rgb(var(--mozi-surface-elevated) / <alpha-value>)",
        inputSurface: "rgb(var(--mozi-surface-input) / <alpha-value>)",
        hover: "rgb(var(--mozi-surface-hover) / <alpha-value>)",
        active: "rgb(var(--mozi-surface-active) / <alpha-value>)",
        ink: "rgb(var(--ink-rgb) / <alpha-value>)",
        sheet: "rgb(var(--sheet-rgb) / <alpha-value>)",
        accent: {
          DEFAULT: "rgb(var(--mozi-accent) / <alpha-value>)",
          light: "rgb(var(--mozi-accent-light) / <alpha-value>)",
          glow: "rgba(58,141,255,0.14)",
        },
        success: "rgb(var(--mozi-success) / <alpha-value>)",
        warning: "rgb(var(--mozi-warning) / <alpha-value>)",
        error: "rgb(var(--mozi-danger) / <alpha-value>)",
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"SF Pro Text"', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        card: "8px",
        btn: "6px",
        badge: "4px",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
