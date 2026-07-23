"use client";

import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createApiFetch } from "@/lib/api-fetch";
import { useAuth } from "@/lib/auth-context";
import { signIn, signOut } from "next-auth/react";
import {
  AlertTriangle,
  ChevronDown,
  FileText,
  MessageSquare,
  PanelLeft,
  Plus,
  Send,
  Trash2,
  Upload,
} from "lucide-react";

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: SourceInfo[];
  followUps?: string[];
  error?: boolean;
};

type SourceInfo = {
  filename: string;
  snippet: string;
};

type Session = {
  id: string;
  title: string;
  active: boolean;
  documents?: { filename: string; chunks: number }[];
  totalChunks?: number;
  totalMessages?: number;
};

type BackendSession = {
  id: string;
  title: string;
  documents?: { filename: string; chunks: number }[];
  total_chunks?: number;
  total_messages?: number;
};

const EMPTY_MESSAGES: Message[] = [];

function createSessionId() {
  return String(Date.now());
}

function hasSessionDocuments(session: Pick<Session, "documents" | "totalChunks">) {
  return Boolean(
    (session.documents && session.documents.length > 0) ||
      (session.totalChunks && session.totalChunks > 0),
  );
}

function normalizeSources(sources: unknown): SourceInfo[] {
  if (!Array.isArray(sources)) return [];

  return sources
    .map((source) => {
      if (typeof source === "string") {
        return { filename: source, snippet: "" };
      }

      if (
        source &&
        typeof source === "object" &&
        "filename" in source &&
        typeof source.filename === "string"
      ) {
        return {
          filename: source.filename,
          snippet:
            "snippet" in source && typeof source.snippet === "string"
              ? source.snippet
              : "",
        };
      }

      return null;
    })
    .filter((source): source is SourceInfo => source !== null);
}

function normalizeMessages(messages: unknown): Message[] {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((message): Message | null => {
      if (
        !message ||
        typeof message !== "object" ||
        !("role" in message) ||
        !("content" in message) ||
        (message.role !== "user" && message.role !== "assistant") ||
        typeof message.content !== "string"
      ) {
        return null;
      }

      const rawFollowUps =
        "followUps" in message ? message.followUps : "follow_ups" in message ? message.follow_ups : [];

      return {
        role: message.role,
        content: message.content,
        sources: normalizeSources("sources" in message ? message.sources : []),
        followUps: Array.isArray(rawFollowUps)
          ? rawFollowUps.filter((item): item is string => typeof item === "string")
          : [],
      };
    })
    .filter((message): message is Message => message !== null);
}

function deriveSessionTitle(messages: Message[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");

  if (!firstUserMessage) {
    return "Nueva Sesion";
  }

  const title = firstUserMessage.content.trim().replace(/\s+/g, " ");
  return title.length > 30 ? `${title.slice(0, 30)}...` : title;
}

function MessageSources({ sources }: { sources: SourceInfo[] }) {
  const [expandedSource, setExpandedSource] = useState<number | null>(null);

  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
      <div className="flex flex-wrap gap-1.5">
        {sources.map((src, j) => (
          <button
            key={`${src.filename}-${j}`}
            type="button"
            onClick={() =>
              setExpandedSource((current) => (current === j ? null : j))
            }
            className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-background px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/10"
          >
            <FileText className="size-3" />
            <span>{src.filename}</span>
            <ChevronDown
              className={`size-3 transition-transform duration-200 ${
                expandedSource === j ? "rotate-180" : "rotate-0"
              }`}
            />
          </button>
        ))}
      </div>
      {expandedSource !== null && sources[expandedSource] && (
        <p className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
          {sources[expandedSource].snippet}
        </p>
      )}
    </div>
  );
}

