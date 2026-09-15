import type { Metadata } from "next";
import AuthForm from "../components/auth/AuthForm";

export const metadata: Metadata = {
  title: "AEDEXA — sign in",
  description: "Sign in to your AEDEXA workspace.",
};

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
