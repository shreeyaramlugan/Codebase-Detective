"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import AuthShell, {
  AuthDivider,
  AuthLabel,
  AuthStatus,
  authInputClass,
  authPrimaryButtonClass,
  authSecondaryButtonClass,
} from "@/components/auth/AuthShell";

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
    <AuthShell
      title="Sign in"
      subtitle="Welcome back to Codebase Detective."
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link
            href="/auth/sign-up"
            className="font-medium text-orange-400 hover:text-orange-300 hover:underline"
          >
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={handleSignIn} className="mt-6 space-y-4">
        <div>
          <AuthLabel htmlFor="email">Email address</AuthLabel>
          <input
            id="email"
            className={authInputClass}
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={isBusy}
          />
        </div>

        <div>
          <AuthLabel htmlFor="password">Password</AuthLabel>
          <input
            id="password"
            className={authInputClass}
            type="password"
            placeholder="Your password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={isBusy}
          />
        </div>

        <button
          type="submit"
          disabled={isBusy}
          className={authPrimaryButtonClass}
        >
          {isLoading ? "Signing in..." : "Sign in"}
        </button>

        <AuthDivider />

        <button
          type="button"
          onClick={handleGitHubSignIn}
          disabled={isBusy}
          className={authSecondaryButtonClass}
        >
          {isGitHubLoading ? "Connecting to GitHub..." : "Continue with GitHub"}
        </button>
      </form>

      <AuthStatus message={message} />
    </AuthShell>
  );
}
