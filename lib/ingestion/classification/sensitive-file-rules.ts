const SAFE_ENV_EXAMPLES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);

const SENSITIVE_EXACT_FILENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials.json",
  "service-account.json",
  "serviceaccount.json",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
]);

const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".aws",
  ".ssh",
  ".gnupg",
  "secrets",
]);

export function isSensitiveFile(path: string): boolean {
  const segments = path.split("/");
  const filename = segments[segments.length - 1].toLowerCase();

  // Exclude sensitive directories anywhere in the path.
  if (
    segments
      .slice(0, -1)
      .some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment.toLowerCase()))
  ) {
    return true;
  }

  // Explicitly allow safe environment templates.
  if (SAFE_ENV_EXAMPLES.has(filename)) {
    return false;
  }

  if (SENSITIVE_EXACT_FILENAMES.has(filename)) {
    return true;
  }

  // Actual environment files are sensitive.
  if (filename === ".env" || filename.startsWith(".env.")) {
    return true;
  }

  // Private key and certificate containers.
  const extensionIndex = filename.lastIndexOf(".");
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex) : "";

  if (SENSITIVE_EXTENSIONS.has(extension)) {
    return true;
  }

  // Common explicitly named secret files.
  if (
    /^secrets?$/.test(filename) ||
    /^secrets?\..+$/.test(filename) ||
    /^.*[._-]credentials?([._-].+)?$/.test(filename) ||
    /^service[-_]account([._-].+)?\.json$/.test(filename)
  ) {
    return true;
  }

  return false;
}
