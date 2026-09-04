import type { Metadata } from "next";
import { AdminDashboard } from "@/components/admin-dashboard";

export const metadata: Metadata = {
  title: "Operations · Finite Feed",
  description: "Private ingestion and recommendation operations dashboard.",
};

export default function AdminPage() {
  return <AdminDashboard />;
}
