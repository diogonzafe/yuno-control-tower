"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CurrentUser, NavCounts, StreamStatus } from "../../types/dashboard";
import { ThemeToggle } from "./theme-toggle";

const navItems = [
  { n: "01", label: "Portfolio", href: "/", key: "portfolio" as const },
  { n: "02", label: "Merchant view", href: "/merchants", key: null },
  { n: "03", label: "Ingestion", href: "/ingestion", key: "ingestion" as const },
  { n: "04", label: "Alerts", href: "/alerts", key: "alerts" as const },
];

export function Sidebar({ counts, stream, user }: { counts: NavCounts; stream: StreamStatus; user: CurrentUser }) {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <div className="sidebar__brand"><span className="sidebar__logo">yuno</span><span className="sidebar__wordmark">Control tower</span></div>
      <nav className="sidebar__nav">
        {navItems.map((item) => {
          const count = item.key ? counts[item.key] : undefined;
          const active = pathname === item.href;
          return (
            <Link key={item.n} href={item.href} className={`sidebar__nav-item ${active ? "sidebar__nav-item--active" : ""}`} aria-current={active ? "page" : undefined}>
              <span className="sidebar__nav-index">{item.n}</span>
              <span className="sidebar__nav-label">{item.label}</span>
              {count !== undefined && <span className="sidebar__nav-count">{count}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar__footer">
        <div className="sidebar__stream"><i className="sidebar__stream-dot" /><div><strong>Stream live</strong><span>{stream.label}</span><span>lag {stream.lagSeconds.toFixed(1)}s · {stream.messagesPerSecond} msg/s</span></div></div>
        <ThemeToggle />
        <div className="sidebar__user"><span className="sidebar__avatar">{user.initials}</span><div><strong>{user.name}</strong><span>{user.role}</span></div></div>
      </div>
    </aside>
  );
}
