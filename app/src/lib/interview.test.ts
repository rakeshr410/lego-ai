import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildSnapshot, snapshotPaths } from './content-snapshot.node';
import { drillList, toInterviewPage } from './interview.node';

// What an interview page is given of its plan (P3-11): the candidate-facing fields only.

vi.spyOn(console, 'warn').mockImplementation(() => {});
const snapshot = buildSnapshot(snapshotPaths(fileURLToPath(new URL('../../', import.meta.url))).contentDir);
const entry = snapshot.interviews.find((i) => i.system === 'instagram')!;
const topics = new Map(snapshot.topics.filter((t) => t.system === 'instagram').map((t) => [t.slug, t]));
const topicOf = (slug: string) => {
  const t = topics.get(slug);
  return t && { title: t.title, slug: t.slug, available: t.content.length > 0, system: { slug: t.system } };
};
const page = toInterviewPage(entry, { slug: 'instagram', name: 'Instagram', icon: 'camera' }, topicOf);

describe('toInterviewPage', () => {
  it('gives the page the stages, dimensions, checklist and what to read first', () => {
    expect(page.minutes).toBe(45);
    expect(page.feedbackMinutes).toBe(5);
    expect(page.stages.map((s) => [s.key, s.minutes])).toEqual([
      ['requirements', 8],
      ['high-level', 12],
      ['data-api', 10],
      ['deep-dive', 10],
    ]);
    expect(page.readFirst).toEqual([
      { title: 'Email and password login', href: '/systems/instagram/email-and-password-login' },
      { title: 'Phone number and OTP login', href: '/systems/instagram/phone-number-and-otp-login' },
    ]);
    expect(page.dimensions.map((d) => d.key)).toEqual(['requirements', 'structure', 'trade-offs', 'communication']);
  });

  it('leaves out everything private to the interviewer and the grader', () => {
    const json = JSON.stringify(page);
    const plan = entry.plan;
    for (const s of plan.stages) {
      for (const text of [s.brief, s.opener, ...s.signals, ...(s.redFlags ?? []), ...(s.followUps ?? [])]) if (text) expect(json).not.toContain(text);
    }
    expect(json).not.toContain(plan.graderBrief);
    expect(json).not.toContain(plan.prompt);
  });
});

// Drills (docs/README.md, "Drills"): a topic's and each section's short plan, on the
// tracks that opt in (tracks.yaml interviewDrills: the agentic track); a page lists them topic by
// topic, each topic's sections under it.
describe('drills', () => {
  const agentic = new Set(snapshot.systems.filter((s) => snapshot.problemClasses.find((c) => c.slug === s.problemClass)?.track === 'agentic').map((s) => s.slug));

  it('are derived for the agentic track only, a topic and each of its sections', () => {
    expect(snapshot.drills.length).toBeGreaterThan(0);
    expect(snapshot.drills.every((d) => agentic.has(d.system))).toBe(true);
    expect(snapshot.drills.some((d) => d.system === 'instagram')).toBe(false);
    const csa = snapshot.drills.filter((d) => d.system === 'customer-support-agent');
    const topicDrills = csa.filter((d) => d.section === null);
    expect(topicDrills.map((d) => d.topic)).toEqual(snapshot.topics.filter((t) => t.system === 'customer-support-agent' && t.content.length).map((t) => t.slug));
    for (const d of topicDrills) {
      expect(d.plan.scope).toBe('topic');
      const sections = csa.filter((x) => x.topic === d.topic && x.section !== null);
      expect(sections.map((x) => x.section)).toEqual(d.plan.sections.map((s) => s.sectionKey));
      expect(sections.every((x) => x.plan.scope === 'section' && x.plan.stages.length === 1)).toBe(true);
    }
    // A concept system has drills and no whole interview.
    expect(snapshot.interviews.some((i) => i.system === 'what-is-an-agent')).toBe(false);
    expect(snapshot.drills.filter((d) => d.system === 'what-is-an-agent' && d.section === null).length).toBe(3);
    expect(snapshot.drills.filter((d) => d.system === 'what-is-an-agent').every((d) => d.plan.profile === 'concept')).toBe(true);
  });

  it('are listed topic by topic with each topic’s sections under it, linking the system’s page with the scope', () => {
    const topics = new Map(snapshot.topics.filter((t) => t.system === 'customer-support-agent').map((t) => [t.slug, t]));
    const list = drillList(snapshot.drills, 'customer-support-agent', (slug) => {
      const t = topics.get(slug);
      return t && { title: t.title, slug: t.slug, available: t.content.length > 0, system: { slug: t.system } };
    });
    const first = list[0];
    expect(first.section).toBeNull();
    expect(first.href).toBe(`/systems/customer-support-agent/interview?topic=${first.topic}`);
    const own = list.filter((d) => d.topic === first.topic);
    expect(own.slice(1).every((d) => d.section && d.href === `/systems/customer-support-agent/interview?topic=${first.topic}&section=${encodeURIComponent(d.section)}`)).toBe(true);
    expect(own.slice(1).every((d) => d.minutes < first.minutes)).toBe(true);
    // Topics in the system's order, sections right after their topic.
    const order = list.filter((d) => d.section === null).map((d) => d.topic);
    expect(order).toEqual([...new Set(list.map((d) => d.topic))]);
  });

  it('project a drill like a plan, with its scope, and keep the private notes out', () => {
    const drill = snapshot.drills.find((d) => d.system === 'customer-support-agent' && d.section !== null)!;
    const topics = new Map(snapshot.topics.filter((t) => t.system === 'customer-support-agent').map((t) => [t.slug, t]));
    const page = toInterviewPage({ plan: drill.plan, derived: true }, { slug: 'customer-support-agent', name: 'Customer support agent', icon: null }, (slug) => {
      const t = topics.get(slug);
      return t && { title: t.title, slug: t.slug, available: t.content.length > 0, system: { slug: t.system } };
    });
    expect(page.scope).toBe('section');
    expect(page.topic).toBe(drill.topic);
    expect(page.section).toBe(drill.section);
    expect(page.stages).toHaveLength(1);
    expect(page.minutes).toBe(7);
    const json = JSON.stringify(page);
    for (const s of drill.plan.stages) for (const item of s.items) if (item.probe) expect(json).not.toContain(item.probe);
    expect(json).not.toContain(drill.plan.graderBrief);
  });
});
