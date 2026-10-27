import { emit } from '../../../../lego/events/src/bus.ts';
import InterviewApp from '../components/sd/InterviewApp';
import PlaylistView from '../components/sd/PlaylistView';
import type { ClassroomProps, Mounted } from './contract';
import { mountReact } from './mount';

// The coach's classroom as a federated module (contract.ts): a playlist's page, and a lesson's
// landing page and room (InterviewApp with the lesson's page: the coach teaches it on the board).
export { CONTRACT } from './contract';

export function mount(element: HTMLElement, props: ClassroomProps): Mounted {
  if (props.kind === 'playlist') {
    emit('classroom.opened', { playlist: props.page.slug, lesson: null }, 'classroom');
    return mountReact(element, <PlaylistView page={props.page} />, 'classroom');
  }
  const course = props.page.course;
  if (course) emit('classroom.opened', { playlist: course.playlist, lesson: course.lesson }, 'classroom');
  return mountReact(element, <InterviewApp page={props.page} />, 'classroom');
}
