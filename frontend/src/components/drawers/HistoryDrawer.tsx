import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../../lib/api";
import { stopEverything } from "../../lib/assistant";
import { relativeTime } from "../../lib/format";
import type { ConversationSummary, StoredMessage } from "../../store/types";
import { useStore } from "../../store/useStore";
import { PlusIcon, TrashIcon } from "../icons";
import { IconButton } from "../IconButton";

export function HistoryDrawer() {
  const revision = useStore((s) => s.serverRevision);
  const activeId = useStore((s) => s.conversationId);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [problem, setProblem] = useState("");

  const load = useCallback(() => {
    api
      .conversations()
      .then((list) => {
        setConversations(list);
        setProblem("");
      })
      .catch((error: ApiError) => setProblem(error.message));
  }, []);
  useEffect(load, [load, revision]);

  // Show the transcript of whichever conversation is active.
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let current = true;
    api
      .conversation(activeId)
      .then((conversation) => current && setMessages(conversation.messages))
      .catch(() => current && setMessages([]));
    return () => {
      current = false;
    };
  }, [activeId, revision]);

  /** Reopen a past conversation: restore its panels and continue it with the next question. */
  const open = async (id: string) => {
    const store = useStore.getState();
    try {
      const conversation = await api.conversation(id);
      stopEverything();
      store.newConversation();
      store.setConversation(id);
      const replies = conversation.messages.filter((m) => m.role === "assistant").slice(-4);
      replies.forEach((reply, index) => {
        const turnId = `h${reply.id}`;
        if (reply.panels.length > 0) {
          reply.panels.forEach((panel, i) => store.addPanel(panel, turnId, { summary: i === 0 ? reply.content : "" }));
        } else if (reply.content) {
          const question = conversation.messages[conversation.messages.indexOf(reply) - 1]?.content ?? "Answer";
          store.addPanel({ type: "answer", title: question.slice(0, 54), text: reply.content }, turnId);
        }
        if (index === replies.length - 1) store.setFollowups(reply.meta.followups ?? []);
      });
    } catch (error) {
      store.toast((error as ApiError).message, "error");
    }
  };

  const remove = async (id: string) => {
    const store = useStore.getState();
    try {
      await api.deleteConversation(id);
      if (store.conversationId === id) store.newConversation();
      store.touchServer();
    } catch (error) {
      store.toast((error as ApiError).message, "error");
    }
  };

  const startNew = () => {
    stopEverything();
    useStore.getState().newConversation();
  };

  return (
    <>
      <button type="button" className="button wide" onClick={startNew}>
        <PlusIcon size={18} /> New conversation
      </button>

      {problem && <p className="problem">{problem}</p>}
      {conversations === null && !problem && <p className="muted">Loading conversations</p>}
      {conversations?.length === 0 && (
        <p className="empty">Nothing here yet. Ask a question and the conversation is saved in this list.</p>
      )}

      <ul className="conversation-list">
        {conversations?.map((conversation) => (
          <li key={conversation.id} data-active={conversation.id === activeId}>
            <button type="button" className="conversation" onClick={() => void open(conversation.id)}>
              <span className="conversation-title">{conversation.title}</span>
              <span className="muted">{relativeTime(conversation.updated_at)}</span>
            </button>
            <IconButton label={`Delete "${conversation.title}"`} onClick={() => void remove(conversation.id)}>
              <TrashIcon size={18} />
            </IconButton>
          </li>
        ))}
      </ul>

      {messages.length > 0 && (
        <section className="drawer-section">
          <h3>This conversation</h3>
          <ol className="transcript">
            {messages.map((message) => (
              <li key={message.id} data-role={message.role}>
                <span className="speaker">{message.role === "user" ? "You" : "Aura"}</span>
                <p>{message.content}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
