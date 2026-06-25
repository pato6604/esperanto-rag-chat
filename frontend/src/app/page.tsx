"use client";

import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
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
};

type Session = {
  id: string;
  title: string;
  active: boolean;
};

const MOCK_SESSIONS: Session[] = [
  { id: "1", title: "Analisis de documentos", active: true },
  { id: "2", title: "Reporte Q4 2025", active: false },
  { id: "3", title: "Arquitectura del proyecto", active: false },
];

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Hola. Soy tu asistente RAG. Subi documentos y preguntame lo que quieras.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sessions] = useState<Session[]>(MOCK_SESSIONS);

  const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function sendMessage() {
    if (!input.trim()) return;
    const messageText = input;
    const userMsg: Message = { role: "user", content: messageText };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: messageText, session_id: "default" }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.response, sources: data.sources },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Error conectando con el backend.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: `Subiendo "${file.name}"...`,
      },
    ]);

    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch(`${API_BASE}/api/upload`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `"${data.filename}" indexado (${data.chunks} chunks).`,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Error al subir el archivo.",
        },
      ]);
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
            RAG Chat
          </span>
        </div>

        <div className="px-4 py-3">
          <Button
            variant="outline"
            size="sm"
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
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <Trash2 className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 hover:opacity-100" />
              </button>
            ))}
          </div>
        </ScrollArea>

        <div className="border-t border-sidebar-border/80 p-3">
          <p className="text-xs text-sidebar-foreground/50">
            {sessions.length} sesiones
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
            <h1 className="truncate text-base font-semibold">
              Analisis de documentos
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.md,.docx"
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
                            : "glass-panel gradient-border text-[#fafafa]"
                        }
                      `}
                    >
                      <p className="whitespace-pre-wrap">{m.content}</p>
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

                {loading && (
                  <div className="message-enter flex justify-start">
                    <div className="glass-panel gradient-border rounded-2xl px-4 py-3">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span className="typing-dot size-2 rounded-full bg-[#3ecf8e]" />
                        <span className="typing-dot size-2 rounded-full bg-[#3ecf8e]" />
                        <span className="typing-dot size-2 rounded-full bg-[#3ecf8e]" />
                        <span className="ml-1 text-sm">Pensando...</span>
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
