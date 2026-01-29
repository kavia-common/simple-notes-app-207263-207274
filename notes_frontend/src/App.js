import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const DEFAULT_API_BASE_URL = "http://localhost:3001";

/**
 * Build the backend base URL.
 *
 * Resolution order:
 * 1) `REACT_APP_API_BASE` (provided via .project_manifest.yaml env: REACT_APP_API_BASE)
 * 2) `REACT_APP_BACKEND_URL` (provided via .project_manifest.yaml env: REACT_APP_BACKEND_URL)
 * 3) `REACT_APP_NOTES_API_BASE_URL` (legacy/manual override)
 * 4) Fallback to localhost for local dev.
 */
function getApiBaseUrl() {
  const candidates = [
    process.env.REACT_APP_API_BASE,
    process.env.REACT_APP_BACKEND_URL,
    process.env.REACT_APP_NOTES_API_BASE_URL,
  ];

  const env = candidates.find((v) => typeof v === "string" && v.trim());
  return env ? env.trim().replace(/\/+$/, "") : DEFAULT_API_BASE_URL;
}

// PUBLIC_INTERFACE
function App() {
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);

  const [theme, setTheme] = useState("dark");

  const [notes, setNotes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  // Editor state
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");

  // UI state
  const [search, setSearch] = useState("");
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeletingId, setIsDeletingId] = useState(null);
  const [error, setError] = useState("");

  // Used to avoid selecting overwritten drafts when selecting notes quickly.
  const lastSelectedIdRef = useRef(null);

  // Effect: apply theme to document element
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedId) || null,
    [notes, selectedId],
  );

  const filteredNotes = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return notes;

    return notes.filter((n) => {
      const t = (n.title || "").toLowerCase();
      const c = (n.content || "").toLowerCase();
      return t.includes(q) || c.includes(q);
    });
  }, [notes, search]);

  // --- API helpers ---
  const apiFetch = useCallback(
    async (path, options = {}) => {
      const url = `${apiBaseUrl}${path}`;
      const resp = await fetch(url, {
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });

      // Try to parse json if possible; otherwise return null.
      const contentType = resp.headers.get("content-type") || "";
      const hasJson = contentType.includes("application/json");
      const payload = hasJson ? await resp.json().catch(() => null) : null;

      if (!resp.ok) {
        const msg =
          (payload && (payload.detail || payload.message)) ||
          `Request failed (${resp.status})`;
        throw new Error(msg);
      }

      return payload;
    },
    [apiBaseUrl],
  );

  const loadNotes = useCallback(async () => {
    setError("");
    setIsLoadingList(true);
    try {
      // Expected backend endpoints (per plan):
      // GET /notes -> [{id, title, content, created_at?, updated_at?}, ...]
      const data = await apiFetch("/notes", { method: "GET" });
      const list = Array.isArray(data) ? data : [];
      setNotes(list);

      // Keep selection consistent if possible
      if (selectedId != null) {
        const stillExists = list.some((n) => n.id === selectedId);
        if (!stillExists) {
          setSelectedId(list[0]?.id ?? null);
        }
      } else {
        setSelectedId(list[0]?.id ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoadingList(false);
    }
  }, [apiFetch, selectedId]);

  // Initial load
  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  // When selection changes, populate editor draft
  useEffect(() => {
    if (!selectedNote) {
      setDraftTitle("");
      setDraftContent("");
      lastSelectedIdRef.current = null;
      return;
    }

    // Avoid overwriting the draft while the user is typing for the same note.
    if (lastSelectedIdRef.current !== selectedNote.id) {
      setDraftTitle(selectedNote.title || "");
      setDraftContent(selectedNote.content || "");
      lastSelectedIdRef.current = selectedNote.id;
    }
  }, [selectedNote]);

  const isDirty = useMemo(() => {
    if (!selectedNote) return draftTitle.trim() !== "" || draftContent.trim() !== "";
    return (draftTitle || "") !== (selectedNote.title || "") || (draftContent || "") !== (selectedNote.content || "");
  }, [draftTitle, draftContent, selectedNote]);

  // PUBLIC_INTERFACE
  const toggleTheme = () => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  };

  const onNewNote = async () => {
    setError("");
    setIsSaving(true);
    try {
      // POST /notes {title, content} -> created note
      const created = await apiFetch("/notes", {
        method: "POST",
        body: JSON.stringify({
          title: "Untitled",
          content: "",
        }),
      });

      // Optimistically prepend; also safe if backend returns id.
      if (created && typeof created === "object") {
        setNotes((prev) => [created, ...prev]);
        setSelectedId(created.id ?? null);
        lastSelectedIdRef.current = created.id ?? null;
        setDraftTitle(created.title || "Untitled");
        setDraftContent(created.content || "");
      } else {
        // If backend doesn't return created note, reload list.
        await loadNotes();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSaving(false);
    }
  };

  const onSave = async () => {
    if (!selectedNote) {
      // Treat as create if nothing selected but draft has content
      if (draftTitle.trim() === "" && draftContent.trim() === "") return;
      setError("");
      setIsSaving(true);
      try {
        const created = await apiFetch("/notes", {
          method: "POST",
          body: JSON.stringify({
            title: draftTitle.trim() || "Untitled",
            content: draftContent,
          }),
        });

        if (created && typeof created === "object") {
          setNotes((prev) => [created, ...prev]);
          setSelectedId(created.id ?? null);
          lastSelectedIdRef.current = created.id ?? null;
        } else {
          await loadNotes();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsSaving(false);
      }
      return;
    }

    setError("");
    setIsSaving(true);
    try {
      // PUT /notes/{id} {title, content} -> updated note
      const updated = await apiFetch(`/notes/${encodeURIComponent(selectedNote.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          title: draftTitle.trim() || "Untitled",
          content: draftContent,
        }),
      });

      if (updated && typeof updated === "object") {
        setNotes((prev) => prev.map((n) => (n.id === selectedNote.id ? updated : n)));
        lastSelectedIdRef.current = updated.id ?? selectedNote.id;
      } else {
        await loadNotes();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSaving(false);
    }
  };

  const onDelete = async (id) => {
    setError("");
    setIsDeletingId(id);
    try {
      // DELETE /notes/{id}
      await apiFetch(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
      setNotes((prev) => prev.filter((n) => n.id !== id));

      if (selectedId === id) {
        const remaining = notes.filter((n) => n.id !== id);
        setSelectedId(remaining[0]?.id ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsDeletingId(null);
    }
  };

  const onSelect = (id) => {
    // If dirty, selection is still allowed, but we warn in a retro way.
    setSelectedId(id);
  };

  const onResetDraft = () => {
    if (!selectedNote) {
      setDraftTitle("");
      setDraftContent("");
      return;
    }
    setDraftTitle(selectedNote.title || "");
    setDraftContent(selectedNote.content || "");
  };

  return (
    <div className="App">
      <div className="crt" aria-hidden="true" />
      <header className="topbar">
        <div className="brand">
          <div className="brandMark" aria-hidden="true">
            N
          </div>
          <div className="brandText">
            <div className="brandTitle">Retro Notes</div>
            <div className="brandSub">Create • Edit • Delete • Repeat</div>
          </div>
        </div>

        <div className="topbarActions">
          <button
            className="btn btnGhost"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            type="button"
          >
            {theme === "light" ? "Dark Mode" : "Light Mode"}
          </button>

          <button className="btn btnPrimary" onClick={onNewNote} disabled={isSaving} type="button">
            {isSaving ? "Creating..." : "New Note"}
          </button>
        </div>
      </header>

      <main className="layout">
        <aside className="sidebar" aria-label="Notes list panel">
          <div className="panelHeader">
            <div className="panelTitle">NOTES</div>
            <div className="panelMeta">
              {isLoadingList ? "Loading..." : `${notes.length} total`}
            </div>
          </div>

          <div className="searchRow">
            <label className="srOnly" htmlFor="search">
              Search notes
            </label>
            <input
              id="search"
              className="input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or content..."
              autoComplete="off"
            />
            <button
              className="btn btnGhost btnSmall"
              onClick={() => setSearch("")}
              type="button"
              disabled={!search.trim()}
            >
              Clear
            </button>
          </div>

          {error ? (
            <div className="alert" role="alert">
              <div className="alertTitle">SYSTEM ERROR</div>
              <div className="alertBody">{error}</div>
              <div className="alertFooter">
                <button className="btn btnGhost btnSmall" onClick={loadNotes} type="button">
                  Retry
                </button>
                <div className="hint">
                  API: <code>{apiBaseUrl}</code>
                </div>
              </div>
            </div>
          ) : null}

          <div className="notesList" role="list">
            {filteredNotes.length === 0 ? (
              <div className="emptyState">
                <div className="emptyTitle">No notes found</div>
                <div className="emptyBody">Try creating a new note or clearing search.</div>
              </div>
            ) : (
              filteredNotes.map((n) => {
                const active = n.id === selectedId;
                return (
                  <div
                    key={n.id}
                    className={`noteRow ${active ? "active" : ""}`}
                    role="listitem"
                  >
                    <button
                      type="button"
                      className="noteRowMain"
                      onClick={() => onSelect(n.id)}
                      aria-current={active ? "true" : "false"}
                    >
                      <div className="noteTitle">{n.title || "Untitled"}</div>
                      <div className="noteSnippet">
                        {(n.content || "").trim() ? (n.content || "").slice(0, 80) : "—"}
                      </div>
                    </button>

                    <button
                      type="button"
                      className="iconBtn"
                      onClick={() => onDelete(n.id)}
                      disabled={isDeletingId === n.id}
                      aria-label={`Delete note ${n.title || "Untitled"}`}
                      title="Delete"
                    >
                      {isDeletingId === n.id ? "..." : "DEL"}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="sidebarFooter">
            <button className="btn btnGhost btnSmall" onClick={loadNotes} disabled={isLoadingList} type="button">
              {isLoadingList ? "Refreshing..." : "Refresh"}
            </button>
            <div className="hint">
              Tip: Use <span className="kbd">CTRL</span>+<span className="kbd">S</span> to save
            </div>
          </div>
        </aside>

        <section className="editor" aria-label="Note editor panel">
          <div className="panelHeader">
            <div className="panelTitle">EDITOR</div>
            <div className="panelMeta">
              {selectedNote ? (
                <>
                  ID: <code>{selectedNote.id}</code>
                </>
              ) : (
                "No note selected"
              )}
            </div>
          </div>

          <div className="editorBody">
            <div className="formRow">
              <label className="label" htmlFor="title">
                Title
              </label>
              <input
                id="title"
                className="input inputLarge"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="A totally radical title..."
                autoComplete="off"
              />
            </div>

            <div className="formRow">
              <label className="label" htmlFor="content">
                Content
              </label>
              <textarea
                id="content"
                className="textarea"
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                placeholder="Type your note here..."
                rows={14}
              />
            </div>

            <div className="editorActions">
              <div className="leftActions">
                <button
                  className="btn btnPrimary"
                  onClick={onSave}
                  disabled={isSaving || (!isDirty && selectedNote != null)}
                  type="button"
                >
                  {isSaving ? "Saving..." : "Save"}
                </button>

                <button
                  className="btn btnGhost"
                  onClick={onResetDraft}
                  disabled={!isDirty}
                  type="button"
                >
                  Revert
                </button>
              </div>

              <div className="rightStatus" aria-live="polite">
                {isDirty ? <span className="chip chipWarn">UNSAVED</span> : <span className="chip">SYNCED</span>}
              </div>
            </div>

            <div className="statusBar">
              <div className="statusItem">
                Backend: <code>{apiBaseUrl}</code>
              </div>
              <div className="statusItem">
                {selectedNote ? (
                  <>
                    Selected: <strong>{selectedNote.title || "Untitled"}</strong>
                  </>
                ) : (
                  "Create a note to begin."
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Keyboard shortcut: Ctrl/Cmd+S to save */}
      <KeyboardShortcuts onSave={onSave} />
    </div>
  );
}

// PUBLIC_INTERFACE
function KeyboardShortcuts({ onSave }) {
  /** Enables Ctrl/Cmd+S to trigger save without opening browser "Save page" dialog. */
  useEffect(() => {
    const handler = (e) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const isSaveCombo = (isMac && e.metaKey && e.key.toLowerCase() === "s") || (!isMac && e.ctrlKey && e.key.toLowerCase() === "s");
      if (!isSaveCombo) return;
      e.preventDefault();
      onSave();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSave]);

  return null;
}

export default App;
