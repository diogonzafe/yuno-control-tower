import type { ReactNode } from "react";

export function Term({ children, title }: { children: ReactNode; title: string }) {
  return (
    <span className="ct-term" title={title}>
      {children}
    </span>
  );
}
