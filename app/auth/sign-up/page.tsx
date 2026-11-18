"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import AuthShell, {
  AuthLabel,
  AuthStatus,
  authInputClass,
  authPrimaryButtonClass,
} from "@/components/auth/AuthShell";

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
    <AuthShell
      title="Create your account"
      subtitle="Start investigating your codebase."
      footer={
        <>
          Already have an account?{" "}
          <Link
            href="/auth/sign-in"
            className="font-medium text-orange-400 hover:text-orange-300 hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSignUp} className="mt-6 space-y-4">
        <div>
          <AuthLabel htmlFor="name">Full name</AuthLabel>
          <input
            id="name"
            className={authInputClass}
            type="text"
            placeholder="Jane Doe"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={isLoading}
          />
        </div>

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
            disabled={isLoading}
          />
        </div>

        <div>
          <AuthLabel htmlFor="password">Password</AuthLabel>
          <input
            id="password"
            className={authInputClass}
            type="password"
            placeholder="Minimum 12 characters"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={12}
            required
            disabled={isLoading}
          />
        </div>

        <button
          className={authPrimaryButtonClass}
          type="submit"
          disabled={isLoading}
        >
          {isLoading ? "Creating account..." : "Create account"}
        </button>
      </form>

      <AuthStatus message={message} />
    </AuthShell>
  );
}
