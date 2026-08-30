import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "../components/layout/sidebar";
import { currentUser, navCounts, streamStatus } from "../lib/dashboard-data";

export const metadata: Metadata = { title: "Yuno Control Tower", description: "Payment operations monitoring" };

const themeInitScript = `(function(){try{var t=localStorage.getItem("yuno-control-tower-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeInitScript }} /></head>
      <body>
        <div className="app-shell">
          <Sidebar counts={navCounts} stream={streamStatus} user={currentUser} />
          <main className="dashboard">{children}</main>
        </div>
      </body>
    </html>
  );
}
