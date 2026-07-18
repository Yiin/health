"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  FileText,
  FlaskConical,
  HeartPulse,
  LayoutDashboard,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Upload,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/labs", label: "Labs", icon: FlaskConical },
  { href: "/vitals", label: "Vitals", icon: HeartPulse },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/upload", label: "Upload", icon: Upload },
  { href: "/insights", label: "Insights", icon: Sparkles },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 flex-col gap-1 p-2">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          onClick={onNavigate}
          title={collapsed ? label : undefined}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            collapsed && "justify-center px-2",
            isActive(pathname, href)
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
          )}
        >
          <Icon className="size-4 shrink-0" />
          {!collapsed && <span className="truncate">{label}</span>}
        </Link>
      ))}
    </nav>
  );
}

function SidebarBrand({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        "flex h-12 items-center gap-2 border-b border-sidebar-border px-4",
        collapsed && "justify-center px-2",
      )}
    >
      <Activity className="size-5 shrink-0 text-sidebar-primary" />
      {!collapsed && (
        <span className="text-base font-semibold tracking-tight">Health</span>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <SidebarBrand collapsed={collapsed} />
        <NavLinks collapsed={collapsed} />
        <div className="border-t border-sidebar-border p-2">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              collapsed && "justify-center px-2",
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4 shrink-0" />
            ) : (
              <PanelLeftClose className="size-4 shrink-0" />
            )}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-sidebar text-sidebar-foreground shadow-xl">
            <div className="flex h-12 items-center justify-between border-b border-sidebar-border pr-2">
              <SidebarBrand collapsed={false} />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="rounded-lg p-2 text-sidebar-foreground/70 hover:bg-sidebar-accent/60"
              >
                <X className="size-4" />
              </button>
            </div>
            <NavLinks
              collapsed={false}
              onNavigate={() => setMobileOpen(false)}
            />
          </aside>
        </div>
      )}

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 md:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted"
          >
            <Menu className="size-5" />
          </button>
          <span className="text-base font-semibold tracking-tight">Health</span>
        </header>
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
