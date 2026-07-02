import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        kalshi: {
          bg: "#0e0e12",
          surface: "#16161d",
          border: "rgba(255,255,255,0.10)",
          orange: "#f7931a",
          green: "#2ecc71",
          red: "#e74c3c",
          muted: "#8b8b9a",
          text: "#f5f5f7",
        },
      },
    },
  },
  plugins: [],
};
export default config;
