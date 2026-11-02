export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AIRequest {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature?: number;
}

export interface AIResponse {
  content: string;
  provider: string;
  model: string;
  usage?: AIUsage;
}

export interface AIProvider {
  readonly name: string;

  generate(request: AIRequest): Promise<AIResponse>;
}
