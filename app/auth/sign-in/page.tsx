"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";

export default function SignInPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isGitHubLoading, setIsGitHubLoading] = useState(false);

  async function handleSignIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (isLoading || isGitHubLoading) return;

    setIsLoading(true);
    setMessage("Signing in...");

    try {
      const { error } = await authClient.signIn.email({
        email: email.trim(),
        password,
      });

      if (error) {
        setMessage(error.message || "Sign-in failed.");
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch (error) {
      console.error("Sign-in error:", error);
      setMessage("Unable to sign in. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleGitHubSignIn() {
    if (isLoading || isGitHubLoading) return;

    setIsGitHubLoading(true);
    setMessage("Connecting to GitHub...");

    try {
      const { error } = await authClient.signIn.social({
        provider: "github",
        callbackURL: "/dashboard",
      });

      if (error) {
        setMessage(error.message || "GitHub sign-in failed.");
        setIsGitHubLoading(false);
      }
    } catch (error) {
      console.error("GitHub sign-in error:", error);
      setMessage("Unable to connect to GitHub. Please try again.");
      setIsGitHubLoading(false);
    }
  }

  const isBusy = isLoading || isGitHubLoading;

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-bold">Sign in</h1>

      <p className="mt-2 text-sm text-stone-500">
        Welcome back to Codebase Detective.
      </p>

      <form onSubmit={handleSignIn} className="mt-6 space-y-4">
        <input
          className="w-full rounded border p-3"
          type="email"
          placeholder="Email address"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={isBusy}
        />

        <input
          className="w-full rounded border p-3"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={isBusy}
        />

        <button
          type="submit"
          disabled={isBusy}
          className="w-full rounded bg-stone-900 p-3 text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? "Signing in..." : "Sign in"}
        </button>

        <button
          type="button"
          onClick={handleGitHubSignIn}
          disabled={isBusy}
          className="w-full rounded border p-3 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isGitHubLoading ? "Connecting to GitHub..." : "Continue with GitHub"}
        </button>
      </form>

      {message && (
        <p className="mt-4 text-sm" role="status" aria-live="polite">
          {message}
        </p>
      )}

      <p className="mt-6 text-center text-sm text-stone-600">
        Don&apos;t have an account?{" "}
        <Link
          href="/auth/sign-up"
          className="font-medium text-orange-700 hover:underline"
        >
          Create an account
        </Link>
      </p>
    </main>
  );
}
