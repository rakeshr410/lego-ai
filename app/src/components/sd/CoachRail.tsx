import t from '../../i18n/messages/interview';
import type { SessionView } from '../../pages/api/interview/index';

// The coach lesson's syllabus rail (docs/coach-mode.md): every part with its sections
// and items, each item's status as the coach's ledger has it, the item being taught marked. It
// replaces the interview room's stage bar in a lesson, and the end screen reads it as the summary.

type Lesson = NonNullable<SessionView['lesson']>;
type Status = Lesson['stages'][number]['sections'][number]['items'][number]['status'];

const STATUS_KEY = {
  queued: 'coach.status.queued',
  explained: 'coach.status.explained',
  checked: 'coach.status.checked',
  understood: 'coach.status.understood',
  shaky: 'coach.status.shaky',
  skipped: 'coach.status.skipped',
} as const satisfies Record<Status, string>;

type Props = {
  lesson: Lesson;
  stageIndex: number;
  /** The summary lists every item; the room's rail folds the parts not current. */
  expanded?: boolean;
};

export default function CoachRail({ lesson, stageIndex, expanded = false }: Props) {
  return (
    <ol className={`ivk-rail${expanded ? ' is-expanded' : ''}`} aria-label={t('coach.room.rail')}>
      {lesson.stages.map((s, i) => {
        const current = i === stageIndex;
        const open = expanded || current;
        return (
          <li key={s.key} className={`ivk-part${current ? ' is-current' : i < stageIndex ? ' is-done' : ''}`} aria-current={current ? 'step' : undefined}>
            <div className="ivk-part__head">
              <span className="ivk-part__n">{i + 1}</span>
              <span className="ivk-part__title">{s.title}</span>
            </div>
            {open && (
              <ol className="ivk-sections">
                {s.sections.map((x) => (
                  <li key={x.key} className="ivk-section">
                    <span className="ivk-section__title">{x.title}</span>
                    <ol className="ivk-items">
                      {x.items.map((item) => (
                        <li key={item.id} className={`ivk-item is-${item.status}${item.id === lesson.focus ? ' is-focus' : ''}${item.core ? '' : ' is-supporting'}`}>
                          <span className="ivk-dot" aria-hidden="true" />
                          <span className="ivk-item__text">{item.text}</span>
                          <span className="sr-only">{t(STATUS_KEY[item.status])}</span>
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
            )}
          </li>
        );
      })}
    </ol>
  );
}
