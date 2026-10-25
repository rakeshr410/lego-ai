// The interview-prep roadmaps (pages/roadmap): one per stack with systems to read, in what order to
// learn it, how to spend the interview's 45 minutes, what interviewers listen for, and the usual
// mistakes. Each phase names the catalog systems that teach it (systems.yaml slugs): resolve() turns
// them into links and fails the build on a slug the catalog doesn't have, so a roadmap can never
// point at a page that isn't there.

import type { System } from './sd';

export type Stage = { name: string; minutes: number; note: string };
export type Signal = { name: string; text: string };
export type Phase = {
  name: string;
  /** "Week 1", "Weeks 2–3". */
  weeks: string;
  goal: string;
  /** What to be able to explain by the end of the phase. */
  learn: string[];
  /** Catalog systems (and concepts) that teach it, in reading order. */
  read: string[];
  practice: string;
  /** A question to answer out loud before moving on. */
  check: string;
};
export type Roadmap = {
  /** The track's slug (content/tracks.yaml). */
  track: string;
  title: string;
  lede: string;
  weeks: number;
  /** What this interview asks you to do, in a sentence. */
  format: string;
  stages: Stage[];
  signals: Signal[];
  phases: Phase[];
  pitfalls: string[];
};

export const ROADMAPS: Roadmap[] = [
  {
    track: 'backend',
    title: 'Backend system design interview',
    lede: 'Six weeks from the vocabulary of distributed systems to designing a payment system against the clock.',
    weeks: 6,
    format:
      'You get a product to build behind an API, such as a URL shortener, a feed or a ride-hailing service, and 45 minutes to scope it, size it and design the services and storage that keep it up at scale.',
    stages: [
      { name: 'Requirements', minutes: 5, note: 'Agree what it must do and the qualities that matter most.' },
      { name: 'Estimates', minutes: 5, note: 'Traffic, storage and bandwidth, rounded to what changes the design.' },
      { name: 'API and data', minutes: 7, note: 'The calls clients make, and the records behind them.' },
      { name: 'High-level design', minutes: 12, note: 'Services, storage and how a request flows through them.' },
      { name: 'Deep dives', minutes: 12, note: 'The one or two parts that are hard at this scale.' },
      { name: 'Wrap-up', minutes: 4, note: 'Bottlenecks, failures and what you’d do next.' },
    ],
    signals: [
      { name: 'Scoping', text: 'You ask before you draw, and you write down what you’re leaving out.' },
      { name: 'Numbers', text: 'Your estimates decide something: a cache, a shard count, a queue.' },
      { name: 'Trade-offs', text: 'Every choice comes with the alternative you rejected and why.' },
      { name: 'Failure', text: 'You say what happens when a node, a region or a dependency goes down.' },
    ],
    phases: [
      {
        name: 'Foundations',
        weeks: 'Week 1',
        goal: 'Speak the language of distributed systems.',
        learn: ['How services call each other, and what a timeout really means', 'Strong versus eventual consistency', 'How systems fail, partially and silently', 'Turning a product idea into requests per second and terabytes'],
        read: ['abstractions-and-rpc', 'consistency-models', 'failure-models', 'non-functional-requirements', 'back-of-the-envelope'],
        practice: 'Estimate the daily writes, reads and storage of an app you use every day, in five minutes, on paper.',
        check: 'Where would eventual consistency surprise a user of that app?',
      },
      {
        name: 'Building blocks',
        weeks: 'Weeks 2–3',
        goal: 'Know each standard part well enough to choose it, and to say when not to.',
        learn: ['Routing traffic: DNS, load balancers and CDNs', 'Picking a database for a workload', 'Caching and its invalidation', 'Queues and pub/sub for work that can wait'],
        read: ['dns', 'load-balancers', 'cdn', 'databases', 'key-value-store', 'distributed-cache', 'blob-store', 'message-queue', 'pub-sub'],
        practice: 'For each block, write one sentence on when you would use it and one on when you wouldn’t.',
        check: 'Which database would you pick for a chat history, a product catalog and a leaderboard, and why?',
      },
      {
        name: 'Patterns at scale',
        weeks: 'Week 4',
        goal: 'Handle the problems that only appear with lots of traffic.',
        learn: ['IDs that stay unique across machines', 'Counting hot keys without locking', 'Scheduling and retrying background work', 'Search, logs and metrics you can actually operate'],
        read: ['unique-id-generator', 'sharded-counters', 'task-scheduler', 'distributed-search', 'logging', 'monitoring'],
        practice: 'Take a design you already know and find its hottest key. Redesign around it.',
        check: 'How would you know, at 3 a.m., that this system is failing?',
      },
      {
        name: 'Classic designs',
        weeks: 'Week 5',
        goal: 'Run the full interview, end to end, on the questions that come up most.',
        learn: ['A repeatable order: requirements, numbers, API, data, design, deep dive', 'Choosing which part deserves the deep dive'],
        read: ['rate-limiter', 'url-shortener', 'typeahead', 'web-crawler', 'news-feed'],
        practice: 'Do each design against a 45-minute timer, following the interview clock above. Stop when time is up.',
        check: 'In which stage did you run out of time, and what did you skip?',
      },
      {
        name: 'Hard designs and mocks',
        weeks: 'Week 6',
        goal: 'Stay calm on the designs with money, location or real-time collaboration in them.',
        learn: ['Exactly-once effects with idempotency', 'Geospatial lookups', 'Real-time delivery and ordering', 'Contention for a limited resource'],
        read: ['payment-system', 'uber', 'ticketmaster', 'whatsapp-backend', 'google-docs-backend'],
        practice: 'Two timed mock interviews with a friend. Record them and score yourself against the four signals.',
        check: 'Could you defend your riskiest choice to someone who disagrees with it?',
      },
    ],
    pitfalls: [
      'Drawing boxes before agreeing what the system must do.',
      'Estimates that don’t change any decision.',
      'One database, one server, no story for failure.',
      'Designing for a billion users when a thousand were asked for.',
      'Spending the deep dive on the easy part.',
    ],
  },
  {
    track: 'frontend',
    title: 'Frontend system design interview',
    lede: 'Six weeks from how a browser paints a page to designing a feed, a chat or a collaborative editor that stays fast.',
    weeks: 6,
    format:
      'You design the client of a real product, such as a news feed, a photo grid, a chat or an editor: its components, its data and state, how it talks to the server, and how it stays fast, accessible and secure.',
    stages: [
      { name: 'Requirements', minutes: 5, note: 'Users, devices, networks, and which features are in scope.' },
      { name: 'Architecture', minutes: 10, note: 'The components, who owns which state, and how data flows.' },
      { name: 'Data model', minutes: 7, note: 'Client-side entities, caches and what is derived.' },
      { name: 'API', minutes: 8, note: 'What the client asks the server for, and in what shape.' },
      { name: 'Optimizations', minutes: 12, note: 'Performance, accessibility, i18n and security, for this product.' },
      { name: 'Wrap-up', minutes: 3, note: 'What you’d measure, and what comes next.' },
    ],
    signals: [
      { name: 'User first', text: 'You start from the people using it: their device, their network, their needs.' },
      { name: 'Boundaries', text: 'Components have clear jobs, and every piece of state has one owner.' },
      { name: 'Performance', text: 'You set a budget and say what you’d measure to keep it.' },
      { name: 'Accessibility', text: 'Keyboard, screen readers and other languages come up without prompting.' },
    ],
    phases: [
      {
        name: 'How browsers work',
        weeks: 'Week 1',
        goal: 'Know what happens between a byte arriving and a pixel changing.',
        learn: ['The rendering pipeline', 'Layout and positioning', 'The DOM, and why virtual DOMs exist', 'Where application state should live'],
        read: ['how-browsers-render-content', 'formatting-contexts-and-css-positioning', 'dom-and-virtual-dom', 'state-management'],
        practice: 'Open the performance panel on a site you use daily and explain one long frame.',
        check: 'Why can changing one CSS property be cheap and another expensive?',
      },
      {
        name: 'Talking to servers',
        weeks: 'Week 2',
        goal: 'Choose how the client and server exchange data, and why.',
        learn: ['HTTP, WebSockets, SSE and polling', 'REST, GraphQL and RPC styles', 'Formats and their costs', 'Fetching, caching and keeping data fresh'],
        read: ['client-server-protocols', 'api-architectural-styles', 'data-formats', 'data-retrieval', 'data-flow-patterns'],
        practice: 'Design the API for a comment thread twice, once REST and once GraphQL. Compare the requests a page load makes.',
        check: 'When would you pick server-sent events over WebSockets?',
      },
      {
        name: 'Architecture',
        weeks: 'Week 3',
        goal: 'Structure an app so it can grow without slowing the team down.',
        learn: ['Single-page versus multi-page apps', 'Component boundaries', 'Micro-frontends and when they pay off'],
        read: ['architecture-patterns', 'spas-vs-mpas', 'component-based-architecture', 'micro-frontends'],
        practice: 'Sketch the component tree of a product page and mark which component owns each piece of state.',
        check: 'What would make you split this app into micro-frontends, and what would it cost?',
      },
      {
        name: 'The quality bar',
        weeks: 'Week 4',
        goal: 'Treat performance, accessibility, languages and security as requirements, not extras.',
        learn: ['Core performance metrics', 'Accessible patterns for custom widgets', 'Right-to-left text and plurals', 'Authentication, tokens and content security'],
        read: ['performance', 'accessibility-and-compatibility', 'localization-and-i18n', 'maintainability', 'authentication-and-authorization', 'secure-transmission-and-content-policies'],
        practice: 'Use a product you like with only the keyboard for ten minutes. Write down every place you got stuck.',
        check: 'Where should a session token live in the browser, and what attacks does that choice invite?',
      },
      {
        name: 'Performance in depth',
        weeks: 'Week 5',
        goal: 'Keep long lists, heavy media and slow networks fast.',
        learn: ['Network and loading strategies', 'Rendering long lists', 'Images and video', 'Infinite scroll or pagination'],
        read: ['network-performance', 'rendering-performance', 'page-load-time', 'javascript-performance', 'virtualization', 'infinite-scroll-vs-pagination', 'media-rendering'],
        practice: 'Budget a feed page: how many kilobytes and milliseconds each part may use on a mid-range phone.',
        check: 'Your feed stutters after 500 posts. What do you check first?',
      },
      {
        name: 'Product designs and mocks',
        weeks: 'Week 6',
        goal: 'Run the full interview on the products that come up most.',
        learn: ['A repeatable order: requirements, architecture, data, API, optimizations', 'Choosing the optimizations that matter for this product'],
        read: ['facebook', 'instagram', 'whatsapp', 'google-docs', 'netflix'],
        practice: 'Two timed mock interviews, one feed and one real-time product. Score yourself against the four signals.',
        check: 'Which optimization did you spend the most time on, and was it the one this product needed?',
      },
    ],
    pitfalls: [
      'Designing the backend instead of the client.',
      'Global state for everything.',
      'Leaving accessibility until someone asks.',
      'Optimizations with no number to justify them.',
      'Ignoring slow networks and low-end phones.',
    ],
  },
  {
    track: 'ml',
    title: 'Machine learning system design interview',
    lede: 'Seven weeks from framing a business goal as a prediction to serving and watching a model in production.',
    weeks: 7,
    format:
      'You turn a product goal, such as better recommendations, catching fraud or answering questions over documents, into an ML system: the prediction to make, the data and features, the model, how to evaluate it, and how to serve and monitor it.',
    stages: [
      { name: 'Framing', minutes: 6, note: 'The business goal, and the prediction that serves it.' },
      { name: 'Metrics', minutes: 5, note: 'Offline metrics, online metrics and how they relate.' },
      { name: 'Data and features', minutes: 9, note: 'Where labels come from, what to feature, what could leak.' },
      { name: 'Model', minutes: 9, note: 'A baseline first, then what earns more complexity.' },
      { name: 'Evaluation', minutes: 7, note: 'Offline tests, then an A/B test, then slices.' },
      { name: 'Serving', minutes: 7, note: 'Latency, scale, and catching drift.' },
      { name: 'Wrap-up', minutes: 2, note: 'Risks and next steps.' },
    ],
    signals: [
      { name: 'Framing', text: 'The ML task follows from the product goal, not the other way round.' },
      { name: 'Data realism', text: 'You know where the labels come from and what they get wrong.' },
      { name: 'Baselines', text: 'You start simple and say what would justify something bigger.' },
      { name: 'Production', text: 'Latency, cost and drift are part of the design, not an afterthought.' },
    ],
    phases: [
      {
        name: 'Framing and metrics',
        weeks: 'Week 1',
        goal: 'Turn a vague goal into a prediction you can measure.',
        learn: ['Choosing what to predict', 'Offline versus online metrics', 'Sizing data, training and serving'],
        read: ['problem-framing', 'success-metrics', 'estimation-for-ml'],
        practice: 'Pick three features of apps you use and write the prediction behind each, with one offline and one online metric.',
        check: 'Your offline metric went up and engagement went down. What happened?',
      },
      {
        name: 'Data and features',
        weeks: 'Week 2',
        goal: 'Build training data you’d trust, and features that exist at serving time.',
        learn: ['Collecting and labelling data', 'Class imbalance', 'Feature engineering', 'Feature stores and training-serving skew', 'Privacy constraints'],
        read: ['data-collection-and-labeling', 'class-imbalance-and-sampling', 'feature-engineering', 'feature-pipelines-and-stores', 'privacy-and-compliance'],
        practice: 'List the features for a fraud model, and mark the ones that wouldn’t be available when the prediction is made.',
        check: 'Where could label leakage creep into this training set?',
      },
      {
        name: 'Models',
        weeks: 'Weeks 3–4',
        goal: 'Match the model to the problem, starting from a baseline.',
        learn: ['Choosing a model family', 'Two-stage retrieval and ranking', 'Text and image models', 'Many objectives at once', 'Exploration versus exploitation'],
        read: ['model-selection', 'ranking-and-retrieval-models', 'nlp-and-vision-models', 'multi-task-and-multi-objective', 'transfer-learning-and-compression', 'exploration-vs-exploitation'],
        practice: 'For a recommendation feed, describe a baseline you could ship in a week, then the model you’d move to and what would prove it was worth it.',
        check: 'Why split recommendation into retrieval and ranking?',
      },
      {
        name: 'Evaluation',
        weeks: 'Week 5',
        goal: 'Prove a model is better, and find where it isn’t.',
        learn: ['Offline metrics for ranking and classification', 'A/B tests and their traps', 'Slices and fairness', 'Evaluating generative output'],
        read: ['offline-metrics', 'a-b-testing', 'error-slice-and-fairness-analysis', 'evaluating-generative-ai'],
        practice: 'Plan an A/B test for a new ranking model: the metric, the guardrails, the sample size and how long it runs.',
        check: 'The new model wins overall but loses for new users. Do you ship it?',
      },
      {
        name: 'Serving and MLOps',
        weeks: 'Week 6',
        goal: 'Serve predictions fast and cheaply, and know when the model goes stale.',
        learn: ['Batch, online and streaming serving', 'Serving large language models', 'Safe rollouts', 'Monitoring and retraining'],
        read: ['serving-architectures', 'llm-inference', 'model-deployment', 'monitoring-and-continual-learning'],
        practice: 'Give a ranking service a latency budget of 100 ms and split it across its stages.',
        check: 'What tells you the model has drifted before your users do?',
      },
      {
        name: 'Product designs and mocks',
        weeks: 'Week 7',
        goal: 'Run the full interview on the problems that come up most.',
        learn: ['A repeatable order: framing, metrics, data, model, evaluation, serving', 'Spending time where this product’s risk is'],
        read: ['video-recommendation', 'ad-click-prediction', 'fraud-detection', 'semantic-search', 'enterprise-rag-assistant'],
        practice: 'Two timed mock interviews, one ranking problem and one with generative AI. Score yourself against the four signals.',
        check: 'Did your design say how the model would be monitored after launch?',
      },
    ],
    pitfalls: [
      'Naming a model before framing the problem.',
      'Metrics that don’t connect to the product goal.',
      'Features that won’t exist at prediction time.',
      'No baseline to compare against.',
      'Forgetting latency, cost and monitoring.',
    ],
  },
  {
    track: 'agentic',
    title: 'AI agent system design interview',
    lede: 'Six weeks from the agent loop to designing a coding or research agent that is safe, measurable and affordable.',
    weeks: 6,
    format:
      'You design an agent that does real work, such as resolving support tickets, writing code or researching a question: how much it may do on its own, its tools, its context and memory, its guardrails, and how you’ll know it works.',
    stages: [
      { name: 'Task and autonomy', minutes: 6, note: 'What the agent does, and how much it may do unsupervised.' },
      { name: 'Agent loop', minutes: 6, note: 'The pattern, the models and how a run starts and ends.' },
      { name: 'Tools', minutes: 8, note: 'What it can call, with what inputs, and what can go wrong.' },
      { name: 'Context and memory', minutes: 8, note: 'What goes in the window, what is remembered, what is retrieved.' },
      { name: 'Safety', minutes: 8, note: 'Guardrails, permissions and where a human approves.' },
      { name: 'Evals and cost', minutes: 7, note: 'How you measure it, and what a run costs.' },
      { name: 'Wrap-up', minutes: 2, note: 'Risks and next steps.' },
    ],
    signals: [
      { name: 'Autonomy', text: 'The agent gets only as much freedom as the task and its risks justify.' },
      { name: 'Tool contracts', text: 'Tools have clear inputs, outputs and failure modes, and are safe to retry.' },
      { name: 'Context budget', text: 'You decide what fills the context window, and what is left out.' },
      { name: 'Measurement', text: 'You can say how you’d know it works, and what it costs per task.' },
    ],
    phases: [
      {
        name: 'Agent foundations',
        weeks: 'Week 1',
        goal: 'Know what makes something an agent, and when not to build one.',
        learn: ['Workflows versus agents', 'The loop: plan, act, observe', 'Reasoning and planning strategies'],
        read: ['what-is-an-agent', 'agent-architecture', 'reasoning-and-planning'],
        practice: 'Take three tasks you do at work and decide for each: a script, a workflow or an agent.',
        check: 'When is a fixed workflow better than an agent?',
      },
      {
        name: 'Tools',
        weeks: 'Week 2',
        goal: 'Give an agent tools it can use correctly and safely.',
        learn: ['Designing tool interfaces', 'Tool protocols', 'Operating browsers and computers'],
        read: ['tool-design', 'tool-protocols', 'computer-and-browser-use'],
        practice: 'Write the interface of a “refund order” tool: its inputs, its errors, and what makes it safe to call twice.',
        check: 'What should happen when a tool call times out halfway?',
      },
      {
        name: 'Context and memory',
        weeks: 'Week 3',
        goal: 'Fill the context window with what the next step needs, and nothing else.',
        learn: ['Context engineering', 'Short- and long-term memory', 'Retrieval over documents'],
        read: ['context-engineering', 'agent-memory', 'knowledge-and-retrieval'],
        practice: 'Budget the context window of a support agent: system prompt, history, retrieved documents and tool results.',
        check: 'What does your agent forget between sessions, and should it?',
      },
      {
        name: 'Orchestration',
        weeks: 'Week 4',
        goal: 'Coordinate steps, and agents, without losing the thread.',
        learn: ['Workflow patterns', 'Multi-agent designs', 'Shared state and hand-offs'],
        read: ['workflow-patterns', 'multi-agent-patterns', 'agent-state-and-communication'],
        practice: 'Redesign a single agent as an orchestrator with workers, and list what you gained and what you lost.',
        check: 'When does adding a second agent make a system worse?',
      },
      {
        name: 'Safety and operations',
        weeks: 'Week 5',
        goal: 'Keep the agent safe, observable and affordable in production.',
        learn: ['Guardrails', 'Human approval points', 'Prompt injection and permissions', 'Evaluating agents', 'Tracing, cost and latency'],
        read: ['guardrails', 'human-in-the-loop', 'agent-security', 'evaluating-agents', 'observability', 'cost-and-latency'],
        practice: 'Write five test cases for an agent, including one that tries to inject instructions through a document.',
        check: 'Which actions should never run without a person approving them?',
      },
      {
        name: 'Agent designs and mocks',
        weeks: 'Week 6',
        goal: 'Run the full interview on the agents that come up most.',
        learn: ['A repeatable order: task, loop, tools, context, safety, evals', 'Matching autonomy to risk'],
        read: ['customer-support-agent', 'coding-agent', 'deep-research-agent', 'web-browsing-agent'],
        practice: 'Two timed mock interviews, one support agent and one coding agent. Score yourself against the four signals.',
        check: 'Could you explain what your agent costs per task, and how you’d bring it down?',
      },
    ],
    pitfalls: [
      'Reaching for an agent when a workflow would do.',
      'Tools with vague inputs and no error handling.',
      'Stuffing everything into the context window.',
      'No human checkpoint on irreversible actions.',
      'No evals, so no way to know if a change helped.',
    ],
  },
];

export type RoadmapLink = { slug: string; name: string; href: string; ready: boolean; icon: string | null };

/** The catalog pages a phase links to; throws on a slug the catalog doesn't have. */
export function resolve(slugs: readonly string[], systems: readonly System[], where: string): RoadmapLink[] {
  return slugs.map((slug) => {
    const s = systems.find((x) => x.slug === slug);
    if (!s) throw new Error(`Roadmap ${where} links to "${slug}", which is not in content/systems.yaml`);
    return { slug, name: s.name, href: `/systems/${slug}`, ready: s.topics.some((t) => t.available), icon: s.icon ?? null };
  });
}

export const roadmapOf = (track: string) => ROADMAPS.find((r) => r.track === track) ?? null;
