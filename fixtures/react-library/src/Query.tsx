import markUrl from "@ui/mark.svg?url";
import styles from "./Query.module.css";

export function Query() {
  return <img className={styles.mark} src={markUrl} alt="Mark" />;
}
