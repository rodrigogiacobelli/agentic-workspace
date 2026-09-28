import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, events } from "../api";
import { useModal } from "../modal";
import { useDismiss } from "../motion";
import { report } from "../notice";
import type { CredentialPrompt as Pending, WindowRole } from "../types";

/** A pending question; `expired` once the backend stopped waiting while it was on screen. */
type Shown = Pending & { expired?: boolean };

/**
 * What ssh asks while the application's git or a workspace's terminal runs
 * it — a host to trust, a passphrase, a secret, a yes or no — shown in the
 * window the question belongs to, one at a time, oldest first.
 */
export function CredentialPrompt({ role }: { role: WindowRole }) {
  const [pending, setPending] = useState<Shown[]>([]);
  useEffect(() => {
    let live = true;
    // Closed questions, remembered: the event and the list below arrive in
    // no set order, and a list that lands after its question's close would
    // bring back one nothing is waiting on any more.
    const gone = new Set<string>();
    const add = (p: Pending) => {
      if (live && p.window === role && !gone.has(p.id)) setPending((all) => (all.some((o) => o.id === p.id) ? all : [...all, p]));
    };
    // The one on screen plays its exit; one still waiting behind it just goes.
    const closed = (id: string) => {
      gone.add(id);
      setPending((all) => (all[0]?.id === id ? [{ ...all[0], expired: true }, ...all.slice(1)] : all.filter((p) => p.id !== id)));
    };
    const listening = [events.onCredentialPrompt(add), events.onCredentialPromptClosed(closed)];
    // Listening first, then asking: a question raised in between arrives by
    // one or the other, and `add` keeps one copy of it.
    void Promise.all(listening)
      .then(() => api.credentialPrompts())
      .then((all) => all.forEach(add))
      .catch((e) => report(`The questions ssh is waiting on could not be read: ${String(e)}`));
    return () => {
      live = false;
      listening.forEach((u) => void u.then((f) => f()));
    };
  }, [role]);
  if (!pending.length) return null;
  return (
    <PromptDialog
      prompt={pending[0]}
      last={pending.length === 1}
      onDone={(id) => setPending((all) => all.filter((p) => p.id !== id))}
    />
  );
}

/**
 * One dialog for as long as questions are waiting: the next takes it over, so
 * the keyboard goes back to where it was only once the last is answered.
 */
function PromptDialog({ prompt, last, onDone }: { prompt: Shown; last: boolean; onDone: (id: string) => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, dismiss, cancel] = useDismiss(() => onDone(prompt.id));

  // A new id is a new question, whatever the last one was doing — including
  // one that arrived while the answered one was still playing its exit.
  useLayoutEffect(() => {
    cancel();
    setSecret("");
    setBusy(false);
    setError(null);
  }, [prompt.id, cancel]);

  // A question can take the keyboard in the middle of typing meant for a
  // shell: a Tab and an Enter would reach Trust, an Enter would send what was
  // typed. Only declining works until it has been on screen a moment, and
  // every new question waits again, so a double-click does not carry over.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    const t = window.setTimeout(() => setArmed(true), 700);
    return () => window.clearTimeout(t);
  }, [prompt.id]);

  const finish = () => (last ? dismiss() : onDone(prompt.id));
  useEffect(() => { if (prompt.expired) finish(); }, [prompt.expired]); // eslint-disable-line react-hooks/exhaustive-deps
  // The question on screen and how it closes, as of the last render. An
  // answer that returns after its question closed and the next took the
  // dialog over leaves that one alone.
  const shown = useRef({ id: prompt.id, finish });
  shown.current = { id: prompt.id, finish };

  const answer = async (value: string | null) => {
    if (busy || closing || (value !== null && !armed)) return;
    const id = prompt.id;
    setBusy(true);
    setError(null);
    try {
      await api.credentialPromptAnswer(id, value);
      if (shown.current.id !== id) return;
      setSecret("");
      shown.current.finish();
    } catch (e) {
      if (shown.current.id !== id) return;
      // The backend's words, never the answer: a secret stays out of every
      // message this dialog shows.
      setSecret("");
      setBusy(false);
      // Declining must always close: ssh fails the same way when the backend
      // stops waiting, and a dialog nothing closes would hold the keyboard.
      if (value === null) {
        report(`Declining did not reach ssh: ${String(e)}`);
        shown.current.finish();
      } else {
        setError(`The answer did not reach ssh: ${String(e)}`);
      }
    }
  };
  const decline = () => void answer(null);
  useModal(dialog, closing ? undefined : decline);

  const isHost = prompt.kind === "host";
  const asksSecret = prompt.kind === "passphrase" || prompt.kind === "secret";
  // A host the backend could not parse is shown in ssh's own words.
  const parsed = isHost && prompt.host !== null && prompt.fingerprint !== null;
  const title = parsed ? `Trust ${prompt.host}?` : prompt.title;

  // On the body, above an open settings dialog. No backdrop dismissal: an
  // answer to ssh is given on purpose or not at all.
  return createPortal(
    <div className={`overlay${closing ? " is-closing" : ""}`}>
      <div
        ref={dialog}
        className="dialog credential-prompt"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="credential-prompt-title"
        aria-describedby={`credential-prompt-origin credential-prompt-text${parsed ? " credential-prompt-fingerprint" : ""}`}
        tabIndex={-1}
      >
        <div key={prompt.id} className="credential-prompt-body">
          <div className="dialog-title"><span id="credential-prompt-title">{title}</span></div>
          <p id="credential-prompt-origin" className="credential-origin">Asked by {prompt.origin}</p>
          {parsed ? (
            <>
              <p id="credential-prompt-text">ssh has no record of this host's key. Trusting it adds the key to ssh's known hosts, and every later connection is checked against it.</p>
              <code id="credential-prompt-fingerprint" className="credential-fingerprint">{prompt.fingerprint}</code>
            </>
          ) : (
            <p id="credential-prompt-text" className="credential-text">{prompt.text}</p>
          )}
          {asksSecret && (
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={secret}
              aria-label={prompt.kind === "passphrase" ? "Passphrase" : "Answer"}
              onChange={(e) => { if (armed) setSecret(e.target.value); }}
              onKeyDown={(e) => { if (e.key === "Enter" && secret && armed) { e.preventDefault(); void answer(secret); } }}
            />
          )}
          {error && <p className="setting-error" role="alert">{error}</p>}
          <div className="credential-actions">
            {isHost ? (
              <>
                <button autoFocus onClick={decline}>Decline</button>
                <button disabled={!armed} onClick={() => void answer("yes")}>Trust</button>
              </>
            ) : asksSecret ? (
              <>
                <button onClick={decline}>Cancel</button>
                <button disabled={!armed || !secret} onClick={() => void answer(secret)}>Use</button>
              </>
            ) : (
              <>
                <button autoFocus onClick={decline}>No</button>
                <button disabled={!armed} onClick={() => void answer("yes")}>Yes</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
