"use client";

import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertTriangle,
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
  sources?: string[];
  error?: boolean;
};

type Session = {
  id: string;
  title: string;
  active: boolean;
  documents?: { filename: string; chunks: number }[];
  totalChunks?: number;
};

const DEFAULT_SESSION: Session = {
  id: "default",
  title: "Nueva Sesion",
  active: true,
};

function createInitialMessages(): Message[] {
  return [
    {
      role: "assistant",
      content:
        "Hola. Soy tu asistente Esperanto. Subi documentos y preguntame lo que quieras.",
    },
  ];
}

function deriveSessionTitle(messages: Message[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");

  if (!firstUserMessage) {
    return "Nueva Sesion";
  }

  const title = firstUserMessage.content.trim().replace(/\s+/g, " ");
  return title.length > 30 ? `${title.slice(0, 30)}...` : title;
}

export default function ChatPage() {
  const [sessionMessages, setSessionMessages] = useState<
    Record<string, Message[]>
  >({
    default: createInitialMessages(),
  });
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
  const [sessions, setSessions] = useState<Session[]>([DEFAULT_SESSION]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState("");

  const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
  const activeSession = sessions.find((session) => session.active);
  const activeSessionId =
    activeSession?.id || DEFAULT_SESSION.id;
  const activeSessionTitle =
    activeSession?.title || DEFAULT_SESSION.title;
  const activeSessionDocuments = activeSession?.documents || [];
  const activeSessionTotalChunks = activeSession?.totalChunks || 0;
  const messages = sessionMessages[activeSessionId] || createInitialMessages();

  const fetchSessionData = useCallback(() => {
    fetch(`${API_BASE}/api/sessions`)
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data)) {
          setSessions((prev) => {
            const currentActiveId =
              prev.find((session) => session.active)?.id || DEFAULT_SESSION.id;
            const backendSessions = data.map((session: any) => ({
              id: session.id,
              title: session.title,
              active: session.id === currentActiveId,
              documents: session.documents,
              totalChunks: session.total_chunks,
            }));

            const hasActive = backendSessions.some((session: Session) => session.active);
            if (!hasActive && backendSessions.length > 0) {
              backendSessions[0].active = true;
            }

            return backendSessions.length > 0 ? backendSessions : prev;
          });
        }
      })
      .catch(() => {
        // Si falla, mantener el estado local sin romper la app.
      });
  }, [API_BASE]);

  function updateSessionMessages(
    sessionId: string,
    updater: Message[] | ((prev: Message[]) => Message[]),
  ) {
    setSessionMessages((prev) => {
      const currentMessages = prev[sessionId] || createInitialMessages();
      const nextMessages =
        typeof updater === "function" ? updater(currentMessages) : updater;

      return {
        ...prev,
        [sessionId]: nextMessages,
      };
    });
  }

  function updateActiveSessionMessages(
    updater: Message[] | ((prev: Message[]) => Message[]),
  ) {
    updateSessionMessages(activeSessionId, updater);
  }

  function handleTitleSave() {
    const newTitle = editTitleValue.trim();
    if (newTitle && newTitle !== activeSessionTitle) {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === activeSessionId ? { ...session, title: newTitle } : session,
        ),
      );
      fetch(`${API_BASE}/api/sessions/${activeSessionId}/title`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      }).catch(() => {});
    }
    setEditingTitle(false);
  }

  useEffect(() => {
    fetchSessionData();
  }, [fetchSessionData]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, streaming]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3000);

    fetch(`${API_BASE}/health`, { signal: controller.signal })
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
  }, [API_BASE]);

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
    if (status && [400, 429, 502, 503].includes(status)) {
      appendAssistantError(getErrorMessage(status), sessionId);
      return;
    }

    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: messageText, session_id: sessionId }),
    });

    if (!res.ok) {
      appendAssistantError(await getResponseErrorMessage(res), sessionId);
      return;
    }

    const data = await res.json();
    updateSessionMessages(sessionId, (prev) => [
      ...prev,
      { role: "assistant", content: data.response, sources: data.sources },
    ]);
  }

  async function sendMessage() {
    if (!input.trim()) return;
    const messageText = input;
    const userMsg: Message = { role: "user", content: messageText };
    const currentSessionId = activeSessionId;
    const currentMessages =
      sessionMessages[currentSessionId] || createInitialMessages();
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
      const res = await fetch(`${API_BASE}/api/chat/stream?${params}`, {
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

      const processEvent = (rawEvent: string) => {
        const dataLines = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        if (dataLines.length === 0) return false;

        const event = JSON.parse(dataLines.join("\n")) as
          | { type: "chunk"; content: string }
          | { type: "done"; sources: string[] }
          | { type: "error"; message: string };

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

        if (event.type === "done") {
          if (assistantIndex !== null) {
            updateSessionMessages(currentSessionId, (prev) =>
              prev.map((msg, index) =>
                index === assistantIndex
                  ? { ...msg, sources: event.sources }
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

  async function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const currentSessionId = activeSessionId;

    updateActiveSessionMessages((prev) => [
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
      const res = await fetch(`${API_BASE}/api/upload?${params}`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        appendAssistantError(await getResponseErrorMessage(res));
        return;
      }
      const data = await res.json();
      updateActiveSessionMessages((prev) => [
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
      appendAssistantError(getErrorMessage());
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
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
          <div className="flex size-8 items-center justify-center rounded-xl bg-[#3ecf8e]">
            <FileText className="size-4 text-[#0f0f0f]" />
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
              const newId = String(Date.now());
              const newSession: Session = {
                id: newId,
                title: "Nueva Sesion",
                active: true,
              };
              setSessions((prev) =>
                prev.map((s) => ({ ...s, active: false })).concat(newSession),
              );
              setSessionMessages((prev) => ({
                ...prev,
                [newId]: createInitialMessages(),
              }));
            }}
            className="w-full justify-start gap-2 rounded-lg border-sidebar-border bg-[#151515]/70 text-sidebar-foreground hover:border-[#3ecf8e]/35 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
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
                }}
                className={`
                  group flex w-[calc(100%-2px)] items-center gap-2 rounded-lg px-3 py-2 text-left text-sm
                  transition-all duration-200 hover:translate-x-0.5 hover:border-[#3ecf8e]/15 hover:shadow-[0_10px_22px_rgba(0,0,0,0.18)]
                  ${
                    s.active
                      ? "border-l-4 border-l-[#3ecf8e] bg-sidebar-accent text-sidebar-accent-foreground shadow-inner"
                      : "border border-transparent text-sidebar-foreground hover:bg-sidebar-accent/55 hover:text-sidebar-accent-foreground"
                  }
                `}
              >
                <MessageSquare className="size-4 shrink-0" />
                {s.totalChunks && s.totalChunks > 0 ? (
                  <span
                    className="ml-0.5 size-2 shrink-0 rounded-full bg-[#3ecf8e]"
                    title="Tiene documentos"
                  />
                ) : (
                  <span
                    className="ml-0.5 size-2 shrink-0 rounded-full bg-[#2e2e2e]"
                    title="Sin documentos"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <Trash2
                  className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
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

                      if (remaining.length === 0) {
                        return [DEFAULT_SESSION];
                      }

                      return remaining.map((session, index) => ({
                        ...session,
                        active: index === 0,
                      }));
                    });
                    fetch(`${API_BASE}/api/sessions/delete`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ session_id: s.id }),
                    }).catch(() => {});
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
                className="h-7 w-64 border-border bg-[#151515] text-base font-semibold"
              />
            ) : (
              <h1
                className="cursor-pointer truncate text-base font-semibold transition-colors hover:text-[#3ecf8e]"
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
                    ? "text-[#3ecf8e]"
                    : apiStatus === "error"
                      ? "text-[#ef4444]"
                      : "text-muted-foreground"
                }`}
              >
                ●
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
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
              className="gap-2 rounded-lg border-border/90 bg-[#151515]/70 text-muted-foreground hover:border-[#3ecf8e]/35 hover:text-foreground"
            >
              <Upload className="size-4" />
              Subir documento
            </Button>
          </div>
        </header>

        {/* Vista general de la sesion activa */}
        {activeSessionDocuments.length > 0 && (
          <div className="border-b border-border/80 bg-[#0f0f0f]/40 px-8 py-3">
            <div className="mx-auto max-w-4xl">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {activeSessionDocuments.length} documentos · {activeSessionTotalChunks} chunks
                  </p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {activeSessionDocuments.map((doc, i) => (
                  <span
                    key={`${doc.filename}-${i}`}
                    className="inline-flex items-center gap-1 rounded-full border border-[#3ecf8e]/25 bg-[#0f0f0f] px-2.5 py-1 text-xs text-[#3ecf8e]"
                  >
                    {doc.filename} · {doc.chunks} chunks
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-4xl px-8 py-8">
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
                        max-w-[82%] rounded-3xl px-4 py-2.5 text-sm leading-relaxed shadow-[0_12px_32px_rgba(0,0,0,0.22)]
                        ${
                          m.role === "user"
                            ? "bg-[#3ecf8e] text-[#0f0f0f] shadow-[0_14px_34px_rgba(62,207,142,0.14)]"
                            : m.error
                              ? "error-message text-[#fafafa]"
                            : "glass-panel gradient-border text-[#fafafa]"
                        }
                      `}
                    >
                      <div className="flex items-start gap-2">
                        {m.error && (
                          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#ef4444]" />
                        )}
                        <p className="whitespace-pre-wrap">{m.content}</p>
                      </div>
                      {m.sources && m.sources.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-[#2e2e2e] pt-2">
                          {m.sources.map((src, j) => (
                            <span
                              key={j}
                              className="inline-flex items-center gap-1 rounded-full border border-[#3ecf8e]/30 bg-[#0f0f0f] px-2 py-0.5 text-[10px] font-medium text-[#3ecf8e]"
                            >
                              <FileText className="size-3" />
                              {src}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {(loading || streaming) && (
                  <div className="message-enter flex justify-start">
                    <div className="glass-panel gradient-border rounded-2xl px-4 py-3">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span className="typing-dot size-2 rounded-full bg-[#3ecf8e]" />
                        <span className="typing-dot size-2 rounded-full bg-[#3ecf8e]" />
                        <span className="typing-dot size-2 rounded-full bg-[#3ecf8e]" />
                        <span className="ml-1 text-sm">
                          {streaming ? "Respondiendo..." : "Pensando..."}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div ref={scrollRef} />
              </div>
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
              className="chat-composer gradient-border flex items-end gap-2 rounded-xl border border-[#2e2e2e] bg-[#0f0f0f]/92 px-4 py-3 shadow-[0_18px_42px_rgba(0,0,0,0.28)]"
            >
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Preguntale a tus documentos..."
                disabled={loading}
                className="h-auto min-h-5 border-0 bg-transparent px-1 text-sm shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
              />
              <Button
                type="submit"
                disabled={loading || !input.trim()}
                size="icon"
                className="size-10 shrink-0 rounded-xl bg-[#3ecf8e] text-[#0f0f0f] shadow-[0_0_20px_rgba(62,207,142,0.18)] hover:bg-[#00c573] disabled:opacity-40"
              >
                <Send className="size-4" />
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
