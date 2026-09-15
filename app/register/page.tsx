import type { Metadata } from "next";
import AuthForm from "../components/auth/AuthForm";

export const metadata: Metadata = {
  title: "AEDEXA — create account",
  description: "An account lets you move projects between devices.",
};

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
