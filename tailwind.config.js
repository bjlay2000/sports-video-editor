/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#1a1a2e",
          light: "#16213e",
          dark: "#0f0f1a",
        },
        accent: {
          DEFAULT: "#e94560",
          hover: "#ff6b81",
        },
        panel: {
          DEFAULT: "#1e1e32",
          border: "#2a2a4a",
        },
      },
    },
  },
  plugins: [],
};