export default function ChatPage() {
  const { isAuthenticated, user, token } = useAuth();
  const [sessionMessages, setSessionMessages] = useState<
    Record<string, Message[]>
  >({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [apiStatus, setApiStatus] = useState<"checking" | "ok" | "error">(
    "checking",
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamControllerRef = useRef<AbortController | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<Session | null>(null);
  const [deleteConfirmEntering, setDeleteConfirmEntering] = useState(false);
  const [docsPanelOpen, setDocsPanelOpen] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const deleteConfirmCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
  const apiFetch = useMemo(() => createApiFetch(() => token), [token]);
  const activeSession = sessions.find((session) => session.active);
  const activeSessionId = activeSession?.id;
  const activeSessionTitle = activeSession?.title || "Carga tu documento";
  const activeSessionDocuments = activeSession?.documents || [];
  const activeSessionTotalChunks = activeSession?.totalChunks || 0;
  const messages = activeSessionId
    ? sessionMessages[activeSessionId] || EMPTY_MESSAGES
    : EMPTY_MESSAGES;
  const showEmptyState = !activeSession;

  const openDeleteConfirm = (session: Session) => {
    if (deleteConfirmCloseTimeoutRef.current) {
      clearTimeout(deleteConfirmCloseTimeoutRef.current);
      deleteConfirmCloseTimeoutRef.current = null;
    }

    setDeleteConfirm(session);
    setDeleteConfirmEntering(false);
    requestAnimationFrame(() => setDeleteConfirmEntering(true));
  };

  const closeDeleteConfirm = useCallback(() => {
    setDeleteConfirmEntering(false);

    if (deleteConfirmCloseTimeoutRef.current) {
      clearTimeout(deleteConfirmCloseTimeoutRef.current);
    }

    deleteConfirmCloseTimeoutRef.current = setTimeout(() => {
      setDeleteConfirm(null);
      deleteConfirmCloseTimeoutRef.current = null;
    }, 200);
  }, []);

  useEffect(() => {
    return () => {
      if (deleteConfirmCloseTimeoutRef.current) {
        clearTimeout(deleteConfirmCloseTimeoutRef.current);
      }
    };
  }, []);

  const fetchSessionData = useCallback(() => {
    apiFetch(`${API_BASE}/api/sessions`)
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data)) {
          setSessions((prev) => {
            const currentActiveId = prev.find((session) => session.active)?.id;
            const backendSessions: Session[] = data
              .map((session: BackendSession) => ({
                id: session.id,
                title: session.title,
                active: session.id === currentActiveId,
                documents: session.documents,
                totalChunks: session.total_chunks,
                totalMessages: session.total_messages,
              }))
              .filter(
                (session) =>
                  session.id !== "default" &&
                  (hasSessionDocuments(session) ||
                    (session.totalMessages && session.totalMessages > 0)),
              );

            const backendSessionIds = new Set(
              backendSessions.map((session) => session.id),
            );
            const frontendOnlySessions = prev
              .filter((session) => !backendSessionIds.has(session.id))
              .map((session) => ({
                ...session,
                active: session.id === currentActiveId,
              }));
            const mergedSessions = [...frontendOnlySessions, ...backendSessions];

            const hasActive = mergedSessions.some((session) => session.active);
            if (!hasActive && mergedSessions.length > 0) {
              mergedSessions[0].active = true;
            }

            return mergedSessions;
          });
        }
      })
      .catch(() => {
        // Si falla, mantener el estado local sin romper la app.
      });
  }, [API_BASE, apiFetch]);

  function updateSessionMessages(
    sessionId: string,
    updater: Message[] | ((prev: Message[]) => Message[]),
  ) {
    setSessionMessages((prev) => {
      const currentMessages = prev[sessionId] || [];
      const nextMessages =
        typeof updater === "function" ? updater(currentMessages) : updater;

      return {
        ...prev,
        [sessionId]: nextMessages,
      };
    });
  }

  async function loadSessionMessages(sessionId: string) {
    try {
      const res = await apiFetch(`${API_BASE}/api/sessions/${sessionId}/messages`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.messages)) {
        setSessionMessages((prev) => ({
          ...prev,
          [sessionId]: normalizeMessages(data.messages),
        }));
      }
    } catch {
      // Mantener los mensajes locales si no se puede leer el historial persistido.
    }
  }

  function createLocalSession(newId: string, title = "Nueva Sesion") {
    const newSession: Session = {
      id: newId,
      title,
      active: true,
    };

    setSessions((prev) =>
      prev.map((session) => ({ ...session, active: false })).concat(newSession),
    );
    setSessionMessages((prev) => ({
      ...prev,
      [newId]: [],
    }));

    return newId;
  }

  function handleTitleSave() {
    if (!activeSessionId) {
      setEditingTitle(false);
      return;
    }

    const newTitle = editTitleValue.trim();
    if (newTitle && newTitle !== activeSessionTitle) {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === activeSessionId ? { ...session, title: newTitle } : session,
        ),
      );
      apiFetch(`${API_BASE}/api/sessions/${activeSessionId}/title`, {
        method: "PUT",
        body: JSON.stringify({ title: newTitle }),
      }).catch(() => {});
    }
    setEditingTitle(false);
  }

  useEffect(() => {
    if (!isAuthenticated) {
      setSessions([]);
      setSessionMessages({});
      return;
    }
    fetchSessionData();
  }, [isAuthenticated, fetchSessionData]);

  useEffect(() => {
    if (activeSessionId && sessionMessages[activeSessionId] === undefined) {
      loadSessionMessages(activeSessionId);
    }
  }, [activeSessionId, sessionMessages]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, streaming]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3000);

    apiFetch(`${API_BASE}/health`, { signal: controller.signal })
      .then((res) => {
        setApiStatus(res.ok ? "ok" : "error");
      })
      .catch(() => {
        setApiStatus("error");
      })
      .finally(() => {
        window.clearTimeout(timeout);
      });

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [API_BASE, apiFetch]);

  useEffect(() => {
    return () => {
      streamControllerRef.current?.abort();
      streamControllerRef.current = null;
    };
  }, []);

  function getErrorMessage(status?: number) {
    if (status === 429) {
      return "Atención: Gemini está recargando, esperá 30 segundos y volvé a preguntar";
    }
    if (status === 502 || status === 503) {
      return "El backend no responde. Verificá que el servidor esté corriendo.";
    }
    return "Error de conexión. Revisá que el backend esté corriendo en el puerto correcto.";
  }

  function appendAssistantError(content: string, sessionId = activeSessionId) {
    if (!sessionId) return;

    const visibleContent = content.toLowerCase().includes("gemini")
      ? `Atención: ${content.replace(/^Atención:\s*/i, "")}`
      : content;
    updateSessionMessages(sessionId, (prev) => [
      ...prev,
      {
        role: "assistant",
        content: visibleContent,
        error: true,
      },
    ]);
  }

  async function getResponseErrorMessage(res: Response) {
    try {
      const data = await res.json();
      if (data && typeof data.detail === "string") {
        return data.detail;
      }
    } catch {
      // Keep the existing status-based fallback when the backend does not return JSON.
    }

    return getErrorMessage(res.status);
  }

  async function sendMessageFallback(
    messageText: string,
    status?: number,
    sessionId = activeSessionId,
  ) {
    if (!sessionId) return;

    if (status && [400, 429, 502, 503].includes(status)) {
      appendAssistantError(getErrorMessage(status), sessionId);
      return;
    }

    const res = await apiFetch(`${API_BASE}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ message: messageText, session_id: sessionId }),
    });

    if (!res.ok) {
      appendAssistantError(await getResponseErrorMessage(res), sessionId);
      return;
    }

    const data = await res.json();
    updateSessionMessages(sessionId, (prev) => [
      ...prev,
      {
        role: "assistant",
        content: data.response,
        sources: normalizeSources(data.sources),
        followUps: data.follow_ups || [],
      },
    ]);
  }

  async function sendMessage(messageOverride?: string) {
    const messageText = messageOverride ?? input;
    if (!messageText.trim()) return;
    const userMsg: Message = { role: "user", content: messageText };
    const currentSessionId =
      activeSessionId || createLocalSession(createSessionId());
    const currentMessages = sessionMessages[currentSessionId] || [];
    const nextMessages = [...currentMessages, userMsg];
    updateSessionMessages(currentSessionId, nextMessages);
    setSessions((prev) =>
      prev.map((session) =>
        session.id === currentSessionId && session.title === "Nueva Sesion"
          ? { ...session, title: deriveSessionTitle(nextMessages) }
          : session,
      ),
    );
    setInput("");
    setLoading(true);
    setStreaming(false);

    streamControllerRef.current?.abort();
    const streamController = new AbortController();
    streamControllerRef.current = streamController;
    let streamTimedOut = false;
    let streamTimeout: number | undefined;

    const resetStreamTimeout = () => {
      if (streamTimeout) window.clearTimeout(streamTimeout);
      streamTimeout = window.setTimeout(() => {
        streamTimedOut = true;
        streamController.abort();
      }, 60000);
    };

    try {
      resetStreamTimeout();
      const params = new URLSearchParams({
        message: messageText,
        session_id: currentSessionId,
      });
      const res = await apiFetch(`${API_BASE}/api/chat/stream?${params}`, {
        signal: streamController.signal,
      });
      const contentType = res.headers.get("content-type") || "";

      if (!res.ok) {
        streamController.abort();
        if (streamControllerRef.current === streamController) {
          streamControllerRef.current = null;
        }
        setStreaming(false);
        setLoading(false);
        await sendMessageFallback(messageText, res.status, currentSessionId);
        return;
      }

      if (!res.body || !contentType.includes("text/event-stream")) {
        streamController.abort();
        if (streamControllerRef.current === streamController) {
          streamControllerRef.current = null;
        }
        setStreaming(false);
        setLoading(false);
        await sendMessageFallback(messageText, undefined, currentSessionId);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantIndex: number | null = null;

      const processEvent = (rawEvent: string): boolean => {
        const dataLines = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        if (dataLines.length === 0) return false;

        const event = JSON.parse(dataLines.join("\n")) as
          | { type: "chunk"; content: string }
          | { type: "done"; sources: unknown; follow_ups?: string[] }
          | { type: "error"; message: string }
          | { type: "cross_session"; message: string };

        if (event.type === "chunk") {
          setStreaming(true);
          if (assistantIndex === null) {
            setLoading(false);
            assistantIndex = currentMessages.length + 1;
            updateSessionMessages(currentSessionId, (prev) => [
              ...prev,
              { role: "assistant", content: event.content },
            ]);
            return false;
          }

          updateSessionMessages(currentSessionId, (prev) =>
            prev.map((msg, index) =>
              index === assistantIndex
                ? { ...msg, content: msg.content + event.content }
                : msg,
            ),
          );
          return false;
        }

        if (event.type === "cross_session") {
          setStreaming(true);
          setLoading(false);
          assistantIndex = currentMessages.length + 1;
          updateSessionMessages(currentSessionId, (prev) => [
            ...prev,
            { role: "assistant", content: event.message },
          ]);
          streamController.abort();
          if (streamControllerRef.current === streamController) {
            streamControllerRef.current = null;
          }
          setStreaming(false);
          setLoading(false);
          return true;
        }

        if (event.type === "done") {
          if (assistantIndex !== null) {
            updateSessionMessages(currentSessionId, (prev) =>
              prev.map((msg, index) =>
                index === assistantIndex
                  ? {
                      ...msg,
                      sources: normalizeSources(event.sources),
                      followUps: event.follow_ups || [],
                    }
                  : msg,
              ),
            );
          }
          streamController.abort();
          if (streamControllerRef.current === streamController) {
            streamControllerRef.current = null;
          }
          setStreaming(false);
          setLoading(false);
          return true;
        }

        streamController.abort();
        if (streamControllerRef.current === streamController) {
          streamControllerRef.current = null;
        }
        setStreaming(false);
        setLoading(false);
        appendAssistantError(event.message, currentSessionId);
        return true;
      };

      let streamComplete = false;

      while (!streamComplete) {
        const { value, done } = await reader.read();
        if (done) break;
        resetStreamTimeout();

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const event of events) {
          streamComplete = processEvent(event);
          if (streamComplete) break;
        }
      }

      if (!streamComplete) {
        buffer += decoder.decode();
        if (buffer.trim()) processEvent(buffer);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (streamTimedOut) {
          appendAssistantError(
            "La conexión tardó demasiado. Volvé a intentar en unos segundos.",
            currentSessionId,
          );
        }
        return;
      }

      streamController.abort();
      if (streamControllerRef.current === streamController) {
        streamControllerRef.current = null;
      }
      appendAssistantError(getErrorMessage(), currentSessionId);
      setLoading(false);
      setStreaming(false);
    } finally {
      if (streamTimeout) window.clearTimeout(streamTimeout);
      if (streamControllerRef.current === streamController) {
        streamControllerRef.current = null;
        setLoading(false);
        setStreaming(false);
      }
    }
  }

  async function uploadFile(file: File) {
    const currentSessionId =
      activeSessionId || createLocalSession(createSessionId(), file.name);

    updateSessionMessages(currentSessionId, (prev) => [
      ...prev,
      {
        role: "assistant",
        content: `Subiendo "${file.name}"...`,
      },
    ]);

    const form = new FormData();
    form.append("file", file);

    try {
      const params = new URLSearchParams({ session_id: currentSessionId });
      const res = await apiFetch(`${API_BASE}/api/upload?${params}`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        appendAssistantError(await getResponseErrorMessage(res), currentSessionId);
        return;
      }
      const data = await res.json();
      updateSessionMessages(currentSessionId, (prev) => [
        ...prev,
        {
          role: "assistant",
          content: `"${data.filename}" indexado (${data.chunks} chunks).`,
        },
      ]);
      setSessions((prev) =>
        prev.map((session) =>
          session.id === currentSessionId && session.title === "Nueva Sesion"
            ? { ...session, title: file.name }
            : session,
        ),
      );
      fetchSessionData();
    } catch {
      appendAssistantError(getErrorMessage(), currentSessionId);
    }
  }

  async function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFileDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;

    const file = e.dataTransfer.files[0];
    if (!file) return;
    await uploadFile(file);
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="ambient-grid flex h-dvh overflow-hidden bg-background text-foreground">
      <aside
        className={`
          flex flex-col border-r border-sidebar-border/80 bg-sidebar/92 shadow-2xl shadow-black/25
          backdrop-blur-xl transition-[width,opacity,transform] duration-200 ease-out
          ${sidebarOpen ? "w-64 opacity-100" : "w-0 -translate-x-2 overflow-hidden opacity-0"}
        `}
      >
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-sidebar-border/80 px-5">
          <div className="flex size-8 items-center justify-center rounded-xl bg-primary">
            <FileText className="size-4 text-primary-foreground" />
          </div>
          <span className="text-base font-semibold">
            Esperanto
          </span>
        </div>

        <div className="px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              createLocalSession(createSessionId());
            }}
            className="w-full justify-start gap-2 rounded-lg border-sidebar-border bg-sidebar-accent/45 text-sidebar-foreground hover:border-primary/35 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Plus className="size-4" />
            Nueva sesion
          </Button>
        </div>

        <ScrollArea className="flex-1 px-4">
          <div className="px-4 py-3">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setSessions((prev) =>
                    prev.map((session) => ({
                      ...session,
                      active: session.id === s.id,
                    })),
                  );
                  loadSessionMessages(s.id);
                }}
                className={`
                  group flex w-[calc(100%-2px)] items-center gap-2 rounded-lg px-3 py-2 text-left text-sm
                  transition-all duration-200 hover:translate-x-0.5 hover:border-primary/15 hover:shadow-lg hover:shadow-black/10
                  ${
                    s.active
                      ? "border-l-4 border-l-primary bg-sidebar-accent text-sidebar-accent-foreground shadow-inner"
                      : "border border-transparent text-sidebar-foreground hover:bg-sidebar-accent/55 hover:text-sidebar-accent-foreground"
                  }
                `}
              >
                <MessageSquare className="size-4 shrink-0" />
                {s.totalChunks && s.totalChunks > 0 ? (
                  <span
                    className="ml-0.5 size-2 shrink-0 rounded-full bg-primary"
                    title="Tiene documentos"
                  />
                ) : (
                  <span
                    className="ml-0.5 size-2 shrink-0 rounded-full bg-border"
                    title="Sin documentos"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <Trash2
                  className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    openDeleteConfirm(s);
                  }}
                />
              </button>
            ))}
          </div>
        </ScrollArea>

        <div className="border-t border-sidebar-border/80 p-3">
          <p className="text-xs text-sidebar-foreground/50">
            {sessions.length} sesiones ·{" "}
            {sessions.reduce((sum, session) => sum + (session.totalChunks || 0), 0)} chunks
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/80 bg-background/72 px-4 backdrop-blur-xl">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="interactive-button rounded-lg p-1 text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              aria-label="Alternar sidebar"
            >
              <PanelLeft className="size-5" />
            </button>
            {editingTitle ? (
              <Input
                value={editTitleValue}
                onChange={(e) => setEditTitleValue(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleTitleSave();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                autoFocus
                className="h-7 w-64 border-border bg-secondary text-base font-semibold"
              />
            ) : (
              <h1
                className="cursor-pointer truncate text-base font-semibold transition-colors hover:text-primary"
                onDoubleClick={() => {
                  setEditTitleValue(activeSessionTitle);
                  setEditingTitle(true);
                }}
                title="Doble clic para renombrar"
              >
                {activeSessionTitle}
              </h1>
            )}
            <span
              className="inline-flex items-center rounded-full px-1"
              title={
                apiStatus === "ok"
                  ? "API conectada"
                  : apiStatus === "error"
                    ? "API sin respuesta"
                    : "Verificando API"
              }
              aria-label={
                apiStatus === "ok"
                  ? "API conectada"
                  : apiStatus === "error"
                    ? "API sin respuesta"
                    : "Verificando API"
              }
            >
              <span
                className={`text-sm ${
                  apiStatus === "ok"
                    ? "text-primary"
                    : apiStatus === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                ●
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />

            {isAuthenticated && user ? (
              <div className="flex items-center gap-2">
                {user.image && (
                  <img
                    src={user.image}
                    alt={user.name || ""}
                    className="size-7 rounded-full border border-border"
                  />
                )}
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {user.name}
                </span>
                <button
                  onClick={() => signOut()}
                  className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Salir
                </button>
              </div>
            ) : (
              <button
                onClick={() => signIn("google")}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs text-foreground hover:bg-muted"
              >
                <svg className="size-4" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Iniciar sesión
              </button>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.md,.docx,.csv,.json,.html"
              onChange={handleFileUpload}
              className="hidden"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="gap-2 rounded-lg border-border/90 bg-secondary/70 text-muted-foreground hover:border-primary/35 hover:text-foreground"
            >
              <Upload className="size-4" />
              Subir documento
            </Button>
          </div>
        </header>

        {/* Vista general de la sesion activa */}
        {activeSessionDocuments.length > 0 && (
          <div className="border-b border-border/80 bg-background/40">
            <button
              type="button"
              onClick={() => setDocsPanelOpen((open) => !open)}
              className="w-full px-8 py-3 text-left transition-colors hover:bg-muted/45"
              aria-expanded={docsPanelOpen}
            >
              <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {activeSessionDocuments.length} documentos · {activeSessionTotalChunks} chunks
                </p>
                <ChevronDown
                  className={`size-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
                    docsPanelOpen ? "rotate-0" : "-rotate-90"
                  }`}
                />
              </div>
            </button>
            <div
              className={`overflow-hidden transition-all duration-300 ease-out ${
                docsPanelOpen ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"
              }`}
            >
              <div className="mx-auto max-w-4xl px-8 pb-3">
                <div className="flex flex-wrap gap-2">
                  {activeSessionDocuments.map((doc, i) => (
                    <span
                      key={`${doc.filename}-${i}`}
                      className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-background px-2.5 py-1 text-xs text-primary"
                    >
                      {doc.filename} · {doc.chunks} chunks
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        <div
          className="relative flex-1 overflow-hidden"
          onDragOver={(e) => {
            e.preventDefault();
            if (Array.from(e.dataTransfer.types).includes("Files")) {
              setIsDragging(true);
            }
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleFileDrop}
        >
          {isDragging && (
            <div className="pointer-events-none absolute inset-4 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/82 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-3 text-primary">
                <Upload className="size-10" />
                <p className="text-base font-semibold">
                  Soltá el archivo para subirlo
                </p>
              </div>
            </div>
          )}
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-4xl px-8 py-8">
              {showEmptyState ? (
                <div className="flex min-h-[calc(100dvh-12rem)] items-center justify-center">
                  <div className="flex max-w-md flex-col items-center text-center">
                    <div className="mb-6 flex size-20 items-center justify-center rounded-2xl border border-primary/25 bg-secondary/80 shadow-xl shadow-black/15">
                      <Upload className="size-10 text-primary" />
                    </div>
                    <h2 className="text-2xl font-semibold text-primary">
                      Carga tu documento
                    </h2>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                      Subí un PDF, TXT, DOCX, CSV, JSON o HTML para empezar a consultar.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                      className="mt-6 gap-2 rounded-lg border-primary/35 bg-secondary/70 text-foreground hover:bg-sidebar-accent"
                    >
                      <Upload className="size-4" />
                      Subir documento
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {messages.map((m, i) => (
                    <div
                      key={i}
                      className={`message-enter flex ${
                        m.role === "user" ? "justify-end" : "justify-start"
                      }`}
                    >
                      <div
                        className={`
                          max-w-[82%] rounded-3xl px-4 py-2.5 text-sm leading-relaxed shadow-xl shadow-black/10
                          ${
                            m.role === "user"
                              ? "bg-primary text-primary-foreground shadow-lg shadow-primary/15"
                              : m.error
                                ? "error-message text-foreground"
                              : "glass-panel gradient-border text-foreground"
                          }
                        `}
                      >
                        <div className="flex items-start gap-2">
                          {m.error && (
                            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                          )}
                          <p className="whitespace-pre-wrap">{m.content}</p>
                        </div>
                        {m.sources && m.sources.length > 0 && (
                          <MessageSources sources={m.sources} />
                        )}
                        {m.role === "assistant" &&
                          m.followUps &&
                          m.followUps.length > 0 && (
                            <div className="mt-2 border-t border-border pt-2">
                              <p className="mb-1.5 text-xs text-muted-foreground">
                                {"Segu\u00ed preguntando"}
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                                {m.followUps.map((question, j) => (
                                  <button
                                    key={`${question}-${j}`}
                                    type="button"
                                    disabled={loading}
                                    onClick={() => {
                                      setInput(question);
                                      sendMessage(question);
                                    }}
                                    className="rounded-full border border-primary/30 bg-background px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
                                  >
                                    {question}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                      </div>
                    </div>
                  ))}

                  {(streaming || loading) && (
                    <div className="message-enter flex justify-start">
                      <div className="glass-panel gradient-border w-[60%] min-w-64 max-w-[82%] rounded-3xl px-4 py-3.5">
                        {streaming && (
                          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>Respondiendo...</span>
                            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                          </div>
                        )}
                        {["85%", "100%", "65%"].map((width) => (
                          <div
                            key={width}
                            className="mb-2 last:mb-0"
                            style={{
                              background:
                                "linear-gradient(90deg, var(--bg-tertiary) 20%, color-mix(in srgb, var(--text-primary) 8%, transparent) 50%, var(--bg-tertiary) 80%)",
                              backgroundSize: "200% 100%",
                              animation: "shimmer 2s infinite",
                              borderRadius: "6px",
                              height: "12px",
                              width,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  <div ref={scrollRef} />
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        <div className="border-t border-border/80 bg-background/76 backdrop-blur-xl">
          <div className="mx-auto max-w-3xl px-4 py-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage();
              }}
              className="chat-composer gradient-border flex items-end gap-2 rounded-xl border border-border bg-[var(--chat-composer-bg)] px-4 py-3 shadow-xl shadow-black/15"
            >
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  activeSessionDocuments.length > 0
                    ? "Preguntale a tus documentos..."
                    : "Subí un documento para empezar"
                }
                disabled={loading}
                autoComplete="off"
                className="h-auto min-h-5 border-0 bg-transparent px-1 text-sm shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
              />
              <Button
                type="submit"
                disabled={loading || !input.trim()}
                size="icon"
                className="size-10 shrink-0 rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-[var(--color-brand-hover)] disabled:opacity-40"
              >
                <Send className="size-4" />
              </Button>
            </form>
          </div>
        </div>
      </div>
      {deleteConfirm && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center transition-all duration-200 ${
            deleteConfirmEntering
              ? "bg-[var(--modal-overlay)] backdrop-blur-sm"
              : "bg-transparent backdrop-blur-none"
          }`}
        >
          <div
            className={`w-96 rounded-2xl border border-border bg-background p-6 shadow-2xl shadow-black/25 transition-all duration-200 ${
              deleteConfirmEntering ? "scale-100 opacity-100" : "scale-95 opacity-0"
            }`}
          >
            <h3 className="text-lg font-semibold text-foreground">
              Eliminar sesión
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              ¿Eliminar esta sesión y sus documentos? Esta acción no se puede deshacer.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={closeDeleteConfirm}
                className="rounded-lg border border-border bg-secondary px-4 py-2 text-sm text-foreground hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  const s: Session = deleteConfirm;
                  closeDeleteConfirm();
                  setSessionMessages((prev) => {
                    const remainingMessages = { ...prev };
                    delete remainingMessages[s.id];
                    return remainingMessages;
                  });
                  setSessions((prev) => {
                    const remaining = prev.filter((session) => session.id !== s.id);

                    if (!s.active) {
                      return remaining;
                    }

                    return remaining.map((session, index) => ({
                      ...session,
                      active: index === 0,
                    }));
                  });
                  apiFetch(`${API_BASE}/api/sessions/delete`, {
                    method: "POST",
                    body: JSON.stringify({ session_id: s.id }),
                  }).catch(() => {});
                }}
                className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-[var(--destructive-foreground)] hover:bg-destructive/90"
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
