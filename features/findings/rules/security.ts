// features/findings/rules/security.ts
//
// Security INDICATOR rules. These report syntax patterns that commonly
// accompany security problems. They never establish that a vulnerability
// exists: no data flow, reachability or runtime behaviour is analysed, so
// every finding is certainty INDICATOR, titled "Possible ..." and capped below
// CRITICAL. Credential values are never read into a finding; the facts pass
// supplies an already-redacted excerpt.
import type {
  FindingSeverity,
  JsonPrimitive,
  RawFinding,
  RuleDefinition,
  SecurityIndicatorKind,
  SecuritySite,
} from "../contracts";
import {
  factsInOrder,
  missingFactsLimitation,
  noFactsAvailable,
} from "./helpers";

const NOTE =
  "This is a static pattern indicator, not a confirmed vulnerability: it does not show that the code is reachable or exploitable.";

interface IndicatorSpec {
  id: string;
  name: string;
  indicator: SecurityIndicatorKind;
  severities: readonly FindingSeverity[];
  severityPolicy: string;
  description: string;
  evaluation: string;
  recommendation: string;
  discriminator: (detail: SecuritySite["detail"]) => string;
  severity: (detail: SecuritySite["detail"]) => FindingSeverity;
  title: (detail: SecuritySite["detail"]) => string;
  explain: (detail: SecuritySite["detail"]) => string;
}

const text = (value: JsonPrimitive | undefined): string =>
  value === undefined || value === null ? "" : String(value);

function securityRule(spec: IndicatorSpec): RuleDefinition {
  return {
    id: spec.id,
    name: spec.name,
    version: "1.0.0",
    category: "SECURITY",
    severities: spec.severities,
    severityPolicy: spec.severityPolicy,
    certainties: ["INDICATOR"],
    scope: "FILE",
    requiresCompleteAnalysis: false,
    usesSourceFacts: true,
    thresholdKeys: [],
    description: `${spec.description} ${NOTE}`,
    evaluation: spec.evaluation,
    evidenceRequirement:
      "A PATTERN_MATCH evidence item with the exact location and a redacted excerpt.",
    recommendation: spec.recommendation,
    evaluate(context) {
      const unavailable = noFactsAvailable(context);
      if (unavailable) return unavailable;

      const findings: RawFinding[] = [];

      for (const file of factsInOrder(context)) {
        const counters = new Map<string, number>();

        for (const site of file.securitySites) {
          if (site.indicator !== spec.indicator) continue;

          const base = `${spec.indicator}:${spec.discriminator(site.detail)}`;
          const n = counters.get(base) ?? 0;
          counters.set(base, n + 1);

          findings.push({
            title: spec.title(site.detail),
            description: `${spec.explain(site.detail)} ${NOTE}`,
            severity: spec.severity(site.detail),
            certainty: "INDICATOR",
            subjectPath: file.path,
            subjectKey: `${base}#${n}`,
            symbolKey: null,
            primaryLine: site.location.startLine,
            evidence: [
              {
                kind: "PATTERN_MATCH",
                filePath: file.path,
                symbolKey: null,
                location: site.location,
                excerpt: site.excerpt,
                message: spec.explain(site.detail),
                data: site.detail,
              },
            ],
            measurements: null,
          });
        }
      }

      return {
        kind: "findings",
        findings,
        limitations: missingFactsLimitation(context),
      };
    },
  };
}

export const dynamicCodeRule = securityRule({
  id: "SEC001",
  name: "Possible dynamic code evaluation",
  indicator: "DYNAMIC_CODE_EVALUATION",
  severities: ["MEDIUM", "LOW"],
  severityPolicy:
    "MEDIUM when the evaluated code is not a static string; LOW otherwise.",
  description:
    "Use of eval, the Function constructor, or string-based timer handlers, which execute text as code.",
  evaluation:
    "A call to eval, Function(...) / new Function(...), or setTimeout/setInterval with a string literal handler.",
  recommendation:
    "Avoid executing text as code. Use functions, lookup tables or a parser instead.",
  discriminator: (d) => text(d.callee),
  severity: (d) => (d.dynamicArgument === true ? "MEDIUM" : "LOW"),
  title: (d) => `Possible dynamic code evaluation via ${text(d.callee)}`,
  explain: (d) =>
    `${text(d.callee)} executes text as code${d.dynamicArgument === true ? " and its argument is not a static string" : ""}.`,
});

export const shellExecutionRule = securityRule({
  id: "SEC002",
  name: "Possible shell command execution",
  indicator: "SHELL_COMMAND_EXECUTION",
  severities: ["MEDIUM", "LOW"],
  severityPolicy:
    "MEDIUM when the command is not a static string or a shell is explicitly used; LOW otherwise.",
  description:
    "Use of child_process functions that run a command through a shell.",
  evaluation:
    "A call to exec/execSync (or spawn/execFile with `shell` set) obtained from child_process.",
  recommendation:
    "Prefer execFile/spawn with an argument array and no shell, and never build commands from untrusted input.",
  discriminator: (d) => text(d.function),
  severity: (d) =>
    d.dynamicCommand === true || d.shellOption === true ? "MEDIUM" : "LOW",
  title: (d) => `Possible shell command execution via ${text(d.function)}`,
  explain: (d) =>
    `${text(d.function)} runs a command through a shell${d.dynamicCommand === true ? " and the command is not a static string" : ""}.`,
});

