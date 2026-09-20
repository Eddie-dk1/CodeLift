import { joinClassNames } from "@ui/classnames.js";
import type { ReactNode } from "react";
import styles from "./Card.module.css";
import copy from "./copy.json";

export interface CardProps {
  children?: ReactNode;
}

export function Card({ children = copy.fallback }: CardProps) {
  return <article className={joinClassNames(styles.card, styles.raised)}>{children}</article>;
}
