"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Reveal on scroll */

type RevealProps = {
  children: ReactNode;
  /** Delay within a group, in milliseconds */
  delay?: number;
  /** Where the block enters from */
  from?: "up" | "left" | "right" | "scale";
  className?: string;
  as?: "div" | "section" | "li" | "article" | "header" | "footer" | "figure";
};

/** Whether blocks may be hidden */
function canHide() {
  return (
    document.visibilityState === "visible" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Permission to hide lives on the root node and is shared by all blocks */
let watchers = 0;
let listening = false;

function syncStage() {
  document.documentElement.toggleAttribute("data-reveal", canHide());
}

function watchStage() {
  watchers += 1;
  syncStage();
  if (!listening) {
    document.addEventListener("visibilitychange", syncStage);
    listening = true;
  }
  return () => {
    watchers -= 1;
    if (watchers > 0 || !listening) return;
    document.removeEventListener("visibilitychange", syncStage);
    listening = false;
    document.documentElement.removeAttribute("data-reveal");
  };
}

export default function Reveal({
  children,
  delay = 0,
  from = "up",
  className,
  as: Tag = "div",
}: RevealProps) {
  const holder = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const release = watchStage();
    const node = holder.current;
    if (!node || shown) return release;

    // A block already in the first viewport doesn't wait for the observer
    const box = node.getBoundingClientRect();
    if (box.top < window.innerHeight && box.bottom > 0) {
      queueMicrotask(() => setShown(true));
      return release;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setShown(true);
          observer.disconnect();
        }
      },
      // Small threshold
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
      release();
    };
  }, [shown]);

  return (
    <Tag
      ref={holder as React.Ref<never>}
      className={`reveal reveal-${from}${shown ? " shown" : ""}${className ? ` ${className}` : ""}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}
