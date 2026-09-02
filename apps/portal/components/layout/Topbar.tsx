"use client";

import { Bell, ChevronDown, Menu } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface TopbarUser { nome: string; perfil: string; }
interface NotificationItem { id: string; title: string; body: string; readAt: string | null; }
interface TopbarProps {
  title: string;
  user: TopbarUser | null;
  loading: boolean;
  onOpenMenu: () => void;
  onLogout: () => Promise<void>;
}

export function Topbar({ title, user, loading, onOpenMenu, onLogout }: TopbarProps) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationsLoaded, setNotificationsLoaded] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function closeMenus(event: MouseEvent) {
      const target = event.target as Node;
      if (!accountRef.current?.contains(target)) setAccountOpen(false);
      if (!notificationRef.current?.contains(target)) setNotificationsOpen(false);
    }
    document.addEventListener("mousedown", closeMenus);
    return () => document.removeEventListener("mousedown", closeMenus);
  }, []);

  async function toggleNotifications() {
    const nextOpen = !notificationsOpen;
    setNotificationsOpen(nextOpen);
    setAccountOpen(false);
    if (!nextOpen || notificationsLoaded) return;
    try {
      const response = await fetch("/api/v1/notifications?limit=5");
      if (!response.ok) return;
      const body = await response.json() as { data: NotificationItem[] };
      setNotifications(body.data);
    } finally {
      setNotificationsLoaded(true);
    }
  }

  const unreadCount = notifications.filter((item) => item.readAt === null).length;

  return (
    <header className="relative z-30 h-[68px] shrink-0 border-b border-[var(--g-border-subtle)] bg-[var(--g-surface-default)]">
      <div className="absolute inset-x-0 top-0 h-1 bg-[var(--g-brand-primary)]" />
      <div className="flex h-full items-center justify-between gap-4 px-4 pt-1 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={onOpenMenu} className="flex size-11 items-center justify-center rounded-[var(--g-radius-control)] text-[var(--g-text-secondary)] hover:bg-[var(--g-surface-hover)] lg:hidden" aria-label="Abrir navegação">
            <Menu className="size-5" />
          </button>
          <h1 className="truncate text-lg font-semibold text-[var(--g-text-primary)]">{title}</h1>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative" ref={notificationRef}>
            <button type="button" onClick={toggleNotifications} className="relative flex size-11 items-center justify-center rounded-[var(--g-radius-control)] text-[var(--g-text-secondary)] hover:bg-[var(--g-surface-hover)]" aria-label="Notificações" aria-expanded={notificationsOpen}>
              <Bell className="size-5" />
              {unreadCount > 0 && <span className="absolute right-2 top-2 size-2 rounded-full bg-[var(--g-status-danger)]" />}
            </button>
            {notificationsOpen && (
              <div className="absolute right-0 top-12 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-[var(--g-radius-card)] border border-[var(--g-border-subtle)] bg-[var(--g-surface-raised)] shadow-[var(--g-shadow-raised)]">
                <div className="border-b border-[var(--g-border-subtle)] px-4 py-3"><p className="text-sm font-semibold text-[var(--g-text-primary)]">Notificações</p></div>
                {!notificationsLoaded ? (
                  <p className="px-4 py-6 text-sm text-[var(--g-text-secondary)]">Carregando notificações…</p>
                ) : notifications.length === 0 ? (
                  <div className="px-4 py-6"><p className="text-sm font-semibold text-[var(--g-text-primary)]">Tudo em dia</p><p className="mt-1 text-sm text-[var(--g-text-secondary)]">Você não possui notificações recentes.</p></div>
                ) : (
                  <ul className="max-h-80 divide-y divide-[var(--g-border-subtle)] overflow-y-auto">
                    {notifications.map((item) => (
                      <li key={item.id} className="px-4 py-3">
                        <div className="flex gap-3">
                          <span className={`mt-1.5 size-2 shrink-0 rounded-full ${item.readAt ? "bg-[var(--g-border-default)]" : "bg-[var(--g-brand-primary)]"}`} />
                          <div><p className="text-sm font-semibold text-[var(--g-text-primary)]">{item.title}</p><p className="mt-1 text-sm leading-5 text-[var(--g-text-secondary)]">{item.body}</p></div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="relative" ref={accountRef}>
            <button type="button" onClick={() => { setAccountOpen(!accountOpen); setNotificationsOpen(false); }} className="flex min-h-11 items-center gap-3 rounded-[var(--g-radius-control)] px-2 text-left hover:bg-[var(--g-surface-hover)]" aria-label="Abrir menu da conta" aria-expanded={accountOpen}>
              <span className="flex size-9 items-center justify-center rounded-full bg-[var(--g-brand-primary-soft)] text-sm font-semibold text-[var(--g-brand-primary)]">{loading ? "…" : user?.nome?.[0]?.toUpperCase() ?? "U"}</span>
              <span className="hidden min-w-0 sm:block"><span className="block max-w-40 truncate text-sm font-semibold text-[var(--g-text-primary)]">{user?.nome ?? "Usuário"}</span><span className="block text-xs text-[var(--g-text-muted)]">{user?.perfil ?? "Acesso"}</span></span>
              <ChevronDown className="hidden size-4 text-[var(--g-text-muted)] sm:block" />
            </button>
            {accountOpen && (
              <div className="absolute right-0 top-12 w-52 rounded-[var(--g-radius-card)] border border-[var(--g-border-subtle)] bg-[var(--g-surface-raised)] p-2 shadow-[var(--g-shadow-raised)]">
                <button type="button" onClick={() => void onLogout()} className="flex min-h-11 w-full items-center rounded-[var(--g-radius-control)] px-3 text-sm font-semibold text-[var(--g-text-secondary)] hover:bg-[var(--g-surface-hover)] hover:text-[var(--g-text-primary)]">Sair da conta</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
