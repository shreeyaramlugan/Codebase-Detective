// features/ai/assistant/redact.ts
//
// Secrets must not be sent to the AI provider unnecessarily. Likely secret
// files are never read for evidence, and credential-shaped text is replaced
// before any evidence reaches a prompt. This is a safety net, not a guarantee.
const SENSITIVE_PATH = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt)$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml)$/i,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH.some((pattern) => pattern.test(path));
}

const REDACTED = "[REDACTED]";

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

const ASSIGNMENT =
  /((?:api[_-]?key|secret|token|passwd|password|pwd|private[_-]?key|access[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*["']?\s*[:=]\s*)(["'`])([^"'`\n]{6,})\2/gi;

export interface RedactionResult {
  text: string;
  redactions: number;
}

export function redactSecrets(input: string): RedactionResult {
  let redactions = 0;
  let text = input;
  for (const pattern of PATTERNS) {
    text = text.replace(pattern, () => {
      redactions += 1;
      return REDACTED;
    });
  }
  text = text.replace(ASSIGNMENT, (_m, lead: string, quote: string) => {
    redactions += 1;
    return `${lead}${quote}${REDACTED}${quote}`;
  });
  return { text, redactions };
}
