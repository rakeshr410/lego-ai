import { useState, type FormEvent } from 'react';
import type { BoardGraph } from '../../lib/board/serialise';
import t from '../../i18n/messages/interview';

// The whiteboard as a list (docs/interview/README.md, "Whiteboard", accessibility): the same graph
// the interviewer reads, with its boxes and arrows, editable from the keyboard: add a box, connect
// two, rename, delete. Ids in the graph are the serialiser's (n1, e1); `eid` is the element's.

type Props = {
  graph: BoardGraph;
  disabled: boolean;
  onAdd: (label: string) => void;
  onConnect: (from: string, to: string, label: string) => void;
  onRename: (eid: string, label: string) => void;
  onDelete: (eid: string) => void;
};

export default function BoardOutline({ graph, disabled, onAdd, onConnect, onRename, onDelete }: Props) {
  const [label, setLabel] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [arrowLabel, setArrowLabel] = useState('');
  const [renaming, setRenaming] = useState<{ eid: string; label: string } | null>(null);
  const boxes = graph.nodes.filter((n) => n.shape !== 'note');
  const name = (id: string | null) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n ? (n.label ?? t('board.outline.unlabelled')) : '?';
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const text = label.trim();
    if (!text) return;
    onAdd(text);
    setLabel('');
  };
  const connect = (e: FormEvent) => {
    e.preventDefault();
    if (!from || !to || from === to) return;
    const a = boxes.find((n) => n.id === from);
    const b = boxes.find((n) => n.id === to);
    if (!a || !b) return;
    onConnect(a.eid, b.eid, arrowLabel.trim());
    setArrowLabel('');
  };
  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const text = renaming.label.trim();
    if (text) onRename(renaming.eid, text);
    setRenaming(null);
  };

  return (
    <div className="ivr-outline" role="region" aria-label={t('board.outline.region')}>
      {boxes.length === 0 && graph.edges.length === 0 ? <p className="ivr-card__small">{t('board.outline.empty')}</p> : null}
      {boxes.length > 0 && (
        <>
          <h3 className="ivr-outline__h">{t('board.outline.boxes')}</h3>
          <ul className="ivr-outline__list">
            {boxes.map((n) => (
              <li key={n.id}>
                {renaming?.eid === n.eid ? (
                  <form className="ivr-outline__form" onSubmit={rename}>
                    <label className="sr-only" htmlFor={`ivr-rename-${n.id}`}>
                      {t('board.outline.label')}
                    </label>
                    <input id={`ivr-rename-${n.id}`} value={renaming.label} maxLength={80} onChange={(e) => setRenaming({ eid: n.eid, label: e.target.value })} />
                    <button type="submit" className="ivr-btn">
                      {t('board.outline.rename')}
                    </button>
                    <button type="button" className="ivr-btn" onClick={() => setRenaming(null)}>
                      {t('board.outline.cancel')}
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="ivr-outline__name">
                      {n.label ?? <em>{t('board.outline.unlabelled')}</em>}
                      {n.frame ? <span className="ivr-outline__in"> · {name(n.frame)}</span> : null}
                    </span>
                    <button type="button" className="ivr-btn ivr-btn--small" onClick={() => setRenaming({ eid: n.eid, label: n.label ?? '' })} disabled={disabled}>
                      {t('board.outline.rename')}
                    </button>
                    <button type="button" className="ivr-btn ivr-btn--small" onClick={() => onDelete(n.eid)} disabled={disabled}>
                      {t('board.outline.delete')}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {graph.edges.length > 0 && (
        <>
          <h3 className="ivr-outline__h">{t('board.outline.arrows')}</h3>
          <ul className="ivr-outline__list">
            {graph.edges.map((e) => (
              <li key={e.id}>
                <span className="ivr-outline__name">
                  {t('board.outline.edge', { from: name(e.from), to: name(e.to) })}
                  {e.label ? <span className="ivr-outline__in"> “{e.label}”</span> : null}
                </span>
                <button type="button" className="ivr-btn ivr-btn--small" onClick={() => onDelete(e.eid)} disabled={disabled}>
                  {t('board.outline.delete')}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {!disabled && (
        <>
          <form className="ivr-outline__form" onSubmit={add}>
            <label htmlFor="ivr-outline-add">{t('board.outline.add')}</label>
            <input id="ivr-outline-add" value={label} maxLength={80} placeholder={t('board.outline.label')} onChange={(e) => setLabel(e.target.value)} />
            <button type="submit" className="ivr-btn" disabled={!label.trim()}>
              {t('board.outline.addBtn')}
            </button>
          </form>
          {boxes.length >= 2 && (
            <form className="ivr-outline__form" onSubmit={connect}>
              <label htmlFor="ivr-outline-from">{t('board.outline.from')}</label>
              <select id="ivr-outline-from" value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">—</option>
                {boxes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label ?? t('board.outline.unlabelled')}
                  </option>
                ))}
              </select>
              <label htmlFor="ivr-outline-to">{t('board.outline.to')}</label>
              <select id="ivr-outline-to" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">—</option>
                {boxes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label ?? t('board.outline.unlabelled')}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="ivr-outline-arrow">
                {t('board.outline.arrowLabel')}
              </label>
              <input id="ivr-outline-arrow" value={arrowLabel} maxLength={80} placeholder={t('board.outline.arrowLabel')} onChange={(e) => setArrowLabel(e.target.value)} />
              <button type="submit" className="ivr-btn" disabled={!from || !to || from === to}>
                {t('board.outline.connect')}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
