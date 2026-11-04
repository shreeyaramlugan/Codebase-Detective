import { describe, expect, it } from "vitest";

import { isSensitiveFile } from "@/lib/ingestion/classification/sensitive-file-rules";

describe("isSensitiveFile", () => {
  describe("environment files", () => {
    it.each([
      ".env",
      ".env.local",
      ".env.production",
      ".env.development",
      "config/.env",
      "config/.env.local",
    ])("identifies sensitive environment file: %s", (path) => {
      expect(isSensitiveFile(path)).toBe(true);
    });

    it.each([
      ".env.example",
      ".env.sample",
      ".env.template",
      "config/.env.example",
    ])("allows safe environment template: %s", (path) => {
      expect(isSensitiveFile(path)).toBe(false);
    });
  });

  describe("sensitive filenames", () => {
    it.each([
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
    ])("identifies sensitive filename: %s", (path) => {
      expect(isSensitiveFile(path)).toBe(true);
    });

    it.each([
      "server.pem",
      "private.key",
      "certificate.p12",
      "certificate.pfx",
      "release.keystore",
      "signing.jks",
    ])("identifies sensitive extension: %s", (path) => {
      expect(isSensitiveFile(path)).toBe(true);
    });
  });

  describe("sensitive directories", () => {
    it.each([
      ".ssh/id_ed25519",
      ".aws/config",
      ".gnupg/private-keys-v1.d/key",
      "config/secrets/database.json",
      "Secrets/api.json",
      "src/.SSH/key",
    ])("identifies files inside sensitive directory: %s", (path) => {
      expect(isSensitiveFile(path)).toBe(true);
    });

    it("does not treat an ordinary directory containing the word secrets as sensitive", () => {
      expect(isSensitiveFile("src/secrets-manager.ts")).toBe(false);
    });
  });

  describe("credential-like filenames", () => {
    it.each([
      "secrets",
      "secret.json",
      "secrets.production.json",
      "database-credentials.json",
      "api_credentials_backup.txt",
      "service_account.production.json",
    ])("identifies credential-like filename: %s", (path) => {
      expect(isSensitiveFile(path)).toBe(true);
    });
  });

  describe("case handling", () => {
    it("matches sensitive filenames regardless of case", () => {
      expect(isSensitiveFile("config/CREDENTIALS.JSON")).toBe(true);
      expect(isSensitiveFile("config/PRIVATE.PEM")).toBe(true);
    });
  });
});