export const htmlSinkRule = securityRule({
  id: "SEC003",
  name: "Possible HTML injection sink",
  indicator: "HTML_INJECTION_SINK",
  severities: ["MEDIUM", "LOW"],
  severityPolicy:
    "MEDIUM when the assigned value is not a static string; LOW otherwise.",
  description:
    "Writes of markup into the DOM (innerHTML, outerHTML, insertAdjacentHTML, document.write, dangerouslySetInnerHTML).",
  evaluation:
    "An assignment to innerHTML/outerHTML, a call to insertAdjacentHTML/document.write, or a dangerouslySetInnerHTML attribute.",
  recommendation:
    "Use text-based APIs, or sanitise markup with a vetted sanitiser before insertion.",
  discriminator: (d) => text(d.sink),
  severity: (d) => (d.dynamicValue === true ? "MEDIUM" : "LOW"),
  title: (d) => `Possible HTML injection sink: ${text(d.sink)}`,
  explain: (d) =>
    `${text(d.sink)} writes markup${d.dynamicValue === true ? " from a value that is not a static string" : ""}.`,
});

export const hardcodedCredentialRule = securityRule({
  id: "SEC004",
  name: "Possible hardcoded credential",
  indicator: "HARDCODED_CREDENTIAL",
  severities: ["HIGH", "MEDIUM"],
  severityPolicy:
    "HIGH for a literal matching a well-known credential format; MEDIUM for a credential-named variable assigned a string literal.",
  description:
    "A string literal that looks like a credential, or a credential-named variable assigned a literal. The value is never stored; the excerpt is redacted.",
  evaluation:
    "A literal matching a known credential format, or an assignment to a name such as password/secret/token/apiKey with a non-placeholder string literal.",
  recommendation:
    "Move secrets to environment variables or a secret store, and rotate any credential that was committed.",
  discriminator: (d) =>
    d.match === "known-format" ? text(d.format) : text(d.name),
  severity: (d) => (d.match === "known-format" ? "HIGH" : "MEDIUM"),
  title: (d) =>
    d.match === "known-format"
      ? `Possible hardcoded credential (${text(d.format)})`
      : `Possible hardcoded credential assigned to ${text(d.name)}`,
  explain: (d) =>
    d.match === "known-format"
      ? `A string literal matches the format of a ${text(d.format)}.`
      : `${text(d.name)} is assigned a string literal of ${text(d.length)} characters.`,
});

export const tlsDisabledRule = securityRule({
  id: "SEC005",
  name: "Possible disabled TLS verification",
  indicator: "TLS_VERIFICATION_DISABLED",
  severities: ["MEDIUM"],
  severityPolicy: "Always MEDIUM.",
  description:
    "Configuration that turns off TLS certificate verification (rejectUnauthorized: false, NODE_TLS_REJECT_UNAUTHORIZED=0).",
  evaluation:
    'A property rejectUnauthorized set to false, or NODE_TLS_REJECT_UNAUTHORIZED set to "0".',
  recommendation:
    "Keep certificate verification enabled; trust a private CA explicitly instead of disabling checks.",
  discriminator: (d) => text(d.setting),
  severity: () => "MEDIUM",
  title: (d) => `Possible disabled TLS verification (${text(d.setting)})`,
  explain: (d) => `${text(d.setting)} turns certificate verification off.`,
});

export const weakHashRule = securityRule({
  id: "SEC006",
  name: "Possible weak hash algorithm",
  indicator: "WEAK_HASH_ALGORITHM",
  severities: ["LOW"],
  severityPolicy: "Always LOW.",
  description:
    "Use of the MD4, MD5 or SHA-1 hash algorithms, which are unsuitable for security purposes. They can be acceptable for non-security checksums.",
  evaluation: "A createHash call with a literal md4, md5 or sha1 algorithm.",
  recommendation:
    "Use SHA-256 or stronger for security purposes; ignore this indicator for non-security checksums.",
  discriminator: (d) => text(d.algorithm),
  severity: () => "LOW",
  title: (d) => `Possible weak hash algorithm: ${text(d.algorithm)}`,
  explain: (d) =>
    `createHash is called with the ${text(d.algorithm)} algorithm.`,
});

export const securityRules: RuleDefinition[] = [
  dynamicCodeRule,
  shellExecutionRule,
  htmlSinkRule,
  hardcodedCredentialRule,
  tlsDisabledRule,
  weakHashRule,
];
