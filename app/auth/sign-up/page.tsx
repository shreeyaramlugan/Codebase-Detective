"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";

export default function SignUpPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function handleSignUp(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (isLoading) return;

    setIsLoading(true);
    setMessage("Creating your account...");

    try {
      const { error } = await authClient.signUp.email({
        name: name.trim(),
        email: email.trim(),
        password,
      });

      if (error) {
        setMessage(error.message || "Registration failed.");
        return;
      }

      setMessage("Account created successfully. Redirecting...");

      router.replace("/dashboard");
      router.refresh();
    } catch (error) {
      console.error("Registration error:", error);
      setMessage("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-bold">Create your account</h1>

      <p className="mt-2 text-sm text-stone-500">
        Start investigating your codebase.
      </p>

      <form onSubmit={handleSignUp} className="mt-6 space-y-4">
        <input
          className="w-full rounded border p-3"
          type="text"
          placeholder="Full name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          disabled={isLoading}
        />

        <input
          className="w-full rounded border p-3"
          type="email"
          placeholder="Email address"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={isLoading}
        />

        <input
          className="w-full rounded border p-3"
          type="password"
          placeholder="Password (minimum 12 characters)"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={12}
          required
          disabled={isLoading}
        />

        <button
          className="w-full rounded bg-stone-900 p-3 text-white disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
          disabled={isLoading}
        >
          {isLoading ? "Creating account..." : "Create account"}
        </button>
      </form>

      {message && (
        <p className="mt-4 text-sm" role="status" aria-live="polite">
          {message}
        </p>
      )}

      <p className="mt-6 text-center text-sm text-stone-600">
        Already have an account?{" "}
        <Link
          href="/auth/sign-in"
          className="font-medium text-orange-700 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </main>
  );
}
