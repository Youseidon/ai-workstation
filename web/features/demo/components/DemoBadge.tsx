"use client";

import { useEffect, useState } from "react";
import { useIdentity } from "@/contexts/identity";
import { demoTimeLeft } from "../lib/demoLaunch";
import styles from "./demo.module.css";

/** Reminds a demo visitor that this account is temporary, and for how long. */
export function DemoBadge() {
  const { user } = useIdentity();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!user.demo) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [user.demo]);
  if (!user.demo) return null;
  const left = demoTimeLeft(user.demoExpiresAt, now);
  return <p className={styles.chip} title="This demo account, its sample folder and everything in it are deleted when it expires.">
    <strong>Demo</strong><span>Sandbox account</span>{left && <span className="numeric text-right">{left}</span>}
  </p>;
}
