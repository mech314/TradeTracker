/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,html}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["DM Sans", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        surface: {
          DEFAULT: "#0c0f14",
          raised: "#12171f",
          overlay: "#181e29",
        },
        accent: { DEFAULT: "#3d8bfd", muted: "#2a5a9e" },
        gain: "#34d399",
        loss: "#f87171",
      },
    },
  },
  plugins: [],
};
