import { serverEnv } from '../env';
import { knownModel } from '../llm-gateway';

// The mock interview's settings (web/.env.example, "Mock interview"), read per call like Ask's so
// a restart picks up a change. Types, defaults and ranges are declared in env.ts.

/** The turn-by-turn interviewer: a cheaper model than Ask's (docs/interview/cost-model.md). */
export const DEFAULT_TURN_MODEL = 'claude-sonnet-5';
/** The one feedback pass at the end reads the whole transcript: the premium model. */
export const DEFAULT_FEEDBACK_MODEL = 'claude-opus-5';
/** The per-turn evaluator tags one turn against a dozen items: the smallest model. */
export const DEFAULT_EVALUATOR_MODEL = 'claude-haiku-5-5';

/**
 * The consent text's version (InterviewRoom.tsx shows it; docs/interview/privacy.md). Sessions
 * record the version the candidate agreed to; bump it whenever the consent text changes.
 */
export const CONSENT_VERSION = '2026-09-27.text-beta';

export function interviewConfig() {
  const s = serverEnv();
  return {
    enabledByEnv: s.INTERVIEW_ENABLED,
    model: knownModel(s.INTERVIEW_MODEL ?? DEFAULT_TURN_MODEL, 'INTERVIEW_MODEL'),
    voiceModel: knownModel(s.INTERVIEW_VOICE_MODEL ?? s.INTERVIEW_MODEL ?? DEFAULT_TURN_MODEL, 'INTERVIEW_VOICE_MODEL'),
    feedbackModel: knownModel(s.INTERVIEW_FEEDBACK_MODEL ?? DEFAULT_FEEDBACK_MODEL, 'INTERVIEW_FEEDBACK_MODEL'),
    effort: s.INTERVIEW_EFFORT,
    maxTokens: s.INTERVIEW_MAX_TOKENS,
    feedbackMaxTokens: s.INTERVIEW_FEEDBACK_MAX_TOKENS,
    feedbackEffort: s.INTERVIEW_FEEDBACK_EFFORT,
    feedbackTimeoutMs: s.INTERVIEW_FEEDBACK_TIMEOUT_MS,
    evaluator: s.INTERVIEW_EVALUATOR,
    evaluatorModel: knownModel(s.INTERVIEW_EVALUATOR_MODEL ?? DEFAULT_EVALUATOR_MODEL, 'INTERVIEW_EVALUATOR_MODEL'),
    evaluatorMaxTokens: s.INTERVIEW_EVALUATOR_MAX_TOKENS,
    boardMatchCalls: s.INTERVIEW_BOARD_MATCH_CALLS,
    boardVisionCalls: s.INTERVIEW_BOARD_VISION_CALLS,
    monthlySessions: s.INTERVIEW_MONTHLY_SESSIONS,
    monthlyDrills: s.INTERVIEW_MONTHLY_DRILLS,
    // Coach mode (docs/interview/coach-mode.md): its own quota; the interviewer's model unless set.
    coach: {
      monthlySessions: s.INTERVIEW_COACH_MONTHLY_SESSIONS,
      maxTokens: s.INTERVIEW_COACH_MAX_TOKENS,
      sessionBudgetUsd: s.INTERVIEW_COACH_SESSION_BUDGET_USD,
      drawTools: s.INTERVIEW_COACH_DRAW_TOOLS,
      model: knownModel(s.INTERVIEW_COACH_MODEL ?? s.INTERVIEW_MODEL ?? DEFAULT_TURN_MODEL, 'INTERVIEW_COACH_MODEL'),
    },
    maxTurns: s.INTERVIEW_MAX_TURNS,
    sessionBudgetUsd: s.INTERVIEW_SESSION_BUDGET_USD,
    dailyBudgetUsd: s.INTERVIEW_DAILY_BUDGET_USD,
    retentionDays: s.INTERVIEW_RETENTION_DAYS,
    overtimeMinutes: s.INTERVIEW_OVERTIME_MINUTES,
    // The voice room (design section 6 and 9). Configured when the service's URL and bearer are set.
    voice: {
      enabledByEnv: s.INTERVIEW_VOICE_ENABLED,
      url: s.INTERVIEW_VOICE_URL ?? null,
      secret: s.INTERVIEW_VOICE_SECRET ?? null,
      monthlySessions: s.INTERVIEW_VOICE_MONTHLY_SESSIONS,
      monthlyMinutes: s.INTERVIEW_VOICE_MONTHLY_MINUTES,
      maxExchanges: s.INTERVIEW_VOICE_MAX_EXCHANGES,
      maxTokens: s.INTERVIEW_VOICE_MAX_TOKENS,
      speculate: s.INTERVIEW_VOICE_SPECULATE,
      sessionBudgetUsd: s.INTERVIEW_VOICE_SESSION_BUDGET_USD,
      dailyBudgetUsd: s.INTERVIEW_VOICE_DAILY_BUDGET_USD,
      sttUsdPerMin: s.VOICE_STT_USD_PER_MIN,
      ttsUsdPer1kChars: s.VOICE_TTS_USD_PER_1K_CHARS,
      dailyApiUrl: s.DAILY_API_URL ?? 'https://api.daily.co/v1',
      dailyApiKey: s.DAILY_API_KEY ?? null,
      // Where Daily hosts the room's media server: Mumbai, with the service and the candidates (null: Daily's choice).
      dailyGeo: s.DAILY_GEO ?? 'ap-south-1',
    },
  };
}

export type InterviewConfig = ReturnType<typeof interviewConfig>;

/** Longest message a candidate may send, in characters. */
export const MAX_MESSAGE_CHARS = 2000;
/** A voice turn is one aggregated utterance, which can run long: the voice service's cap (design section 6). */
export const MAX_VOICE_MESSAGE_CHARS = 6000;
/** The consent text's voice version: transcribed live, not recorded, with the three subprocessors named (privacy.md). */
export const VOICE_CONSENT_VERSION = '2026-10-23.voice-beta';
