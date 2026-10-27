import { emit } from '../../../../lego/events/src/bus.ts';
import InterviewApp from '../components/sd/InterviewApp';
import type { InterviewProps, Mounted } from './contract';
import { mountReact } from './mount';

// The mock interview as a federated module (contract.ts): a system's interview, or a topic's or a
// section's drill, landing page and room.
export { CONTRACT } from './contract';

export function mount(element: HTMLElement, props: InterviewProps): Mounted {
  emit('interview.opened', { system: props.page.system.slug, scope: props.page.scope }, 'interview');
  return mountReact(element, <InterviewApp page={props.page} />, 'interview');
}
