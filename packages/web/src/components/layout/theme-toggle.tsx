"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const STORAGE_KEY = "yuno-control-tower-theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
    const initial = stored ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(initial);
    document.documentElement.setAttribute("data-theme", initial);
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    window.localStorage.setItem(STORAGE_KEY, next);
  };

  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      <button type="button" className={theme === "light" ? "theme-toggle__btn theme-toggle__btn--active" : "theme-toggle__btn"} onClick={() => apply("light")}>Light</button>
      <button type="button" className={theme === "dark" ? "theme-toggle__btn theme-toggle__btn--active" : "theme-toggle__btn"} onClick={() => apply("dark")}>Dark</button>
    </div>
  );
}
