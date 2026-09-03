"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/console", label: "Console" },
  { href: "/history", label: "History" },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="ct-navbar">
      <div className="ct-brand"><strong>Control Tower</strong><span>Yuno</span></div>
      <div className="ct-navbar__links">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={pathname === link.href ? "ct-navbar__active" : ""}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
