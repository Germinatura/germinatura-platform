"use client";

import {
  notificationReadResponseSchema,
  notificationSchema,
  notificationsResponseSchema,
} from "@germinatura/contracts";
import { Badge, Button, Card } from "@germinatura/ui";
import { BellRing, Check, CircleAlert, Inbox, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";

type Notification = z.infer<typeof notificationSchema>;

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" });

async function fetchNotifications(cursor?: string, unreadOnly = false) {
  const params = new URLSearchParams({ limit: "20", unreadOnly: String(unreadOnly) });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/v1/notifications?${params.toString()}`, { cache: "no-store" });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error("Não foi possível carregar suas notificações. Tente novamente em alguns instantes.");
  const parsed = notificationsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("As notificações retornaram dados inválidos. Atualize a página e tente novamente.");
  return parsed.data;
}

export function NotificationsCenter() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const loadInitial = useCallback(async (onlyUnread: boolean) => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchNotifications(undefined, onlyUnread);
      setNotifications(result.data);
      setNextCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar suas notificações.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadInitial(unreadOnly), 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadInitial, unreadOnly]);

  const unreadCount = useMemo(() => notifications.filter((notification) => notification.readAt === null).length, [notifications]);

  async function markRead(id: string) {
    setBusyId(id);
    setError("");
    try {
      const response = await fetch(`/api/v1/notifications/${id}/read`, { method: "POST" });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error("Não foi possível marcar a notificação como lida. Tente novamente.");
      const parsed = notificationReadResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error("A atualização retornou uma resposta inesperada. Atualize a página.");
      const { readAt } = parsed.data.data;
      setNotifications((current) => unreadOnly
        ? current.filter((notification) => notification.id !== id)
        : current.map((notification) => notification.id === id ? { ...notification, readAt } : notification));
      window.dispatchEvent(new CustomEvent("germinatura:notification-read", { detail: { id, readAt } }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível atualizar a notificação.");
    } finally {
      setBusyId(null);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError("");
    try {
      const result = await fetchNotifications(nextCursor, unreadOnly);
      setNotifications((current) => [...current, ...result.data.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setNextCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar mais notificações.");
    } finally {
      setLoadingMore(false);
    }
  }

  return <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10"><div className="mx-auto max-w-[var(--g-content-standard)] space-y-6">
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-sm font-semibold text-[var(--g-brand-primary)]">Comunicação</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Notificações</h1><p className="mt-2 max-w-2xl text-base leading-6 text-[var(--g-text-secondary)]">Acompanhe atualizações importantes sobre reservas, pagamentos, fechamentos e rifas.</p></div><Button variant={unreadOnly ? "brand" : "secondary"} onClick={() => setUnreadOnly((current) => !current)} aria-pressed={unreadOnly}>{unreadOnly ? "Mostrando não lidas" : "Mostrar somente não lidas"}</Button></header>

    {error && <div role="alert" className="flex flex-col gap-3 rounded-[var(--g-radius-control)] bg-[var(--g-status-danger-soft)] p-4 text-sm text-[var(--g-status-danger-foreground)] sm:flex-row sm:items-center sm:justify-between"><span className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" />{error}</span><button type="button" onClick={() => void loadInitial(unreadOnly)} className="inline-flex min-h-11 items-center gap-2 font-semibold"><RefreshCw className="size-4" /> Tentar novamente</button></div>}

    {!loading && notifications.length > 0 && <div className="flex items-center gap-2 text-sm text-[var(--g-text-secondary)]"><Badge tone={unreadCount > 0 ? "info" : "neutral"}>{unreadCount} {unreadCount === 1 ? "não lida" : "não lidas"}</Badge><span>nesta página</span></div>}

    {loading ? <section className="space-y-3" aria-label="Carregando notificações">{Array.from({ length: 4 }, (_, index) => <Card key={index} className="animate-pulse p-5"><div className="h-4 w-32 rounded bg-[var(--g-surface-subtle)]" /><div className="mt-3 h-5 w-2/3 rounded bg-[var(--g-surface-subtle)]" /><div className="mt-2 h-4 w-full rounded bg-[var(--g-surface-subtle)]" /></Card>)}</section>
      : notifications.length === 0 ? <Card className="p-10 text-center"><Inbox className="mx-auto size-11 text-[var(--g-text-muted)]" /><h2 className="mt-4 text-lg font-semibold">{unreadOnly ? "Nenhuma notificação não lida" : "Tudo em dia"}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--g-text-secondary)]">{unreadOnly ? "Quando chegar uma nova atualização, ela aparecerá aqui." : "Você não possui notificações recentes."}</p></Card>
      : <section className="space-y-3" aria-label="Lista de notificações">{notifications.map((notification) => <Card key={notification.id} tone={notification.readAt ? "default" : "selected"} className="p-5"><div className="flex items-start gap-4"><span className={`flex size-11 shrink-0 items-center justify-center rounded-[var(--g-radius-control)] ${notification.readAt ? "bg-[var(--g-surface-subtle)] text-[var(--g-text-muted)]" : "bg-[var(--g-brand-primary-soft)] text-[var(--g-brand-primary)]"}`}><BellRing className="size-5" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{notification.title}</h2>{!notification.readAt && <Badge tone="info">Nova</Badge>}</div><p className="mt-2 text-sm leading-6 text-[var(--g-text-secondary)]">{notification.body}</p><p className="mt-3 text-xs text-[var(--g-text-muted)]">{dateTime.format(new Date(notification.createdAt))}</p></div>{!notification.readAt && <Button variant="ghost" size="sm" loading={busyId === notification.id} onClick={() => void markRead(notification.id)} aria-label={`Marcar “${notification.title}” como lida`}><Check className="size-4" /><span className="hidden sm:inline">Marcar como lida</span></Button>}</div></Card>)}</section>}
    {nextCursor && !loading && <div className="flex justify-center"><Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>Carregar mais notificações</Button></div>}
  </div></div>;
}
