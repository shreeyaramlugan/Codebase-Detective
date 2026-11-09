// features/ai/assistant/orchestrate.ts
//
// Pure orchestration: evidence candidates in, validated answer out. No
// database, no HTTP. The caller owns retrieval, usage reservation and
// persistence; this module owns context assembly, the provider call and
// answer/citation validation.
import type { AIProvider, AIUsage } from "../providers/ai-provider";
import { AIProviderError } from "../providers/ai-provider";
import { MalformedAnswerError, parseModelAnswer } from "./answer";
import { insufficientAnswer, validateAnswer } from "./citations";
import { assembleContext } from "./context";
import type {
  AssistantAnswer,
  AssistantLimits,
  EvidenceCandidate,
  RetrievalSummary,
  SnapshotScope,
} from "./contracts";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import type { QuestionCategory } from "./question";

export interface ProduceAnswerInput {
  provider: AIProvider;
  limits: AssistantLimits;
  question: string;
  category: QuestionCategory;
  terms: string[];
  scope: SnapshotScope;
  candidates: EvidenceCandidate[];
  /** Called once, just before the provider is contacted (usage reservation). */
  beforeProvider?: () => Promise<void>;
}

export interface ProduceAnswerResult {
  answer: AssistantAnswer;
  retrieval: RetrievalSummary;
  provider: string | null;
  model: string | null;
  usage: AIUsage | null;
  /** True when the provider was contacted. */
  providerCalled: boolean;
}

export async function produceAnswer(
  input: ProduceAnswerInput,
): Promise<ProduceAnswerResult> {
  const context = assembleContext(
    input.candidates,
    input.limits.maxContextChars,
  );
  const retrieval: RetrievalSummary = {
    category: input.category,
    terms: input.terms,
    ...context.summary,
  };

  // No usable evidence: answer honestly without spending provider quota.
  if (!context.substantive) {
    return {
      answer: insufficientAnswer(input.scope),
      retrieval,
      provider: null,
      model: null,
      usage: null,
      providerCalled: false,
    };
  }

  await input.beforeProvider?.();

  const response = await input.provider.generate({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(input.question, input.scope, context.items),
    temperature: 0.1,
    maxOutputTokens: input.limits.maxOutputTokens,
    timeoutMs: input.limits.requestTimeoutMs,
    responseFormat: "json",
  });

  let raw;
  try {
    raw = parseModelAnswer(response.content);
  } catch (error) {
    if (error instanceof MalformedAnswerError) {
      throw new AIProviderError(
        "The AI provider returned an answer in an unexpected format.",
        "MALFORMED_RESPONSE",
        { detail: error.message },
      );
    }
    throw error;
  }

  return {
    answer: validateAnswer(raw, context.items, input.scope),
    retrieval,
    provider: response.provider,
    model: response.model,
    usage: response.usage ?? null,
    providerCalled: true,
  };
}
